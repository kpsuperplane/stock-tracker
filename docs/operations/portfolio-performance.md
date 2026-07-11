# Portfolio performance and free-tier verification

Run the deterministic local Worker/D1 performance gate with:

```bash
npm run test:worker -- tests/worker/performance.test.ts
```

The fixture creates 100 held instruments, 10,000 ledger transactions, and
130,400 weekday market facts covering 2021–2025. The December calendar probe
uses the API's 500-event page limit; the week probe uses the same bounded
query path. The test proxy records D1 statement count, `meta.rows_read`,
`meta.rows_written`, and `meta.duration` when Miniflare exposes them, plus
serialized response bytes and wall time. Provider and Queue calls are counted
with spies.

## Budgets

| Probe | Query/operation budget | Read/response budget | Local wall budget |
| --- | ---: | ---: | ---: |
| Cold Portfolio | ≤30 D1 statements | ≤250,000 rows; ≤500 KiB | 10 s |
| Cold Calendar month | ≤35 D1 statements | ≤250,000 rows; ≤1 MiB | 10 s |
| Cold Calendar week | ≤35 D1 statements | ≤150,000 rows | 10 s |
| Unchanged Portfolio `304` | ≤10 state/bucket rows | 0-byte body | route-dependent |
| Ledger mutation | ≤250 statements; provider call is one split-range request | writes must be observed | 5 s |
| Reconciliation page | ≤250 statements | bounded page (`25` candidates) | 5 s |
| Backfill start | ≤180 statements | bounded two-day/two-symbol request | 5 s |
| Migration catch-up page | ≤800 statements | bounded page (`50` rows) | 5 s |
| Dispatcher with historical backlog | one current-day item at a ceiling of `1` | historical items remain pending; one Queue envelope | 5 s |

The 250-statement mutation/planner and 800-statement migration budgets
deliberately expose the existing 100-position guard, per-candidate planner
reads, and per-row migration provenance/audit writes. They are regression
ceilings for the current design, not a claim that those paths are free of
N+1-shaped work; future query-folding optimizations should lower them and keep
the tests' stricter-than-production fixtures intact.

## Recorded baseline

The earlier 100/10,000/five-year local trace recorded:

- Portfolio cold: 15 statements, 46,150 rows read, approximately 11 ms D1
  duration, 32 ms wall time, 90,183 bytes, and zero provider calls.
- Calendar December: 11 statements, 21,515 rows read, approximately 10 ms D1
  duration, 50 ms wall time, 170,875 bytes, and zero provider calls.
- Unchanged Portfolio and Calendar: three statements, two state rows, an
  empty `304` body, and approximately 1 ms wall time.
- Dispatcher: the current-day priority item is queued first while the two
  historical items remain pending under a ceiling of one.
- The 50-row migration catch-up inserted 50 legacy-basis facts in one bounded
  page; its current baseline is about 709 statements, below the
  800-statement ceiling, and is kept visible because it is the most
  query-heavy operation in this gate.

The focused suite also exercises a single range market-provider call,
transaction mutation/reconciliation planning, a bounded Backfill adapter
start, and an enabled migration catch-up page against the same local D1
fixture. All new normalized behavior remains feature-flagged off in the
application and no remote resource is touched by this verification.

## Limits of local evidence

Miniflare's D1 `meta.duration` is a local statement-duration proxy. Hosted
Worker CPU, production D1 billing/row quotas, Cloudflare Queue operation
billing, provider latency, and Alpha Vantage/Yahoo quota behavior are not
available in this repository-only test. Production rollout must collect those
metrics from safe tail/analytics diagnostics before enabling new reads or
writes; this document must not be read as a hosted free-tier guarantee.
