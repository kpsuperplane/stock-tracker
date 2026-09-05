import type { ResourceUnits } from "./resource-governor";

const meters = new WeakMap<object, D1UsageMeter>();

export interface D1UsageSnapshot {
  rowsRead: number;
  rowsWritten: number;
}

const addResultUsage = (usage: D1UsageSnapshot, result: unknown): void => {
  if (!result || typeof result !== "object" || !("meta" in result)) return;
  const meta = (result as { meta?: D1Result["meta"] }).meta;
  usage.rowsRead += meta?.rows_read ?? 0;
  usage.rowsWritten += meta?.rows_written ?? 0;
};

const meteredStatement = (
  statement: D1PreparedStatement,
  usage: D1UsageSnapshot,
): D1PreparedStatement =>
  new Proxy(statement, {
    get(source, property, receiver) {
      if (property === "bind") {
        return (...values: unknown[]) =>
          meteredStatement(source.bind(...values), usage);
      }
      if (property === "first") {
        // D1's first() API discards query metadata. Execute the same statement
        // through all() so quota accounting still sees rows_read/rows_written.
        return async (columnName?: string) => {
          const result = await source.all<Record<string, unknown>>();
          addResultUsage(usage, result);
          const first = result.results[0];
          return columnName && first
            ? (first[columnName] ?? null)
            : (first ?? null);
        };
      }
      if (property === "all" || property === "run") {
        return async (...values: unknown[]) => {
          const method = Reflect.get(source, property) as (
            ...args: unknown[]
          ) => Promise<unknown>;
          const result = await Reflect.apply(method, source, values);
          addResultUsage(usage, result);
          return result;
        };
      }
      const value = Reflect.get(source, property, receiver);
      return typeof value === "function" ? value.bind(source) : value;
    },
  });

export class D1UsageMeter {
  private readonly usage: D1UsageSnapshot = { rowsRead: 0, rowsWritten: 0 };
  readonly db: D1Database;

  constructor(database: D1Database) {
    this.db = new Proxy(database, {
      get: (source, property, receiver) => {
        if (property === "prepare") {
          return (query: string) =>
            meteredStatement(source.prepare(query), this.usage);
        }
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            const results = await source.batch(statements);
            for (const result of results) addResultUsage(this.usage, result);
            return results;
          };
        }
        const value = Reflect.get(source, property, receiver);
        return typeof value === "function" ? value.bind(source) : value;
      },
    });
    meters.set(this.db, this);
  }

  snapshot(): D1UsageSnapshot {
    return { ...this.usage };
  }

  resourceUnits(): ResourceUnits[] {
    return [
      { resourceType: "d1_rows_read", units: this.usage.rowsRead },
      { resourceType: "d1_rows_written", units: this.usage.rowsWritten },
    ];
  }
}

export const measuredD1ResourceUnits = (
  database: D1Database,
): ResourceUnits[] => meters.get(database)?.resourceUnits() ?? [];
