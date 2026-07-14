import { readPortfolioFeatureFlags } from "../config/features";
import { RunRepository } from "../db/runs";
import { ExaNewsProvider } from "../providers/exa";
import { WorkersAiExplanationProvider } from "../providers/explanations";
import { FallbackNewsProvider } from "../providers/fallback-news";
import { GoogleNewsProvider } from "../providers/google-news";
import { MarketauxNewsProvider } from "../providers/marketaux";
import { YahooMarketDataProvider } from "../providers/yahoo";
import { YahooCorporateActionProvider } from "../providers/yahoo-corporate-actions";
import { EventImportJobProcessor } from "../services/event-import-job";
import { LegacyDualWriteService } from "../services/legacy-dual-write";
import { PortfolioPipelineProcessor } from "../services/portfolio-pipeline-processor";
import { ScreeningService } from "../services/screening";
import {
  type ImportDispatchMessage,
  isImportDispatchMessage,
  isPipelineDispatchMessage,
  isScreeningJobMessage,
  type QueueMessage,
  type ScreeningJobMessage,
} from "../shared/contracts";
import type { Env } from "./env";
import { safeErrorMessage } from "./errors";
import { logEvent } from "./log";
import { handlePipelineQueue } from "./pipeline-queue";

const retryable = (error: unknown) =>
  error instanceof TypeError ||
  /http_(429|5\d\d)|\b429\b|\b5\d\d\b|timed?out|network|abort/i.test(
    String(error),
  );

const newsProviderFor = (env: Env) => {
  const exa = env.EXA_API_KEY ? new ExaNewsProvider(env.EXA_API_KEY) : null;
  const marketaux = env.MARKETAUX_API_TOKEN
    ? new MarketauxNewsProvider(env.MARKETAUX_API_TOKEN)
    : null;
  return exa && marketaux
    ? new FallbackNewsProvider(exa, marketaux)
    : (exa ?? marketaux ?? new GoogleNewsProvider());
};

export const handleLegacyQueue = async (
  batch: MessageBatch<ScreeningJobMessage>,
  env: Env,
) => {
  const dualWrite = new LegacyDualWriteService(env.DB, {
    enabled: readPortfolioFeatureFlags(env).dualWrite,
  });
  const repository = new RunRepository(env.DB, dualWrite);
  const news = newsProviderFor(env);
  const service = new ScreeningService(
    repository,
    new YahooMarketDataProvider(),
    news,
    new WorkersAiExplanationProvider(env.AI),
  );
  await Promise.all(
    batch.messages.map(async (message) => {
      const started = Date.now();
      try {
        const now = new Date().toISOString();
        const runId = await service.process(message.body.screeningId, now);
        if (runId) await repository.finalizeRun(runId, now);
        logEvent("screening_complete", {
          screeningId: message.body.screeningId,
          durationMs: Date.now() - started,
        });
        message.ack();
      } catch (error) {
        const text = String(error);
        const provider = text.includes("market_")
          ? "yahoo"
          : text.includes("news_")
            ? env.EXA_API_KEY
              ? env.MARKETAUX_API_TOKEN
                ? "exa/marketaux"
                : "exa"
              : env.MARKETAUX_API_TOKEN
                ? "marketaux"
                : "google-news"
            : "workers-ai";
        const row = await env.DB.prepare(
          "SELECT attempt_count AS attemptCount FROM screenings WHERE id = ?1",
        )
          .bind(message.body.screeningId)
          .first<{ attemptCount: number }>();
        if (retryable(error) && (row?.attemptCount ?? 0) < 3) {
          await env.DB.prepare(
            `UPDATE screenings SET status = 'queued', processing_started_at = NULL
               WHERE id = ?1 AND status = 'processing'`,
          )
            .bind(message.body.screeningId)
            .run();
          logEvent("screening_retry", {
            screeningId: message.body.screeningId,
            provider,
            attempt: row?.attemptCount ?? 1,
            durationMs: Date.now() - started,
          });
          message.retry({ delaySeconds: 30 * (row?.attemptCount ?? 1) });
        } else {
          await repository.markFailed(
            message.body.screeningId,
            "screening_failed",
            safeErrorMessage(error),
          );
          const runId = await repository.runIdForScreening(
            message.body.screeningId,
          );
          if (runId) {
            await repository.finalizeRun(runId, new Date().toISOString());
          }
          logEvent("screening_failed", {
            screeningId: message.body.screeningId,
            provider,
            attempt: row?.attemptCount ?? 0,
            durationMs: Date.now() - started,
          });
          message.ack();
        }
      }
    }),
  );
};

/**
 * Route both queue contracts through one Worker entrypoint.  The exact-shape
 * discriminants keep a malformed/new payload from reaching the legacy
 * screening service, while preserving the old behavior for legacy messages.
 */
export const handleQueue = async (
  batch: MessageBatch<QueueMessage>,
  env: Env,
) => {
  const legacy = batch.messages.filter((message) =>
    isScreeningJobMessage(message.body),
  );
  const normalized = batch.messages.filter((message) =>
    isPipelineDispatchMessage(message.body),
  );
  const imports = batch.messages.filter((message) =>
    isImportDispatchMessage(message.body),
  );
  const unknown = batch.messages.filter(
    (message) =>
      !isScreeningJobMessage(message.body) &&
      !isPipelineDispatchMessage(message.body) &&
      !isImportDispatchMessage(message.body),
  );
  unknown.forEach((message) => {
    message.ack();
  });
  const normalizedEnabled = readPortfolioFeatureFlags(env).newWrites;
  if (!normalizedEnabled) {
    // Queue delivery is not the source of truth.  A flag-off deployment
    // acknowledges an already-delivered normalized envelope and leaves its
    // dispatch batch/work rows in D1 for the gated dispatcher to recover.
    normalized.forEach((message) => {
      message.ack();
    });
  }
  await Promise.all([
    legacy.length > 0
      ? handleLegacyQueue(
          { ...batch, messages: legacy } as MessageBatch<ScreeningJobMessage>,
          env,
        )
      : Promise.resolve(),
    normalized.length > 0 && normalizedEnabled
      ? handlePipelineQueue(
          { ...batch, messages: normalized } as MessageBatch<
            import("../shared/contracts").PipelineDispatchMessage
          >,
          {
            db: env.DB,
            dlq: env.NORMALIZED_WORK_DLQ,
            processor: new PortfolioPipelineProcessor({
              db: env.DB,
              marketDataProvider: new YahooMarketDataProvider(),
              newsProvider: newsProviderFor(env),
              explanationProvider: new WorkersAiExplanationProvider(env.AI),
            }),
          },
        )
      : Promise.resolve(),
    imports.length > 0
      ? Promise.all(
          imports.map(async (message) => {
            try {
              await new EventImportJobProcessor({
                db: env.DB,
                queue: env.NORMALIZED_WORK_QUEUE,
                marketDataProvider: new YahooMarketDataProvider(),
                corporateActionProvider: new YahooCorporateActionProvider(),
              }).process((message.body as ImportDispatchMessage).importBatchId);
              message.ack();
            } catch (error) {
              logEvent("portfolio_import_delivery_failed", {
                importBatchId: (message.body as ImportDispatchMessage)
                  .importBatchId,
                message: safeErrorMessage(error),
              });
              message.retry({ delaySeconds: 30 });
            }
          }),
        )
      : Promise.resolve(),
  ]);
};
