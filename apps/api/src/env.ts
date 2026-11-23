import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.url(),
  API_HOST: z.string().default("0.0.0.0"),
  API_PORT: z.coerce.number().int().default(4000),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
});

export const env = schema.parse(process.env);
export type Env = typeof env;
