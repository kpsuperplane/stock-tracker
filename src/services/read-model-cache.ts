import type { ReadModelFreshnessDto } from "../shared/contracts";
import { easternMarketDate } from "../shared/dates";

export type ReadModelFamily =
  | "accounts"
  | "portfolio"
  | "portfolio_history"
  | "calendar"
  | "status";

interface SnapshotRecord {
  version: 1;
  family: ReadModelFamily;
  requestUrl: string;
  payload: Record<string, unknown>;
  sourceRevision: string;
  contentHash: string;
  generatedAt: string;
  validUntil: string;
  headers: Record<string, string>;
}

export interface SnapshotLookup {
  snapshot: SnapshotRecord;
  migratedLegacyKey: boolean;
}

const headerNames = [
  "content-language",
  "etag",
  "x-account-structure-revision",
  "x-position-basis-revision",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSnapshot = (value: unknown): value is SnapshotRecord => {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    typeof value.family === "string" &&
    typeof value.requestUrl === "string" &&
    isRecord(value.payload) &&
    typeof value.sourceRevision === "string" &&
    typeof value.contentHash === "string" &&
    typeof value.generatedAt === "string" &&
    typeof value.validUntil === "string" &&
    isRecord(value.headers)
  );
};

const hex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const digest = async (value: string): Promise<string> =>
  hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));

const normalizeCurrentCalendarAsOf = (url: URL, currentDate: string): void => {
  if (
    url.pathname === "/api/calendar" &&
    url.searchParams.get("asOfDate") === currentDate
  ) {
    url.searchParams.delete("asOfDate");
  }
};

const requestIdentity = (request: Request, url: URL): string => {
  const params = [...url.searchParams.entries()].sort(
    ([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue),
  );
  const normalized = new URL(url.pathname, "https://stock-tracker.invalid");
  for (const [key, value] of params) normalized.searchParams.append(key, value);
  const accessSubject =
    request.headers.get("Cf-Access-Authenticated-User-Email") ??
    "protected-app";
  return `${accessSubject}\n${normalized.pathname}${normalized.search}`;
};

const normalizedRequestIdentity = (
  request: Request,
  currentDate: string,
): string => {
  const url = new URL(request.url);
  normalizeCurrentCalendarAsOf(url, currentDate);
  return requestIdentity(request, url);
};

const addDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T12:00:00.000Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);

const legacyCalendarCacheKeys = async (
  request: Request,
  currentDate: string,
): Promise<string[]> => {
  const requestUrl = new URL(request.url);
  if (
    requestUrl.pathname !== "/api/calendar" ||
    (requestUrl.searchParams.has("asOfDate") &&
      requestUrl.searchParams.get("asOfDate") !== currentDate)
  ) {
    return [];
  }
  const keys: string[] = [];
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new URL(requestUrl);
    candidate.searchParams.set("asOfDate", addDays(currentDate, -offset));
    keys.push(
      `read-model:v1:${await digest(requestIdentity(request, candidate))}`,
    );
  }
  return keys;
};

const canonicalSnapshotRequestUrl = (
  family: ReadModelFamily,
  requestUrl: string,
  currentDate: string,
): string => {
  if (family !== "calendar") return requestUrl;
  const url = new URL(requestUrl, "https://read-model.internal");
  normalizeCurrentCalendarAsOf(url, currentDate);
  return `${url.pathname}${url.search}`;
};

const internalCacheRequest = (cacheKey: string): Request =>
  new Request(`https://read-model-cache.invalid/${cacheKey}`);

const ttlSeconds = (
  family: ReadModelFamily,
  payload?: Record<string, unknown>,
): number => {
  if (family === "accounts") return 6 * 60 * 60;
  if (family === "portfolio") return 5 * 60;
  if (family === "portfolio_history") return 30 * 60;
  if (family === "calendar") return 15 * 60;
  if (family === "status") {
    const reconciliation = payload?.reconciliation;
    const isActive =
      isRecord(reconciliation) &&
      Object.values(reconciliation).some(
        (value) => isRecord(value) && value.status === "syncing",
      );
    return isActive ? 30 : 5 * 60;
  }
  return 5 * 60;
};

const sourceRevision = (response: Response, generatedAt: string): string =>
  response.headers.get("ETag") ??
  response.headers.get("X-Position-Basis-Revision") ??
  response.headers.get("X-Account-Structure-Revision") ??
  generatedAt;

const responseHeaders = (response: Response): Record<string, string> => {
  const headers: Record<string, string> = {};
  for (const name of headerNames) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  return headers;
};

export class ReadModelSnapshotStore {
  constructor(
    private readonly db: D1Database,
    private readonly kv: KVNamespace,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async keyFor(request: Request): Promise<string> {
    const explicit = request.headers.get("X-Read-Model-Refresh-Key");
    if (
      explicit &&
      new URL(request.url).hostname === "read-model.internal" &&
      /^read-model:v1:[a-f0-9]{64}$/.test(explicit)
    ) {
      return explicit;
    }
    return `read-model:v1:${await digest(
      normalizedRequestIdentity(request, easternMarketDate(this.now())),
    )}`;
  }

  async read(cacheKey: string): Promise<SnapshotRecord | null> {
    try {
      const cache = await caches.open("stock-tracker-read-models-v1");
      const cached = await cache.match(internalCacheRequest(cacheKey));
      if (cached) {
        const candidate: unknown = await cached.json();
        if (isSnapshot(candidate)) return candidate;
      }
    } catch {
      // Cache API is per-colo and opportunistic. KV remains the durable plane.
    }
    const candidate: unknown = await this.kv.get(cacheKey, {
      type: "json",
      cacheTtl: 30,
    });
    return isSnapshot(candidate) ? candidate : null;
  }

  async readForRequest(
    request: Request,
    cacheKey: string,
  ): Promise<SnapshotLookup | null> {
    const current = await this.read(cacheKey);
    if (current) return { snapshot: current, migratedLegacyKey: false };
    const currentDate = easternMarketDate(this.now());
    for (const legacyKey of await legacyCalendarCacheKeys(
      request,
      currentDate,
    )) {
      const snapshot = await this.read(legacyKey);
      if (snapshot) return { snapshot, migratedLegacyKey: true };
    }
    return null;
  }

  async registerPublicationTarget(input: {
    cacheKey: string;
    family: ReadModelFamily;
    requestUrl: string;
    snapshot: SnapshotRecord;
  }): Promise<void> {
    const requestUrl = canonicalSnapshotRequestUrl(
      input.family,
      input.requestUrl,
      easternMarketDate(this.now()),
    );
    await this.db
      .prepare(
        `INSERT INTO read_model_publications
         (cache_key, family, request_url, source_revision, content_hash,
          generated_at, valid_until, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(cache_key) DO UPDATE SET
           family = excluded.family,
           request_url = excluded.request_url
         WHERE read_model_publications.family <> excluded.family
            OR read_model_publications.request_url <> excluded.request_url`,
      )
      .bind(
        input.cacheKey,
        input.family,
        requestUrl,
        input.snapshot.sourceRevision,
        input.snapshot.contentHash,
        input.snapshot.generatedAt,
        input.snapshot.validUntil,
        this.now().toISOString(),
      )
      .run();
  }

  isFresh(snapshot: SnapshotRecord): boolean {
    return snapshot.validUntil > this.now().toISOString();
  }

  toResponse(
    snapshot: SnapshotRecord,
    options: {
      stale: boolean;
      reason?: ReadModelFreshnessDto["reason"];
    },
  ): Response {
    const freshness: ReadModelFreshnessDto = {
      state: options.stale ? "stale" : "fresh",
      asOf: snapshot.generatedAt,
      sourceRevision: snapshot.sourceRevision,
      nextRefreshAt: snapshot.validUntil,
      ...(options.reason ? { reason: options.reason } : {}),
    };
    const headers = new Headers(snapshot.headers);
    headers.set("Content-Type", "application/json; charset=UTF-8");
    headers.set("Cache-Control", "private, no-store");
    headers.set("X-Read-Model-Cache", options.stale ? "stale" : "hit");
    headers.set("X-Data-As-Of", snapshot.generatedAt);
    headers.set("X-Data-Stale", String(options.stale));
    if (options.reason) headers.set("X-Data-Stale-Reason", options.reason);
    return Response.json({ ...snapshot.payload, freshness }, { headers });
  }

  async publish(input: {
    cacheKey: string;
    family: ReadModelFamily;
    requestUrl: string;
    response: Response;
    previous?: SnapshotRecord | null;
  }): Promise<SnapshotRecord | null> {
    if (!input.response.ok) return null;
    const payload: unknown = await input.response.clone().json();
    if (!isRecord(payload)) return null;
    delete payload.freshness;
    const encoded = JSON.stringify(payload);
    const contentHash = await digest(encoded);
    const generatedAt = this.now().toISOString();
    const ttl = ttlSeconds(input.family, payload);
    const validUntil = new Date(
      Date.parse(generatedAt) + ttl * 1_000,
    ).toISOString();
    const snapshot: SnapshotRecord = {
      version: 1,
      family: input.family,
      requestUrl: canonicalSnapshotRequestUrl(
        input.family,
        input.requestUrl,
        easternMarketDate(this.now()),
      ),
      payload,
      sourceRevision: sourceRevision(input.response, generatedAt),
      contentHash,
      generatedAt,
      validUntil,
      headers: responseHeaders(input.response),
    };
    const edgeResponse = Response.json(snapshot, {
      headers: { "Cache-Control": `max-age=${ttl}` },
    });
    try {
      const cache = await caches.open("stock-tracker-read-models-v1");
      await cache.put(internalCacheRequest(input.cacheKey), edgeResponse);
    } catch {
      // A KV snapshot is sufficient when Cache API storage is unavailable.
    }
    if (input.previous?.contentHash !== contentHash) {
      await this.kv.put(
        input.cacheKey,
        encoded === "" ? "{}" : JSON.stringify(snapshot),
      );
    }
    await this.db
      .prepare(
        `INSERT INTO read_model_publications
         (cache_key, family, request_url, source_revision, content_hash,
          generated_at, valid_until, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?6)
         ON CONFLICT(cache_key) DO UPDATE SET
           family = excluded.family,
           request_url = excluded.request_url,
           source_revision = excluded.source_revision,
           content_hash = excluded.content_hash,
           generated_at = excluded.generated_at,
           valid_until = excluded.valid_until,
           updated_at = excluded.updated_at`,
      )
      .bind(
        input.cacheKey,
        input.family,
        snapshot.requestUrl,
        snapshot.sourceRevision,
        contentHash,
        generatedAt,
        validUntil,
      )
      .run();
    return snapshot;
  }
}

export const readModelFamilyFor = (path: string): ReadModelFamily | null => {
  if (path === "/api/accounts") return "accounts";
  if (path === "/api/portfolio/history") return "portfolio_history";
  if (path === "/api/portfolio") return "portfolio";
  if (path === "/api/calendar") return "calendar";
  if (path === "/api/status") return "status";
  return null;
};

export const cacheableReadModelFamily = (
  request: Request,
): ReadModelFamily | null => {
  const family = readModelFamilyFor(new URL(request.url).pathname);
  if (family !== "portfolio_history") return family;
  return new URL(request.url).searchParams.get("range") === "custom"
    ? null
    : family;
};
