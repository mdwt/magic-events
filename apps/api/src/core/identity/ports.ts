import { z } from "zod";
import type { Role, TenantStatus } from "../organizations/ports.ts";
import { AppError } from "../shared/errors.ts";

// Identity: knows who is calling and decides what they may do.
// It holds credentials through Better Auth, used directly, and reads role and tenant from Organizations.

// Whether a credential is used by a person or by an agent acting for them. Both have the same access.
export const CALLER_KINDS = ["person", "agent"] as const;
export type CallerKind = (typeof CALLER_KINDS)[number];

export const CREDENTIAL_NAME_MAX_LENGTH = 32;

// Everything a caller can do through the API. Every REST route and every MCP tool names one.
export type Action =
  | "experiences.search"
  | "experiences.changes"
  // Onboarding: creating tenants, adding their users and issuing their credentials. A system admin's alone.
  | "tenants.manage"
  | "mcp.use"
  | "openapi.read";

// Who is calling, as established by Identity for one request.
export interface Caller {
  userId: string;
  role: Role;
  kind: CallerKind;
  // The ID of the credential used, for the logs. Never the credential itself.
  credentialId: string;
  // Empty for a system admin.
  tenant: { id: string; slug: string; status: TenantStatus } | null;
}

export interface IssuedCredential {
  id: string;
  // The API key. It is shown once, here, and stored only as a hash.
  key: string;
}

export interface CredentialSummary {
  id: string;
  name: string | null;
  kind: CallerKind;
  enabled: boolean;
}

// ---- Credentials: what a system admin sends and gets, over REST and MCP alike ----

const userIdSchema = z.string().min(1).max(128).describe("The user's ID, as returned when the user was added.");

export const userIdParamsSchema = z.strictObject({ userId: userIdSchema });

export const credentialParamsSchema = z.strictObject({
  userId: userIdSchema,
  credentialId: z.string().min(1).max(128).describe("The credential's ID, as returned when it was issued or listed."),
});

export const issueCredentialInputSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(CREDENTIAL_NAME_MAX_LENGTH)
    .describe("A name that says where the key is used, such as \"planning desk\" or \"trip assistant\"."),
  kind: z
    .enum(CALLER_KINDS)
    .describe("Who uses the key: a person, or an AI agent acting for them. Both have the same access."),
});

export const issuedCredentialSchema = z.object({
  id: z.string(),
  key: z.string().describe("The API key. It is shown only in this answer and cannot be read again, so keep it now."),
});

export const credentialSummarySchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  kind: z.enum(CALLER_KINDS),
  enabled: z.boolean().describe("False once the key is revoked: it is refused from then on."),
});

export const credentialListSchema = z.object({ items: z.array(credentialSummarySchema) });

// What authenticate fails with when a credential has made too many requests: rate_limited, with when to try again.
// retryAfterSeconds is undefined when it is not known.
export class CredentialRateLimitedError extends AppError {
  constructor(message: string, retryAfterSeconds: number | undefined) {
    super("rate_limited", message, undefined, { retryAfterSeconds });
    this.name = "CredentialRateLimitedError";
  }
}

// Inbound port: what Identity offers.
export interface Identity {
  // Fails with unauthenticated when the credential is missing, unknown, disabled or expired, with rate_limited when
  // the credential has made too many requests, and with unavailable when the credentials cannot be read, such as
  // while the database is down. A good key is never refused as unauthenticated because the check could not be made.
  authenticate(credential: string | undefined): Promise<Caller>;
  // Fails with forbidden when the caller's role does not allow the action or their tenant is not active.
  authorise(caller: Caller, action: Action): void;
  // Issues an API key for a user, for REST and MCP alike.
  issueCredential(input: { userId: string; kind: CallerKind; name: string }): Promise<IssuedCredential>;
  // A user's credentials, without the keys. Fails with not_found when the user does not exist.
  listCredentials(userId: string): Promise<CredentialSummary[]>;
  // Disables one of a user's credentials, so authenticate refuses it from then on. Fails with not_found when the user
  // does not exist or has no credential with this ID.
  revokeCredential(userId: string, credentialId: string): Promise<CredentialSummary>;
}
