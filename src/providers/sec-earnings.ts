import { z } from "zod";
import type {
  EarningsHistoryProvider,
  EarningsHistoryRange,
  EarningsInstrumentReference,
  NormalizedEarningsEvent,
} from "./earnings";
import { ProviderResponseError } from "./provider-errors";
import { isIsoCalendarDate, readBoundedJson } from "./provider-http";

export const secEarningsProvider = "sec-edgar-earnings";

const directorySchema = z.object({
  fields: z.tuple([
    z.literal("cik"),
    z.literal("name"),
    z.literal("ticker"),
    z.literal("exchange"),
  ]),
  data: z.array(
    z.tuple([
      z.number().int().positive(),
      z.string().min(1),
      z.string().min(1),
      z.string().min(1).nullable(),
    ]),
  ),
});

const dateColumn = z.array(z.string().refine(isIsoCalendarDate));
const recentFilingsSchema = z.object({
  accessionNumber: z.array(z.string().min(1)),
  filingDate: dateColumn,
  reportDate: z.array(z.string()),
  form: z.array(z.string().min(1)),
  items: z.array(z.string()),
  primaryDocument: z.array(z.string()).optional(),
  primaryDocDescription: z.array(z.string()).optional(),
});
const submissionsSchema = z.object({
  cik: z.string().regex(/^\d{10}$/),
  tickers: z.array(z.string().min(1)),
  filings: z.object({
    recent: recentFilingsSchema,
    files: z.array(
      z.object({
        name: z.string().regex(/^CIK\d{10}-submissions-\d{3}\.json$/),
        filingFrom: z.string().refine(isIsoCalendarDate),
        filingTo: z.string().refine(isIsoCalendarDate),
      }),
    ),
  }),
});

interface FilingRow {
  accessionNumber: string;
  filingDate: string;
  reportDate: string;
  form: string;
  items: string;
  primaryDocument: string;
  primaryDocDescription: string;
}

const normalizedTicker = (value: string): string =>
  value.trim().toUpperCase().replace(/\./g, "-");

const addDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T12:00:00.000Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);

const rowsFrom = (recent: z.infer<typeof recentFilingsSchema>): FilingRow[] => {
  const columns = [
    recent.accessionNumber,
    recent.filingDate,
    recent.reportDate,
    recent.form,
    recent.items,
  ];
  const length = recent.accessionNumber.length;
  if (columns.some((column) => column.length !== length)) {
    throw new Error("provider_schema");
  }
  if (
    (recent.primaryDocument !== undefined &&
      recent.primaryDocument.length !== length) ||
    (recent.primaryDocDescription !== undefined &&
      recent.primaryDocDescription.length !== length)
  ) {
    throw new Error("provider_schema");
  }
  return Array.from({ length }, (_, index) => ({
    accessionNumber: recent.accessionNumber[index] ?? "",
    filingDate: recent.filingDate[index] ?? "",
    reportDate: recent.reportDate[index] ?? "",
    form: recent.form[index] ?? "",
    items: recent.items[index] ?? "",
    primaryDocument: recent.primaryDocument?.[index] ?? "",
    primaryDocDescription: recent.primaryDocDescription?.[index] ?? "",
  }));
};

const hasItem202 = (items: string): boolean =>
  items.split(",").some((item) => item.trim() === "2.02");

const domesticPeriodicForm = (form: string): boolean =>
  form === "10-Q" || form === "10-K";

const foreignAnnualForm = (form: string): boolean =>
  form === "20-F" || form === "40-F";

const quarterEndReportDate = (date: string): boolean => {
  if (!isIsoCalendarDate(date)) return false;
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  return [3, 6, 9, 12].includes(month) && day >= 20;
};

const foreignInterimScore = (row: FilingRow): number | null => {
  if (
    (row.form !== "6-K" && row.form !== "6-K/A") ||
    !quarterEndReportDate(row.reportDate) ||
    row.reportDate >= row.filingDate ||
    addDays(row.reportDate, 100) < row.filingDate
  ) {
    return null;
  }
  const document = `${row.primaryDocument} ${row.primaryDocDescription}`;
  if (
    /(?:monthend|month-end|revenue|dividend|board|annualgeneralmeeting|agm|voting|notice)/i.test(
      document,
    )
  ) {
    return null;
  }
  return /(?:quarter|q[1-4]|financial|results?|earnings?|fsx|wrapper)/i.test(
    document,
  )
    ? 2
    : 1;
};

const foreignInterimRows = (rows: readonly FilingRow[]): FilingRow[] => {
  const byFiscalDate = new Map<string, { row: FilingRow; score: number }>();
  for (const row of rows) {
    const score = foreignInterimScore(row);
    if (score === null) continue;
    const existing = byFiscalDate.get(row.reportDate);
    if (
      !existing ||
      score > existing.score ||
      (score === existing.score && row.filingDate < existing.row.filingDate)
    ) {
      byFiscalDate.set(row.reportDate, { row, score });
    }
  }
  return [...byFiscalDate.values()].map(({ row }) => row);
};

const directoryCandidates = (
  instrument: EarningsInstrumentReference,
): string[] => {
  const primary = normalizedTicker(instrument.providerSymbol);
  const candidates = new Set([primary, normalizedTicker(instrument.symbol)]);
  const crossListAliases: Readonly<Record<string, string>> = {
    "BB-TO": "BB",
  };
  if (/(?:TSX|TOR|VENTURE|TSXV|CDNX|CVE|NEO|CSE)/i.test(instrument.exchange)) {
    const alias = crossListAliases[primary];
    if (alias) candidates.add(alias);
  }
  return [...candidates];
};

const matchFiscalDate = (
  earnings: FilingRow,
  periodic: readonly FilingRow[],
): string | null => {
  const filingDeadline = addDays(earnings.reportDate, 90);
  const candidates = periodic
    .filter(
      (row) =>
        isIsoCalendarDate(row.reportDate) &&
        row.reportDate < earnings.reportDate &&
        row.filingDate >= earnings.reportDate &&
        row.filingDate <= filingDeadline,
    )
    .sort(
      (left, right) =>
        left.filingDate.localeCompare(right.filingDate) ||
        right.reportDate.localeCompare(left.reportDate),
    );
  return candidates[0]?.reportDate ?? null;
};

export class SecEarningsHistoryProvider implements EarningsHistoryProvider {
  private directory: Promise<Map<string, string>> | null = null;

  constructor(
    private readonly userAgent: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!userAgent.trim()) throw new Error("provider_user_agent_unavailable");
  }

  private async request(url: string): Promise<unknown> {
    const fetcher = this.fetcher;
    const response = await fetcher(url, {
      headers: {
        "User-Agent": this.userAgent,
        "Accept-Encoding": "gzip, deflate",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`provider_http_${response.status}`);
    return readBoundedJson(response);
  }

  private async cikDirectory(): Promise<Map<string, string>> {
    this.directory ??= (async () => {
      let payload: z.infer<typeof directorySchema>;
      try {
        payload = directorySchema.parse(
          await this.request(
            "https://www.sec.gov/files/company_tickers_exchange.json",
          ),
        );
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("provider_")) {
          throw error;
        }
        if (error instanceof z.ZodError) {
          const issue = error.issues[0];
          const field =
            issue?.path[0] === "data" ? issue.path[2] : issue?.path[0];
          const issueCode = issue?.code ?? "unknown";
          throw new ProviderResponseError(
            `provider_directory_schema_${String(field ?? "root")}_${issueCode}`,
            JSON.stringify(error.issues.slice(0, 3)),
          );
        }
        throw new ProviderResponseError(
          "provider_directory_response_invalid",
          error instanceof Error ? error.message : "Invalid SEC response",
        );
      }
      return new Map(
        payload.data.map(([cik, , ticker]) => [
          normalizedTicker(ticker),
          String(cik).padStart(10, "0"),
        ]),
      );
    })();
    return this.directory;
  }

  async getEarningsHistory(
    instrument: EarningsInstrumentReference & { currency: "USD" | "CAD" },
    startDate: string,
    endDate: string,
  ): Promise<EarningsHistoryRange> {
    if (
      !isIsoCalendarDate(startDate) ||
      !isIsoCalendarDate(endDate) ||
      startDate > endDate
    ) {
      throw new Error("provider_invalid_range");
    }
    const tickerCandidates = directoryCandidates(instrument);
    const directory = await this.cikDirectory();
    const cik = tickerCandidates
      .map((candidate) => directory.get(candidate))
      .find((candidate): candidate is string => candidate !== undefined);
    if (!cik) throw new Error("provider_symbol_unavailable");

    let payload: z.infer<typeof submissionsSchema>;
    try {
      payload = submissionsSchema.parse(
        await this.request(`https://data.sec.gov/submissions/CIK${cik}.json`),
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("provider_")) {
        throw error;
      }
      throw new Error("provider_submissions_schema");
    }
    if (
      payload.cik !== cik ||
      !payload.tickers.some((ticker) =>
        tickerCandidates.includes(normalizedTicker(ticker)),
      )
    ) {
      throw new Error("provider_symbol_mismatch");
    }

    const rows = rowsFrom(payload.filings.recent);
    for (const file of payload.filings.files.filter(
      (candidate) =>
        candidate.filingTo >= startDate && candidate.filingFrom <= endDate,
    )) {
      let archived: z.infer<typeof recentFilingsSchema>;
      try {
        archived = recentFilingsSchema.parse(
          await this.request(`https://data.sec.gov/submissions/${file.name}`),
        );
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("provider_")) {
          throw error;
        }
        throw new Error("provider_archive_schema");
      }
      rows.push(...rowsFrom(archived));
    }
    const uniqueRows = [
      ...new Map(rows.map((row) => [row.accessionNumber, row])).values(),
    ];
    const periodic = [
      ...uniqueRows.filter(
        (row) => domesticPeriodicForm(row.form) || foreignAnnualForm(row.form),
      ),
      ...foreignInterimRows(uniqueRows),
    ];
    const earningsRows = uniqueRows.filter(
      (row) =>
        (row.form === "8-K" || row.form === "8-K/A") &&
        hasItem202(row.items) &&
        isIsoCalendarDate(row.reportDate),
    );
    const byFiscalDate = new Map<string, NormalizedEarningsEvent>();
    for (const row of earningsRows) {
      const fiscalDateEnding = matchFiscalDate(row, periodic);
      // Item 2.02 is also used for disclosures that are not quarterly or
      // annual earnings releases. Treat the periodic filings as the coverage
      // checklist below instead of rejecting the entire instrument because
      // one unrelated 8-K cannot be paired with a 10-Q or 10-K.
      if (!fiscalDateEnding) continue;
      const providerEventId = `${secEarningsProvider}:${cik}:earnings:${fiscalDateEnding}`;
      const event: NormalizedEarningsEvent = {
        type: "earnings",
        instrumentId: instrument.instrumentId,
        symbol: instrument.symbol.toUpperCase(),
        reportDate: row.reportDate,
        fiscalDateEnding,
        epsEstimate: null,
        currency: instrument.currency,
        timeOfDay: null,
        provider: secEarningsProvider,
        providerEventId,
        providerRevision: `${row.accessionNumber}|${row.reportDate}|${fiscalDateEnding}`,
      };
      const existing = byFiscalDate.get(fiscalDateEnding);
      if (!existing || event.reportDate < existing.reportDate) {
        byFiscalDate.set(fiscalDateEnding, event);
      }
    }
    // Some issuers publish a 10-Q/10-K without a separate Item 2.02 8-K.
    // The filing date is still an authoritative public-report date, so use it
    // as the event date instead of declaring the entire SEC snapshot partial
    // and spending a scarce Alpha fallback request forever.
    for (const row of [...periodic].sort((left, right) =>
      left.filingDate.localeCompare(right.filingDate),
    )) {
      const existing = byFiscalDate.get(row.reportDate);
      if (
        row.filingDate < startDate ||
        row.filingDate > endDate ||
        !isIsoCalendarDate(row.reportDate) ||
        (existing !== undefined &&
          existing.reportDate >= startDate &&
          existing.reportDate <= row.filingDate)
      ) {
        continue;
      }
      byFiscalDate.set(row.reportDate, {
        type: "earnings",
        instrumentId: instrument.instrumentId,
        symbol: instrument.symbol.toUpperCase(),
        reportDate: row.filingDate,
        fiscalDateEnding: row.reportDate,
        epsEstimate: null,
        currency: instrument.currency,
        timeOfDay: null,
        provider: secEarningsProvider,
        providerEventId: `${secEarningsProvider}:${cik}:earnings:${row.reportDate}`,
        providerRevision: `${row.accessionNumber}|${row.filingDate}|${row.reportDate}`,
      });
    }
    const events = [...byFiscalDate.values()]
      .filter(
        (event) => event.reportDate >= startDate && event.reportDate <= endDate,
      )
      .sort((left, right) => left.reportDate.localeCompare(right.reportDate));
    const hasForeignAnnual = periodic.some((row) =>
      foreignAnnualForm(row.form),
    );
    const hasForeignInterim = periodic.some(
      (row) => row.form === "6-K" || row.form === "6-K/A",
    );
    const observedAt = this.now().toISOString();
    return {
      range: {
        requestedStartDate: startDate,
        requestedEndDate: endDate,
        provider: secEarningsProvider,
        observedAt,
        providerRevision: [
          secEarningsProvider,
          cik,
          startDate,
          endDate,
          ...events.map((event) => event.providerRevision),
        ].join("|"),
        secCik: cik,
        complete: events.length > 0 && (!hasForeignAnnual || hasForeignInterim),
      },
      events,
    };
  }
}
