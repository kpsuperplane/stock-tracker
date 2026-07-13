export interface EarningsEventRecord {
  id: string;
  instrumentId: string;
  reportDate: string;
  fiscalDateEnding: string;
  epsEstimateDecimal: string | null;
  currency: "USD" | "CAD";
  timeOfDay: string | null;
  provider: string;
  providerEventId: string;
  providerRevision: string;
  retrievedAt: string;
  status: "active" | "superseded" | "stale";
  createdAt: string;
  updatedAt: string;
}

export interface EarningsCoverageRecord {
  provider: string;
  coverageStartDate: string | null;
  coverageEndDate: string | null;
  horizon: "3month";
  providerRevision: string | null;
  observedAt: string | null;
  status: "current" | "stale" | "unavailable";
  errorCode: string | null;
  errorMessage: string | null;
  updatedAt: string;
}

export class EarningsRepository {
  constructor(private readonly db: D1Database) {}

  upsertStatement(event: EarningsEventRecord): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO earnings_events
         (id, instrument_id, report_date, fiscal_date_ending,
          eps_estimate_decimal, currency, time_of_day, provider,
          provider_event_id, provider_revision, retrieved_at, status,
          created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT(instrument_id, provider, provider_event_id, provider_revision)
         DO UPDATE SET report_date = excluded.report_date,
          fiscal_date_ending = excluded.fiscal_date_ending,
          eps_estimate_decimal = excluded.eps_estimate_decimal,
          currency = excluded.currency, time_of_day = excluded.time_of_day,
          retrieved_at = excluded.retrieved_at, status = excluded.status,
          updated_at = excluded.updated_at`,
      )
      .bind(
        event.id,
        event.instrumentId,
        event.reportDate,
        event.fiscalDateEnding,
        event.epsEstimateDecimal,
        event.currency,
        event.timeOfDay,
        event.provider,
        event.providerEventId,
        event.providerRevision,
        event.retrievedAt,
        event.status,
        event.createdAt,
        event.updatedAt,
      );
  }

  async listForInstruments(
    instrumentIds: readonly string[],
    provider: string,
  ): Promise<EarningsEventRecord[]> {
    if (instrumentIds.length === 0) return [];
    const result = await this.db
      .prepare(
        `SELECT id, instrument_id AS instrumentId, report_date AS reportDate,
                fiscal_date_ending AS fiscalDateEnding,
                eps_estimate_decimal AS epsEstimateDecimal, currency,
                time_of_day AS timeOfDay, provider,
                provider_event_id AS providerEventId,
                provider_revision AS providerRevision,
                retrieved_at AS retrievedAt, status,
                created_at AS createdAt, updated_at AS updatedAt
           FROM earnings_events
          WHERE provider = ?1
            AND instrument_id IN (SELECT value FROM json_each(?2))
          ORDER BY report_date, instrument_id, provider_event_id, provider_revision`,
      )
      .bind(provider, JSON.stringify(instrumentIds))
      .all<EarningsEventRecord>();
    return result.results;
  }

  supersedeIdentityStatement(input: {
    instrumentId: string;
    provider: string;
    providerEventId: string;
    providerRevision: string;
    updatedAt: string;
  }): D1PreparedStatement {
    return this.db
      .prepare(
        `UPDATE earnings_events SET status = 'superseded', updated_at = ?1
         WHERE instrument_id = ?2 AND provider = ?3 AND provider_event_id = ?4
           AND provider_revision <> ?5 AND status IN ('active', 'stale')`,
      )
      .bind(
        input.updatedAt,
        input.instrumentId,
        input.provider,
        input.providerEventId,
        input.providerRevision,
      );
  }

  markStaleStatement(input: {
    id: string;
    updatedAt: string;
  }): D1PreparedStatement {
    return this.db
      .prepare(
        `UPDATE earnings_events SET status = 'stale', updated_at = ?1
         WHERE id = ?2 AND status = 'active'`,
      )
      .bind(input.updatedAt, input.id);
  }

  async coverage(provider: string): Promise<EarningsCoverageRecord | null> {
    return this.db
      .prepare(
        `SELECT provider, coverage_start_date AS coverageStartDate,
                coverage_end_date AS coverageEndDate, horizon,
                provider_revision AS providerRevision,
                observed_at AS observedAt, status, error_code AS errorCode,
                error_message AS errorMessage, updated_at AS updatedAt
           FROM earnings_calendar_coverage WHERE provider = ?1`,
      )
      .bind(provider)
      .first<EarningsCoverageRecord>();
  }

  upsertCoverageStatement(
    coverage: EarningsCoverageRecord,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO earnings_calendar_coverage
         (provider, coverage_start_date, coverage_end_date, horizon,
          provider_revision, observed_at, status, error_code, error_message,
          updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(provider) DO UPDATE SET
          coverage_start_date = excluded.coverage_start_date,
          coverage_end_date = excluded.coverage_end_date,
          horizon = excluded.horizon,
          provider_revision = excluded.provider_revision,
          observed_at = excluded.observed_at, status = excluded.status,
          error_code = excluded.error_code, error_message = excluded.error_message,
          updated_at = excluded.updated_at`,
      )
      .bind(
        coverage.provider,
        coverage.coverageStartDate,
        coverage.coverageEndDate,
        coverage.horizon,
        coverage.providerRevision,
        coverage.observedAt,
        coverage.status,
        coverage.errorCode,
        coverage.errorMessage,
        coverage.updatedAt,
      );
  }
}
