# Report Query Optimization Design

## Goal

Load a published report in a constant number of D1 statements regardless of how many stocks the report contains. Loading a 71-stock day must no longer execute one source query per stock.

## Current Problem

`RunRepository.hydrateReport` loads the report's screening rows, then loops over them and awaits a separate `sources` query for every screening. Since reports now include all checked stocks, a 71-stock report executes approximately 73 D1 statements: one for the report run, one for screenings, and 71 for sources.

## Design

Keep report hydration as three ordered steps:

1. Load the published report-run summary.
2. Load all screenings and their optional analyses for that run, preserving the existing percentage-change ordering.
3. Load every source belonging to the run with one query that joins `sources` to `screenings` and filters by `screenings.report_run_id`.

The source query will return `screeningId` with each source. Application code will group those rows by screening ID and attach the corresponding array to each mover. Movers with no sources will receive an empty array.

The API contract, row ordering, source ordering, and frontend behavior remain unchanged. This change does not add frontend or HTTP caching.

## Error Handling

D1 errors continue to propagate through the existing Worker error handler. The bulk query introduces no partial-result behavior: if any report-hydration query fails, the report request fails as it does today.

## Testing

Add a worker integration regression test that uses the real D1 test database behind a counting wrapper. Hydrating a report containing 71 screenings must:

- return all 71 movers;
- attach sources to the correct movers and leave the others empty;
- execute exactly three D1 statements for `reportByDate`, independent of stock count.

Run the focused regression test first for the red/green cycle, then run the complete project check.
