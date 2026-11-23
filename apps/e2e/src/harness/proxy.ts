import { connect, createServer, type Server, type Socket } from "node:net";

// A TCP proxy in front of Postgres, so a server can lose its database and get it back while every other database
// on the same Postgres, the development one included, stays up.

export class DatabaseProxy {
  readonly port: number;
  readonly #target: { host: string; port: number };
  #server: Server | undefined;
  readonly #sockets = new Set<Socket>();

  constructor(port: number, target: { host: string; port: number }) {
    this.port = port;
    this.#target = target;
  }

  open(): Promise<void> {
    const server = createServer((inbound) => {
      const outbound = connect(this.#target.port, this.#target.host);
      for (const socket of [inbound, outbound]) {
        this.#sockets.add(socket);
        socket.on("close", () => this.#sockets.delete(socket));
        socket.on("error", () => {
          inbound.destroy();
          outbound.destroy();
        });
      }
      inbound.pipe(outbound).pipe(inbound);
    });
    this.#server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, "127.0.0.1", () => {
        resolve();
      });
    });
  }

  // The database goes away: no new connection is taken, and every open one is cut.
  close(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    const server = this.#server;
    this.#server = undefined;
    if (server === undefined) return Promise.resolve();
    return new Promise((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}
