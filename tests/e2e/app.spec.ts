import { expect, test } from "@playwright/test";

const shopMover = {
  screeningId: "shop",
  symbol: "SHOP.TO",
  companyName: "Shopify Inc.",
  exchange: "TOR",
  currency: "CAD",
  currentPrice: 174.45,
  changeAmount: 12.03,
  changePct: 7.4,
  explanationZhCn: "企业客户增长及分析师上调目标价可能推动上涨。",
  confidence: "high",
  clearCatalyst: true,
  analysisStatus: "complete",
  sources: [
    {
      title: "Shopify shares jump after enterprise update",
      publisher: "Reuters",
      publishedAt: "2026-07-09T18:30:00.000Z",
      url: "https://news/1",
      cited: true,
    },
  ],
};

const nvdaMover = {
  ...shopMover,
  screeningId: "nvda",
  symbol: "NVDA",
  companyName: "NVIDIA Corporation",
  exchange: "NMS",
  currency: "USD",
  currentPrice: 151.2,
  changeAmount: -10.8,
  changePct: -6.67,
  explanationZhCn: "多家报道将下跌与行业需求担忧联系起来，但无法证明单一原因。",
  confidence: "medium",
  clearCatalyst: false,
  sources: [],
};

const run = {
  id: "run",
  tradingDate: "2026-07-09",
  status: "complete",
  tickersTotal: 64,
  tickersProcessed: 64,
  tickersQualified: 2,
  tickersFailed: 0,
};

test.beforeEach(async ({ page }) => {
  let tickers: Array<Record<string, unknown>> = [];
  await page.route("**/api/reports/latest", (route) =>
    route.fulfill({
      json: {
        report: { run, movers: [shopMover, nvdaMover] },
        currentRun: null,
      },
    }),
  );
  await page.route(/\/api\/reports(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { reports: [run], nextCursor: null } }),
  );
  await page.route("**/api/reports/2026-07-09", (route) =>
    route.fulfill({
      json: { report: { run, movers: [shopMover, nvdaMover] } },
    }),
  );
  await page.route("**/api/tickers**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST") {
      const body = request.postDataJSON() as { symbol: string };
      const ticker = {
        id: "shop",
        symbol: body.symbol,
        companyName: "Shopify Inc.",
        exchange: "TOR",
        currency: "CAD",
        active: true,
      };
      tickers = [ticker];
      await route.fulfill({ status: 201, json: { ticker } });
      return;
    }
    if (request.method() === "PATCH") {
      const active = (request.postDataJSON() as { active: boolean }).active;
      tickers = tickers.map((ticker) => ({ ...ticker, active }));
      await route.fulfill({ status: 204 });
      return;
    }
    if (request.method() === "DELETE") {
      tickers = tickers.filter(
        (ticker) => ticker.id !== url.pathname.split("/").at(-1),
      );
      await route.fulfill({ status: 204 });
      return;
    }
    await route.fulfill({ json: { tickers } });
  });
  await page.route("**/api/backfills", (route) =>
    route.fulfill({ status: 202, json: { id: "backfill-1" } }),
  );
  await page.route("**/api/backfills/backfill-1", (route) =>
    route.fulfill({
      json: {
        job: {
          id: "backfill-1",
          status: "complete_with_errors",
          dates_total: 2,
          dates_processed: 2,
          ticker_jobs_total: 4,
          ticker_jobs_processed: 4,
          ticker_jobs_failed: 1,
          runs: [
            {
              tradingDate: "2026-07-08",
              status: "complete",
              tickersFailed: 0,
            },
            {
              tradingDate: "2026-07-09",
              status: "complete_with_errors",
              tickersFailed: 1,
            },
          ],
          errors: [],
        },
      },
    }),
  );
});

test("renders the responsive report feed and expands sources", async ({
  page,
}, testInfo) => {
  await page.goto("/#/today");
  await expect(page.getByRole("heading", { name: "SHOP.TO" })).toBeVisible();
  await expect(
    page.getByText("企业客户增长及分析师上调目标价可能推动上涨。"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Show 1 source" }).click();
  await expect(
    page.getByRole("link", { name: /Shopify shares jump/ }),
  ).toBeVisible();
  await expect(page.getByRole("navigation")).toBeVisible();
  const columns = await page
    .getByLabel("Qualifying movers")
    .evaluate(
      (element) =>
        getComputedStyle(element).gridTemplateColumns.split(" ").length,
    );
  expect(columns).toBe(testInfo.project.name === "phone" ? 1 : 2);
});

test("supports keyboard focus and 44px controls", async ({ page }) => {
  await page.goto("/#/today");
  await page.keyboard.press("Tab");
  const focused = page.locator(":focus");
  await expect(focused).toBeVisible();
  const box = await focused.boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(44);
  expect(
    await focused.evaluate((element) => getComputedStyle(element).outlineWidth),
  ).toBe("3px");
});

test("adds, disables, and removes a validated ticker", async ({ page }) => {
  await page.goto("/#/watchlist");
  await page.getByLabel("Yahoo symbol").fill("shop.to");
  await page.getByRole("button", { name: "Add ticker" }).click();
  await expect(page.getByText("Shopify Inc. · TOR · CAD")).toBeVisible();
  await page.getByRole("button", { name: "Disable" }).click();
  await expect(page.getByRole("button", { name: "Enable" })).toBeVisible();
  await page.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("Shopify Inc. · TOR · CAD")).toHaveCount(0);
});

test("starts a backfill and shows date and failure progress", async ({
  page,
}) => {
  await page.goto("/#/backfill");
  await page.getByLabel("Start date").fill("2026-07-08");
  await page.getByLabel("End date").fill("2026-07-09");
  await page.getByRole("button", { name: "Start backfill" }).click();
  await expect(
    page.getByRole("heading", { name: "complete with errors" }),
  ).toBeVisible();
  await expect(page.getByText("4/4 ticker jobs · 1 failed")).toBeVisible();
  await expect(page.getByText("2026-07-09")).toBeVisible();
});

test("opens a historical report", async ({ page }) => {
  await page.goto("/#/history");
  await expect(page.getByLabel("Report date")).toHaveValue("2026-07-09");
  await expect(page.getByRole("heading", { name: "NVDA" })).toBeVisible();
});
