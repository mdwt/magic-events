import type { z } from "zod";

// The one way the source adapters reach the network: a GET with a timeout, the configured User-Agent and a cap on
// the size of the answer. Redirects are followed and compressed answers are unpacked by fetch itself.

const MEGABYTE = 1024 * 1024;
// Well above the largest page a source serves today (about 300 KB) and the largest calendar file (about 500 KB).
export const MAX_PAGE_BYTES = 10 * MEGABYTE;
export const MAX_FILE_BYTES = 30 * MEGABYTE;

export interface HttpResponse {
  // The address that answered, after any redirects.
  url: string;
  status: number;
  contentType: string | null;
  body: Uint8Array;
}

// A source that answered with a status other than 2xx.
export class HttpStatusError extends Error {
  readonly status: number;

  constructor(url: string, status: number, statusText: string) {
    super(`GET ${url} answered ${status}${statusText === "" ? "" : ` ${statusText}`}`);
    this.name = "HttpStatusError";
    this.status = status;
  }
}

export interface Http {
  get(url: string, options: { accept: string; maxBytes: number }): Promise<HttpResponse>;
}

export function createHttp(settings: { timeoutSeconds: number; userAgent: string }): Http {
  return {
    async get(url, options) {
      let response: Response;
      // The timeout covers the whole answer, its body included.
      const signal = AbortSignal.timeout(settings.timeoutSeconds * 1000);
      try {
        response = await fetch(url, {
          signal,
          redirect: "follow",
          headers: { "user-agent": settings.userAgent, accept: options.accept },
        });
      } catch (error) {
        throw requestFailed(url, error, settings.timeoutSeconds);
      }

      if (!response.ok) {
        await response.body?.cancel();
        throw new HttpStatusError(url, response.status, response.statusText);
      }

      const tooLarge = new Error(`GET ${url} answered with more than ${options.maxBytes / MEGABYTE} MB`);
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > options.maxBytes) {
        await response.body?.cancel();
        throw tooLarge;
      }

      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        const reader = response.body?.getReader();
        while (reader) {
          // fetch types a body's chunks as any; they are bytes.
          const read: { done: boolean; value?: unknown } = await reader.read();
          if (read.done) break;
          const value = read.value;
          if (!(value instanceof Uint8Array)) throw new Error(`GET ${url} gave a body that is not bytes`);
          size += value.byteLength;
          if (size > options.maxBytes) {
            await reader.cancel();
            throw tooLarge;
          }
          chunks.push(value);
        }
      } catch (error) {
        if (error === tooLarge) throw error;
        throw requestFailed(url, error, settings.timeoutSeconds);
      }

      return {
        url: response.url === "" ? url : response.url,
        status: response.status,
        contentType: response.headers.get("content-type"),
        body: Buffer.concat(chunks),
      };
    },
  };
}

// The body as text, in the character set the answer names, or UTF-8.
export function textOf(response: HttpResponse): string {
  const charset = /charset=["']?([^;"'\s]+)/i.exec(response.contentType ?? "")?.[1];
  try {
    return new TextDecoder(charset ?? "utf-8").decode(response.body);
  } catch {
    // An unknown character set.
    return new TextDecoder("utf-8").decode(response.body);
  }
}

// A source's settings, checked against the kind's schema. Wrong settings fail the run with what is wrong.
export function parseSettings<T>(kind: string, schema: z.ZodType<T>, settings: unknown): T {
  const parsed = schema.safeParse(settings);
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues.map((issue) => {
    const path = issue.path.map(String).join(".");
    return path === "" ? issue.message : `${path}: ${issue.message}`;
  });
  throw new Error(`The ${kind} settings are wrong: ${problems.join("; ")}`);
}

function requestFailed(url: string, error: unknown, timeoutSeconds: number): Error {
  if (error instanceof Error && error.name === "TimeoutError") {
    return new Error(`GET ${url} timed out after ${timeoutSeconds} s`);
  }
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`GET ${url} failed: ${cause ?? message}`);
}
