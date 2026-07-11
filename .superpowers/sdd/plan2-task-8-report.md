# Plan 2 — Task 8 verification report

Date: 2026-07-11  
Implementation under test: `4e8ad5f` (`perf: optimize portfolio latest fact lookup`)

## Result

The dormant normalized pipeline/read-model boundary passes the Plan 2 verification gate. All feature flags were disabled for the legacy regression checks. The normalized pipeline remains dormant in production wiring; no queue or schedule cutover was made.

## Validation evidence

### Flags-off full check

Ran `npm run check` with every read-model and backfill-pipeline flag unset. The check passed:

- 15 unit test files, 98 tests.
- 16 Worker/D1 test files, 158 tests.
- Worker type generation, lint, and typecheck passed.
- Production build passed. The only output was the expected local warning that `BASIC_AUTH_USERNAME` and `BASIC_AUTH_PASSWORD` are not set in the shell.

### Repeated pipeline race tests

Ran the focused dispatcher, reconciliation-planner, and backfill-residual suites ten times with flags unset. Every repetition passed 3 files and 33 tests (10/10 repetitions).

### Legacy dashboard and scheduled regression

Ran the existing reports, runs, scheduled, queue, backfills, and read-model suites with flags unset. All 6 files and 36 tests passed. This confirms that the legacy dashboard/report path, cron dispatch, queue consumer, and Backfill behavior remain unchanged.

## Performance fixture

The temporary local Worker/D1 harness populated 100 instruments, 10,000 buy transactions, and 130,400 weekday `daily_market_facts` rows covering 2021–2025 (five years). It traced each D1 statement's `meta.rows_read`, `meta.duration`, response bytes, and wall time, then removed the temporary test file. Provider calls are zero by construction because the read paths only consume persisted facts.

`meta.duration` is the local D1 statement-duration proxy; hosted Worker CPU and production D1 billing were not available in this harness. The fixture is intended to expose unbounded scans and N+1 behavior, not to model market holidays, splits, analyses, or provider latency.

| Request | Status | Queries | Rows read | D1 duration | Wall time | Body | Provider calls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Portfolio cold | 200 | 15 | 46,150 | 11 ms | 32 ms | 90,183 B | 0 |
| Portfolio unchanged conditional | 304 | 3 | 2 | ~0 ms | 1 ms | 0 B | 0 |
| Calendar, busy December 2025 | 200 | 11 | 21,515 | 10 ms | 50 ms | 170,875 B | 0 |
| Calendar unchanged conditional | 304 | 3 | 2 | ~1 ms | 1 ms | 0 B | 0 |

The Portfolio latest-fact query now derives dates from held instruments and performs an indexed per-instrument lookup (`src/services/portfolio-read-model.ts:186-224`). The same fixture previously caused a 7,017,301-row read, including 6,725,700 rows from the valid-fact correlated `MAX` query; the optimized 46,150-row result removes that scan risk. Both conditional requests read two revision/state rows, within the ten-row fast-path requirement, and returned `304` with an empty body.

## Adversarial architecture review

- **Work sharing:** global fact work uses deterministic keys with `ON CONFLICT DO NOTHING`; job links are independently idempotent with a `(pipeline_job_id, work_item_id)` conflict guard. Shared-job and failed-link projection tests passed.
- **Outbox/lease recovery:** dispatcher and pipeline-queue tests cover send failures, dispatch and processing lease expiry, duplicate delivery, partial provider ranges, daily ceilings, terminal/DLQ delivery, and stale acknowledgements. The pipeline queue is intentionally not exported by `src/worker/index.ts`; production still uses the legacy `SCREENING_QUEUE` consumer. This is the documented dormant boundary, not an accidental cutover.
- **Scheduled behavior:** `src/worker/scheduled.ts` continues to run legacy screening dispatch and only invokes normalized Backfill continuation when its explicit flag is enabled. `wrangler.jsonc` retains the existing weekday cron and legacy queue binding.
- **Price basis:** `normalizeFact` stores raw closes and split-adjusted previous-close movement; Portfolio valuation uses `current_raw_close_decimal`, while movement and Calendar use the normalized split-adjusted percentage. Legacy-migration facts remain excluded from valuation and surface as pending/conflict state. Market-facts, read-model, and planner tests passed.
- **D1 scans:** the optimized Portfolio lookup uses the `(instrument_id, trading_date DESC)` index; Calendar uses date-leading range indexes and batched range reads. Conditional ETag paths read only two state/bucket rows in the fixture. No per-symbol, per-cell, or per-date provider request was observed.
- **Migrations:** the migration scan found no destructive table/index operations. The sole migration `DELETE` is the scoped retry trigger that detaches terminal dispatch links before a manual retry.

No high-severity architecture or compatibility finding remains for the dormant Plan 2 boundary.

