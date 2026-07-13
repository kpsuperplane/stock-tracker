# Stock Movement Explainer

Personal, password-protected daily reports for US and Canadian watchlist symbols. The application screens completed daily bars for movements of at least 5%, then explains likely catalysts in Simplified Chinese using English news metadata. Price data and news feeds are unofficial, and explanations are not investment advice.

## Local development

Requirements: Node.js 22.13 or newer and npm.

```bash
npm ci
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply DB --local
npm run dev
```

Open <http://127.0.0.1:5173> and use the credentials from `.dev.vars`. Never commit `.dev.vars`.

The Portfolio/Events/Calendar/Backfill shell is the only UI. Its derived read
models remain server-side gates: copy the commented `READ_MODELS_ENABLED=true`
line into `.dev.vars` before previewing Portfolio, Calendar, or normalized
reconciliation jobs, then run:

```bash
npm run dev
```

If the read models are disabled, Portfolio and Calendar show an explicit
read-model-disabled message instead of silently treating a 404 as empty data.

### Application UI

The persistent navigation links to four stable destinations:

- **Portfolio** shows today’s derived holdings, quantity, native-currency
  valuation, latest completed close movement, and Chinese analysis/source links
  for qualifying movers.
- **Events** is the source of truth for holdings. Add, edit, or delete a buy or
  sell, or use **Import CSV** to preview rows, review projected holdings, confirm
  provider split history, and commit the staged batch. A successful commit
  queues reconciliation; it does not write a second holdings table.
- **Calendar** shows historical movers, ex-dividend events, and Alpha Vantage
  earnings dates in month or week view. Earnings appear only when the selected
  account scope held shares at the start of the report date.
- **Backfill** starts a bounded historical refresh and shows manual and automatic
  reconciliation progress. Work counts, partial errors, retryable items, and
  background continuation remain visible after navigation. The page merges the
  normalized pipeline list with the legacy backfill list, so turning the
  normalized Backfill flag off does not make older manual runs disappear.

The sidebar language control switches static labels between **EN** and **中文**
and persists the choice locally. Stored LLM summaries remain Simplified Chinese
in either locale. On narrow screens, forms wrap and ASTRYX tables expose a
keyboard-focusable horizontal scroll region; the calendar intentionally keeps
its dense seven-column grid scrollable rather than hiding event details.

Whenever bindings change in `wrangler.jsonc`, regenerate and commit the binding-aware Worker types:

```bash
npm run types:worker
```

## Verification

```bash
npm run check
```

`npm run check` regenerates Worker types, checks formatting/lint and TypeScript, runs service and local D1/Worker tests, and creates the production build.

Worker integration tests use the local-only `wrangler.test.jsonc`. Keep that test configuration separate from `wrangler.jsonc`; pointing Vitest at the production configuration can connect remote bindings and mutate deployed Worker state.

## Portfolio-events foundation (development notes)

The ledger API backs the Events and Portfolio experience and remains available
to integration tests and external clients.

- `GET /api/events` returns the reverse-chronological transaction/split timeline
  and its position-basis revision. It accepts bounded `limit`, `cursor`,
  `instrumentId`, `symbol`, and `type` filters.
- The product UI reads the same authenticated timeline from
  `/data/ledger`; this neutral read path avoids browser environments that
  block generic `/api/*` fetches before they reach the Worker.
- `POST /api/events` creates a transaction. `PATCH` and `DELETE`
  `/api/events/:id` require both the current `X-Position-Basis-Revision` and
  the transaction `If-Match: "event-N"` revision. A create requires the basis
  revision; successful mutations return the new basis revision and reconciliation
  job ID.
- `POST /api/corporate-actions/confirm` and any transaction confirmation identify
  only the server-fetched split snapshot by requested range and provider
  revision. Clients never submit split rows. A historical mutation remains
  blocked until that exact best-effort snapshot is explicitly confirmed; a
  changed provider revision requires review again.
- Every mutation is authenticated and must include a same-origin `Origin`, the
  matching `Host`, and `X-Stock-Tracker-Request: 1`. Ordinary mutations use
  JSON and the 64 KiB API body limit.

### CSV events template

`public/templates/portfolio-events.csv` is the only supported UTF-8 import
shape. Its exact header is
`trade_date,symbol,side,quantity,price`; dates are `YYYY-MM-DD`, sides are
case-insensitive `BUY`/`SELL`, and quantity/price are positive canonical
decimals with at most six fractional digits. Preview accepts at most 5 MiB,
10,000 data rows, and 40 distinct symbols. The symbol cap keeps synchronous
split-history checks within a Worker request budget; split larger imports into
separate files.

Use `POST /api/event-imports/preview` as `multipart/form-data` with one `file`
part. Preview stages normalized rows and returns any split histories needing
review without changing transactions. Commit the returned batch with
`POST /api/event-imports/:id/commit`, JSON confirmations, and the previewed
`X-Position-Basis-Revision`. Commit reads staged rows rather than reparsing the
file and is all-or-nothing; a stale revision, expired preview, or changed split
snapshot requires a new preview/review. Committed-file digests are retained for
duplicate detection, while staging rows expire.

## Architecture and guardrails

One Cloudflare Worker protects the React static assets and Hono API with HTTP Basic Authentication. D1 retains ticker snapshots and published report generations, the legacy weekday Cron Trigger starts work at 22:00 UTC, Cloudflare Queues fan out per-ticker screening, and Workers AI is called at most once for each qualifying mover with news. The disabled-by-default portfolio cutover adds 20:30/21:30 UTC planner candidates (the two Toronto 4:30 p.m. DST offsets) and a separate 15-minute dispatcher trigger; later tasks will route those triggers.

- Maximum 100 active tickers.
- Maximum 30 inclusive calendar days per backfill.
- Maximum 10 deduplicated news items per mover.
- Daily soft dispatch ceiling of 2,500 ticker messages; remaining D1 work resumes on a later dispatcher invocation.
- No automatic paid fallback or plan upgrade.
- Missing full-market data never publishes an empty holiday report.
- Reprocessing retains the old published generation until the replacement completes.
- The normalized Queue handler is feature-flagged and currently wires the
  Plan 2 D1 outbox/lease consumer only; provider and LLM execution remains an
  explicit processor injection at cutover. With the default flag off, no
  normalized envelope is consumed and D1 work remains the source of truth.

## Production bootstrap

These steps require an authenticated Cloudflare account and are intentionally not part of local verification:

```bash
npx wrangler login
npx wrangler d1 create stock-tracker --binding DB --update-config --location enam
npx wrangler queues create stock-tracker-screenings --message-retention-period-secs 86400
npx wrangler queues create stock-tracker-normalized-work --message-retention-period-secs 86400
npx wrangler queues create stock-tracker-normalized-work-dlq --message-retention-period-secs 1209600
npm run types:worker
npx wrangler d1 migrations apply DB --remote
npx wrangler secret put BASIC_AUTH_USERNAME
npx wrangler secret put BASIC_AUTH_PASSWORD
npx wrangler secret put ALPHA_VANTAGE_API_KEY
npm run deploy:production
```

Queue retention is intentionally bounded by Cloudflare's 14-day maximum;
unfinished work and one-year terminal/DLQ audit records remain authoritative
in D1 rather than depending on Queue retention.

Commit the real D1 identifier and regenerated `worker-configuration.d.ts` written after bootstrap. Secrets are entered interactively and must never be stored in Git or shell history.

## Automatic deployment

1. Protect GitHub `main`: require pull requests and the `CI / verify` check, and block direct pushes.
2. In Cloudflare Workers Builds, connect this repository and select `main` as the production branch.
3. Set the build command to `npm ci` and the deploy command to `npm run deploy:production`.
4. Disable non-production branch deployments initially.
5. Use a scoped Cloudflare build token with only Workers Scripts and D1 edit permissions.

Cloudflare remains the production deployer. The deploy script reruns local gates, applies versioned remote D1 migrations, and deploys only when each preceding step succeeds.

## Operations

- The legacy scheduled screen runs at 22:00 UTC Monday through Friday. The normalized portfolio planner candidates run at 20:30 and 21:30 UTC Monday through Friday, with a separate 15-minute dispatcher; all portfolio cutover behavior remains disabled by default.
- The report timeline and Backfill controls are the primary progress and partial-error views.
- Use Backfill with **Reprocess existing reports** to atomically replace a date.
- Use a mover's **Retry explanation** action only when price data exists but analysis failed.
- Stale queued/processing leases are reconciled from D1 before dispatch.
- Queued batches are resent from D1 on each 15-minute pass, including after a
  flag-off Queue acknowledgement; Queue delivery is therefore advisory and
  never the only copy of unfinished work.
- Provider timeouts, HTTP 429 responses, and 5xx responses retry at most three attempts with backoff. Terminal errors remain visible per ticker and never suppress successful movers.
- The normalized planner is guarded at 16:30 America/Toronto (both 20:30 and
  21:30 UTC candidates are configured); the first candidate that maps to a
  Toronto weekday owns the deterministic date key and a duplicate is a no-op.
  Delayed daily bars remain retryable for a six-hour horizon. Dispatcher leases
  are five minutes, consumer processing leases are ten minutes, and queued
  envelopes are eligible for resend after ten minutes; the recurring
  15-minute dispatcher recovers each state from D1.
- Rotate the two Basic Auth Worker secrets to revoke cached browser access.

Useful production diagnostics:

```bash
npx wrangler tail --format json
npx wrangler d1 migrations list DB --remote
npx wrangler d1 migrations apply DB --remote
```

Logs contain safe run/screening/provider identifiers and bounded error codes, never credentials, authorization headers, or full provider payloads.
