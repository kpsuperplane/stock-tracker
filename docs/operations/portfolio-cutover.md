# Portfolio staged cutover and rollback runbook

This runbook is a procedure and evidence template, not a claim that a remote
cutover has happened. Production flags remain `false` in the repository. Any
step that changes a remote flag, applies a remote migration, or sends a remote
Queue message requires explicit approval for that deployment window.

## Current go/no-go state

Before scheduling a read or write cutover, record these facts:

| Gate | Required state | Evidence | Status |
| --- | --- | --- | --- |
| Additive schema | All migrations applied; no legacy table/row removed | `wrangler d1 migrations list DB --remote` and migration export | `NOT RUN` |
| Feature defaults | Dual-write, migrator, new reads, and new writes all off | `npm run test -- src/config/deploy-safety.test.ts` | `PASS (local)` |
| Compatibility writes | Legacy publication still wins; repair markers are empty or explained | D1 counts, provenance sample, safe tail | `NOT RUN` |
| Published migration | High-water reached; two consecutive clean passes; no unexplained audit differences | migrator status/audit export | `NOT RUN` |
| Performance | Local budgets in [portfolio-performance.md](./portfolio-performance.md) pass | `npm run test:worker -- tests/worker/performance.test.ts` | `PASS (local)` |
| Normalized processor | Market/news/LLM processor is configured and tested; no `pipeline_processor_unconfigured` terminal outcomes | Queue consumer and provider evidence | `PASS (local; production not run)` |
| Rollback | Legacy schedule/queue and published generations remain available | flag-off rehearsal evidence | `NOT RUN` |

The normalized Queue consumer is wired to the provider/LLM processor and the
local provider, retry, range, persistence, and queue smoke tests pass. This is
repository evidence only: do not enable normalized writes until the production
provider credentials, bindings, quota, and remote rollback checks are verified
in the deployment window.

## Phase 0 — preflight (flags unchanged)

1. Record the deploy SHA, Wrangler account/project, D1 database name/ID,
   timezone, and the proposed maintenance window.
2. Export or back up D1 according to the organization's recovery policy. Save
   the export identifier; do not use a destructive migration or cleanup as a
   backup mechanism.
3. Confirm the remote migration list matches the reviewed branch and that the
   legacy tables, published generations, and reports are present.
4. Confirm both normalized Queue bindings and the DLQ point at the intended
   environment, and inspect queued/processing/DLQ counts. Do not drain or
   delete messages as part of this rehearsal.
5. Confirm Basic Auth secrets, Worker asset binding, Cron candidates
   (`20:30`/`21:30` UTC and `*/15`), and observability are configured.
6. Run the local gates with all flags off:

   ```bash
   npm run check
   npm run test:worker -- tests/worker/scheduled.test.ts tests/worker/queue.test.ts
   npm run test:worker -- tests/worker/performance.test.ts
   ```

Record command output and timestamps in the evidence table below. A failed
gate is an abort, not a reason to advance a later flag.

## Phase 1 — compatibility dual-write (reads/writes still legacy)

This phase is optional only after the processor prerequisite is satisfied.
Keep `PORTFOLIO_MIGRATOR_ENABLED`, `PORTFOLIO_NEW_READS_ENABLED`, and
`PORTFOLIO_NEW_WRITES_ENABLED` false. Enable only
`PORTFOLIO_DUAL_WRITE_ENABLED=true` for the approved window.

1. Run one ordinary legacy scheduled publication and one controlled retry.
2. Verify the legacy published generation is unchanged and every normalized
   row has `legacy_compatibility` provenance, the expected source revision,
   and the correct legacy run/screening identity.
3. Verify failed compatibility writes create bounded repair markers and that a
   retry is idempotent. Do not treat a missing normalized row as permission to
   rewrite a legacy report.
4. Keep the legacy report UI and queue authoritative. If repair markers grow,
   provenance differs, or a legacy publication fails, set dual-write false and
   investigate before continuing.

## Phase 2 — published-generation migration and catch-up

1. With new reads/writes still false, set
   `PORTFOLIO_MIGRATOR_ENABLED=true` for bounded invocations only.
   The legacy `0 22 * * MON-FRI` scheduled handler runs one page (maximum 100
   published screenings) per invocation and logs `portfolio_migration_scheduled`.
   Inspect progress with:

   ```sql
   SELECT status, cursor_trading_date, cursor_run_id, cursor_generation,
          examined_count, inserted_count, updated_count, unchanged_count,
          skipped_count, mismatched_count, error_count,
          consecutive_clean_passes
   FROM portfolio_migration_state
   WHERE id = 'legacy-published';
   ```

2. Run pages through the persisted high-water mark. Capture examined,
   inserted, updated, unchanged, skipped, mismatched, error counts, cursor,
   high-water, lease recovery, and audit hashes after every pass.
3. Run a complete pass twice. The second pass must contain only unchanged
   outcomes and zero unexplained skipped/mismatched/error rows. A publication
   replacement during migration requires a new catch-up pass.
4. Compare sampled normalized facts/analyses/sources to the currently
   published legacy winners, including soft-deleted ticker identities. Keep
   legacy rows and generations intact.
5. If the high-water lease expires, allow the next page to reclaim it; do not
   manually advance the cursor or delete audit rows.

## Phase 3 — read-only cutover rehearsal

1. Capture a baseline legacy report for the same trading date and a sampled
   Portfolio/Calendar fixture. Confirm position-basis revision, movement
   basis, source URLs, Chinese summaries, and CAD/USD totals.
2. Set `PORTFOLIO_NEW_READS_ENABLED=true` while keeping new writes false.
   In production, this is the fallback gate for Portfolio, Calendar, and Job
   read routes when the older `READ_MODELS_ENABLED` aliases are unset. Verify,
   in order: Portfolio, Calendar month, Calendar week, Events, and Backfill.
   Events and Backfill remain separately authenticated routes and are included
   in the smoke check; they are not silently disabled by the read-model flag.
   Check an unchanged conditional `304`, a historical month update, and the
   normal legacy scheduled screen.
3. Compare normalized output to the published legacy sample by instrument/date
   and provenance. Record any expected legacy-basis pending/conflict state;
   never silently coerce it into a current value.
4. Observe at least one normal dispatcher interval and inspect D1 queued,
   processing, terminal, and DLQ states. Queue retention is advisory; D1 is
   the source of truth.
5. Roll back the API read rehearsal by setting
   `PORTFOLIO_NEW_READS_ENABLED=false` (and any explicitly configured legacy
   `READ_MODELS_ENABLED`/model-specific aliases to false). This makes the
   normalized API return its explicit disabled response; the product UI remains
   deployed and presents that state. Confirm normalized facts, ledger
   transactions, and audit rows were not deleted or rewritten.

## Rollback and abort procedure

Abort immediately for any unexplained data-equivalence mismatch, non-zero
repair/error growth, processor-unconfigured terminal outcome, unexpected DLQ
growth, missing legacy publication, failed auth/asset check, or performance
budget breach.

1. Disable new writes first (if they were ever enabled):
   `PORTFOLIO_NEW_WRITES_ENABLED=false`.
2. Disable new reads: `PORTFOLIO_NEW_READS_ENABLED=false`.
3. Leave the product UI deployed and verify it presents the explicit
   read-model-disabled state; there is no legacy UI asset rollback.
4. Leave D1 work, normalized facts, audit rows, and legacy generations intact;
   do not run cleanup or destructive SQL as rollback.
5. Keep the legacy Cron/Queue path authoritative. Disable dual-write and the
   migrator only after capturing repair/migration diagnostics, unless dual
   writes are the source of an active publication failure.
6. If normalized Queue envelopes were acknowledged while the flag was off,
   allow the 15-minute D1 dispatcher recovery path to reconcile queued work;
   do not manually delete or replay envelopes without the D1 batch ID.
7. Capture safe tail logs, D1 counts, migration state, queue/DLQ state, and the
   exact flag transition timestamps. Open an incident and require a new
   approval before retrying a phase.

## Evidence record

Copy this table into the deployment record and fill every cell. `NOT RUN` is a
valid result for this repository-only session; do not replace it with an
invented remote success.

| Timestamp (Toronto) | Phase/checkpoint | Command or query | Result/count/hash | Operator/approver |
| --- | --- | --- | --- | --- |
|  | Preflight migrations/export |  |  |  |
|  | Queue/DLQ/auth checks |  |  |  |
|  | Dual-write publication sample |  |  |  |
|  | Migration pass 1 |  |  |  |
|  | Migration pass 2 |  |  |  |
|  | Read-only Portfolio/Calendar/Events/Backfill |  |  |  |
|  | `304` and invalidation checks |  |  |  |
|  | Rollback confirmation |  |  |  |

No production flag change, remote migration, or write cutover is authorized by
this document alone. Obtain explicit approval after all prior rows are filled,
the processor prerequisite is met, and the rollback rehearsal is accepted.
