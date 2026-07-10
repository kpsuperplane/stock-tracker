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
}
