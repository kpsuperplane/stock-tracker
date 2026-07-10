# Portfolio Ledger Expansion Implementation Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to execute the linked plans. Do not begin a later plan until the preceding plan's review gate passes.

**Goal:** Deliver the approved Portfolio, Events, Calendar, and Backfill experience through four testable implementation phases without destabilizing the existing report application.

**Architecture:** Transactions and user-confirmed split actions form the position basis; reusable market/source-reported-dividend/analysis facts are maintained by a D1-backed work pipeline; Portfolio and Calendar combine derived holdings with those facts. The rollout is additive, dual-written, feature-flagged, and reversible until final cutover.

**Tech Stack:** TypeScript, React 19, Vite, Hono, Cloudflare Workers, D1, Queues, Cron, Workers AI, ASTRYX neutral theme, Vitest.

## Global Constraints

- This is a structural execution plan. It intentionally contains no implementation snippets or prescribed function bodies; implementing subagents own exact code choices.
- The approved specification is the authority: `docs/superpowers/specs/2026-07-10-portfolio-ledger-calendar-expansion-design.md`.
- Preserve HTTP Basic Authentication and the single-user deployment model.
- Holdings must remain derived; do not add current-holdings rows, daily holdings rows, or checkpoints.
- Portfolio valuation uses latest raw completed close. Movement uses split-adjusted, dividend-unadjusted price return.
- Static UI copy supports English and Simplified Chinese. Stored summaries remain Simplified Chinese.
- Use exact pinned ASTRYX packages with the neutral theme; keep custom CSS limited to the event calendar, financial alignment, and unavoidable overflow.
- All authoritative mutations use the trigger-enforced position-basis revision.
- Best-effort split snapshots never authorize mutations automatically; confirmation binds the required range to an exact provider revision and is invalidated when that revision changes.
- Dividend rows are source-reported and incomplete; absence of a future row means no event is currently known from that source.
- D1 is the source of truth for unfinished work; Queue messages are transient delivery hints.
- No task may remove or destructively rewrite legacy report data during this roadmap.
- Every implementation task follows TDD, focused validation, adversarial review, and a scoped commit.

---

## Plan sequence

### Plan 1 — Ledger and Events foundation

File: `docs/superpowers/plans/2026-07-10-ledger-events-foundation.md`

Produces:

- best-effort provider evidence and normalized split/dividend contracts;
- additive instrument, transaction, split-confirmation, candidate-action, mutation-guard, import, pipeline-job, and job-scoped planning-work schema;
- exact decimal and holdings-domain boundaries;
- concurrency-safe Events CRUD and atomic CSV preview/commit APIs;
- no user-visible replacement of the existing dashboard yet.

Gate: authoritative ledger behavior passes domain and local D1 concurrency tests, including explicit split-history confirmation, provider-revision invalidation, and quarantined corrections.

### Plan 2 — Normalized facts and reconciliation pipeline

File: `docs/superpowers/plans/2026-07-10-normalized-facts-pipeline.md`

Consumes Plan 1's position basis and produces:

- normalized market, analysis, source, dividend, revision-bucket, job, work-item, and dispatch-batch schema;
- fact-granular global deduplication with job-scoped planning;
- range-batched provider retrieval, transactional outbox, leases, DLQ, and 15-minute reconciliation;
- read-model services for Portfolio, Calendar, Events, and job status;
- legacy writes remain authoritative during this phase.

Gate: shared-work progress, send/claim races, range batching, retries, and conditional read performance pass integration tests.

### Plan 3 — Portfolio, Calendar, Events, and ASTRYX UI

File: `docs/superpowers/plans/2026-07-10-portfolio-calendar-ui.md`

Consumes Plans 1–2 and produces:

- ASTRYX neutral AppShell and persistent sidebar;
- lightweight EN/CN translation boundary;
- functional Portfolio and Events pages;
- custom ASTRYX-convention monthly/weekly event calendar;
- Backfill and reconciliation progress UI;
- responsive and accessibility coverage.

Gate: the four pages pass component, desktop/mobile, keyboard, bilingual, stale/pending/error, and Calendar interaction tests behind a disabled-by-default feature flag.

### Plan 4 — Migration, cutover, and operations

File: `docs/superpowers/plans/2026-07-10-migration-cutover-operations.md`

Consumes Plans 1–3 and produces:

- compatibility dual-write deployment;
- resumable published-generation migration with provenance and high-water catch-up;
- 4:30 p.m. ET planner, 15-minute dispatcher, queue/DLQ configuration, priority and quota controls;
- read/write cutover feature flags and rollback procedure;
- final performance, security, data-equivalence, and production verification.

Gate: two clean catch-up passes, sampled hash equivalence, bounded D1 rows read/provider calls, successful rollback rehearsal, and full `npm run check` before enabling the new read path.

## Cross-plan ownership

| Boundary | Owning plan | Later consumers |
| --- | --- | --- |
| Decimal and holdings semantics | Plan 1 | Plans 2–4 |
| Position-basis revision and mutation guard | Plan 1 | Plans 2 and 4 |
| Best-effort provider contracts | Plan 1 | Plans 2 and 4 |
| Split review/confirmation semantics | Plan 1 | Plans 2–4 |
| Normalized facts and revision buckets | Plan 2 | Plans 3 and 4 |
| Job/work/outbox lifecycle | Plan 2 | Plans 3 and 4 |
| Portfolio/Calendar read models | Plan 2 | Plan 3 |
| ASTRYX shell, i18n, and pages | Plan 3 | Plan 4 |
| Migration, schedules, flags, and production operations | Plan 4 | Production |

## Execution policy

- Use one fresh implementation subagent per task, with file ownership limited to that task's listed modules.
- After each task, run a spec-conformance review and a code-quality review before accepting the commit.
- Later subagents may choose exact types, signatures, helper functions, and internal algorithms, but may not alter the approved architectural invariants.
- A subagent that discovers a provider/platform assumption invalidating the specification must stop and report evidence; it must not silently broaden scope or substitute a different behavior.
- Keep the current dashboard operational at the end of every accepted task and plan.

## Final acceptance

The roadmap is complete only when all four plan gates pass, the new feature flag is enabled, the legacy read path remains available for rollback, and the full acceptance criteria in the approved design specification are demonstrated.
