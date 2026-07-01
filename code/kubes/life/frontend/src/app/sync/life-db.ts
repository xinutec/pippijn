import { Injectable, isDevMode } from '@angular/core';
import {
  addRxPlugin,
  createRxDatabase,
  type RxCollection,
  type RxConflictHandler,
  type RxDatabase,
  type RxJsonSchema,
} from 'rxdb';
import { getRxStorageDexie } from 'rxdb/plugins/storage-dexie';

/** The single shared RxDB database. Every offline collection (shopping, todo,
 *  todo_link, …) is added to THIS one database.
 *
 *  Why a shared service and not `createRxDatabase` per store: calling
 *  `createRxDatabase({ name: 'lifedb' })` more than once throws in production
 *  (`ignoreDuplicate` is dev-only). That bites the moment one screen pulls in
 *  several stores at once — e.g. the to-do graph needs the todo, todo_link and
 *  shopping stores together. One database, collections added on demand, calls
 *  serialised so two collections can't race `addCollections`. */
@Injectable({ providedIn: 'root' })
export class LifeDb {
  private dbPromise?: Promise<RxDatabase>;
  private chain: Promise<unknown> = Promise.resolve();

  private db(): Promise<RxDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = (async () => {
        if (isDevMode()) {
          const { RxDBDevModePlugin } = await import('rxdb/plugins/dev-mode');
          addRxPlugin(RxDBDevModePlugin);
        }
        return createRxDatabase({
          name: 'lifedb',
          storage: getRxStorageDexie(),
          multiInstance: true,
          ignoreDuplicate: isDevMode(),
        });
      })();
    }
    return this.dbPromise;
  }

  /** Add (once) and return a named collection on the shared database. Calls are
   *  serialised so concurrent `collection()` calls can't race `addCollections`. */
  collection<T>(
    name: string,
    schema: RxJsonSchema<T>,
    conflictHandler: RxConflictHandler<T>,
  ): Promise<RxCollection<T>> {
    const result = this.chain.then(async () => {
      const db = await this.db();
      const existing = db.collections[name] as RxCollection<T> | undefined;
      if (existing) return existing;
      const added = await db.addCollections({ [name]: { schema, conflictHandler } });
      return added[name] as RxCollection<T>;
    });
    // Keep the chain alive even if this add fails, so later adds still run.
    this.chain = result.catch(() => undefined);
    return result;
  }
}
