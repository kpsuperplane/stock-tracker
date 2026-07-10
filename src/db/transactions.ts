export interface TransactionRecord {
  id: string;
  instrumentId: string;
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
         (id, instrument_id, trade_date, side, quantity_decimal, price_decimal,
          revision, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      )
      .bind(
        record.id,
        record.instrumentId,
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
         SET trade_date = ?1, side = ?2, quantity_decimal = ?3,
             price_decimal = ?4, revision = revision + 1, updated_at = ?5
         WHERE id = ?6 AND instrument_id = ?7 AND revision = ?8`,
      )
      .bind(
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

  async listForInstrument(instrumentId: string): Promise<TransactionRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM transactions WHERE instrument_id = ?1
         ORDER BY trade_date, id`,
      )
      .bind(instrumentId)
      .all<TransactionRow>();
    return result.results.map(mapTransaction);
  }
}
