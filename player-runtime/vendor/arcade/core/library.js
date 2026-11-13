// The shelf a construction set saves onto: named documents, plus the draft.
//
// Both games grew the same thing independently. Pinball keeps an array of table
// documents under one key, caps it, resolves a name collision by appending
// "(shared)", and tracks whether storage works at all. Starline keeps an object
// map of name to level under one key, with no cap, no collision handling and a
// bare try/catch. This is Pinball's version, which is the better of the two,
// with Starline's draft debounce left to the caller where it belongs.
//
// What is deliberately NOT here: the storage key. Both games already have saved
// work under keys that follow no shared convention -- Starline's
// `starline-level-library-v1` and Pinball's `pinball-construction-lab.tables.v1`
// -- so a library that derived its own key from a namespace would silently
// orphan every save either game has ever made. The key is the caller's, always.

import { createReporter } from "./report.js";
import { resolveStorage } from "./storage.js";
import { uniqueId } from "./validate.js";

/** The shape this module writes. Anything else on the key is `migrate`'s job. */
const SHELF_VERSION = 1;

function isShelf(raw) {
  return Boolean(raw) && typeof raw === "object" && !Array.isArray(raw) &&
    raw.version === SHELF_VERSION && Array.isArray(raw.entries);
}

/**
 * @param {object} options
 * @param {{parse: (input: unknown) => any, serialize: (document: any) => string}} options.format
 *        A `defineFormat` instance, typed structurally: DocumentFormat lives in
 *        the hand-written .d.ts and is not reachable from a JSDoc import of the
 *        .js module. Every document read is parsed through it, so a corrupt or
 *        foreign entry is dropped rather than handed to the game.
 * @param {string} options.key        Storage key for the shelf. The caller's,
 *        so an existing game keeps the saves it already has.
 * @param {string} [options.draftKey] Storage key for the working draft. Without
 *        one, the draft methods are no-ops that report `false`.
 * @param {number} [options.limit]    Most documents kept; the oldest go first.
 * @param {(raw: any) => Array<{name?: string, savedAt?: string, document: any}>} [options.migrate]
 *        Converts whatever a game stored before this module into entries. Runs
 *        once: the result is written back in this module's shape.
 * @param {Storage|null} [options.storage] Defaults to localStorage, memory when
 *        the browser blocks it. Pass null to force memory.
 * @param {{event?: Function} | ((name: string, data?: unknown) => void)} [options.report]
 */
export function defineLibrary({
  format,
  key,
  draftKey,
  limit = 30,
  migrate,
  storage,
  report,
}) {
  if (!format || typeof format.parse !== "function") {
    throw new Error("A library needs a document format.");
  }
  if (!key) throw new Error("A library needs a storage key.");

  const { store, persistent } = resolveStorage(storage);
  const emit = createReporter(report);
  // Reported once, not per write. A browser that refuses to persist refuses
  // every time, and a game whose saves are silently going nowhere is exactly
  // the thing worth one event rather than none.
  let blockedReported = !persistent;
  if (!persistent) emit("library.storage-blocked", { key });
  let writable = persistent;

  function reportBlocked(during) {
    writable = false;
    if (blockedReported) return;
    blockedReported = true;
    emit("library.storage-blocked", { key, during });
  }

  /** Never throws. A shelf that cannot be read is an empty shelf. */
  function readShelf() {
    let raw;
    try {
      const stored = store.getItem(key);
      if (!stored) return [];
      raw = JSON.parse(stored);
    } catch {
      return [];
    }
    const rows = isShelf(raw)
      ? raw.entries
      : typeof migrate === "function" ? safeMigrate(raw) : [];
    const entries = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || typeof row !== "object") continue;
      let document;
      try {
        document = format.parse(row.document ?? row);
      } catch (error) {
        // One unreadable entry must not cost the player the other twenty-nine.
        emit("library.entry-rejected", {
          key,
          reason: error && typeof error === "object" && "reason" in error ? error.reason : "invalid",
        });
        continue;
      }
      entries.push({
        id: typeof row.id === "string" && row.id ? row.id : uniqueId("doc"),
        name: String(row.name ?? document.name ?? "Untitled").slice(0, 120),
        savedAt: typeof row.savedAt === "string" ? row.savedAt : document.savedAt,
        document,
      });
    }
    return entries;
  }

  function safeMigrate(raw) {
    try {
      const migrated = migrate(raw);
      return Array.isArray(migrated) ? migrated : [];
    } catch {
      return [];
    }
  }

  function writeShelf(entries) {
    try {
      store.setItem(key, JSON.stringify({ version: SHELF_VERSION, entries }));
      writable = true;
      return true;
    } catch {
      reportBlocked("save");
      return false;
    }
  }

  const meta = ({ id, name, savedAt }) => ({ id, name, savedAt });

  const api = {
    /** False once a write has actually been refused, not merely suspected. */
    get available() { return writable; },
    get key() { return key; },
    get limit() { return limit; },
    /**
     * Resolved once the store has loaded what it holds. An IndexedDB store
     * needs a moment after construction; localStorage and memory are ready at
     * once. A host that restores a draft at mount waits on this first.
     */
    get ready() { return store.ready ?? Promise.resolve(); },
    /** Resolves when every write so far has actually been committed. */
    flush() { return typeof store.flush === "function" ? store.flush() : Promise.resolve(); },

    /** Metadata only, newest first. */
    list() {
      return readShelf()
        .sort((a, b) => String(b.savedAt ?? "").localeCompare(String(a.savedAt ?? "")))
        .map(meta);
    },

    /**
     * Every entry WITH its document, in one read of the shelf.
     *
     * `list` plus a `read` per id is the same information for n+1 parses of
     * everything, which for a capped shelf of two-hundred-part documents is
     * hundreds of thousands of field clamps to draw one dialog. Pinball wants
     * a part count on every card in its library, so it wants exactly this;
     * Starline only ever wants names and one document, so it wants `list` and
     * `readByName`. Both are here because the two games genuinely differ.
     */
    entries() {
      return readShelf()
        .sort((a, b) => String(b.savedAt ?? "").localeCompare(String(a.savedAt ?? "")));
    },

    /** The parsed document, or null if this id is not on the shelf. */
    read(id) {
      return readShelf().find((entry) => entry.id === id)?.document ?? null;
    },

    /** The parsed document under this exact name, or null. */
    readByName(name) {
      const wanted = String(name).trim().toLowerCase();
      return readShelf().find((entry) => entry.name.trim().toLowerCase() === wanted)?.document ?? null;
    },

    /**
     * Upsert. Matching is by `id` when one is given, and otherwise by name --
     * which is what makes a plain "Save" overwrite the save of the same name
     * instead of growing a second copy of it every time.
     *
     * @param {any} input
     * @param {{id?: string, name?: string}} [options]
     * @returns {{id: string, name: string, savedAt: string}|null} null if the
     *          write was refused by storage.
     */
    save(input, { id, name } = {}) {
      const document = format.parse(input);
      const label = String(name ?? document.name ?? "Untitled").trim().slice(0, 120) || "Untitled";
      const entries = readShelf();
      const at = typeof document.savedAt === "string" ? document.savedAt : new Date().toISOString();
      const index = id
        ? entries.findIndex((entry) => entry.id === id)
        : entries.findIndex((entry) => entry.name.trim().toLowerCase() === label.toLowerCase());
      const entry = {
        id: index >= 0 ? entries[index].id : (id || uniqueId("doc")),
        name: label,
        savedAt: at,
        document,
      };
      if (index >= 0) entries[index] = entry;
      else entries.unshift(entry);
      // Oldest first over the cap, so the thing just saved is never the thing
      // discarded -- which is what dropping from the end of an append would do.
      if (entries.length > limit) {
        entries.sort((a, b) => String(b.savedAt ?? "").localeCompare(String(a.savedAt ?? "")));
        entries.length = limit;
        emit("library.full", { key, limit });
      }
      return writeShelf(entries) ? meta(entry) : null;
    },

    remove(id) {
      const entries = readShelf();
      const next = entries.filter((entry) => entry.id !== id);
      if (next.length === entries.length) return false;
      return writeShelf(next);
    },

    /**
     * Relabels the shelf entry. It deliberately does NOT rewrite the document
     * inside, because not every format has a name field to rewrite -- a game
     * that wants the two to agree saves the renamed document back through
     * `save(document, { id })`, which is one call and says what it means.
     */
    rename(id, name) {
      const entries = readShelf();
      const entry = entries.find((candidate) => candidate.id === id);
      if (!entry) return null;
      entry.name = String(name).trim().slice(0, 120) || entry.name;
      return writeShelf(entries) ? meta(entry) : null;
    },

    clear() {
      try { store.removeItem(key); return true; } catch { reportBlocked("clear"); return false; }
    },

    /**
     * A second entry holding a copy of this one's document, under a name the
     * shelf is not using -- "Name (copy)", then "(copy 2)". The copy gets a
     * fresh id, so it is a document in its own right from the first moment.
     * Returns the new entry, or null if the id is unknown or storage refused.
     *
     * @param {string} id
     * @param {{name?: string}} [options]
     */
    duplicate(id, { name } = {}) {
      const source = readShelf().find((entry) => entry.id === id);
      if (!source) return null;
      const label = api.uniqueName(name ?? source.name);
      return api.save(source.document, { id: uniqueId("doc"), name: label });
    },

    /**
     * A name nothing on the shelf is using. Pinball's rule, which is the one
     * worth keeping: try the name, then the name plus a suffix, then numbered
     * suffixes, and only then something that cannot collide. Opening somebody's
     * shared table should not silently overwrite your own of the same name.
     */
    uniqueName(preferred, { suffix = "copy", maxLength = 48 } = {}) {
      const taken = new Set(readShelf().map((entry) => entry.name.trim().toLowerCase()));
      const base = String(preferred ?? "").trim().slice(0, maxLength) || "Untitled";
      if (!taken.has(base.toLowerCase())) return base;
      const fit = (tail) => `${base.slice(0, Math.max(1, maxLength - tail.length))}${tail}`;
      const first = fit(` (${suffix})`);
      if (!taken.has(first.toLowerCase())) return first;
      for (let index = 2; index <= limit + 1; index += 1) {
        const candidate = fit(` (${suffix} ${index})`);
        if (!taken.has(candidate.toLowerCase())) return candidate;
      }
      return fit(` (${suffix} ${uniqueId("n").slice(0, 6)})`);
    },

    /**
     * The working document, kept apart from the named shelf. The caller decides
     * when -- both games debounce it a few hundred milliseconds behind an edit,
     * and that timing is theirs, not this module's.
     */
    saveDraft(input) {
      if (!draftKey) return false;
      try {
        store.setItem(draftKey, format.serialize(input));
        writable = true;
        return true;
      } catch {
        reportBlocked("draft");
        return false;
      }
    },

    /** Null when there is no draft, or when the one there will not parse. */
    readDraft() {
      if (!draftKey) return null;
      try {
        const stored = store.getItem(draftKey);
        return stored ? format.parse(stored) : null;
      } catch {
        return null;
      }
    },

    clearDraft() {
      if (!draftKey) return false;
      try { store.removeItem(draftKey); return true; } catch { reportBlocked("draft"); return false; }
    },
  };
  return api;
}
