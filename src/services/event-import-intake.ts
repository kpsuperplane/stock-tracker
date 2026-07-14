import { parseCsv } from "../shared/csv";
import { importChunks } from "./event-import-csv";

const HEADER = "trade_date,symbol,side,quantity,price,category,account";
export const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 10_000;
const STAGING_CHUNK_SIZE = 500;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export interface ImportDispatchQueue {
  send(message: { importBatchId: string }): Promise<unknown>;
}

export type StartImportResult =
  | { kind: "accepted"; importId: string; status: "pending" }
  | { kind: "invalid_file"; code: string };

interface EventImportIntakeDependencies {
  db: D1Database;
  queue: ImportDispatchQueue;
  now?: () => Date;
  newId?: () => string;
}

const digest = async (bytes: Uint8Array): Promise<string> => {
  const input = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(input).set(bytes);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", input))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
};

export class EventImportIntakeService {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly dependencies: EventImportIntakeDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.newId = dependencies.newId ?? (() => crypto.randomUUID());
  }

  async start(input: {
    originalFilename: string;
    file: Uint8Array;
  }): Promise<StartImportResult> {
    if (
      !/^[^/\\\0]{1,255}\.csv$/i.test(input.originalFilename) ||
      input.originalFilename.trim() !== input.originalFilename
    ) {
      return { kind: "invalid_file", code: "invalid_filename" };
    }
    if (
      input.file.byteLength === 0 ||
      input.file.byteLength > MAX_IMPORT_FILE_BYTES
    ) {
      return { kind: "invalid_file", code: "file_too_large" };
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(input.file);
    } catch {
      return { kind: "invalid_file", code: "invalid_utf8" };
    }
    const parsed = parseCsv(text.replace(/^\uFEFF/, ""));
    if (!parsed) return { kind: "invalid_file", code: "invalid_csv" };
    if (parsed[0]?.join(",") !== HEADER) {
      return { kind: "invalid_file", code: "invalid_header" };
    }
    const rows = parsed
      .slice(1)
      .filter((row) => row.some((cell) => cell.trim() !== ""));
    if (rows.length === 0) {
      return { kind: "invalid_file", code: "no_rows" };
    }
    if (rows.length > MAX_IMPORT_ROWS) {
      return { kind: "invalid_file", code: "too_many_rows" };
    }
    if (rows.some((row) => row.length !== 7)) {
      return { kind: "invalid_file", code: "column_count" };
    }

    const timestamp = this.now().toISOString();
    const expiresAt = new Date(
      this.now().valueOf() + RETENTION_MS,
    ).toISOString();
    const batchId = this.newId();
    const revision = await this.dependencies.db
      .prepare("SELECT revision FROM position_basis_state WHERE id = 1")
      .first<{ revision: number }>();
    if (!revision) throw new Error("position_basis_state_missing");

    const stagedRows = rows.map((values, index) => {
      const trimmed = values.map((value) => value.trim());
      const side = trimmed[2]?.toLowerCase();
      return {
        id: this.newId(),
        rowNumber: index + 2,
        symbol: (trimmed[1] ?? "").toUpperCase(),
        tradeDate: trimmed[0] || null,
        side: side === "buy" || side === "sell" ? side : null,
        quantityDecimal: trimmed[3] || null,
        priceDecimal: trimmed[4] || null,
        categoryName: trimmed[5] ?? "",
        accountName: trimmed[6] ?? "",
        sourceJson: JSON.stringify(values),
      };
    });
    const symbols = [
      ...new Set(stagedRows.map((row) => row.symbol).filter(Boolean)),
    ];
    const statements: D1PreparedStatement[] = [
      this.dependencies.db
        .prepare(
          `INSERT INTO import_batches
           (id, file_digest, original_filename, base_position_basis_revision,
            projected_holdings_json, status, result_pipeline_job_id, expires_at,
            committed_at, total_rows, total_symbols, processed_symbols,
            failed_rows, available_at, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, NULL, 'pending', NULL, ?5, NULL,
                   ?6, ?7, 0, 0, ?8, ?8, ?8)`,
        )
        .bind(
          batchId,
          await digest(input.file),
          input.originalFilename,
          revision.revision,
          expiresAt,
          stagedRows.length,
          symbols.length,
          timestamp,
        ),
    ];
    for (const chunk of importChunks(stagedRows, STAGING_CHUNK_SIZE)) {
      statements.push(
        this.dependencies.db
          .prepare(
            `INSERT INTO import_rows
             (id, import_batch_id, row_number, symbol, trade_date, side,
              quantity_decimal, price_decimal, account_id, category_name,
              account_name, status, validation_errors_json,
              normalized_transaction_json, source_json)
             SELECT json_extract(value, '$.id'), ?1,
                    json_extract(value, '$.rowNumber'),
                    json_extract(value, '$.symbol'),
                    json_extract(value, '$.tradeDate'),
                    json_extract(value, '$.side'),
                    json_extract(value, '$.quantityDecimal'),
                    json_extract(value, '$.priceDecimal'), NULL,
                    json_extract(value, '$.categoryName'),
                    json_extract(value, '$.accountName'), 'pending', NULL, NULL,
                    json_extract(value, '$.sourceJson')
               FROM json_each(?2)`,
          )
          .bind(batchId, JSON.stringify(chunk)),
      );
    }
    for (const chunk of importChunks(symbols, STAGING_CHUNK_SIZE)) {
      statements.push(
        this.dependencies.db
          .prepare(
            `INSERT INTO import_symbols
             (id, import_batch_id, source_symbol, state, attempt_count,
              created_at, updated_at)
             SELECT ?1 || ':' || value, ?1, value, 'pending', 0,
                    ?3, ?3 FROM json_each(?2)`,
          )
          .bind(batchId, JSON.stringify(chunk), timestamp),
      );
    }
    await this.dependencies.db.batch(statements);

    // D1 is the source of truth. A send failure leaves the pending batch for
    // the 15-minute recovery scheduler instead of failing an accepted upload.
    try {
      await this.dependencies.queue.send({ importBatchId: batchId });
    } catch {
      // Recovery intentionally owns this path.
    }
    return { kind: "accepted", importId: batchId, status: "pending" };
  }
}
