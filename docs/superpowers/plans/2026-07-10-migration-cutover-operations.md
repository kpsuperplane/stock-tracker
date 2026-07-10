# Migration, Cutover, and Operational Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate published legacy facts, enable reliable production scheduling, prove performance/security, and cut over the new product with a rehearsed rollback path.

**Architecture:** A compatibility Worker dual-writes new published legacy results into normalized facts while a resumable high-water migrator copies historical published winners. Feature flags separate schema deployment, dual-write, new reads, and new writes so every transition is observable and reversible.

**Tech Stack:** Cloudflare Workers, D1, Queues/DLQ, Cron, Hono, TypeScript, Wrangler, Vitest, production diagnostics.

## Global Constraints

- Plans 1–3 must be accepted first.
- This plan intentionally leaves exact implementation code and signatures to implementing subagents.
- Migrations must remain additive; no legacy table or row may be deleted.
- Only the currently published legacy generation may win a normalized instrument/date key.
- Legacy-basis facts must refresh before they can become authoritative Portfolio/Calendar facts.
- D1 retains unfinished work independent of Queue retention.
- The 4:30 p.m. ET planner and 15-minute dispatcher are separate schedules.
- Current-day work must not be starved by historical reconciliation.
- No production flag advances without explicit evidence and a rollback checkpoint.
- Every task ends with focused validation, production-safe review, and a scoped commit.

---

## Intended project structure

| Path | Responsibility |
| --- | --- |
| `migrations/0004_migration_cutover_state.sql` | Migrator high-water, provenance audit, and cutover state |
| `src/db/migration-state.ts` | High-water, catch-up, hash, and audit repository |
| `src/services/legacy-fact-migrator.ts` | Published-winner resumable conversion |
| `src/services/legacy-dual-write.ts` | Compatibility writes after legacy publication |
| `src/worker/routes/migrations.ts` | Protected operational migration status/advance API if needed |
| `src/worker/scheduled.ts` | 4:30 p.m. ET planner and 15-minute dispatcher routing |
| `src/worker/queue.ts` | Compatibility routing between legacy and work-item consumers |
| `src/config/features.ts` | Typed read/write/dual-write feature flags |
| `src/config/deploy-safety.test.ts` | Flag, binding, Cron, migration, and production safety assertions |
| `wrangler.jsonc` | Production Cron, Queue, DLQ, and feature bindings |
| `wrangler.test.jsonc` | Local equivalents isolated from production |
| `docs/operations/portfolio-cutover.md` | Stepwise rollout and rollback runbook |
| `docs/operations/portfolio-diagnostics.md` | Metrics, logs, queries, and incident actions |

---

### Task 1: Add feature flags and production-safe bindings

**Files:**

- Create `src/config/features.ts` and update environment types/tests.
- Modify Wrangler production/test configs and deploy-safety tests.
- Do not enable new reads or writes.

**Interfaces:**

- Separate flags control dual-write, migrator execution, new reads, and new writes.
- Queue bindings distinguish primary work delivery and DLQ.
- Cron routing distinguishes local-time planner triggers and recurring dispatcher.

- [ ] Add failing config tests for missing/invalid flags, production/test binding separation, DLQ presence, both DST planner triggers, 15-minute dispatcher, and unchanged Basic Auth/assets bindings.
- [ ] Add typed defaults with every new behavior off.
- [ ] Configure Queue/DLQ retention and consumer settings consistent with D1-authoritative work.
- [ ] Configure both possible 4:30 p.m. ET UTC triggers and the recurring dispatcher trigger.
- [ ] Run deploy-safety tests, type generation, `npm run typecheck`, and local Wrangler validation.
- [ ] Request Cloudflare configuration review.
- [ ] Commit with message `chore: prepare portfolio production flags`.

### Task 2: Add compatibility dual-write

**Files:**

- Create `src/services/legacy-dual-write.ts` and focused tests.
- Modify the existing legacy report finalization boundary in `src/db/runs.ts` or its extracted successor, keeping legacy publication authoritative.

**Interfaces:**

- After a legacy generation becomes published, compatibility logic upserts normalized fact/analysis/source rows with legacy provenance and basis.
- Failure is observable and retryable but must not roll back or corrupt the already-valid legacy publication.

- [ ] Add failing tests for one published winner, replacement generation, unpublished exclusion, duplicate finalization, partial analysis, missing price, soft-deleted ticker, provenance, and retry after dual-write failure.
- [ ] Implement idempotent compatibility writes behind the dual-write flag.
- [ ] Add safe structured diagnostics and a D1 repair marker for failed compatibility writes.
- [ ] Run existing report tests, dual-write tests, and `npm run check` with flags off/on in test fixtures.
- [ ] Request regression review focused on publication atomicity.
- [ ] Commit with message `feat: dual-write published portfolio facts`.

### Task 3: Build the resumable published-generation migrator

**Files:**

- Create migration-state schema/repository/service/tests and operational status route if required.
- Add representative multi-generation legacy fixtures.

**Interfaces:**

- Copies all referenced ticker identities, including soft-deleted ones.
- Chooses only `published = 1` screening per instrument/date.
- Persists legacy run/screening/generation provenance and content hash.
- Advances a durable high-water mark and supports repeated catch-up passes.

- [ ] Add failing tests for multiple generations, publication replacement during migration, deleted identities, missing analyses, legacy basis labels, duplicate rerun, interrupted page, high-water resume, and provenance hash mismatch.
- [ ] Implement bounded pages and idempotent upserts; never perform a monolithic remote migration.
- [ ] Add audit output for examined, inserted, updated, unchanged, skipped, and mismatched rows.
- [ ] Add the requirement for two consecutive catch-up passes with no unexplained differences.
- [ ] Run local D1 migration against fresh and representative legacy databases.
- [ ] Request data-loss and winner-determinism review.
- [ ] Commit with message `feat: migrate published portfolio facts safely`.

### Task 4: Wire planner, dispatcher, and Queue recovery schedules

**Files:**

- Modify `src/worker/scheduled.ts`, `src/worker/queue.ts`, `src/worker/index.ts`, and scheduler/queue tests.
- Use Plan 2 services; do not duplicate pipeline logic in handlers.

**Interfaces:**

- Planner performs work only at 4:30 p.m. America/Toronto across DST.
- Dispatcher runs every 15 minutes, recovers leases, applies priority/ceiling rules, and dispatches D1 work.
- Queue routes legacy messages and new dispatch-batch messages safely during transition.

- [ ] Add failing tests for both DST seasons, no-op duplicate UTC trigger, weekend/holiday behavior, delayed-bar six-hour horizon, 15-minute recovery, daily ceiling, priority fairness, send failure, DLQ, and next-day recovery.
- [ ] Implement handlers behind the new-write flag while legacy Cron/queue remains active when off.
- [ ] Prove D1 work survives Queue retention and consumer restart in integration tests.
- [ ] Run scheduler, queue, lease-race, and existing production-safety suites.
- [ ] Request operational concurrency review.
- [ ] Commit with message `feat: schedule portfolio reconciliation`.

### Task 5: Enforce final security and retention controls

**Files:**

- Modify API middleware, import cleanup, work cleanup, URL validation, logging, and security tests from earlier plans.
- Create or update operational retention documentation.

**Interfaces:**

- Every mutation enforces same-origin Host/Origin plus the non-simple app header.
- Source URLs persist/render only as absolute HTTP(S).
- Preview rows, completed work, job summaries, terminal/DLQ records, digests, and authoritative facts follow approved retention periods.

- [ ] Add cross-origin multipart form, missing custom header, forged Host/Origin, stale If-Match, invalid URL scheme, oversized upload, log-redaction, and cleanup-resume tests.
- [ ] Verify Basic Auth credentials and provider/model payloads never reach logs.
- [ ] Implement scheduled cleanup as low-priority D1 work.
- [ ] Run auth/security/import/work tests and `npm run check`.
- [ ] Request security/privacy review.
- [ ] Commit with message `fix: harden portfolio mutations and retention`.

### Task 6: Prove performance and free-tier behavior

**Files:**

- Add benchmark fixtures/helpers under `tests/performance/` or the repository's established test location.
- Update diagnostic documentation with measured budgets and commands.

**Interfaces:**

- Measures queries, D1 rows read/written, Worker CPU, serialized response size, provider calls, and Queue operations.
- Exercises 100 current instruments, 10,000 transactions, five years of facts, and a busy Calendar month.

- [ ] Measure cold Portfolio, cold Calendar month/week, unchanged conditional `304`, ledger mutation, historical reconciliation, Backfill, and migration catch-up.
- [ ] Assert unchanged conditional reads touch at most ten revision/bucket rows.
- [ ] Assert historical-month updates do not invalidate Portfolio `latest` or unrelated Calendar months.
- [ ] Assert market work batches provider calls rather than fetching each date.
- [ ] Verify current-day priority under a large historical backlog and the daily soft dispatch ceiling.
- [ ] Record actual budgets and fail tests on regression beyond approved tolerances.
- [ ] Request performance review based on rows scanned rather than query count alone.
- [ ] Commit with message `test: enforce portfolio performance budgets`.

### Task 7: Rehearse staged read cutover and rollback

**Files:**

- Create `docs/operations/portfolio-cutover.md` and any feature-flag verification tests.
- Do not enable production flags as part of the code commit.

**Interfaces:**

- Defines exact observable checkpoints for schema, compatibility dual-write, historical migration, catch-up, new reads, new writes, and rollback.

- [ ] Document preflight backups/exports, remote migration list, Queue/DLQ checks, auth checks, feature defaults, and diagnostics.
- [ ] Run dual-write with new reads/writes off in a production-like environment.
- [ ] Complete migration through high-water and two clean catch-up passes.
- [ ] Compare sampled normalized API output, provenance hashes, counts, and legacy reports.
- [ ] Enable new reads only, verify all four pages, then disable and confirm immediate legacy rollback.
- [ ] Record evidence and unresolved deviations before authorizing write cutover.
- [ ] Request ship-readiness review.
- [ ] Commit the runbook/evidence template with message `docs: add portfolio cutover runbook`.

### Task 8: Cut over writes and complete production verification

**Files:**

- No new architecture files should be introduced. Changes are limited to verified feature defaults/configuration and documentation.

**Interfaces:**

- Produces the production-enabled read/write path, retained legacy rollback path, and final operational evidence.

- [ ] Enter a short dispatch freeze and confirm no legacy work remains mid-publication.
- [ ] Run final migrator catch-up and provenance/hash comparison.
- [ ] Enable new writes, resume through the 15-minute dispatcher, and keep compatibility reads available.
- [ ] Verify 4:30 p.m. ET planning, delayed-bar retries, Queue/DLQ state, Backfill, event mutation reconciliation, Portfolio, and Calendar.
- [ ] Run `npm run check`, remote migration status, safe tail diagnostics, and performance probes.
- [ ] Rehearse the documented rollback without deleting normalized or legacy data.
- [ ] Keep legacy tables read-only and retained after acceptance.
- [ ] Request final adversarial review and explicit user approval before any cleanup proposal.
- [ ] Commit only approved configuration/documentation changes with message `chore: complete portfolio cutover`.

Plan 4 is complete only when cutover evidence passes, rollback remains viable, and no legacy data has been removed.
