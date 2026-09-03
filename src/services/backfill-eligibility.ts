import type { PipelineJobRecord } from "../db/pipeline-jobs";
import { deriveHoldings } from "../domain/holdings";

interface BackfillTransaction {
  id: string;
  instrumentId: string;
  tradeDate: string;
  side: "buy" | "sell";
  quantityDecimal: string;
}

interface BackfillSplit {
  id: string;
  instrumentId: string;
  effectiveDate: string;
  numerator: string;
  denominator: string;
}

export interface BackfillEligibilityInterval {
  instrumentId: string;
  startDate: string;
  endDate: string;
}

export const freezeBackfillEligibilityIntervals = async (
  db: D1Database,
  input: {
    instrumentIds: readonly string[];
    startDate: string;
    endDate: string;
  },
): Promise<BackfillEligibilityInterval[]> => {
  if (input.instrumentIds.length === 0) return [];
  const [transactions, splits] = await Promise.all([
    db
      .prepare(
        `SELECT id, instrument_id AS instrumentId, trade_date AS tradeDate,
                side, quantity_decimal AS quantityDecimal
           FROM transactions
          WHERE instrument_id IN (SELECT value FROM json_each(?1))
            AND trade_date <= ?2
          ORDER BY instrument_id, trade_date, id`,
      )
      .bind(JSON.stringify(input.instrumentIds), input.endDate)
      .all<BackfillTransaction>(),
    db
      .prepare(
        `SELECT id, instrument_id AS instrumentId,
                effective_date AS effectiveDate,
                split_numerator AS numerator,
                split_denominator AS denominator
           FROM corporate_actions
          WHERE instrument_id IN (SELECT value FROM json_each(?1))
            AND status = 'active' AND effective_date <= ?2
          ORDER BY instrument_id, effective_date, id`,
      )
      .bind(JSON.stringify(input.instrumentIds), input.endDate)
      .all<BackfillSplit>(),
  ]);
  return input.instrumentIds.flatMap((instrumentId) =>
    deriveHoldings({
      today: input.endDate,
      transactions: transactions.results
        .filter((row) => row.instrumentId === instrumentId)
        .map((row) => ({
          id: row.id,
          tradeDate: row.tradeDate,
          side: row.side,
          quantityDecimal: row.quantityDecimal,
        })),
      activeSplits: splits.results
        .filter((row) => row.instrumentId === instrumentId)
        .map((row) => ({
          id: row.id,
          effectiveDate: row.effectiveDate,
          numerator: row.numerator,
          denominator: row.denominator,
        })),
    })
      .heldIntervals({
        startDate: input.startDate,
        endDate: input.endDate,
      })
      .map((interval) => ({ instrumentId, ...interval })),
  );
};

const parseStringArray = (value: string, errorCode: string): string[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(errorCode);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    throw new Error(errorCode);
  }
  return [...new Set(parsed as string[])];
};

export const repairMissingBackfillEligibilityIntervals = async (
  db: D1Database,
  job: PipelineJobRecord,
  now: string,
): Promise<boolean> => {
  let existing: unknown;
  try {
    existing = JSON.parse(job.eligibilityIntervalsJson);
  } catch {
    throw new Error("pipeline_eligibility_intervals_invalid");
  }
  if (!Array.isArray(existing)) {
    throw new Error("pipeline_eligibility_intervals_invalid");
  }
  if (existing.length > 0 || !job.requestedStartDate || !job.requestedEndDate) {
    return false;
  }

  const instrumentIds = parseStringArray(
    job.affectedInstrumentsJson,
    "pipeline_affected_instruments_invalid",
  );
  const intervals = await freezeBackfillEligibilityIntervals(db, {
    instrumentIds,
    startDate: job.requestedStartDate,
    endDate: job.requestedEndDate,
  });
  if (intervals.length === 0) return false;

  const repaired = await db
    .prepare(
      `UPDATE pipeline_jobs
          SET eligibility_intervals_json = ?1, updated_at = ?2
        WHERE id = ?3 AND trigger_type = 'backfill'
          AND status IN ('pending', 'planning', 'running')
          AND eligibility_intervals_json = ?4 AND work_total = 0
          AND NOT EXISTS (
            SELECT 1 FROM job_work_items link
            JOIN work_items work ON work.id = link.work_item_id
            WHERE link.pipeline_job_id = pipeline_jobs.id
              AND work.scope = 'global_fact'
          )`,
    )
    .bind(JSON.stringify(intervals), now, job.id, job.eligibilityIntervalsJson)
    .run();
  return repaired.meta.changes === 1;
};
