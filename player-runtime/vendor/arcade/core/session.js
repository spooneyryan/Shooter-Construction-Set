// One document model for every editor.
//
// Every construction set and designer here grew the same chrome by hand --
// a name field, Save, some way to load, some way to fork -- and the same
// button ended up meaning four different things: Save renamed in one game,
// forked in two, and silently overwrote a stranger of the same name in a
// fourth, decided by nothing but whether the host passed an `id` to
// `library.save`. This module is the rule those hosts were missing, written
// once and pinned by tests, so a renderer over it cannot get the semantics
// wrong. (docs/EDITOR-UX.md is the review that produced it.)
//
// The model is the named-document one -- Google Docs, Figma, Notion -- which
// is what a shelf in local storage with live drafts and an inline name field
// already implies:
//
//   - a document has an identity apart from its name; editing the name
//     RENAMES the open document and never creates one;
//   - there is one commit verb, save, and it writes by id -- the first save
//     mints the id, so two documents may share a name without colliding;
//   - the fork is duplicate, which copies what you are looking at, names it
//     "(copy)", and switches you into the copy;
//   - new / open / import never destroy: while the session is dirty they
//     refuse until the caller decides (save, discard, cancel), and unsaved
//     work is autosaved as the library's draft for crash recovery;
//   - delete is undoable for a window, and deleting the open document leaves
//     it open, merely unsaved again.
//
// Nothing here touches the DOM. The renderer -- React in the studio, plain
// elements in the import-map games -- reads `state`, calls the verbs, and
// subscribes for changes. Timers are injectable so the whole thing runs
// under `node --test` with a fake clock.

import { createReporter } from "./report.js";
import { uniqueId } from "./validate.js";

const SESSION_DEFAULTS = {
  draftDebounceMs: 400,
  undoWindowMs: 6000,
};

/**
 * @param {object} options
 * @param {{parse: Function, readFile?: Function, download?: Function, shareLink?: Function}} options.format
 *        A `defineFormat` instance. Only `parse` is required; import, export
 *        and share use the rest when the caller asks for them.
 * @param {object|null} [options.library] A `defineLibrary` instance, or null
 *        for a session with no shelf (save, open and duplicate then report
 *        false and the rest still works).
 * @param {() => any} options.blank  A fresh document. Called by `new`, and at
 *        construction unless `initial` is given.
 * @param {any} [options.initial]  The document to open with, unsaved.
 * @param {(document: any) => string} [options.nameOf]  Reads a document's
 *        display name. Defaults to its `name` field, or "Untitled".
 * @param {(document: any, name: string) => any} [options.withName]  Returns a
 *        copy of the document carrying a new name. Defaults to spreading it in.
 * @param {number} [options.draftDebounceMs]
 * @param {number} [options.undoWindowMs]
 * @param {(fn: Function, ms: number) => any} [options.setTimer]
 * @param {(handle: any) => void} [options.clearTimer]
 * @param {{event?: Function} | ((name: string, data?: unknown) => void)} [options.report]
 */
export function createDocumentSession({
  format,
  library = null,
  blank,
  initial,
  nameOf = (document) =>
    (document && typeof document.name === "string" && document.name.trim()) || "Untitled",
  withName = (document, name) => ({ ...document, name }),
  draftDebounceMs = SESSION_DEFAULTS.draftDebounceMs,
  undoWindowMs = SESSION_DEFAULTS.undoWindowMs,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
  report,
}) {
  if (!format || typeof format.parse !== "function") {
    throw new Error("A document session needs a document format.");
  }
  if (typeof blank !== "function") {
    throw new Error("A document session needs a blank() that makes a fresh document.");
  }

  const emitEvent = createReporter(report);
  const listeners = new Set();

  let id = null;
  let doc = initial ?? blank();
  let name = nameOf(doc);
  let dirty = initial !== undefined;
  let savedAt = null;
  /** The name this id was last saved under; null until the first save. */
  let savedName = null;
  let draftTimer = null;
  /** The last removal, kept for the undo window: { entry, wasOpen, wasDirty, timer }. */
  let pending = null;

  const label = (value) => String(value ?? "").trim().slice(0, 120) || "Untitled";

  /**
   * A document as a save should write it: without the time it was last
   * saved, so the format stamps this one. A format keeps any `savedAt` it is
   * handed — right for a restore, which should keep its time — and every
   * document here carries the one it was opened with, so without this a
   * save, however much later, reported the moment the document was created.
   */
  const unstamped = (document) => {
    if (!document || typeof document !== "object") return document;
    const { savedAt, ...rest } = document;
    void savedAt;
    return rest;
  };

  function snapshot() {
    return Object.freeze({
      id,
      name,
      doc,
      dirty,
      savedAt,
      savedName,
      /** A saved document whose name has changed since it was saved -- the
       *  moment a host should ask "rename it, or save a copy?" */
      renamed: id !== null && savedName !== null && name !== savedName,
      canUndoRemove: pending !== null,
      hasShelf: library !== null,
    });
  }

  // The snapshot is rebuilt only when something changed, so a React
  // useSyncExternalStore reading `state` sees the same object between
  // changes -- it treats a fresh object per read as an endless change.
  let current = null;

  function emit() {
    current = snapshot();
    for (const listener of listeners) listener(current);
  }

  function clearDraftTimer() {
    if (draftTimer !== null) clearTimer(draftTimer);
    draftTimer = null;
  }

  /** Debounced behind an edit, the way both construction sets already did it. */
  function scheduleDraft() {
    if (!library) return;
    clearDraftTimer();
    draftTimer = setTimer(() => {
      draftTimer = null;
      if (dirty) library.saveDraft(doc);
    }, draftDebounceMs);
  }

  function clearDraft() {
    clearDraftTimer();
    library?.clearDraft();
  }

  function forgetPending() {
    if (pending === null) return;
    clearTimer(pending.timer);
    pending = null;
  }

  /** Replace the open document outright. Used by new, open, import, restore. */
  function load(next) {
    id = next.id ?? null;
    doc = next.doc;
    name = next.name ?? nameOf(doc);
    dirty = Boolean(next.dirty);
    savedAt = next.savedAt ?? null;
    savedName = next.id ? (next.name ?? nameOf(doc)) : null;
    if (!dirty) clearDraft();
    else scheduleDraft();
    emit();
  }

  return {
    /** A frozen picture of the open document. Read it, never mutate it. */
    get state() {
      if (current === null) current = snapshot();
      return current;
    },

    /** Fires after every change with the new state. Returns the unsubscribe. */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** The document changed. Hand in the next value; the session owns dirty. */
    update(next) {
      doc = next;
      dirty = true;
      scheduleDraft();
      emit();
    },

    /**
     * Rename the OPEN document. Never a fork -- and nothing on the shelf
     * moves until save, which is the moment a host can ask a person who has
     * renamed a saved document whether they meant to rename it or to save a
     * copy under the new name (`state.renamed` says when). Ryan asked for
     * that question on 2026-09-03, after typing a new name over a saved
     * field and finding that Save had, correctly, renamed it.
     */
    rename(next) {
      const value = label(next);
      if (value === name) return;
      name = value;
      doc = withName(doc, value);
      dirty = true;
      scheduleDraft();
      emit();
      emitEvent("document.renamed", { id, name: value });
    },

    /**
     * Write by id. The first save mints the id, so a second document may
     * carry the same name as a first without overwriting it -- the by-name
     * matching in `library.save` is for slot-keyed callers and never runs
     * from here. Returns the entry, or null when there is no shelf or the
     * write was refused.
     */
    save() {
      if (!library) return null;
      const entryId = id ?? uniqueId("doc");
      const entry = library.save(unstamped(doc), { id: entryId, name });
      if (!entry) return null;
      id = entry.id;
      savedAt = entry.savedAt;
      savedName = name;
      dirty = false;
      clearDraft();
      emit();
      emitEvent("document.saved", { id, name });
      return entry;
    },

    /**
     * A fresh document. Refused while dirty unless `force`, because the
     * caller -- not this module -- knows how to ask "save, discard, or
     * cancel?". Returns whether it happened.
     */
    new({ force = false } = {}) {
      if (dirty && !force) return false;
      const fresh = blank();
      load({ id: null, doc: fresh, name: nameOf(fresh), dirty: false, savedAt: null });
      return true;
    },

    /** Open a shelf entry by id. Same dirty rule as `new`. */
    open(entryId, { force = false } = {}) {
      if (!library) return false;
      if (dirty && !force) return false;
      const entry = library.entries().find((candidate) => candidate.id === entryId);
      if (!entry) return false;
      load({ id: entry.id, doc: entry.document, name: entry.name, dirty: false, savedAt: entry.savedAt });
      return true;
    },

    /**
     * Open a document that is not on the shelf -- a parsed file, a share
     * link, a sample -- as a NEW document. The shelf is untouched until the
     * user saves. Same dirty rule. It opens as unsaved work, because a file
     * or a link usually is; a sample offered as a starting point passes
     * `dirty: false`, so nothing nags about saving a thing nobody touched.
     *
     * @param {unknown} input
     * @param {{name?: string, force?: boolean, dirty?: boolean}} [options]
     */
    openDocument(input, { name: preferred, force = false, dirty: opensDirty = true } = {}) {
      if (dirty && !force) return false;
      const parsed = format.parse(input);
      load({ id: null, doc: parsed, name: preferred ?? nameOf(parsed), dirty: opensDirty, savedAt: null });
      emitEvent("document.opened", { name });
      return true;
    },

    /**
     * Copy what you are looking at -- edits included -- to a new entry named
     * "(copy)", and switch into it. The original keeps its last saved state.
     */
    duplicate() {
      if (!library) return null;
      const copyName = library.uniqueName(name);
      const copyDoc = withName(doc, copyName);
      const entry = library.save(unstamped(copyDoc), { id: uniqueId("doc"), name: copyName });
      if (!entry) return null;
      const from = id;
      load({ id: entry.id, doc: copyDoc, name: copyName, dirty: false, savedAt: entry.savedAt });
      emitEvent("document.duplicated", { from, id: entry.id, name: copyName });
      return entry;
    },

    /**
     * Remove a shelf entry, keeping it for `undoRemove` until the window
     * closes. Removing the open document leaves it open, unsaved again.
     */
    remove(entryId = id) {
      if (!library || !entryId) return false;
      const entry = library.entries().find((candidate) => candidate.id === entryId);
      if (!entry) return false;
      if (!library.remove(entryId)) return false;
      forgetPending();
      const wasOpen = entryId === id;
      pending = {
        entry,
        wasOpen,
        wasDirty: dirty,
        timer: setTimer(() => {
          pending = null;
          emit();
        }, undoWindowMs),
      };
      if (wasOpen) {
        id = null;
        dirty = true;
        scheduleDraft();
      }
      emit();
      emitEvent("document.removed", { id: entryId, name: entry.name });
      return true;
    },

    /**
     * Rename a shelf entry — the picker's inline rename, which may be any
     * entry, not only the open one. The entry's document is saved back
     * under the name as well, so the label and the document agree (the
     * library's own `rename` relabels only). When the entry is the open
     * document, the open document takes the name as its saved name, and
     * stays exactly as clean or dirty as it was.
     */
    renameEntry(entryId, next) {
      if (!library) return null;
      const entry = library.entries().find((candidate) => candidate.id === entryId);
      if (!entry) return null;
      const value = label(next);
      const saved = library.save(withName(entry.document, value), { id: entryId, name: value });
      if (!saved) return null;
      if (entryId === id) {
        name = value;
        savedName = value;
        doc = withName(doc, value);
        if (dirty) scheduleDraft();
      }
      emit();
      emitEvent("document.renamed", { id: entryId, name: value });
      return saved;
    },

    /**
     * Copy a shelf entry to a new one named "(copy)" WITHOUT switching to it
     * — the picker's Duplicate, which manages the shelf rather than the
     * editor. The editor's Duplicate is `duplicate`, which copies what is
     * on screen and opens the copy.
     */
    duplicateEntry(entryId) {
      if (!library) return null;
      const source = library.entries().find((candidate) => candidate.id === entryId);
      if (!source) return null;
      const copyName = library.uniqueName(source.name);
      const entry = library.save(unstamped(withName(source.document, copyName)), { id: uniqueId("doc"), name: copyName });
      if (!entry) return null;
      emit();
      emitEvent("document.duplicated", { from: entryId, id: entry.id, name: copyName });
      return entry;
    },

    /** Put the last removed entry back, same id and all. */
    undoRemove() {
      if (!library || pending === null) return false;
      const { entry, wasOpen, wasDirty } = pending;
      forgetPending();
      const restored = library.save(entry.document, { id: entry.id, name: entry.name });
      if (!restored) return false;
      if (wasOpen && id === null) {
        id = entry.id;
        dirty = wasDirty;
        if (!dirty) clearDraft();
      }
      emit();
      emitEvent("document.restored", { id: entry.id, name: entry.name });
      return true;
    },

    /** A picked file, opened as a new document. Rejections propagate. */
    async importFile(file, options = {}) {
      if (typeof format.readFile !== "function") {
        throw new Error("This format cannot read files.");
      }
      const parsed = await format.readFile(file);
      const opened = this.openDocument(parsed, options);
      if (opened) emitEvent("document.imported", { name });
      return opened;
    },

    /** Download the open document as its format's file. Returns the filename. */
    exportFile() {
      if (typeof format.download !== "function") return null;
      const filename = format.download(doc, name);
      emitEvent("document.exported", { name, filename });
      return filename;
    },

    /** A link carrying the open document. The caller copies it. */
    shareLink(options) {
      if (typeof format.shareLink !== "function") return null;
      const url = format.shareLink(doc, options);
      emitEvent("document.shared", { name });
      return url;
    },

    /** Whether unsaved work from a previous visit is waiting. */
    hasDraft() {
      return Boolean(library?.readDraft());
    },

    /** Open that unsaved work, as a dirty document. */
    restoreDraft() {
      const draft = library?.readDraft();
      if (!draft) return false;
      load({ id: null, doc: draft, name: nameOf(draft), dirty: true, savedAt: null });
      return true;
    },

    discardDraft() {
      clearDraft();
    },

    /**
     * Warn on leaving the page while dirty -- the one place the browser
     * itself will help. Returns the remover. `target` is any EventTarget with
     * the `beforeunload` event; tests pass their own.
     */
    guardUnload(target = globalThis) {
      const handler = (event) => {
        if (!dirty) return undefined;
        event.preventDefault?.();
        // Legacy browsers read the return value; modern ones need it set.
        event.returnValue = "";
        return "";
      };
      target?.addEventListener?.("beforeunload", handler);
      return () => target?.removeEventListener?.("beforeunload", handler);
    },

    /** The shelf, with documents, for a picker. Empty without a library. */
    entries() {
      return library ? library.entries() : [];
    },

    /** Stop timers. The state is left as it is. */
    dispose() {
      clearDraftTimer();
      forgetPending();
      listeners.clear();
    },
  };
}
