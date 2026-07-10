import { RunRepository } from "../db/runs";
import { WorkersAiExplanationProvider } from "../providers/explanations";
import { GoogleNewsProvider } from "../providers/google-news";
import { MarketauxNewsProvider } from "../providers/marketaux";
import { YahooMarketDataProvider } from "../providers/yahoo";
import { ScreeningService } from "../services/screening";
import type { ScreeningJobMessage } from "../shared/contracts";
import type { Env } from "./env";
import { safeErrorMessage } from "./errors";
import { logEvent } from "./log";

const retryable = (error: unknown) =>
  error instanceof TypeError ||
  /http_(429|5\d\d)|\b429\b|\b5\d\d\b|timed?out|network|abort/i.test(
    String(error),
  );

export const handleQueue = async (
  batch: MessageBatch<ScreeningJobMessage>,
  env: Env,
) => {
  const repository = new RunRepository(env.DB);
  const news = env.MARKETAUX_API_TOKEN
    ? new MarketauxNewsProvider(env.MARKETAUX_API_TOKEN)
    : new GoogleNewsProvider();
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
            ? env.MARKETAUX_API_TOKEN
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
