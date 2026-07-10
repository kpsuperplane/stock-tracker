# Ledger and Events Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a concurrency-safe transaction ledger, validated split-action basis, exact holdings domain, and atomic Events/CSV APIs alongside the unchanged legacy application.

**Architecture:** Instruments, transactions, corporate-action coverage/candidates, and a trigger-guarded position-basis revision form one authoritative ledger. Provider coverage is established before historical validation; holdings are folded in memory with arbitrary-precision decimals and are never stored as position snapshots.

**Tech Stack:** TypeScript, Hono, Cloudflare D1, Yahoo provider adapters or another approved free source, Zod, arbitrary-precision decimal library selected by the implementer, Vitest.

## Global Constraints

- Follow the approved design specification and roadmap.
- This plan defines files, schema responsibilities, tests, commands, and gates but intentionally leaves exact code, signatures, and algorithms to implementing subagents.
- Do not change the current report read path, scheduler, Backfill behavior, or visible UI in this plan.
- Use additive migrations only.
- Reject future trade dates and negative end-of-day holdings.
- Require current split coverage from the earliest affected trade date through today before an authoritative transaction mutation.
- Treat quarantined corporate-action corrections as visible conflicts; never silently apply an invalid split set.
- Store transaction/dividend decimal values as canonical strings and keep arithmetic outside JavaScript `Number`.
- Every task ends with focused tests, `npm run typecheck`, review, and a scoped commit.

---

## Intended project structure

| Path | Responsibility |
| --- | --- |
| `src/domain/decimal.ts` | Canonical decimal parsing, bounds, arithmetic, and formatting boundary |
| `src/domain/holdings.ts` | Transaction/split folding and dated eligibility rules |
| `src/domain/holdings.test.ts` | Ledger semantics and split/eligibility fixtures |
| `src/providers/corporate-actions.ts` | Corporate-action provider contract |
| `src/providers/dividends.ts` | Dividend provider contract |
| `src/providers/yahoo-corporate-actions.ts` | Candidate Yahoo split adapter, if feasibility passes |
| `src/providers/yahoo-dividends.ts` | Candidate Yahoo dividend adapter, if feasibility passes |
| `src/db/instruments.ts` | Instrument identity repository |
| `src/db/transactions.ts` | Transaction persistence and event revisions |
| `src/db/corporate-actions.ts` | Coverage, candidates, active actions, quarantine state |
| `src/db/position-basis.ts` | Mutation token and position-basis revision repository |
| `src/db/imports.ts` | CSV preview batches and normalized staging rows |
| `src/db/pipeline-jobs.ts` | Minimal job creation/state needed by authoritative mutations |
| `src/db/work-items.ts` | Job-scoped planning work and job/work links |
| `src/services/ledger.ts` | Transaction proposal validation and guarded commit orchestration |
| `src/services/event-imports.ts` | CSV parse, preview, digest, expiry, and commit orchestration |
| `src/worker/routes/events.ts` | Events CRUD API |
| `src/worker/routes/event-imports.ts` | CSV preview/commit API |
| `migrations/0002_portfolio_ledger.sql` | Additive ledger, job/planning-work schema, constraints, indexes, and revision trigger |
| `tests/worker/events.test.ts` | D1/API mutation and concurrency coverage |
| `tests/worker/event-imports.test.ts` | Multipart, preview, conflict, and atomic import coverage |
| `docs/operations/provider-feasibility.md` | Evidence and selected provider capabilities |

Implementers may split an oversized module while preserving these ownership boundaries.

---

### Task 1: Prove corporate-action and dividend provider feasibility

**Files:**

- Create the provider contract, candidate adapter, fixture, test, and feasibility-document paths listed above.
- Leave the legacy `src/providers/market-data.ts` contract operational; add the new provider contracts alongside it for later cutover.
- Do not modify persistence or UI.

**Interfaces:**

- Produces normalized split coverage with stable identity, exact ratio, effective date, provider revision, and range coverage.
- Produces normalized announced dividend events with exact ex-date, per-share amount, currency, identity, and revision.
- Later tasks consume only these normalized contracts, not Yahoo response shapes.

- [ ] Record provider fixtures covering an ordinary split, reverse split, correction, historical dividend, announced future dividend, missing fields, timezone boundary, duplicate event, and delisted symbol.
- [ ] Add contract tests that fail against the current collapsed corporate-action representation.
- [ ] Evaluate Yahoo endpoints against every required field and coverage case; document request shape, stability limits, and correction identity.
- [ ] If Yahoo fails future dividend amount/ex-date coverage, test one alternative free source. Stop the plan and request a provider decision if no source passes; do not weaken acceptance criteria.
- [ ] Select adapters only after all required fixture cases pass.
- [ ] Run `npm test -- src/providers` and `npm run typecheck`; expect all provider contract tests to pass.
- [ ] Request adversarial review focused on historical coverage claims and future dividend evidence.
- [ ] Commit provider contracts, fixtures, adapters, tests, and feasibility evidence with message `feat: establish portfolio event providers`.

### Task 2: Add the authoritative ledger schema

**Files:**

- Create `migrations/0002_portfolio_ledger.sql`.
- Create the instrument, transaction, corporate-action, position-basis, and import repository modules listed in the structure map.
- Extend `tests/worker/apply-migrations.ts` only as needed for the new additive migration.

**Interfaces:**

- Produces `instruments`, `transactions`, `corporate_actions`, `corporate_action_coverage`, `position_basis_state`, `ledger_mutations`, `import_batches`, `import_rows`, `pipeline_jobs`, `work_items`, and `job_work_items`.
- The job/work tables include the complete job-scoped/global scope and deterministic-key fields required by the approved schema, although this plan uses only job-scoped planning work.
- The mutation-token trigger must abort on expected-revision mismatch and advance the revision on success inside the same D1 batch.
- Existing ticker/report tables remain unchanged.

- [ ] Write migration tests for clean apply, repeated local test setup, constraints, indexes, canonical status values, foreign keys, and legacy-table preservation.
- [ ] Write concurrent mutation-token tests proving one of two identical expected revisions aborts without partial writes.
- [ ] Write schema tests for event revision, unique import digest, coverage ranges, active/candidate/quarantined actions, and cascade/retention rules.
- [ ] Apply migrations locally and inspect the resulting D1 schema.
- [ ] Implement repositories without adding business folding logic to persistence modules.
- [ ] Run `npm run test:worker -- tests/worker/events.test.ts` and `npm run typecheck`; expect schema and guard tests to pass.
- [ ] Request review focused on D1 transactional assumptions and additive safety.
- [ ] Commit with message `feat: add portfolio ledger schema`.

### Task 3: Implement exact decimal and holdings semantics

**Files:**

- Create `src/domain/decimal.ts`.
- Create `src/domain/holdings.ts` and `src/domain/holdings.test.ts`.
- Modify `package.json` and `package-lock.json` only if the chosen decimal implementation requires a dependency.

**Interfaces:**

- Produces a domain boundary that accepts/returns canonical decimal strings and prevents accidental JavaScript-number arithmetic.
- Produces current quantity, quantity on a date, start-of-day eligibility, ex-dividend eligibility, and held intervals from transactions plus active splits.

- [ ] Add failing tests for canonicalization, six-digit input precision, configured bounds, exact multiplication, comparison, twelve-digit derived precision, and display rounding.
- [ ] Add failing holdings tests for multiple buys/sells, same-day netting, future-date rejection, negative history, forward split, reverse split, fractional cash-in-lieu sell, buy-on-ex-date, sell-on-ex-date, buy-on-screening-date, and sell-to-zero screening behavior.
- [ ] Implement the smallest domain surface satisfying those scenarios without persistence or provider knowledge.
- [ ] Add property-style invariants for deterministic ordering and non-negative accepted histories.
- [ ] Run `npm test -- src/domain/holdings.test.ts` and `npm run typecheck`; expect all domain tests to pass.
- [ ] Request review focused on precision leakage and date ordering.
- [ ] Commit with message `feat: derive holdings from portfolio events`.

### Task 4: Add coverage-aware, concurrency-safe ledger mutations

**Files:**

- Create `src/services/ledger.ts` and focused service tests.
- Use the repositories and provider contracts from Tasks 1–2 and the holdings domain from Task 3.

**Interfaces:**

- Consumes a proposed create/edit/delete plus expected position-basis and event revisions.
- Produces either an atomic authoritative mutation with its pipeline job and job-scoped planning work, or a typed coverage/conflict/validation error.
- Plan 2 implements planner execution and global child work without replacing this atomic foundation.

- [ ] Add failing service tests for missing coverage, stale coverage, provider outage, valid coverage refresh, negative proposal, stale event revision, stale position-basis revision, and the 100-current-position race.
- [ ] Add candidate-action tests for valid promotion, invalid quarantine, unrelated edits during conflict, and a resolving edit that promotes the candidate in the same guarded batch.
- [ ] Implement coverage refresh and proposal folding before the guarded D1 batch.
- [ ] Ensure the guarded batch contains the mutation token, event/action writes, revision advance, pipeline job, job-scoped planning work, and job/work link atomically.
- [ ] Run focused service and Worker D1 tests plus `npm run typecheck`.
- [ ] Request adversarial review focused on time-of-check/time-of-use races.
- [ ] Commit with message `feat: guard portfolio event mutations`.

### Task 5: Expose Events CRUD safely

**Files:**

- Create `src/worker/routes/events.ts` and `tests/worker/events.test.ts` additions.
- Modify `src/worker/app.ts`, `src/shared/contracts.ts`, and `src/ui/api.ts` only for route registration and stable DTO contracts; do not build UI.

**Interfaces:**

- Produces paginated combined transaction/split timeline reads and transaction create/edit/delete mutations.
- Mutations require same-origin validation, the non-simple app header, and `If-Match` where applicable.

- [ ] Add failing HTTP tests for timeline pagination/filtering, canonical decimal DTOs, transaction creation, edit/delete revisions, stale conflicts, missing coverage, quarantined correction reporting, negative holdings, auth, CSRF/origin rejection, body limits, and unsupported methods.
- [ ] Register routes without changing current report endpoints.
- [ ] Implement stable English API errors independent of UI locale.
- [ ] Run `npm run test:worker -- tests/worker/events.test.ts`, `npm run typecheck`, and existing report route tests.
- [ ] Request API/security review.
- [ ] Commit with message `feat: add portfolio events api`.

### Task 6: Add documented atomic CSV import

**Files:**

- Create `src/services/event-imports.ts`, `src/worker/routes/event-imports.ts`, and `tests/worker/event-imports.test.ts`.
- Add a checked-in sample template under `public/templates/portfolio-events.csv`.
- Modify request middleware narrowly for the multipart preview route.

**Interfaces:**

- Preview accepts the documented five-column UTF-8 template, normalizes rows, establishes coverage, stores staging rows, and returns row errors/projected quantities.
- Commit checks the previewed position-basis revision and performs one guarded `INSERT ... SELECT`-style authoritative commit with its pipeline job and job-scoped planning work.

- [ ] Add failing tests for exact header, BOM handling, row limit, file-size limit, dates, side normalization, decimals, symbols, duplicate digest, provider coverage, projected negative holdings, expiry, stale revision, multipart CSRF defense, and all-or-nothing commit.
- [ ] Add retention tests for 24-hour preview expiry, seven-day staging cleanup, and retained digest/status.
- [ ] Implement preview and commit without reparsing the file during commit.
- [ ] Run focused import tests, all Events tests, `npm run typecheck`, and `npm run build`.
- [ ] Request review focused on atomicity, upload abuse, and sensitive-data retention.
- [ ] Commit with message `feat: import portfolio events from csv`.

### Task 7: Plan-level verification gate

**Files:**

- Update `README.md` only with the Events API/template development notes needed by later agents.
- Do not expose unfinished navigation or replace the legacy dashboard.

**Interfaces:**

- Produces the accepted Plan 1 commit boundary consumed by Plan 2.
- Guarantees that legacy application behavior remains unchanged while ledger APIs are dormant and testable.

- [ ] Run `npm run check`.
- [ ] Run focused concurrent mutation and CSV suites repeatedly to detect ordering flakes.
- [ ] Apply the migration to a fresh local D1 database and to a copy containing representative legacy report rows.
- [ ] Confirm `git diff --check` and inspect the migration for destructive statements.
- [ ] Run an adversarial architecture/concurrency review against the approved specification.
- [ ] Commit verification/documentation changes with message `docs: verify portfolio ledger foundation`.

Plan 1 is complete only when the current application still functions unchanged and every ledger/provider gate above passes.
