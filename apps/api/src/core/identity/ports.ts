import type { Role, TenantStatus } from "../organizations/ports.ts";
import { AppError } from "../shared/errors.ts";

// Identity: knows who is calling and decides what they may do.
// It holds credentials through Better Auth, used directly, and reads role and tenant from Organizations.

// Whether a credential is used by a person or by an agent acting for them. Both have the same access.
export type CallerKind = "person" | "agent";

// Everything a caller can do through the API. Every REST route and every MCP tool names one.
export type Action =
  | "experiences.search"
  | "experiences.changes"
  // Onboarding: creating tenants, adding their users and issuing their credentials. A system admin's alone.
  | "tenants.manage"
  | "mcp.use"
  | "health.read"
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

// What authenticate fails with when a credential has made too many requests: rate_limited, with when to try again.
export class CredentialRateLimitedError extends AppError {
  // Undefined when it is not known.
  readonly retryAfterSeconds: number | undefined;

  constructor(message: string, retryAfterSeconds: number | undefined) {
    super("rate_limited", message);
    this.name = "CredentialRateLimitedError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// Inbound port: what Identity offers.
export interface Identity {
  // Fails with unauthenticated when the credential is missing, unknown, disabled or expired,
  // and with rate_limited when the credential has made too many requests.
  authenticate(credential: string | undefined): Promise<Caller>;
  // Fails with forbidden when the caller's role does not allow the action or their tenant is not active.
  authorise(caller: Caller, action: Action): void;
  // Issues an API key for a user, for REST and MCP alike.
  issueCredential(input: { userId: string; kind: CallerKind; name: string }): Promise<IssuedCredential>;
  // A user's credentials, without the keys.
  listCredentials(userId: string): Promise<CredentialSummary[]>;
}
