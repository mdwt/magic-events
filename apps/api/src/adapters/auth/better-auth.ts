import { apiKey } from "@better-auth/api-key";
import { account, apikey, session, user, verification, type Db } from "@magic-events/db";
import { betterAuth } from "better-auth/minimal";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { IdentitySettings } from "../../core/shared/settings.ts";

// Every API key starts with this, so a leaked key is easy to recognise and to search for.
export const API_KEY_PREFIX = "mev_";

// Better Auth, which Identity uses directly: the one documented exception to ports. Only its server API is used.
// Its HTTP handler is not mounted, so there is no sign-up, sign-in or key management over HTTP.
export function createAuth(db: Db, settings: IdentitySettings) {
  return betterAuth({
    secret: settings.authSecret,
    database: drizzleAdapter(db, { provider: "pg", schema: { user, session, account, verification, apikey } }),
    user: {
      // Ours, on Better Auth's user table. Organizations writes them; nobody can set them through Better Auth.
      additionalFields: {
        tenantId: { type: "string", required: false, input: false },
        role: { type: ["system_admin", "client"], required: false, defaultValue: "client", input: false },
      },
    },
    telemetry: { enabled: false },
    // Better Auth logs every refused key as an error. Identity logs refused calls itself, at the right level.
    logger: { disabled: true },
    plugins: [
      apiKey({
        defaultPrefix: API_KEY_PREFIX,
        // Whether a key is a person's or an agent's is in its metadata.
        enableMetadata: true,
        rateLimit: {
          enabled: true,
          timeWindow: settings.apiKeyRateLimitWindowSeconds * 1000,
          maxRequests: settings.apiKeyRateLimitMax,
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
