import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";

// A local web server for the adapter tests, serving the recorded fixtures. No test calls a real website.

export interface Route {
  status?: number;
  type?: string;
  body?: string | Buffer;
  // Sent gzip-compressed, as most sites do.
  gzip?: boolean;
  // Waits this long before answering.
  delayMs?: number;
  // Answers with a redirect to this path.
  redirectTo?: string;
}

export interface FixtureServer {
  url(path: string): string;
  // Sets what a path answers, as path plus query.
  route(path: string, route: Route): void;
  requests: { path: string; headers: IncomingHttpHeaders }[];
  close(): Promise<void>;
}

export function fixture(name: string): Buffer {
  return readFileSync(new URL(name, import.meta.url));
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const routes = new Map<string, Route>();
  const requests: FixtureServer["requests"] = [];

  const server: Server = createServer((request, response) => {
    const path = request.url ?? "/";
    requests.push({ path, headers: request.headers });
    const route = routes.get(path) ?? { status: 404, type: "text/html", body: "<h1>Not found</h1>" };
    const send = () => {
      if (route.redirectTo !== undefined) {
        response.writeHead(301, { location: route.redirectTo });
        response.end();
        return;
      }
      const body = route.body ?? "";
      const headers: Record<string, string> = { "content-type": route.type ?? "text/html; charset=utf-8" };
      if (route.gzip === true) headers["content-encoding"] = "gzip";
      response.writeHead(route.status ?? 200, headers);
      response.end(route.gzip === true ? gzipSync(body) : body);
    };
    if (route.delayMs === undefined) send();
    else setTimeout(send, route.delayMs);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: (path) => `http://127.0.0.1:${port}${path}`,
    route: (path, route) => routes.set(path, route),
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
