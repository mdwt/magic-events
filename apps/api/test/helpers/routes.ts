import type { FastifyInstance } from "fastify";

// Every method and address the server answers, read from Fastify's own route tree once the app is ready, so a route
// added later is in the list without anyone adding it. HEAD is there for every GET, and "*" is @fastify/cors's
// catch-all OPTIONS route. A parameter keeps Fastify's form, as /things/:id.
export function registeredRoutes(app: FastifyInstance): { method: string; url: string }[] {
  const routes: { method: string; url: string }[] = [];
  const prefixes: string[] = [];
  for (const line of app.printRoutes({ commonPrefix: false }).split("\n")) {
    const match = /^((?:│ {3}| {4})*)[├└]── (\S+) \(([^)]+)\)$/.exec(line);
    if (!match) continue;
    const [, indent = "", segment = "", methods = ""] = match;
    const depth = indent.length / 4;
    prefixes.length = depth;
    const url = `${prefixes.join("")}${segment}`;
    prefixes.push(segment);
    for (const method of methods.split(", ")) routes.push({ method, url });
  }
  return routes.sort((a, b) => `${a.url} ${a.method}`.localeCompare(`${b.url} ${b.method}`));
}
