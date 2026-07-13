import { RationalValue } from "../domain/decimal";
import { isMarketTradingDayForExchange } from "../domain/market-calendar";
import {
  PortfolioAccountingEngine,
  type PortfolioAccountingPosition,
} from "../domain/portfolio-accounting";
import type {
  PortfolioConflictDto,
  PortfolioHistoryCoverageDto,
  PortfolioHistoryCurrencyDto,
  PortfolioHistoryPointDto,
  PortfolioHistoryPositionDto,
  PortfolioHistoryReadModelDto,
  PortfolioMetric,
  PortfolioRangePreset,
  ReadModelLocale,
} from "../shared/contracts";

interface TransactionRow {
  id: string;
  account_id: string;
  instrument_id: string;
  trade_date: string;
  side: "buy" | "sell";
  quantity_decimal: string;
  price_decimal: string;
}

interface InstrumentRow {
  id: string;
  symbol: string;
  company_name: string;
  exchange: string;
  currency: "CAD" | "USD";
}

interface SplitRow {
  id: string;
  instrument_id: string;
  effective_date: string;
  split_numerator: string;
  split_denominator: string;
  status: "candidate" | "active" | "superseded" | "quarantined";
  conflict_code: string | null;
  conflict_message: string | null;
}

interface DividendRow {
  id: string;
  instrument_id: string;
  ex_date: string;
  amount_per_share_decimal: string;
  status: "active" | "superseded" | "stale" | "error";
  error_code: string | null;
  error_message: string | null;
}

interface DividendRefreshRow {
  instrument_id: string;
  status: string;
  last_error_message: string | null;
}

interface FactRow {
  instrument_id: string;
  trading_date: string;
  current_raw_close_decimal: string;
  status: "valid" | "stale" | "error";
}

export interface PortfolioHistoryReadModelInput {
  range: PortfolioRangePreset;
  startDate: string;
  endDate: string;
  locale: ReadModelLocale;
  accountIds: readonly string[];
}

interface PriceState {
  value: RationalValue;
  date: string;
  estimated: boolean;
}

interface PointWithPositions {
  point: PortfolioHistoryPointDto;
  positions: PortfolioAccountingPosition[];
  prices: Map<string, PriceState>;
}

const MAX_POINTS = 600;
const MAX_COVERAGE_DETAILS = 50;

const daysBetween = (startDate: string, endDate: string): number =>
  Math.floor(
    (Date.parse(`${endDate}T12:00:00Z`) -
      Date.parse(`${startDate}T12:00:00Z`)) /
      86_400_000,
  );

const addDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);

const sum = (values: readonly RationalValue[]): RationalValue =>
  values.reduce((total, value) => total.add(value), RationalValue.zero());

const safeRational = (value: string): RationalValue | null => {
  try {
    return RationalValue.fromDecimal(value);
  } catch {
    return null;
  }
};

const safePositiveRational = (value: string): RationalValue | null => {
  const parsed = safeRational(value);
  return parsed?.isPositive() ? parsed : null;
};

const granularityFor = (
  startDate: string,
  endDate: string,
): "daily" | "weekly" | "monthly" => {
  const days = daysBetween(startDate, endDate);
  return days <= 366 ? "daily" : days <= 366 * 5 ? "weekly" : "monthly";
};

const valuationDates = (
  startDate: string,
  endDate: string,
  granularity: "daily" | "weekly" | "monthly",
  eventDates: readonly string[],
): string[] => {
  const dates = new Set<string>([startDate, endDate]);
  if (granularity === "daily") {
    for (let date = startDate; date <= endDate; date = addDays(date, 1))
      dates.add(date);
  } else if (granularity === "weekly") {
    for (let date = startDate; date <= endDate; date = addDays(date, 7))
      dates.add(date);
  } else {
    let cursor = startDate;
    while (cursor <= endDate) {
      dates.add(cursor);
      const year = Number(cursor.slice(0, 4));
      const month = Number(cursor.slice(5, 7));
      cursor = new Date(Date.UTC(year, month, 1, 12))
        .toISOString()
        .slice(0, 10);
    }
  }
  for (const date of eventDates) {
    if (date >= startDate && date <= endDate) dates.add(date);
  }
  const sorted = [...dates].sort();
  if (sorted.length <= MAX_POINTS) return sorted;
  const first = sorted[0];
  const last = sorted.at(-1);
  if (!first || !last) return [];
  const selected = new Set(
    [first, last, ...eventDates].filter(
      (date) => date >= startDate && date <= endDate,
    ),
  );
  const candidates = sorted.filter((date) => !selected.has(date));
  const slots = Math.max(0, MAX_POINTS - selected.size);
  if (slots > 0) {
    const stride = candidates.length / slots;
    for (let index = 0; index < slots; index += 1) {
      const candidate = candidates[Math.floor(index * stride)];
      if (candidate) selected.add(candidate);
    }
  }
  const sampled = [...selected].sort();
  if (sampled.length <= MAX_POINTS) return sampled;
  return sampled.slice(0, MAX_POINTS - 1).concat(last);
};

const marketFactDates = (
  dates: readonly string[],
  instruments: readonly InstrumentRow[],
): string[] => {
  const requested = new Set<string>();
  for (const date of dates) {
    for (const instrument of instruments) {
      let factDate = date;
      while (!isMarketTradingDayForExchange(factDate, instrument.exchange))
        factDate = addDays(factDate, -1);
      requested.add(factDate);
    }
  }
  return [...requested].sort();
};

const metricValue = (
  point: PortfolioHistoryPointDto,
  metric: PortfolioMetric,
): string | null =>
  metric === "totalValue"
    ? point.totalValueDecimal
    : metric === "bookValue"
      ? point.bookValueDecimal
      : metric === "realizedGains"
        ? point.realizedGainsDecimal
        : metric === "unrealizedGains"
          ? point.unrealizedGainsDecimal
          : point.dividendsDecimal;

const delta = (end: string | null, start: string | null): string | null => {
  if (end === null || start === null) return null;
  return RationalValue.fromDecimal(end)
    .subtract(RationalValue.fromDecimal(start))
    .toString();
};

const sortPositions = (
  left: PortfolioHistoryPositionDto,
  right: PortfolioHistoryPositionDto,
): number => {
  if (left.marketValueDecimal === null) return 1;
  if (right.marketValueDecimal === null) return -1;
  const comparison = RationalValue.fromDecimal(
    right.marketValueDecimal,
  ).compare(RationalValue.fromDecimal(left.marketValueDecimal));
  return comparison !== 0
    ? comparison
    : left.symbol.localeCompare(right.symbol);
};

export class PortfolioHistoryReadModelService {
  constructor(private readonly db: D1Database) {}

  async read(
    input: PortfolioHistoryReadModelInput,
  ): Promise<PortfolioHistoryReadModelDto> {
    const transactions = await this.transactions(input);
    const instrumentIds = [
      ...new Set(transactions.map((row) => row.instrument_id)),
    ];
    if (instrumentIds.length === 0) {
      return {
        range: input.range,
        startDate: input.startDate,
        endDate: input.endDate,
        dataThrough: null,
        locale: input.locale,
        currencies: [],
      };
    }
    const [instruments, splits, dividends, refresh] = await Promise.all([
      this.instruments(instrumentIds),
      this.splits(instrumentIds, input.endDate),
      this.dividends(instrumentIds, input.endDate),
      this.dividendRefresh(instrumentIds),
    ]);
    const instrumentById = new Map(instruments.map((row) => [row.id, row]));
    const validDividends = dividends.filter(
      (row) =>
        row.status === "active" &&
        safePositiveRational(row.amount_per_share_decimal),
    );
    const accountingInput = {
      instruments: instruments.map((row) => ({
        id: row.id,
        symbol: row.symbol,
        companyName: row.company_name,
        exchange: row.exchange,
        currency: row.currency,
      })),
      transactions: transactions.map((row) => ({
        id: row.id,
        accountId: row.account_id,
        instrumentId: row.instrument_id,
        tradeDate: row.trade_date,
        side: row.side,
        quantityDecimal: row.quantity_decimal,
        priceDecimal: row.price_decimal,
      })),
      splits: splits
        .filter((row) => row.status === "active")
        .map((row) => ({
          id: row.id,
          instrumentId: row.instrument_id,
          effectiveDate: row.effective_date,
          numerator: row.split_numerator,
          denominator: row.split_denominator,
        })),
      dividends: validDividends.map((row) => ({
        id: row.id,
        instrumentId: row.instrument_id,
        exDate: row.ex_date,
        amountPerShareDecimal: row.amount_per_share_decimal,
      })),
    };
    const firstBuyPrice = this.firstBuyPrices(transactions);
    const granularity = granularityFor(input.startDate, input.endDate);
    const dates = valuationDates(input.startDate, input.endDate, granularity, [
      ...transactions.map((row) => row.trade_date),
      ...validDividends.map((row) => row.ex_date),
    ]);
    const facts = await this.facts(
      instrumentIds,
      marketFactDates(dates, instruments),
      input.startDate,
      transactions.some((row) => row.trade_date < input.startDate),
    );
    const factsByDate = new Map<string, FactRow[]>();
    for (const fact of facts) {
      const rows = factsByDate.get(fact.trading_date) ?? [];
      rows.push(fact);
      factsByDate.set(fact.trading_date, rows);
    }
    const dataThrough =
      facts
        .filter((fact) => fact.status === "valid")
        .map((fact) => fact.trading_date)
        .filter((date) => date <= input.endDate)
        .sort()
        .at(-1) ?? null;
    const currencyResults = (["CAD", "USD"] as const)
      .filter((currency) =>
        instruments.some((instrument) => instrument.currency === currency),
      )
      .map((currency) =>
        this.buildCurrency({
          currency,
          engine: new PortfolioAccountingEngine(accountingInput),
          dates,
          facts,
          factsByDate,
          firstBuyPrice,
          instrumentById,
          splits,
          dividends,
          refresh,
          granularity,
        }),
      );
    return {
      range: input.range,
      startDate: input.startDate,
      endDate: input.endDate,
      dataThrough,
      locale: input.locale,
      currencies: currencyResults,
    };
  }

  private buildCurrency(input: {
    currency: "CAD" | "USD";
    engine: PortfolioAccountingEngine;
    dates: readonly string[];
    facts: readonly FactRow[];
    factsByDate: ReadonlyMap<string, FactRow[]>;
    firstBuyPrice: ReadonlyMap<string, { date: string; price: RationalValue }>;
    instrumentById: ReadonlyMap<string, InstrumentRow>;
    splits: readonly SplitRow[];
    dividends: readonly DividendRow[];
    refresh: readonly DividendRefreshRow[];
    granularity: "daily" | "weekly" | "monthly";
  }): PortfolioHistoryCurrencyDto {
    const currencyInstrumentIds = new Set(
      [...input.instrumentById.values()]
        .filter((instrument) => instrument.currency === input.currency)
        .map((instrument) => instrument.id),
    );
    const prices = new Map<string, PriceState>();
    let factIndex = 0;
    const missing = new Map<
      string,
      PortfolioHistoryCoverageDto["missingPrices"][number]
    >();
    let usedEstimate = false;
    const emitted: PointWithPositions[] = [];
    for (const date of input.dates) {
      input.engine.advanceTo(date);
      while (factIndex < input.facts.length) {
        const fact = input.facts[factIndex];
        if (!fact || fact.trading_date > date) break;
        factIndex += 1;
        const value = safeRational(fact.current_raw_close_decimal);
        if (fact.status === "valid" && value)
          prices.set(fact.instrument_id, {
            value,
            date: fact.trading_date,
            estimated: false,
          });
      }
      const positions = input.engine
        .snapshot()
        .filter((position) => position.instrument.currency === input.currency);
      let partial = false;
      let estimated = false;
      const marketValues: RationalValue[] = [];
      const unrealized: RationalValue[] = [];
      for (const position of positions) {
        if (!position.quantity.isPositive()) continue;
        let price = prices.get(position.instrument.id);
        const hasRawFact = (input.factsByDate.get(date) ?? []).some(
          (fact) =>
            fact.instrument_id === position.instrument.id &&
            fact.status === "valid",
        );
        if (
          !hasRawFact &&
          isMarketTradingDayForExchange(date, position.instrument.exchange)
        ) {
          const firstBuy = input.firstBuyPrice.get(position.instrument.id);
          if (!price && firstBuy?.date === date) {
            price = { value: firstBuy.price, date, estimated: true };
            prices.set(position.instrument.id, price);
            estimated = true;
            usedEstimate = true;
          } else {
            partial = true;
            missing.set(`${position.instrument.id}:${date}`, {
              instrumentId: position.instrument.id,
              symbol: position.instrument.symbol,
              date,
            });
            continue;
          }
        }
        if (!price) {
          partial = true;
          missing.set(`${position.instrument.id}:${date}`, {
            instrumentId: position.instrument.id,
            symbol: position.instrument.symbol,
            date,
          });
          continue;
        }
        estimated ||= price.estimated;
        const marketValue = position.quantity.multiply(price.value);
        marketValues.push(marketValue);
        unrealized.push(marketValue.subtract(position.bookCost));
      }
      emitted.push({
        point: {
          date,
          totalValueDecimal: partial ? null : sum(marketValues).toString(),
          bookValueDecimal: sum(
            positions.map((position) => position.bookCost),
          ).toString(),
          realizedGainsDecimal: sum(
            positions.map((position) => position.realizedGain),
          ).toString(),
          unrealizedGainsDecimal: partial ? null : sum(unrealized).toString(),
          dividendsDecimal: sum(
            positions.map((position) => position.dividends),
          ).toString(),
          status: partial ? "partial" : estimated ? "estimated" : "complete",
        },
        positions,
        prices: new Map(prices),
      });
    }
    const points = emitted.map(({ point }) => point);
    const final = emitted.at(-1);
    if (!final) throw new Error("portfolio history requires a final point");
    const positions = final.positions
      .filter((position) => position.quantity.isPositive())
      .map((position) =>
        this.positionDto(position, final.prices.get(position.instrument.id)),
      )
      .sort(sortPositions);
    const splitConflicts: PortfolioConflictDto[] = input.splits
      .filter(
        (row) =>
          currencyInstrumentIds.has(row.instrument_id) &&
          row.status !== "active",
      )
      .slice(0, MAX_COVERAGE_DETAILS)
      .map((row) => ({
        code: row.conflict_code ?? `split_${row.status}`,
        message: row.conflict_message ?? `Corporate action is ${row.status}.`,
        instrumentId: row.instrument_id,
        effectiveDate: row.effective_date,
      }));
    const dividendRefresh = [
      ...input.refresh
        .filter(
          (row) =>
            currencyInstrumentIds.has(row.instrument_id) &&
            row.status !== "current",
        )
        .map((row) => ({
          instrumentId: row.instrument_id,
          symbol:
            input.instrumentById.get(row.instrument_id)?.symbol ??
            row.instrument_id,
          status: row.status,
          message: row.last_error_message,
        })),
      ...input.dividends
        .filter(
          (row) =>
            currencyInstrumentIds.has(row.instrument_id) &&
            (row.status !== "active" ||
              !safePositiveRational(row.amount_per_share_decimal)),
        )
        .map((row) => ({
          instrumentId: row.instrument_id,
          symbol:
            input.instrumentById.get(row.instrument_id)?.symbol ??
            row.instrument_id,
          status: row.status === "active" ? "invalid" : row.status,
          message: row.error_message ?? row.error_code,
        })),
    ].slice(0, MAX_COVERAGE_DETAILS);
    const missingPrices = [...missing.values()].slice(0, MAX_COVERAGE_DETAILS);
    const pending = dividendRefresh.some((detail) =>
      ["pending", "in_progress", "retry"].includes(detail.status),
    );
    const hasDividendCoverageIssue = dividendRefresh.some(
      (detail) => !["pending", "in_progress", "retry"].includes(detail.status),
    );
    const status =
      missingPrices.length > 0 ||
      splitConflicts.length > 0 ||
      hasDividendCoverageIssue
        ? "partial"
        : pending
          ? "pending"
          : usedEstimate
            ? "estimated"
            : "complete";
    const firstPoint = points[0];
    const lastPoint = points.at(-1);
    if (!firstPoint || !lastPoint)
      throw new Error("portfolio history requires summary points");
    const metrics: PortfolioMetric[] = [
      "totalValue",
      "bookValue",
      "realizedGains",
      "unrealizedGains",
      "dividends",
    ];
    return {
      currency: input.currency,
      summaries: Object.fromEntries(
        metrics.map((metric) => {
          const value = metricValue(lastPoint, metric);
          return [
            metric,
            {
              valueDecimal: value,
              periodDeltaDecimal: delta(value, metricValue(firstPoint, metric)),
            },
          ];
        }),
      ) as PortfolioHistoryCurrencyDto["summaries"],
      points,
      positions,
      granularity: input.granularity,
      coverage: { status, missingPrices, splitConflicts, dividendRefresh },
    };
  }

  private positionDto(
    position: PortfolioAccountingPosition,
    price: PriceState | undefined,
  ): PortfolioHistoryPositionDto {
    const marketValue = price ? position.quantity.multiply(price.value) : null;
    return {
      instrumentId: position.instrument.id,
      symbol: position.instrument.symbol,
      companyName: position.instrument.companyName,
      exchange: position.instrument.exchange,
      currency: position.instrument.currency,
      quantityDecimal: position.quantity.toString(),
      averageCostDecimal: position.averageCost.toString(),
      bookCostDecimal: position.bookCost.toString(),
      marketValueDecimal: marketValue?.toString() ?? null,
      unrealizedGainDecimal:
        marketValue?.subtract(position.bookCost).toString() ?? null,
      realizedGainDecimal: position.realizedGain.toString(),
      dividendsDecimal: position.dividends.toString(),
      latestPriceDecimal: price?.value.toString() ?? null,
      latestPriceDate: price?.date ?? null,
      valuationStatus: price
        ? price.estimated
          ? "estimated"
          : "complete"
        : "partial",
    };
  }

  private firstBuyPrices(
    rows: readonly TransactionRow[],
  ): Map<string, { date: string; price: RationalValue }> {
    const grouped = new Map<string, TransactionRow[]>();
    for (const row of rows.filter((candidate) => candidate.side === "buy")) {
      const current = grouped.get(row.instrument_id);
      const first = current?.[0];
      if (!first || row.trade_date < first.trade_date)
        grouped.set(row.instrument_id, [row]);
      else if (row.trade_date === first.trade_date) current.push(row);
    }
    return new Map(
      [...grouped.entries()].map(([instrumentId, buys]) => {
        const first = buys[0];
        if (!first) throw new Error("portfolio first-buy group is empty");
        const quantity = sum(
          buys.map((row) => RationalValue.fromDecimal(row.quantity_decimal)),
        );
        const cost = sum(
          buys.map((row) =>
            RationalValue.fromDecimal(row.quantity_decimal).multiply(
              RationalValue.fromDecimal(row.price_decimal),
            ),
          ),
        );
        return [
          instrumentId,
          { date: first.trade_date, price: cost.divide(quantity) },
        ];
      }),
    );
  }

  private transactions(input: PortfolioHistoryReadModelInput) {
    return this.db
      .prepare(
        `SELECT id, account_id, instrument_id, trade_date, side,
                quantity_decimal, price_decimal
           FROM transactions
          WHERE account_id IN (SELECT value FROM json_each(?1))
            AND trade_date <= ?2
          ORDER BY trade_date, CASE side WHEN 'buy' THEN 0 ELSE 1 END, id`,
      )
      .bind(JSON.stringify(input.accountIds), input.endDate)
      .all<TransactionRow>()
      .then((result) => result.results);
  }

  private instruments(ids: readonly string[]) {
    return this.db
      .prepare(
        `SELECT id, symbol, company_name, exchange, currency FROM instruments
          WHERE id IN (SELECT value FROM json_each(?1)) ORDER BY symbol, id`,
      )
      .bind(JSON.stringify(ids))
      .all<InstrumentRow>()
      .then((result) => result.results);
  }

  private splits(ids: readonly string[], endDate: string) {
    return this.db
      .prepare(
        `SELECT id, instrument_id, effective_date, split_numerator,
                split_denominator, status, conflict_code, conflict_message
           FROM corporate_actions
          WHERE instrument_id IN (SELECT value FROM json_each(?1))
            AND effective_date <= ?2
          ORDER BY effective_date, id`,
      )
      .bind(JSON.stringify(ids), endDate)
      .all<SplitRow>()
      .then((result) => result.results);
  }

  private dividends(ids: readonly string[], endDate: string) {
    return this.db
      .prepare(
        `SELECT id, instrument_id, ex_date, amount_per_share_decimal, status,
                error_code, error_message
           FROM dividend_events
          WHERE instrument_id IN (SELECT value FROM json_each(?1))
            AND ex_date <= ?2
          ORDER BY ex_date, id`,
      )
      .bind(JSON.stringify(ids), endDate)
      .all<DividendRow>()
      .then((result) => result.results);
  }

  private dividendRefresh(ids: readonly string[]) {
    return this.db
      .prepare(
        `SELECT instrument_id, status, last_error_message
           FROM dividend_refresh_state
          WHERE instrument_id IN (SELECT value FROM json_each(?1))`,
      )
      .bind(JSON.stringify(ids))
      .all<DividendRefreshRow>()
      .then((result) => result.results);
  }

  private facts(
    ids: readonly string[],
    requestedDates: readonly string[],
    startDate: string,
    includePrior: boolean,
  ) {
    if (!includePrior) {
      return this.db
        .prepare(
          `SELECT instrument_id, trading_date, current_raw_close_decimal, status
             FROM daily_market_facts
            WHERE instrument_id IN (SELECT value FROM json_each(?1))
              AND trading_date IN (SELECT value FROM json_each(?2))
            ORDER BY trading_date, instrument_id`,
        )
        .bind(JSON.stringify(ids), JSON.stringify(requestedDates))
        .all<FactRow>()
        .then((result) => result.results);
    }
    return this.db
      .prepare(
        `WITH requested_instruments AS (
           SELECT value AS instrument_id FROM json_each(?1)
         ),
         prior_dates AS (
           SELECT requested.instrument_id,
                  (
                    SELECT prior.trading_date
                      FROM daily_market_facts prior
                     WHERE prior.instrument_id = requested.instrument_id
                       AND prior.trading_date < ?2
                       AND prior.status = 'valid'
                     ORDER BY prior.trading_date DESC LIMIT 1
                  ) AS trading_date
             FROM requested_instruments requested
         )
         SELECT instrument_id, trading_date, current_raw_close_decimal, status
           FROM daily_market_facts
          WHERE instrument_id IN (SELECT instrument_id FROM requested_instruments)
            AND trading_date IN (SELECT value FROM json_each(?3))
         UNION ALL
         SELECT fact.instrument_id, fact.trading_date,
                fact.current_raw_close_decimal, fact.status
           FROM prior_dates prior
           JOIN daily_market_facts fact
             ON fact.instrument_id = prior.instrument_id
            AND fact.trading_date = prior.trading_date
          WHERE prior.trading_date IS NOT NULL
          ORDER BY trading_date, instrument_id`,
      )
      .bind(JSON.stringify(ids), startDate, JSON.stringify(requestedDates))
      .all<FactRow>()
      .then((result) => result.results);
  }
}
