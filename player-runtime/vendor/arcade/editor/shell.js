// The construction-set shell, the headless half: one key table and one
// preferences schema for every set.
//
// Four construction sets exist — Pinball, Platformer, Starline and the Racer
// — and each wrote its own shortcut table over `createKeymap` (or, in
// Pinball's case, as the if-chain the keymap was written to replace). Laid
// side by side on 2026-10-08 they agree on almost everything: Ctrl+S, Ctrl+Z,
// T to test and Shift+T to present, Esc to leave, P to pause, F8 for the
// rates, Q and E to turn with Shift for a fine step, arrows to nudge with
// Shift for a coarse one, Delete, F for full screen. And each disagrees with
// the others somewhere small — D duplicates in three sets and drives a car in
// the fourth; F is full screen in three and "fit the track" in one; one set
// has M for sound and the others have no key for it at all. A person moving
// between the sets, which is the point of there being a family of them,
// meets the differences as surprises.
//
// This file is the table, once. A set hands `shellBindings` the actions it
// has and gets back the bindings for exactly those, under the chords every
// set uses, with the labels and descriptions the help sheet shows — so the
// sheet reads the same in every set, and a verb cannot be bound without
// being listed. What a set binds beyond these (its own tools: B for a brush,
// N for a node) it adds after, and `keymapConflicts` is the test that says
// whether one of its letters shadows a standard one.
//
// The preferences are the same story: text size, the played picture's
// filter, sound, the rate readout, how the rails fold and how wide they are
// — each set kept its own schema for the same six things under its own
// names. `defineShellSettings` is the schema once, with a set's own fields
// beside it, so a preferences sheet can be drawn once as well.
//
// Nothing here touches the DOM. The React half is `@ccllc/studio`'s Shell;
// a set without React (Pinball) reads the same table and draws its own.

import { defineSettings } from "../core/settings.js";

// -- the key table ------------------------------------------------------------

/**
 * What a set can do, each optional: a set with no zoom gets no zoom keys and
 * lists none. `mode` is required, because half the table only applies while
 * editing and the other half only while playing.
 *
 * @typedef {object} ShellActions
 * @property {() => "edit" | "play"} mode
 * @property {() => void} [save]
 * @property {() => void} [duplicateDocument]
 * @property {() => void} [open]
 * @property {() => void} [undo]
 * @property {() => void} [redo]
 * @property {() => void} [deleteSelected]
 * @property {() => void} [duplicateSelected]
 * @property {() => void} [copy]
 * @property {() => void} [paste]
 * @property {(degrees: number) => void} [rotate]
 * @property {(dx: number, dy: number) => void} [nudge]
 * @property {() => void} [selectTool]
 * @property {() => void} [deselect]
 * @property {(delta: number) => void} [zoom]
 * @property {() => void} [resetView]
 * @property {() => void} [toggleGrid]
 * @property {() => void} [fullscreen]
 * @property {() => void} [test]
 * @property {() => void} [present]
 * @property {() => void} [leave]
 * @property {() => void} [togglePause]
 * @property {() => void} [stepOnce]
 * @property {() => void} [stepBack]
 * @property {() => void} [restart]
 * @property {() => void} [toggleRates]
 * @property {() => void} [toggleSound]
 * @property {() => void} [toggleHelp]
 */

/** The help sheet's groups, in the order they are shown. */
export const SHELL_KEY_GROUPS = Object.freeze(["Document", "Editing", "View", "Playing", "App"]);

/**
 * The document bar's three chords, as help rows. A set whose bar is
 * `@ccllc/studio`'s `DocumentBar` does not pass `save`, `duplicateDocument`
 * or `open` to `shellBindings` — the bar binds them itself — and lists them
 * from here instead, so the sheet is still complete.
 */
export const SHELL_DOCUMENT_SHORTCUTS = Object.freeze([
  { group: "Document", label: "Ctrl+S", description: "Save" },
  { group: "Document", label: "Ctrl+Shift+S", description: "Duplicate: a copy, and you are in it" },
  { group: "Document", label: "Ctrl+O", description: "Open…" },
]);

const ARROWS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];

/**
 * The standard table, for the actions a set has.
 *
 * @param {ShellActions} actions
 * @param {object} [options]
 * @param {[number, number]} [options.nudge] The fine and coarse nudge, in the
 *   set's own units. Five and twenty-five pixels is what three sets chose.
 * @param {[number, number]} [options.rotate] The coarse and fine turn, in
 *   degrees. Fifteen and one.
 * @returns {import("./keymap.js").Binding[]} In the order the help sheet lists them.
 */
export function shellBindings(actions, { nudge = [5, 25], rotate = [15, 1] } = {}) {
  if (!actions || typeof actions.mode !== "function") throw new Error("shellBindings needs actions.mode().");
  const editing = () => actions.mode() === "edit";
  const playing = () => actions.mode() === "play";
  /** @type {import("./keymap.js").Binding[]} */
  const bindings = [];
  const add = (/** @type {import("./keymap.js").Binding} */ binding) => { bindings.push(binding); };

  // Document. Inside text fields too: the name field is exactly where a
  // person presses Ctrl+S, and losing the edit is worse than the surprise.
  if (actions.save) add({ group: "Document", code: "KeyS", ctrl: true, label: "Ctrl+S", description: "Save", allowInTextEntry: true, run: () => actions.save() });
  if (actions.duplicateDocument) add({ group: "Document", code: "KeyS", ctrl: true, shift: true, label: "Ctrl+Shift+S", description: "Duplicate: a copy, and you are in it", allowInTextEntry: true, run: () => actions.duplicateDocument() });
  if (actions.open) add({ group: "Document", code: "KeyO", ctrl: true, label: "Ctrl+O", description: "Open…", allowInTextEntry: true, run: () => actions.open() });

  // Editing. Repeat is on for undo and redo — holding Ctrl+Z walks back —
  // and for the gestures; off for everything that should happen once per press.
  if (actions.undo) add({ group: "Editing", code: "KeyZ", ctrl: true, label: "Ctrl+Z", description: "Undo", when: editing, allowRepeat: true, run: () => actions.undo() });
  if (actions.redo) {
    add({ group: "Editing", code: "KeyZ", ctrl: true, shift: true, label: "Ctrl+Shift+Z or Ctrl+Y", description: "Redo", when: editing, allowRepeat: true, run: () => actions.redo() });
    add({ group: "Editing", code: "KeyY", ctrl: true, when: editing, allowRepeat: true, run: () => actions.redo() });
  }
  if (actions.deleteSelected) add({ group: "Editing", code: ["Delete", "Backspace"], label: "Del", description: "Delete what is selected", when: editing, run: () => actions.deleteSelected() });
  if (actions.duplicateSelected) add({ group: "Editing", code: "KeyD", label: "D", description: "Duplicate what is selected", when: editing, run: () => actions.duplicateSelected() });
  if (actions.copy) add({ group: "Editing", code: "KeyC", ctrl: true, label: "Ctrl+C", description: "Copy what is selected", when: editing, run: () => actions.copy() });
  if (actions.paste) add({ group: "Editing", code: "KeyV", ctrl: true, label: "Ctrl+V", description: "Paste it, at the pointer", when: editing, run: () => actions.paste() });
  if (actions.rotate) {
    const [coarse, fine] = rotate;
    const turn = (/** @type {number} */ step) => (/** @type {KeyboardEvent} */ event) => actions.rotate((event.code === "KeyQ" ? -1 : 1) * step);
    add({ group: "Editing", code: ["KeyQ", "KeyE"], label: "Q / E", description: `Turn what is selected ${coarse}° (Shift: ${fine}°)`, when: editing, allowRepeat: true, run: turn(coarse) });
    add({ group: "Editing", code: ["KeyQ", "KeyE"], shift: true, when: editing, allowRepeat: true, run: turn(fine) });
  }
  if (actions.nudge) {
    const [fine, coarse] = nudge;
    const move = (/** @type {number} */ step) => (/** @type {KeyboardEvent} */ event) => actions.nudge(
      event.code === "ArrowLeft" ? -step : event.code === "ArrowRight" ? step : 0,
      event.code === "ArrowUp" ? -step : event.code === "ArrowDown" ? step : 0,
    );
    add({ group: "Editing", code: ARROWS, label: "Arrows", description: `Nudge what is selected ${fine} px (Shift: ${coarse})`, when: editing, allowRepeat: true, run: move(fine) });
    add({ group: "Editing", code: ARROWS, shift: true, when: editing, allowRepeat: true, run: move(coarse) });
  }
  if (actions.selectTool) add({ group: "Editing", code: "KeyV", label: "V", description: "Select and move", when: editing, run: () => actions.selectTool() });
  if (actions.deselect) add({ group: "Editing", code: "Escape", label: "Esc", description: "Let go of the selection", when: editing, run: () => actions.deselect() });

  // View.
  if (actions.zoom) {
    add({ group: "View", code: "Equal", label: "+ / -", description: "Zoom in and out", when: editing, allowRepeat: true, run: () => actions.zoom(1) });
    add({ group: "View", code: "Equal", shift: true, when: editing, allowRepeat: true, run: () => actions.zoom(1) });
    add({ group: "View", code: "Minus", when: editing, allowRepeat: true, run: () => actions.zoom(-1) });
  }
  if (actions.resetView) add({ group: "View", code: "Digit0", label: "0", description: "Fit the whole thing on screen", when: editing, run: () => actions.resetView() });
  if (actions.toggleGrid) add({ group: "View", code: "KeyG", label: "G", description: "Snap to the grid", when: editing, run: () => actions.toggleGrid() });
  if (actions.fullscreen) add({ group: "View", code: "KeyF", label: "F", description: "Full screen", run: () => actions.fullscreen() });

  // Playing. Enter stays passive: it never prevented default in any set, and
  // whatever else listens for it must keep hearing it.
  if (actions.test) add({ group: "Playing", code: "KeyT", label: "T", description: "Test: play what you are making", when: editing, run: () => actions.test() });
  if (actions.present) add({ group: "Playing", code: "KeyT", shift: true, label: "Shift+T", description: "Present: the same, full screen, no editor", when: editing, run: () => actions.present() });
  if (actions.leave) add({ group: "Playing", code: "Escape", label: "Esc", description: "Back to the editor", when: playing, run: () => actions.leave() });
  if (actions.togglePause) add({ group: "Playing", code: "KeyP", label: "P", description: "Pause or carry on", when: playing, run: () => actions.togglePause() });
  if (actions.stepOnce) add({ group: "Playing", code: "Period", label: ".", description: "One step, while paused", when: playing, allowRepeat: true, run: () => actions.stepOnce() });
  if (actions.stepBack) add({ group: "Playing", code: "Comma", label: ",", description: "Back a few steps, while paused", when: playing, allowRepeat: true, run: () => actions.stepBack() });
  if (actions.restart) add({ group: "Playing", code: "Enter", label: "Enter", description: "Start again", when: playing, passive: true, run: () => actions.restart() });

  // App. These work in every mode: the rates, the sound and the sheet are
  // wanted mid-race as much as mid-edit.
  if (actions.toggleRates) add({ group: "App", code: "F8", label: "F8", description: "Frame and step rates", run: () => actions.toggleRates() });
  if (actions.toggleSound) add({ group: "App", code: "KeyM", label: "M", description: "Sound on or off", run: () => actions.toggleSound() });
  if (actions.toggleHelp) {
    add({ group: "App", code: ["Slash", "F1"], label: "? or F1", description: "This sheet", run: () => actions.toggleHelp() });
    add({ group: "App", code: ["Slash", "F1"], shift: true, run: () => actions.toggleHelp() });
  }
  return bindings;
}

const KEY_NAMES = {
  Escape: "Esc", Delete: "Del", Backspace: "Backspace", Enter: "Enter", Space: "Space", Tab: "Tab",
  Period: ".", Comma: ",", Slash: "/", Backslash: "\\", Semicolon: ";", Quote: "'", Backquote: "`",
  Equal: "=", Minus: "-", BracketLeft: "[", BracketRight: "]",
  ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down",
  Home: "Home", End: "End", PageUp: "PgUp", PageDown: "PgDn", Insert: "Ins",
};

/** "KeyS" → "S", "Digit0" → "0", "Period" → ".", "F8" → "F8". */
export function keyName(code) {
  const text = String(code ?? "");
  if (text.startsWith("Key") && text.length === 4) return text.slice(3);
  if (text.startsWith("Digit") && text.length === 6) return text.slice(5);
  if (text.startsWith("Numpad")) return `Num ${text.slice(6)}`;
  return KEY_NAMES[text] ?? text;
}

/**
 * "Ctrl+Shift+S", "Q / E", "Del": the label for a chord, from its binding or
 * from a `describe()` row — so a set adding its own keys need not hand-write
 * the label the sheet shows, and cannot misspell the modifier order.
 *
 * @param {{ code: string | string[], ctrl?: boolean, shift?: boolean, alt?: boolean }} binding
 */
export function chordLabel(binding) {
  const codes = Array.isArray(binding.code) ? binding.code : [binding.code];
  const keys = codes.every((code) => ARROWS.includes(code)) && codes.length === 4
    ? "Arrows"
    : codes.map(keyName).join(" / ");
  const modifiers = [binding.ctrl ? "Ctrl" : "", binding.alt ? "Alt" : "", binding.shift ? "Shift" : ""].filter(Boolean);
  return [...modifiers, keys].join("+");
}

/**
 * The sheet's rows, grouped, from `keymap.describe()`: rows without a label
 * or a description are the unlabelled halves of a listed chord and are
 * dropped; a label listed twice (the `?` binding is, on purpose) shows once;
 * the groups come in `SHELL_KEY_GROUPS` order, then a set's own in the order
 * they were met. Rows handed in `prepend` go first in their group — the
 * document bar's three, usually.
 *
 * @param {ReadonlyArray<{ label?: string | null, description?: string | null, group?: string | null }>} rows
 * @param {object} [options]
 * @param {ReadonlyArray<{ group?: string, label: string, description: string }>} [options.prepend]
 * @returns {Array<{ title: string, rows: Array<{ label: string, description: string }> }>}
 */
export function describeShortcuts(rows, { prepend = [] } = {}) {
  /** @type {Map<string, Array<{ label: string, description: string }>>} */
  const groups = new Map();
  for (const title of SHELL_KEY_GROUPS) groups.set(title, []);
  const seen = new Set();
  for (const row of [...prepend, ...rows]) {
    if (!row.label || !row.description) continue;
    const key = `${row.label}\u0000${row.description}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const title = row.group || "More";
    if (!groups.has(title)) groups.set(title, []);
    groups.get(title).push({ label: row.label, description: row.description });
  }
  return [...groups].filter(([, list]) => list.length > 0).map(([title, list]) => ({ title, rows: list }));
}

const chordKey = (/** @type {string} */ code, /** @type {{ ctrl?: boolean, shift?: boolean, alt?: boolean }} */ binding) =>
  `${binding.ctrl ? "Ctrl+" : ""}${binding.alt ? "Alt+" : ""}${binding.shift ? "Shift+" : ""}${code}`;

/**
 * Chords bound more than once where at least one binding has no `when`:
 * the first match wins in `createKeymap`, so an unguarded F for full screen
 * ahead of a guarded F for "frame the track" means the second never fires,
 * and behind it means full screen never does while editing. Two guarded
 * bindings on one chord are the normal case — Esc leaves a race and clears
 * a selection — and are not reported, because gates cannot be read.
 *
 * A set's test asserts this is empty over its whole table, standard and own.
 *
 * @param {ReadonlyArray<import("./keymap.js").Binding>} bindings
 * @returns {Array<{ chord: string, labels: string[] }>}
 */
export function keymapConflicts(bindings) {
  /** @type {Map<string, Array<import("./keymap.js").Binding>>} */
  const byChord = new Map();
  for (const binding of bindings) {
    const codes = Array.isArray(binding.code) ? binding.code : [binding.code];
    for (const code of codes) {
      const key = chordKey(code, binding);
      if (!byChord.has(key)) byChord.set(key, []);
      byChord.get(key).push(binding);
    }
  }
  const conflicts = [];
  for (const [chord, list] of byChord) {
    if (list.length < 2 || !list.some((binding) => !binding.when)) continue;
    conflicts.push({ chord, labels: list.map((binding) => binding.label || binding.description || chordLabel(binding)) });
  }
  return conflicts;
}

// -- the preferences ------------------------------------------------------------

/** The played picture's treatments, as the settings sheet offers them. */
export const SHELL_FILTER_CHOICES = Object.freeze([
  { value: "none", label: "None" },
  { value: "display-scanlines", label: "Scanlines" },
  { value: "lcd-grid", label: "LCD grid" },
  { value: "crt", label: "CRT tube" },
]);

/**
 * Each filter's own numbers, and which filter shows them. The defaults are
 * the presenter's own, so a filter switched on for the first time looks the
 * way its author tuned it — Starline's choice, kept.
 */
export const SHELL_DISPLAY_FIELDS = Object.freeze([
  { key: "lineBrightness", label: "Line brightness", min: 0, max: 1, step: 0.05, filters: ["display-scanlines", "lcd-grid"] },
  { key: "bandRows", label: "Band rows", min: 1, max: 8, step: 1, filters: ["display-scanlines"] },
  { key: "gridThickness", label: "Grid thickness", min: 0, max: 4, step: 0.25, filters: ["lcd-grid"] },
  { key: "crtAmount", label: "Tube", min: 0, max: 1, step: 0.02, filters: ["crt"] },
  { key: "crtGlow", label: "Glow", min: 0, max: 1, step: 0.02, filters: ["crt"] },
  { key: "crtNoise", label: "Noise", min: 0, max: 1, step: 0.01, filters: ["crt"] },
]);

/** The text sizes offered: the original, then coarse steps up to double. */
export const SHELL_TEXT_SCALES = Object.freeze([1, 1.25, 1.5, 1.75, 2]);

/**
 * How wide the rails may be. The palette's floor is where a tool button
 * still has its label; the inspector's is where a field row still has its
 * value beside it. Overridable per set, because a sprite palette and a
 * node list want different rooms.
 */
export const SHELL_RAIL_LIMITS = Object.freeze({
  palette: { min: 160, max: 460, default: 200 },
  inspector: { min: 200, max: 560, default: 260 },
});

/**
 * The fields every set's preferences carry, as `defineSettings` takes them.
 * @param {object} [options]
 * @param {{ palette: { min: number, max: number, default: number }, inspector: { min: number, max: number, default: number } }} [options.rails]
 */
export function shellSettingsFields({ rails = SHELL_RAIL_LIMITS } = {}) {
  return {
    textScale: { type: "number", default: 1, min: 1, max: 2, step: 0.25 },
    pixelFilter: { type: "enum", default: "none", values: SHELL_FILTER_CHOICES.map((choice) => choice.value) },
    lineBrightness: { type: "number", default: 0.72, min: 0, max: 1 },
    bandRows: { type: "integer", default: 1, min: 1, max: 8 },
    gridThickness: { type: "number", default: 1, min: 0, max: 4 },
    crtAmount: { type: "number", default: 1, min: 0, max: 1 },
    crtGlow: { type: "number", default: 1, min: 0, max: 1 },
    crtNoise: { type: "number", default: 0.25, min: 0, max: 1 },
    soundOn: { type: "boolean", default: true },
    showRates: { type: "boolean", default: false },
    sectionMode: { type: "enum", default: "multiple", values: ["multiple", "single"] },
    paletteWidth: { type: "integer", default: rails.palette.default, min: rails.palette.min, max: rails.palette.max },
    inspectorWidth: { type: "integer", default: rails.inspector.default, min: rails.inspector.min, max: rails.inspector.max },
  };
}

/** Where the shared half of every set's preferences lives on an origin. */
export const SHELL_SHARED_NAMESPACE = "gamebase.shell";

/**
 * The standard preferences that are about the person rather than the set:
 * how big the text is, how the played picture is treated, sound, the rates,
 * how the rails fold. A set that asks for `shared` keeps these under
 * `SHELL_SHARED_NAMESPACE`, so every set on one address agrees on them. The
 * rail widths are not here: each set's rails have limits of their own.
 */
export const SHELL_SHARED_FIELDS = Object.freeze([
  "textScale", "pixelFilter", "lineBrightness", "bandRows", "gridThickness",
  "crtAmount", "crtGlow", "crtNoise", "soundOn", "showRates", "sectionMode",
]);

/**
 * The preferences store every set shares the shape of: the standard fields
 * and the set's own beside them. Under one namespace by default — the shared
 * one, when a set gives none. With `shared`, a set keeps the person's half
 * (`SHELL_SHARED_FIELDS`) under the shared namespace and its own half — the
 * rail widths and its own fields — under its own, so four sets on one
 * address agree on the text size and each keeps its rails. Either way the
 * store is one `SettingsStore`; nothing that reads it can tell.
 *
 * @param {object} [options]
 * @param {string} [options.namespace]
 * @param {number} [options.version]
 * @param {Record<string, object>} [options.fields] The set's own. A name the
 *   standard already uses is an error, not an override: the sheet is drawn
 *   from the standard's meaning of each.
 * @param {{ palette: { min: number, max: number, default: number }, inspector: { min: number, max: number, default: number } }} [options.rails]
 * @param {boolean} [options.shared] Keep the person's half under the shared
 *   namespace. The first time, an empty shared half takes the values this
 *   set kept on its own, so nobody's text size resets.
 * @param {Storage|null} [options.storage]
 * @param {(values: object, fromVersion: number) => object} [options.migrate]
 *   Runs on the set's own half, and on its old values when they seed the
 *   shared half.
 * @param {{event?: Function} | ((name: string, data?: unknown) => void)} [options.report]
 */
export function defineShellSettings({ namespace = SHELL_SHARED_NAMESPACE, version = 1, fields = {}, rails, shared = false, storage, migrate, report } = {}) {
  const standard = shellSettingsFields({ rails });
  for (const name of Object.keys(fields)) {
    if (name in standard) throw new Error(`Shell settings already define "${name}"; the set's own fields need names of their own.`);
  }
  if (!shared) return defineSettings({ namespace, version, fields: { ...standard, ...fields }, storage, migrate, report });
  if (namespace === SHELL_SHARED_NAMESPACE) {
    throw new Error(`A set that shares the standard preferences keeps its own half under a namespace of its own, not "${SHELL_SHARED_NAMESPACE}".`);
  }
  const personFields = {};
  const setFields = {};
  for (const [name, field] of Object.entries(standard)) {
    (SHELL_SHARED_FIELDS.includes(name) ? personFields : setFields)[name] = field;
  }
  Object.assign(setFields, fields);
  const own = defineSettings({ namespace, version, fields: setFields, storage, migrate, report });
  const person = defineSettings({ namespace: SHELL_SHARED_NAMESPACE, fields: personFields, storage, report });
  seedSharedShellHalf(person, own.storageKey, { version, migrate, storage });
  return composeShellHalves([person, own], Object.keys({ ...standard, ...fields }), version, own.storageKey);
}

/**
 * The first set to share on an origin brings the person's choices with it:
 * an empty shared half takes the standard values the set kept on its own,
 * read through the set's migration if they are older. Once the shared half
 * exists it wins, and a set's leftovers are dropped on its next write.
 */
function seedSharedShellHalf(person, ownKey, { version, migrate, storage }) {
  try {
    const store = storage === undefined ? globalThis.localStorage : storage;
    if (!store || store.getItem(person.storageKey) !== null) return;
    const raw = store.getItem(ownKey);
    if (!raw) return;
    const envelope = JSON.parse(raw);
    const storedVersion = Number.isFinite(envelope?.v) ? envelope.v : 0;
    if (storedVersion > version) return;
    let values = envelope?.values ?? envelope;
    if (storedVersion < version && typeof migrate === "function") values = migrate(values, storedVersion);
    const kept = {};
    for (const name of SHELL_SHARED_FIELDS) if (values && typeof values === "object" && name in values) kept[name] = values[name];
    person.patch(kept);
  } catch {
    // Storage refused, or an old blob that will not parse: the shared
    // defaults stand, and the set's own half reports its own trouble.
  }
}

/** Two stores behind one SettingsStore: each name read and written where it lives. */
function composeShellHalves(halves, names, version, storageKey) {
  const owner = (name) => halves.find((half) => half.field(name) !== undefined);
  const split = (values) => halves.map((half) =>
    Object.fromEntries(Object.entries(values ?? {}).filter(([name]) => half.field(name) !== undefined)));
  const inOrder = (values) => {
    const result = {};
    for (const name of names) if (name in values) result[name] = values[name];
    return result;
  };
  const merged = (read) => inOrder(Object.assign({}, ...halves.map(read)));
  const listeners = new Set();
  for (const half of halves) {
    half.subscribe((_values, changed) => {
      if (!listeners.size) return;
      const snapshot = Object.freeze(merged((each) => each.all()));
      for (const listener of listeners) listener(snapshot, changed);
    });
  }
  return {
    get names() { return [...names]; },
    get available() { return halves.every((half) => half.available); },
    get version() { return version; },
    get storageKey() { return storageKey; },
    get(name) { return owner(name)?.get(name); },
    all() { return Object.freeze(merged((half) => half.all())); },
    defaults() { return merged((half) => half.defaults()); },
    set(name, value) { return owner(name)?.set(name, value) ?? false; },
    patch(next, options) {
      const parts = split(next);
      return halves.flatMap((half, index) => half.patch(parts[index], options));
    },
    reset() { return halves.flatMap((half) => half.reset()); },
    reload() { return halves.flatMap((half) => half.reload()); },
    fromFormData(source) { return Object.assign({}, ...halves.map((half) => half.fromFormData(source))); },
    restartRequired(next) {
      const parts = split(next);
      return halves.flatMap((half, index) => half.restartRequired(parts[index]));
    },
    subscribe(nameOrListener, maybeListener) {
      if (typeof nameOrListener === "function") {
        listeners.add(nameOrListener);
        return () => listeners.delete(nameOrListener);
      }
      const half = owner(nameOrListener);
      if (!half) throw new Error(`Unknown setting "${nameOrListener}".`);
      return half.subscribe(nameOrListener, maybeListener);
    },
    sanitize(candidate) { return merged((half) => half.sanitize(candidate)); },
    field(name) { return owner(name)?.field(name); },
  };
}

// -- home -------------------------------------------------------------------------

/**
 * The cookie the GameBase app sets on its own origin, naming where its
 * launcher is. A set served as a room under the app reads it to draw the way
 * home; the same build at its own address finds no cookie and draws none.
 * A cookie rather than a path rule, because a set under some other path
 * (Starline under /games/starline/) is not a room; and rather than a
 * request, because it is there synchronously on the first render.
 */
export const SHELL_HOME_COOKIE = "gamebase-home";

/**
 * Where home is, when this page is a room under the GameBase app: the
 * launcher's address, ready for `Shell`'s `home` prop, or null.
 * @param {string} [cookie] Defaults to `document.cookie`.
 * @returns {{ href: string, label: string } | null}
 */
export function readShellHome(cookie = globalThis.document?.cookie ?? "") {
  for (const part of String(cookie).split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name !== SHELL_HOME_COOKIE) continue;
    let href = "";
    try { href = decodeURIComponent(rest.join("=")); } catch { return null; }
    // Only a path on this origin: a cookie is no place to send anyone elsewhere.
    return href.startsWith("/") && !href.startsWith("//") ? { href, label: "GameBase" } : null;
  }
  return null;
}

/**
 * The played picture's treatment, as `createPixelPresenter` takes it, read
 * off the preferences — `pixelFilter` is the one name that differs, because
 * `filter` alone says too little in a schema beside twelve other things.
 * @param {{ pixelFilter: string, lineBrightness: number, bandRows: number, gridThickness: number, crtAmount: number, crtGlow: number, crtNoise: number }} values
 */
export function shellPresenterOptions(values) {
  return {
    filter: values.pixelFilter,
    lineBrightness: values.lineBrightness,
    bandRows: values.bandRows,
    gridThickness: values.gridThickness,
    crtAmount: values.crtAmount,
    crtGlow: values.crtGlow,
    crtNoise: values.crtNoise,
  };
}
