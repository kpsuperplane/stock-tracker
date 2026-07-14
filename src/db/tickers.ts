import type { InstrumentType } from "../domain/instruments";

export interface TickerRecord {
  id: string;
  symbol: string;
  companyName: string;
  exchange: string;
  currency: string;
  instrumentType: InstrumentType;
  active: boolean;
  deletedAt: string | null;
}

export interface InsertTicker {
  id: string;
  symbol: string;
  companyName: string;
  exchange: string;
  currency: string;
  instrumentType?: InstrumentType;
  now: string;
}

interface TickerRow {
  id: string;
  symbol: string;
  company_name: string;
  exchange: string;
  currency: string;
  security_type: InstrumentType;
  active: number;
  deleted_at: string | null;
}

const mapTicker = (row: TickerRow): TickerRecord => ({
  id: row.id,
  symbol: row.symbol,
  companyName: row.company_name,
  exchange: row.exchange,
  currency: row.currency,
  instrumentType: row.security_type,
  active: row.active === 1,
  deletedAt: row.deleted_at,
});

export class TickerRepository {
  constructor(private readonly db: D1Database) {}

  async list(): Promise<TickerRecord[]> {
    const result = await this.db
      .prepare("SELECT * FROM tickers WHERE deleted_at IS NULL ORDER BY symbol")
      .all<TickerRow>();
    return result.results.map(mapTicker);
  }

  async listActive(): Promise<TickerRecord[]> {
    const result = await this.db
      .prepare(
        "SELECT * FROM tickers WHERE active = 1 AND deleted_at IS NULL ORDER BY symbol",
      )
      .all<TickerRow>();
    return result.results.map(mapTicker);
  }

  async countActive(): Promise<number> {
    const row = await this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM tickers WHERE active = 1 AND deleted_at IS NULL",
      )
      .first<{ count: number }>();
    return row?.count ?? 0;
  }

  async findBySymbol(symbol: string): Promise<TickerRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM tickers WHERE symbol = ?1")
      .bind(symbol)
      .first<TickerRow>();
    return row ? mapTicker(row) : null;
  }

  async insert(input: InsertTicker): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO tickers
         (id, symbol, company_name, exchange, currency, security_type, active,
          created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?7)`,
      )
      .bind(
        input.id,
        input.symbol,
        input.companyName,
        input.exchange,
        input.currency,
        input.instrumentType ?? "stock",
        input.now,
      )
      .run();
  }

  async restore(input: InsertTicker): Promise<void> {
    await this.db
      .prepare(
        `UPDATE tickers
         SET company_name = ?1, exchange = ?2, currency = ?3,
             security_type = ?4, active = 1, deleted_at = NULL,
             updated_at = ?5
         WHERE id = ?6`,
      )
      .bind(
        input.companyName,
        input.exchange,
        input.currency,
        input.instrumentType ?? "stock",
        input.now,
        input.id,
      )
      .run();
  }

  async setActive(id: string, active: boolean, now: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        "UPDATE tickers SET active = ?1, updated_at = ?2 WHERE id = ?3 AND deleted_at IS NULL",
      )
      .bind(active ? 1 : 0, now, id)
      .run();
    return result.meta.changes === 1;
  }

  async softDelete(id: string, now: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE tickers SET active = 0, deleted_at = ?1, updated_at = ?1
         WHERE id = ?2 AND deleted_at IS NULL`,
      )
      .bind(now, id)
      .run();
    return result.meta.changes === 1;
  }
}
