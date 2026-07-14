import { type Context, Hono } from "hono";
import { z } from "zod";
import { EventImportIntakeService } from "../../services/event-import-intake";
import type { Env } from "../env";

type ImportContext = Context<{ Bindings: Env }>;

const error = (
  context: ImportContext,
  status: 404 | 405 | 415 | 422,
  code: string,
  message: string,
) => context.json({ error: { code, message } }, status);

const start = async (context: ImportContext) => {
  let form: FormData;
  try {
    form = await context.req.formData();
  } catch {
    return error(context, 422, "invalid_file", "Attach one readable CSV file.");
  }
  const file = form.get("file");
  if (!(file instanceof File) || form.getAll("file").length !== 1) {
    return error(context, 422, "invalid_file", "Attach one CSV file.");
  }
  if (
    file.type &&
    !["text/csv", "application/csv", "text/plain"].includes(
      file.type.toLowerCase(),
    )
  ) {
    return error(context, 415, "content_type", "Use a CSV file.");
  }
  const result = await new EventImportIntakeService({
    db: context.env.DB,
    queue: context.env.NORMALIZED_WORK_QUEUE,
  }).start({
    originalFilename: file.name,
    file: new Uint8Array(await file.arrayBuffer()),
  });
  if (result.kind === "invalid_file") {
    return error(
      context,
      422,
      result.code,
      "The CSV file does not match the documented template.",
    );
  }
  return context.json(
    { importId: result.importId, status: result.status },
    202,
  );
};

const errorsQuery = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

interface ErrorRow {
  sort_key: string;
  row_number: number | null;
  symbol: string;
  code: string;
  message: string | null;
  source: "row" | "provider";
}

const listErrors = async (context: ImportContext) => {
  const batchId = context.req.param("id");
  const batch = await context.env.DB.prepare(
    "SELECT id FROM import_batches WHERE id = ?1",
  )
    .bind(batchId)
    .first<{ id: string }>();
  if (!batch) {
    return error(
      context,
      404,
      "import_not_found",
      "The import does not exist.",
    );
  }
  const query = errorsQuery.parse(context.req.query());
  const result = await context.env.DB.prepare(
    `WITH errors AS (
         SELECT printf('r:%010d:%s', rows.row_number, validation.value) AS sort_key,
                rows.row_number, rows.symbol,
                CAST(validation.value AS TEXT) AS code,
                NULL AS message, 'row' AS source
           FROM import_rows rows
           JOIN json_each(rows.validation_errors_json) validation
          WHERE rows.import_batch_id = ?1 AND rows.status = 'invalid'
         UNION ALL
         SELECT 's:' || symbols.source_symbol || ':' || symbols.error_code,
                NULL, symbols.source_symbol, symbols.error_code,
                symbols.error_message, 'provider'
           FROM import_symbols symbols
          WHERE symbols.import_batch_id = ?1
            AND symbols.error_code IS NOT NULL
            AND symbols.state IN ('failed', 'terminal')
       )
       SELECT sort_key, row_number, symbol, code, message, source
         FROM errors WHERE sort_key > ?2
        ORDER BY sort_key LIMIT ?3`,
  )
    .bind(batchId, query.cursor ?? "", query.limit + 1)
    .all<ErrorRow>();
  const hasMore = result.results.length > query.limit;
  const page = result.results.slice(0, query.limit);
  return context.json({
    errors: page.map((row) => ({
      rowNumber: row.row_number,
      symbol: row.symbol,
      code: row.code,
      message: row.message,
      source: row.source,
    })),
    nextCursor: hasMore ? (page.at(-1)?.sort_key ?? null) : null,
  });
};

const methodNotAllowed = (allow: string) => (context: ImportContext) => {
  context.header("Allow", allow);
  return error(
    context,
    405,
    "method_not_allowed",
    "This import method is not supported.",
  );
};

export const eventImportRoutes = new Hono<{ Bindings: Env }>();

eventImportRoutes.post("/", start);
eventImportRoutes.get("/:id/errors", listErrors);
eventImportRoutes.all("/:id/errors", methodNotAllowed("GET"));
eventImportRoutes.all("/*", methodNotAllowed("POST"));
