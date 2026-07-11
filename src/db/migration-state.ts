export const LEGACY_MIGRATION_ID = "legacy-published";

export interface MigrationCursor {
  tradingDate: string;
  runId: string;
  generation: number;
  screeningId: string;
}

export interface MigrationStateRecord {
  id: string;
  cursor: MigrationCursor | null;
  highWater: { tradingDate: string; generation: number; runId: string } | null;
  passNumber: number;
  status: "idle" | "running" | "complete" | "failed";
  leaseOwner: string | null;
  leaseUntil: string | null;
  examinedCount: number;
  insertedCount: number;
  updatedCount: number;
  unchangedCount: number;
  skippedCount: number;
  mismatchedCount: number;
  errorCount: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  lastAuditHash: string | null;
  passUnexplainedCount: number;
  consecutiveCleanPasses: number;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MigrationStateRow {
  id: string;
  cursorTradingDate: string | null;
  cursorRunId: string | null;
  cursorGeneration: number | null;
  cursorScreeningId: string | null;
  highWaterTradingDate: string | null;
  highWaterGeneration: number | null;
  highWaterRunId: string | null;
  passNumber: number;
  status: MigrationStateRecord["status"];
  leaseOwner: string | null;
  leaseUntil: string | null;
  examinedCount: number;
  insertedCount: number;
  updatedCount: number;
  unchangedCount: number;
  skippedCount: number;
  mismatchedCount: number;
  errorCount: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  lastAuditHash: string | null;
  passUnexplainedCount: number;
  consecutiveCleanPasses: number;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const mapState = (row: MigrationStateRow): MigrationStateRecord => ({
  id: row.id,
  cursor:
    row.cursorTradingDate &&
    row.cursorRunId &&
    row.cursorGeneration !== null &&
    row.cursorScreeningId
      ? {
          tradingDate: row.cursorTradingDate,
          runId: row.cursorRunId,
          generation: row.cursorGeneration,
          screeningId: row.cursorScreeningId,
        }
      : null,
  highWater:
    row.highWaterTradingDate &&
    row.highWaterGeneration !== null &&
    row.highWaterRunId
      ? {
          tradingDate: row.highWaterTradingDate,
          generation: row.highWaterGeneration,
          runId: row.highWaterRunId,
        }
      : null,
  passNumber: row.passNumber,
  status: row.status,
  leaseOwner: row.leaseOwner,
  leaseUntil: row.leaseUntil,
  examinedCount: row.examinedCount,
  insertedCount: row.insertedCount,
  updatedCount: row.updatedCount,
  unchangedCount: row.unchangedCount,
  skippedCount: row.skippedCount,
  mismatchedCount: row.mismatchedCount,
  errorCount: row.errorCount,
  lastErrorCode: row.lastErrorCode,
  lastErrorMessage: row.lastErrorMessage,
  lastAuditHash: row.lastAuditHash,
  passUnexplainedCount: row.passUnexplainedCount,
  consecutiveCleanPasses: row.consecutiveCleanPasses,
  lastStartedAt: row.lastStartedAt,
  lastCompletedAt: row.lastCompletedAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const stateSelect = `
  SELECT id,
         cursor_trading_date AS cursorTradingDate,
         cursor_run_id AS cursorRunId,
         cursor_generation AS cursorGeneration,
         cursor_screening_id AS cursorScreeningId,
         high_water_trading_date AS highWaterTradingDate,
         high_water_generation AS highWaterGeneration,
         high_water_run_id AS highWaterRunId,
         pass_number AS passNumber, status,
         lease_owner AS leaseOwner, lease_until AS leaseUntil,
         examined_count AS examinedCount, inserted_count AS insertedCount,
         updated_count AS updatedCount, unchanged_count AS unchangedCount,
         skipped_count AS skippedCount, mismatched_count AS mismatchedCount,
         error_count AS errorCount, last_error_code AS lastErrorCode,
         last_error_message AS lastErrorMessage,
         last_audit_hash AS lastAuditHash,
         pass_unexplained_count AS passUnexplainedCount,
         consecutive_clean_passes AS consecutiveCleanPasses,
         last_started_at AS lastStartedAt, last_completed_at AS lastCompletedAt,
         created_at AS createdAt, updated_at AS updatedAt
    FROM portfolio_migration_state`;

export interface MigrationPageStats {
  examined: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
  mismatched: number;
  errors: number;
  unexplained: number;
  auditHash: string | null;
}

export class MigrationStateRepository {
  constructor(private readonly db: D1Database) {}

  async get(
    id: string = LEGACY_MIGRATION_ID,
  ): Promise<MigrationStateRecord | null> {
    const row = await this.db
      .prepare(`${stateSelect} WHERE id = ?1`)
      .bind(id)
      .first<MigrationStateRow>();
    return row ? mapState(row) : null;
  }

  async claimLease(input: {
    owner: string;
    now: string;
    leaseUntil: string;
    id?: string;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE portfolio_migration_state
            SET lease_owner = ?1, lease_until = ?2,
                last_started_at = COALESCE(last_started_at, ?3),
                updated_at = ?3
          WHERE id = ?4
            AND (lease_owner IS NULL OR lease_until IS NULL
                 OR lease_until < ?3 OR lease_owner = ?1)`,
      )
      .bind(
        input.owner,
        input.leaseUntil,
        input.now,
        input.id ?? LEGACY_MIGRATION_ID,
      )
      .run();
    return result.meta.changes === 1;
  }

  async beginPass(input: {
    owner: string;
    now: string;
    id?: string;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE portfolio_migration_state
            SET cursor_trading_date = NULL, cursor_run_id = NULL,
                cursor_generation = NULL,
                cursor_screening_id = NULL, pass_number = pass_number + 1,
                high_water_trading_date = (
                  SELECT trading_date FROM report_runs
                   WHERE published = 1
                   ORDER BY trading_date DESC, generation DESC, id DESC LIMIT 1
                ),
                high_water_generation = (
                  SELECT generation FROM report_runs
                   WHERE published = 1
                   ORDER BY trading_date DESC, generation DESC, id DESC LIMIT 1
                ),
                high_water_run_id = (
                  SELECT id FROM report_runs
                   WHERE published = 1
                   ORDER BY trading_date DESC, generation DESC, id DESC LIMIT 1
                ),
                status = 'running', pass_unexplained_count = 0,
                last_error_code = NULL, last_error_message = NULL,
                last_started_at = ?1, updated_at = ?1
          WHERE id = ?2 AND lease_owner = ?3`,
      )
      .bind(input.now, input.id ?? LEGACY_MIGRATION_ID, input.owner)
      .run();
    return result.meta.changes === 1;
  }

  async captureHighWater(input: {
    owner: string;
    now: string;
    id?: string;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE portfolio_migration_state
            SET high_water_trading_date = (
                  SELECT trading_date FROM report_runs
                   WHERE published = 1
                   ORDER BY trading_date DESC, generation DESC, id DESC LIMIT 1
                ),
                high_water_generation = (
                  SELECT generation FROM report_runs
                   WHERE published = 1
                   ORDER BY trading_date DESC, generation DESC, id DESC LIMIT 1
                ),
                high_water_run_id = (
                  SELECT id FROM report_runs
                   WHERE published = 1
                   ORDER BY trading_date DESC, generation DESC, id DESC LIMIT 1
                ),
                updated_at = ?1
          WHERE id = ?2 AND lease_owner = ?3
            AND (
              high_water_trading_date IS NULL OR
              high_water_generation IS NULL OR
              high_water_run_id IS NULL
            )`,
      )
      .bind(input.now, input.id ?? LEGACY_MIGRATION_ID, input.owner)
      .run();
    return result.meta.changes === 1;
  }

  async advance(input: {
    owner: string;
    now: string;
    cursor: MigrationCursor | null;
    complete: boolean;
    stats: MigrationPageStats;
    id?: string;
  }): Promise<boolean> {
    const cursor = input.cursor;
    const unexplained = input.stats.unexplained;
    const result = await this.db
      .prepare(
        `UPDATE portfolio_migration_state
            SET cursor_trading_date = ?1, cursor_run_id = ?2,
                cursor_generation = ?3, cursor_screening_id = ?4,
                status = CASE WHEN ?5 = 1 THEN 'complete' ELSE 'running' END,
                examined_count = examined_count + ?6,
                inserted_count = inserted_count + ?7,
                updated_count = updated_count + ?8,
                unchanged_count = unchanged_count + ?9,
                skipped_count = skipped_count + ?10,
                mismatched_count = mismatched_count + ?11,
                error_count = error_count + ?12,
                last_audit_hash = COALESCE(?13, last_audit_hash),
                pass_unexplained_count = CASE
                  WHEN ?5 = 1 THEN 0 ELSE pass_unexplained_count + ?14 END,
                consecutive_clean_passes = CASE
                  WHEN ?5 = 1 AND pass_unexplained_count + ?14 = 0
                    THEN consecutive_clean_passes + 1
                  WHEN ?5 = 1 THEN 0
                  ELSE consecutive_clean_passes END,
                last_completed_at = CASE WHEN ?5 = 1 THEN ?15 ELSE last_completed_at END,
                last_error_code = CASE WHEN ?12 > 0 THEN 'migration_page_error' ELSE last_error_code END,
                last_error_message = CASE WHEN ?12 > 0
                  THEN 'One or more migration rows failed; inspect the audit.'
                  ELSE last_error_message END,
                updated_at = ?15, lease_owner = NULL, lease_until = NULL
          WHERE id = ?16 AND lease_owner = ?17`,
      )
      .bind(
        cursor?.tradingDate ?? null,
        cursor?.runId ?? null,
        cursor?.generation ?? null,
        cursor?.screeningId ?? null,
        input.complete ? 1 : 0,
        input.stats.examined,
        input.stats.inserted,
        input.stats.updated,
        input.stats.unchanged,
        input.stats.skipped,
        input.stats.mismatched,
        input.stats.errors,
        input.stats.auditHash,
        unexplained,
        input.now,
        input.id ?? LEGACY_MIGRATION_ID,
        input.owner,
      )
      .run();
    return result.meta.changes === 1;
  }

  async fail(input: {
    owner: string;
    now: string;
    code: string;
    message: string;
    id?: string;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE portfolio_migration_state
            SET status = 'failed', last_error_code = ?1,
                last_error_message = substr(?2, 1, 500),
                updated_at = ?3, lease_owner = NULL, lease_until = NULL
          WHERE id = ?4 AND lease_owner = ?5`,
      )
      .bind(
        input.code,
        input.message,
        input.now,
        input.id ?? LEGACY_MIGRATION_ID,
        input.owner,
      )
      .run();
    return result.meta.changes === 1;
  }

  async latestAudit(input: {
    screeningId: string;
    generation: number;
    id?: string;
  }): Promise<{
    contentHash: string;
    provenanceHash: string;
    outcome: string;
  } | null> {
    return (
      (await this.db
        .prepare(
          `SELECT content_hash AS contentHash,
                  provenance_hash AS provenanceHash, outcome
             FROM portfolio_migration_audit
            WHERE migration_id = ?1 AND legacy_screening_id = ?2
              AND legacy_generation = ?3
            ORDER BY examined_at DESC, rowid DESC LIMIT 1`,
        )
        .bind(
          input.id ?? LEGACY_MIGRATION_ID,
          input.screeningId,
          input.generation,
        )
        .first<{
          contentHash: string;
          provenanceHash: string;
          outcome: string;
        }>()) ?? null
    );
  }

  async hasMismatchedAudit(input: {
    screeningId: string;
    generation: number;
    id?: string;
  }): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 FROM portfolio_migration_audit
          WHERE migration_id = ?1 AND legacy_screening_id = ?2
            AND legacy_generation = ?3 AND outcome = 'mismatched'
          LIMIT 1`,
      )
      .bind(
        input.id ?? LEGACY_MIGRATION_ID,
        input.screeningId,
        input.generation,
      )
      .first();
    return Boolean(row);
  }

  auditStatement(input: {
    id: string;
    legacyRunId: string;
    legacyScreeningId: string;
    legacyGeneration: number;
    tradingDate: string;
    tickerId: string | null;
    instrumentId: string | null;
    contentHash: string;
    provenanceHash: string;
    outcome: string;
    reasonCode: string | null;
    reasonMessage: string | null;
    examinedAt: string;
    idState?: string;
  }): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO portfolio_migration_audit
           (id, migration_id, legacy_run_id, legacy_screening_id,
            legacy_generation, trading_date, ticker_id, instrument_id,
            content_hash, provenance_hash, outcome, reason_code,
            reason_message, examined_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                 ?14, ?14, ?14)
         ON CONFLICT(migration_id, legacy_run_id, legacy_screening_id,
                     legacy_generation, content_hash) DO UPDATE SET
           instrument_id = excluded.instrument_id, outcome = excluded.outcome,
           reason_code = excluded.reason_code,
           reason_message = excluded.reason_message,
           examined_at = excluded.examined_at, updated_at = excluded.updated_at`,
      )
      .bind(
        input.id,
        input.idState ?? LEGACY_MIGRATION_ID,
        input.legacyRunId,
        input.legacyScreeningId,
        input.legacyGeneration,
        input.tradingDate,
        input.tickerId,
        input.instrumentId,
        input.contentHash,
        input.provenanceHash,
        input.outcome,
        input.reasonCode,
        input.reasonMessage,
        input.examinedAt,
      );
  }
}
