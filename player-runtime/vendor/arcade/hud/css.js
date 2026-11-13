// The stylesheet half: the base rules, the tokens as custom properties, and
// the author's own CSS with the rules about what it may contain.
//
// Three layers in one sheet, in this order, so that each can override the
// one before it with an ordinary rule and no `!important`:
//
//   1. `HUD_BASE_CSS`   the layout and the hooks, written once here;
//   2. the tokens       `.hud { --hud-size: 26px; … }`, from the document;
//   3. the author's CSS whatever the tokens do not reach.
//
// Every value the base layer uses is a `var(--hud-*)`, which is what makes
// layer 3 able to change anything layer 1 decided — including per readout,
// because `.hud-field[data-field="score"] { --hud-size: 48px }` re-scopes
// a token to one element. That is the design: a handful of tokens for the
// common case, and the entire CSS language for the rest, over a DOM whose
// class names and data attributes are a published contract (`HUD_HOOKS`).
//
// The author's CSS is user content and ends up inside a `<style>` element,
// so it is treated the way a skin file is: refused whole when it carries
// anything that could reach outside the sheet. The list is short and it is
// the list, not a heuristic — an `@import` fetches, `<` closes the element,
// a backslash spells either of those a second way, and `url()` is allowed
// only for an inline image, which a pixel-font icon legitimately needs.

import { HUD_STYLE_TOKENS, hudStyleTokenNames } from "./contract.js";

/** A HUD stylesheet is a page of rules, not a framework. */
export const HUD_CSS_MAX_BYTES = 16 * 1024;

/** `labelColor` → `--hud-label-color`. */
export function hudCssVariable(name) {
  return `--hud-${String(name).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

const HUD_CSS_FORBIDDEN = Object.freeze([
  { pattern: /@import/i, reason: "@import" },
  { pattern: /@charset/i, reason: "@charset" },
  { pattern: /@namespace/i, reason: "@namespace" },
  { pattern: /[<>]/, reason: "an angle bracket" },
  { pattern: /\\/, reason: "a backslash escape" },
  { pattern: /expression\s*\(/i, reason: "expression()" },
  { pattern: /(?:javascript|vbscript)\s*:/i, reason: "a script URL" },
  { pattern: /behavior\s*:/i, reason: "behavior:" },
  { pattern: /-moz-binding/i, reason: "-moz-binding" },
]);

/**
 * The author's CSS, or nothing, with the reasons.
 *
 * Comments are stripped first — so a forbidden construct cannot hide inside
 * one, and so an unterminated comment (which swallows the rest of the sheet,
 * closing brace and all) is refused rather than shipped.
 *
 * @param {unknown} input
 * @returns {{ css: string, rejected: string[] }}
 */
export function sanitizeHudCss(input) {
  if (typeof input !== "string") return { css: "", rejected: [] };
  const css = input.replace(/\/\*[\s\S]*?\*\//g, "").trim();
  if (!css) return { css: "", rejected: [] };
  const rejected = [];
  if (new TextEncoder().encode(css).byteLength > HUD_CSS_MAX_BYTES) {
    rejected.push(`longer than ${HUD_CSS_MAX_BYTES} bytes`);
  }
  if (css.includes("/*")) rejected.push("an unterminated comment");
  for (const { pattern, reason } of HUD_CSS_FORBIDDEN) {
    if (pattern.test(css)) rejected.push(reason);
  }
  for (const match of css.matchAll(/url\s*\(\s*["']?\s*([^"')\s]*)/gi)) {
    if (!/^data:image\//i.test(match[1])) {
      rejected.push(`url(${match[1].slice(0, 40)}${match[1].length > 40 ? "…" : ""}) — only data:image/ is allowed`);
    }
  }
  return rejected.length ? { css: "", rejected } : { css, rejected };
}

/**
 * The tokens as one rule of custom properties, plus two composites the base
 * sheet reads: the text shadow assembled from `glow` and `shadow`, and the
 * panel fill from `panel` and `panelAlpha`. Booleans are not variables —
 * `uppercase` is a data attribute on the root, because CSS cannot branch
 * on a custom property's value.
 *
 * @param {object} style A normalized style.
 * @param {string} [selector]
 */
export function hudTokensToCss(style, selector = ".hud") {
  const lines = [];
  for (const name of hudStyleTokenNames) {
    const token = HUD_STYLE_TOKENS[name];
    if (token.type === "boolean") continue;
    const value = style[name];
    lines.push(`  ${hudCssVariable(name)}: ${value}${token.unit && typeof value === "number" ? token.unit : ""};`);
  }
  const shadows = [];
  if (style.shadow > 0) shadows.push(`${style.shadow}px ${style.shadow}px 0 rgba(0, 0, 0, 0.65)`);
  if (style.glow > 0) shadows.push(`0 0 ${style.glow}px var(--hud-accent)`);
  lines.push(`  --hud-text-shadow: ${shadows.length ? shadows.join(", ") : "none"};`);
  lines.push(`  --hud-panel-fill: color-mix(in srgb, var(--hud-panel) ${Math.round(style.panelAlpha * 100)}%, transparent);`);
  return `${selector} {\n${lines.join("\n")}\n}`;
}

/**
 * The layout and the hooks. Every number in here is a token, and every
 * class is in `HUD_HOOKS`. The root fills its host, so the host is what a
 * game positions over its canvas: `position: relative` on the wrapper, or
 * absolute on the target itself.
 */
export const HUD_BASE_CSS = `.hud, .hud * { box-sizing: border-box; }
.hud {
  position: absolute; inset: 0;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  grid-template-rows: auto 1fr auto;
  grid-template-areas: "tl tc tr" "c c c" "bl bc br";
  padding: var(--hud-inset);
  overflow: hidden;
  pointer-events: none;
  user-select: none;
  font-family: var(--hud-font);
  font-size: var(--hud-size);
  color: var(--hud-color);
  line-height: 1;
}
.hud-slot { display: flex; flex-wrap: wrap; gap: var(--hud-gap); min-width: 0; align-items: flex-start; }
.hud-slot[data-slot="top-left"] { grid-area: tl; justify-content: flex-start; }
.hud-slot[data-slot="top-center"] { grid-area: tc; justify-content: center; }
.hud-slot[data-slot="top-right"] { grid-area: tr; justify-content: flex-end; }
.hud-slot[data-slot="center"] { grid-area: c; justify-content: center; align-items: center; align-content: center; }
.hud-slot[data-slot="bottom-left"] { grid-area: bl; justify-content: flex-start; align-items: flex-end; }
.hud-slot[data-slot="bottom-center"] { grid-area: bc; justify-content: center; align-items: flex-end; }
.hud-slot[data-slot="bottom-right"] { grid-area: br; justify-content: flex-end; align-items: flex-end; }
.hud-slot[data-slot="top-right"] .hud-field, .hud-slot[data-slot="bottom-right"] .hud-field { align-items: flex-end; text-align: right; }
.hud-slot[data-slot="top-center"] .hud-field, .hud-slot[data-slot="bottom-center"] .hud-field, .hud-slot[data-slot="center"] .hud-field { align-items: center; text-align: center; }
.hud-field {
  display: flex; flex-direction: column; gap: 0.2em; min-width: 0;
  padding: var(--hud-padding);
  background: var(--hud-panel-fill);
  border: var(--hud-border-width) solid var(--hud-panel-border);
  border-radius: var(--hud-radius);
}
.hud-label {
  font-family: var(--hud-label-font);
  font-size: var(--hud-label-size);
  color: var(--hud-label-color);
  letter-spacing: var(--hud-letter-spacing);
  text-shadow: var(--hud-text-shadow);
}
.hud[data-uppercase="true"] .hud-label { text-transform: uppercase; }
.hud-value {
  display: inline-flex; align-items: baseline;
  font-variant-numeric: tabular-nums;
  letter-spacing: var(--hud-letter-spacing);
  text-shadow: var(--hud-text-shadow);
  white-space: nowrap;
}
.hud-field[data-size="small"] .hud-value { font-size: 0.6em; }
.hud-field[data-size="large"] .hud-value { font-size: 1.8em; }
.hud-zeros { color: var(--hud-dim); }
.hud-prefix, .hud-suffix { color: var(--hud-label-color); }
.hud-icons { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 0.15em; font-size: var(--hud-icon-size); text-shadow: var(--hud-text-shadow); }
.hud-icon { font-style: normal; color: var(--hud-accent); transition: color 120ms, opacity 120ms; }
.hud-icon.is-off { color: var(--hud-dim); opacity: 0.6; }
.hud-icon[hidden], .hud-overflow[hidden] { display: none; }
.hud-overflow { font-size: 0.7em; color: var(--hud-color); margin-left: 0.2em; }
.hud-bar {
  display: block; overflow: hidden;
  width: var(--hud-bar-width); height: var(--hud-bar-height);
  background: var(--hud-dim);
  border-radius: var(--hud-radius);
}
.hud-bar-fill { display: block; height: 100%; width: var(--hud-fill); background: var(--hud-accent); transition: width 160ms ease-out, background-color 160ms; }
.hud-field.is-low .hud-bar-fill { background: var(--hud-low); }
.hud-field.is-low .hud-value { color: var(--hud-low); }
.hud-readout { font-size: 0.6em; }
.hud-field.is-changed .hud-value { animation: hud-pop 240ms ease-out; }
.hud-field.is-changed[data-delta="down"] .hud-value { animation-name: hud-shake; }
@keyframes hud-pop { from { transform: scale(1.14); } to { transform: none; } }
@keyframes hud-shake { 0% { transform: translateX(-3px); } 50% { transform: translateX(3px); } 100% { transform: none; } }
@media (prefers-reduced-motion: reduce) {
  .hud-field.is-changed .hud-value { animation: none; }
  .hud-bar-fill, .hud-icon { transition: none; }
}`;

/**
 * The whole sheet for a document.
 *
 * @param {object} hud A normalized HUD.
 * @param {object} [options]
 * @param {string} [options.selector] The root selector for the token rule.
 * @param {boolean} [options.base] Include the layout rules. Off for a page
 *        that already has them and wants only this document's part.
 */
export function hudToCss(hud, { selector = ".hud", base = true } = {}) {
  const parts = [];
  if (base) parts.push(HUD_BASE_CSS);
  parts.push(hudTokensToCss(hud.style, selector));
  if (hud.css) parts.push(hud.css);
  return parts.join("\n\n");
}

/**
 * The published contract between the DOM the view builds and the CSS an
 * author writes. The designer renders this table beside its CSS editor and
 * the README carries the same list; nothing in it may change without a
 * version bump, because a game's stylesheet depends on every line.
 */
export const HUD_HOOKS = Object.freeze([
  { hook: ".hud", is: "selector", what: "The root. Fills its host; a grid of the seven slots. Carries data-hud=\"<id>\" and data-uppercase." },
  { hook: ".hud-slot[data-slot=\"top-left\"]", is: "selector", what: "One of the seven regions: top-left, top-center, top-right, center, bottom-left, bottom-center, bottom-right." },
  { hook: ".hud-field[data-field=\"score\"]", is: "selector", what: "One readout, by its id. Also carries data-kind (number, icons, time, bar, text) and data-size (small, normal, large)." },
  { hook: ".hud-field.is-changed", is: "state", what: "For a moment after the value changed; data-delta says up, down or same. The default pop and shake animations hang off it." },
  { hook: ".hud-field.is-low", is: "state", what: "A bar under its threshold." },
  { hook: ".hud-label", is: "selector", what: "The readout's name." },
  { hook: ".hud-value", is: "selector", what: "The readout's value, wrapping the parts below." },
  { hook: ".hud-prefix .hud-zeros .hud-text .hud-suffix", is: "selector", what: "A number's parts: prefix, the zero-fill, the digits, suffix. A clock and a string are only .hud-text." },
  { hook: ".hud-icons > .hud-icon.is-on / .is-off, .hud-overflow", is: "selector", what: "The glyph row; each icon is lit or not. The overflow follows it with \"×12\" past the last one." },
  { hook: ".hud-bar > .hud-bar-fill, .hud-readout", is: "selector", what: "The bar and its fill. The readout follows when the field asks for one." },
  { hook: "--hud-fill", is: "variable", what: "On .hud-bar: the fill as a percentage. The base sheet uses it as the fill's width." },
  ...hudStyleTokenNames
    .filter((name) => HUD_STYLE_TOKENS[name].type !== "boolean")
    .map((name) => ({ hook: hudCssVariable(name), is: "token", what: `${HUD_STYLE_TOKENS[name].label}. Set on .hud by the document; re-scope it on any element.` })),
  { hook: "--hud-text-shadow --hud-panel-fill", is: "variable", what: "Composites the document derives from glow, shadow, panel and panelAlpha." },
  { hook: ".hud[data-uppercase=\"true\"]", is: "attribute", what: "Labels are uppercased. The one boolean token, as an attribute because CSS cannot branch on a variable." },
]);
