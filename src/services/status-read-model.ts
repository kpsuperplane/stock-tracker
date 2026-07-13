import { EarningsRepository } from "../db/earnings";
import { alphaVantageEarningsProvider } from "../providers/alpha-vantage-earnings";
import type { StatusReadModelDto } from "../shared/contracts";
import {
  type JobReadModelListInput,
  JobReadModelService,
} from "./job-read-model";

export class StatusReadModelService {
  constructor(private readonly db: D1Database) {}

  async read(input: JobReadModelListInput = {}): Promise<StatusReadModelDto> {
    const [earningsCoverage, jobs] = await Promise.all([
      new EarningsRepository(this.db).coverage(alphaVantageEarningsProvider),
      new JobReadModelService(this.db).list(input),
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
      jobs: jobs.jobs,
      nextCursor: jobs.nextCursor
        ? btoa(JSON.stringify(jobs.nextCursor))
        : null,
    };
  }
}
