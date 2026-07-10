# Stock Movement Explainer

Personal, password-protected daily reports for US and Canadian watchlist symbols. The application screens completed daily bars for movements of at least 5%, then explains likely catalysts in Simplified Chinese using English news metadata. Price data and news feeds are unofficial, and explanations are not investment advice.

## Local development

Requirements: Node.js 22.12 or newer and npm.

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
npx playwright install chromium
npm run test:e2e
```

`npm run check` regenerates Worker types, checks formatting/lint and TypeScript, runs unit and local D1/Worker tests, and creates the production build. Browser tests cover phone and desktop report, history, watchlist, and backfill flows.

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

Commit the real D1 identifier and regenerated `worker-configuration.d.ts` written after bootstrap. The checked-in `local-placeholder` identifier is not a production resource. Secrets are entered interactively and must never be stored in Git or shell history.

## Automatic deployment

1. Protect GitHub `main`: require pull requests and the `CI / verify` check, and block direct pushes.
2. In Cloudflare Workers Builds, connect this repository and select `main` as the production branch.
3. Set the build command to `npm ci` and the deploy command to `npm run deploy:production`.
4. Disable non-production branch deployments initially.
5. Use a scoped Cloudflare build token with only Workers Scripts and D1 edit permissions.

Cloudflare remains the production deployer. The deploy script reruns local gates, applies versioned remote D1 migrations, and deploys only when each preceding step succeeds.

## Operations

- The scheduled screen runs at 22:00 UTC Monday through Friday.
- The Today and Backfill pages are the primary progress and partial-error views.
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
