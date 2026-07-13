export interface TransactionRecord {
  id: string;
  instrumentId: string;
  /**
   * Brokerage account that owns this transaction.  Optional at the type
   * boundary so legacy fixtures and callers written before account scoping
   * can still be read; all persisted rows are normalized to account-default
   * by the account migration/fallback.
   */
  accountId?: string;
  tradeDate: string;
  side: "buy" | "sell";
  quantityDecimal: string;
  priceDecimal: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

interface TransactionRow {
  id: string;
  instrument_id: string;
  account_id: string | null;
  trade_date: string;
  side: "buy" | "sell";
  quantity_decimal: string;
  price_decimal: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

const mapTransaction = (row: TransactionRow): TransactionRecord => ({
  id: row.id,
  instrumentId: row.instrument_id,
  accountId: row.account_id ?? "account-default",
  tradeDate: row.trade_date,
  side: row.side,
  quantityDecimal: row.quantity_decimal,
  priceDecimal: row.price_decimal,
  revision: row.revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class TransactionRepository {
  constructor(private readonly db: D1Database) {}

  insertStatement(record: TransactionRecord): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO transactions
         (id, instrument_id, account_id, trade_date, side, quantity_decimal,
          price_decimal, revision, created_at, updated_at)
         VALUES (?1, ?2, COALESCE(?3, 'account-default'), ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      )
      .bind(
        record.id,
        record.instrumentId,
        record.accountId ?? null,
        record.tradeDate,
        record.side,
        record.quantityDecimal,
        record.priceDecimal,
        record.revision,
        record.createdAt,
        record.updatedAt,
      );
  }

  updateStatement(
    record: TransactionRecord,
    expectedRevision: number,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `UPDATE transactions
         SET account_id = COALESCE(?1, account_id), trade_date = ?2,
             side = ?3, quantity_decimal = ?4, price_decimal = ?5,
             revision = revision + 1, updated_at = ?6
         WHERE id = ?7 AND instrument_id = ?8 AND revision = ?9`,
      )
      .bind(
        record.accountId ?? null,
        record.tradeDate,
        record.side,
        record.quantityDecimal,
        record.priceDecimal,
        record.updatedAt,
        record.id,
        record.instrumentId,
        expectedRevision,
      );
  }

  deleteStatement(id: string, expectedRevision: number): D1PreparedStatement {
    return this.db
      .prepare("DELETE FROM transactions WHERE id = ?1 AND revision = ?2")
      .bind(id, expectedRevision);
  }

  async listForInstrument(
    instrumentId: string,
    accountIds?: readonly string[],
  ): Promise<TransactionRecord[]> {
    const requested =
      accountIds && accountIds.length > 0 ? [...new Set(accountIds)] : null;
    const result = await this.db
      .prepare(
        `SELECT * FROM transactions
         WHERE instrument_id = ?1
           AND (?2 IS NULL OR account_id IN (
             SELECT value FROM json_each(?2)
           ))
         ORDER BY trade_date, id`,
      )
      .bind(instrumentId, requested ? JSON.stringify(requested) : null)
      .all<TransactionRow>();
    return result.results.map(mapTransaction);
  }

  async listForAccountIds(
    accountIds: readonly string[],
  ): Promise<TransactionRecord[]> {
    const requested = [...new Set(accountIds)];
    if (requested.length === 0) return [];
    const result = await this.db
      .prepare(
        `SELECT * FROM transactions
         WHERE account_id IN (SELECT value FROM json_each(?1))
         ORDER BY instrument_id, trade_date, id`,
      )
      .bind(JSON.stringify(requested))
      .all<TransactionRow>();
    return result.results.map(mapTransaction);
  }
}
