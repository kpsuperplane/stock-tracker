import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { ReportDto } from "../../src/shared/contracts";

const headers = { Authorization: `Basic ${btoa("owner:password")}` };
const now = "2026-07-09T22:00:00.000Z";

beforeEach(async () => {
  await env.DB.batch([
    env.DB
      .prepare(
        "INSERT INTO tickers (id,symbol,company_name,exchange,currency,active,created_at,updated_at) VALUES ('shop','SHOP.TO','Shopify Inc.','TOR','CAD',1,?1,?1)",
      )
      .bind(now),
    env.DB
      .prepare(
        "INSERT INTO tickers (id,symbol,company_name,exchange,currency,active,created_at,updated_at) VALUES ('nvda','NVDA','NVIDIA','NMS','USD',1,?1,?1)",
      )
      .bind(now),
    env.DB
      .prepare(
        "INSERT INTO report_runs (id,trading_date,generation,origin,published,status,tickers_total,tickers_processed,tickers_qualified,created_at) VALUES ('run','2026-07-09',1,'scheduled',1,'complete',2,2,2,?1)",
      )
      .bind(now),
    env.DB.prepare(
      "INSERT INTO screenings (id,report_run_id,ticker_id,symbol,company_name,exchange,currency,target_date,current_price,change_amount,change_pct,qualified,status) VALUES ('s-shop','run','shop','SHOP.TO','Shopify Inc.','TOR','CAD','2026-07-09',107,7,7,1,'complete')",
    ),
    env.DB.prepare(
      "INSERT INTO screenings (id,report_run_id,ticker_id,symbol,company_name,exchange,currency,target_date,current_price,change_amount,change_pct,qualified,status) VALUES ('s-nvda','run','nvda','NVDA','NVIDIA','NMS','USD','2026-07-09',91,-9,-9,1,'complete')",
    ),
    env.DB
      .prepare(
        "INSERT INTO analyses (id,screening_id,explanation_zh_cn,confidence,clear_catalyst,model,status,created_at) VALUES ('a-shop','s-shop','企业增长可能支持上涨。','high',1,'test','complete',?1)",
      )
      .bind(now),
    env.DB
      .prepare(
        "INSERT INTO analyses (id,screening_id,explanation_zh_cn,confidence,clear_catalyst,model,status,created_at) VALUES ('a-nvda','s-nvda','相关报道可能解释下跌。','medium',1,'test','complete',?1)",
      )
      .bind(now),
    env.DB
      .prepare(
        "INSERT INTO sources (id,screening_id,source_index,title,publisher,published_at,url,cited) VALUES ('src-shop','s-shop',0,'Shopify news','Reuters',?1,'https://news/shop',1)",
      )
      .bind(now),
  ]);
});

describe("report routes", () => {
  it("orders movers by absolute percentage change and hydrates sources", async () => {
    const response = await exports.default.fetch(
      new Request("http://local/api/reports/latest", { headers }),
    );
    expect(response.status).toBe(200);
    const payload = await response.json<{ report: ReportDto }>();
    expect(payload.report.movers.map((mover) => mover.symbol)).toEqual([
      "NVDA",
      "SHOP.TO",
    ]);
    expect(payload.report.movers[1]?.sources[0]?.publisher).toBe("Reuters");
  });

  it("lists history and reads a report by date", async () => {
    const history = await exports.default.fetch(
      new Request("http://local/api/reports", { headers }),
    );
    expect(
      (await history.json<{ reports: Array<{ tradingDate: string }> }>()).reports,
    ).toEqual([expect.objectContaining({ tradingDate: "2026-07-09" })]);
    const dated = await exports.default.fetch(
      new Request("http://local/api/reports/2026-07-09", { headers }),
    );
    expect((await dated.json<{ report: ReportDto }>()).report.movers).toHaveLength(
      2,
    );
  });

  it("clears stale analysis and requeues a failed qualifying screening", async () => {
    await env.DB
      .prepare("UPDATE screenings SET status = 'failed' WHERE id = 's-shop'")
      .run();
    const response = await exports.default.fetch(
      new Request("http://local/api/screenings/s-shop/retry", {
        method: "POST",
        headers,
      }),
    );
    expect(response.status).toBe(202);
    expect(
      await env.DB
        .prepare(
          "SELECT status, attempt_count FROM screenings WHERE id = 's-shop'",
        )
        .first(),
    ).toEqual({ status: "queued", attempt_count: 0 });
    expect(
      await env.DB
        .prepare(
          "SELECT COUNT(*) AS count FROM analyses WHERE screening_id = 's-shop'",
        )
        .first(),
    ).toEqual({ count: 0 });
    expect(
      await env.DB
        .prepare(
          "SELECT COUNT(*) AS count FROM sources WHERE screening_id = 's-shop'",
        )
        .first(),
    ).toEqual({ count: 0 });
  });

  it("rejects retry for a successful or non-qualifying screening", async () => {
    const response = await exports.default.fetch(
      new Request("http://local/api/screenings/s-shop/retry", {
        method: "POST",
        headers,
      }),
    );
    expect(response.status).toBe(409);
  });
});
