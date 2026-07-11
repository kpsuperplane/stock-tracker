# Portfolio retention and cleanup

The 15-minute dispatcher invokes a bounded D1 cleanup pass before dispatching
new normalized work. Each pass deletes at most the configured batch size per
retention class; a later pass resumes by selecting the next oldest rows. D1
transactions make a failed pass all-or-nothing, so retrying cannot partially
erase a class.

| Data | Retention | Cleanup behavior |
| --- | --- | --- |
| Preview batches | 24 hours after creation | The batch is marked expired; its digest/status remains. |
| Uncommitted import rows | 7 days after preview expiry | Rows are removed; the expired batch digest/status remains. |
| Committed import rows | 7 days after commit | Rows are removed; the committed batch digest/status remains. |
| Completed work and job links | 90 days | Only derived workflow rows with settled parents are removed. |
| Completed dispatch batches | 90 days | Batch rows and child links are removed after settlement. |
| Terminal work, terminal/DLQ batches, and job summaries | 1 year | Records are removed only after terminal/DLQ settlement. |
| Ledger transactions, normalized facts, corporate-action provenance, import digests, legacy reports, and migration audit | Indefinite | Never removed by this cleanup. |

Cleanup is intentionally low priority and independent of Queue retention. A
Queue message may expire while its D1 batch remains queued or processing; the
dispatcher recovers that D1 work before selecting new work.
