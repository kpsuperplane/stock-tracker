import type { ReadModelLocale } from "../shared/contracts";

interface RevisionRow {
  bucket_key: string;
  revision: number;
}

export interface ReadModelTagInput {
  model: "portfolio" | "calendar";
  locale: ReadModelLocale;
  positionBasisRevision: number;
  accountStructureRevision?: number;
  bucketKeys: readonly string[];
  /** Query-shape input that makes validators safe across different ranges/pages. */
  representationKey?: string;
}

export interface ReadModelTagResult {
  etag: string;
  revisions: Record<string, number>;
}

const digest = async (value: string): Promise<string> => {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const uniqueBuckets = (bucketKeys: readonly string[]): string[] =>
  [...new Set(bucketKeys)]
    .filter((key) => key === "latest" || /^\d{4}-(?:0[1-9]|1[0-2])$/.test(key))
    .sort((left, right) => {
      if (left === "latest") return -1;
      if (right === "latest") return 1;
      return left.localeCompare(right);
    });

/**
 * ETags intentionally read only the requested revision bucket rows. Calendar
 * ranges are bounded, so this remains a small point lookup rather than a scan
 * of all fact state.
 */
export const readModelTag = async (
  db: D1Database,
  input: ReadModelTagInput,
): Promise<ReadModelTagResult> => {
  const buckets = uniqueBuckets(input.bucketKeys);
  const revisions: Record<string, number> = {};
  if (buckets.length > 0) {
    const placeholders = buckets
      .map((_key, index) => `?${index + 1}`)
      .join(", ");
    const rows = await db
      .prepare(
        `SELECT bucket_key, revision FROM fact_revision_buckets
         WHERE bucket_key IN (${placeholders}) ORDER BY bucket_key`,
      )
      .bind(...buckets)
      .all<RevisionRow>();
    for (const row of rows.results) revisions[row.bucket_key] = row.revision;
  }
  const canonical = [
    input.model,
    input.locale,
    `representation:${input.representationKey ?? ""}`,
    `position:${input.positionBasisRevision}`,
    `accounts:${input.accountStructureRevision ?? 0}`,
    ...buckets.map((bucket) => `${bucket}:${revisions[bucket] ?? 0}`),
  ].join("|");
  return { etag: `"read-${await digest(canonical)}"`, revisions };
};

export const matchesIfNoneMatch = (
  value: string | undefined,
  etag: string,
): boolean =>
  value?.split(",").some((candidate) => {
    const token = candidate.trim();
    return token === "*" || token === etag || token === `W/${etag}`;
  }) ?? false;

export const monthKeysForRange = (
  startDate: string,
  endDate: string,
): string[] => {
  const keys = new Set<string>();
  let cursor = startDate.slice(0, 7);
  const end = endDate.slice(0, 7);
  while (cursor <= end) {
    keys.add(cursor);
    const [yearText, monthText] = cursor.split("-");
    const year = Number(yearText);
    const month = Number(monthText);
    const next = new Date(Date.UTC(year, month, 1));
    cursor = next.toISOString().slice(0, 7);
  }
  return [...keys];
};
