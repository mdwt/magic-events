export type ErrorCode = "unauthenticated" | "forbidden" | "invalid_input" | "not_found" | "rate_limited";

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

  constructor(code: ErrorCode, message: string, details?: ErrorDetail[]) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }
}
