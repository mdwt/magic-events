import { AsyncLocalStorage } from "node:async_hooks";
import type { Db, Tx } from "@magic-events/db";
import type { Transactions } from "../../core/shared/transactions.ts";

// The storage side of the Transactions port. A repository is built with the database handle from here.
// Outside a transaction the handle is the plain database; inside `run` it is the open transaction, so every
// repository of every domain writes into the same one without being handed it.

interface OpenTransaction {
  tx: Tx;
  // What to do once the transaction has committed. Dropped when it rolls back.
  afterCommit: (() => void)[];
}

export interface TransactionalDb {
  db: Db;
  transactions: Transactions;
  // Runs the callback once the open transaction has committed, or at once when none is open.
  // When the transaction rolls back the callback is never run.
  afterCommit(callback: () => void): void;
}

export function createTransactionalDb(db: Db): TransactionalDb {
  const open = new AsyncLocalStorage<OpenTransaction>();

  const handle = new Proxy(db, {
    get(target, property) {
      const current: Db | Tx = open.getStore()?.tx ?? target;
      const value: unknown = Reflect.get(current, property, current);
      return typeof value === "function" ? (value.bind(current) as unknown) : value;
    },
  });

  const transactions: Transactions = {
    async run(work) {
      if (open.getStore()) return work();
      const afterCommit: (() => void)[] = [];
      const result = await db.transaction((tx) => open.run({ tx, afterCommit }, work));
      for (const callback of afterCommit) callback();
      return result;
    },
  };

  return {
    db: handle,
    transactions,
    afterCommit(callback) {
      const current = open.getStore();
      if (current) current.afterCommit.push(callback);
      else callback();
    },
  };
}
