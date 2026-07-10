import { Hono } from "hono";
import { z } from "zod";
import { TickerRepository } from "../../db/tickers";
import { YahooMarketDataProvider } from "../../providers/yahoo";
import { WatchlistService } from "../../services/watchlist";
import type { Env } from "../env";
import { ApiError } from "../errors";

const bodySchema = z.object({ symbol: z.string().max(20) }).strict();
export const tickerRoutes = new Hono<{ Bindings: Env }>();

tickerRoutes.get("/", async (context) =>
  context.json({ tickers: await new TickerRepository(context.env.DB).list() }),
);

tickerRoutes.post("/", async (context) => {
  const body = bodySchema.parse(await context.req.json());
  const ticker = await new WatchlistService(
    new TickerRepository(context.env.DB),
    new YahooMarketDataProvider(),
    () => crypto.randomUUID(),
  ).add(body.symbol, new Date().toISOString());
  return context.json({ ticker }, 201);
});

tickerRoutes.patch("/:id", async (context) => {
  const body = z
    .object({ active: z.boolean() })
    .strict()
    .parse(await context.req.json());
  const changed = await new TickerRepository(context.env.DB).setActive(
    context.req.param("id"),
    body.active,
    new Date().toISOString(),
  );
  if (!changed) {
    throw new ApiError(404, "ticker_not_found", "Ticker not found.");
  }
  return context.body(null, 204);
});

tickerRoutes.delete("/:id", async (context) => {
  const changed = await new TickerRepository(context.env.DB).softDelete(
    context.req.param("id"),
    new Date().toISOString(),
  );
  if (!changed) {
    throw new ApiError(404, "ticker_not_found", "Ticker not found.");
  }
  return context.body(null, 204);
});
