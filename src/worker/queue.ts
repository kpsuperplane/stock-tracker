import { readPortfolioFeatureFlags } from "../config/features";
import { RunRepository } from "../db/runs";
import { WorkersAiExplanationProvider } from "../providers/explanations";
import { YahooMarketDataProvider } from "../providers/yahoo";
import { YahooCorporateActionProvider } from "../providers/yahoo-corporate-actions";
import { EventImportJobProcessor } from "../services/event-import-job";
import { LegacyDualWriteService } from "../services/legacy-dual-write";
import { PortfolioPipelineProcessor } from "../services/portfolio-pipeline-processor";
import { ScreeningService } from "../services/screening";
import {
  type DividendRefreshMessage,
  type ImportDispatchMessage,
  isDividendRefreshMessage,
  isImportDispatchMessage,
  isPipelineDispatchMessage,
  isPlanningContinuationMessage,
  isReadModelRefreshMessage,
  isScreeningJobMessage,
  isSyncSliceMessage,
  type PlanningContinuationMessage,
  type QueueMessage,
  type ReadModelRefreshMessage,
  type ScreeningJobMessage,
  type SyncSliceMessage,
} from "../shared/contracts";
import { consumeDividendRefresh } from "./dividends";
import type { Env } from "./env";
import { safeErrorMessage } from "./errors";
import { logEvent } from "./log";
import { handlePipelineQueue } from "./pipeline-queue";
import { continuePlanningFromQueue } from "./planning";
import { newsProviderFor } from "./provider-factories";
import { consumeReadModelRefresh } from "./read-model-refresh";
import { consumeSyncSlice, syncSchedulerFor } from "./sync";

const retryable = (error: unknown) =>
  error instanceof TypeError ||
  /http_(429|5\d\d)|\b429\b|\b5\d\d\b|timed?out|network|abort/i.test(
    String(error),
  );

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

const groupImportMessages = (
  messages: Message<QueueMessage>[],
): Map<string, Message<QueueMessage>[]> => {
  const grouped = new Map<string, Message<QueueMessage>[]>();
  for (const message of messages) {
    const importBatchId = (message.body as ImportDispatchMessage).importBatchId;
    const group = grouped.get(importBatchId) ?? [];
    group.push(message);
    grouped.set(importBatchId, group);
  }
  return grouped;
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
  const dividends = batch.messages.filter((message) =>
    isDividendRefreshMessage(message.body),
  );
  const planning = batch.messages.filter((message) =>
    isPlanningContinuationMessage(message.body),
  );
  const syncSlices = batch.messages.filter((message) =>
    isSyncSliceMessage(message.body),
  );
  const readModelRefreshes = batch.messages.filter((message) =>
    isReadModelRefreshMessage(message.body),
  );
  const unknown = batch.messages.filter(
    (message) =>
      !isScreeningJobMessage(message.body) &&
      !isPipelineDispatchMessage(message.body) &&
      !isImportDispatchMessage(message.body) &&
      !isDividendRefreshMessage(message.body) &&
      !isPlanningContinuationMessage(message.body) &&
      !isSyncSliceMessage(message.body) &&
      !isReadModelRefreshMessage(message.body),
  );
  unknown.forEach((message) => {
    message.ack();
  });
  const queueFlags = readPortfolioFeatureFlags(env);
  const normalizedEnabled = queueFlags.newWrites && queueFlags.legacySync;
  const compactEnabled =
    queueFlags.syncCurrent ||
    queueFlags.syncFuture ||
    queueFlags.syncRecent ||
    queueFlags.syncHistory;
  const importEnabled = queueFlags.legacySync || queueFlags.syncCurrent;
  const dividendEnabled =
    queueFlags.legacySync || queueFlags.syncCurrent || queueFlags.syncFuture;
  if (!normalizedEnabled) {
    // Queue delivery is not the source of truth.  A flag-off deployment
    // acknowledges an already-delivered normalized envelope and leaves its
    // dispatch batch/work rows in D1 for the gated dispatcher to recover.
    normalized.forEach((message) => {
      message.ack();
    });
    if (!compactEnabled) {
      planning.forEach((message) => {
        message.ack();
      });
    }
  }
  if (!importEnabled) {
    imports.forEach((message) => {
      message.ack();
    });
  }
  if (!dividendEnabled) {
    dividends.forEach((message) => {
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
            continuationQueue: env.NORMALIZED_WORK_QUEUE,
            processor: new PortfolioPipelineProcessor({
              db: env.DB,
              marketDataProvider: new YahooMarketDataProvider(),
              newsProvider: newsProviderFor(env),
              explanationProvider: new WorkersAiExplanationProvider(env.AI),
            }),
          },
        )
      : Promise.resolve(),
    imports.length > 0 && importEnabled
      ? Promise.all(
          [...groupImportMessages(imports).entries()].map(
            async ([importBatchId, messages]) => {
              try {
                await new EventImportJobProcessor({
                  db: env.DB,
                  queue: compactEnabled
                    ? env.SYNC_FOREGROUND_QUEUE
                    : env.NORMALIZED_WORK_QUEUE,
                  marketDataProvider: new YahooMarketDataProvider(),
                  corporateActionProvider: new YahooCorporateActionProvider(),
                }).process(importBatchId);
                messages.forEach((message) => {
                  message.ack();
                });
              } catch (error) {
                logEvent("portfolio_import_delivery_failed", {
                  importBatchId,
                  message: safeErrorMessage(error),
                });
                messages.forEach((message) => {
                  message.retry({ delaySeconds: 30 });
                });
              }
            },
          ),
        )
      : Promise.resolve(),
    dividends.length > 0 && dividendEnabled
      ? Promise.all(
          dividends.map(async (message) => {
            try {
              await consumeDividendRefresh(
                env,
                new Date(),
                message.body as DividendRefreshMessage,
              );
              message.ack();
            } catch (error) {
              logEvent("dividend_refresh_delivery_failed", {
                instrumentId: (message.body as DividendRefreshMessage)
                  .dividendRefreshInstrumentId,
                message: safeErrorMessage(error),
              });
              message.retry({ delaySeconds: 30 });
            }
          }),
        )
      : Promise.resolve(),
    planning.length > 0 && (normalizedEnabled || compactEnabled)
      ? Promise.all(
          planning.map(async (message) => {
            try {
              const flags = readPortfolioFeatureFlags(env);
              if (
                flags.syncCurrent ||
                flags.syncFuture ||
                flags.syncRecent ||
                flags.syncHistory
              ) {
                const scheduler = syncSchedulerFor(env);
                await scheduler.createForPipelineJob(
                  (message.body as PlanningContinuationMessage)
                    .planningPipelineJobId,
                );
                await scheduler.dispatch(2);
              } else {
                await continuePlanningFromQueue(
                  env,
                  message.body as PlanningContinuationMessage,
                );
              }
              message.ack();
            } catch (error) {
              logEvent("portfolio_planning_delivery_failed", {
                pipelineJobId: (message.body as PlanningContinuationMessage)
                  .planningPipelineJobId,
                message: safeErrorMessage(error),
              });
              message.retry({ delaySeconds: 30 });
            }
          }),
        )
      : Promise.resolve(),
    syncSlices.length > 0
      ? Promise.all(
          syncSlices.map(async (message) => {
            try {
              await consumeSyncSlice(env, message.body as SyncSliceMessage);
              message.ack();
            } catch (error) {
              logEvent("sync_slice_delivery_failed", {
                syncSliceId: (message.body as SyncSliceMessage).syncSliceId,
                message: safeErrorMessage(error),
              });
              message.retry({ delaySeconds: 30 });
            }
          }),
        )
      : Promise.resolve(),
    readModelRefreshes.length > 0
      ? Promise.all(
          readModelRefreshes.map(async (message) => {
            try {
              await consumeReadModelRefresh(
                env,
                message.body as ReadModelRefreshMessage,
              );
              message.ack();
            } catch (error) {
              logEvent("read_model_refresh_delivery_failed", {
                readModelRefreshId: (message.body as ReadModelRefreshMessage)
                  .readModelRefreshId,
                message: safeErrorMessage(error),
              });
              message.retry({ delaySeconds: 60 });
            }
          }),
        )
      : Promise.resolve(),
  ]);
};
