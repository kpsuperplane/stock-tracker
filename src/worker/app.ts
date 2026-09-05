import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ZodError } from "zod";
import { readPortfolioFeatureFlags } from "../config/features";
import { measuredD1ResourceUnits } from "../services/d1-usage";
import {
  cacheableReadModelFamily,
  ReadModelSnapshotStore,
  readModelFamilyFor,
} from "../services/read-model-cache";
import { ReadModelRefreshOutbox } from "../services/read-model-refresh";
import {
  RESOURCE_ENVELOPES,
  ResourceGovernor,
  type ResourceReservation,
} from "../services/resource-governor";
import type { ReadModelRefreshMessage } from "../shared/contracts";
import type { Env } from "./env";
import {
  ApiError,
  isStorageUnavailableError,
  safeErrorMessage,
} from "./errors";
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

  app.use("/api/*", async (context, next) => {
    if (context.req.method !== "GET") return next();
    const routeFamily = readModelFamilyFor(context.req.path);
    if (!routeFamily) return next();
    const family = cacheableReadModelFamily(context.req.raw);
    const flags = readPortfolioFeatureFlags(context.env ?? {});
    if (!flags.readModelCache) return next();
    if (!family) {
      const governor = new ResourceGovernor(context.env.DB);
      let reservation: ResourceReservation | null;
      try {
        reservation = await governor.reserve(
          `custom-read:${await new ReadModelSnapshotStore(
            context.env.DB,
            context.env.READ_MODEL_CACHE,
          ).keyFor(context.req.raw)}:${crypto.randomUUID()}`,
          RESOURCE_ENVELOPES.customReadModel,
        );
      } catch (error) {
        if (isStorageUnavailableError(error)) {
          throw new ApiError(
            503,
            "snapshot_unavailable",
            "This custom view is not cached while storage is unavailable.",
          );
        }
        throw error;
      }
      if (!reservation) {
        throw new ApiError(
          503,
          "snapshot_unavailable",
          "This custom view is not cached and its daily read capacity is exhausted.",
        );
      }
      try {
        await next();
        await governor.consume(
          reservation.id,
          measuredD1ResourceUnits(context.env.DB),
        );
        return context.res;
      } catch (error) {
        await governor.release(reservation.id).catch(() => false);
        if (isStorageUnavailableError(error)) {
          throw new ApiError(
            503,
            "snapshot_unavailable",
            "This custom view is not cached while storage is unavailable.",
          );
        }
        throw error;
      }
    }
    const store = new ReadModelSnapshotStore(
      context.env.DB,
      context.env.READ_MODEL_CACHE,
    );
    const cacheKey = await store.keyFor(context.req.raw);
    const previous = await store.read(cacheKey).catch(() => null);
    const requestUrl = `${context.req.path}${new URL(context.req.url).search}`;
    const internalRefresh =
      new URL(context.req.url).hostname === "read-model.internal" &&
      context.req.header("X-Read-Model-Refresh-Key") === cacheKey;
    if (!internalRefresh && previous && store.isFresh(previous)) {
      return store.toResponse(previous, { stale: false });
    }

    const refresh = async (): Promise<Response> => {
      const governor = new ResourceGovernor(context.env.DB);
      let reservation: ResourceReservation | null;
      try {
        reservation = await governor.reserve(
          `read-model:${cacheKey}:${crypto.randomUUID()}`,
          RESOURCE_ENVELOPES.readModelRefresh,
        );
      } catch (error) {
        if (!previous && isStorageUnavailableError(error)) {
          throw new ApiError(
            503,
            "snapshot_unavailable",
            "This view has no cached snapshot while storage is unavailable.",
          );
        }
        throw error;
      }
      if (!reservation) {
        if (previous) {
          return store.toResponse(previous, {
            stale: true,
            reason: "daily_budget",
          });
        }
        throw new ApiError(
          503,
          "snapshot_unavailable",
          "This view has no cached snapshot and its daily refresh capacity is exhausted.",
        );
      }
      try {
        await next();
        const response = context.res;
        if (!response.ok) {
          await governor.release(reservation.id);
          if (previous && response.status >= 500) {
            const fallback = store.toResponse(previous, {
              stale: true,
              reason: "storage_unavailable",
            });
            context.res = fallback;
            return fallback;
          }
          return response;
        }
        const snapshot = await store.publish({
          cacheKey,
          family,
          requestUrl,
          response,
          previous,
        });
        await governor.consume(
          reservation.id,
          measuredD1ResourceUnits(context.env.DB),
        );
        const result = snapshot
          ? store.toResponse(snapshot, { stale: false })
          : response;
        context.res = result;
        return result;
      } catch (error) {
        await governor.release(reservation.id).catch(() => false);
        if (previous && isStorageUnavailableError(error)) {
          const fallback = store.toResponse(previous, {
            stale: true,
            reason: "storage_unavailable",
          });
          context.res = fallback;
          return fallback;
        }
        throw error;
      }
    };

    if (!internalRefresh && previous) {
      context.executionCtx.waitUntil(
        new ReadModelRefreshOutbox(
          context.env.DB,
          context.env.SYNC_FOREGROUND_QUEUE as Queue<ReadModelRefreshMessage>,
        )
          .request(
            family,
            `stale:${previous.sourceRevision}:${previous.validUntil}`,
            cacheKey,
          )
          .then(() => undefined)
          .catch((error: unknown) => {
            console.warn(
              JSON.stringify({
                event: "read_model_background_refresh_failed",
                family,
                message: safeErrorMessage(error),
              }),
            );
          }),
      );
      return store.toResponse(previous, {
        stale: true,
        reason: "refresh_delayed",
      });
    }
    return refresh();
  });

  app.use("/api/*", async (context, next) => {
    await next();
    const flags = readPortfolioFeatureFlags(context.env ?? {});
    if (
      !flags.readModelPublish ||
      !["POST", "PATCH", "PUT", "DELETE"].includes(context.req.method) ||
      context.res.status >= 400
    ) {
      return;
    }
    const requestedRevision =
      context.res.headers.get("X-Position-Basis-Revision") ??
      context.res.headers.get("X-Account-Structure-Revision") ??
      new Date().toISOString();
    const outbox = new ReadModelRefreshOutbox(
      context.env.DB,
      context.env.SYNC_FOREGROUND_QUEUE as Queue<ReadModelRefreshMessage>,
    );
    context.executionCtx.waitUntil(
      outbox.request("all", requestedRevision).catch((error) => {
        console.warn(
          JSON.stringify({
            event: "read_model_refresh_enqueue_failed",
            message: safeErrorMessage(error),
          }),
        );
        return false;
      }),
    );
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
    if (isStorageUnavailableError(error)) {
      const reset = new Date();
      reset.setUTCHours(24, 0, 0, 0);
      context.header(
        "Retry-After",
        String(Math.max(1, Math.ceil((reset.getTime() - Date.now()) / 1_000))),
      );
      return context.json(
        {
          error: {
            code: "storage_unavailable",
            message:
              "Storage is temporarily unavailable. Try again after the daily reset.",
          },
          retryAt: reset.toISOString(),
        },
        503,
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
