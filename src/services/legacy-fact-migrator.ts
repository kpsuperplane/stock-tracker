import Decimal from "decimal.js";
import {
  type MovementAnalysisRecord,
  MovementAnalysisRepository,
  type NewsSourceRecord,
} from "../db/analyses";
import { MarketFactRepository } from "../db/market-facts";
import {
  LEGACY_MIGRATION_ID,
  type MigrationCursor,
  type MigrationPageStats,
  MigrationStateRepository,
} from "../db/migration-state";
import { FactRevisionBucketRepository } from "../db/revision-buckets";
import { canonicalizeDecimal, DecimalValue } from "../domain/decimal";
import {
  LEGACY_ANALYSIS_PREFIX,
  LEGACY_PROVIDER,
  legacyAnalysisFingerprint,
  legacyProviderRevision,
} from "./legacy-mapping";

const LEGACY_INSTRUMENT_PREFIX = "legacy-ticker:";
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const LEASE_MS = 2 * 60 * 1000;

type MigrationScreeningRow = {
  runId: string;
  generation: number;
  tradingDate: string;
  screeningId: string;
  tickerId: string;
  symbol: string;
  companyName: string;
  exchange: string;
  currency: "USD" | "CAD";
  previousDate: string | null;
  previousPrice: number | null;
  currentPrice: number | null;
  changeAmount: number | null;
  changePct: number | null;
  priceBasis: string | null;
  qualified: number | null;
  screeningStatus: string;
  screeningErrorCode: string | null;
  screeningErrorMessage: string | null;
  analysisSummary: string | null;
  analysisModel: string | null;
  analysisStatus: string | null;
};

type MigrationSourceRow = {
  sourceOrder: number;
  title: string;
  publisher: string | null;
  publishedAt: string | null;
  sourceUrl: string;
  cited: number;
};

type ExistingFact = {
  id: string;
  providerRevision: string;
  current: string;
  previous: string | null;
  movementAmount: string | null;
  movementPercent: string | null;
  rawDifference: string | null;
};

type ExistingAnalysis = {
  id: string;
  dependencyFingerprint: string;
};

export interface LegacyFactMigratorOptions {
  /** The caller must pass a strict, validated flag value. */
  enabled?: boolean;
  now?: () => Date;
  beforePage?: () => void | Promise<void>;
  /** Test/diagnostic hook for exercising per-screening source failures. */
  beforeSourceRead?: (screeningId: string) => void | Promise<void>;
}

export interface MigrationPageResult {
  status: "disabled" | "leased" | "running" | "complete" | "failed";
  owner: string | null;
  examined: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
  mismatched: number;
  errors: number;
  cursor: MigrationCursor | null;
  highWater: {
    tradingDate: string;
    generation: number;
    runId: string;
  } | null;
  consecutiveCleanPasses: number;
  message?: string;
}

const boundedMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
};

const safeDecimal = (value: number | null, positive = false): string | null => {
  if (value === null || !Number.isFinite(value)) return null;
  try {
    const decimal = canonicalizeDecimal(new Decimal(value).toFixed());
    if (positive && !DecimalValue.parse(decimal).isPositive()) return null;
    return decimal;
  } catch {
    return null;
  }
};

const safeSourceUrl = (value: string): string | null => {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
};

const digest = async (value: string): Promise<string> => {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const fallbackHash = (value: string): string => {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").repeat(8);
};

const bucketForDate = async (
  db: D1Database,
  tradingDate: string,
): Promise<string> => {
  const latest = await db
    .prepare(
      "SELECT MAX(trading_date) AS tradingDate FROM report_runs WHERE published = 1",
    )
    .first<{ tradingDate: string | null }>();
  return latest?.tradingDate === tradingDate
    ? "latest"
    : tradingDate.slice(0, 7);
};

const hashPayload = (
  row: MigrationScreeningRow,
  sources: MigrationSourceRow[],
) =>
  JSON.stringify({
    run: {
      id: row.runId,
      generation: row.generation,
      tradingDate: row.tradingDate,
    },
    screening: {
      id: row.screeningId,
      tickerId: row.tickerId,
      symbol: row.symbol,
      companyName: row.companyName,
      exchange: row.exchange,
      currency: row.currency,
      previousDate: row.previousDate,
      previousPrice: row.previousPrice,
      currentPrice: row.currentPrice,
      changeAmount: row.changeAmount,
      changePct: row.changePct,
      priceBasis: row.priceBasis,
      status: row.screeningStatus,
      errorCode: row.screeningErrorCode,
      errorMessage: row.screeningErrorMessage,
    },
    analysis: {
      summary: row.analysisSummary,
      model: row.analysisModel,
      status: row.analysisStatus,
    },
    sources: sources.map((source) => ({
      order: source.sourceOrder,
      title: source.title,
      publisher: source.publisher,
      publishedAt: source.publishedAt,
      sourceUrl: source.sourceUrl,
      cited: source.cited,
    })),
  });

export class LegacyFactMigrator {
  private readonly state: MigrationStateRepository;
  private readonly facts: MarketFactRepository;
  private readonly analyses: MovementAnalysisRepository;
  private readonly buckets: FactRevisionBucketRepository;
  private readonly enabled: boolean;
  private readonly now: () => Date;
  private readonly beforePage: (() => void | Promise<void>) | undefined;
  private readonly beforeSourceRead:
    | ((screeningId: string) => void | Promise<void>)
    | undefined;

  constructor(
    private readonly db: D1Database,
    options: LegacyFactMigratorOptions = {},
  ) {
    this.state = new MigrationStateRepository(db);
    this.facts = new MarketFactRepository(db);
    this.analyses = new MovementAnalysisRepository(db);
    this.buckets = new FactRevisionBucketRepository(db);
    this.enabled = options.enabled === true;
    this.now = options.now ?? (() => new Date());
    this.beforePage = options.beforePage;
    this.beforeSourceRead = options.beforeSourceRead;
  }

  async status() {
    return this.state.get(LEGACY_MIGRATION_ID);
  }

  async runPage(
    input: { pageSize?: number; owner?: string; now?: string } = {},
  ): Promise<MigrationPageResult> {
    if (!this.enabled) {
      return {
        status: "disabled",
        owner: null,
        examined: 0,
        inserted: 0,
        updated: 0,
        unchanged: 0,
        skipped: 0,
        mismatched: 0,
        errors: 0,
        cursor: null,
        highWater: null,
        consecutiveCleanPasses: 0,
      };
    }
    const now = input.now ?? this.now().toISOString();
    const owner = input.owner ?? crypto.randomUUID();
    const pageSize = Math.max(
      1,
      Math.min(input.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
    );
    const leaseUntil = new Date(Date.parse(now) + LEASE_MS).toISOString();
    if (!(await this.state.claimLease({ owner, now, leaseUntil }))) {
      const current = await this.state.get();
      return this.resultFromState("leased", current, owner);
    }

    try {
      let current = await this.state.get();
      if (!current) throw new Error("migration_state_missing");
      if (!current.cursor && current.status !== "running") {
        if (!(await this.state.beginPass({ owner, now }))) {
          throw new Error("migration_pass_claim_lost");
        }
        current = await this.state.get();
        if (!current) throw new Error("migration_state_missing");
      }
      if (!current.highWater) {
        await this.state.captureHighWater({ owner, now });
        current = await this.state.get();
        if (!current) throw new Error("migration_state_missing");
      }
      await this.sweepTickerIdentities(now);
      await this.beforePage?.();
      const rows = await this.page(current.cursor, current.highWater, pageSize);
      const stats: MigrationPageStats = {
        examined: 0,
        inserted: 0,
        updated: 0,
        unchanged: 0,
        skipped: 0,
        mismatched: 0,
        errors: 0,
        unexplained: 0,
        auditHash: null,
      };
      const auditHashes: string[] = [];
      let lastCursor = current.cursor;
      for (const row of rows) {
        const result = await this.process(row, now);
        stats.examined += 1;
        stats[result.outcome] += 1;
        if (
          result.outcome === "skipped" ||
          result.outcome === "mismatched" ||
          result.outcome === "errors"
        ) {
          stats.unexplained += 1;
        }
        auditHashes.push(result.contentHash);
        lastCursor = {
          tradingDate: row.tradingDate,
          runId: row.runId,
          generation: row.generation,
          screeningId: row.screeningId,
        };
      }
      stats.auditHash = await digest(JSON.stringify(auditHashes));
      const complete = rows.length < pageSize;
      if (
        !(await this.state.advance({
          owner,
          now,
          cursor: complete ? null : lastCursor,
          complete,
          stats,
        }))
      ) {
        throw new Error("migration_state_advance_lost");
      }
      const next = await this.state.get();
      return this.resultFromState(
        complete ? "complete" : "running",
        next,
        owner,
        stats,
      );
    } catch (error) {
      await this.state.fail({
        owner,
        now,
        code: "migration_page_failed",
        message: boundedMessage(error),
      });
      const failed = await this.state.get();
      return this.resultFromState(
        "failed",
        failed,
        owner,
        undefined,
        boundedMessage(error),
      );
    }
  }

  private resultFromState(
    status: MigrationPageResult["status"],
    state: Awaited<ReturnType<MigrationStateRepository["get"]>>,
    owner: string | null,
    stats?: MigrationPageStats,
    message?: string,
  ): MigrationPageResult {
    return {
      status,
      owner,
      examined: stats?.examined ?? 0,
      inserted: stats?.inserted ?? 0,
      updated: stats?.updated ?? 0,
      unchanged: stats?.unchanged ?? 0,
      skipped: stats?.skipped ?? 0,
      mismatched: stats?.mismatched ?? 0,
      errors: stats?.errors ?? 0,
      cursor: state?.cursor ?? null,
      highWater: state?.highWater ?? null,
      consecutiveCleanPasses: state?.consecutiveCleanPasses ?? 0,
      ...(message ? { message } : {}),
    };
  }

  private async page(
    cursor: MigrationCursor | null,
    highWater: {
      tradingDate: string;
      generation: number;
      runId: string;
    } | null,
    pageSize: number,
  ): Promise<MigrationScreeningRow[]> {
    const result = await this.db
      .prepare(
        `SELECT r.id AS runId, r.generation, r.trading_date AS tradingDate,
                s.id AS screeningId, s.ticker_id AS tickerId, s.symbol,
                s.company_name AS companyName, s.exchange, s.currency,
                s.previous_bar_date AS previousDate,
                s.previous_price AS previousPrice,
                s.current_price AS currentPrice,
                s.change_amount AS changeAmount, s.change_pct AS changePct,
                s.price_basis AS priceBasis, s.qualified,
                s.status AS screeningStatus,
                s.error_code AS screeningErrorCode,
                s.error_message AS screeningErrorMessage,
                a.explanation_zh_cn AS analysisSummary,
                a.model AS analysisModel, a.status AS analysisStatus
           FROM report_runs r
           JOIN screenings s ON s.report_run_id = r.id
           LEFT JOIN analyses a ON a.screening_id = s.id
          WHERE r.published = 1
            AND ?5 IS NOT NULL
            AND (
              ?1 IS NULL OR r.trading_date > ?1 OR
              (r.trading_date = ?1 AND (
                r.generation > ?2 OR
                (r.generation = ?2 AND (
                  r.id > ?3 OR (r.id = ?3 AND s.id > ?4)
                ))
              ))
            )
            AND (
              r.trading_date < ?5 OR
              (r.trading_date = ?5 AND (
                r.generation < ?6 OR
                (r.generation = ?6 AND r.id <= ?7)
              ))
            )
          ORDER BY r.trading_date, r.generation, r.id, s.id
          LIMIT ?8`,
      )
      .bind(
        cursor?.tradingDate ?? null,
        cursor?.generation ?? null,
        cursor?.runId ?? null,
        cursor?.screeningId ?? null,
        highWater?.tradingDate ?? null,
        highWater?.generation ?? null,
        highWater?.runId ?? null,
        pageSize,
      )
      .all<MigrationScreeningRow>();
    return result.results;
  }

  private async loadSources(
    screeningId: string,
  ): Promise<MigrationSourceRow[]> {
    const result = await this.db
      .prepare(
        `SELECT source_index AS sourceOrder, title, publisher,
                published_at AS publishedAt, url AS sourceUrl, cited
           FROM sources WHERE screening_id = ?1 ORDER BY source_index`,
      )
      .bind(screeningId)
      .all<MigrationSourceRow>();
    return result.results;
  }

  private async currentWinner(row: MigrationScreeningRow): Promise<boolean> {
    const winner = await this.db
      .prepare(
        `SELECT id, generation FROM report_runs
          WHERE trading_date = ?1 AND published = 1`,
      )
      .bind(row.tradingDate)
      .first<{ id: string; generation: number }>();
    return winner?.id === row.runId && winner.generation === row.generation;
  }

  private async ensureInstrument(
    row: MigrationScreeningRow,
    now: string,
  ): Promise<string> {
    const existing = await this.db
      .prepare("SELECT id FROM instruments WHERE symbol = ?1")
      .bind(row.symbol)
      .first<{ id: string }>();
    if (existing) return existing.id;
    const candidateId = `${LEGACY_INSTRUMENT_PREFIX}${row.tickerId}`;
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO instruments
           (id, symbol, company_name, exchange, currency, instrument_type,
            provider, provider_symbol, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'stock', ?6, ?2, ?7, ?7)`,
      )
      .bind(
        candidateId,
        row.symbol,
        row.companyName,
        row.exchange,
        row.currency,
        LEGACY_PROVIDER,
        now,
      )
      .run();
    const resolved = await this.db
      .prepare("SELECT id FROM instruments WHERE symbol = ?1")
      .bind(row.symbol)
      .first<{ id: string }>();
    if (!resolved) throw new Error("migration_instrument_unresolved");
    return resolved.id;
  }

  /**
   * Preserve every currently known legacy ticker identity, including deleted
   * watchlist entries. The watchlist is capped at 100 active entries, so this
   * set-based sweep is bounded by the personal ticker table (active watchlist
   * entries are capped at 100); referenced identities are always ensured by
   * the row materializer as well.
   */
  private async sweepTickerIdentities(now: string): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `INSERT OR IGNORE INTO instruments
             (id, symbol, company_name, exchange, currency, instrument_type,
              provider, provider_symbol, provider_metadata_json, created_at,
              updated_at)
           SELECT 'legacy-ticker:' || id, symbol, company_name, exchange,
                  currency, 'stock', ?1, symbol,
                  json_object(
                    'legacyTickerId', id,
                    'legacyActive', CASE WHEN active = 1 THEN json('true') ELSE json('false') END,
                    'legacyDeletedAt', deleted_at
                  ),
                  ?2, ?2
             FROM tickers`,
        )
        .bind(LEGACY_PROVIDER, now),
      this.db
        .prepare(
          `UPDATE instruments
              SET provider_metadata_json = (
                    SELECT json_object(
                      'legacyTickerId', t.id,
                      'legacyActive', CASE WHEN t.active = 1 THEN json('true') ELSE json('false') END,
                      'legacyDeletedAt', t.deleted_at
                    )
                      FROM tickers t
                     WHERE 'legacy-ticker:' || t.id = instruments.id
                  ),
                  updated_at = ?1
            WHERE provider = ?2
              AND EXISTS (
                SELECT 1 FROM tickers t
                 WHERE 'legacy-ticker:' || t.id = instruments.id
              )`,
        )
        .bind(now, LEGACY_PROVIDER),
    ]);
  }

  private async existingFact(
    instrumentId: string,
    tradingDate: string,
  ): Promise<ExistingFact | null> {
    return (
      (await this.db
        .prepare(
          `SELECT id, provider_revision AS providerRevision,
                  current_raw_close_decimal AS current,
                  previous_raw_close_decimal AS previous,
                  movement_amount_decimal AS movementAmount,
                  movement_percent_decimal AS movementPercent,
                  raw_close_difference_decimal AS rawDifference
             FROM daily_market_facts
            WHERE instrument_id = ?1 AND trading_date = ?2`,
        )
        .bind(instrumentId, tradingDate)
        .first<ExistingFact>()) ?? null
    );
  }

  private async existingAnalysis(
    factId: string,
  ): Promise<ExistingAnalysis | null> {
    return (
      (await this.db
        .prepare(
          `SELECT id, dependency_fingerprint AS dependencyFingerprint
             FROM movement_analyses WHERE daily_market_fact_id = ?1`,
        )
        .bind(factId)
        .first<ExistingAnalysis>()) ?? null
    );
  }

  private async process(
    row: MigrationScreeningRow,
    now: string,
  ): Promise<{
    outcome:
      | "inserted"
      | "updated"
      | "unchanged"
      | "skipped"
      | "mismatched"
      | "errors";
    contentHash: string;
  }> {
    let sources: MigrationSourceRow[] = [];
    const provenancePayload = JSON.stringify({
      runId: row.runId,
      screeningId: row.screeningId,
      generation: row.generation,
      tradingDate: row.tradingDate,
      tickerId: row.tickerId,
    });
    let contentHash = fallbackHash(hashPayload(row, sources));
    let provenanceHash = fallbackHash(provenancePayload);
    let auditId = `${LEGACY_MIGRATION_ID}:${row.runId}:${row.screeningId}:${row.generation}:${contentHash}`;
    const audit = (input: {
      outcome: string;
      reasonCode?: string | null;
      reasonMessage?: string | null;
      instrumentId?: string | null;
    }) =>
      this.state.auditStatement({
        id: auditId,
        legacyRunId: row.runId,
        legacyScreeningId: row.screeningId,
        legacyGeneration: row.generation,
        tradingDate: row.tradingDate,
        tickerId: row.tickerId,
        instrumentId: input.instrumentId ?? null,
        contentHash,
        provenanceHash,
        outcome: input.outcome,
        reasonCode: input.reasonCode ?? null,
        reasonMessage: input.reasonMessage ?? null,
        examinedAt: now,
      });
    try {
      await this.beforeSourceRead?.(row.screeningId);
      sources = await this.loadSources(row.screeningId);
      contentHash = await digest(hashPayload(row, sources));
      provenanceHash = await digest(provenancePayload);
      auditId = `${LEGACY_MIGRATION_ID}:${row.runId}:${row.screeningId}:${row.generation}:${contentHash}`;
      if (
        await this.state.hasMismatchedAudit({
          screeningId: row.screeningId,
          generation: row.generation,
        })
      ) {
        await this.db.batch([
          audit({
            outcome: "mismatched",
            reasonCode: "migration_hash_mismatch",
            reasonMessage:
              "A prior hash mismatch remains unresolved; manual review is required.",
          }),
        ]);
        return { outcome: "mismatched", contentHash };
      }
      const auditPrevious = await this.state.latestAudit({
        screeningId: row.screeningId,
        generation: row.generation,
      });
      const retryableAudit =
        auditPrevious?.outcome === "error" ||
        auditPrevious?.outcome === "skipped";
      if (
        auditPrevious &&
        !retryableAudit &&
        (auditPrevious.outcome === "mismatched" ||
          auditPrevious.contentHash !== contentHash ||
          auditPrevious.provenanceHash !== provenanceHash)
      ) {
        await this.db.batch([
          audit({
            outcome: "mismatched",
            reasonCode: "migration_hash_mismatch",
            reasonMessage: "Legacy content or provenance hash changed.",
          }),
        ]);
        return { outcome: "mismatched", contentHash };
      }
      if (!(await this.currentWinner(row))) {
        await this.db.batch([
          audit({
            outcome: "skipped",
            reasonCode: "migration_winner_changed",
            reasonMessage:
              "Published generation changed before materialization.",
          }),
        ]);
        return { outcome: "skipped", contentHash };
      }
      const instrumentId = await this.ensureInstrument(row, now);
      const current = safeDecimal(row.currentPrice, true);
      if (!current) {
        await this.db.batch([
          audit({
            outcome: "skipped",
            reasonCode: "migration_missing_price",
            reasonMessage: "Published screening has no valid current price.",
            instrumentId,
          }),
        ]);
        return { outcome: "skipped", contentHash };
      }
      const previous = safeDecimal(row.previousPrice, true);
      const hasMovement =
        row.previousDate !== null &&
        row.previousDate < row.tradingDate &&
        previous !== null &&
        safeDecimal(row.changeAmount) !== null &&
        safeDecimal(row.changePct) !== null;
      const previousDate = hasMovement ? row.previousDate : null;
      const previousRaw = hasMovement ? previous : null;
      const movementAmount = hasMovement ? safeDecimal(row.changeAmount) : null;
      const movementPercent = hasMovement ? safeDecimal(row.changePct) : null;
      const existingFact = await this.existingFact(
        instrumentId,
        row.tradingDate,
      );
      const factId = existingFact?.id ?? `${instrumentId}:${row.tradingDate}`;
      const providerRevision = legacyProviderRevision(row);
      const fact = {
        id: factId,
        instrumentId,
        tradingDate: row.tradingDate,
        previousTradingDate: previousDate,
        previousRawCloseDecimal: previousRaw,
        currentRawCloseDecimal: current,
        crossingSplitNumerator: "1",
        crossingSplitDenominator: "1",
        splitAdjustedPreviousCloseDecimal: previousRaw,
        movementAmountDecimal: movementAmount,
        movementPercentDecimal: movementPercent,
        rawCloseDifferenceDecimal:
          row.priceBasis === "close" ? movementAmount : null,
        movementBasis: "legacy_migration" as const,
        provider: LEGACY_PROVIDER,
        providerRevision,
        retrievedAt: now,
        status: "valid" as const,
        errorCode: null,
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
      };
      const existingAnalysis = await this.existingAnalysis(factId);
      const analysisId =
        existingAnalysis?.id ?? `${LEGACY_ANALYSIS_PREFIX}${factId}`;
      const validSources: NewsSourceRecord[] = sources
        .map((source) => {
          const sourceUrl = safeSourceUrl(source.sourceUrl);
          if (!sourceUrl) return null;
          return {
            id: `${analysisId}:source:${source.sourceOrder}`,
            movementAnalysisId: analysisId,
            sourceOrder: source.sourceOrder,
            title: source.title,
            publisher: source.publisher,
            publishedAt: source.publishedAt,
            sourceUrl,
            cited: source.cited === 1,
            createdAt: now,
          } satisfies NewsSourceRecord;
        })
        .filter((source): source is NewsSourceRecord => source !== null);
      const analysisStatus =
        row.analysisStatus === "complete" && row.analysisSummary
          ? "complete"
          : row.screeningStatus === "failed" ||
              row.analysisStatus === "unavailable"
            ? "error"
            : "pending";
      const analysisSummary =
        analysisStatus === "complete" ? row.analysisSummary : null;
      const dependencyFingerprint = await legacyAnalysisFingerprint({
        providerRevision,
        status: analysisStatus,
        summary: analysisSummary,
        model: row.analysisModel,
        sources: validSources,
      });
      const analysis: MovementAnalysisRecord = {
        id: analysisId,
        dailyMarketFactId: factId,
        dependencyFingerprint,
        summaryZhCn: analysisSummary,
        model: row.analysisModel,
        status: analysisStatus,
        errorCode:
          row.screeningStatus === "failed" ||
          row.analysisStatus === "unavailable"
            ? (row.screeningErrorCode ?? "migration_analysis_unavailable")
            : null,
        errorMessage:
          row.screeningStatus === "failed" ||
          row.analysisStatus === "unavailable"
            ? (row.screeningErrorMessage ?? "Legacy analysis is unavailable.")
            : null,
        createdAt: now,
        updatedAt: now,
      };
      const factChanged =
        !existingFact ||
        existingFact.providerRevision !== providerRevision ||
        existingFact.current !== current ||
        existingFact.previous !== previousRaw ||
        existingFact.movementAmount !== movementAmount ||
        existingFact.movementPercent !== movementPercent ||
        existingFact.rawDifference !== fact.rawCloseDifferenceDecimal;
      const analysisChanged =
        !existingAnalysis ||
        existingAnalysis.dependencyFingerprint !== dependencyFingerprint;
      const guard = {
        tradingDate: row.tradingDate,
        generation: row.generation,
      };
      if (factChanged || analysisChanged) {
        const statements: D1PreparedStatement[] = [];
        if (factChanged)
          statements.push(this.facts.upsertStatement(fact, guard));
        if (analysisChanged) {
          statements.push(this.analyses.upsertStatement(analysis, guard));
          statements.push(
            ...this.analyses.replaceSourcesStatements(
              {
                movementAnalysisId: analysisId,
                sources: validSources,
              },
              guard,
              factId,
            ),
          );
        }
        statements.push(
          this.buckets.bumpStatement(
            await bucketForDate(this.db, row.tradingDate),
            now,
            guard,
          ),
        );
        await this.db.batch(statements);
        if (!(await this.currentWinner(row))) {
          await this.db.batch([
            audit({
              outcome: "skipped",
              reasonCode: "migration_winner_changed",
              reasonMessage:
                "Published generation changed during materialization.",
              instrumentId,
            }),
          ]);
          return { outcome: "skipped", contentHash };
        }
      }
      await this.db.batch([
        audit({
          outcome:
            factChanged || analysisChanged
              ? existingFact
                ? "updated"
                : "inserted"
              : "unchanged",
          instrumentId,
        }),
      ]);
      return {
        outcome:
          factChanged || analysisChanged
            ? existingFact
              ? "updated"
              : "inserted"
            : "unchanged",
        contentHash,
      };
    } catch (error) {
      await this.db.batch([
        audit({
          outcome: "error",
          reasonCode: "migration_materialization_failed",
          reasonMessage: boundedMessage(error),
        }),
      ]);
      return { outcome: "errors", contentHash };
    }
  }
}
