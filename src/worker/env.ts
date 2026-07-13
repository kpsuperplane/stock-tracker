import type {
  PipelineDispatchMessage,
  ScreeningJobMessage,
} from "../shared/contracts";

export interface Env extends Cloudflare.Env {
  SCREENING_QUEUE: Queue<ScreeningJobMessage>;
  NORMALIZED_WORK_QUEUE: Queue<PipelineDispatchMessage>;
  NORMALIZED_WORK_DLQ: Queue<PipelineDispatchMessage>;
  EXA_API_KEY?: string;
  MARKETAUX_API_TOKEN?: string;
  ALPHA_VANTAGE_API_KEY: string;
  READ_MODELS_ENABLED?: string;
  READ_MODEL_ENABLED?: string;
  PORTFOLIO_READ_MODELS_ENABLED?: string;
  PORTFOLIO_READ_MODEL_ENABLED?: string;
  CALENDAR_READ_MODEL_ENABLED?: string;
  JOB_READ_MODEL_ENABLED?: string;
  ENABLE_PORTFOLIO_READ_MODEL?: string;
  ENABLE_CALENDAR_READ_MODEL?: string;
  ENABLE_JOB_READ_MODEL?: string;
  BACKFILL_RECONCILIATION_PIPELINE_ENABLED?: string;
  BACKFILL_PIPELINE_ENABLED?: string;
  ENABLE_BACKFILL_PIPELINE?: string;
  ENABLE_BACKFILL_RECONCILIATION_PIPELINE?: string;
}
