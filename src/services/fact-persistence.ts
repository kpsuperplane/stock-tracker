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
import { easternMarketDate } from "../shared/dates";
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
    return this.persistBatch({
      facts: input.facts,
      errors: [],
      ...(input.latestTradingDate === undefined
        ? {}
        : { latestTradingDate: input.latestTradingDate }),
    });
  }

  private async persistBatch(input: {
    facts: readonly NormalizedMarketFact[];
    errors: readonly MarketFactError[];
    latestTradingDate?: string;
  }): Promise<MarketPersistenceResult> {
    if (input.facts.length === 0 && input.errors.length === 0) {
      return { persistedCount: 0, preservedErrors: [] };
    }
    const timestamp = this.now().toISOString();
    const localToday = easternMarketDate(timestamp);
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
        bucketForDate(fact.tradingDate, input.latestTradingDate, localToday),
      );
    }
    const markedErrors = new Set<string>();
    for (const error of input.errors) {
      const dates = error.tradingDate
        ? [error.tradingDate]
        : await this.facts.listDatesForInstrument({
            instrumentId: error.instrumentId,
            provider: error.provider,
          });
      for (const date of dates) {
        bucketKeys.add(
          bucketForDate(date, input.latestTradingDate, localToday),
        );
      }
      const markerKey = `${error.instrumentId}|${error.provider}|${error.tradingDate ?? "*"}|${error.errorCode}`;
      if (!markedErrors.has(markerKey)) {
        markedErrors.add(markerKey);
        statements.push(
          this.facts.markErrorStatement({
            instrumentId: error.instrumentId,
            provider: error.provider,
            providerRevision: error.providerRevision,
            retrievedAt: error.retrievedAt,
            errorCode: error.errorCode,
            errorMessage: error.errorMessage,
            updatedAt: timestamp,
            ...(error.tradingDate === null
              ? {}
              : { tradingDate: error.tradingDate }),
          }),
        );
      }
    }
    for (const bucketKey of bucketKeys) {
      statements.push(this.buckets.bumpStatement(bucketKey, timestamp));
    }
    if (statements.length > 0) await this.db.batch(statements);
    return {
      persistedCount: input.facts.length,
      preservedErrors: input.errors.map((error) => ({
        ...error,
        preserved: true as const,
      })),
    };
  }

  async persistResult(input: {
    facts: readonly NormalizedMarketFact[];
    errors: readonly MarketFactError[];
    latestTradingDate?: string;
  }): Promise<MarketPersistenceResult> {
    return this.persistBatch(input);
  }
}

export type DividendRefreshResult =
  | {
      kind: "refreshed";
      events: NormalizedDividendEvent[];
      incompleteHistoryWarning: true;
      noAnnouncedEventCurrentlyKnown: boolean;
      correctionConflict: boolean;
    }
  | { kind: "provider_unavailable"; code: string; preserved: true }
  | { kind: "provider_invalid"; code: string; preserved: true }
  | { kind: "persistence_error"; code: string; preserved: true };

const persistenceErrorCode = (error: unknown): string => {
  const message = error instanceof Error ? error.message : "persistence_error";
  return message.length > 0 ? message.slice(0, 120) : "persistence_error";
};

const dividendDeclarationKey = (providerEventId: string): string | null => {
  const parts = providerEventId.split(":");
  const declaration = parts.at(-1);
  return declaration && declaration !== "unknown-declaration"
    ? declaration
    : null;
};

const canonicalUrl = (value: string): string | null => {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
};

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
  private readonly knownProviderByInstrument = new Map<string, string>();

  constructor(private readonly dependencies: DividendFactsServiceDependencies) {
    this.dividends = new DividendRepository(dependencies.db);
    this.buckets = new FactRevisionBucketRepository(dependencies.db);
    this.now = dependencies.now ?? (() => new Date());
    this.newId = dependencies.newId ?? (() => crypto.randomUUID());
  }

  private async markProviderRowsError(input: {
    instrumentId: string;
    provider?: string;
    startDate?: string;
    endDate?: string;
    errorCode: string;
    errorMessage: string;
    updatedAt: string;
  }): Promise<string | null> {
    if (!input.provider) return null;
    try {
      const rows = await this.dividends.listForProvider({
        instrumentId: input.instrumentId,
        provider: input.provider,
      });
      const affectedRows = rows.filter(
        (row) =>
          row.status === "active" &&
          (input.startDate === undefined || row.exDate >= input.startDate) &&
          (input.endDate === undefined || row.exDate <= input.endDate),
      );
      if (affectedRows.length === 0) return null;
      const statement =
        input.startDate !== undefined && input.endDate !== undefined
          ? this.dividends.markProviderErrorRangeStatement({
              instrumentId: input.instrumentId,
              provider: input.provider,
              startDate: input.startDate,
              endDate: input.endDate,
              errorCode: input.errorCode,
              errorMessage: input.errorMessage,
              updatedAt: input.updatedAt,
            })
          : this.dividends.markProviderErrorStatement({
              instrumentId: input.instrumentId,
              provider: input.provider,
              errorCode: input.errorCode,
              errorMessage: input.errorMessage,
              updatedAt: input.updatedAt,
            });
      const buckets = new Set(
        affectedRows.map((row) => row.exDate.slice(0, 7)),
      );
      await this.dependencies.db.batch([
        statement,
        ...[...buckets].map((bucket) =>
          this.buckets.bumpStatement(bucket, input.updatedAt),
        ),
      ]);
      return null;
    } catch (error) {
      return persistenceErrorCode(error);
    }
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
      const timestamp = this.now().toISOString();
      const knownProvider = this.knownProviderByInstrument.get(
        input.instrumentId,
      );
      const persistenceCode = await this.markProviderRowsError({
        instrumentId: input.instrumentId,
        errorCode: providerErrorCode(error),
        errorMessage: providerErrorCode(error),
        updatedAt: timestamp,
        startDate: input.startDate,
        endDate: input.endDate,
        ...(knownProvider === undefined ? {} : { provider: knownProvider }),
      });
      if (persistenceCode) {
        return {
          kind: "persistence_error",
          code: persistenceCode,
          preserved: true,
        };
      }
      return {
        kind: "provider_unavailable",
        code: providerErrorCode(error),
        preserved: true,
      };
    }
    const timestamp = this.now().toISOString();
    const rangeProvider = range.range.provider;
    if (
      range.symbol.toUpperCase() !== input.symbol.toUpperCase() ||
      range.range.requestedStartDate !== input.startDate ||
      range.range.requestedEndDate !== input.endDate ||
      range.range.basis !== "source-reported" ||
      range.range.isComplete
    ) {
      this.knownProviderByInstrument.set(input.instrumentId, rangeProvider);
      const persistenceCode = await this.markProviderRowsError({
        instrumentId: input.instrumentId,
        provider: rangeProvider,
        startDate: input.startDate,
        endDate: input.endDate,
        errorCode: "provider_snapshot_mismatch",
        errorMessage: "Provider response did not match the requested range.",
        updatedAt: timestamp,
      });
      if (persistenceCode) {
        return {
          kind: "persistence_error",
          code: persistenceCode,
          preserved: true,
        };
      }
      return {
        kind: "provider_invalid",
        code: "provider_snapshot_mismatch",
        preserved: true,
      };
    }

    this.knownProviderByInstrument.set(input.instrumentId, rangeProvider);
    const today = easternMarketDate(timestamp);
    const statements: D1PreparedStatement[] = [];
    const buckets = new Set<string>();
    let correctionConflict = false;
    try {
      const existingProviderRows = await this.dividends.listForProvider({
        instrumentId: input.instrumentId,
        provider: range.range.provider,
      });
      const activeProviderRows = existingProviderRows.filter(
        (row) => row.status === "active",
      );
      const seenProviderEventIds = new Set(
        range.events.map((event) => event.providerEventId),
      );
      const identityCorrectionFor = (event: NormalizedDividendEvent) => {
        const declarationKey = dividendDeclarationKey(event.providerEventId);
        return activeProviderRows.find(
          (row) =>
            row.providerEventId !== event.providerEventId &&
            declarationKey !== null &&
            dividendDeclarationKey(row.providerEventId) === declarationKey,
        );
      };
      const identityMatchedOldIds = new Set(
        range.events
          .map(identityCorrectionFor)
          .filter(
            (row): row is (typeof activeProviderRows)[number] =>
              row !== undefined,
          )
          .map((row) => row.providerEventId),
      );
      const unmatchedActiveRows = activeProviderRows.filter(
        (row) =>
          row.exDate >= input.startDate &&
          row.exDate <= input.endDate &&
          row.exDate <= today &&
          !seenProviderEventIds.has(row.providerEventId) &&
          !identityMatchedOldIds.has(row.providerEventId),
      );
      // A source-reported range cannot prove whether an unreturned historical
      // row was deleted or merely omitted. Keep historical conflicts visible
      // while leaving future rows active unless identity evidence is explicit.
      const quarantineUnmatchedEvents =
        unmatchedActiveRows.length > 0 && range.events.length > 0;
      if (quarantineUnmatchedEvents) correctionConflict = true;
      for (const event of range.events) {
        if (
          event.symbol.toUpperCase() !== input.symbol.toUpperCase() ||
          event.provider !== range.range.provider
        ) {
          throw new Error("provider_snapshot_mismatch");
        }
        let amount: string;
        try {
          amount = canonicalizeDecimal(event.amount);
        } catch {
          throw new Error("provider_invalid_amount");
        }
        if (amount.startsWith("-")) throw new Error("provider_invalid_amount");
        if (event.currency !== "USD" && event.currency !== "CAD") {
          throw new Error("provider_unsupported_currency");
        }
        const existing = existingProviderRows.filter(
          (row) => row.providerEventId === event.providerEventId,
        );
        const identityCorrection = identityCorrectionFor(event);
        const sameActive = existing.some(
          (row) =>
            row.providerRevision === event.providerRevision &&
            row.status === "active" &&
            row.amountPerShareDecimal === amount &&
            row.exDate === event.exDate,
        );
        const sameConflict = existing.some(
          (row) =>
            row.providerRevision === event.providerRevision &&
            row.status === "error" &&
            row.errorCode === "provider_identity_changed" &&
            row.amountPerShareDecimal === amount &&
            row.exDate === event.exDate,
        );
        const priorIdentityConflict = existing.some(
          (row) =>
            row.status === "error" &&
            row.errorCode === "provider_identity_changed",
        );
        if (sameConflict) {
          correctionConflict = true;
        } else if (identityCorrection) {
          correctionConflict = true;
          statements.push(
            this.dividends.supersedeIdentityStatement({
              instrumentId: input.instrumentId,
              provider: event.provider,
              providerEventId: identityCorrection.providerEventId,
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
              status: "error",
              errorCode: "provider_identity_changed",
              errorMessage: "Provider identity changed; review required.",
              createdAt: timestamp,
              updatedAt: timestamp,
            }),
          );
          buckets.add(identityCorrection.exDate.slice(0, 7));
          buckets.add(event.exDate.slice(0, 7));
        } else if (!sameActive) {
          for (const row of existing.filter(
            (candidate) => candidate.status === "active",
          )) {
            buckets.add(row.exDate.slice(0, 7));
          }
          const quarantined =
            quarantineUnmatchedEvents || priorIdentityConflict;
          if (quarantined) correctionConflict = true;
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
              status: quarantined ? "error" : "active",
              errorCode: quarantined ? "provider_identity_changed" : null,
              errorMessage: quarantined
                ? "Provider identity changed; review required."
                : null,
              createdAt: timestamp,
              updatedAt: timestamp,
            }),
          );
          buckets.add(event.exDate.slice(0, 7));
        }
      }
      if (quarantineUnmatchedEvents) {
        for (const row of unmatchedActiveRows) {
          statements.push(
            this.dividends.markErrorStatement({
              id: row.id,
              errorCode: "provider_identity_changed",
              errorMessage:
                "Provider identity changed or event disappeared; review required.",
              updatedAt: timestamp,
            }),
          );
          buckets.add(row.exDate.slice(0, 7));
        }
      }
      for (const bucketKey of buckets) {
        statements.push(this.buckets.bumpStatement(bucketKey, timestamp));
      }
      if (statements.length > 0) await this.dependencies.db.batch(statements);
    } catch (error) {
      const code = error instanceof Error ? error.message : "provider_invalid";
      if (code.startsWith("provider_")) {
        const persistenceCode = await this.markProviderRowsError({
          instrumentId: input.instrumentId,
          provider: rangeProvider,
          startDate: input.startDate,
          endDate: input.endDate,
          errorCode: code,
          errorMessage:
            code === "provider_snapshot_mismatch"
              ? "Provider response did not match the requested range."
              : code,
          updatedAt: timestamp,
        });
        if (persistenceCode) {
          return {
            kind: "persistence_error",
            code: persistenceCode,
            preserved: true,
          };
        }
        return { kind: "provider_invalid", code, preserved: true };
      }
      return {
        kind: "persistence_error",
        code: persistenceErrorCode(error),
        preserved: true,
      };
    }

    return {
      kind: "refreshed",
      events: range.events,
      incompleteHistoryWarning: true,
      noAnnouncedEventCurrentlyKnown:
        input.endDate >= today &&
        !range.events.some((event) => event.exDate > today),
      correctionConflict,
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
    let existing: MovementAnalysisRecord | null;
    try {
      existing = await this.analyses.findByFact(input.fact.id);
    } catch (error) {
      return {
        kind: "error",
        code: persistenceErrorCode(error),
        preserved: true,
      };
    }
    let sources: NewsItem[];
    try {
      sources = await this.dependencies.newsProvider.search({
        symbol: input.symbol,
        companyName: input.companyName,
        publishedAfter: input.publishedAfter,
        publishedBefore: input.publishedBefore,
      });
    } catch (error) {
      return this.persistAnalysisError(
        input,
        existing,
        analysisErrorCode(error),
      );
    }
    let normalizedSources: Array<{
      title: string;
      publisher: string;
      publishedAt: string;
      url: string;
      description: string;
    }>;
    try {
      normalizedSources = sources
        .map((source) => {
          const title = source.title.trim();
          const publisher = source.publisher.trim();
          const url = canonicalUrl(source.url);
          if (!title || !publisher || !source.publishedAt || !url) {
            throw new Error("unsafe_source_url");
          }
          return {
            title,
            publisher,
            publishedAt: source.publishedAt,
            url,
            description: source.description?.trim() ?? "",
          };
        })
        .sort((left, right) =>
          JSON.stringify([
            left.url,
            left.title,
            left.publisher,
            left.publishedAt,
            left.description,
          ]).localeCompare(
            JSON.stringify([
              right.url,
              right.title,
              right.publisher,
              right.publishedAt,
              right.description,
            ]),
          ),
        );
    } catch (error) {
      return this.persistAnalysisError(
        input,
        existing,
        analysisErrorCode(error),
      );
    }
    const normalizedNews: NewsItem[] = normalizedSources.map((source) => ({
      title: source.title,
      publisher: source.publisher,
      publishedAt: source.publishedAt,
      url: source.url,
      description: source.description,
    }));
    const dependencyFingerprint = await digest(
      JSON.stringify({
        context: {
          symbol: input.symbol,
          companyName: input.companyName,
          publishedAfter: input.publishedAfter,
          publishedBefore: input.publishedBefore,
        },
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
        sources: normalizedNews,
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
    try {
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
            easternMarketDate(timestamp),
          ),
          timestamp,
        ),
      ]);
    } catch (error) {
      return {
        kind: "error",
        code: persistenceErrorCode(error),
        preserved: true,
      };
    }
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
    try {
      await this.dependencies.db.batch([
        this.analyses.upsertStatement(analysis),
        this.buckets.bumpStatement(
          bucketForDate(
            input.fact.tradingDate,
            input.latestTradingDate,
            easternMarketDate(timestamp),
          ),
          timestamp,
        ),
      ]);
    } catch (error) {
      return {
        kind: "error",
        code: persistenceErrorCode(error),
        preserved: true,
      };
    }
    return { kind: "error", code, preserved: true };
  }
}
