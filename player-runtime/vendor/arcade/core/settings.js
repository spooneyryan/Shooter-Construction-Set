// One namespaced key, one schema, one sanitizer.
//
// This replaces the twelve hand-written setX/restoreX pairs in Pinball
// Construction Set and the single sanitized blob in SpeegeBall with the same
// model: a field schema that knows how to clamp itself, a versioned envelope
// that can be migrated, and a store that degrades to memory when the browser
// blocks persistence rather than throwing at every call site.

import { createReporter } from "./report.js";
import {
  asBoolean,
  boundedInteger,
  boundedNumber,
  boundedString,
  hexColor,
  oneOf,
  snapped,
} from "./validate.js";

class MemoryStorage {
  #map = new Map();
  getItem(key) { return this.#map.has(key) ? this.#map.get(key) : null; }
  setItem(key, value) { this.#map.set(key, String(value)); }
  removeItem(key) { this.#map.delete(key); }
}

function defaultStorage() {
  try {
    const storage = globalThis.localStorage;
    // Touching the API is the only reliable probe: Safari private mode and
    // third-party-cookie blocking both expose the object and then throw.
    const probe = "__arcade_probe__";
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

function sanitizeField(field, value) {
  switch (field.type) {
    case "number":
      return field.step
        ? snapped(value, field.default, field.min, field.max, field.step)
        : boundedNumber(value, field.default, field.min, field.max);
    case "integer":
      return boundedInteger(value, field.default, field.min, field.max);
    case "boolean":
      return asBoolean(value, field.default);
    case "enum":
      return oneOf(value, field.values, field.default);
    case "color":
      return hexColor(value, field.default);
    case "string":
      return boundedString(value, field.default, field.maxLength ?? 120);
    default:
      throw new Error(`Unknown settings field type "${field.type}".`);
  }
}

/**
 * @param {object} options
 * @param {string} options.namespace  Storage key prefix, e.g. "voidcut".
 * @param {number} [options.version]  Bump when a migration is needed.
 * @param {Record<string, object>} options.fields
 * @param {Storage|null} [options.storage]  Defaults to localStorage, memory if blocked.
 * @param {(values: object, fromVersion: number) => object} [options.migrate]
 * @param {{event?: Function} | ((name: string, data?: unknown) => void)} [options.report]
 *        Sink for `settings.storage-blocked`, reported once when the browser
 *        refuses to persist rather than on every write.
 */
export function defineSettings({
  namespace,
  version = 1,
  fields,
  storage = defaultStorage(),
  migrate,
  report,
}) {
  if (!namespace) throw new Error("Settings need a namespace.");
  if (!fields || typeof fields !== "object") throw new Error("Settings need a fields schema.");

  const names = Object.keys(fields);
  const key = `${namespace}.settings`;
  const store = storage ?? new MemoryStorage();
  const persistent = Boolean(storage);
  const listeners = new Set();
  const fieldListeners = new Map();

  const defaults = () => {
    const result = {};
    for (const name of names) result[name] = fields[name].default;
    return result;
  };

  /** Clamp every known field and drop everything else. */
  function sanitize(candidate) {
    const source = candidate && typeof candidate === "object" ? candidate : {};
    const result = {};
    for (const name of names) {
      result[name] = sanitizeField(fields[name], source[name]);
    }
    return result;
  }

  // A browser that refuses to persist is invisible from the inside: the player
  // just finds their settings gone next visit. Report it once — repeating it on
  // every write would say nothing new.
  const emit = createReporter(report);
  let reportedBlocked = false;
  function noteBlocked(during) {
    if (reportedBlocked) return;
    reportedBlocked = true;
    emit("settings.storage-blocked", { namespace, during });
  }

  let available = persistent;
  let values = defaults();

  function read() {
    let raw;
    try {
      raw = store.getItem(key);
    } catch {
      // Only a throw from storage itself means storage is unusable. A value
      // that will not parse is a corrupt setting, not a blocked browser, and
      // reporting it as blocked sends the operator looking in the wrong place.
      available = false;
      noteBlocked("read");
      return defaults();
    }

    try {
      if (!raw) return defaults();
      const envelope = JSON.parse(raw);
      // Anything without an envelope is a pre-library blob; treat the whole
      // object as version-0 values so old saves survive the upgrade.
      const storedVersion = Number.isFinite(envelope?.v) ? envelope.v : 0;
      const stored = envelope?.values ?? envelope;
      if (storedVersion > version) return defaults();
      const upgraded = storedVersion < version && typeof migrate === "function"
        ? migrate(stored, storedVersion)
        : stored;
      return sanitize(upgraded);
    } catch {
      // Corrupt or unparseable. Storage still works, so `available` stays true
      // and the next write will replace the bad value.
      emit("settings.corrupt", { namespace });
      return defaults();
    }
  }

  function write() {
    try {
      store.setItem(key, JSON.stringify({ v: version, values }));
      available = persistent;
      return true;
    } catch {
      available = false;
      noteBlocked("write");
      return false;
    }
  }

  if (!persistent) noteBlocked("open");

  function notify(changed) {
    if (!changed.length) return;
    const snapshot = Object.freeze({ ...values });
    for (const listener of listeners) listener(snapshot, changed);
    for (const name of changed) {
      const scoped = fieldListeners.get(name);
      if (!scoped) continue;
      for (const listener of scoped) listener(values[name], name);
    }
  }

  /** Apply a partial update; returns the names that actually changed. */
  function apply(patch, { persist = true } = {}) {
    const changed = [];
    for (const [name, raw] of Object.entries(patch ?? {})) {
      if (!(name in fields)) continue;
      const next = sanitizeField(fields[name], raw);
      if (Object.is(next, values[name])) continue;
      values[name] = next;
      changed.push(name);
    }
    if (changed.length && persist) write();
    notify(changed);
    return changed;
  }

  values = read();

  return {
    /** Field names that were declared, in schema order. */
    get names() { return [...names]; },
    /** False once the browser has refused to persist. Show an export hint. */
    get available() { return available; },
    get version() { return version; },
    get storageKey() { return key; },

    get(name) { return values[name]; },
    all() { return Object.freeze({ ...values }); },
    defaults,

    set(name, value) { return apply({ [name]: value }).length > 0; },
    patch(next, options) { return apply(next, options); },

    reset() {
      const changed = names.filter((name) => !Object.is(values[name], fields[name].default));
      values = defaults();
      write();
      notify(changed);
      return changed;
    },

    /** Re-read from storage — for the `storage` event across tabs. */
    reload() {
      const next = read();
      const changed = names.filter((name) => !Object.is(next[name], values[name]));
      values = next;
      notify(changed);
      return changed;
    },

    /**
     * Sanitized values off a form, so a settings dialog is a plain `<form>`
     * round-trip rather than a per-input read function.
     *
     * Pass the form element itself where possible. FormData cannot tell an
     * unchecked checkbox from a field the form does not have — both are simply
     * absent — so reading a partial form through FormData alone would silently
     * set every setting the dialog does not show to false. Given the element,
     * `form.elements` settles it: only the fields the form actually owns come
     * back, which makes the result safe to hand straight to `patch`.
     */
    fromFormData(source) {
      const isForm = typeof globalThis.HTMLFormElement === "function" &&
        source instanceof globalThis.HTMLFormElement;
      const data = isForm ? new globalThis.FormData(source) : source;
      const raw = typeof globalThis.FormData === "function" && data instanceof globalThis.FormData
        ? Object.fromEntries(data.entries())
        : { ...data };

      // namedItem, not property access: HTMLFormControlsCollection has its own
      // properties, so `elements.length` is a number whether or not the form
      // has a control called "length" — and a field with that name would be
      // treated as owned and reset to its default on every save.
      const owned = isForm
        ? names.filter((name) => source.elements.namedItem?.(name) != null)
        : names.filter((name) => name in raw);

      const result = {};
      for (const name of owned) {
        // Present in the form but absent from the data means unchecked.
        const value = fields[name].type === "boolean" && isForm && !(name in raw)
          ? false
          : raw[name];
        result[name] = sanitizeField(fields[name], value);
      }
      return result;
    },

    /**
     * Which of the supplied changes cannot take effect until the game
     * restarts. Everything else is expected to apply live — the default is
     * live-apply, and `requiresRestart` is the documented exception.
     */
    restartRequired(next) {
      return Object.keys(next ?? {}).filter(
        (name) => fields[name]?.requiresRestart && !Object.is(sanitizeField(fields[name], next[name]), values[name]),
      );
    },

    subscribe(nameOrListener, maybeListener) {
      if (typeof nameOrListener === "function") {
        listeners.add(nameOrListener);
        return () => listeners.delete(nameOrListener);
      }
      const name = nameOrListener;
      if (!(name in fields)) throw new Error(`Unknown setting "${name}".`);
      if (!fieldListeners.has(name)) fieldListeners.set(name, new Set());
      fieldListeners.get(name).add(maybeListener);
      return () => fieldListeners.get(name)?.delete(maybeListener);
    },

    /** Exposed so a game can validate an imported settings file. */
    sanitize,
    field(name) { return fields[name]; },
  };
}
