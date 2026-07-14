import type { InstrumentType } from "../domain/instruments";

export interface InstrumentRecord {
  id: string;
  symbol: string;
  companyName: string;
  exchange: string;
  currency: "USD" | "CAD";
  instrumentType: InstrumentType;
  provider: string;
  providerSymbol: string;
  providerMetadataJson: string | null;
  createdAt: string;
  updatedAt: string;
}

interface InstrumentRow {
  id: string;
  symbol: string;
  company_name: string;
  exchange: string;
  currency: "USD" | "CAD";
  instrument_type: "stock" | "etf";
  security_type: InstrumentType;
  provider: string;
  provider_symbol: string;
  provider_metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

interface TickerIdentityRow {
  id: string;
  symbol: string;
  company_name: string;
  exchange: string;
  currency: "USD" | "CAD";
  security_type: InstrumentType;
  created_at: string;
  updated_at: string;
}

const mapInstrument = (row: InstrumentRow): InstrumentRecord => ({
  id: row.id,
  symbol: row.symbol,
  companyName: row.company_name,
  exchange: row.exchange,
  currency: row.currency,
  instrumentType: row.security_type,
  provider: row.provider,
  providerSymbol: row.provider_symbol,
  providerMetadataJson: row.provider_metadata_json,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class InstrumentRepository {
  constructor(private readonly db: D1Database) {}

  async insert(record: InstrumentRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO instruments
         (id, symbol, company_name, exchange, currency, instrument_type,
          security_type, provider, provider_symbol, provider_metadata_json,
          created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      )
      .bind(
        record.id,
        record.symbol,
        record.companyName,
        record.exchange,
        record.currency,
        record.instrumentType === "etf" ? "etf" : "stock",
        record.instrumentType,
        record.provider,
        record.providerSymbol,
        record.providerMetadataJson,
        record.createdAt,
        record.updatedAt,
      )
      .run();
  }

  async findById(id: string): Promise<InstrumentRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM instruments WHERE id = ?1")
      .bind(id)
      .first<InstrumentRow>();
    return row ? mapInstrument(row) : null;
  }

  async findBySymbol(symbol: string): Promise<InstrumentRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM instruments WHERE symbol = ?1")
      .bind(symbol)
      .first<InstrumentRow>();
    return row ? mapInstrument(row) : null;
  }

  /**
   * Materialize a normalized identity only when a ledger mutation needs it.
   * The legacy watchlist remains the source of display/provider metadata, while
   * the normalized symbol itself is the stable identity for this single-
   * provider application.
   */
  async ensureForSymbol(
    symbol: string,
    now: string,
  ): Promise<InstrumentRecord | null> {
    const normalized = symbol.trim().toUpperCase();
    if (!normalized) return null;

    const existing = await this.findBySymbol(normalized);
    if (existing) return existing;

    const ticker = await this.db
      .prepare(
        `SELECT id, symbol, company_name, exchange, currency, security_type,
                created_at, updated_at
           FROM tickers
          WHERE symbol = ?1`,
      )
      .bind(normalized)
      .first<TickerIdentityRow>();
    if (!ticker) return null;

    await this.db
      .prepare(
        `INSERT OR IGNORE INTO instruments
           (id, symbol, company_name, exchange, currency, instrument_type,
            security_type, provider, provider_symbol, provider_metadata_json,
            created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5,
                 CASE WHEN ?6 = 'etf' THEN 'etf' ELSE 'stock' END,
                 ?6, 'yahoo', ?2, NULL, ?7, ?7)`,
      )
      .bind(
        ticker.symbol,
        ticker.symbol,
        ticker.company_name,
        ticker.exchange,
        ticker.currency,
        ticker.security_type,
        now,
      )
      .run();

    return this.findBySymbol(normalized);
  }
}
