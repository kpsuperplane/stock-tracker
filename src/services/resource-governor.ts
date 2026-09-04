export type ResourceLane = "availability" | "foreground" | "history";
export type ResourceType =
  | "d1_rows_read"
  | "d1_rows_written"
  | "provider_call"
  | "queue_send"
  | "kv_write";

export interface ResourceUnits {
  resourceType: ResourceType;
  resourceKey?: string;
  units: number;
}

export interface ResourceReservation {
  id: string;
  deterministicKey: string;
  usageDate: string;
  lane: ResourceLane;
  operationType: string;
  state: "reserved" | "consumed" | "released";
}

export interface ResourceEnvelope {
  lane: ResourceLane;
  operationType: string;
  items: readonly ResourceUnits[];
}

interface BudgetDefinition {
  allocation: number;
  reservable: number;
}

const D1_BUDGETS: Readonly<Record<ResourceLane, BudgetDefinition>> = {
  availability: { allocation: 2_000_000, reservable: 1_000_000 },
  foreground: { allocation: 2_000_000, reservable: 2_000_000 },
  history: { allocation: 1_000_000, reservable: 1_000_000 },
};

const D1_WRITE_BUDGETS: Readonly<Record<ResourceLane, BudgetDefinition>> = {
  availability: { allocation: 40_000, reservable: 20_000 },
  foreground: { allocation: 40_000, reservable: 40_000 },
  history: { allocation: 20_000, reservable: 20_000 },
};

const providerBudget = (lane: ResourceLane, key: string): BudgetDefinition => {
  if (key === "alpha-dividend") return { allocation: 5, reservable: 5 };
  if (key === "alpha-earnings") return { allocation: 20, reservable: 20 };
  if (key === "yahoo-market") {
    const limit = lane === "history" ? 250 : 100;
    return { allocation: limit, reservable: limit };
  }
  if (key === "analysis") return { allocation: 250, reservable: 250 };
  return { allocation: 10_000, reservable: 10_000 };
};

const budgetFor = (
  lane: ResourceLane,
  resourceType: ResourceType,
  resourceKey: string,
): BudgetDefinition => {
  if (resourceType === "d1_rows_read") return D1_BUDGETS[lane];
  if (resourceType === "d1_rows_written") return D1_WRITE_BUDGETS[lane];
  if (resourceType === "provider_call") {
    return providerBudget(lane, resourceKey);
  }
  if (resourceType === "kv_write") {
    return lane === "availability"
      ? { allocation: 800, reservable: 800 }
      : { allocation: 0, reservable: 0 };
  }
  return { allocation: 10_000, reservable: 10_000 };
};

const validUnits = (units: number): number => {
  if (!Number.isSafeInteger(units) || units <= 0) {
    throw new Error("invalid_resource_units");
  }
  return units;
};

export const utcUsageDate = (date: Date): string =>
  date.toISOString().slice(0, 10);

export const nextUtcReset = (date: Date): string => {
  const reset = new Date(date);
  reset.setUTCHours(24, 0, 0, 0);
  return reset.toISOString();
};

export const RESOURCE_ENVELOPES = {
  readModelRefresh: {
    lane: "availability",
    operationType: "read_model_refresh",
    items: [
      { resourceType: "d1_rows_read", units: 100_000 },
      { resourceType: "d1_rows_written", units: 25 },
      { resourceType: "kv_write", units: 1 },
    ],
  },
  foregroundCurrentMarket: {
    lane: "foreground",
    operationType: "foreground_current_market_slice",
    items: [
      { resourceType: "d1_rows_read", units: 10_000 },
      // A current slice persists at most one market fact plus revision/index
      // bookkeeping. Keep substantial headroom over measured fixture usage
      // without reserving nearly the entire foreground lane for 72 holdings.
      { resourceType: "d1_rows_written", units: 250 },
      { resourceType: "provider_call", resourceKey: "yahoo-market", units: 1 },
      { resourceType: "queue_send", resourceKey: "foreground", units: 1 },
    ],
  },
  customReadModel: {
    lane: "availability",
    operationType: "custom_read_model",
    items: [
      { resourceType: "d1_rows_read", units: 100_000 },
      { resourceType: "d1_rows_written", units: 5 },
    ],
  },
  foregroundMarket: {
    lane: "foreground",
    operationType: "foreground_market_slice",
    items: [
      { resourceType: "d1_rows_read", units: 10_000 },
      { resourceType: "d1_rows_written", units: 3_000 },
      { resourceType: "provider_call", resourceKey: "yahoo-market", units: 1 },
      { resourceType: "queue_send", resourceKey: "foreground", units: 1 },
    ],
  },
  historyMarket: {
    lane: "history",
    operationType: "history_market_slice",
    items: [
      { resourceType: "d1_rows_read", units: 10_000 },
      { resourceType: "d1_rows_written", units: 3_000 },
      { resourceType: "provider_call", resourceKey: "yahoo-market", units: 1 },
      { resourceType: "queue_send", resourceKey: "history", units: 1 },
    ],
  },
  foregroundAnalysis: {
    lane: "foreground",
    operationType: "foreground_analysis_slice",
    items: [
      { resourceType: "d1_rows_read", units: 5_000 },
      { resourceType: "d1_rows_written", units: 1_000 },
      { resourceType: "provider_call", resourceKey: "analysis", units: 1 },
      { resourceType: "queue_send", resourceKey: "foreground", units: 1 },
    ],
  },
  foregroundDividend: {
    lane: "foreground",
    operationType: "foreground_dividend_refresh",
    items: [
      { resourceType: "d1_rows_read", units: 5_000 },
      { resourceType: "d1_rows_written", units: 400 },
      {
        resourceType: "provider_call",
        resourceKey: "yahoo-dividend",
        units: 1,
      },
      { resourceType: "queue_send", resourceKey: "foreground", units: 1 },
    ],
  },
  foregroundEarnings: {
    lane: "foreground",
    operationType: "foreground_earnings_calendar",
    items: [
      { resourceType: "d1_rows_read", units: 25_000 },
      { resourceType: "d1_rows_written", units: 5_000 },
      {
        resourceType: "provider_call",
        resourceKey: "alpha-earnings",
        units: 1,
      },
    ],
  },
  foregroundSplitRefresh: {
    lane: "foreground",
    operationType: "foreground_split_refresh",
    items: [
      { resourceType: "d1_rows_read", units: 100_000 },
      { resourceType: "d1_rows_written", units: 5_000 },
      { resourceType: "provider_call", resourceKey: "yahoo-splits", units: 20 },
    ],
  },
  foregroundCoverageMaintenance: {
    lane: "foreground",
    operationType: "foreground_coverage_maintenance",
    items: [
      { resourceType: "d1_rows_read", units: 10_000 },
      { resourceType: "d1_rows_written", units: 2_000 },
    ],
  },
  historyEarnings: {
    lane: "history",
    operationType: "history_earnings_batch",
    items: [
      { resourceType: "d1_rows_read", units: 100_000 },
      { resourceType: "d1_rows_written", units: 10_000 },
      { resourceType: "provider_call", resourceKey: "sec-earnings", units: 8 },
    ],
  },
  historyAnalysis: {
    lane: "history",
    operationType: "history_analysis_slice",
    items: [
      { resourceType: "d1_rows_read", units: 5_000 },
      { resourceType: "d1_rows_written", units: 1_000 },
      { resourceType: "provider_call", resourceKey: "analysis", units: 1 },
      { resourceType: "queue_send", resourceKey: "history", units: 1 },
    ],
  },
} as const satisfies Record<string, ResourceEnvelope>;

interface ReservationRow {
  id: string;
  deterministicKey: string;
  usageDate: string;
  lane: ResourceLane;
  operationType: string;
  state: ResourceReservation["state"];
}

const mapReservation = (row: ReservationRow): ResourceReservation => row;

export class ResourceGovernor {
  constructor(
    private readonly db: D1Database,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  async reserve(
    deterministicKey: string,
    envelope: ResourceEnvelope,
  ): Promise<ResourceReservation | null> {
    const existing = await this.find(deterministicKey);
    const timestamp = this.now().toISOString();
    if (existing?.state === "released") {
      try {
        const result = await this.db
          .prepare(
            `UPDATE resource_reservations
                SET state = 'reserved', released_at = NULL, updated_at = ?1
              WHERE id = ?2 AND state = 'released'`,
          )
          .bind(timestamp, existing.id)
          .run();
        return result.meta.changes === 1
          ? { ...existing, state: "reserved" }
          : this.find(deterministicKey);
      } catch (error) {
        if (/resource_budget_exhausted/i.test(String(error))) return null;
        throw error;
      }
    }
    if (existing) return existing;
    const usageDate = utcUsageDate(this.now());
    const id = this.newId();
    const baseline = envelope.items.map((item) => ({
      resourceType: item.resourceType,
      resourceKey: item.resourceKey ?? "",
      units: validUnits(item.units),
    }));
    const observedSince = new Date(
      this.now().getTime() - 7 * 24 * 60 * 60_000,
    ).toISOString();
    const observations = await this.db
      .prepare(
        `WITH ranked AS (
           SELECT resource_type AS resourceType, resource_key AS resourceKey,
                  actual_units AS actualUnits,
                  ROW_NUMBER() OVER (
                    PARTITION BY resource_type, resource_key
                    ORDER BY actual_units
                  ) AS rank,
                  COUNT(*) OVER (
                    PARTITION BY resource_type, resource_key
                  ) AS sampleCount
             FROM resource_operation_observations
            WHERE lane = ?1 AND operation_type = ?2 AND observed_at >= ?3
         )
         SELECT resourceType, resourceKey, actualUnits
           FROM ranked
          WHERE rank = CAST((sampleCount * 99 + 99) / 100 AS INTEGER)`,
      )
      .bind(envelope.lane, envelope.operationType, observedSince)
      .all<{
        resourceType: ResourceType;
        resourceKey: string;
        actualUnits: number;
      }>();
    const normalized = baseline.map((item) => {
      const observed = observations.results.find(
        (row) =>
          row.resourceType === item.resourceType &&
          row.resourceKey === item.resourceKey,
      );
      return {
        ...item,
        units: Math.max(
          item.units,
          observed ? Math.ceil(observed.actualUnits * 1.25) : 0,
        ),
      };
    });
    const budgetStatements = normalized.map((item) => {
      const budget = budgetFor(
        envelope.lane,
        item.resourceType,
        item.resourceKey,
      );
      return this.db
        .prepare(
          `INSERT OR IGNORE INTO resource_budget_days
           (usage_date, lane, resource_type, resource_key, allocation_units,
            reservable_units, reserved_units, actual_units, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 0, ?7)`,
        )
        .bind(
          usageDate,
          envelope.lane,
          item.resourceType,
          item.resourceKey,
          budget.allocation,
          budget.reservable,
          timestamp,
        );
    });
    try {
      await this.db.batch([
        ...budgetStatements,
        this.db
          .prepare(
            `INSERT INTO resource_reservations
             (id, deterministic_key, usage_date, lane, operation_type, state,
              created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'reserved', ?6, ?6)`,
          )
          .bind(
            id,
            deterministicKey,
            usageDate,
            envelope.lane,
            envelope.operationType,
            timestamp,
          ),
        ...normalized.map((item) =>
          this.db
            .prepare(
              `INSERT INTO resource_reservation_items
               (reservation_id, resource_type, resource_key, reserved_units)
               VALUES (?1, ?2, ?3, ?4)`,
            )
            .bind(id, item.resourceType, item.resourceKey, item.units),
        ),
      ]);
    } catch (error) {
      if (/resource_budget_exhausted/i.test(String(error))) return null;
      if (/UNIQUE constraint failed.*deterministic_key/i.test(String(error))) {
        const duplicate = await this.find(deterministicKey);
        return duplicate?.state === "released" ? null : duplicate;
      }
      throw error;
    }
    return {
      id,
      deterministicKey,
      usageDate,
      lane: envelope.lane,
      operationType: envelope.operationType,
      state: "reserved",
    };
  }

  async consume(
    reservationId: string,
    actual: readonly ResourceUnits[] = [],
  ): Promise<boolean> {
    const timestamp = this.now().toISOString();
    const row = await this.db
      .prepare(
        `SELECT usage_date AS usageDate, lane,
                operation_type AS operationType FROM resource_reservations
          WHERE id = ?1 AND state = 'reserved'`,
      )
      .bind(reservationId)
      .first<{
        usageDate: string;
        lane: ResourceLane;
        operationType: string;
      }>();
    if (!row) return false;
    // A reservation is an upper bound, not a measurement. Callers that can
    // observe D1/provider metadata pass it explicitly; callers that cannot do
    // so still consume the reservation without poisoning the adaptive p99.
    const normalized = actual
      .filter((item) => item.units >= 0)
      .map((item) => ({
        resourceType: item.resourceType,
        resourceKey: item.resourceKey ?? "",
        units: Math.floor(item.units),
      }));
    const statements: D1PreparedStatement[] = [];
    for (const item of normalized) {
      statements.push(
        this.db
          .prepare(
            `UPDATE resource_budget_days
                SET actual_units = actual_units + ?1, updated_at = ?2
              WHERE usage_date = ?3 AND lane = ?4
                AND resource_type = ?5 AND resource_key = ?6`,
          )
          .bind(
            item.units,
            timestamp,
            row.usageDate,
            row.lane,
            item.resourceType,
            item.resourceKey,
          ),
        this.db
          .prepare(
            `UPDATE resource_reservation_items SET actual_units = ?1
              WHERE reservation_id = ?2 AND resource_type = ?3
                AND resource_key = ?4`,
          )
          .bind(item.units, reservationId, item.resourceType, item.resourceKey),
        this.db
          .prepare(
            `INSERT INTO resource_operation_observations
             (id, usage_date, lane, operation_type, resource_type,
              resource_key, actual_units, observed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
          )
          .bind(
            crypto.randomUUID(),
            row.usageDate,
            row.lane,
            row.operationType,
            item.resourceType,
            item.resourceKey,
            item.units,
            timestamp,
          ),
      );
    }
    statements.push(
      this.db
        .prepare(
          `UPDATE resource_reservations
              SET state = 'consumed', consumed_at = ?1, updated_at = ?1
            WHERE id = ?2 AND state = 'reserved'`,
        )
        .bind(timestamp, reservationId),
    );
    const results = await this.db.batch(statements);
    return (results.at(-1)?.meta.changes ?? 0) === 1;
  }

  async release(reservationId: string): Promise<boolean> {
    const timestamp = this.now().toISOString();
    const result = await this.db
      .prepare(
        `UPDATE resource_reservations
            SET state = 'released', released_at = ?1, updated_at = ?1
          WHERE id = ?2 AND state = 'reserved'`,
      )
      .bind(timestamp, reservationId)
      .run();
    return result.meta.changes > 0;
  }

  async find(deterministicKey: string): Promise<ResourceReservation | null> {
    const row = await this.db
      .prepare(
        `SELECT id, deterministic_key AS deterministicKey,
                usage_date AS usageDate, lane,
                operation_type AS operationType, state
           FROM resource_reservations WHERE deterministic_key = ?1`,
      )
      .bind(deterministicKey)
      .first<ReservationRow>();
    return row ? mapReservation(row) : null;
  }
}

export const d1ActualUnits = (
  results: readonly D1Result<unknown>[],
): ResourceUnits[] => [
  {
    resourceType: "d1_rows_read",
    units: results.reduce((sum, result) => sum + result.meta.rows_read, 0),
  },
  {
    resourceType: "d1_rows_written",
    units: results.reduce((sum, result) => sum + result.meta.rows_written, 0),
  },
];

interface CapacityRow {
  lane: ResourceLane;
  resourceType: ResourceType;
  resourceKey: string;
  allocation: number;
  reservable: number;
  reserved: number;
  actual: number;
}

const capacityValue = (
  row: CapacityRow | undefined,
  fallback: BudgetDefinition,
): ResourceCapacityDto => {
  const allocation = row?.allocation ?? fallback.allocation;
  const reservable = row?.reservable ?? fallback.reservable;
  const reserved = row?.reserved ?? 0;
  return {
    allocation,
    reservable,
    reserved,
    actual: row?.actual ?? 0,
    remaining: Math.max(0, reservable - reserved),
  };
};

export const readSyncCapacity = async (
  db: D1Database,
  now: Date = new Date(),
): Promise<SyncCapacityDto> => {
  const usageDate = utcUsageDate(now);
  const [budgets, depths] = await Promise.all([
    db
      .prepare(
        `SELECT lane, resource_type AS resourceType,
                resource_key AS resourceKey, allocation_units AS allocation,
                reservable_units AS reservable,
                reserved_units AS reserved, actual_units AS actual
           FROM resource_budget_days
          WHERE usage_date = ?1`,
      )
      .bind(usageDate)
      .all<CapacityRow>(),
    db
      .prepare(
        `SELECT limits.lane, limits.high_water_mark AS highWaterMark,
                COUNT(slice.id) AS depth
           FROM sync_queue_limits limits
           LEFT JOIN sync_intents intent
             ON CASE WHEN intent.priority_class = 'history'
                     THEN 'history' ELSE 'foreground' END = limits.lane
           LEFT JOIN sync_slices slice ON slice.intent_id = intent.id
             AND slice.state IN ('dispatching', 'queued', 'processing')
          GROUP BY limits.lane, limits.high_water_mark`,
      )
      .all<{
        lane: "foreground" | "history";
        highWaterMark: number;
        depth: number;
      }>(),
  ]);
  const lane = (name: ResourceLane): SyncLaneCapacityDto => {
    const matching = budgets.results.filter((row) => row.lane === name);
    const depth = depths.results.find((row) => row.lane === name);
    const providerCalls = Object.fromEntries(
      matching
        .filter((row) => row.resourceType === "provider_call")
        .map((row) => [
          row.resourceKey,
          capacityValue(row, providerBudget(name, row.resourceKey)),
        ]),
    );
    const queueSends = matching.find(
      (row) => row.resourceType === "queue_send",
    );
    const kvWrites = matching.find((row) => row.resourceType === "kv_write");
    return {
      rowsRead: capacityValue(
        matching.find((row) => row.resourceType === "d1_rows_read"),
        D1_BUDGETS[name],
      ),
      rowsWritten: capacityValue(
        matching.find((row) => row.resourceType === "d1_rows_written"),
        D1_WRITE_BUDGETS[name],
      ),
      providerCalls,
      ...(queueSends
        ? {
            queueSends: capacityValue(
              queueSends,
              budgetFor(name, "queue_send", queueSends.resourceKey),
            ),
          }
        : {}),
      ...(kvWrites
        ? {
            kvWrites: capacityValue(
              kvWrites,
              budgetFor(name, "kv_write", kvWrites.resourceKey),
            ),
          }
        : {}),
      queueDepth: depth?.depth ?? 0,
      queueHighWaterMark: depth?.highWaterMark ?? null,
    };
  };
  return {
    usageDate,
    resetAt: nextUtcReset(now),
    lanes: {
      availability: lane("availability"),
      foreground: lane("foreground"),
      history: lane("history"),
    },
  };
};

import type {
  ResourceCapacityDto,
  SyncCapacityDto,
  SyncLaneCapacityDto,
} from "../shared/contracts";
