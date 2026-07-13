import { type Context, Hono } from "hono";
import { z } from "zod";
import { YahooCorporateActionProvider } from "../../providers/yahoo-corporate-actions";
import {
  EventImportsService,
  type ImportCommitResult,
  type ImportPreviewResult,
} from "../../services/event-imports";
import type { Env } from "../env";

type ImportContext = Context<{ Bindings: Env }>;

const APP_REQUEST_HEADER = "X-Stock-Tracker-Request";
const APP_REQUEST_VALUE = "1";

const commitSchema = z.object({}).strict();

const error = (
  context: ImportContext,
  status: 403 | 404 | 405 | 409 | 413 | 415 | 422 | 503,
  code: string,
  message: string,
  details?: Record<string, unknown>,
) => context.json({ error: { code, message }, ...details }, status);

const sameOriginAndAppRequest = (context: ImportContext): Response | null => {
  const origin = context.req.header("Origin");
  const host = context.req.header("Host");
  let requestUrl: URL;
  let originUrl: URL;
  try {
    requestUrl = new URL(context.req.url);
    originUrl = new URL(origin ?? "");
  } catch {
    return error(
      context,
      403,
      "csrf_rejected",
      "This mutation must come from the same origin.",
    );
  }
  if (
    !host ||
    /[\s,/@]/.test(host) ||
    !["http:", "https:"].includes(requestUrl.protocol) ||
    host.toLowerCase() !== requestUrl.host.toLowerCase() ||
    origin !== originUrl.origin ||
    originUrl.protocol !== requestUrl.protocol ||
    originUrl.host.toLowerCase() !== host.toLowerCase() ||
    context.req.header(APP_REQUEST_HEADER) !== APP_REQUEST_VALUE
  ) {
    return error(
      context,
      403,
      "csrf_rejected",
      "This mutation must come from the same origin.",
    );
  }
  return null;
};

const expectedRevision = (context: ImportContext): number | null => {
  const value = context.req.header("X-Position-Basis-Revision");
  return value &&
    /^(?:0|[1-9]\d*)$/.test(value) &&
    Number.isSafeInteger(Number(value))
    ? Number(value)
    : null;
};

const previewResponse = (
  context: ImportContext,
  result: ImportPreviewResult,
): Response => {
  if (result.kind === "invalid_file")
    return error(
      context,
      422,
      result.code,
      "The CSV file does not match the documented template.",
    );
  if (result.kind === "duplicate")
    return error(
      context,
      409,
      "duplicate_import",
      "This file was already imported.",
      {
        batchId: result.batchId,
        status: result.status,
      },
    );
  if (result.kind === "provider_unavailable")
    return error(
      context,
      503,
      result.code,
      "The split-history provider is unavailable. Try again later.",
    );
  if (result.kind === "conflict")
    return error(
      context,
      409,
      result.code,
      "The portfolio changed. Reload and try again.",
    );
  return context.json(result, 201);
};

const commitResponse = (
  context: ImportContext,
  result: ImportCommitResult,
): Response => {
  if (result.kind === "committed") {
    context.header("ETag", `"position-basis-${result.positionBasisRevision}"`);
    context.header(
      "X-Position-Basis-Revision",
      String(result.positionBasisRevision),
    );
    return context.json(result, 201);
  }
  if (result.kind === "provider_unavailable")
    return error(
      context,
      503,
      result.code,
      "The split-history provider is unavailable. Try again later.",
    );
  if (result.kind === "conflict")
    return error(
      context,
      409,
      result.code,
      "The portfolio changed. Reload and try again.",
    );
  if (result.kind === "expired")
    return error(
      context,
      409,
      "import_expired",
      "The import preview expired. Upload the file again.",
    );
  if (result.kind === "not_found")
    return error(
      context,
      404,
      "import_not_found",
      "The import preview does not exist.",
    );
  return error(context, 422, result.code, "The import cannot be committed.");
};

const preview = async (context: ImportContext) => {
  const rejected = sameOriginAndAppRequest(context);
  if (rejected) return rejected;
  const form = await context.req.formData();
  const file = form.get("file");
  if (!(file instanceof File) || form.getAll("file").length !== 1)
    return error(context, 422, "invalid_file", "Attach one CSV file.");
  if (
    file.type &&
    !["text/csv", "application/csv", "text/plain"].includes(
      file.type.toLowerCase(),
    )
  )
    return error(context, 415, "content_type", "Use a CSV file.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const result = await new EventImportsService({
    db: context.env.DB,
    corporateActionProvider: new YahooCorporateActionProvider(),
  }).preview({
    originalFilename: file.name,
    file: bytes,
  });
  return previewResponse(context, result);
};

const commit = async (context: ImportContext) => {
  const rejected = sameOriginAndAppRequest(context);
  if (rejected) return rejected;
  const revision = expectedRevision(context);
  if (revision === null)
    return error(
      context,
      422,
      "precondition_required",
      "Provide a valid portfolio revision.",
    );
  commitSchema.parse(await context.req.json());
  const batchId = context.req.param("id");
  if (!batchId)
    return error(context, 422, "invalid_request", "The request is invalid.");
  const result = await new EventImportsService({
    db: context.env.DB,
    corporateActionProvider: new YahooCorporateActionProvider(),
  }).commit({
    batchId,
    expectedPositionBasisRevision: revision,
  });
  return commitResponse(context, result);
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

eventImportRoutes.post("/preview", preview);
eventImportRoutes.all("/preview", methodNotAllowed("POST"));
eventImportRoutes.post("/:id/commit", commit);
eventImportRoutes.all("/:id/commit", methodNotAllowed("POST"));
eventImportRoutes.all("/*", methodNotAllowed("POST"));
