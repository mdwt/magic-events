import type { apiKey } from "@better-auth/api-key";
import type { Auth as BetterAuth, DBAdapter } from "better-auth";
import type { Organizations, Role } from "../organizations/ports.ts";
import { AppError } from "../shared/errors.ts";
import type { Logger } from "../shared/logger.ts";
import type { IdentitySettings } from "../shared/settings.ts";
import {
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
  api: Pick<BetterAuth<{ plugins: [ReturnType<typeof apiKey>] }>["api"], "createApiKey" | "verifyApiKey">;
  $context: Promise<{ adapter: Pick<DBAdapter, "findMany"> }>;
}

// Who may do what. Every action is listed, so a new action cannot be added without deciding who may do it.
// On top of this table, a client may act only while their tenant is active.
const ALLOWED: Record<Action, Record<Role, boolean>> = {
  "experiences.search": { client: true, system_admin: true },
  "experiences.changes": { client: true, system_admin: true },
  "tenants.manage": { client: false, system_admin: true },
  "mcp.use": { client: true, system_admin: true },
  "health.read": { client: true, system_admin: true },
  "openapi.read": { client: true, system_admin: true },
};

// One message for a missing, unknown, disabled or expired key, so a caller cannot tell which.
export const UNAUTHENTICATED_MESSAGE = "A valid API key is required. Send it as: Authorization: Bearer <key>.";

const NAME_MAX_LENGTH = 32;
const KINDS: readonly CallerKind[] = ["person", "agent"];

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
        throw new CredentialRateLimitedError(
          "This API key has made too many requests. Wait before trying again.",
          retryAfterSeconds,
        );
      }
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
      throw new AppError("forbidden", "You may not do this.");
    }
    if (caller.role === "client" && caller.tenant?.status !== "active") {
      this.#logger.warn({ action, reason: "tenant not active" }, "Action refused");
      throw new AppError("forbidden", "Your organisation's access is suspended. Contact support to restore it.");
    }
  }

  async issueCredential(input: { userId: string; kind: CallerKind; name: string }): Promise<IssuedCredential> {
    const name = input.name.trim();
    if (name.length === 0 || name.length > NAME_MAX_LENGTH) {
      throw new AppError("invalid_input", "The credential's name is not valid.", [
        { path: "name", message: `Must be 1 to ${NAME_MAX_LENGTH} characters.` },
      ]);
    }
    const membership = await this.#organizations.getMembership(input.userId);
    if (membership === null) throw new AppError("not_found", "There is no user with this ID.");

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
    this.#logger.info({ userId: input.userId, credentialId: created.id, kind: input.kind }, "Credential issued");
    return { id: created.id, key: created.key };
  }

  async listCredentials(userId: string): Promise<CredentialSummary[]> {
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
  return KINDS.find((kind) => kind === value.kind) ?? null;
}

// The plugin says how long to wait, in milliseconds, in the error's details.
function retryAfter(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("details" in error)) return undefined;
  const details = error.details;
  if (typeof details !== "object" || details === null || !("tryAgainIn" in details)) return undefined;
  const ms = details.tryAgainIn;
  return typeof ms === "number" && ms > 0 ? Math.ceil(ms / 1000) : undefined;
}
