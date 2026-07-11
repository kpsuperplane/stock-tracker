# Portfolio migration operations

The published-generation migrator is intentionally dormant until
`PORTFOLIO_MIGRATOR_ENABLED` is exactly `true`. It runs one bounded page at a
time and persists its high-water cursor and audit rows in D1; restarting the
Worker does not lose unfinished work.

Each page also performs a set-based, idempotent ticker identity sweep so
soft-deleted and currently unreferenced watchlist identities retain stable
legacy IDs and deletion metadata. Pages are capped at 100 published
screenings and use a two-minute D1 lease; no external provider calls occur in
the migrator, so a page is expected to finish within that lease. A lease
expiry safely allows another invocation to resume from the persisted cursor.

Before treating a migration as caught up, run the bounded pass to completion
twice. Both passes must report zero unexplained `skipped`, `mismatched`, or
`error` rows, and the second pass should contain only `unchanged` outcomes.
Investigate audit hashes and publication replacements before advancing any
read or write cutover flag. A lease expiry is safe to recover, and rerunning a
page is idempotent; legacy report rows are never deleted or rewritten.
