import type { DividendProvider } from "../providers/dividends";
import type { PrimaryFallbackDividendProvider } from "../providers/fallback-dividends";
import type { DividendRefreshMessage } from "../shared/contracts";
import { easternMarketDate } from "../shared/dates";
import { reconcileDividendCoverage } from "./event-coverage";
import { DividendFactsService } from "./fact-persistence";
import {
  nextUtcReset,
  RESOURCE_ENVELOPES,
  ResourceGovernor,
  type ResourceReservation,
} from "./resource-governor";

const LEASE_MS = 15 * 60_000;
const REFRESH_INTERVAL_MS = 5 * 86_400_000;
const RETRY_DELAYS_MS = [
  15 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000,
];

const addMilliseconds = (timestamp: string, milliseconds: number): string =>
  new Date(Date.parse(timestamp) + milliseconds).toISOString();

const addDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T12:00:00.000Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);

const permanentFailure = (code: string): boolean =>
  /provider_(?:invalid_range|symbol_mismatch|symbol_unavailable|currency_unavailable|unsupported_currency|invalid_amount|invalid_source_url|snapshot_mismatch|invalid_request|conflicting_revision)/.test(
    code,
  );

interface DueRow {
  instrumentId: string;
}

interface DividendDispatchClaim extends DueRow {
  dispatchToken: string;
}

interface ClaimedRow {
  instrumentId: string;
  providerSymbol: string;
  currency: "USD" | "CAD";
  requestedStartDate: string;
  attemptCount: number;
}

export interface DividendDispatchSummary {
  due: number;
  queued: number;
  sendFailures: number;
  recovered: number;
}

export class DividendRefreshDispatcher {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly dependencies: {
      db: D1Database;
      queue: Queue<DividendRefreshMessage>;
      now?: () => Date;
      newId?: () => string;
      limit?: number;
    },
  ) {
    this.now = dependencies.now ?? (() => new Date());
    this.newId = dependencies.newId ?? (() => crypto.randomUUID());
  }

  async dispatch(): Promise<DividendDispatchSummary> {
    const timestamp = this.now().toISOString();
    await reconcileDividendCoverage(this.dependencies.db, timestamp);
    const recovered = await this.dependencies.db
      .prepare(
        `UPDATE dividend_refresh_state
            SET status = 'retry', next_attempt_at = ?1, lease_until = NULL,
                dispatch_token = NULL, updated_at = ?1
          WHERE status IN ('dispatching', 'queued', 'in_progress')
            AND (lease_until IS NULL OR lease_until <= ?1)`,
      )
      .bind(timestamp)
      .run();
    const due = await this.dependencies.db
      .prepare(
        `SELECT instrument_id AS instrumentId
           FROM dividend_refresh_state
          WHERE status IN ('pending', 'retry', 'current')
            AND next_attempt_at <= ?1
          ORDER BY CASE status
                     WHEN 'retry' THEN 0
                     WHEN 'pending' THEN 1
                     ELSE 2
                   END,
                   next_attempt_at, updated_at, instrument_id
          LIMIT ?2`,
      )
      .bind(
        timestamp,
        Math.min(100, Math.max(1, this.dependencies.limit ?? 100)),
      )
      .all<DueRow>();
    if (due.results.length === 0) {
      return {
        due: 0,
        queued: 0,
        sendFailures: 0,
        recovered: Number(recovered.meta.changes ?? 0),
      };
    }

    const leaseUntil = addMilliseconds(timestamp, LEASE_MS);
    const governor = new ResourceGovernor(
      this.dependencies.db,
      this.now,
      this.newId,
    );
    const reservations = new Map<string, ResourceReservation>();
    const candidates: DividendDispatchClaim[] = [];
    for (const row of due.results) {
      const candidate = {
        instrumentId: row.instrumentId,
        dispatchToken: this.newId(),
      };
      const reservation = await governor.reserve(
        `dividend:${candidate.dispatchToken}`,
        RESOURCE_ENVELOPES.foregroundDividend,
      );
      if (!reservation) {
        await this.dependencies.db
          .prepare(
            `UPDATE dividend_refresh_state
                SET status = 'retry', next_attempt_at = ?1,
                    last_error_code = 'daily_budget',
                    last_error_message = 'Daily foreground capacity is exhausted.',
                    updated_at = ?2
              WHERE instrument_id = ?3
                AND status IN ('pending', 'retry', 'current')`,
          )
          .bind(nextUtcReset(this.now()), timestamp, row.instrumentId)
          .run();
        continue;
      }
      reservations.set(candidate.dispatchToken, reservation);
      candidates.push(candidate);
    }
    if (candidates.length === 0) {
      return {
        due: due.results.length,
        queued: 0,
        sendFailures: 0,
        recovered: Number(recovered.meta.changes ?? 0),
      };
    }
    const claimResults = await this.dependencies.db.batch(
      candidates.map((candidate) =>
        this.dependencies.db
          .prepare(
            `UPDATE dividend_refresh_state
                SET status = 'dispatching', lease_until = ?1,
                    dispatch_token = ?2, updated_at = ?3
              WHERE instrument_id = ?4
                AND status IN ('pending', 'retry', 'current')
                AND next_attempt_at <= ?3`,
          )
          .bind(
            leaseUntil,
            candidate.dispatchToken,
            timestamp,
            candidate.instrumentId,
          ),
      ),
    );
    const claimed = candidates.filter(
      (_candidate, index) => claimResults[index]?.meta.changes === 1,
    );
    for (const candidate of candidates) {
      if (!claimed.includes(candidate)) {
        const reservation = reservations.get(candidate.dispatchToken);
        if (reservation) await governor.release(reservation.id);
      }
    }
    if (claimed.length === 0) {
      return {
        due: due.results.length,
        queued: 0,
        sendFailures: 0,
        recovered: Number(recovered.meta.changes ?? 0),
      };
    }

    try {
      await this.dependencies.queue.sendBatch(
        claimed.map((candidate) => ({
          body: {
            dividendRefreshInstrumentId: candidate.instrumentId,
            dispatchToken: candidate.dispatchToken,
          },
          contentType: "json" as const,
        })),
      );
      await this.dependencies.db.batch(
        claimed.map((candidate) =>
          this.dependencies.db
            .prepare(
              `UPDATE dividend_refresh_state
                  SET status = 'queued', updated_at = ?1
                WHERE instrument_id = ?2 AND status = 'dispatching'
                  AND dispatch_token = ?3`,
            )
            .bind(timestamp, candidate.instrumentId, candidate.dispatchToken),
        ),
      );
    } catch {
      await this.dependencies.db.batch(
        claimed.map((candidate) =>
          this.dependencies.db
            .prepare(
              `UPDATE dividend_refresh_state
                  SET status = 'retry', next_attempt_at = ?1,
                      lease_until = NULL, dispatch_token = NULL,
                      last_error_code = 'queue_send_failed',
                      last_error_message = 'queue_send_failed', updated_at = ?1
                WHERE instrument_id = ?2 AND status = 'dispatching'
                  AND dispatch_token = ?3`,
            )
            .bind(timestamp, candidate.instrumentId, candidate.dispatchToken),
        ),
      );
      for (const candidate of claimed) {
        const reservation = reservations.get(candidate.dispatchToken);
        if (reservation) await governor.release(reservation.id);
      }
      return {
        due: due.results.length,
        queued: 0,
        sendFailures: claimed.length,
        recovered: Number(recovered.meta.changes ?? 0),
      };
    }
    return {
      due: due.results.length,
      queued: claimed.length,
      sendFailures: 0,
      recovered: Number(recovered.meta.changes ?? 0),
    };
  }
}

export class DividendRefreshConsumer {
  private readonly now: () => Date;

  constructor(
    private readonly dependencies: {
      db: D1Database;
      provider: PrimaryFallbackDividendProvider | DividendProvider;
      now?: () => Date;
      newId?: () => string;
    },
  ) {
    this.now = dependencies.now ?? (() => new Date());
  }

  async process(message: DividendRefreshMessage): Promise<void> {
    const timestamp = this.now().toISOString();
    const leaseUntil = addMilliseconds(timestamp, LEASE_MS);
    const claimed = await this.dependencies.db
      .prepare(
        `UPDATE dividend_refresh_state
            SET status = 'in_progress', lease_until = ?1,
                last_attempted_at = ?2, attempt_count = attempt_count + 1,
                updated_at = ?2
          WHERE instrument_id = ?3
            AND dispatch_token = ?4
            AND status IN ('dispatching', 'queued')
        RETURNING instrument_id AS instrumentId,
          (SELECT provider_symbol FROM instruments WHERE id = instrument_id)
            AS providerSymbol,
          (SELECT currency FROM instruments WHERE id = instrument_id) AS currency,
          requested_start_date AS requestedStartDate,
          attempt_count AS attemptCount`,
      )
      .bind(
        leaseUntil,
        timestamp,
        message.dividendRefreshInstrumentId,
        message.dispatchToken,
      )
      .first<ClaimedRow>();
    if (!claimed) return;

    const governor = new ResourceGovernor(this.dependencies.db, this.now);
    const reservation = await governor.find(
      `dividend:${message.dispatchToken}`,
    );
    if (reservation?.state === "reserved") {
      await governor.consume(reservation.id);
    }

    const service = new DividendFactsService({
      db: this.dependencies.db,
      provider: this.dependencies.provider,
      now: this.now,
      ...(this.dependencies.newId ? { newId: this.dependencies.newId } : {}),
    });
    const today = easternMarketDate(timestamp);
    const result = await service.refresh({
      instrumentId: claimed.instrumentId,
      symbol: claimed.providerSymbol,
      currency: claimed.currency,
      startDate: claimed.requestedStartDate,
      endDate: addDays(today, 370),
    });
    if (result.kind === "refreshed") {
      const selected =
        "lastProvider" in this.dependencies.provider
          ? this.dependencies.provider.lastProvider
          : "primary";
      const provider =
        selected === "fallback" ? "alpha-vantage-dividends" : "yahoo-dividends";
      if (provider === "yahoo-dividends") {
        await this.dependencies.db
          .prepare(
            `UPDATE dividend_events
                SET status = 'superseded', updated_at = ?1
              WHERE instrument_id = ?2
                AND provider = 'alpha-vantage-dividends'
                AND status = 'active'
                AND ex_date BETWEEN ?3 AND ?4`,
          )
          .bind(
            timestamp,
            claimed.instrumentId,
            claimed.requestedStartDate,
            addDays(today, 370),
          )
          .run();
      } else {
        await this.dependencies.db
          .prepare(
            `UPDATE dividend_events AS alpha
                SET status = 'superseded', updated_at = ?1
              WHERE alpha.instrument_id = ?2
                AND alpha.provider = 'alpha-vantage-dividends'
                AND alpha.status = 'active'
                AND EXISTS (
                  SELECT 1 FROM dividend_events yahoo
                   WHERE yahoo.instrument_id = alpha.instrument_id
                     AND yahoo.provider = 'yahoo-dividends'
                     AND yahoo.status = 'active'
                     AND yahoo.ex_date = alpha.ex_date
                )`,
          )
          .bind(timestamp, claimed.instrumentId)
          .run();
      }
      await this.dependencies.db
        .prepare(
          `UPDATE dividend_refresh_state
              SET status = 'current', attempt_count = 0,
                  next_attempt_at = ?1, lease_until = NULL,
                  dispatch_token = NULL, provider = ?2,
                  completed_at = ?3, last_error_code = NULL,
                  last_error_message = NULL, updated_at = ?3
            WHERE instrument_id = ?4 AND status = 'in_progress'
              AND dispatch_token = ?5`,
        )
        .bind(
          addMilliseconds(timestamp, REFRESH_INTERVAL_MS),
          provider,
          timestamp,
          claimed.instrumentId,
          message.dispatchToken,
        )
        .run();
      return;
    }

    const code = result.code;
    const blocked = permanentFailure(code);
    const delay =
      RETRY_DELAYS_MS[
        Math.min(claimed.attemptCount - 1, RETRY_DELAYS_MS.length - 1)
      ] ??
      RETRY_DELAYS_MS.at(-1) ??
      86_400_000;
    await this.dependencies.db
      .prepare(
        `UPDATE dividend_refresh_state
            SET status = ?1, next_attempt_at = ?2, lease_until = NULL,
                dispatch_token = NULL, last_error_code = ?3,
                last_error_message = ?3, updated_at = ?4
          WHERE instrument_id = ?5 AND status = 'in_progress'
            AND dispatch_token = ?6`,
      )
      .bind(
        blocked ? "blocked" : "retry",
        blocked ? timestamp : addMilliseconds(timestamp, delay),
        code,
        timestamp,
        claimed.instrumentId,
        message.dispatchToken,
      )
      .run();
  }
}
