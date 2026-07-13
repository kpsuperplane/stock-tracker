export const maxProviderResponseBytes = 2_000_000;

export function isIsoCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === value
  );
}

async function readBoundedBytes(response: Response): Promise<Uint8Array> {
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
  return bytes;
}

export async function readBoundedText(response: Response): Promise<string> {
  return new TextDecoder("utf-8", { fatal: true }).decode(
    await readBoundedBytes(response),
  );
}

export async function readBoundedJson(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await readBoundedText(response)) as unknown;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "provider_response_too_large"
    ) {
      throw error;
    }
    throw new Error("provider_schema");
  }
}
