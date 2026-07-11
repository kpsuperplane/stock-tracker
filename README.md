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

The ledger API is intentionally available for tests and later UI work, but the
current dashboard and navigation remain the legacy report experience until the
Portfolio/Events UI is delivered. Do not link these routes from the existing
application yet.

- `GET /api/events` returns the reverse-chronological transaction/split timeline
  and its position-basis revision. It accepts bounded `limit`, `cursor`,
  `instrumentId`, `symbol`, and `type` filters.
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

One Cloudflare Worker protects the React static assets and Hono API with HTTP Basic Authentication. D1 retains ticker snapshots and published report generations, a weekday Cron Trigger starts work at 22:00 UTC, Cloudflare Queues fan out per-ticker screening, and Workers AI is called at most once for each qualifying mover with news.

- Maximum 100 active tickers.
- Maximum 30 inclusive calendar days per backfill.
- Maximum 10 deduplicated news items per mover.
- Daily soft dispatch ceiling of 2,500 ticker messages; remaining D1 work resumes on a later dispatcher invocation.
- No automatic paid fallback or plan upgrade.
- Missing full-market data never publishes an empty holiday report.
- Reprocessing retains the old published generation until the replacement completes.

## Production bootstrap

These steps require an authenticated Cloudflare account and are intentionally not part of local verification:

```bash
npx wrangler login
npx wrangler d1 create stock-tracker --binding DB --update-config --location enam
npx wrangler queues create stock-tracker-screenings --message-retention-period-secs 86400
npm run types:worker
npx wrangler d1 migrations apply DB --remote
npx wrangler secret put BASIC_AUTH_USERNAME
npx wrangler secret put BASIC_AUTH_PASSWORD
npm run deploy:production
```

Commit the real D1 identifier and regenerated `worker-configuration.d.ts` written after bootstrap. Secrets are entered interactively and must never be stored in Git or shell history.

## Automatic deployment

1. Protect GitHub `main`: require pull requests and the `CI / verify` check, and block direct pushes.
2. In Cloudflare Workers Builds, connect this repository and select `main` as the production branch.
3. Set the build command to `npm ci` and the deploy command to `npm run deploy:production`.
4. Disable non-production branch deployments initially.
5. Use a scoped Cloudflare build token with only Workers Scripts and D1 edit permissions.

Cloudflare remains the production deployer. The deploy script reruns local gates, applies versioned remote D1 migrations, and deploys only when each preceding step succeeds.

## Operations

- The scheduled screen runs at 22:00 UTC Monday through Friday.
- The report timeline and Backfill controls are the primary progress and partial-error views.
- Use Backfill with **Reprocess existing reports** to atomically replace a date.
- Use a mover's **Retry explanation** action only when price data exists but analysis failed.
- Stale queued/processing leases are reconciled from D1 before dispatch.
- Provider timeouts, HTTP 429 responses, and 5xx responses retry at most three attempts with backoff. Terminal errors remain visible per ticker and never suppress successful movers.
- Rotate the two Basic Auth Worker secrets to revoke cached browser access.

Useful production diagnostics:

```bash
npx wrangler tail --format json
npx wrangler d1 migrations list DB --remote
npx wrangler d1 migrations apply DB --remote
```

Logs contain safe run/screening/provider identifiers and bounded error codes, never credentials, authorization headers, or full provider payloads.
