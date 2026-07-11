import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
      BASIC_AUTH_USERNAME: string;
      BASIC_AUTH_PASSWORD: string;
    }
  }
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM dispatch_daily_reservations"),
    env.DB.prepare("DELETE FROM dispatch_batch_items"),
    env.DB.prepare("DELETE FROM dispatch_batches"),
    env.DB.prepare("DELETE FROM job_work_items"),
    env.DB.prepare("DELETE FROM work_items"),
    env.DB.prepare("DELETE FROM news_sources"),
    env.DB.prepare("DELETE FROM portfolio_migration_audit"),
    env.DB.prepare(
      `UPDATE portfolio_migration_state SET
         cursor_trading_date = NULL, cursor_run_id = NULL,
         cursor_generation = NULL, cursor_screening_id = NULL,
         high_water_trading_date = NULL, high_water_generation = NULL,
         high_water_run_id = NULL,
         pass_number = 0, status = 'idle', lease_owner = NULL,
         lease_until = NULL, examined_count = 0, inserted_count = 0,
         updated_count = 0, unchanged_count = 0, skipped_count = 0,
         mismatched_count = 0, error_count = 0, last_error_code = NULL,
         last_error_message = NULL, last_audit_hash = NULL,
         pass_unexplained_count = 0, consecutive_clean_passes = 0,
         last_started_at = NULL, last_completed_at = NULL,
         updated_at = datetime('now') WHERE id = 'legacy-published'`,
    ),
    env.DB.prepare("DELETE FROM legacy_dual_write_repairs"),
    env.DB.prepare("DELETE FROM movement_analyses"),
    env.DB.prepare("DELETE FROM daily_market_facts"),
    env.DB.prepare("DELETE FROM dividend_events"),
    env.DB.prepare("DELETE FROM fact_revision_buckets"),
    env.DB.prepare("DELETE FROM import_rows"),
    env.DB.prepare("DELETE FROM import_batches"),
    env.DB.prepare("DELETE FROM corporate_action_coverage"),
    env.DB.prepare("DELETE FROM corporate_actions"),
    env.DB.prepare("DELETE FROM transactions"),
    env.DB.prepare("DELETE FROM pipeline_jobs"),
    env.DB.prepare("DELETE FROM ledger_mutations"),
    env.DB.prepare(
      "UPDATE position_basis_state SET revision = 0, updated_at = NULL, last_mutation_id = NULL WHERE id = 1",
    ),
    env.DB.prepare("DELETE FROM instruments"),
    env.DB.prepare("DELETE FROM dispatch_events"),
    env.DB.prepare("DELETE FROM sources"),
    env.DB.prepare("DELETE FROM analyses"),
    env.DB.prepare("DELETE FROM screenings"),
    env.DB.prepare("DELETE FROM report_runs"),
    env.DB.prepare("DELETE FROM backfill_jobs"),
    env.DB.prepare("DELETE FROM tickers"),
  ]);
});
