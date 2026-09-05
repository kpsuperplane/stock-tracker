import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { readCalendarAnalysisFallbacks } from "../../src/services/calendar-analysis-fallbacks";
import { D1UsageMeter } from "../../src/services/d1-usage";

const now = "2026-07-10T12:00:00.000Z";

describe("calendar analysis fallbacks", () => {
  it("does not multiply analysis scans by the account-scope size", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `WITH RECURSIVE numbers(value) AS (
           SELECT 0 UNION ALL SELECT value + 1 FROM numbers WHERE value < 71
         )
         INSERT INTO instruments
           (id, symbol, company_name, exchange, currency, instrument_type,
            provider, provider_symbol, created_at, updated_at)
         SELECT 'scope-instrument-' || printf('%03d', value),
                'SCOPE' || printf('%03d', value), 'Scope Fixture', 'NYSE',
                'USD', 'stock', 'fixture', 'SCOPE' || printf('%03d', value),
                ?1, ?1 FROM numbers`,
      ).bind(now),
      env.DB.prepare(
        `WITH RECURSIVE days(value) AS (
           SELECT 0 UNION ALL SELECT value + 1 FROM days WHERE value < 39
         )
         INSERT INTO daily_market_facts
           (id, instrument_id, trading_date, current_raw_close_decimal,
            movement_basis, provider, provider_revision, retrieved_at, status,
            created_at, updated_at)
         SELECT 'scope-fact:' || instrument.id || ':' || days.value,
                instrument.id, date('2026-01-01', '+' || days.value || ' days'),
                '100', 'split_adjusted_price_return', 'fixture', 'fixture-r1',
                ?1, 'valid', ?1, ?1
           FROM instruments instrument CROSS JOIN days
          WHERE instrument.id LIKE 'scope-instrument-%'`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO movement_analyses
           (id, daily_market_fact_id, dependency_fingerprint, summary_zh_cn,
            model, status, created_at, updated_at)
         SELECT 'scope-analysis:' || fact.id, fact.id, 'fixture-r1',
                'Fixture summary', 'fixture', 'complete', ?1, ?1
           FROM daily_market_facts fact
          WHERE fact.instrument_id LIKE 'scope-instrument-%'`,
      ).bind(now),
    ]);
    const ids = (
      await env.DB.prepare(
        `SELECT id FROM instruments WHERE id LIKE 'scope-instrument-%'
          ORDER BY id`,
      ).all<{ id: string }>()
    ).results.map((row) => row.id);
    const meter = new D1UsageMeter(env.DB);

    const rows = await readCalendarAnalysisFallbacks(
      meter.db,
      ids,
      "2026-03-01",
      "2026-03-31",
    );

    expect(rows).toHaveLength(72);
    expect(meter.snapshot().rowsRead).toBeLessThan(50_000);
  });
});
