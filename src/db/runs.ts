import type { ExplanationResult } from "../providers/explanations";
import type { NewsItem } from "../providers/news";
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
  constructor(private readonly db: D1Database) {}

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
    return this.db
      .prepare(
        `SELECT id, report_run_id AS reportRunId, symbol,
         company_name AS companyName, exchange, currency,
         target_date AS targetDate, attempt_count AS attemptCount
         FROM screenings WHERE id = ?1`,
      )
      .bind(id)
      .first<ScreeningWork>();
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
    if (sources.length === 0) return;
    await this.db.batch(
      sources.slice(0, 10).map((source, index) =>
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
    );
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
          result.confidence,
          result.clearCatalyst ? 1 : 0,
          result.model,
          now,
        ),
      this.db
        .prepare(
          `UPDATE sources
           SET cited = CASE
             WHEN source_index IN (SELECT value FROM json_each(?1)) THEN 1
             ELSE 0 END
           WHERE screening_id = ?2`,
        )
        .bind(JSON.stringify(result.sourceIndexes), screeningId),
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
      .prepare(
        "SELECT report_run_id AS runId FROM screenings WHERE id = ?1",
      )
      .bind(id)
      .first<{ runId: string }>();
    return row?.runId ?? null;
  }

  async publishGeneration(runId: string, now: string): Promise<void> {
    const run = await this.db
      .prepare(
        `SELECT trading_date AS tradingDate FROM report_runs
         WHERE id = ?1 AND status IN ('complete', 'complete_with_errors')`,
      )
      .bind(runId)
      .first<{ tradingDate: string }>();
    if (!run) throw new Error("run_not_publishable");
    await this.db.batch([
      this.db
        .prepare(
          "UPDATE report_runs SET published = 0 WHERE trading_date = ?1 AND published = 1",
        )
        .bind(run.tradingDate),
      this.db
        .prepare(
          `UPDATE report_runs SET published = 1,
           completed_at = COALESCE(completed_at, ?1) WHERE id = ?2`,
        )
        .bind(now, runId),
    ]);
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
        "SELECT COUNT(*) AS count FROM screenings WHERE queued_at >= ?1",
      )
      .bind(dayStart)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }

  async dispatchPending(
    queue: Queue<{ screeningId: string }>,
    limit: number,
    now: string,
  ): Promise<number> {
    if (limit <= 0) return 0;
    const rows = await this.db
      .prepare(
        `SELECT id FROM screenings WHERE status = 'pending'
         ORDER BY target_date, id LIMIT ?1`,
      )
      .bind(limit)
      .all<{ id: string }>();
    if (rows.results.length === 0) return 0;
    for (let offset = 0; offset < rows.results.length; offset += 100) {
      const chunk = rows.results.slice(offset, offset + 100);
      await queue.sendBatch(
        chunk.map((row) => ({ body: { screeningId: row.id } })),
      );
      await this.db.batch(
        chunk.map((row) =>
          this.db
            .prepare(
              `UPDATE screenings SET status = 'queued', queued_at = ?1
               WHERE id = ?2 AND status = 'pending'`,
            )
            .bind(now, row.id),
        ),
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
        .bind(
          counts.processed,
          counts.qualified,
          counts.failed,
          now,
          runId,
        )
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
      await this.publishGeneration(runId, now);
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
}
