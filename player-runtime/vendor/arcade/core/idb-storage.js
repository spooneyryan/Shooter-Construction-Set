// A Storage-shaped store over IndexedDB, for a shelf that has outgrown
// localStorage.
//
// localStorage gives an origin about five megabytes for everything, and a
// level that carries image sprites as data URLs spends that in a few saves.
// IndexedDB allows hundreds. The catch is that IndexedDB is asynchronous and
// every consumer of `resolveStorage` -- the library, the session that reads
// its draft -- is synchronous and stays so. This is the bridge: a Map is the
// truth, reads and writes are served from it synchronously, every write is
// also queued to the backend in order, and `ready` is the promise that the
// Map has been loaded. A host waits on `ready` once, at mount, before it asks
// for a draft; after that nothing is different.
//
// The backend is injectable, which is how the tests run without a browser and
// how a platform with no IndexedDB still gets a store that behaves: it just
// does not survive a reload, and says so through `persistent`.
//
// Top-level names here are deliberately specific -- see tests/flat-scope.test.mjs
// for why two modules may not share one.

import { createReporter } from "./report.js";

/** Bumped only if the object store's shape changes. It holds strings by key; it will not. */
const IDB_STORE_VERSION = 1;

/** Wraps an IDBRequest in the promise it should have been. */
function idbAwait(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

/** Resolves when a transaction has actually committed, which `request.onsuccess` does not promise. */
function idbCommitted(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

/**
 * The real backend: one database, one object store of strings keyed by name.
 *
 * @param {string} database
 * @param {string} store
 */
export function createIndexedDbBackend(database, store) {
  let opening = null;
  const open = () => {
    opening ??= new Promise((resolve, reject) => {
      const request = globalThis.indexedDB.open(database, IDB_STORE_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB would not open"));
      request.onblocked = () => reject(new Error("IndexedDB open was blocked by another tab"));
    });
    return opening;
  };
  return {
    async load() {
      const db = await open();
      const objects = db.transaction(store, "readonly").objectStore(store);
      const [keys, values] = await Promise.all([idbAwait(objects.getAllKeys()), idbAwait(objects.getAll())]);
      const map = new Map();
      keys.forEach((key, index) => {
        if (typeof key === "string" && typeof values[index] === "string") map.set(key, values[index]);
      });
      return map;
    },
    async put(key, value) {
      const db = await open();
      const transaction = db.transaction(store, "readwrite");
      transaction.objectStore(store).put(value, key);
      await idbCommitted(transaction);
    },
    async remove(key) {
      const db = await open();
      const transaction = db.transaction(store, "readwrite");
      transaction.objectStore(store).delete(key);
      await idbCommitted(transaction);
    },
  };
}

/**
 * A backend that is only a Map, for tests and for a platform without
 * IndexedDB. Asynchronous like the real one, so the facade is exercised the
 * same way, and it keeps the order of operations it saw so a test can check it.
 *
 * @param {Iterable<[string, string]>} [seed]
 */
export function createIndexedDbMemoryBackend(seed = []) {
  const held = new Map(seed);
  const operations = [];
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    held,
    operations,
    async load() { await tick(); return new Map(held); },
    async put(key, value) { await tick(); held.set(key, value); operations.push(["put", key]); },
    async remove(key) { await tick(); held.delete(key); operations.push(["remove", key]); },
  };
}

/**
 * @param {object} [options]
 * @param {string} [options.database]
 * @param {string} [options.store]
 * @param {{load: () => Promise<Map<string,string>>, put: (key: string, value: string) => Promise<void>, remove: (key: string) => Promise<void>} | null} [options.backend]
 *        Injected for tests; defaults to IndexedDB where the platform has it, and to nothing where it does not.
 * @param {string[]} [options.migrateFrom]
 *        localStorage keys to carry across on the first run, when the backend does not already hold them.
 * @param {boolean} [options.removeMigrated]
 *        Let go of the localStorage originals once their copies have committed. Defaults to true: a
 *        full localStorage is the reason anyone is here, and leaving the shelf in it would keep it full.
 * @param {{event?: Function} | ((name: string, data?: unknown) => void)} [options.report]
 *        Sink for `storage.migrated`, `storage.write-failed` and `storage.load-failed`.
 */
export function createIndexedDbStorage({
  database = "arcade-storage",
  store = "kv",
  backend = globalThis.indexedDB ? createIndexedDbBackend(database, store) : null,
  migrateFrom = [],
  removeMigrated = true,
  report,
} = {}) {
  const map = new Map();
  /** Keys written before the load finished, which the load must not overwrite. */
  const writtenEarly = new Set();
  let queue = Promise.resolve();
  let failed = null;
  let persistent = backend !== null;
  // A telemetry instance or a plain function, as every sibling in core takes it.
  const emit = createReporter(report);

  const enqueue = (operation, key) => {
    if (!backend) return;
    queue = queue.then(operation).catch((error) => {
      failed = error;
      persistent = false;
      emit("storage.write-failed", { key, error });
    });
  };

  const ready = (async () => {
    if (!backend) return;
    try {
      const loaded = await backend.load();
      for (const [key, value] of loaded) if (!writtenEarly.has(key)) map.set(key, value);
      // The first run over an old localStorage shelf: copy what is there and
      // not yet here, commit it, and only then let go of the originals.
      const local = typeof globalThis.localStorage !== "undefined" ? globalThis.localStorage : null;
      const migrated = [];
      if (local) {
        for (const key of migrateFrom) {
          if (map.has(key)) continue;
          let value = null;
          try { value = local.getItem(key); } catch { value = null; }
          if (value === null) continue;
          map.set(key, value);
          enqueue(() => backend.put(key, value), key);
          migrated.push(key);
        }
        if (migrated.length) {
          await queue;
          const removed = !failed && removeMigrated;
          if (removed) for (const key of migrated) { try { local.removeItem(key); } catch { /* the copy is safe; the original merely stays */ } }
          emit("storage.migrated", { keys: migrated, removed });
        }
      }
    } catch (error) {
      failed = error;
      persistent = false;
      emit("storage.load-failed", { error });
    }
  })();

  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      const text = String(value);
      map.set(key, text);
      writtenEarly.add(key);
      enqueue(() => backend.put(key, text), key);
    },
    removeItem: (key) => {
      map.delete(key);
      writtenEarly.add(key);
      enqueue(() => backend.remove(key), key);
    },
    key: (index) => [...map.keys()][index] ?? null,
    get length() { return map.size; },
    get size() { return map.size; },
    /** Resolved once the Map holds what the backend held. Never rejects: a failed load reports and leaves the store in memory. */
    ready,
    /** Whether writes are reaching a store that survives a reload. */
    get persistent() { return persistent; },
    /** The last write or load that failed, or null. */
    get failed() { return failed; },
    /** Resolves when every write queued so far has been committed. */
    flush: () => queue,
  };
}
