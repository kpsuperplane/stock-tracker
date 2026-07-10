export type CorporateActionStatus =
  | "candidate"
  | "active"
  | "superseded"
  | "quarantined";
export type CorporateActionCoverageStatus =
  | "review_required"
  | "confirmed"
  | "refreshing"
  | "unavailable"
  | "conflict";

export interface CorporateActionRecord {
  id: string;
  instrumentId: string;
  effectiveDate: string;
  splitNumerator: string;
  splitDenominator: string;
  provider: string;
  providerEventId: string;
  providerRevision: string;
  retrievedAt: string;
  revision: number;
  status: CorporateActionStatus;
  conflictCode: string | null;
  conflictMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CoverageRecord {
  instrumentId: string;
  provider: string;
  requestedStartDate: string;
  requestedEndDate: string;
  snapshotProviderRevision: string | null;
  retrievedAt: string | null;
  confirmedStartDate: string | null;
  confirmedEndDate: string | null;
  confirmedProviderRevision: string | null;
  confirmedAt: string | null;
  status: CorporateActionCoverageStatus;
  errorCode: string | null;
  errorMessage: string | null;
  updatedAt: string;
}

export class CorporateActionRepository {
  constructor(private readonly db: D1Database) {}

  insertStatement(action: CorporateActionRecord): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO corporate_actions
         (id, instrument_id, action_type, effective_date, split_numerator,
          split_denominator, provider, provider_event_id, provider_revision,
          retrieved_at, revision, status, conflict_code, conflict_message,
          created_at, updated_at)
         VALUES (?1, ?2, 'split', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                 ?11, ?12, ?13, ?14, ?15)`,
      )
      .bind(
        action.id,
        action.instrumentId,
        action.effectiveDate,
        action.splitNumerator,
        action.splitDenominator,
        action.provider,
        action.providerEventId,
        action.providerRevision,
        action.retrievedAt,
        action.revision,
        action.status,
        action.conflictCode,
        action.conflictMessage,
        action.createdAt,
        action.updatedAt,
      );
  }

  upsertCoverageStatement(coverage: CoverageRecord): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO corporate_action_coverage
         (instrument_id, provider, requested_start_date, requested_end_date,
          snapshot_provider_revision, retrieved_at, confirmed_start_date,
          confirmed_end_date, confirmed_provider_revision, confirmed_at,
          status, error_code, error_message, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT(instrument_id, provider) DO UPDATE SET
          requested_start_date = excluded.requested_start_date,
          requested_end_date = excluded.requested_end_date,
          snapshot_provider_revision = excluded.snapshot_provider_revision,
          retrieved_at = excluded.retrieved_at,
          confirmed_start_date = excluded.confirmed_start_date,
          confirmed_end_date = excluded.confirmed_end_date,
          confirmed_provider_revision = excluded.confirmed_provider_revision,
          confirmed_at = excluded.confirmed_at,
          status = excluded.status, error_code = excluded.error_code,
          error_message = excluded.error_message, updated_at = excluded.updated_at`,
      )
      .bind(
        coverage.instrumentId,
        coverage.provider,
        coverage.requestedStartDate,
        coverage.requestedEndDate,
        coverage.snapshotProviderRevision,
        coverage.retrievedAt,
        coverage.confirmedStartDate,
        coverage.confirmedEndDate,
        coverage.confirmedProviderRevision,
        coverage.confirmedAt,
        coverage.status,
        coverage.errorCode,
        coverage.errorMessage,
        coverage.updatedAt,
      );
  }

  async listForInstrument(
    instrumentId: string,
  ): Promise<CorporateActionRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT id, instrument_id AS instrumentId, effective_date AS effectiveDate,
         split_numerator AS splitNumerator, split_denominator AS splitDenominator,
         provider, provider_event_id AS providerEventId,
         provider_revision AS providerRevision, retrieved_at AS retrievedAt,
         revision, status, conflict_code AS conflictCode,
         conflict_message AS conflictMessage, created_at AS createdAt,
         updated_at AS updatedAt
         FROM corporate_actions WHERE instrument_id = ?1
         ORDER BY effective_date, id`,
      )
      .bind(instrumentId)
      .all<CorporateActionRecord>();
    return result.results;
  }
}
