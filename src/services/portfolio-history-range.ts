import type { PortfolioRangePreset } from "../shared/contracts";

export interface PortfolioHistoryRange {
  range: PortfolioRangePreset;
  startDate: string;
  endDate: string;
}

const addDays = (date: string, days: number): string => {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

const subtractCalendar = (
  date: string,
  input: { months?: number; years?: number },
): string => {
  const [yearText, monthText, dayText] = date.split("-");
  const year = Number(yearText) - (input.years ?? 0);
  const zeroBasedMonth = Number(monthText) - 1 - (input.months ?? 0);
  const first = new Date(Date.UTC(year, zeroBasedMonth, 1, 12));
  const lastDay = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0, 12),
  ).getUTCDate();
  first.setUTCDate(Math.min(Number(dayText), lastDay));
  return first.toISOString().slice(0, 10);
};

const latestCloseDates = async (
  db: D1Database,
  accountIds: readonly string[],
  asOfDate: string,
): Promise<string[]> => {
  const rows = await db
    .prepare(
      `SELECT DISTINCT f.trading_date
         FROM daily_market_facts f
        WHERE f.status = 'valid'
          AND f.trading_date <= ?2
          AND f.instrument_id IN (
            SELECT DISTINCT instrument_id FROM transactions
             WHERE account_id IN (SELECT value FROM json_each(?1))
          )
        ORDER BY f.trading_date DESC LIMIT 2`,
    )
    .bind(JSON.stringify(accountIds), asOfDate)
    .all<{ trading_date: string }>();
  return rows.results.map((row) => row.trading_date);
};

const earliestTransactionDate = async (
  db: D1Database,
  accountIds: readonly string[],
): Promise<string | null> =>
  (
    await db
      .prepare(
        `SELECT MIN(trade_date) AS trade_date FROM transactions
          WHERE account_id IN (SELECT value FROM json_each(?1))`,
      )
      .bind(JSON.stringify(accountIds))
      .first<{ trade_date: string | null }>()
  )?.trade_date ?? null;

export const resolvePortfolioHistoryRange = async (
  db: D1Database,
  input: {
    range: PortfolioRangePreset;
    asOfDate: string;
    accountIds: readonly string[];
    customStartDate?: string;
    customEndDate?: string;
  },
): Promise<PortfolioHistoryRange> => {
  if (input.range === "custom") {
    if (!input.customStartDate || !input.customEndDate) {
      throw new Error("custom portfolio history dates are required");
    }
    return {
      range: input.range,
      startDate: input.customStartDate,
      endDate: input.customEndDate,
    };
  }
  const closeDates = await latestCloseDates(
    db,
    input.accountIds,
    input.asOfDate,
  );
  const endDate = closeDates[0] ?? input.asOfDate;
  if (input.range === "today") {
    return {
      range: input.range,
      startDate: closeDates[1] ?? addDays(endDate, -1),
      endDate,
    };
  }
  if (input.range === "all") {
    return {
      range: input.range,
      startDate:
        (await earliestTransactionDate(db, input.accountIds)) ?? endDate,
      endDate,
    };
  }
  const startDate =
    input.range === "1w"
      ? addDays(endDate, -6)
      : input.range === "30d"
        ? addDays(endDate, -29)
        : input.range === "3m"
          ? subtractCalendar(endDate, { months: 3 })
          : input.range === "ytd"
            ? `${endDate.slice(0, 4)}-01-01`
            : subtractCalendar(endDate, { years: 1 });
  return { range: input.range, startDate, endDate };
};
