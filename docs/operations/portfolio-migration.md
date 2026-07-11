# Portfolio migration operations

The published-generation migrator is intentionally dormant until
`PORTFOLIO_MIGRATOR_ENABLED` is exactly `true`. It runs one bounded page at a
time and persists its high-water cursor and audit rows in D1; restarting the
Worker does not lose unfinished work.

Before treating a migration as caught up, run the bounded pass to completion
twice. Both passes must report zero unexplained `skipped`, `mismatched`, or
`error` rows, and the second pass should contain only `unchanged` outcomes.
Investigate audit hashes and publication replacements before advancing any
read or write cutover flag. A lease expiry is safe to recover, and rerunning a
page is idempotent; legacy report rows are never deleted or rewritten.
