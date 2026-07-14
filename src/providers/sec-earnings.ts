import { z } from "zod";
import type {
  EarningsHistoryProvider,
  EarningsHistoryRange,
  EarningsInstrumentReference,
  NormalizedEarningsEvent,
} from "./earnings";
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
  return Array.from({ length }, (_, index) => ({
    accessionNumber: recent.accessionNumber[index] ?? "",
    filingDate: recent.filingDate[index] ?? "",
    reportDate: recent.reportDate[index] ?? "",
    form: recent.form[index] ?? "",
    items: recent.items[index] ?? "",
  }));
};

const hasItem202 = (items: string): boolean =>
  items.split(",").some((item) => item.trim() === "2.02");

const periodicForm = (form: string): boolean =>
  form === "10-Q" || form === "10-K";

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
    const response = await this.fetcher(url, {
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
        throw new Error("provider_schema");
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
    const cik = (await this.cikDirectory()).get(
      normalizedTicker(instrument.providerSymbol),
    );
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
      throw new Error("provider_schema");
    }
    if (
      payload.cik !== cik ||
      !payload.tickers.some(
        (ticker) =>
          normalizedTicker(ticker) ===
          normalizedTicker(instrument.providerSymbol),
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
        throw new Error("provider_schema");
      }
      rows.push(...rowsFrom(archived));
    }
    const uniqueRows = [
      ...new Map(rows.map((row) => [row.accessionNumber, row])).values(),
    ];
    const periodic = uniqueRows.filter((row) => periodicForm(row.form));
    const earningsRows = uniqueRows.filter(
      (row) =>
        (row.form === "8-K" || row.form === "8-K/A") &&
        hasItem202(row.items) &&
        isIsoCalendarDate(row.reportDate),
    );
    const byFiscalDate = new Map<string, NormalizedEarningsEvent>();
    for (const row of earningsRows) {
      const fiscalDateEnding = matchFiscalDate(row, periodic);
      if (!fiscalDateEnding) throw new Error("provider_history_unavailable");
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
    const missingFiscalPeriod = periodic.some(
      (row) =>
        row.filingDate >= startDate &&
        row.filingDate <= endDate &&
        isIsoCalendarDate(row.reportDate) &&
        row.reportDate < endDate &&
        !byFiscalDate.has(row.reportDate),
    );
    if (missingFiscalPeriod) {
      throw new Error("provider_history_unavailable");
    }

    const events = [...byFiscalDate.values()]
      .filter(
        (event) => event.reportDate >= startDate && event.reportDate <= endDate,
      )
      .sort((left, right) => left.reportDate.localeCompare(right.reportDate));
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
      },
      events,
    };
  }
}
