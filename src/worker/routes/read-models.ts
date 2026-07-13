import { type Context, Hono } from "hono";
import { z } from "zod";
import { AccountRepository } from "../../db/accounts";
import { AccountService } from "../../services/accounts";
import { CalendarReadModelService } from "../../services/calendar-read-model";
import { JobReadModelService } from "../../services/job-read-model";
import { PortfolioReadModelService } from "../../services/portfolio-read-model";
import {
  matchesIfNoneMatch,
  monthKeysForRange,
  readModelTag,
} from "../../services/read-model-etags";
import { easternMarketDate } from "../../shared/dates";
import type { Env } from "../env";
import { ApiError } from "../errors";

const isoDate = z.iso.date();
const localeSchema = z.enum(["en", "cn"]);

const resolveScope = async (db: D1Database, query: Record<string, string>) => {
  const scopeType = query.scopeType ?? "all";
  const accountService = new AccountService(new AccountRepository(db));
  if (scopeType === "all") {
    if (query.scopeId) {
      throw new ApiError(422, "invalid_scope", "The account scope is invalid.");
    }
    return accountService.resolveScope({ scopeType: "all" });
  }
  if ((scopeType !== "category" && scopeType !== "account") || !query.scopeId) {
    throw new ApiError(422, "invalid_scope", "The account scope is invalid.");
  }
  return accountService.resolveScope({
    scopeType,
    scopeId: query.scopeId,
  });
};

const isEnabled = (
  env: Env,
  model: "portfolio" | "calendar" | "job",
): boolean => {
  const specific =
    model === "portfolio"
      ? (env.PORTFOLIO_READ_MODELS_ENABLED ??
        env.PORTFOLIO_READ_MODEL_ENABLED ??
        env.ENABLE_PORTFOLIO_READ_MODEL)
      : model === "calendar"
        ? (env.CALENDAR_READ_MODELS_ENABLED ??
          env.CALENDAR_READ_MODEL_ENABLED ??
          env.ENABLE_CALENDAR_READ_MODEL)
        : (env.JOB_READ_MODELS_ENABLED ??
          env.JOB_READ_MODEL_ENABLED ??
          env.ENABLE_JOB_READ_MODEL);
  // The cutover flag is a fallback for production, while the existing
  // READ_MODELS aliases remain usable for local previews and compatibility
  // tests. Production has no legacy alias configured, so toggling
  // PORTFOLIO_NEW_READS_ENABLED is the reversible read gate there.
  const value =
    specific ??
    env.READ_MODELS_ENABLED ??
    env.READ_MODEL_ENABLED ??
    env.PORTFOLIO_NEW_READS_ENABLED;
  return (
    value !== undefined &&
    ["1", "true", "on", "enabled"].includes(value.toLowerCase())
  );
};

const requireEnabled = (env: Env, model: "portfolio" | "calendar" | "job") => {
  if (!isEnabled(env, model)) {
    throw new ApiError(
      404,
      "read_model_disabled",
      "This read model is not enabled.",
    );
  }
};

const parseLocale = (value: string | undefined) => {
  const parsed = localeSchema.safeParse(value ?? "en");
  if (!parsed.success)
    throw new ApiError(422, "locale", "Locale must be en or cn.");
  return parsed.data;
};

const parseDate = (value: string | undefined, code: string): string => {
  const parsed = isoDate.safeParse(value);
  if (!parsed.success)
    throw new ApiError(422, code, "Provide a valid ISO calendar date.");
  return parsed.data;
};

const parseLimit = (
  value: string | undefined,
  fallback: number,
  maximum: number,
) => {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > maximum) {
    throw new ApiError(
      422,
      "limit",
      "The limit is outside the supported range.",
    );
  }
  return number;
};

const decodeCursor = <T extends Record<string, unknown>>(
  value: string | undefined,
  code: string,
  schema: z.ZodType<T>,
): T | null => {
  if (!value) return null;
  try {
    const parsed = schema.parse(JSON.parse(atob(value)));
    return parsed;
  } catch {
    throw new ApiError(422, code, "The cursor is invalid.");
  }
};

const encodeCursor = (value: object): string => btoa(JSON.stringify(value));

const basisRevision = async (db: D1Database): Promise<number> =>
  (
    await db
      .prepare("SELECT revision FROM position_basis_state WHERE id = 1")
      .first<{ revision: number }>()
  )?.revision ?? 0;

const latestFactDate = async (
  db: D1Database,
  asOfDate: string,
): Promise<string | null> =>
  (
    await db
      .prepare(
        `SELECT MAX(trading_date) AS trading_date
         FROM daily_market_facts WHERE trading_date <= ?1`,
      )
      .bind(asOfDate)
      .first<{ trading_date: string | null }>()
  )?.trading_date ?? null;

const setTagHeaders = (
  context: Context<{ Bindings: Env }>,
  tag: string,
  positionRevision: number,
) => {
  context.header("ETag", tag);
  context.header("X-Position-Basis-Revision", String(positionRevision));
};

const inclusiveDays = (startDate: string, endDate: string): number =>
  Math.floor(
    (Date.parse(`${endDate}T12:00:00Z`) -
      Date.parse(`${startDate}T12:00:00Z`)) /
      86_400_000,
  ) + 1;

const addDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);

const monthRange = (date: string): { start: string; end: string } => {
  const [yearText, monthText] = date.slice(0, 7).split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const start = `${yearText}-${monthText}-01`;
  const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return { start, end };
};

export const portfolioRoutes = new Hono<{ Bindings: Env }>();
export const calendarRoutes = new Hono<{ Bindings: Env }>();
export const jobRoutes = new Hono<{ Bindings: Env }>();

portfolioRoutes.get("/", async (context) => {
  requireEnabled(context.env, "portfolio");
  const query = context.req.query();
  const today = query.today
    ? parseDate(query.today, "today")
    : easternMarketDate(new Date());
  const locale = parseLocale(query.locale);
  const scope = await resolveScope(context.env.DB, query);
  const accountStructure = await new AccountService(
    new AccountRepository(context.env.DB),
  ).structure();
  const limit = parseLimit(query.limit, 100, 100);
  const cursor = decodeCursor(
    query.cursor,
    "cursor",
    z
      .object({
        symbol: z.string().min(1).max(64),
        instrumentId: z.string().min(1).max(128),
      })
      .strict(),
  );
  const positionRevision = await basisRevision(context.env.DB);
  const currentDate = easternMarketDate(new Date());
  const currentLatestDate = await latestFactDate(context.env.DB, currentDate);
  const currentLatestMonth =
    currentLatestDate?.slice(0, 7) ?? currentDate.slice(0, 7);
  const includeLatestBucket =
    !query.today || today.slice(0, 7) >= currentLatestMonth;
  const tag = await readModelTag(context.env.DB, {
    model: "portfolio",
    locale,
    positionBasisRevision: positionRevision,
    accountStructureRevision: accountStructure.revision,
    representationKey: JSON.stringify({
      today,
      limit,
      cursor,
      scope: scope.fingerprint,
    }),
    bucketKeys: [
      ...(includeLatestBucket ? ["latest"] : []),
      ...(query.today ? [today.slice(0, 7)] : []),
    ],
  });
  setTagHeaders(context, tag.etag, positionRevision);
  if (matchesIfNoneMatch(context.req.header("If-None-Match"), tag.etag)) {
    return context.body(null, 304);
  }
  const portfolio = await new PortfolioReadModelService(context.env.DB).read({
    today,
    locale,
    accountIds: scope.accountIds,
    limit,
    cursor,
  });
  context.header("Content-Language", locale);
  return context.json({ portfolio });
});

calendarRoutes.get("/", async (context) => {
  requireEnabled(context.env, "calendar");
  const query = context.req.query();
  const asOfDate = query.asOfDate
    ? parseDate(query.asOfDate, "asOfDate")
    : easternMarketDate(new Date());
  const locale = parseLocale(query.locale);
  const scope = await resolveScope(context.env.DB, query);
  const accountStructure = await new AccountService(
    new AccountRepository(context.env.DB),
  ).structure();
  const view = query.view ?? "month";
  if (view !== "week" && view !== "month") {
    throw new ApiError(
      422,
      "calendar_view",
      "Calendar view must be week or month.",
    );
  }
  let startDate = query.startDate ?? query.start;
  let endDate = query.endDate ?? query.end;
  if (!startDate && !endDate) {
    const anchor = parseDate(query.date ?? asOfDate, "date");
    if (view === "month") {
      const range = monthRange(anchor);
      startDate = range.start;
      endDate = range.end;
    } else {
      startDate = anchor;
      endDate = addDays(anchor, 6);
    }
  }
  if (!startDate || !endDate) {
    throw new ApiError(
      422,
      "calendar_range",
      "Both calendar range dates are required.",
    );
  }
  startDate = parseDate(startDate, "startDate");
  endDate = parseDate(endDate, "endDate");
  if (startDate > endDate) {
    throw new ApiError(
      422,
      "calendar_range",
      "The calendar range is reversed.",
    );
  }
  const days = inclusiveDays(startDate, endDate);
  if (days > 31 || (view === "week" && days > 7)) {
    throw new ApiError(
      422,
      "calendar_range",
      "Calendar ranges are bounded to the selected view.",
    );
  }
  const cursor = decodeCursor(
    query.cursor,
    "cursor",
    z
      .object({
        date: z.iso.date(),
        kind: z.string().min(1).max(32),
        id: z.string().min(1).max(256),
      })
      .strict(),
  );
  const limit = parseLimit(query.limit, 500, 500);
  const positionRevision = await basisRevision(context.env.DB);
  const latestDate = await latestFactDate(context.env.DB, asOfDate);
  const latestIntersectsRange =
    (asOfDate >= startDate && asOfDate <= endDate) ||
    (latestDate !== null && latestDate >= startDate && latestDate <= endDate);
  const tag = await readModelTag(context.env.DB, {
    model: "calendar",
    locale,
    positionBasisRevision: positionRevision,
    accountStructureRevision: accountStructure.revision,
    representationKey: JSON.stringify({
      startDate,
      endDate,
      asOfDate,
      view,
      limit,
      cursor,
      scope: scope.fingerprint,
    }),
    bucketKeys: [
      ...(latestIntersectsRange ? ["latest"] : []),
      ...monthKeysForRange(startDate, endDate),
    ],
  });
  setTagHeaders(context, tag.etag, positionRevision);
  if (matchesIfNoneMatch(context.req.header("If-None-Match"), tag.etag)) {
    return context.body(null, 304);
  }
  const calendar = await new CalendarReadModelService(context.env.DB).read({
    startDate,
    endDate,
    asOfDate,
    locale,
    accountIds: scope.accountIds,
    limit,
    cursor,
  });
  context.header("Content-Language", locale);
  return context.json({ calendar });
});

jobRoutes.get("/", async (context) => {
  requireEnabled(context.env, "job");
  const query = context.req.query();
  const limit = parseLimit(query.limit, 25, 50);
  const cursor = decodeCursor(
    query.cursor,
    "cursor",
    z
      .object({
        id: z.string().min(1).max(128),
        createdAt: z.string().min(1).max(64).optional(),
      })
      .strict(),
  );
  const listCursor = cursor
    ? cursor.createdAt
      ? { id: cursor.id, createdAt: cursor.createdAt }
      : cursor.id
    : null;
  const result = await new JobReadModelService(context.env.DB).list({
    limit,
    cursor: listCursor,
  });
  return context.json({
    jobs: result.jobs,
    nextCursor: result.nextCursor ? encodeCursor(result.nextCursor) : null,
  });
});

jobRoutes.get("/:id", async (context) => {
  requireEnabled(context.env, "job");
  const id = context.req.param("id");
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) {
    throw new ApiError(422, "job_id", "The job identifier is invalid.");
  }
  const query = context.req.query();
  const limit = parseLimit(query.limit, 50, 100);
  const cursor = decodeCursor(
    query.cursor,
    "cursor",
    z.object({ id: z.string().min(1).max(128) }).strict(),
  );
  const job = await new JobReadModelService(context.env.DB).find(id, {
    limit,
    cursor: cursor?.id ?? null,
  });
  if (!job) throw new ApiError(404, "job_not_found", "Job not found.");
  const cursorToken = cursor?.id ? encodeURIComponent(cursor.id) : "";
  const etag = `"job-${encodeURIComponent(job.id)}-${encodeURIComponent(job.updatedAt)}-${limit}-${cursorToken}"`;
  context.header("ETag", etag);
  if (matchesIfNoneMatch(context.req.header("If-None-Match"), etag)) {
    return context.body(null, 304);
  }
  return context.json({ job });
});
