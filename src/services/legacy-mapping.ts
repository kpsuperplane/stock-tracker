import type { NewsSourceRecord } from "../db/analyses";

export const LEGACY_PROVIDER = "legacy-report";
export const LEGACY_ANALYSIS_PREFIX = "legacy-analysis:";

export const legacyProviderRevision = (input: {
  runId: string;
  generation: number;
  screeningId: string;
}): string =>
  `${LEGACY_PROVIDER}:${input.runId}:${input.generation}:${input.screeningId}`;

const digest = async (value: string): Promise<string> => {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

export const legacyAnalysisFingerprint = async (input: {
  providerRevision: string;
  status: string;
  summary: string | null;
  model: string | null;
  sources: readonly Pick<
    NewsSourceRecord,
    | "sourceOrder"
    | "title"
    | "publisher"
    | "publishedAt"
    | "cited"
    | "sourceUrl"
  >[];
}): Promise<string> =>
  digest(
    JSON.stringify({
      providerRevision: input.providerRevision,
      status: input.status,
      summary: input.summary,
      model: input.model,
      sources: input.sources.map((source) => [
        source.sourceOrder,
        source.title,
        source.publisher,
        source.publishedAt,
        source.cited,
        source.sourceUrl,
      ]),
    }),
  );
