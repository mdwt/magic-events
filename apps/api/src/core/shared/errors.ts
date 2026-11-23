export type ErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "invalid_input"
  | "not_found"
  // What the call would create already exists, such as a taken slug or email address.
  | "conflict"
  | "rate_limited"
  // The system cannot answer for now, such as while its database is down. The caller may try again later.
  | "unavailable";

export interface ErrorDetail {
  // Where in the input the problem is, such as "near.lat". Empty when it is about the input as a whole.
  path: string;
  message: string;
}

// An error the caller may see. Its message is written for the caller and says nothing about the system's insides.
// Anything else that is thrown is a system error: it is logged in full, and the caller gets a general message.
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: ErrorDetail[] | undefined;
  // How long the caller should wait before trying again, when that is known.
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    details?: ErrorDetail[],
    options: { retryAfterSeconds?: number | undefined; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.details = details;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

// How long a caller is asked to wait when the system cannot answer for now.
export const UNAVAILABLE_RETRY_AFTER_SECONDS = 10;

// What a caller is told while the system cannot answer, such as while its database is down. The cause is kept for the
// logs and never reaches the caller.
export function unavailable(cause: unknown): AppError {
  return new AppError(
    "unavailable",
    `The service is unavailable for a moment. Try again in ${UNAVAILABLE_RETRY_AFTER_SECONDS} seconds.`,
    undefined,
    { retryAfterSeconds: UNAVAILABLE_RETRY_AFTER_SECONDS, cause },
  );
}
