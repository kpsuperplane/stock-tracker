export class ApiError extends Error {
  constructor(
    readonly status: 400 | 404 | 405 | 409 | 415 | 422 | 428 | 429 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const safeErrorMessage = (error: unknown) =>
  (error instanceof Error ? error.message : String(error))
    .replace(/(?:Bearer|Basic)\s+[^\s,;]+/gi, "credential=[REDACTED]")
    .replace(
      /(?:authorization|api[_-]?key|token|password|secret)\s*[=:]\s*[^\s,;]+/gi,
      "credential=[REDACTED]",
    )
    .slice(0, 500);
