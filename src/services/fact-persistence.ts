import {
  type MovementAnalysisRecord,
  MovementAnalysisRepository,
  type NewsSourceRecord,
} from "../db/analyses";
import { DividendRepository } from "../db/dividends";
import { MarketFactRepository } from "../db/market-facts";
import { FactRevisionBucketRepository } from "../db/revision-buckets";
import { canonicalizeDecimal } from "../domain/decimal";
import type {
  DividendEventRange,
  DividendProvider,
  NormalizedDividendEvent,
} from "../providers/dividends";
import type {
  ExplanationProvider,
  ExplanationResult,
} from "../providers/explanations";
import type { NewsItem, NewsProvider } from "../providers/news";
import type { MarketFactError, NormalizedMarketFact } from "./market-facts";

const providerErrorCode = (error: unknown): string => {
  const message =
    error instanceof Error ? error.message : "provider_unavailable";
  return message.startsWith("provider_") ? message : "provider_unavailable";
};

const analysisErrorCode = (error: unknown): string => {
  const message =
    error instanceof Error ? error.message : "analysis_unavailable";
  return message.length > 0 ? message.slice(0, 120) : "analysis_unavailable";
};

const isSafeUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

const bucketForDate = (
  date: string,
  latestTradingDate: string | undefined,
  today: string,
): string =>
  date === (latestTradingDate ?? today) ? "latest" : date.slice(0, 7);

const digest = async (value: string): Promise<string> => {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

export interface MarketPersistenceResult {
  persistedCount: number;
  preservedErrors: Array<MarketFactError & { preserved: true }>;
}

export class MarketFactsPersistenceService {
  private readonly facts: MarketFactRepository;
  private readonly buckets: FactRevisionBucketRepository;

  constructor(
    private readonly db: D1Database,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.facts = new MarketFactRepository(db);
    this.buckets = new FactRevisionBucketRepository(db);
  }

  async persist(input: {
    facts: readonly NormalizedMarketFact[];
    latestTradingDate?: string;
  }): Promise<MarketPersistenceResult> {
    if (input.facts.length === 0) {
      return { persistedCount: 0, preservedErrors: [] };
    }
    const timestamp = this.now().toISOString();
    const bucketKeys = new Set<string>();
    const statements: D1PreparedStatement[] = [];
    for (const fact of input.facts) {
      statements.push(
        this.facts.upsertStatement({
          id: fact.id,
          instrumentId: fact.instrumentId,
          tradingDate: fact.tradingDate,
          previousTradingDate: fact.previousTradingDate,
          previousRawCloseDecimal: fact.previousRawCloseDecimal,
          currentRawCloseDecimal: fact.currentRawCloseDecimal,
          crossingSplitNumerator: fact.crossingSplitNumerator,
          crossingSplitDenominator: fact.crossingSplitDenominator,
          splitAdjustedPreviousCloseDecimal:
            fact.splitAdjustedPreviousCloseDecimal,
          movementAmountDecimal: fact.movementAmountDecimal,
          movementPercentDecimal: fact.movementPercentDecimal,
          rawCloseDifferenceDecimal: fact.rawCloseDifferenceDecimal,
          movementBasis: fact.movementBasis,
          provider: fact.provider,
          providerRevision: fact.providerRevision,
          retrievedAt: fact.retrievedAt,
          status: "valid",
          errorCode: null,
          errorMessage: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      );
      bucketKeys.add(
        bucketForDate(fact.tradingDate, input.latestTradingDate, timestamp),
      );
    }
    for (const bucketKey of bucketKeys) {
      statements.push(this.buckets.bumpStatement(bucketKey, timestamp));
    }
    await this.db.batch(statements);
    return { persistedCount: input.facts.length, preservedErrors: [] };
  }

  async persistResult(input: {
    facts: readonly NormalizedMarketFact[];
    errors: readonly MarketFactError[];
    latestTradingDate?: string;
  }): Promise<MarketPersistenceResult> {
    const result = await this.persist(input);
    return {
      ...result,
      preservedErrors: input.errors.map((error) => ({
        ...error,
        preserved: true as const,
      })),
    };
  }
}

export type DividendRefreshResult =
  | {
      kind: "refreshed";
      events: NormalizedDividendEvent[];
      incompleteHistoryWarning: true;
      noAnnouncedEventCurrentlyKnown: boolean;
    }
  | { kind: "provider_unavailable"; code: string; preserved: true }
  | { kind: "provider_invalid"; code: string; preserved: true };

export interface DividendFactsServiceDependencies {
  db: D1Database;
  provider: DividendProvider;
  now?: () => Date;
  newId?: () => string;
}

export class DividendFactsService {
  private readonly dividends: DividendRepository;
  private readonly buckets: FactRevisionBucketRepository;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly dependencies: DividendFactsServiceDependencies) {
    this.dividends = new DividendRepository(dependencies.db);
    this.buckets = new FactRevisionBucketRepository(dependencies.db);
    this.now = dependencies.now ?? (() => new Date());
    this.newId = dependencies.newId ?? (() => crypto.randomUUID());
  }

  async refresh(input: {
    instrumentId: string;
    symbol: string;
    startDate: string;
    endDate: string;
  }): Promise<DividendRefreshResult> {
    let range: DividendEventRange;
    try {
      range = await this.dependencies.provider.getDividends(
        input.symbol,
        input.startDate,
        input.endDate,
      );
    } catch (error) {
      return {
        kind: "provider_unavailable",
        code: providerErrorCode(error),
        preserved: true,
      };
    }
    if (
      range.symbol.toUpperCase() !== input.symbol.toUpperCase() ||
      range.range.requestedStartDate !== input.startDate ||
      range.range.requestedEndDate !== input.endDate ||
      range.range.basis !== "source-reported" ||
      range.range.isComplete
    ) {
      return {
        kind: "provider_invalid",
        code: "provider_snapshot_mismatch",
        preserved: true,
      };
    }

    const timestamp = this.now().toISOString();
    const statements: D1PreparedStatement[] = [];
    const buckets = new Set<string>();
    try {
      for (const event of range.events) {
        const amount = canonicalizeDecimal(event.amount);
        if (amount.startsWith("-")) throw new Error("provider_invalid_amount");
        if (event.currency !== "USD" && event.currency !== "CAD") {
          throw new Error("provider_unsupported_currency");
        }
        const existing = await this.dividends.listByIdentity({
          instrumentId: input.instrumentId,
          provider: event.provider,
          providerEventId: event.providerEventId,
        });
        const sameActive = existing.some(
          (row) =>
            row.providerRevision === event.providerRevision &&
            row.status === "active" &&
            row.amountPerShareDecimal === amount &&
            row.exDate === event.exDate,
        );
        if (!sameActive) {
          statements.push(
            this.dividends.supersedeIdentityStatement({
              instrumentId: input.instrumentId,
              provider: event.provider,
              providerEventId: event.providerEventId,
              providerRevision: event.providerRevision,
              updatedAt: timestamp,
            }),
            this.dividends.upsertStatement({
              id: this.newId(),
              instrumentId: input.instrumentId,
              exDate: event.exDate,
              declarationDate: null,
              recordDate: null,
              paymentDate: null,
              amountPerShareDecimal: amount,
              currency: event.currency as "USD" | "CAD",
              provider: event.provider,
              providerEventId: event.providerEventId,
              providerRevision: event.providerRevision,
              sourceUrl: null,
              announcedAt: null,
              retrievedAt: range.range.observedAt,
              status: "active",
              errorCode: null,
              errorMessage: null,
              createdAt: timestamp,
              updatedAt: timestamp,
            }),
          );
          buckets.add(event.exDate.slice(0, 7));
        }
      }
      for (const bucketKey of buckets) {
        statements.push(this.buckets.bumpStatement(bucketKey, timestamp));
      }
      if (statements.length > 0) await this.dependencies.db.batch(statements);
    } catch (error) {
      const code = providerErrorCode(error);
      return { kind: "provider_invalid", code, preserved: true };
    }

    const today = timestamp.slice(0, 10);
    return {
      kind: "refreshed",
      events: range.events,
      incompleteHistoryWarning: true,
      noAnnouncedEventCurrentlyKnown:
        range.events.length === 0 && input.endDate >= today,
    };
  }
}

export type AnalysisRefreshResult =
  | { kind: "refreshed"; analysis: MovementAnalysisRecord }
  | { kind: "reused"; analysis: MovementAnalysisRecord }
  | { kind: "error"; code: string; preserved: true };

export interface AnalysisFactsServiceDependencies {
  db: D1Database;
  newsProvider: NewsProvider;
  explanationProvider: ExplanationProvider;
  now?: () => Date;
  newId?: () => string;
}

export class AnalysisFactsService {
  private readonly analyses: MovementAnalysisRepository;
  private readonly buckets: FactRevisionBucketRepository;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly dependencies: AnalysisFactsServiceDependencies) {
    this.analyses = new MovementAnalysisRepository(dependencies.db);
    this.buckets = new FactRevisionBucketRepository(dependencies.db);
    this.now = dependencies.now ?? (() => new Date());
    this.newId = dependencies.newId ?? (() => crypto.randomUUID());
  }

  async refresh(input: {
    fact: NormalizedMarketFact;
    symbol: string;
    companyName: string;
    publishedAfter: string;
    publishedBefore: string;
    latestTradingDate?: string;
  }): Promise<AnalysisRefreshResult> {
    const existing = await this.analyses.findByFact(input.fact.id);
    let sources: NewsItem[];
    try {
      sources = await this.dependencies.newsProvider.search({
        symbol: input.symbol,
        companyName: input.companyName,
        publishedAfter: input.publishedAfter,
        publishedBefore: input.publishedBefore,
      });
      if (
        sources.some(
          (source) =>
            !source.title ||
            !source.publisher ||
            !source.publishedAt ||
            !isSafeUrl(source.url),
        )
      ) {
        throw new Error("unsafe_source_url");
      }
    } catch (error) {
      return this.persistAnalysisError(
        input,
        existing,
        analysisErrorCode(error),
      );
    }
    const normalizedSources = [...sources]
      .map((source) => ({
        title: source.title.trim(),
        publisher: source.publisher.trim(),
        publishedAt: source.publishedAt,
        url: source.url,
        description: source.description ?? "",
      }))
      .sort((left, right) =>
        `${left.url}|${left.publishedAt}`.localeCompare(
          `${right.url}|${right.publishedAt}`,
        ),
      );
    const dependencyFingerprint = await digest(
      JSON.stringify({
        movement: {
          provider: input.fact.provider,
          providerRevision: input.fact.providerRevision,
          tradingDate: input.fact.tradingDate,
          movementBasis: input.fact.movementBasis,
          currentRawCloseDecimal: input.fact.currentRawCloseDecimal,
          previousRawCloseDecimal: input.fact.previousRawCloseDecimal,
          splitAdjustedPreviousCloseDecimal:
            input.fact.splitAdjustedPreviousCloseDecimal,
          movementAmountDecimal: input.fact.movementAmountDecimal,
          movementPercentDecimal: input.fact.movementPercentDecimal,
          crossingSplitNumerator: input.fact.crossingSplitNumerator,
          crossingSplitDenominator: input.fact.crossingSplitDenominator,
        },
        sources: normalizedSources,
      }),
    );
    if (
      existing?.status === "complete" &&
      existing.dependencyFingerprint === dependencyFingerprint
    ) {
      return { kind: "reused", analysis: existing };
    }

    let result: ExplanationResult;
    try {
      result = await this.dependencies.explanationProvider.explain({
        symbol: input.symbol,
        companyName: input.companyName,
        changePct: Number(input.fact.movementPercentDecimal),
        sources,
      });
    } catch (error) {
      return this.persistAnalysisError(
        input,
        existing,
        analysisErrorCode(error),
      );
    }

    const timestamp = this.now().toISOString();
    const analysis: MovementAnalysisRecord = {
      id: existing?.id ?? this.newId(),
      dailyMarketFactId: input.fact.id,
      dependencyFingerprint,
      summaryZhCn: result.explanationZhCn,
      model: result.model,
      status: "complete",
      errorCode: null,
      errorMessage: null,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    const sourceRecords = normalizedSources.map(
      (source, sourceOrder): NewsSourceRecord => ({
        id: this.newId(),
        movementAnalysisId: analysis.id,
        sourceOrder,
        title: source.title,
        publisher: source.publisher,
        publishedAt: source.publishedAt,
        sourceUrl: source.url,
        cited: true,
        createdAt: timestamp,
      }),
    );
    await this.dependencies.db.batch([
      this.analyses.upsertStatement(analysis),
      ...this.analyses.replaceSourcesStatements({
        movementAnalysisId: analysis.id,
        sources: sourceRecords,
      }),
      this.buckets.bumpStatement(
        bucketForDate(
          input.fact.tradingDate,
          input.latestTradingDate,
          timestamp.slice(0, 10),
        ),
        timestamp,
      ),
    ]);
    return { kind: "refreshed", analysis };
  }

  private async persistAnalysisError(
    input: {
      fact: NormalizedMarketFact;
      latestTradingDate?: string;
    },
    existing: MovementAnalysisRecord | null,
    code: string,
  ): Promise<AnalysisRefreshResult> {
    const timestamp = this.now().toISOString();
    const analysis: MovementAnalysisRecord = {
      id: existing?.id ?? this.newId(),
      dailyMarketFactId: input.fact.id,
      dependencyFingerprint:
        existing?.dependencyFingerprint ??
        `failed:${input.fact.providerRevision}`,
      summaryZhCn: existing?.summaryZhCn ?? null,
      model: existing?.model ?? null,
      status: "error",
      errorCode: code,
      errorMessage: code,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    await this.dependencies.db.batch([
      this.analyses.upsertStatement(analysis),
      this.buckets.bumpStatement(
        bucketForDate(
          input.fact.tradingDate,
          input.latestTradingDate,
          timestamp.slice(0, 10),
        ),
        timestamp,
      ),
    ]);
    return { kind: "error", code, preserved: true };
  }
}
