import {
  type EarningsCoverageRecord,
  EarningsRepository,
} from "../db/earnings";
import { FactRevisionBucketRepository } from "../db/revision-buckets";
import { canonicalizeDecimal } from "../domain/decimal";
import { alphaVantageEarningsProvider } from "../providers/alpha-vantage-earnings";
import type {
  EarningsEventRange,
  EarningsInstrumentReference,
  EarningsProvider,
} from "../providers/earnings";
import { easternMarketDate } from "../shared/dates";

interface HeldInstrumentRow {
  instrument_id: string;
  symbol: string;
  provider_symbol: string;
  exchange: string;
}

export interface EarningsRefreshSummary {
  instruments: number;
  events: number;
  insertedOrCorrected: number;
  markedStale: number;
  coverageStatus: "current" | "stale" | "unavailable";
}

const providerErrorCode = (error: unknown): string => {
  const message =
    error instanceof Error ? error.message : "provider_unavailable";
  return message.startsWith("provider_")
    ? message.slice(0, 120)
    : "provider_unavailable";
};

const addMonthsClamped = (date: string, months: number): string => {
  const [year, month, day] = date.split("-").map(Number);
  const first = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
  ).getUTCDate();
  first.setUTCDate(Math.min(day ?? 1, lastDay));
  return first.toISOString().slice(0, 10);
};

const instrumentReferences = (
  rows: readonly HeldInstrumentRow[],
): EarningsInstrumentReference[] =>
  rows.map((row) => ({
    instrumentId: row.instrument_id,
    symbol: row.symbol,
    providerSymbol: row.provider_symbol,
    exchange: row.exchange,
  }));

export class ScheduledEarningsRefreshService {
  private readonly earnings: EarningsRepository;
  private readonly buckets: FactRevisionBucketRepository;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly dependencies: {
      db: D1Database;
      provider?: EarningsProvider;
      now?: () => Date;
      newId?: () => string;
    },
  ) {
    this.earnings = new EarningsRepository(dependencies.db);
    this.buckets = new FactRevisionBucketRepository(dependencies.db);
    this.now = dependencies.now ?? (() => new Date());
    this.newId = dependencies.newId ?? (() => crypto.randomUUID());
  }

  private async rows(): Promise<HeldInstrumentRow[]> {
    const result = await this.dependencies.db
      .prepare(
        `SELECT DISTINCT i.id AS instrument_id, i.symbol, i.provider_symbol,
                         i.exchange
           FROM instruments i
           JOIN transactions t ON t.instrument_id = i.id
          WHERE i.instrument_type = 'stock'
          ORDER BY i.symbol`,
      )
      .all<HeldInstrumentRow>();
    return result.results;
  }

  private async recordCoverageFailure(input: {
    startDate: string;
    endDate: string;
    errorCode: string;
    timestamp: string;
  }): Promise<"stale" | "unavailable"> {
    const existing = await this.earnings.coverage(alphaVantageEarningsProvider);
    const status = existing?.coverageEndDate
      ? ("stale" as const)
      : ("unavailable" as const);
    const coverage: EarningsCoverageRecord = {
      provider: alphaVantageEarningsProvider,
      coverageStartDate: existing?.coverageStartDate ?? null,
      coverageEndDate: existing?.coverageEndDate ?? null,
      horizon: "3month",
      providerRevision: existing?.providerRevision ?? null,
      observedAt: existing?.observedAt ?? null,
      status,
      errorCode: input.errorCode,
      errorMessage: input.errorCode,
      updatedAt: input.timestamp,
    };
    await this.dependencies.db.batch([
      this.earnings.upsertCoverageStatement(coverage),
      this.buckets.bumpRangeStatement(
        input.startDate,
        input.endDate,
        input.timestamp,
      ),
    ]);
    return status;
  }

  async refreshHeldInstruments(): Promise<EarningsRefreshSummary> {
    const rows = await this.rows();
    const timestamp = this.now().toISOString();
    const startDate = easternMarketDate(timestamp);
    const endDate = addMonthsClamped(startDate, 3);
    if (!this.dependencies.provider) {
      const coverageStatus = await this.recordCoverageFailure({
        startDate,
        endDate,
        errorCode: "provider_key_unavailable",
        timestamp,
      });
      return {
        instruments: rows.length,
        events: 0,
        insertedOrCorrected: 0,
        markedStale: 0,
        coverageStatus,
      };
    }

    let range: EarningsEventRange;
    try {
      range = await this.dependencies.provider.getEarningsCalendar(
        instrumentReferences(rows),
        startDate,
        endDate,
      );
    } catch (error) {
      const coverageStatus = await this.recordCoverageFailure({
        startDate,
        endDate,
        errorCode: providerErrorCode(error),
        timestamp,
      });
      return {
        instruments: rows.length,
        events: 0,
        insertedOrCorrected: 0,
        markedStale: 0,
        coverageStatus,
      };
    }

    if (
      range.range.provider !== alphaVantageEarningsProvider ||
      range.range.requestedStartDate !== startDate ||
      range.range.requestedEndDate !== endDate
    ) {
      const coverageStatus = await this.recordCoverageFailure({
        startDate,
        endDate,
        errorCode: "provider_snapshot_mismatch",
        timestamp,
      });
      return {
        instruments: rows.length,
        events: 0,
        insertedOrCorrected: 0,
        markedStale: 0,
        coverageStatus,
      };
    }

    const byInstrument = new Map(rows.map((row) => [row.instrument_id, row]));
    const existing = await this.earnings.listForInstruments(
      rows.map((row) => row.instrument_id),
      range.range.provider,
    );
    const seenIdentities = new Set<string>();
    const statements: D1PreparedStatement[] = [];
    const buckets = new Set<string>();
    let insertedOrCorrected = 0;
    let markedStale = 0;
    try {
      for (const event of range.events) {
        const instrument = byInstrument.get(event.instrumentId);
        if (
          !instrument ||
          event.type !== "earnings" ||
          event.symbol.toUpperCase() !== instrument.symbol.toUpperCase() ||
          event.provider !== range.range.provider ||
          event.reportDate < startDate ||
          event.reportDate > endDate
        ) {
          throw new Error("provider_snapshot_mismatch");
        }
        const estimate =
          event.epsEstimate === null
            ? null
            : canonicalizeDecimal(event.epsEstimate);
        if (event.currency !== "USD" && event.currency !== "CAD") {
          throw new Error("provider_unsupported_currency");
        }
        const identityKey = `${event.instrumentId}:${event.providerEventId}`;
        seenIdentities.add(identityKey);
        const identityRows = existing.filter(
          (row) =>
            row.instrumentId === event.instrumentId &&
            row.providerEventId === event.providerEventId,
        );
        const sameActive = identityRows.some(
          (row) =>
            row.providerRevision === event.providerRevision &&
            row.reportDate === event.reportDate &&
            row.epsEstimateDecimal === estimate &&
            row.status === "active",
        );
        if (sameActive) continue;
        for (const row of identityRows.filter(
          (candidate) => candidate.status !== "superseded",
        )) {
          buckets.add(row.reportDate.slice(0, 7));
        }
        statements.push(
          this.earnings.supersedeIdentityStatement({
            instrumentId: event.instrumentId,
            provider: event.provider,
            providerEventId: event.providerEventId,
            providerRevision: event.providerRevision,
            updatedAt: timestamp,
          }),
          this.earnings.upsertStatement({
            id: this.newId(),
            instrumentId: event.instrumentId,
            reportDate: event.reportDate,
            fiscalDateEnding: event.fiscalDateEnding,
            epsEstimateDecimal: estimate,
            currency: event.currency,
            timeOfDay: event.timeOfDay,
            provider: event.provider,
            providerEventId: event.providerEventId,
            providerRevision: event.providerRevision,
            retrievedAt: range.range.observedAt,
            status: "active",
            createdAt: timestamp,
            updatedAt: timestamp,
          }),
        );
        buckets.add(event.reportDate.slice(0, 7));
        insertedOrCorrected += 1;
      }
      for (const row of existing) {
        if (
          row.status === "active" &&
          row.reportDate >= startDate &&
          row.reportDate <= endDate &&
          !seenIdentities.has(`${row.instrumentId}:${row.providerEventId}`)
        ) {
          statements.push(
            this.earnings.markStaleStatement({
              id: row.id,
              updatedAt: timestamp,
            }),
          );
          buckets.add(row.reportDate.slice(0, 7));
          markedStale += 1;
        }
      }
    } catch (error) {
      const coverageStatus = await this.recordCoverageFailure({
        startDate,
        endDate,
        errorCode: providerErrorCode(error),
        timestamp,
      });
      return {
        instruments: rows.length,
        events: 0,
        insertedOrCorrected: 0,
        markedStale: 0,
        coverageStatus,
      };
    }

    statements.push(
      this.earnings.upsertCoverageStatement({
        provider: range.range.provider,
        coverageStartDate: startDate,
        coverageEndDate: endDate,
        horizon: "3month",
        providerRevision: range.range.providerRevision,
        observedAt: range.range.observedAt,
        status: "current",
        errorCode: null,
        errorMessage: null,
        updatedAt: timestamp,
      }),
      this.buckets.bumpRangeStatement(startDate, endDate, timestamp),
    );
    for (const bucket of buckets) {
      statements.push(this.buckets.bumpStatement(bucket, timestamp));
    }
    await this.dependencies.db.batch(statements);
    return {
      instruments: rows.length,
      events: range.events.length,
      insertedOrCorrected,
      markedStale,
      coverageStatus: "current",
    };
  }
}
