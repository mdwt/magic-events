import type { apiKey } from "@better-auth/api-key";
import type { Auth as BetterAuth, DBAdapter } from "better-auth";
import type { Organizations, Role } from "../organizations/ports.ts";
import { AppError, unavailable } from "../shared/errors.ts";
import type { Logger } from "../shared/logger.ts";
import type { IdentitySettings } from "../shared/settings.ts";
import {
  CALLER_KINDS,
  CREDENTIAL_NAME_MAX_LENGTH,
  CredentialRateLimitedError,
  type Action,
  type Caller,
  type CallerKind,
  type CredentialSummary,
  type Identity,
  type IssuedCredential,
} from "./ports.ts";

// The parts of Better Auth that Identity calls. Identity uses Better Auth directly, the one documented exception to
// ports; the instance is built with its API key plugin by the composition root.
export interface IdentityAuth {
  api: Pick<BetterAuth<{ plugins: [ReturnType<typeof apiKey>] }>["api"], "createApiKey" | "verifyApiKey" | "updateApiKey">;
  $context: Promise<{ adapter: Pick<DBAdapter, "findMany" | "findOne"> }>;
}

// Who may do what. Every action is listed, so a new action cannot be added without deciding who may do it.
// On top of this table, a client may act only while their tenant is active.
const ALLOWED: Record<Action, Record<Role, boolean>> = {
  "experiences.search": { client: true, system_admin: true },
  "experiences.changes": { client: true, system_admin: true },
  "mcp.use": { client: true, system_admin: true },
  "openapi.read": { client: true, system_admin: true },
};

// One message for a missing, unknown, disabled or expired key, so a caller cannot tell which.
export const UNAUTHENTICATED_MESSAGE =
  "This needs a valid API key, sent as Authorization: Bearer <key>. If your key was revoked or has expired, ask for a " +
  "new one.";


export class IdentityService implements Identity {
  readonly #auth: IdentityAuth;
  readonly #organizations: Organizations;
  readonly #settings: IdentitySettings;
  readonly #logger: Logger;

  constructor(deps: { auth: IdentityAuth; organizations: Organizations; settings: IdentitySettings; logger: Logger }) {
    this.#auth = deps.auth;
    this.#organizations = deps.organizations;
    this.#settings = deps.settings;
    this.#logger = deps.logger.child({ domain: "identity" });
  }

  async authenticate(credential: string | undefined): Promise<Caller> {
    if (credential === undefined || credential === "") return this.#refuse("missing");

    const result = await this.#auth.api.verifyApiKey({ body: { key: credential } });
    if (!result.valid || result.key === null) {
      const code = result.error?.code;
      if (code === "RATE_LIMITED" || code === "USAGE_EXCEEDED") {
        const retryAfterSeconds = retryAfter(result.error);
        this.#logger.warn({ reason: code, retryAfterSeconds }, "API key over its rate limit");
        const wait = retryAfterSeconds === undefined ? "a moment" : `${retryAfterSeconds} seconds`;
        throw new CredentialRateLimitedError(
          `This API key has made too many requests. Try again in ${wait}.`,
          retryAfterSeconds,
        );
      }
      if (code === undefined || code === "INVALID_API_KEY") await this.#confirmRefusal(result.error);
      return this.#refuse(code ?? "invalid");
    }

    const key = result.key;
    const kind = kindOf(key.metadata);
    if (kind === null) return this.#refuse("no kind in the key's metadata", key.id);

    const membership = await this.#organizations.getMembership(key.referenceId);
    if (membership === null) return this.#refuse("the key's user does not exist", key.id);

    const { user, tenant } = membership;
    return {
      userId: user.id,
      role: user.role,
      kind,
      credentialId: key.id,
      tenant: tenant ? { id: tenant.id, slug: tenant.slug, status: tenant.status } : null,
    };
  }

  authorise(caller: Caller, action: Action): void {
    if (!ALLOWED[action][caller.role]) {
      this.#logger.warn({ action, reason: "role" }, "Action refused");
      // Every action a client is refused is a system admin's alone.
      throw new AppError("forbidden", "Only a system admin may do this.");
    }
    if (caller.role === "client" && caller.tenant?.status !== "active") {
      this.#logger.warn({ action, reason: "tenant not active" }, "Action refused");
      throw new AppError("forbidden", "Your organisation's access is suspended. Contact support to restore it.");
    }
  }

  async issueCredential(input: { userId: string; kind: CallerKind; name: string }): Promise<IssuedCredential> {
    const name = input.name.trim();
    if (name.length === 0 || name.length > CREDENTIAL_NAME_MAX_LENGTH) {
      const message = `Give the API key a name of 1 to ${CREDENTIAL_NAME_MAX_LENGTH} characters, such as planning desk.`;
      throw new AppError("invalid_input", message, [{ path: "name", message }]);
    }
    await this.#requireUser(input.userId);

    const created = await this.#auth.api.createApiKey({
      body: {
        userId: input.userId,
        name,
        metadata: { kind: input.kind },
        rateLimitEnabled: true,
        rateLimitMax: this.#settings.apiKeyRateLimitMax,
        rateLimitTimeWindow: this.#settings.apiKeyRateLimitWindowSeconds * 1000,
      },
    });
    // Under its own key, so the caller's userId and credentialId on the line still say who did it. Never the key.
    this.#logger.info({ credential: { id: created.id, userId: input.userId, kind: input.kind } }, "Credential issued");
    return { id: created.id, key: created.key };
  }

  async listCredentials(userId: string): Promise<CredentialSummary[]> {
    await this.#requireUser(userId);
    // The plugin's list endpoint needs a signed-in session, which a server call does not have, so the keys are read
    // through Better Auth's own adapter. The hashed keys are never read out.
    const { adapter } = await this.#auth.$context;
    const keys = await adapter.findMany<{ id: string; name: string | null; enabled: boolean | null; metadata: unknown }>({
      model: "apikey",
      where: [{ field: "referenceId", value: userId }],
      select: ["id", "name", "enabled", "metadata"],
    });
    return keys.map((key) => ({
      id: key.id,
      name: key.name,
      kind: kindOf(key.metadata) ?? "person",
      enabled: key.enabled !== false,
    }));
  }

  async revokeCredential(userId: string, credentialId: string): Promise<CredentialSummary> {
    // Only this user's credentials are searched, so another user's credential ID is not_found too.
    const credentials = await this.listCredentials(userId);
    if (!credentials.some((credential) => credential.id === credentialId)) {
      throw new AppError("not_found", "This user has no API key with this ID. List their keys to see the IDs.");
    }
    // Disabled rather than deleted: the plugin deletes a key only for a signed-in session, verifyApiKey refuses a
    // disabled key just the same, and the user's list still shows the key was revoked.
    const updated = await this.#auth.api.updateApiKey({ body: { keyId: credentialId, userId, enabled: false } });
    this.#logger.info({ credential: { id: credentialId, userId } }, "Credential revoked");
    return { id: updated.id, name: updated.name, kind: kindOf(updated.metadata) ?? "person", enabled: updated.enabled };
  }

  async #requireUser(userId: string): Promise<void> {
    const membership = await this.#organizations.getMembership(userId);
    if (membership === null) throw new AppError("not_found", "There is no user with this ID.");
  }

  // The plugin's key check catches every error inside it and answers INVALID_API_KEY, the verdict it also gives a key
  // it does not hold. With its logger off it says nothing else. So that verdict is trusted only once the key store
  // answers: if it does not, the check could not be made, and the caller is told to try again, not that their key is
  // wrong. The catch-all also gives its message as an object where a real verdict gives text, so a failure inside the
  // check while the store answers is a system error too.
  async #confirmRefusal(error: { message?: unknown } | null | undefined): Promise<void> {
    const { adapter } = await this.#auth.$context;
    try {
      await adapter.findOne({ model: "apikey", where: [{ field: "id", value: "" }] });
    } catch (cause) {
      throw unavailable(cause);
    }
    if (typeof error?.message !== "string") {
      throw new Error("The API key check failed inside Better Auth, which did not say why.");
    }
  }

  #refuse(reason: string, credentialId?: string): never {
    this.#logger.warn({ reason, credentialId }, "Authentication refused");
    throw new AppError("unauthenticated", UNAUTHENTICATED_MESSAGE);
  }
}

// The kind recorded in a key's metadata, which Better Auth returns as an object or, read raw, as JSON text.
function kindOf(metadata: unknown): CallerKind | null {
  let value = metadata;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null || !("kind" in value)) return null;
  return CALLER_KINDS.find((kind) => kind === value.kind) ?? null;
}

// The plugin says how long to wait, in milliseconds, in the error's details.
function retryAfter(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("details" in error)) return undefined;
  const details = error.details;
  if (typeof details !== "object" || details === null || !("tryAgainIn" in details)) return undefined;
  const ms = details.tryAgainIn;
  return typeof ms === "number" && ms > 0 ? Math.ceil(ms / 1000) : undefined;
}
