export class ApiError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 415 | 422 | 429 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const safeErrorMessage = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 500);
