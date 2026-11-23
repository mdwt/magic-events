import cors from "@fastify/cors";
import Fastify from "fastify";
import { createDb, sql } from "@magic-events/db";
import type { Env } from "./env.ts";
import { mcpRoutes } from "./mcp.ts";

export async function buildApp(env: Env) {
  const app = Fastify({ logger: true });
  const { db, close } = createDb(env.DATABASE_URL);
  app.addHook("onClose", async () => close());

  await app.register(cors, { origin: env.CORS_ORIGIN });

  app.get("/health", async () => {
    await db.execute(sql`select 1`);
    return { status: "ok" };
  });

  await app.register(mcpRoutes, { db });

  return app;
}
