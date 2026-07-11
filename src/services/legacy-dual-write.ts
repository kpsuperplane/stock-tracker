import Decimal from "decimal.js";
import {
  type MovementAnalysisRecord,
  MovementAnalysisRepository,
  type NewsSourceRecord,
} from "../db/analyses";
import { MarketFactRepository } from "../db/market-facts";
import { FactRevisionBucketRepository } from "../db/revision-buckets";
import { canonicalizeDecimal, DecimalValue } from "../domain/decimal";
import { logEvent } from "../worker/log";

const LEGACY_PROVIDER = "legacy-report";
const LEGACY_INSTRUMENT_PREFIX = "legacy-ticker:";
const LEGACY_ANALYSIS_PREFIX = "legacy-analysis:";
const LEGACY_REPAIR_PREFIX = "legacy-dual-write:";

type LegacyScreeningRow = {
  runId: string;
  generation: number;
  tradingDate: string;
  screeningId: string;
  tickerId: string;
  symbol: string;
  companyName: string;
  exchange: string;
  currency: string;
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

type LegacySourceRow = {
  screeningId: string;
  sourceOrder: number;
  title: string;
  publisher: string | null;
  publishedAt: string | null;
  sourceUrl: string;
  cited: number;
};

interface ExistingFactRow {
  id: string;
  provider_revision: string;
  current_raw_close_decimal: string;
  previous_raw_close_decimal: string | null;
  movement_amount_decimal: string | null;
  movement_percent_decimal: string | null;
  raw_close_difference_decimal: string | null;
}

interface ExistingAnalysisRow {
  id: string;
  dependency_fingerprint: string;
}

interface RepairRetryRow extends LegacyScreeningRow {
  repairState: "pending" | "failed" | null;
  attemptCount: number | null;
}

export interface LegacyDualWriteOptions {
  /** The caller must pass a strict, validated flag value. */
  enabled?: boolean;
  now?: () => Date;
  /** Test/diagnostic hook; failures are recorded and never escape publication. */
  beforeAttempt?: (screening: LegacyScreeningRow) => void | Promise<void>;
}

export interface LegacyPublishedRunHook {
  onPublishedRun(runId: string, now: string): Promise<void>;
}

const boundedMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
};

const validSourceUrl = (value: string): string | null => {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
};

const legacyNumberToDecimal = (
  value: number | null,
  positive = false,
): string | null => {
  if (value === null || !Number.isFinite(value)) return null;
  try {
    const decimal = canonicalizeDecimal(new Decimal(value).toFixed());
    if (positive && !DecimalValue.parse(decimal).isPositive()) return null;
    return decimal;
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

export class LegacyDualWriteService implements LegacyPublishedRunHook {
  private readonly facts: MarketFactRepository;
  private readonly analyses: MovementAnalysisRepository;
  private readonly buckets: FactRevisionBucketRepository;
  private readonly enabled: boolean;
  private readonly now: () => Date;

  constructor(
    private readonly db: D1Database,
    options: LegacyDualWriteOptions = {},
  ) {
    this.facts = new MarketFactRepository(db);
    this.analyses = new MovementAnalysisRepository(db);
    this.buckets = new FactRevisionBucketRepository(db);
    this.enabled = options.enabled === true;
    this.now = options.now ?? (() => new Date());
    this.beforeAttempt = options.beforeAttempt;
  }

  private readonly beforeAttempt:
    | ((screening: LegacyScreeningRow) => void | Promise<void>)
    | undefined;

  async onPublishedRun(runId: string, now: string): Promise<void> {
    if (!this.enabled) return;
    try {
      const screenings = await this.loadPublishedScreenings(runId);
      if (screenings.length === 0) return;
      const sourceRows = await this.loadSources(runId);
      const sourcesByScreening = new Map<string, LegacySourceRow[]>();
      for (const source of sourceRows) {
        const list = sourcesByScreening.get(source.screeningId) ?? [];
        list.push(source);
        sourcesByScreening.set(source.screeningId, list);
      }
      for (const screening of screenings) {
        await this.writeScreening(
          screening,
          sourcesByScreening.get(screening.screeningId) ?? [],
          now,
        );
      }
    } catch {
      // Publication already committed. Per-screening markers cover normal
      // failures; this guard protects that invariant if loading itself fails.
      logEvent("legacy_dual_write_load_failed", {
        runId,
        code: "legacy_dual_write_load_failed",
      });
    }
  }

  /**
   * Retry a bounded number of compatibility repairs for rows that are still
   * owned by the currently published generation. Skipped rows are intentionally
   * excluded: they represent source data that cannot be mapped safely (for
   * example, a missing price), while failed/pending rows are operationally
   * retryable. The attempt cap prevents a permanently malformed row from
   * consuming every scheduled invocation.
   */
  async retryPending(
    now: string,
    options: { limit?: number; maxAttempts?: number } = {},
  ): Promise<number> {
    if (!this.enabled) return 0;
    const limit = Math.max(0, Math.min(options.limit ?? 100, 500));
    const maxAttempts = Math.max(1, options.maxAttempts ?? 5);
    if (limit === 0) return 0;
    const rows = await this.db
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
                a.model AS analysisModel, a.status AS analysisStatus,
                repair.state AS repairState,
                repair.attempt_count AS attemptCount
           FROM report_runs r
           JOIN screenings s ON s.report_run_id = r.id
           LEFT JOIN legacy_dual_write_repairs repair
             ON repair.legacy_screening_id = s.id
           LEFT JOIN analyses a ON a.screening_id = s.id
          WHERE r.published = 1
            AND (repair.id IS NULL OR (
              repair.state IN ('pending', 'failed')
              AND repair.attempt_count < ?1
              AND r.generation = repair.legacy_generation
            ))
          ORDER BY repair.last_attempted_at, repair.id, s.id
          LIMIT ?2`,
      )
      .bind(maxAttempts, limit)
      .all<RepairRetryRow>();
    if (rows.results.length === 0) return 0;

    const sourcesByRun = new Map<string, LegacySourceRow[]>();
    for (const runId of new Set(rows.results.map((row) => row.runId))) {
      for (const source of await this.loadSources(runId)) {
        const list = sourcesByRun.get(runId) ?? [];
        list.push(source);
        sourcesByRun.set(runId, list);
      }
    }
    let attempted = 0;
    for (const screening of rows.results) {
      const claimed = await this.writeScreening(
        screening,
        (sourcesByRun.get(screening.runId) ?? []).filter(
          (source) => source.screeningId === screening.screeningId,
        ),
        now,
        maxAttempts,
      );
      if (claimed) attempted += 1;
    }
    return attempted;
  }

  private async loadPublishedScreenings(
    runId: string,
  ): Promise<LegacyScreeningRow[]> {
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
          WHERE r.id = ?1 AND r.published = 1
          ORDER BY s.symbol, s.id`,
      )
      .bind(runId)
      .all<LegacyScreeningRow>();
    return result.results;
  }

  private async loadSources(runId: string): Promise<LegacySourceRow[]> {
    const result = await this.db
      .prepare(
        `SELECT s.id AS screeningId, src.source_index AS sourceOrder,
                src.title, src.publisher, src.published_at AS publishedAt,
                src.url AS sourceUrl, src.cited
           FROM screenings s
           JOIN sources src ON src.screening_id = s.id
          WHERE s.report_run_id = ?1
          ORDER BY s.id, src.source_index`,
      )
      .bind(runId)
      .all<LegacySourceRow>();
    return result.results;
  }

  private async ensureInstrument(
    screening: LegacyScreeningRow,
    now: string,
  ): Promise<string> {
    const existing = await this.db
      .prepare("SELECT id FROM instruments WHERE symbol = ?1")
      .bind(screening.symbol)
      .first<{ id: string }>();
    if (existing) return existing.id;

    const candidateId = `${LEGACY_INSTRUMENT_PREFIX}${screening.tickerId}`;
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO instruments
           (id, symbol, company_name, exchange, currency, instrument_type,
            provider, provider_symbol, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'stock', ?6, ?2, ?7, ?7)`,
      )
      .bind(
        candidateId,
        screening.symbol,
        screening.companyName,
        screening.exchange,
        screening.currency,
        LEGACY_PROVIDER,
        now,
      )
      .run();
    const resolved = await this.db
      .prepare("SELECT id FROM instruments WHERE symbol = ?1")
      .bind(screening.symbol)
      .first<{ id: string }>();
    if (!resolved) throw new Error("legacy_instrument_unresolved");
    return resolved.id;
  }

  private async startAttempt(
    screening: LegacyScreeningRow,
    now: string,
    maxAttempts?: number,
  ): Promise<{ claimed: boolean; needsBucketRepair: boolean }> {
    let existing = await this.db
      .prepare(
        `SELECT state, attempt_count AS attemptCount
           FROM legacy_dual_write_repairs
          WHERE legacy_screening_id = ?1`,
      )
      .bind(screening.screeningId)
      .first<{ state: string; attemptCount: number }>();
    if (!existing) {
      const inserted = await this.db
        .prepare(
          `INSERT OR IGNORE INTO legacy_dual_write_repairs
             (id, legacy_run_id, legacy_screening_id, legacy_generation,
              trading_date, ticker_id, state, attempt_count,
              first_attempted_at, last_attempted_at, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', 1, ?7, ?7, ?7, ?7)`,
        )
        .bind(
          `${LEGACY_REPAIR_PREFIX}${screening.screeningId}`,
          screening.runId,
          screening.screeningId,
          screening.generation,
          screening.tradingDate,
          screening.tickerId,
          now,
        )
        .run();
      if (inserted.meta.changes === 1) {
        return { claimed: true, needsBucketRepair: false };
      }
      existing = await this.db
        .prepare(
          `SELECT state, attempt_count AS attemptCount
             FROM legacy_dual_write_repairs
            WHERE legacy_screening_id = ?1`,
        )
        .bind(screening.screeningId)
        .first<{ state: string; attemptCount: number }>();
    }
    if (!existing) return { claimed: false, needsBucketRepair: false };
    const retryableState =
      existing.state === "pending" || existing.state === "failed";
    const canClaim =
      retryableState &&
      (maxAttempts === undefined || existing.attemptCount < maxAttempts);
    if (!canClaim) return { claimed: false, needsBucketRepair: false };
    const result = await this.db
      .prepare(
        `UPDATE legacy_dual_write_repairs
            SET legacy_run_id = ?1, legacy_generation = ?2,
                trading_date = ?3, ticker_id = ?4, instrument_id = NULL,
                state = 'pending', failure_code = NULL, failure_message = NULL,
                attempt_count = attempt_count + 1,
                last_attempted_at = ?5, resolved_at = NULL, updated_at = ?5
          WHERE legacy_screening_id = ?6
            AND (?7 IS NULL OR state IN ('pending', 'failed'))
            AND (?7 IS NULL OR attempt_count < ?7)`,
      )
      .bind(
        screening.runId,
        screening.generation,
        screening.tradingDate,
        screening.tickerId,
        now,
        screening.screeningId,
        maxAttempts ?? null,
      )
      .run();
    return {
      claimed: result.meta.changes === 1,
      needsBucketRepair:
        result.meta.changes === 1 &&
        (existing.state === "pending" || existing.state === "failed"),
    };
  }

  private async markResolved(
    screeningId: string,
    instrumentId: string,
    now: string,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE legacy_dual_write_repairs
            SET state = 'resolved', instrument_id = ?1,
                failure_code = NULL, failure_message = NULL,
                resolved_at = ?2, updated_at = ?2
          WHERE legacy_screening_id = ?3`,
      )
      .bind(instrumentId, now, screeningId)
      .run();
  }

  private async markFailure(input: {
    screening: LegacyScreeningRow;
    state: "failed" | "skipped";
    code: string;
    message: string;
    instrumentId?: string;
    now: string;
  }): Promise<void> {
    await this.db
      .prepare(
        `UPDATE legacy_dual_write_repairs
            SET state = ?1, instrument_id = ?2,
                failure_code = ?3, failure_message = substr(?4, 1, 500),
                resolved_at = NULL, updated_at = ?5
          WHERE legacy_screening_id = ?6`,
      )
      .bind(
        input.state,
        input.instrumentId ?? null,
        input.code,
        input.message,
        input.now,
        input.screening.screeningId,
      )
      .run();
  }

  private async writeScreening(
    screening: LegacyScreeningRow,
    legacySources: readonly LegacySourceRow[],
    now: string,
    maxAttempts?: number,
  ): Promise<boolean> {
    try {
      const attempt = await this.startAttempt(screening, now, maxAttempts);
      if (!attempt.claimed) return false;
      const needsBucketRepair = attempt.needsBucketRepair;
      await this.beforeAttempt?.(screening);
      const currentWinner = await this.db
        .prepare(
          `SELECT generation FROM report_runs
             WHERE id = ?1 AND trading_date = ?2 AND published = 1`,
        )
        .bind(screening.runId, screening.tradingDate)
        .first<{ generation: number }>();
      if (currentWinner?.generation !== screening.generation) {
        await this.markFailure({
          screening,
          state: "skipped",
          code: "legacy_stale_generation",
          message:
            "Published generation was superseded before compatibility write.",
          now,
        });
        return true;
      }
      const instrumentId = await this.ensureInstrument(screening, now);
      const current = legacyNumberToDecimal(screening.currentPrice, true);
      if (!current) {
        await this.markFailure({
          screening,
          state: "skipped",
          code: "legacy_missing_price",
          message: "Published legacy screening has no valid current price.",
          instrumentId,
          now,
        });
        return true;
      }

      const previous = legacyNumberToDecimal(screening.previousPrice, true);
      const hasMovement =
        screening.previousDate !== null &&
        screening.previousDate < screening.tradingDate &&
        previous !== null &&
        legacyNumberToDecimal(screening.changeAmount) !== null &&
        legacyNumberToDecimal(screening.changePct) !== null;
      const previousDate = hasMovement ? screening.previousDate : null;
      const previousRawCloseDecimal = hasMovement ? previous : null;
      const movementAmountDecimal = hasMovement
        ? legacyNumberToDecimal(screening.changeAmount)
        : null;
      const movementPercentDecimal = hasMovement
        ? legacyNumberToDecimal(screening.changePct)
        : null;
      const existingFact = await this.db
        .prepare(
          `SELECT id, provider_revision, current_raw_close_decimal,
                  previous_raw_close_decimal, movement_amount_decimal,
                  movement_percent_decimal, raw_close_difference_decimal
             FROM daily_market_facts
            WHERE instrument_id = ?1 AND trading_date = ?2`,
        )
        .bind(instrumentId, screening.tradingDate)
        .first<ExistingFactRow>();
      const factId =
        existingFact?.id ?? `${instrumentId}:${screening.tradingDate}`;
      const providerRevision = `${LEGACY_PROVIDER}:${screening.runId}:${screening.generation}:${screening.screeningId}`;
      const fact = {
        id: factId,
        instrumentId,
        tradingDate: screening.tradingDate,
        previousTradingDate: previousDate,
        previousRawCloseDecimal,
        currentRawCloseDecimal: current,
        crossingSplitNumerator: "1",
        crossingSplitDenominator: "1",
        splitAdjustedPreviousCloseDecimal: previousRawCloseDecimal,
        movementAmountDecimal,
        movementPercentDecimal,
        rawCloseDifferenceDecimal:
          screening.priceBasis === "close" ? movementAmountDecimal : null,
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
      const existingAnalysis = await this.db
        .prepare(
          `SELECT id, dependency_fingerprint
             FROM movement_analyses WHERE daily_market_fact_id = ?1`,
        )
        .bind(factId)
        .first<ExistingAnalysisRow>();
      const analysisId =
        existingAnalysis?.id ?? `${LEGACY_ANALYSIS_PREFIX}${factId}`;
      const validSources = legacySources
        .map((source) => {
          const sourceUrl = validSourceUrl(source.sourceUrl);
          if (!sourceUrl) return null;
          const normalized: NewsSourceRecord = {
            id: `${analysisId}:source:${source.sourceOrder}`,
            movementAnalysisId: analysisId,
            sourceOrder: source.sourceOrder,
            title: source.title,
            publisher: source.publisher,
            publishedAt: source.publishedAt,
            sourceUrl,
            cited: source.cited === 1,
            createdAt: now,
          };
          return normalized;
        })
        .filter((source): source is NewsSourceRecord => source !== null);
      const analysis = {
        ...this.analysisRecord(screening, factId, now, validSources),
        id: analysisId,
      };
      const dependencyFingerprint = await digest(
        JSON.stringify({
          providerRevision,
          status: analysis.status,
          summary: analysis.summaryZhCn,
          model: analysis.model,
          sources: validSources.map((source) => [
            source.sourceOrder,
            source.title,
            source.publisher,
            source.publishedAt,
            source.cited,
            source.sourceUrl,
          ]),
        }),
      );
      const analysisWithFingerprint: MovementAnalysisRecord = {
        ...analysis,
        dependencyFingerprint,
      };
      const factChanged =
        !existingFact ||
        existingFact.provider_revision !== providerRevision ||
        existingFact.current_raw_close_decimal !== current ||
        existingFact.previous_raw_close_decimal !== previousRawCloseDecimal ||
        existingFact.movement_amount_decimal !== movementAmountDecimal ||
        existingFact.movement_percent_decimal !== movementPercentDecimal ||
        existingFact.raw_close_difference_decimal !==
          fact.rawCloseDifferenceDecimal;
      const analysisChanged =
        !existingAnalysis ||
        existingAnalysis.dependency_fingerprint !== dependencyFingerprint;
      const publicationGuard = {
        tradingDate: screening.tradingDate,
        generation: screening.generation,
      };
      if (factChanged || analysisChanged || needsBucketRepair) {
        const statements: D1PreparedStatement[] = [];
        if (factChanged) {
          statements.push(this.facts.upsertStatement(fact, publicationGuard));
        }
        if (analysisChanged || needsBucketRepair) {
          statements.push(
            this.analyses.upsertStatement(
              analysisWithFingerprint,
              publicationGuard,
            ),
          );
          statements.push(
            ...this.analyses.replaceSourcesStatements(
              {
                movementAnalysisId: analysisWithFingerprint.id,
                sources: validSources,
              },
              publicationGuard,
              factId,
            ),
          );
        }
        statements.push(
          this.buckets.bumpStatement(
            await bucketForDate(this.db, screening.tradingDate),
            now,
            publicationGuard,
          ),
        );
        await this.db.batch(statements);
        const winnerAfterWrite = await this.db
          .prepare(
            `SELECT generation FROM report_runs
               WHERE id = ?1 AND trading_date = ?2 AND published = 1`,
          )
          .bind(screening.runId, screening.tradingDate)
          .first<{ generation: number }>();
        if (winnerAfterWrite?.generation !== screening.generation) {
          await this.markFailure({
            screening,
            state: "skipped",
            code: "legacy_stale_generation",
            message:
              "Published generation was superseded before compatibility write.",
            instrumentId,
            now,
          });
          return true;
        }
        const resolvedFact = await this.db
          .prepare(
            `SELECT id FROM daily_market_facts
               WHERE instrument_id = ?1 AND trading_date = ?2`,
          )
          .bind(instrumentId, screening.tradingDate)
          .first<{ id: string }>();
        if (!resolvedFact) throw new Error("legacy_fact_unresolved");
        if (analysisChanged) {
          const resolvedAnalysis = await this.db
            .prepare(
              `SELECT id FROM movement_analyses
                 WHERE daily_market_fact_id = ?1`,
            )
            .bind(resolvedFact.id)
            .first<{ id: string }>();
          if (!resolvedAnalysis) throw new Error("legacy_analysis_unresolved");
        }
      }
      await this.markResolved(screening.screeningId, instrumentId, now);
      return true;
    } catch (error) {
      await this.markFailure({
        screening,
        state: "failed",
        code: "legacy_dual_write_failed",
        message: boundedMessage(error),
        now,
      });
      return true;
    }
  }

  private analysisRecord(
    screening: LegacyScreeningRow,
    factId: string,
    now: string,
    _sources: readonly NewsSourceRecord[],
  ): Omit<MovementAnalysisRecord, "dependencyFingerprint"> & {
    dependencyFingerprint?: string;
  } {
    const analysisId = `${LEGACY_ANALYSIS_PREFIX}${factId}`;
    if (screening.analysisStatus === "complete" && screening.analysisSummary) {
      return {
        id: analysisId,
        dailyMarketFactId: factId,
        summaryZhCn: screening.analysisSummary,
        model: screening.analysisModel,
        status: "complete",
        errorCode: null,
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
      };
    }
    if (
      screening.screeningStatus === "failed" ||
      screening.analysisStatus === "unavailable"
    ) {
      return {
        id: analysisId,
        dailyMarketFactId: factId,
        summaryZhCn: null,
        model: screening.analysisModel,
        status: "error",
        errorCode:
          screening.screeningErrorCode ?? "legacy_analysis_unavailable",
        errorMessage:
          screening.screeningErrorMessage ?? "Legacy analysis is unavailable.",
        createdAt: now,
        updatedAt: now,
      };
    }
    return {
      id: analysisId,
      dailyMarketFactId: factId,
      summaryZhCn: null,
      model: screening.analysisModel,
      status: "pending",
      errorCode: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    };
  }
}
