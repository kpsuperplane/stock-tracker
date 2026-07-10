import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ZodError } from "zod";
import { requireBasicAuth } from "./auth";
import type { Env } from "./env";
import { ApiError } from "./errors";
import { backfillRoutes } from "./routes/backfills";
import { eventImportRoutes } from "./routes/event-imports";
import { corporateActionRoutes, eventsRoutes } from "./routes/events";
import { reportRoutes } from "./routes/reports";
import { retryRoutes } from "./routes/retries";
import { tickerRoutes } from "./routes/tickers";

export const createApp = () => {
  const app = new Hono<{ Bindings: Env }>();
  const bodyTooLarge = (context: Parameters<ReturnType<typeof bodyLimit>>[0]) =>
    context.json(
      {
        error: {
          code: "body_too_large",
          message: "Request body is too large.",
        },
      },
      413,
    );
  const normalBodyLimit = bodyLimit({
    maxSize: 64 * 1024,
    onError: bodyTooLarge,
  });
  const importPreviewBodyLimit = bodyLimit({
    maxSize: 5 * 1024 * 1024 + 64 * 1024,
    onError: bodyTooLarge,
  });

  app.use("*", requireBasicAuth());
  app.use("/api/*", (context, next) =>
    context.req.path === "/api/event-imports/preview"
      ? importPreviewBodyLimit(context, next)
      : normalBodyLimit(context, next),
  );
  app.use("/api/*", async (context, next) => {
    const contentType = context.req.header("Content-Type");
    const mimeType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
    if (
      ["POST", "PATCH", "PUT"].includes(context.req.method) &&
      context.req.raw.body !== null &&
      mimeType !== "application/json" &&
      !(
        context.req.path === "/api/event-imports/preview" &&
        mimeType === "multipart/form-data"
      )
    ) {
      return context.json(
        { error: { code: "content_type", message: "Use application/json." } },
        415,
      );
    }
    await next();
  });

  app.get("/api/health", (context) => context.json({ ok: true }));
  app.route("/api/backfills", backfillRoutes);
  app.route("/api/corporate-actions", corporateActionRoutes);
  app.route("/api/events", eventsRoutes);
  app.route("/api/event-imports", eventImportRoutes);
  app.route("/api/reports", reportRoutes);
  app.route("/api/screenings", retryRoutes);
  app.route("/api/tickers", tickerRoutes);

  app.onError((error, context) => {
    if (error instanceof ApiError) {
      return context.json(
        { error: { code: error.code, message: error.message } },
        error.status,
      );
    }
    if (error instanceof ZodError) {
      return context.json(
        {
          error: {
            code: "invalid_request",
            message: "The request is invalid.",
          },
        },
        422,
      );
    }
    console.error(
      JSON.stringify({ event: "request_failed", message: String(error) }),
    );
    return context.json(
      { error: { code: "internal_error", message: "The request failed." } },
      500,
    );
  });

  app.all("*", (context) => context.env.ASSETS.fetch(context.req.raw));
  return app;
};
