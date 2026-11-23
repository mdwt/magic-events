import { AsyncLocalStorage } from "node:async_hooks";
import type { Db, Tx } from "@magic-events/db";
import type { Transactions } from "../../core/shared/transactions.ts";

// The storage side of the Transactions port. A repository is built with the database handle from here.
// Outside a transaction the handle is the plain database; inside `run` it is the open transaction, so every
// repository of every domain writes into the same one without being handed it.
export function createTransactionalDb(db: Db): { db: Db; transactions: Transactions } {
  const open = new AsyncLocalStorage<Tx>();

  const handle = new Proxy(db, {
    get(target, property) {
      const current: Db | Tx = open.getStore() ?? target;
      const value: unknown = Reflect.get(current, property, current);
      return typeof value === "function" ? (value.bind(current) as unknown) : value;
    },
  });

  const transactions: Transactions = {
    run(work) {
      if (open.getStore()) return work();
      return db.transaction((tx) => open.run(tx, work));
    },
  };

  return { db: handle, transactions };
}
