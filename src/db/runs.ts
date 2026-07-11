import type { ExplanationResult } from "../providers/explanations";
import type { NewsItem } from "../providers/news";
import type { LegacyPublishedRunHook } from "../services/legacy-dual-write";
import type {
  MoverDto,
  ReportDto,
  ReportSummaryDto,
  ScreeningJobMessage,
  SourceDto,
} from "../shared/contracts";
import type { TickerRecord } from "./tickers";

export interface ScreeningWork {
  id: string;
  reportRunId: string;
  symbol: string;
  companyName: string;
  exchange: string;
  currency: string;
  targetDate: string;
  attemptCount: number;
  previousDate: string | null;
  previousPrice: number | null;
  currentPrice: number | null;
  changeAmount: number | null;
  changePct: number | null;
  priceBasis: "adjusted" | "close" | null;
  qualified: boolean | null;
}

export interface CreateRunInput {
  tradingDate: string;
  origin: "scheduled" | "backfill";
  backfillJobId: string | null;
  tickers: TickerRecord[];
  now: string;
}

interface ExistingRun {
  runId: string;
  generation: number;
}

export class RunRepository {
  constructor(
    private readonly db: D1Database,
    private readonly afterPublished?: LegacyPublishedRunHook,
  ) {}

  private async existingScheduledRun(
    tradingDate: string,
  ): Promise<(ExistingRun & { screeningIds: string[] }) | null> {
    const run = await this.db
      .prepare(
        `SELECT id AS runId, generation FROM report_runs
         WHERE trading_date = ?1 AND origin = 'scheduled' LIMIT 1`,
      )
      .bind(tradingDate)
      .first<ExistingRun>();
    if (!run) return null;
    const screenings = await this.db
      .prepare(
        "SELECT id FROM screenings WHERE report_run_id = ?1 ORDER BY symbol, id",
      )
      .bind(run.runId)
      .all<{ id: string }>();
    return { ...run, screeningIds: screenings.results.map(({ id }) => id) };
  }

  async createRun(
    input: CreateRunInput,
  ): Promise<{ runId: string; generation: number; screeningIds: string[] }> {
    if (input.origin === "scheduled") {
      const existing = await this.existingScheduledRun(input.tradingDate);
      if (existing) return existing;
    }
    const generationRow = await this.db
      .prepare(
        `SELECT COALESCE(MAX(generation), 0) + 1 AS generation
         FROM report_runs WHERE trading_date = ?1`,
      )
      .bind(input.tradingDate)
      .first<{ generation: number }>();
    const generation = generationRow?.generation ?? 1;
    const runId = crypto.randomUUID();
    const screeningIds = input.tickers.map(() => crypto.randomUUID());
    const statements = [
      this.db
        .prepare(
          `INSERT INTO report_runs
           (id, trading_date, generation, origin, backfill_job_id, published,
            status, tickers_total, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, 0, 'pending', ?6, ?7)`,
        )
        .bind(
          runId,
          input.tradingDate,
          generation,
          input.origin,
          input.backfillJobId,
          input.tickers.length,
          input.now,
        ),
      ...input.tickers.map((ticker, index) =>
        this.db
          .prepare(
            `INSERT INTO screenings
             (id, report_run_id, ticker_id, symbol, company_name, exchange,
              currency, target_date, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending')`,
          )
          .bind(
            screeningIds[index],
            runId,
            ticker.id,
            ticker.symbol,
            ticker.companyName,
            ticker.exchange,
            ticker.currency,
            input.tradingDate,
          ),
      ),
    ];
    try {
      await this.db.batch(statements);
    } catch (error) {
      if (input.origin === "scheduled") {
        const existing = await this.existingScheduledRun(input.tradingDate);
        if (existing) return existing;
      }
      throw error;
    }
    return { runId, generation, screeningIds };
  }

  async claimScreening(id: string, now: string): Promise<ScreeningWork | null> {
    const result = await this.db
      .prepare(
        `UPDATE screenings
         SET status = 'processing', processing_started_at = ?1,
             attempt_count = attempt_count + 1
         WHERE id = ?2 AND status IN ('pending', 'queued')`,
      )
      .bind(now, id)
      .run();
    if (result.meta.changes !== 1) return null;
    const row = await this.db
      .prepare(
        `SELECT id, report_run_id AS reportRunId, symbol,
         company_name AS companyName, exchange, currency,
         target_date AS targetDate, attempt_count AS attemptCount,
         previous_bar_date AS previousDate, previous_price AS previousPrice,
         current_price AS currentPrice, change_amount AS changeAmount,
         change_pct AS changePct, price_basis AS priceBasis, qualified
         FROM screenings WHERE id = ?1`,
      )
      .bind(id)
      .first<Omit<ScreeningWork, "qualified"> & { qualified: number | null }>();
    return row
      ? {
          ...row,
          qualified: row.qualified === null ? null : row.qualified === 1,
        }
      : null;
  }

  async savePrice(
    id: string,
    input: {
      previousDate: string;
      previousPrice: number;
      currentPrice: number;
      changeAmount: number;
      changePct: number;
      priceBasis: "adjusted" | "close";
      qualified: boolean;
    },
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE screenings SET previous_bar_date = ?1, previous_price = ?2,
         current_price = ?3, change_amount = ?4, change_pct = ?5,
         price_basis = ?6, qualified = ?7 WHERE id = ?8`,
      )
      .bind(
        input.previousDate,
        input.previousPrice,
        input.currentPrice,
        input.changeAmount,
        input.changePct,
        input.priceBasis,
        input.qualified ? 1 : 0,
        id,
      )
      .run();
  }

  async saveSources(screeningId: string, sources: NewsItem[]): Promise<void> {
    await this.db.batch([
      this.db
        .prepare("DELETE FROM sources WHERE screening_id = ?1")
        .bind(screeningId),
      ...sources.slice(0, 10).map((source, index) =>
        this.db
          .prepare(
            `INSERT OR REPLACE INTO sources
             (id, screening_id, source_index, title, publisher, published_at, url, cited)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)`,
          )
          .bind(
            crypto.randomUUID(),
            screeningId,
            index,
            source.title,
            source.publisher,
            source.publishedAt,
            source.url,
          ),
      ),
    ]);
  }

  async saveAnalysis(
    screeningId: string,
    result: ExplanationResult,
    now: string,
  ): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `INSERT OR REPLACE INTO analyses
           (id, screening_id, explanation_zh_cn, confidence, clear_catalyst,
            model, status, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'complete', ?7)`,
        )
        .bind(
          crypto.randomUUID(),
          screeningId,
          result.explanationZhCn,
          null,
          null,
          result.model,
          now,
        ),
      this.db
        .prepare("UPDATE sources SET cited = 1 WHERE screening_id = ?1")
        .bind(screeningId),
      this.db
        .prepare(
          `UPDATE screenings SET status = 'complete', error_code = NULL,
           error_message = NULL WHERE id = ?1`,
        )
        .bind(screeningId),
    ]);
  }

  async saveScreeningResult(
    screeningId: string,
    sources: NewsItem[],
    result: ExplanationResult,
    now: string,
  ): Promise<void> {
    await this.db.batch([
      this.db
        .prepare("DELETE FROM sources WHERE screening_id = ?1")
        .bind(screeningId),
      ...sources.slice(0, 10).map((source, index) =>
        this.db
          .prepare(
            `INSERT OR REPLACE INTO sources
             (id, screening_id, source_index, title, publisher, published_at, url, cited)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
          )
          .bind(
            crypto.randomUUID(),
            screeningId,
            index,
            source.title,
            source.publisher,
            source.publishedAt,
            source.url,
            1,
          ),
      ),
      this.db
        .prepare(
          `INSERT OR REPLACE INTO analyses
           (id, screening_id, explanation_zh_cn, confidence, clear_catalyst,
            model, status, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'complete', ?7)`,
        )
        .bind(
          crypto.randomUUID(),
          screeningId,
          result.explanationZhCn,
          null,
          null,
          result.model,
          now,
        ),
      this.db
        .prepare(
          `UPDATE screenings SET status = 'complete', error_code = NULL,
           error_message = NULL WHERE id = ?1`,
        )
        .bind(screeningId),
    ]);
  }

  async completeWithoutAnalysis(id: string): Promise<void> {
    await this.db
      .prepare("UPDATE screenings SET status = 'complete' WHERE id = ?1")
      .bind(id)
      .run();
  }

  async markNoTradingData(id: string, code: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE screenings SET status = 'no_trading_data', error_code = ?1,
         error_message = NULL WHERE id = ?2`,
      )
      .bind(code, id)
      .run();
  }

  async markFailed(id: string, code: string, message: string): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE screenings SET status = 'failed', error_code = ?1,
           error_message = substr(?2, 1, 500) WHERE id = ?3`,
        )
        .bind(code, message, id),
      this.db
        .prepare(
          `INSERT OR REPLACE INTO analyses
           (id, screening_id, explanation_zh_cn, confidence, clear_catalyst,
            model, status, created_at)
           SELECT ?1, id, NULL, NULL, NULL, NULL, 'unavailable', ?2
           FROM screenings WHERE id = ?3 AND qualified = 1`,
        )
        .bind(crypto.randomUUID(), new Date().toISOString(), id),
    ]);
  }

  async runIdForScreening(id: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT report_run_id AS runId FROM screenings WHERE id = ?1")
      .bind(id)
      .first<{ runId: string }>();
    return row?.runId ?? null;
  }

  async publishGeneration(runId: string, now: string): Promise<boolean> {
    const run = await this.db
      .prepare(
        `SELECT trading_date AS tradingDate, generation FROM report_runs
         WHERE id = ?1 AND status IN ('complete', 'complete_with_errors')`,
      )
      .bind(runId)
      .first<{ tradingDate: string; generation: number }>();
    if (!run) throw new Error("run_not_publishable");
    // The unpublish and conditional winner update are one D1 transaction.
    // Both statements re-check the generation, so concurrent finalizers
    // cannot let an older generation win after a newer one commits.
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE report_runs SET published = 0
             WHERE trading_date = ?1 AND published = 1
               AND generation < ?2`,
        )
        .bind(run.tradingDate, run.generation),
      this.db
        .prepare(
          `UPDATE report_runs SET published = 1,
           completed_at = COALESCE(completed_at, ?1)
           WHERE id = ?2
             AND status IN ('complete', 'complete_with_errors')
             AND NOT EXISTS (
               SELECT 1 FROM report_runs newer
                WHERE newer.trading_date = ?3
                  AND newer.published = 1
                  AND newer.generation > ?4
             )`,
        )
        .bind(now, runId, run.tradingDate, run.generation),
    ]);
    return (results[1]?.meta.changes ?? 0) === 1;
  }

  async reconcileStaleLeases(cutoff: string): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE screenings SET status = 'pending', queued_at = NULL,
         processing_started_at = NULL
         WHERE (status = 'queued' AND queued_at < ?1)
            OR (status = 'processing' AND processing_started_at < ?1)`,
      )
      .bind(cutoff)
      .run();
    return result.meta.changes;
  }

  async countDispatchedSince(dayStart: string): Promise<number> {
    const row = await this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM dispatch_events WHERE dispatched_at >= ?1",
      )
      .bind(dayStart)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }

  async dispatchPending(
    queue: Queue<ScreeningJobMessage>,
    limit: number,
    now: string,
  ): Promise<number> {
    if (limit <= 0) return 0;
    const rows = await this.db
      .prepare(
        `SELECT id, report_run_id AS reportRunId, ticker_id AS tickerId
         FROM screenings WHERE status = 'pending'
         ORDER BY target_date, id LIMIT ?1`,
      )
      .bind(limit)
      .all<{ id: string; reportRunId: string; tickerId: string }>();
    if (rows.results.length === 0) return 0;
    for (let offset = 0; offset < rows.results.length; offset += 100) {
      const chunk = rows.results.slice(offset, offset + 100);
      const ids = JSON.stringify(chunk.map((row) => row.id));
      const events = JSON.stringify(
        chunk.map((row) => ({
          id: crypto.randomUUID(),
          screeningId: row.id,
          dispatchedAt: now,
        })),
      );
      await this.db.batch([
        this.db
          .prepare(
            `UPDATE screenings SET status = 'queued', queued_at = ?1
             WHERE id IN (SELECT value FROM json_each(?2))
               AND status = 'pending'`,
          )
          .bind(now, ids),
        this.db
          .prepare(
            `INSERT INTO dispatch_events (id, screening_id, dispatched_at)
             SELECT json_extract(value, '$.id'),
                    json_extract(value, '$.screeningId'),
                    json_extract(value, '$.dispatchedAt')
             FROM json_each(?1)`,
          )
          .bind(events),
      ]);
      await queue.sendBatch(
        chunk.map((row) => ({
          body: {
            screeningId: row.id,
            reportRunId: row.reportRunId,
            tickerId: row.tickerId,
          },
        })),
      );
    }
    return rows.results.length;
  }

  async finalizeRun(
    runId: string,
    now: string,
  ): Promise<
    "running" | "complete" | "complete_with_errors" | "no_market_data"
  > {
    const counts = await this.db
      .prepare(
        `SELECT COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN status IN
           ('complete','no_trading_data','failed') THEN 1 ELSE 0 END), 0) AS processed,
         COALESCE(SUM(CASE WHEN qualified = 1 THEN 1 ELSE 0 END), 0) AS qualified,
         COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
         COALESCE(SUM(CASE WHEN current_price IS NOT NULL THEN 1 ELSE 0 END), 0) AS withMarketData
         FROM screenings WHERE report_run_id = ?1`,
      )
      .bind(runId)
      .first<{
        total: number;
        processed: number;
        qualified: number;
        failed: number;
        withMarketData: number;
      }>();
    if (!counts) return "running";
    if (counts.processed < counts.total) {
      await this.db
        .prepare(
          `UPDATE report_runs SET status = 'running', tickers_processed = ?1,
           tickers_qualified = ?2, tickers_failed = ?3,
           started_at = COALESCE(started_at, ?4) WHERE id = ?5`,
        )
        .bind(counts.processed, counts.qualified, counts.failed, now, runId)
        .run();
      return "running";
    }
    const status =
      counts.withMarketData === 0
        ? "no_market_data"
        : counts.failed > 0
          ? "complete_with_errors"
          : "complete";
    await this.db
      .prepare(
        `UPDATE report_runs SET status = ?1, tickers_processed = ?2,
         tickers_qualified = ?3, tickers_failed = ?4, completed_at = ?5
         WHERE id = ?6`,
      )
      .bind(
        status,
        counts.processed,
        counts.qualified,
        counts.failed,
        now,
        runId,
      )
      .run();
    if (status === "complete" || status === "complete_with_errors") {
      const published = await this.publishGeneration(runId, now);
      if (published && this.afterPublished) {
        try {
          await this.afterPublished.onPublishedRun(runId, now);
        } catch {
          // Compatibility failures are recorded by the hook and must never
          // turn an already-published legacy run into a failed run.
        }
      }
    }
    await this.refreshBackfillForRun(runId, now);
    return status;
  }

  private async refreshBackfillForRun(
    runId: string,
    now: string,
  ): Promise<void> {
    const parent = await this.db
      .prepare(
        "SELECT backfill_job_id AS backfillId FROM report_runs WHERE id = ?1",
      )
      .bind(runId)
      .first<{ backfillId: string | null }>();
    if (!parent?.backfillId) return;
    const totals = await this.db
      .prepare(
        `SELECT COUNT(*) AS datesTotal,
         COALESCE(SUM(CASE WHEN status IN
           ('complete','complete_with_errors','no_market_data') THEN 1 ELSE 0 END), 0) AS datesProcessed,
         COALESCE(SUM(tickers_total), 0) AS tickerJobsTotal,
         COALESCE(SUM(tickers_processed), 0) AS tickerJobsProcessed,
         COALESCE(SUM(tickers_failed), 0) AS tickerJobsFailed
         FROM report_runs WHERE backfill_job_id = ?1`,
      )
      .bind(parent.backfillId)
      .first<{
        datesTotal: number;
        datesProcessed: number;
        tickerJobsTotal: number;
        tickerJobsProcessed: number;
        tickerJobsFailed: number;
      }>();
    if (!totals) return;
    const status =
      totals.datesProcessed === totals.datesTotal
        ? totals.tickerJobsFailed > 0
          ? "complete_with_errors"
          : "complete"
        : "running";
    await this.db
      .prepare(
        `UPDATE backfill_jobs SET status = ?1, dates_total = ?2,
         dates_processed = ?3, ticker_jobs_total = ?4,
         ticker_jobs_processed = ?5, ticker_jobs_failed = ?6,
         completed_at = CASE WHEN ?1 IN ('complete','complete_with_errors')
           THEN ?7 ELSE NULL END WHERE id = ?8`,
      )
      .bind(
        status,
        totals.datesTotal,
        totals.datesProcessed,
        totals.tickerJobsTotal,
        totals.tickerJobsProcessed,
        totals.tickerJobsFailed,
        now,
        parent.backfillId,
      )
      .run();
  }

  async createBackfill(input: {
    startDate: string;
    endDate: string;
    reprocessExisting: boolean;
    now: string;
    datesTotal: number;
  }): Promise<string> {
    const id = crypto.randomUUID();
    const status = input.datesTotal === 0 ? "complete" : "running";
    await this.db
      .prepare(
        `INSERT INTO backfill_jobs
         (id, start_date, end_date, reprocess_existing, status, dates_total,
          created_at, started_at, completed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8)`,
      )
      .bind(
        id,
        input.startDate,
        input.endDate,
        input.reprocessExisting ? 1 : 0,
        status,
        input.datesTotal,
        input.now,
        input.datesTotal === 0 ? input.now : null,
      )
      .run();
    return id;
  }

  async hasPublishedDate(date: string): Promise<boolean> {
    return Boolean(
      await this.db
        .prepare(
          "SELECT 1 FROM report_runs WHERE trading_date = ?1 AND published = 1",
        )
        .bind(date)
        .first(),
    );
  }

  async findScheduledRun(date: string): Promise<string | null> {
    const row = await this.db
      .prepare(
        `SELECT id FROM report_runs WHERE trading_date = ?1
         AND origin = 'scheduled' LIMIT 1`,
      )
      .bind(date)
      .first<{ id: string }>();
    return row?.id ?? null;
  }

  async getBackfill(id: string): Promise<Record<string, unknown> | null> {
    const job = await this.db
      .prepare("SELECT * FROM backfill_jobs WHERE id = ?1")
      .bind(id)
      .first<Record<string, unknown>>();
    if (!job) return null;
    const runs = await this.db
      .prepare(
        `SELECT trading_date AS tradingDate, status,
         tickers_failed AS tickersFailed FROM report_runs
         WHERE backfill_job_id = ?1 ORDER BY trading_date`,
      )
      .bind(id)
      .all<{
        tradingDate: string;
        status: string;
        tickersFailed: number;
      }>();
    const errors = await this.db
      .prepare(
        `SELECT s.id AS screeningId, s.symbol,
         r.trading_date AS tradingDate, s.error_code AS errorCode,
         s.error_message AS errorMessage,
         CASE WHEN s.qualified = 1 THEN 1 ELSE 0 END AS retryable
         FROM screenings s JOIN report_runs r ON r.id = s.report_run_id
         WHERE r.backfill_job_id = ?1 AND s.status = 'failed'
         ORDER BY r.trading_date, s.symbol`,
      )
      .bind(id)
      .all<{
        screeningId: string;
        symbol: string;
        tradingDate: string;
        errorCode: string | null;
        errorMessage: string | null;
        retryable: number;
      }>();
    return {
      ...job,
      runs: runs.results,
      errors: errors.results.map((error) => ({
        ...error,
        retryable: error.retryable === 1,
      })),
    };
  }

  async listBackfills(
    input: {
      limit?: number;
      cursor?: { createdAt?: string; id: string } | string | null;
    } = {},
  ): Promise<{
    jobs: Record<string, unknown>[];
    nextCursor: { createdAt: string; id: string } | null;
  }> {
    type BackfillListRow = {
      id: string;
      start_date: string;
      end_date: string;
      reprocess_existing: number;
      status: string;
      dates_total: number;
      dates_processed: number;
      ticker_jobs_total: number;
      ticker_jobs_processed: number;
      ticker_jobs_failed: number;
      created_at: string;
      started_at: string | null;
      completed_at: string | null;
      runs_total: number;
      errors_total: number;
    };
    const limit = Math.min(Math.max(input.limit ?? 25, 1), 50);
    const cursor =
      typeof input.cursor === "string"
        ? { id: input.cursor, createdAt: null }
        : (input.cursor ?? null);
    const select = `SELECT b.id, b.start_date, b.end_date,
       b.reprocess_existing, b.status, b.dates_total, b.dates_processed,
       b.ticker_jobs_total, b.ticker_jobs_processed, b.ticker_jobs_failed,
       b.created_at, b.started_at, b.completed_at,
       (SELECT COUNT(*) FROM report_runs r
        WHERE r.backfill_job_id = b.id) AS runs_total,
       (SELECT COUNT(*) FROM screenings s
        JOIN report_runs r ON r.id = s.report_run_id
        WHERE r.backfill_job_id = b.id AND s.status = 'failed') AS errors_total
       FROM backfill_jobs b`;
    const rows = cursor?.createdAt
      ? await this.db
          .prepare(
            `${select}
             WHERE b.created_at < ?1
                OR (b.created_at = ?1 AND b.id < ?2)
             ORDER BY b.created_at DESC, b.id DESC
             LIMIT ?3`,
          )
          .bind(cursor.createdAt, cursor.id, limit + 1)
          .all<BackfillListRow>()
      : cursor
        ? await this.db
            .prepare(
              `${select}
               WHERE b.id < ?1
               ORDER BY b.id DESC
               LIMIT ?2`,
            )
            .bind(cursor.id, limit + 1)
            .all<BackfillListRow>()
        : await this.db
            .prepare(
              `${select}
               ORDER BY b.created_at DESC, b.id DESC
               LIMIT ?1`,
            )
            .bind(limit + 1)
            .all<BackfillListRow>();
    const page = rows.results.slice(0, limit);
    // List views only need progress and aggregate counts. Keep row-level run
    // and error hydration on getBackfill(), which powers detail and retry
    // routes, so a page of 50 jobs remains one bounded query instead of 151.
    const jobs: Record<string, unknown>[] = page.map((row) => ({
      id: row.id,
      start_date: row.start_date,
      end_date: row.end_date,
      reprocess_existing: row.reprocess_existing === 1,
      status: row.status,
      dates_total: row.dates_total,
      dates_processed: row.dates_processed,
      ticker_jobs_total: row.ticker_jobs_total,
      ticker_jobs_processed: row.ticker_jobs_processed,
      ticker_jobs_failed: row.ticker_jobs_failed,
      created_at: row.created_at,
      started_at: row.started_at,
      completed_at: row.completed_at,
      runs: [],
      errors: [],
      runs_total: Number(row.runs_total ?? 0),
      errors_total: Number(row.errors_total ?? 0),
      details_truncated: true,
    }));
    const lastRow = page.at(-1);
    return {
      jobs,
      nextCursor:
        rows.results.length > limit && lastRow
          ? { id: lastRow.id, createdAt: lastRow.created_at }
          : null,
    };
  }

  async pauseRunningBackfills(_now: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE backfill_jobs SET status = 'paused'
         WHERE status IN ('pending', 'running')`,
      )
      .run();
  }

  private async hydrateReport(
    run: ReportSummaryDto | null,
  ): Promise<ReportDto | null> {
    if (!run) return null;
    const movers = await this.db
      .prepare(
        `SELECT s.id AS screeningId, s.symbol,
         s.company_name AS companyName, s.exchange, s.currency,
         s.current_price AS currentPrice, s.change_amount AS changeAmount,
         s.change_pct AS changePct, s.qualified,
         a.explanation_zh_cn AS explanationZhCn, a.status AS analysisStatus
         FROM screenings s LEFT JOIN analyses a ON a.screening_id = s.id
         WHERE s.report_run_id = ?1
         ORDER BY CASE WHEN s.change_pct IS NULL THEN 1 ELSE 0 END,
         ABS(s.change_pct) DESC, s.symbol`,
      )
      .bind(run.id)
      .all<
        Omit<MoverDto, "sources" | "qualified"> & {
          qualified: number | null;
        }
      >();
    const sourceRows = await this.db
      .prepare(
        `SELECT src.screening_id AS screeningId, src.title, src.publisher,
         src.published_at AS publishedAt, src.url, src.cited
         FROM sources src JOIN screenings s ON s.id = src.screening_id
         WHERE s.report_run_id = ?1
         ORDER BY src.screening_id, src.source_index`,
      )
      .bind(run.id)
      .all<
        Omit<SourceDto, "cited"> & {
          screeningId: string;
          cited: number;
        }
      >();
    const sourcesByScreening = new Map<string, SourceDto[]>();
    for (const source of sourceRows.results) {
      const sources = sourcesByScreening.get(source.screeningId) ?? [];
      sources.push({
        title: source.title,
        publisher: source.publisher,
        publishedAt: source.publishedAt,
        url: source.url,
        cited: source.cited === 1,
      });
      sourcesByScreening.set(source.screeningId, sources);
    }
    const hydrated: MoverDto[] = [];
    for (const mover of movers.results) {
      hydrated.push({
        ...mover,
        qualified: mover.qualified === null ? null : mover.qualified === 1,
        sources: sourcesByScreening.get(mover.screeningId) ?? [],
      });
    }
    return { run, movers: hydrated };
  }

  async reportByDate(date: string): Promise<ReportDto | null> {
    const run = await this.db
      .prepare(
        `SELECT id, trading_date AS tradingDate, status,
         tickers_total AS tickersTotal, tickers_processed AS tickersProcessed,
         tickers_qualified AS tickersQualified, tickers_failed AS tickersFailed
         FROM report_runs WHERE trading_date = ?1 AND published = 1`,
      )
      .bind(date)
      .first<ReportSummaryDto>();
    return this.hydrateReport(run);
  }

  async latestPublishedReport(): Promise<ReportDto | null> {
    const run = await this.db
      .prepare(
        `SELECT id, trading_date AS tradingDate, status,
         tickers_total AS tickersTotal, tickers_processed AS tickersProcessed,
         tickers_qualified AS tickersQualified, tickers_failed AS tickersFailed
         FROM report_runs WHERE published = 1
         ORDER BY trading_date DESC LIMIT 1`,
      )
      .first<ReportSummaryDto>();
    return this.hydrateReport(run);
  }

  async currentRun(): Promise<ReportSummaryDto | null> {
    return this.db
      .prepare(
        `SELECT id, trading_date AS tradingDate, status,
         tickers_total AS tickersTotal, tickers_processed AS tickersProcessed,
         tickers_qualified AS tickersQualified, tickers_failed AS tickersFailed
         FROM report_runs WHERE origin = 'scheduled' AND published = 0
         AND status IN ('pending','running')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .first<ReportSummaryDto>();
  }

  async reportHistory(
    before: string | null,
    limit = 30,
  ): Promise<ReportSummaryDto[]> {
    const cursor = before ?? "9999-12-31";
    const rows = await this.db
      .prepare(
        `SELECT id, trading_date AS tradingDate, status,
         tickers_total AS tickersTotal, tickers_processed AS tickersProcessed,
         tickers_qualified AS tickersQualified, tickers_failed AS tickersFailed
         FROM report_runs WHERE published = 1 AND trading_date < ?1
         ORDER BY trading_date DESC LIMIT ?2`,
      )
      .bind(cursor, limit)
      .all<ReportSummaryDto>();
    return rows.results;
  }

  async retryAnalysis(
    screeningId: string,
    queue: Queue<ScreeningJobMessage>,
    now: string,
  ): Promise<"queued" | "not_retryable" | "daily_dispatch_limit"> {
    const row = await this.db
      .prepare(
        `SELECT qualified, report_run_id AS reportRunId, ticker_id AS tickerId
         FROM screenings
         WHERE id = ?1 AND status = 'failed'`,
      )
      .bind(screeningId)
      .first<{ qualified: number; reportRunId: string; tickerId: string }>();
    if (row?.qualified !== 1) return "not_retryable";
    const dayStart = `${now.slice(0, 10)}T00:00:00.000Z`;
    if ((await this.countDispatchedSince(dayStart)) >= 2_500) {
      return "daily_dispatch_limit";
    }
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE screenings SET status = 'queued', attempt_count = 0,
           queued_at = ?1, processing_started_at = NULL, error_code = NULL,
           error_message = NULL WHERE id = ?2`,
        )
        .bind(now, screeningId),
      this.db
        .prepare(
          `INSERT INTO dispatch_events (id, screening_id, dispatched_at)
           VALUES (?1, ?2, ?3)`,
        )
        .bind(crypto.randomUUID(), screeningId, now),
    ]);
    await queue.send({
      screeningId,
      reportRunId: row.reportRunId,
      tickerId: row.tickerId,
    });
    return "queued";
  }
}
