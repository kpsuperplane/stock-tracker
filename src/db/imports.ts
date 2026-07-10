export type ImportBatchStatus =
  | "preview"
  | "committed"
  | "expired"
  | "rejected";
export type ImportRowStatus = "valid" | "invalid";

export interface ImportBatchRecord {
  id: string;
  fileDigest: string;
  originalFilename: string;
  basePositionBasisRevision: number;
  projectedHoldingsJson: string | null;
  status: ImportBatchStatus;
  resultPipelineJobId: string | null;
  expiresAt: string;
  committedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ImportRowRecord {
  id: string;
  importBatchId: string;
  rowNumber: number;
  symbol: string;
  tradeDate: string | null;
  side: "buy" | "sell" | null;
  quantityDecimal: string | null;
  priceDecimal: string | null;
  status: ImportRowStatus;
  validationErrorsJson: string | null;
  normalizedTransactionJson: string | null;
}

export class ImportRepository {
  constructor(private readonly db: D1Database) {}

  createBatchStatement(batch: ImportBatchRecord): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO import_batches
         (id, file_digest, original_filename, base_position_basis_revision,
          projected_holdings_json, status, result_pipeline_job_id, expires_at,
          committed_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      )
      .bind(
        batch.id,
        batch.fileDigest,
        batch.originalFilename,
        batch.basePositionBasisRevision,
        batch.projectedHoldingsJson,
        batch.status,
        batch.resultPipelineJobId,
        batch.expiresAt,
        batch.committedAt,
        batch.createdAt,
        batch.updatedAt,
      );
  }

  createRowStatement(row: ImportRowRecord): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO import_rows
         (id, import_batch_id, row_number, symbol, trade_date, side,
          quantity_decimal, price_decimal, status, validation_errors_json,
          normalized_transaction_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      )
      .bind(
        row.id,
        row.importBatchId,
        row.rowNumber,
        row.symbol,
        row.tradeDate,
        row.side,
        row.quantityDecimal,
        row.priceDecimal,
        row.status,
        row.validationErrorsJson,
        row.normalizedTransactionJson,
      );
  }

  async findBatchByDigest(
    digest: string,
  ): Promise<{ id: string; status: ImportBatchStatus } | null> {
    return this.db
      .prepare("SELECT id, status FROM import_batches WHERE file_digest = ?1")
      .bind(digest)
      .first<{ id: string; status: ImportBatchStatus }>();
  }
}
