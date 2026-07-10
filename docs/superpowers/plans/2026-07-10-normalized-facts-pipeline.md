# Normalized Facts and Reconciliation Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build reusable market/dividend/analysis facts and a resumable D1-backed reconciliation pipeline without cutting over legacy production reads or schedules.

**Architecture:** Jobs own job-scoped planning work and attach to globally deduplicated fact work. A D1 transactional outbox groups compatible fact-granular market work into transient provider-range batches, while revision buckets support inexpensive conditional Portfolio and Calendar reads.

**Tech Stack:** TypeScript, Cloudflare D1, Queues, Hono, Yahoo/provider adapters, news providers, Workers AI, Vitest.

## Global Constraints

- Plan 1 must be accepted first.
- This plan intentionally leaves exact code and signatures to implementing subagents.
- Legacy report tables and current production scheduler remain authoritative throughout this plan.
- Market valuation facts use raw close; movement uses split-adjusted, dividend-unadjusted raw-close return.
- Logical work is deduplicated per fact/date. Provider range batching occurs only at dispatch.
- Job planning is job-scoped and must attach shared child work independently for every job.
- D1 persists all unfinished work; Queue delivery is at least once and disposable.
- Current-day work outranks manual Backfill, which outranks historical reconciliation.
- No user-visible UI replacement occurs in this plan.

---

## Intended project structure

| Path | Responsibility |
| --- | --- |
| `migrations/0003_normalized_facts_pipeline.sql` | Facts, revision buckets, dispatch batches, and supporting indexes |
| `src/db/market-facts.ts` | Daily raw/split-adjusted facts repository |
| `src/db/dividends.ts` | Dividend fact repository |
| `src/db/analyses.ts` | Movement analysis and source repository |
| `src/db/pipeline-jobs.ts` | Extend Plan 1 repository with aggregation behavior |
| `src/db/work-items.ts` | Extend Plan 1 repository with global work and leases |
| `src/db/dispatch-batches.ts` | Transactional outbox and range-batch repository |
| `src/db/revision-buckets.ts` | `latest` and `YYYY-MM` fact revisions |
| `src/services/market-facts.ts` | Range normalization and price-return semantics |
| `src/services/dividend-facts.ts` | Dividend upsert/freshness orchestration |
| `src/services/reconciliation-planner.ts` | Eligibility diff to job/global work links |
| `src/services/work-dispatcher.ts` | Priority, batching, ceiling, send, and recovery |
| `src/services/portfolio-read-model.ts` | Derived Portfolio DTO and ETag |
| `src/services/calendar-read-model.ts` | Range-bounded Calendar DTO and ETag |
| `src/services/job-read-model.ts` | Job progress/error projection |
| `src/worker/pipeline-queue.ts` | New work-item consumer, not yet production-wired |
| `src/worker/routes/portfolio.ts` | Feature-flagged Portfolio API |
| `src/worker/routes/calendar.ts` | Feature-flagged Calendar API |
| `src/worker/routes/pipeline-jobs.ts` | Job status API |
| `tests/worker/pipeline-*.test.ts` | D1/outbox/concurrency integration suites |

---

### Task 1: Add normalized fact and work schema

**Files:**

- Create `migrations/0003_normalized_facts_pipeline.sql` and the new fact/dispatch/revision repositories; modify the Plan 1 job/work repositories.
- Extend migration test fixtures without modifying legacy table definitions.

**Interfaces:**

- Produces `daily_market_facts`, `movement_analyses`, `news_sources`, `dividend_events`, `fact_revision_buckets`, `dispatch_batches`, and `dispatch_batch_items`.
- Consumes the existing `pipeline_jobs`, `work_items`, and `job_work_items` schema from Plan 1 and adds their complete repository/state-machine behavior.
- Supports job-scoped planning keys, global fact keys, forced-refresh generations, leases, priorities, terminal errors, and retention timestamps.

- [ ] Write migration tests for constraints, deterministic uniqueness, job/work many-to-many links, dispatch-batch compatibility, revision buckets, forced refreshes, and legacy preservation.
- [ ] Write repository tests proving two jobs can link to one global fact while retaining independent progress.
- [ ] Write tests proving planning work includes its owning job ID and cannot be reused by another job.
- [ ] Implement repositories with state transitions centralized rather than scattered through services.
- [ ] Run focused Worker migration/repository tests and `npm run typecheck`.
- [ ] Request schema/state-machine review.
- [ ] Commit with message `feat: add normalized fact and work schema`.

### Task 2: Normalize market ranges and price semantics

**Files:**

- Modify `src/domain/market.ts`, `src/providers/market-data.ts`, and relevant provider fixtures.
- Create `src/services/market-facts.ts` and focused tests.
- Preserve legacy screening service behavior until Plan 4.

**Interfaces:**

- Consumes bounded provider ranges plus validated active split actions.
- Produces fact-granular raw closes, split factors, split-adjusted comparison price, amount/percentage return, basis, revision, and freshness.

- [ ] Add failing cases for ordinary days, weekends, holidays, missing previous bar, 2:1 split, reverse split, ex-dividend price drop, provider correction, and range-boundary lookback.
- [ ] Add an assertion that amount and percentage movement use the same split-adjusted basis.
- [ ] Add a range test proving one provider response materializes all completed facts without per-date fetches.
- [ ] Implement the new fact service separately from the legacy calculation path.
- [ ] Run domain/provider/service tests and `npm run typecheck`.
- [ ] Request financial-semantics review.
- [ ] Commit with message `feat: normalize portfolio market facts`.

### Task 3: Persist dividends, analyses, and revision buckets

**Files:**

- Create `src/services/dividend-facts.ts` and repositories/tests for dividends, analyses, sources, and revisions.
- Reuse existing news/explanation adapters behind normalized inputs.

**Interfaces:**

- Dividend writes update only affected `YYYY-MM` buckets.
- Current/latest market or analysis changes update `latest`; historical changes update their month.
- Analysis dependency fingerprint covers movement revision and normalized news evidence.

- [ ] Add failing tests for dividend identity/correction, native currency, announced future event, stale refresh, source URL schemes, analysis reuse, and dependency invalidation.
- [ ] Add bucket tests proving a historical update does not change Portfolio `latest` or unrelated months.
- [ ] Add last-valid-result tests for failed market/analysis refreshes.
- [ ] Implement atomic fact-plus-bucket updates.
- [ ] Run focused fact tests and `npm run typecheck`.
- [ ] Request data-freshness and source-safety review.
- [ ] Commit with message `feat: persist reusable portfolio facts`.

### Task 4: Build job-scoped planning and shared child work

**Files:**

- Create `src/services/reconciliation-planner.ts` and planner tests.
- Execute the job-scoped planning items that Plan 1 already creates atomically.

**Interfaces:**

- Consumes stored minimal eligibility intervals and fact freshness.
- Produces paged global fact work plus a complete `job_work_items` attachment set for the owning job.
- Quantity-only positive-position changes create no market/analysis work.

- [ ] Add failing tests for quantity-only edits, newly held/unheld intervals, split correction, dividend-only recalculation, legacy-basis refresh, forced Backfill generation, and long historical pagination.
- [ ] Add the first-current-buy case proving the latest completed price pair is requested immediately rather than waiting for the next daily planner.
- [ ] Add the two-job regression: Job B links to a completed planning-independent global fact set and still receives every required child link.
- [ ] Add priority tests for current-day, Backfill, and automatic reconciliation jobs.
- [ ] Implement idempotent planner pages and job aggregation.
- [ ] Run planner and repository tests plus `npm run typecheck`.
- [ ] Request adversarial shared-work review.
- [ ] Commit with message `feat: plan incremental portfolio reconciliation`.

### Task 5: Build transactional dispatch, batching, and recovery

**Files:**

- Create `src/services/work-dispatcher.ts`, `src/worker/pipeline-queue.ts`, and dispatch integration tests.
- Modify `wrangler.test.jsonc` only for local test queue/DLQ bindings.

**Interfaces:**

- Dispatcher groups compatible contiguous market fact work into at most 90-calendar-day batches.
- Queue messages contain only dispatch-batch ID.
- Consumer may claim an unexpired matching batch from `dispatching` or `queued`; post-send acknowledgement cannot overwrite `processing`.

- [ ] Add failing tests for send failure, crash before acknowledgement, consumer-before-ack race, duplicate send, duplicate delivery, expired dispatch lease, expired processing lease, provider partial range, attempt ceiling, terminal D1 record, and DLQ routing.
- [ ] Add daily-ceiling and priority/fairness tests.
- [ ] Add provider-call-count tests proving date-level work is range-batched at dispatch.
- [ ] Implement the D1 outbox lifecycle and consumer without wiring production Cron.
- [ ] Run pipeline Worker tests repeatedly for races and `npm run typecheck`.
- [ ] Request concurrency and Queue-delivery review.
- [ ] Commit with message `feat: dispatch portfolio work reliably`.

### Task 6: Add Portfolio, Calendar, and job read models

**Files:**

- Create the three read-model services and feature-flagged route modules listed above.
- Modify `src/shared/contracts.ts`, `src/worker/app.ts`, and `src/ui/api.ts` only for DTOs and guarded route registration.

**Interfaces:**

- Portfolio returns derived quantities, raw-close valuations, split-adjusted movement, summaries, native totals, actual trading dates, conflicts, and freshness.
- Calendar returns bounded held mover/dividend events and pending coverage for requested week/month ranges.
- Conditional reads compose ETags from position-basis plus `latest` or intersecting month buckets.

- [ ] Add failing read-model tests for CAD/USD totals, current quantity, qualifying threshold, Chinese summary, start-of-day historical eligibility, ex-date quantity, future dividend, stale/pending/error, quarantined split, and legacy-basis pending refresh.
- [ ] Add ETag tests for unchanged `304`, historical-month isolation, locale variation, position-basis invalidation, and at-most-ten state-row fast path.
- [ ] Add API tests for auth, range bounds, decimal-string DTOs, cursor/job error limits, and source URL safety.
- [ ] Implement feature-flagged routes while keeping legacy UI/read paths active.
- [ ] Run route/read-model/performance fixtures and `npm run typecheck`.
- [ ] Request query-plan and data-contract review.
- [ ] Commit with message `feat: add portfolio and calendar read models`.

### Task 7: Adapt Backfill to the shared planner behind a flag

**Files:**

- Modify `src/worker/routes/backfills.ts`, `src/services/jobs.ts`, and Backfill tests behind a disabled-by-default pipeline flag.
- Preserve the existing production behavior when the flag is off.

**Interfaces:**

- Normal Backfill ensures missing/stale fact work.
- Reprocess assigns a forced-refresh generation and only invalidates analysis if refreshed dependencies change.
- Existing Backfill status remains available while the new job status adds reuse/fetch/analyze counts.

- [ ] Add dual-mode tests proving legacy behavior is unchanged with the flag off.
- [ ] Add pipeline-mode tests for 30-day validation, shared work, forced refresh, partial error, targeted retry, and browser-independent continuation.
- [ ] Implement the compatibility projection over pipeline jobs.
- [ ] Run existing and new Backfill tests plus `npm run typecheck`.
- [ ] Request regression review against current Backfill guarantees.
- [ ] Commit with message `feat: prepare backfill reconciliation pipeline`.

### Task 8: Plan-level verification gate

**Files:**

- Update only benchmark evidence or developer documentation required to reproduce verification.

**Interfaces:**

- Produces the accepted dormant pipeline/read-model boundary consumed by Plan 3.
- Guarantees feature flags off preserve current production behavior.

- [ ] Run `npm run check` with all new feature flags disabled.
- [ ] Run focused pipeline race tests repeatedly.
- [ ] Benchmark the 100-instrument, 10,000-transaction, five-year fixture for rows read, CPU, response size, provider calls, and unchanged `304` reads.
- [ ] Confirm the current dashboard and scheduled test suites remain unchanged.
- [ ] Run an adversarial architecture review of work sharing, outbox recovery, price basis, and D1 row scans.
- [ ] Commit any verification documentation with message `docs: verify normalized portfolio pipeline`.

Plan 2 is complete only when the dormant pipeline and read models pass their gates without changing current production behavior.
