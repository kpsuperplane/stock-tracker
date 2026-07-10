import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ZodError } from "zod";
import { requireBasicAuth } from "./auth";
import type { Env } from "./env";
import { ApiError } from "./errors";
import { tickerRoutes } from "./routes/tickers";

export const createApp = () => {
  const app = new Hono<{ Bindings: Env }>();

  app.use("*", requireBasicAuth());
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (context) =>
        context.json(
          {
            error: {
              code: "body_too_large",
              message: "Request body is too large.",
            },
          },
          413,
        ),
    }),
  );
  app.use("/api/*", async (context, next) => {
    if (
      ["POST", "PATCH", "PUT"].includes(context.req.method) &&
      context.req.raw.body !== null &&
      !context.req.header("Content-Type")?.includes("application/json")
    ) {
      return context.json(
        { error: { code: "content_type", message: "Use application/json." } },
        415,
      );
    }
    await next();
  });

  app.get("/api/health", (context) => context.json({ ok: true }));
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
