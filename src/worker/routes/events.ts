import { type Context, Hono } from "hono";
import { z } from "zod";
import { YahooCorporateActionProvider } from "../../providers/yahoo-corporate-actions";
import {
  type LedgerMutationResult,
  type LedgerProposal,
  LedgerService,
} from "../../services/ledger";
import type {
  EventsTimelineDto,
  PortfolioEventDto,
  SplitEventDto,
  TransactionEventDto,
} from "../../shared/contracts";
import type { Env } from "../env";

type EventContext = Context<{ Bindings: Env }>;

const APP_REQUEST_HEADER = "X-Stock-Tracker-Request";
const APP_REQUEST_VALUE = "1";
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;

const confirmationSchema = z
  .object({
    requestedStartDate: z.iso.date(),
    requestedEndDate: z.iso.date(),
    providerRevision: z.string().min(1).max(512),
  })
  .strict();

const createSchema = z
  .object({
    instrumentId: z.string().min(1).max(128),
    tradeDate: z.iso.date(),
    side: z.enum(["buy", "sell"]),
    quantityDecimal: z.string().min(1).max(64),
    priceDecimal: z.string().min(1).max(64),
    confirmation: confirmationSchema.optional(),
  })
  .strict();

const updateSchema = z
  .object({
    tradeDate: z.iso.date(),
    side: z.enum(["buy", "sell"]),
    quantityDecimal: z.string().min(1).max(64),
    priceDecimal: z.string().min(1).max(64),
    confirmation: confirmationSchema.optional(),
  })
  .strict();

const confirmSchema = z
  .object({
    instrumentId: z.string().min(1).max(128),
    confirmation: confirmationSchema,
  })
  .strict();

const timelineQuerySchema = z.object({
  instrumentId: z.string().min(1).max(128).optional(),
  symbol: z.string().min(1).max(32).optional(),
  type: z.enum(["transaction", "split"]).optional(),
  cursor: z.string().min(1).max(1_024).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
});

interface TimelineRow {
  event_type: "transaction" | "split";
  event_id: string;
  instrument_id: string;
  symbol: string;
  company_name: string;
  currency: "USD" | "CAD";
  event_date: string;
  side: "buy" | "sell" | null;
  quantity_decimal: string | null;
  price_decimal: string | null;
  effective_date: string | null;
  split_numerator: string | null;
  split_denominator: string | null;
  provider: string | null;
  provider_event_id: string | null;
  provider_revision: string | null;
  retrieved_at: string | null;
  revision: number;
  status: SplitEventDto["status"] | null;
  conflict_code: string | null;
  conflict_message: string | null;
  created_at: string | null;
  updated_at: string | null;
}

interface TimelineCursor {
  date: string;
  type: "transaction" | "split";
  id: string;
}

const error = (
  context: EventContext,
  status: 403 | 405 | 409 | 422 | 503,
  code: string,
  message: string,
  details?: Record<string, unknown>,
) => context.json({ error: { code, message }, ...details }, status);

const positionBasisTag = (revision: number) => `"position-basis-${revision}"`;
const eventTag = (revision: number) => `"event-${revision}"`;

const parsePositionBasisRevision = (
  value: string | undefined,
): number | null =>
  value && /^(?:0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value))
    ? Number(value)
    : null;

const parseEventIfMatch = (value: string | undefined): number | null => {
  if (!value) return null;
  const match = /^"event-([1-9]\d*)"$/.exec(value);
  return match && Number.isSafeInteger(Number(match[1]))
    ? Number(match[1])
    : null;
};

const parseCursor = (value: string | undefined): TimelineCursor | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(atob(value)) as unknown;
    const cursor = z
      .object({
        date: z.iso.date(),
        type: z.enum(["transaction", "split"]),
        id: z.string().min(1).max(256),
      })
      .strict()
      .parse(parsed);
    return cursor;
  } catch {
    return null;
  }
};

const encodeCursor = (cursor: TimelineCursor): string =>
  btoa(JSON.stringify(cursor));

const toTransactionDto = (row: TimelineRow): TransactionEventDto => ({
  type: "transaction",
  id: row.event_id,
  instrumentId: row.instrument_id,
  symbol: row.symbol,
  companyName: row.company_name,
  currency: row.currency,
  tradeDate: row.event_date,
  side: row.side as "buy" | "sell",
  quantityDecimal: row.quantity_decimal as string,
  priceDecimal: row.price_decimal as string,
  revision: row.revision,
  createdAt: row.created_at as string,
  updatedAt: row.updated_at as string,
});

const toSplitDto = (row: TimelineRow): SplitEventDto => ({
  type: "split",
  id: row.event_id,
  instrumentId: row.instrument_id,
  symbol: row.symbol,
  companyName: row.company_name,
  currency: row.currency,
  effectiveDate: row.effective_date as string,
  numerator: row.split_numerator as string,
  denominator: row.split_denominator as string,
  provider: row.provider as string,
  providerEventId: row.provider_event_id as string,
  providerRevision: row.provider_revision as string,
  retrievedAt: row.retrieved_at as string,
  revision: row.revision,
  status: row.status as SplitEventDto["status"],
  conflictCode: row.conflict_code,
  conflictMessage: row.conflict_message,
});

const toDto = (row: TimelineRow): PortfolioEventDto =>
  row.event_type === "transaction" ? toTransactionDto(row) : toSplitDto(row);

const sameOriginAndAppRequest = (context: EventContext): Response | null => {
  const origin = context.req.header("Origin");
  const host = context.req.header("Host");
  let requestUrl: URL;
  let originUrl: URL;
  try {
    requestUrl = new URL(context.req.url);
    originUrl = new URL(origin ?? "");
  } catch {
    return error(
      context,
      403,
      "csrf_rejected",
      "This mutation must come from the same origin.",
    );
  }
  if (
    !host ||
    /[\s,/@]/.test(host) ||
    !["http:", "https:"].includes(requestUrl.protocol) ||
    host.toLowerCase() !== requestUrl.host.toLowerCase() ||
    origin !== originUrl.origin ||
    originUrl.protocol !== requestUrl.protocol ||
    originUrl.host.toLowerCase() !== host.toLowerCase()
  ) {
    return error(
      context,
      403,
      "csrf_rejected",
      "This mutation must come from the same origin.",
    );
  }
  if (context.req.header(APP_REQUEST_HEADER) !== APP_REQUEST_VALUE) {
    return error(
      context,
      403,
      "csrf_rejected",
      "This mutation requires the application request header.",
    );
  }
  return null;
};

const timelineSql = `
  SELECT * FROM (
    SELECT
      'transaction' AS event_type, transactions.id AS event_id,
      instruments.id AS instrument_id, instruments.symbol, instruments.company_name,
      instruments.currency, transactions.trade_date AS event_date,
      transactions.side, transactions.quantity_decimal, transactions.price_decimal,
      NULL AS effective_date, NULL AS split_numerator, NULL AS split_denominator,
      NULL AS provider, NULL AS provider_event_id, NULL AS provider_revision,
      NULL AS retrieved_at, transactions.revision, NULL AS status,
      NULL AS conflict_code, NULL AS conflict_message,
      transactions.created_at, transactions.updated_at
    FROM transactions
    JOIN instruments ON instruments.id = transactions.instrument_id
    WHERE (?1 IS NULL OR transactions.instrument_id = ?1)
      AND (?2 IS NULL OR instruments.symbol = ?2)
      AND (?3 IS NULL OR ?3 = 'transaction')
    UNION ALL
    SELECT
      'split' AS event_type, corporate_actions.id AS event_id,
      instruments.id AS instrument_id, instruments.symbol, instruments.company_name,
      instruments.currency, corporate_actions.effective_date AS event_date,
      NULL AS side, NULL AS quantity_decimal, NULL AS price_decimal,
      corporate_actions.effective_date, corporate_actions.split_numerator,
      corporate_actions.split_denominator, corporate_actions.provider,
      corporate_actions.provider_event_id, corporate_actions.provider_revision,
      corporate_actions.retrieved_at, corporate_actions.revision,
      corporate_actions.status, corporate_actions.conflict_code,
      corporate_actions.conflict_message, NULL AS created_at,
      corporate_actions.updated_at
    FROM corporate_actions
    JOIN instruments ON instruments.id = corporate_actions.instrument_id
    WHERE (?1 IS NULL OR corporate_actions.instrument_id = ?1)
      AND (?2 IS NULL OR instruments.symbol = ?2)
      AND (?3 IS NULL OR ?3 = 'split')
  )
  WHERE (
    ?4 IS NULL
    OR event_date < ?4
    OR (event_date = ?4 AND event_type > ?5)
    OR (event_date = ?4 AND event_type = ?5 AND event_id < ?6)
  )
  ORDER BY event_date DESC, event_type ASC, event_id DESC
  LIMIT ?7`;

const transactionById = async (
  db: D1Database,
  id: string,
): Promise<TransactionEventDto | null> => {
  const row = await db
    .prepare(
      `SELECT
        'transaction' AS event_type, transactions.id AS event_id,
        instruments.id AS instrument_id, instruments.symbol, instruments.company_name,
        instruments.currency, transactions.trade_date AS event_date,
        transactions.side, transactions.quantity_decimal, transactions.price_decimal,
        transactions.revision, transactions.created_at, transactions.updated_at
       FROM transactions JOIN instruments ON instruments.id = transactions.instrument_id
       WHERE transactions.id = ?1`,
    )
    .bind(id)
    .first<TimelineRow>();
  return row ? toTransactionDto(row) : null;
};

const currentPositionBasisRevision = async (
  context: EventContext,
): Promise<number> =>
  (
    await context.env.DB.prepare(
      "SELECT revision FROM position_basis_state WHERE id = 1",
    ).first<{ revision: number }>()
  )?.revision ?? 0;

const setPositionBasisHeaders = (context: EventContext, revision: number) => {
  context.header("ETag", positionBasisTag(revision));
  context.header("X-Position-Basis-Revision", String(revision));
};

const mutationResponse = async (
  context: EventContext,
  result: LedgerMutationResult,
  status: 200 | 201,
  options: { deleted?: true } = {},
): Promise<Response> => {
  if (result.kind === "review_required") {
    const positionBasisRevision = await currentPositionBasisRevision(context);
    setPositionBasisHeaders(context, positionBasisRevision);
    return error(
      context,
      409,
      "split_review_required",
      "Confirm the displayed split history before changing this transaction.",
      { review: result.snapshot, positionBasisRevision },
    );
  }
  if (result.kind === "candidate_conflict") {
    const positionBasisRevision = await currentPositionBasisRevision(context);
    setPositionBasisHeaders(context, positionBasisRevision);
    return error(
      context,
      409,
      "split_correction_conflict",
      "The provider split correction conflicts with historical holdings.",
      { correction: result.snapshot, positionBasisRevision },
    );
  }
  if (result.kind === "provider_unavailable") {
    return error(
      context,
      503,
      "provider_unavailable",
      "The split-history provider is unavailable. Try again later.",
    );
  }
  if (result.kind === "conflict") {
    return error(
      context,
      409,
      result.code,
      result.code === "ledger_conflict"
        ? "The portfolio changed. Reload and try again."
        : "This transaction changed. Reload and try again.",
    );
  }
  if (result.kind === "validation_error") {
    const messages: Record<string, string> = {
      instrument_not_found: "The selected instrument does not exist.",
      invalid_transaction: "Enter a valid completed transaction.",
      invalid_position_basis_revision: "The portfolio revision is invalid.",
      invalid_confirmation: "Confirm split history through the current date.",
      negative_holdings:
        "This change would create negative historical holdings.",
      position_limit: "The portfolio is limited to 100 current positions.",
    };
    return error(
      context,
      422,
      result.code,
      messages[result.code] ?? "The transaction is invalid.",
    );
  }

  const transaction = result.transactionId
    ? await transactionById(context.env.DB, result.transactionId)
    : null;
  context.header(
    "ETag",
    transaction
      ? eventTag(transaction.revision)
      : positionBasisTag(result.positionBasisRevision),
  );
  context.header(
    "X-Position-Basis-Revision",
    String(result.positionBasisRevision),
  );
  if (transaction)
    context.header("X-Event-Revision", String(transaction.revision));
  return context.json(
    {
      transaction,
      ...(options.deleted ? { deleted: true } : {}),
      positionBasisRevision: result.positionBasisRevision,
      pipelineJobId: result.pipelineJobId,
    },
    status,
  );
};

const missingPrecondition = (context: EventContext) =>
  error(
    context,
    422,
    "precondition_required",
    "Provide valid revision preconditions.",
  );

const staleBasis = async (
  context: EventContext,
  expectedRevision: number,
): Promise<Response | null> => {
  const current = await currentPositionBasisRevision(context);
  return current === expectedRevision
    ? null
    : error(
        context,
        409,
        "ledger_conflict",
        "The portfolio changed. Reload and try again.",
      );
};

const futureTrade = (
  context: EventContext,
  tradeDate: string,
): Response | null =>
  tradeDate > new Date().toISOString().slice(0, 10)
    ? error(
        context,
        422,
        "invalid_transaction",
        "Transactions must use completed trade dates.",
      )
    : null;

const timeline = async (context: EventContext) => {
  const query = timelineQuerySchema.parse(context.req.query());
  const cursor = parseCursor(query.cursor);
  if (query.cursor && !cursor) {
    return error(
      context,
      422,
      "invalid_cursor",
      "The event cursor is invalid.",
    );
  }
  const pageSize = query.limit ?? DEFAULT_PAGE_SIZE;
  const result = await context.env.DB.prepare(timelineSql)
    .bind(
      query.instrumentId ?? null,
      query.symbol?.toUpperCase() ?? null,
      query.type ?? null,
      cursor?.date ?? null,
      cursor?.type ?? null,
      cursor?.id ?? null,
      pageSize + 1,
    )
    .all<TimelineRow>();
  const rows = result.results.slice(0, pageSize);
  const tail = result.results.at(pageSize);
  const positionBasisRevision = await currentPositionBasisRevision(context);
  const payload: EventsTimelineDto = {
    events: rows.map(toDto),
    nextCursor: tail
      ? encodeCursor({
          date: rows.at(-1)?.event_date ?? tail.event_date,
          type: rows.at(-1)?.event_type ?? tail.event_type,
          id: rows.at(-1)?.event_id ?? tail.event_id,
        })
      : null,
    positionBasisRevision,
  };
  setPositionBasisHeaders(context, positionBasisRevision);
  return context.json(payload);
};

const expectedPositionBasis = (context: EventContext): number | null =>
  parsePositionBasisRevision(context.req.header("X-Position-Basis-Revision"));

const createTransaction = async (context: EventContext) => {
  const rejected = sameOriginAndAppRequest(context);
  if (rejected) return rejected;
  const positionBasisRevision = expectedPositionBasis(context);
  if (positionBasisRevision === null) return missingPrecondition(context);
  const stale = await staleBasis(context, positionBasisRevision);
  if (stale) return stale;
  const body = createSchema.parse(await context.req.json());
  const future = futureTrade(context, body.tradeDate);
  if (future) return future;
  const result = await new LedgerService({
    db: context.env.DB,
    corporateActionProvider: new YahooCorporateActionProvider(),
  }).apply({
    expectedPositionBasisRevision: positionBasisRevision,
    proposal: {
      kind: "create",
      instrumentId: body.instrumentId,
      tradeDate: body.tradeDate,
      side: body.side,
      quantityDecimal: body.quantityDecimal,
      priceDecimal: body.priceDecimal,
    },
    ...(body.confirmation ? { confirmation: body.confirmation } : {}),
  });
  return mutationResponse(context, result, 201);
};

const updateTransaction = async (context: EventContext) => {
  const rejected = sameOriginAndAppRequest(context);
  if (rejected) return rejected;
  const positionBasisRevision = expectedPositionBasis(context);
  const eventRevision = parseEventIfMatch(context.req.header("If-Match"));
  if (positionBasisRevision === null || eventRevision === null)
    return missingPrecondition(context);
  const stale = await staleBasis(context, positionBasisRevision);
  if (stale) return stale;
  const body = updateSchema.parse(await context.req.json());
  const future = futureTrade(context, body.tradeDate);
  if (future) return future;
  const eventId = context.req.param("id");
  if (!eventId)
    return error(context, 422, "invalid_request", "The request is invalid.");
  const proposal: LedgerProposal = {
    kind: "update",
    eventId,
    expectedEventRevision: eventRevision,
    tradeDate: body.tradeDate,
    side: body.side,
    quantityDecimal: body.quantityDecimal,
    priceDecimal: body.priceDecimal,
  };
  const result = await new LedgerService({
    db: context.env.DB,
    corporateActionProvider: new YahooCorporateActionProvider(),
  }).apply({
    expectedPositionBasisRevision: positionBasisRevision,
    proposal,
    ...(body.confirmation ? { confirmation: body.confirmation } : {}),
  });
  return mutationResponse(context, result, 200);
};

const deleteTransaction = async (context: EventContext) => {
  const rejected = sameOriginAndAppRequest(context);
  if (rejected) return rejected;
  const positionBasisRevision = expectedPositionBasis(context);
  const eventRevision = parseEventIfMatch(context.req.header("If-Match"));
  if (positionBasisRevision === null || eventRevision === null)
    return missingPrecondition(context);
  const stale = await staleBasis(context, positionBasisRevision);
  if (stale) return stale;
  const eventId = context.req.param("id");
  if (!eventId)
    return error(context, 422, "invalid_request", "The request is invalid.");
  const result = await new LedgerService({
    db: context.env.DB,
    corporateActionProvider: new YahooCorporateActionProvider(),
  }).apply({
    expectedPositionBasisRevision: positionBasisRevision,
    proposal: {
      kind: "delete",
      eventId,
      expectedEventRevision: eventRevision,
    },
  });
  return mutationResponse(context, result, 200, { deleted: true });
};

const confirmSplitHistory = async (context: EventContext) => {
  const rejected = sameOriginAndAppRequest(context);
  if (rejected) return rejected;
  const positionBasisRevision = expectedPositionBasis(context);
  if (positionBasisRevision === null) return missingPrecondition(context);
  const stale = await staleBasis(context, positionBasisRevision);
  if (stale) return stale;
  const body = confirmSchema.parse(await context.req.json());
  const result = await new LedgerService({
    db: context.env.DB,
    corporateActionProvider: new YahooCorporateActionProvider(),
  }).confirmSplitHistory({
    expectedPositionBasisRevision: positionBasisRevision,
    instrumentId: body.instrumentId,
    confirmation: body.confirmation,
  });
  return mutationResponse(context, result, 200);
};

const methodNotAllowed = (allow: string) => (context: EventContext) => {
  context.header("Allow", allow);
  return error(
    context,
    405,
    "method_not_allowed",
    "This event method is not supported.",
  );
};

export const eventsRoutes = new Hono<{ Bindings: Env }>();

eventsRoutes.get("/", timeline);
eventsRoutes.post("/", createTransaction);
eventsRoutes.post("/transactions", createTransaction);
eventsRoutes.patch("/transactions/:id", updateTransaction);
eventsRoutes.delete("/transactions/:id", deleteTransaction);
eventsRoutes.patch("/:id", updateTransaction);
eventsRoutes.delete("/:id", deleteTransaction);
eventsRoutes.all("/transactions/:id", methodNotAllowed("PATCH, DELETE"));
eventsRoutes.all("/:id", methodNotAllowed("PATCH, DELETE"));
eventsRoutes.all("/transactions", methodNotAllowed("POST"));
eventsRoutes.all("/", methodNotAllowed("GET, POST"));
eventsRoutes.all("/*", methodNotAllowed("GET, POST, PATCH, DELETE"));

export const corporateActionRoutes = new Hono<{ Bindings: Env }>();

corporateActionRoutes.post("/confirm", confirmSplitHistory);
corporateActionRoutes.all("/confirm", (context) => {
  context.header("Allow", "POST");
  return error(
    context,
    405,
    "method_not_allowed",
    "This corporate-action method is not supported.",
  );
});
