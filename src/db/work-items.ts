export interface PlanningWorkRecord {
  id: string;
  pipelineJobId: string;
  workType: string;
  deterministicKey: string;
  priority: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
}

export class WorkItemRepository {
  constructor(private readonly db: D1Database) {}

  createPlanningStatement(work: PlanningWorkRecord): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO work_items
         (id, scope, pipeline_job_id, work_type, deterministic_key, state,
          priority, attempt_count, max_attempts, created_at, updated_at)
         VALUES (?1, 'job_planning', ?2, ?3, ?4, 'pending', ?5, 0, ?6, ?7, ?8)`,
      )
      .bind(
        work.id,
        work.pipelineJobId,
        work.workType,
        work.deterministicKey,
        work.priority,
        work.maxAttempts,
        work.createdAt,
        work.updatedAt,
      );
  }

  linkToJobStatement(input: {
    pipelineJobId: string;
    workItemId: string;
    relationship: "required" | "optional";
    createdAt: string;
  }): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO job_work_items
         (pipeline_job_id, work_item_id, relationship, outcome, created_at)
         VALUES (?1, ?2, ?3, 'pending', ?4)`,
      )
      .bind(
        input.pipelineJobId,
        input.workItemId,
        input.relationship,
        input.createdAt,
      );
  }
}
