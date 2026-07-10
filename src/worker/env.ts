import type { ScreeningJobMessage } from "../shared/contracts";

export interface Env extends Cloudflare.Env {
  SCREENING_QUEUE: Queue<ScreeningJobMessage>;
  BASIC_AUTH_USERNAME: string;
  BASIC_AUTH_PASSWORD: string;
}
