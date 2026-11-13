// Web Storage that never throws at a call site.
//
// Touching the API is the only reliable probe: Safari's private mode and
// third-party-cookie blocking both expose a `localStorage` object and then
// throw on the first write. So a game that checks for the object's existence
// still crashes, and a game that wraps every call in try/catch has written this
// module badly, spread across a dozen places.
//
// `core/settings.js` carries its own copy of this and is deliberately left
// alone. Extracting it would add an import edge, and a consumer that
// concatenates this package into one flat scope -- Pinball Construction Set,
// building its standalone player -- has to be told about a new module before it
// can link one, which means its own module list has to change first. Converging
// the two is recorded in docs/future.md, for the next time that list changes
// anyway. The names here differ from the private ones in settings.js for the
// same flat-scope reason; see tests/flat-scope.test.mjs.

/** Storage-shaped, backed by a Map. What a blocked browser gets instead. */
export function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    get size() { return map.size; },
  };
}

/**
 * The platform's storage if it actually works, otherwise null.
 * @returns {Storage|null}
 */
export function probeStorage() {
  try {
    const storage = globalThis.localStorage;
    const probe = "__arcade_probe__";
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

/**
 * What a module can write to: the platform's Storage, the Map-backed stand-in
 * above, or the IndexedDB facade in idb-storage.js -- the one that may also
 * say whether it survives a reload, when it has finished loading, and when a
 * write has committed. The three optional members are that facade's; the
 * other two stores simply do not have them, and a reader treats absence as
 * "ready now, persistent unless told otherwise".
 *
 * @typedef {object} StorageLike
 * @property {(key: string) => string | null} getItem
 * @property {(key: string, value: string) => void} setItem
 * @property {(key: string) => void} removeItem
 * @property {boolean} [persistent]
 * @property {Promise<void>} [ready]
 * @property {() => Promise<void>} [flush]
 */

/**
 * Resolves what a module should actually write to, and says whether that
 * survives a reload. Passing `null` explicitly forces memory, which is how a
 * test opts out of touching the platform at all; passing nothing probes.
 *
 * @param {StorageLike|null|undefined} preferred
 * @returns {{store: StorageLike, persistent: boolean}}
 */
export function resolveStorage(preferred) {
  const store = preferred === undefined ? probeStorage() : preferred;
  // A store may know for itself whether it survives a reload -- the IndexedDB
  // facade in idb-storage.js does -- and its own word beats the presence test.
  const persistent = store ? (typeof store.persistent === "boolean" ? store.persistent : true) : false;
  return { store: store ?? createMemoryStorage(), persistent };
}
