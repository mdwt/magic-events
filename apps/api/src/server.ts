import { buildApp } from "./app.ts";
import { env } from "./env.ts";

const app = await buildApp(env);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ host: env.API_HOST, port: env.API_PORT });
