import { EarningsRepository } from "../db/earnings";
import { alphaVantageEarningsProvider } from "../providers/alpha-vantage-earnings";
import type {
  ReconciliationStatus,
  ReconciliationStatusDto,
  StatusReadModelDto,
} from "../shared/contracts";
import {
  type JobReadModelListInput,
  JobReadModelService,
} from "./job-read-model";

interface ReconciliationSummaryRow {
  total: number;
  completed: number;
  pending: number;
  failed: number;
  updatedAt: string | null;
}

interface ReconciliationErrorRow {
  errorCode: string | null;
  errorMessage: string | null;
}

const emptySummary: ReconciliationSummaryRow = {
  total: 0,
  completed: 0,
  pending: 0,
  failed: 0,
  updatedAt: null,
};

const statusFor = (summary: ReconciliationSummaryRow): ReconciliationStatus => {
  if (summary.total === 0) return "unknown";
  if (summary.pending > 0) return "syncing";
  if (summary.failed > 0) return "attention";
  return summary.completed === summary.total ? "current" : "attention";
};

const toDto = (
  summary: ReconciliationSummaryRow | null,
  error: ReconciliationErrorRow | null,
): ReconciliationStatusDto => {
  const value = summary ?? emptySummary;
  return {
    status: statusFor(value),
    total: value.total,
    completed: value.completed,
    pending: value.pending,
    failed: value.failed,
    updatedAt: value.updatedAt,
    errorCode: error?.errorCode ?? null,
    errorMessage: error?.errorMessage ?? null,
  };
};

export class StatusReadModelService {
  constructor(private readonly db: D1Database) {}

  private async reconciliation(
    kind: "stockValues" | "dividends" | "financialReports",
  ): Promise<ReconciliationStatusDto> {
    const queries = {
      stockValues: {
        summary: `SELECT COUNT(*) AS total,
                         COALESCE(SUM(state = 'complete'), 0) AS completed,
                         COALESCE(SUM(state IN
                           ('pending', 'dispatching', 'queued', 'processing')), 0)
                           AS pending,
                         COALESCE(SUM(state = 'terminal'), 0) AS failed,
                         MAX(updated_at) AS updatedAt
                    FROM work_items
                   WHERE scope = 'global_fact' AND work_type = 'market_fact'`,
        error: `SELECT terminal_error_code AS errorCode,
                       terminal_error_message AS errorMessage
                  FROM work_items
                 WHERE scope = 'global_fact'
                   AND work_type = 'market_fact'
                   AND (terminal_error_code IS NOT NULL
                     OR terminal_error_message IS NOT NULL)
                 ORDER BY updated_at DESC, id DESC
                 LIMIT 1`,
      },
      dividends: {
        summary: `SELECT COUNT(*) AS total,
                         COALESCE(SUM(status = 'current'), 0) AS completed,
                         COALESCE(SUM(status IN ('pending', 'in_progress')), 0)
                           AS pending,
                         COALESCE(SUM(status = 'retry'), 0) AS failed,
                         MAX(updated_at) AS updatedAt
                    FROM dividend_refresh_state`,
        error: `SELECT last_error_code AS errorCode,
                       last_error_message AS errorMessage
                  FROM dividend_refresh_state
                 WHERE last_error_code IS NOT NULL
                    OR last_error_message IS NOT NULL
                 ORDER BY updated_at DESC, instrument_id DESC
                 LIMIT 1`,
      },
      financialReports: {
        summary: `SELECT COUNT(*) AS total,
                         COALESCE(SUM(status = 'current'), 0) AS completed,
                         COALESCE(SUM(status IN ('pending', 'in_progress')), 0)
                           AS pending,
                         COALESCE(SUM(status = 'retry'), 0) AS failed,
                         MAX(updated_at) AS updatedAt
                    FROM earnings_history_coverage`,
        error: `SELECT last_error_code AS errorCode,
                       last_error_message AS errorMessage
                  FROM earnings_history_coverage
                 WHERE last_error_code IS NOT NULL
                    OR last_error_message IS NOT NULL
                 ORDER BY updated_at DESC, instrument_id DESC
                 LIMIT 1`,
      },
    } as const;
    const query = queries[kind];
    const [summary, error] = await Promise.all([
      this.db.prepare(query.summary).first<ReconciliationSummaryRow>(),
      this.db.prepare(query.error).first<ReconciliationErrorRow>(),
    ]);
    return toDto(summary, error);
  }

  async read(input: JobReadModelListInput = {}): Promise<StatusReadModelDto> {
    const [earningsCoverage, jobs, stockValues, dividends, financialReports] =
      await Promise.all([
        new EarningsRepository(this.db).coverage(alphaVantageEarningsProvider),
        new JobReadModelService(this.db).list(input),
        this.reconciliation("stockValues"),
        this.reconciliation("dividends"),
        this.reconciliation("financialReports"),
      ]);

    return {
      earningsCoverage: earningsCoverage
        ? {
            provider: earningsCoverage.provider,
            coverageStartDate: earningsCoverage.coverageStartDate,
            coverageEndDate: earningsCoverage.coverageEndDate,
            observedAt: earningsCoverage.observedAt,
            status: earningsCoverage.status,
            errorCode: earningsCoverage.errorCode,
            errorMessage: earningsCoverage.errorMessage,
            updatedAt: earningsCoverage.updatedAt,
          }
        : null,
      reconciliation: {
        stockValues,
        dividends,
        financialReports,
      },
      jobs: jobs.jobs,
      nextCursor: jobs.nextCursor
        ? btoa(JSON.stringify(jobs.nextCursor))
        : null,
    };
  }
}
