export interface DividendEventRecord {
  id: string;
  instrumentId: string;
  exDate: string;
  declarationDate: string | null;
  recordDate: string | null;
  paymentDate: string | null;
  amountPerShareDecimal: string;
  currency: "USD" | "CAD";
  provider: string;
  providerEventId: string;
  providerRevision: string;
  sourceUrl: string | null;
  announcedAt: string | null;
  retrievedAt: string;
  status: "active" | "superseded" | "stale" | "error";
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export class DividendRepository {
  constructor(private readonly db: D1Database) {}

  upsertStatement(event: DividendEventRecord): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO dividend_events
         (id, instrument_id, ex_date, declaration_date, record_date, payment_date,
          amount_per_share_decimal, currency, provider, provider_event_id,
          provider_revision, source_url, announced_at, retrieved_at, status,
          error_code, error_message, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                 ?14, ?15, ?16, ?17, ?18, ?19)
         ON CONFLICT(instrument_id, provider, provider_event_id, provider_revision)
         DO UPDATE SET ex_date = excluded.ex_date,
          declaration_date = excluded.declaration_date, record_date = excluded.record_date,
          payment_date = excluded.payment_date,
          amount_per_share_decimal = excluded.amount_per_share_decimal,
          currency = excluded.currency, source_url = excluded.source_url,
          announced_at = excluded.announced_at, retrieved_at = excluded.retrieved_at,
          status = excluded.status, error_code = excluded.error_code,
          error_message = excluded.error_message, updated_at = excluded.updated_at`,
      )
      .bind(
        event.id,
        event.instrumentId,
        event.exDate,
        event.declarationDate,
        event.recordDate,
        event.paymentDate,
        event.amountPerShareDecimal,
        event.currency,
        event.provider,
        event.providerEventId,
        event.providerRevision,
        event.sourceUrl,
        event.announcedAt,
        event.retrievedAt,
        event.status,
        event.errorCode,
        event.errorMessage,
        event.createdAt,
        event.updatedAt,
      );
  }

  async listByIdentity(input: {
    instrumentId: string;
    provider: string;
    providerEventId: string;
  }): Promise<DividendEventRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT id, instrument_id AS instrumentId, ex_date AS exDate,
                declaration_date AS declarationDate, record_date AS recordDate,
                payment_date AS paymentDate,
                amount_per_share_decimal AS amountPerShareDecimal, currency,
                provider, provider_event_id AS providerEventId,
                provider_revision AS providerRevision, source_url AS sourceUrl,
                announced_at AS announcedAt, retrieved_at AS retrievedAt,
                status, error_code AS errorCode, error_message AS errorMessage,
                created_at AS createdAt, updated_at AS updatedAt
         FROM dividend_events
         WHERE instrument_id = ?1 AND provider = ?2 AND provider_event_id = ?3
         ORDER BY provider_revision`,
      )
      .bind(input.instrumentId, input.provider, input.providerEventId)
      .all<DividendEventRecord>();
    return result.results;
  }

  async listForProvider(input: {
    instrumentId: string;
    provider: string;
  }): Promise<DividendEventRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT id, instrument_id AS instrumentId, ex_date AS exDate,
                declaration_date AS declarationDate, record_date AS recordDate,
                payment_date AS paymentDate,
                amount_per_share_decimal AS amountPerShareDecimal, currency,
                provider, provider_event_id AS providerEventId,
                provider_revision AS providerRevision, source_url AS sourceUrl,
                announced_at AS announcedAt, retrieved_at AS retrievedAt,
                status, error_code AS errorCode, error_message AS errorMessage,
                created_at AS createdAt, updated_at AS updatedAt
         FROM dividend_events WHERE instrument_id = ?1 AND provider = ?2
         ORDER BY ex_date, provider_event_id, provider_revision`,
      )
      .bind(input.instrumentId, input.provider)
      .all<DividendEventRecord>();
    return result.results;
  }

  async listForInstrument(
    instrumentId: string,
  ): Promise<DividendEventRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT id, instrument_id AS instrumentId, ex_date AS exDate,
                declaration_date AS declarationDate, record_date AS recordDate,
                payment_date AS paymentDate,
                amount_per_share_decimal AS amountPerShareDecimal, currency,
                provider, provider_event_id AS providerEventId,
                provider_revision AS providerRevision, source_url AS sourceUrl,
                announced_at AS announcedAt, retrieved_at AS retrievedAt,
                status, error_code AS errorCode, error_message AS errorMessage,
                created_at AS createdAt, updated_at AS updatedAt
         FROM dividend_events WHERE instrument_id = ?1
         ORDER BY ex_date, provider, provider_event_id, provider_revision`,
      )
      .bind(instrumentId)
      .all<DividendEventRecord>();
    return result.results;
  }

  markProviderErrorStatement(input: {
    instrumentId: string;
    provider: string;
    errorCode: string;
    errorMessage: string;
    updatedAt: string;
  }): D1PreparedStatement {
    return this.db
      .prepare(
        `UPDATE dividend_events
         SET status = 'error', error_code = ?1, error_message = ?2,
             updated_at = ?3
         WHERE instrument_id = ?4 AND provider = ?5 AND status = 'active'`,
      )
      .bind(
        input.errorCode,
        input.errorMessage,
        input.updatedAt,
        input.instrumentId,
        input.provider,
      );
  }

  markErrorStatement(input: {
    id: string;
    errorCode: string;
    errorMessage: string;
    updatedAt: string;
  }): D1PreparedStatement {
    return this.db
      .prepare(
        `UPDATE dividend_events
         SET status = 'error', error_code = ?1, error_message = ?2,
             updated_at = ?3
         WHERE id = ?4 AND status = 'active'`,
      )
      .bind(input.errorCode, input.errorMessage, input.updatedAt, input.id);
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
        `UPDATE dividend_events SET status = 'superseded', updated_at = ?1
         WHERE instrument_id = ?2 AND provider = ?3 AND provider_event_id = ?4
           AND provider_revision <> ?5 AND status = 'active'`,
      )
      .bind(
        input.updatedAt,
        input.instrumentId,
        input.provider,
        input.providerEventId,
        input.providerRevision,
      );
  }
}
