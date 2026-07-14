import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ZodError } from "zod";
import type { Env } from "./env";
import { ApiError, safeErrorMessage } from "./errors";
import { accountRoutes } from "./routes/accounts";
import { backfillRoutes } from "./routes/backfills";
import { dividendRoutes } from "./routes/dividends";
import { earningsRoutes } from "./routes/earnings";
import { eventImportRoutes } from "./routes/event-imports";
import { eventsRoutes, ledgerReadRoutes } from "./routes/events";
import {
  calendarRoutes,
  jobRoutes,
  portfolioRoutes,
  statusRoutes,
} from "./routes/read-models";
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
  const importBodyLimit = bodyLimit({
    maxSize: 5 * 1024 * 1024 + 64 * 1024,
    onError: bodyTooLarge,
  });

  app.use("/api/*", (context, next) =>
    context.req.path === "/api/event-imports"
      ? importBodyLimit(context, next)
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
        context.req.path === "/api/event-imports" &&
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

  // Every browser-originating state change uses the same fail-closed guard,
  // including multipart imports. Route-level checks remain for the existing
  // Events/import contracts; this boundary covers legacy mutation routes too.
  app.use("/api/*", async (context, next) => {
    if (!["POST", "PATCH", "PUT", "DELETE"].includes(context.req.method)) {
      return next();
    }
    const origin = context.req.header("Origin");
    const host = context.req.header("Host");
    let requestUrl: URL;
    let originUrl: URL;
    try {
      requestUrl = new URL(context.req.url);
      originUrl = new URL(origin ?? "");
    } catch {
      return context.json(
        {
          error: {
            code: "csrf_rejected",
            message: "This mutation must come from the same origin.",
          },
        },
        403,
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
      context.req.header("X-Stock-Tracker-Request") !== "1"
    ) {
      return context.json(
        {
          error: {
            code: "csrf_rejected",
            message: "This mutation must come from the same origin.",
          },
        },
        403,
      );
    }
    return next();
  });

  app.get("/api/health", (context) => context.json({ ok: true }));
  app.route("/api/accounts", accountRoutes);
  app.route("/api/backfills", backfillRoutes);
  app.route("/api/dividends", dividendRoutes);
  app.route("/api/earnings", earningsRoutes);
  app.route("/api/events", eventsRoutes);
  app.route("/api/transactions", eventsRoutes);
  app.route("/data/ledger", ledgerReadRoutes);
  app.route("/api/event-imports", eventImportRoutes);
  app.route("/api/reports", reportRoutes);
  app.route("/api/portfolio", portfolioRoutes);
  app.route("/api/calendar", calendarRoutes);
  app.route("/api/status", statusRoutes);
  app.route("/api/jobs", jobRoutes);
  app.route("/api/pipeline-jobs", jobRoutes);
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
      JSON.stringify({
        event: "request_failed",
        code: "internal_error",
        message: safeErrorMessage(error),
      }),
    );
    return context.json(
      { error: { code: "internal_error", message: "The request failed." } },
      500,
    );
  });

  app.all("*", (context) => context.env.ASSETS.fetch(context.req.raw));
  return app;
};
