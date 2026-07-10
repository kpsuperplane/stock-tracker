export const maxProviderResponseBytes = 2_000_000;

export function isIsoCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === value
  );
}

export async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(
    response.headers.get("content-length") ?? Number.NaN,
  );
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > maxProviderResponseBytes
  ) {
    throw new Error("provider_response_too_large");
  }

  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maxProviderResponseBytes) {
          await reader.cancel();
          throw new Error("provider_response_too_large");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error("provider_schema");
  }
}
