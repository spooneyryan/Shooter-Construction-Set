// The DOM half: a HUD document as a tree, as markup, and as a live view.
//
// One structure, three ways out. `hudTree` describes the DOM as plain data;
// `hudToHtml` serializes that for a static page or a documentation sample,
// and `mountHud` builds it with `createElement` and keeps it updated. The
// markup a game mounts and the markup the README shows are therefore the
// same tree, which is what keeps the hooks in `HUD_HOOKS` honest.
//
// The view is deliberately dumb. `hud/format` decides what every readout
// shows; this file copies the result into the nodes it recorded while
// building, and only when the result differs from the last one. It never
// queries the DOM, never uses innerHTML, and touches nothing outside its
// host — which is a shadow root by default, so the author's stylesheet is
// the HUD's own and the page's cannot reach in. Custom properties still
// inherit across that boundary, so a skin's `--game-*` tokens are usable
// from the author's CSS: `.hud { --hud-accent: var(--game-action-primary) }`.
//
// A view takes its `document` and its timers as arguments, the rule every
// module here follows, which is why the tests need no DOM implementation.

import { createReporter } from "../core/report.js";
import { HUD_SLOTS } from "./contract.js";
import { hudToCss } from "./css.js";
import { hudDelta, hudPresent, hudSameShown } from "./format.js";

/**
 * @typedef {object} HudNode
 * @property {string} tag
 * @property {Record<string, string>} [attrs]
 * @property {string} [text]
 * @property {HudNode[]} [children]
 */

const hudText = (className, part, text) => ({
  tag: "span",
  attrs: part ? { class: className, "data-part": part } : { class: className },
  text,
});

/** @returns {HudNode} */
function hudFieldTree(field, value) {
  const shown = hudPresent(field, value);
  /** @type {HudNode[]} */
  const children = [];
  if (field.showLabel) children.push(hudText("hud-label", "", field.label));

  if (field.kind === "icons") {
    const icons = [];
    for (let index = 0; index < field.max; index += 1) {
      const on = index < shown.on;
      /** @type {Record<string, string>} */
      const attrs = { class: `hud-icon ${on ? "is-on" : "is-off"}` };
      if (!on && !field.showEmpty) attrs.hidden = "";
      icons.push({ tag: "i", attrs, text: field.icon });
    }
    children.push({ tag: "span", attrs: { class: "hud-icons", "data-part": "icons" }, children: icons });
    /** @type {Record<string, string>} */
    const overflowAttrs = { class: "hud-overflow", "data-part": "overflow" };
    if (!shown.overflow) overflowAttrs.hidden = "";
    children.push({ tag: "span", attrs: overflowAttrs, text: shown.overflow });
  } else if (field.kind === "bar") {
    children.push({
      tag: "span",
      attrs: { class: "hud-bar", "data-part": "bar", style: `--hud-fill: ${shown.fill}` },
      children: [{ tag: "span", attrs: { class: "hud-bar-fill" } }],
    });
    if (field.readout !== "none") children.push(hudText("hud-readout", "text", shown.text));
  } else {
    /** @type {HudNode[]} */
    const parts = [];
    if (field.kind === "number" && field.prefix) parts.push(hudText("hud-prefix", "", field.prefix));
    if (field.kind === "number") parts.push(hudText("hud-zeros", "zeros", shown.zeros));
    parts.push(hudText("hud-text", "text", shown.text));
    if (field.kind === "number" && field.suffix) parts.push(hudText("hud-suffix", "", field.suffix));
    children.push({ tag: "span", attrs: { class: "hud-value" }, children: parts });
  }

  return {
    tag: "div",
    attrs: {
      class: shown.low ? "hud-field is-low" : "hud-field",
      "data-field": field.id,
      "data-kind": field.kind,
      "data-size": field.size,
    },
    children,
  };
}

/**
 * The DOM as data: the root, the seven slots in order, each readout in the
 * slot it asked for, showing `values` (or the zero state).
 *
 * @param {object} hud A normalized HUD.
 * @param {Record<string, unknown>} [values]
 * @returns {HudNode}
 */
export function hudTree(hud, values = {}) {
  return {
    tag: "div",
    attrs: { class: "hud", "data-hud": hud.id, "data-uppercase": hud.style.uppercase ? "true" : "false" },
    children: HUD_SLOTS.map((slot) => ({
      tag: "div",
      attrs: { class: "hud-slot", "data-slot": slot },
      children: hud.fields.filter((field) => field.slot === slot).map((field) => hudFieldTree(field, values[field.id])),
    })),
  };
}

const hudEscape = (text) => String(text)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

/** @param {HudNode} node */
function hudSerialize(node, depth) {
  const pad = "  ".repeat(depth);
  const attrs = Object.entries(node.attrs ?? {})
    .map(([name, value]) => (value === "" ? ` ${name}` : ` ${name}="${hudEscape(value)}"`))
    .join("");
  if (node.children?.length) {
    const inner = node.children.map((child) => hudSerialize(child, depth + 1)).join("\n");
    return `${pad}<${node.tag}${attrs}>\n${inner}\n${pad}</${node.tag}>`;
  }
  return `${pad}<${node.tag}${attrs}>${hudEscape(node.text ?? "")}</${node.tag}>`;
}

/**
 * Static markup for a document — for a page with no script, a README, or a
 * designer's "copy the HTML" button. With `style`, the sheet comes first
 * in a `<style>` element so the fragment is complete on its own.
 *
 * @param {object} hud
 * @param {Record<string, unknown>} [values]
 * @param {object} [options]
 * @param {boolean} [options.style]
 */
export function hudToHtml(hud, values = {}, { style = false } = {}) {
  const markup = hudSerialize(hudTree(hud, values), 0);
  return style ? `<style>\n${hudToCss(hud)}\n</style>\n${markup}` : markup;
}

/** Build the tree with `createElement`, recording each readout's live parts. */
function hudBuild(documentRef, node, parts, fieldsById, context) {
  const element = documentRef.createElement(node.tag);
  for (const [name, value] of Object.entries(node.attrs ?? {})) element.setAttribute(name, value);
  if (node.text !== undefined) element.textContent = node.text;
  let scope = context;
  const fieldId = node.attrs?.["data-field"];
  if (fieldId) {
    scope = { field: fieldsById.get(fieldId), root: element, icons: [], zeros: null, text: null, bar: null, overflow: null };
    parts.set(fieldId, scope);
  }
  const part = node.attrs?.["data-part"];
  if (scope && part && part !== "icons") scope[part] = element;
  if (scope && node.tag === "i") scope.icons.push(element);
  for (const child of node.children ?? []) {
    element.append(hudBuild(documentRef, child, parts, fieldsById, scope));
  }
  return element;
}

/** Copy a presentation into a readout's recorded nodes. */
function hudPatch(entry, shown) {
  const { field } = entry;
  if (field.kind === "icons") {
    entry.icons.forEach((icon, index) => {
      const on = index < shown.on;
      icon.classList.toggle("is-on", on);
      icon.classList.toggle("is-off", !on);
      if (!field.showEmpty) {
        if (on) icon.removeAttribute("hidden");
        else icon.setAttribute("hidden", "");
      }
    });
    if (entry.overflow) {
      entry.overflow.textContent = shown.overflow;
      if (shown.overflow) entry.overflow.removeAttribute("hidden");
      else entry.overflow.setAttribute("hidden", "");
    }
    return;
  }
  if (field.kind === "bar") {
    entry.bar?.style?.setProperty("--hud-fill", shown.fill);
    entry.root.classList.toggle("is-low", shown.low);
    if (entry.text) entry.text.textContent = shown.text;
    return;
  }
  if (entry.zeros) entry.zeros.textContent = shown.zeros;
  if (entry.text) entry.text.textContent = shown.text;
}

/**
 * Mount a HUD into an element and keep it updated.
 *
 * The target is what a game positions over its play field; the view fills
 * it. Values arrive through `update` from the game's presentation layer —
 * after `step`, never inside it — keyed by field id, and a key no field
 * owns is reported once as `hud.unknown-field`, because a misspelled
 * `lifes` is otherwise a readout that silently never moves.
 *
 * @param {HTMLElement} target
 * @param {object} hud A normalized HUD.
 * @param {object} [options]
 * @param {boolean} [options.shadow] Mount inside a shadow root, the default,
 *        so the author's stylesheet is scoped to the HUD and the page's
 *        cannot reach in. `false` mounts as plain children of the target.
 * @param {number} [options.changeMs] How long `is-changed` stays on a
 *        readout after its value moved.
 * @param {(callback: () => void, ms: number) => unknown} [options.schedule]
 * @param {(handle: unknown) => void} [options.cancel]
 * @param {Document} [options.document]
 * @param {{event?: Function} | ((name: string, data?: unknown) => unknown)} [options.report]
 */
export function mountHud(target, hud, {
  shadow = true,
  changeMs = 400,
  schedule = (callback, ms) => globalThis.setTimeout(callback, ms),
  cancel = (handle) => globalThis.clearTimeout(/** @type {any} */ (handle)),
  document: documentRef,
  report,
} = {}) {
  if (!target) throw new Error("mountHud needs an element to mount into.");
  const doc = documentRef ?? target.ownerDocument ?? globalThis.document;
  const host = shadow && typeof target.attachShadow === "function"
    ? (target.shadowRoot ?? target.attachShadow({ mode: "open" }))
    : target;
  const emit = createReporter(report);
  const warned = new Set();
  const timers = new Map();

  let current = hud;
  /** @type {Record<string, unknown>} */
  let values = {};
  let styleElement = null;
  let root = null;
  let parts = new Map();
  let shownById = new Map();

  function build() {
    const fieldsById = new Map(current.fields.map((field) => [field.id, field]));
    parts = new Map();
    styleElement = doc.createElement("style");
    styleElement.setAttribute("data-hud-style", current.id);
    styleElement.textContent = hudToCss(current);
    root = hudBuild(doc, hudTree(current, values), parts, fieldsById, null);
    host.append(styleElement, root);
    shownById = new Map(current.fields.map((field) => [field.id, hudPresent(field, values[field.id])]));
  }

  function tear() {
    for (const handle of timers.values()) cancel(handle);
    timers.clear();
    styleElement?.remove();
    root?.remove();
    styleElement = null;
    root = null;
  }

  function update(next) {
    if (!next || typeof next !== "object") return;
    for (const [id, value] of Object.entries(next)) {
      const entry = parts.get(id);
      if (!entry) {
        if (!warned.has(id)) {
          warned.add(id);
          emit("hud.unknown-field", { id, hud: current.id });
        }
        continue;
      }
      values[id] = value;
      const shown = hudPresent(entry.field, value);
      const before = shownById.get(id);
      if (hudSameShown(shown, before)) continue;
      hudPatch(entry, shown);
      shownById.set(id, shown);
      entry.root.setAttribute("data-delta", hudDelta(before, shown));
      entry.root.classList.add("is-changed");
      if (timers.has(id)) cancel(timers.get(id));
      timers.set(id, schedule(() => {
        timers.delete(id);
        entry.root.classList.remove("is-changed");
      }, changeMs));
    }
  }

  build();

  return {
    /** The root `.hud` element. Replaced by `apply`, so read it fresh. */
    get element() { return root; },
    /** The shadow root, or the target when `shadow` was false. */
    host,
    get hud() { return current; },
    update,
    set(id, value) { update({ [id]: value }); },
    values() { return { ...values }; },
    /**
     * Swap the document — a designer editing live, a game switching HUDs
     * between levels. The DOM is rebuilt and the values kept, so a readout
     * that survived the edit shows what it showed.
     */
    apply(nextHud) {
      tear();
      current = nextHud;
      build();
    },
    dispose: tear,
  };
}
