import type { ScreeningJobMessage } from "../shared/contracts";

export interface Env extends Cloudflare.Env {
  SCREENING_QUEUE: Queue<ScreeningJobMessage>;
  MARKETAUX_API_TOKEN?: string;
}
