// What a HUD is made of.
//
// Every game here draws a score, and every one of them draws it differently
// and badly at 11pm: Starline's is JSX over a CSS module, Pinball's is a
// hand-positioned `<div>` per readout, Voidcut's is `ctx.fillText` inside the
// render pass, and the generated GameMaker demos each have a `<pre>`. None
// of them can be restyled without editing the game, and none of them agrees
// on how a life is drawn or when a timer shows tenths.
//
// So a HUD is a **document**: a list of readouts — score, lives, time, a
// health bar, a line of text — each placed in one of seven slots around the
// play field, plus a small set of style tokens and, for anything the tokens
// do not reach, a stylesheet of the author's own. The runtime turns that
// document into DOM with stable hooks (`hud/view`) and into CSS (`hud/css`);
// the game feeds it values from its presentation layer and never touches a
// node. The designer on the site edits exactly this document, and what it
// previews is what a game mounts, because they are the same functions.
//
// **This is presentation.** A HUD reads state the simulation exposes and
// writes nothing back, so it lives outside `step` with the particles and
// the sound, may use the wall clock for its pulse animation, and may differ
// between two players in a co-op match without anyone desyncing.

import { defineFields } from "../core/fields.js";
import {
  asBoolean,
  boundedInteger,
  boundedNumber,
  boundedString,
  cssSupports,
  hexColor,
  isSafeCssValue,
  oneOf,
} from "../core/validate.js";

export const HUD_VERSION = 1;

/**
 * How a readout presents its value. The kind decides which options matter
 * and what the value is expected to be:
 *
 * `number`  a count — score, coins, wave. Zero-padded, grouped, decimals.
 * `icons`   a small integer as a row of glyphs — lives, bombs, keys.
 * `time`    seconds as a clock, in the format the game wants.
 * `bar`     a value over a maximum — health, energy, progress.
 * `text`    a short string — the level name, the weapon, "READY".
 */
export const HUD_FIELD_KINDS = Object.freeze(["number", "icons", "time", "bar", "text"]);

/** Where a readout sits. Three across the top, three across the bottom, and the middle. */
export const HUD_SLOTS = Object.freeze([
  "top-left", "top-center", "top-right",
  "center",
  "bottom-left", "bottom-center", "bottom-right",
]);

export const HUD_SIZES = Object.freeze(["small", "normal", "large"]);
export const HUD_TIME_FORMATS = Object.freeze(["m:ss", "mm:ss", "m:ss.t", "h:mm:ss", "s"]);
export const HUD_BAR_READOUTS = Object.freeze(["none", "value", "percent", "fraction"]);
export const HUD_ICON_OVERFLOWS = Object.freeze(["count", "hide"]);

/** A field id is a CSS-safe slug, because it becomes `data-field="…"`. */
export function hudSlug(value, fallback) {
  const slug = String(typeof value === "string" ? value : "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || fallback;
}

/** `hi-score` → `Hi Score`, the label a new field starts with. */
export function hudTitle(id) {
  return String(id)
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * A colour as CSS will read it. Hex from the designer's colour inputs, and
 * any colour `CSS.supports` accepts from a hand-edited file — `transparent`,
 * `hsl(…)`, a named colour — but nothing that could escape a declaration.
 * The same stance as a skin token, for the same reason: this string ends up
 * inside a `<style>` element.
 */
export function hudColor(value, fallback) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed || !isSafeCssValue(trimmed, 60)) return fallback;
  if (/^#[0-9a-f]{3,8}$/i.test(trimmed)) return hexColor(trimmed, fallback);
  return cssSupports("color", trimmed) ? trimmed : fallback;
}

/** A font-family list, and nothing that could close the declaration. */
export function hudFont(value, fallback) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim().slice(0, 120);
  return trimmed && /^[a-zA-Z0-9 ,'"-]+$/.test(trimmed) ? trimmed : fallback;
}

/**
 * The style tokens, and everything about them in one table: the type that
 * clamps them, the fallback a garbage value becomes, the unit the CSS half
 * appends, and the label the designer shows. `normalizeHudStyle` walks it,
 * `hudTokensToCss` walks it, and `HUD_STYLE_FIELDS` is derived from it, so
 * a token added here reaches the file, the stylesheet and the panel at once.
 *
 * Each becomes a `--hud-*` custom property (`labelColor` → `--hud-label-color`),
 * which is what lets the author's own CSS override any of them.
 */
/** @type {Readonly<Record<string, { type: string, label: string, fallback: any, min?: number, max?: number, step?: number, unit?: string, help?: string }>>} */
export const HUD_STYLE_TOKENS = Object.freeze({
  font: { type: "font", label: "Value font", fallback: "Impact, 'Arial Black', sans-serif" },
  labelFont: { type: "font", label: "Label font", fallback: "ui-sans-serif, system-ui, sans-serif" },
  size: { type: "integer", label: "Value size", min: 8, max: 120, unit: "px", fallback: 26 },
  labelSize: { type: "integer", label: "Label size", min: 6, max: 60, unit: "px", fallback: 11 },
  color: { type: "color", label: "Value colour", fallback: "#ffffff" },
  labelColor: { type: "color", label: "Label colour", fallback: "#9aa3b2" },
  accent: { type: "color", label: "Accent", fallback: "#ffd166", help: "Icons that are on, the bar fill, the glow." },
  dim: { type: "color", label: "Dim", fallback: "#3a4050", help: "Icons that are off, leading zeros, the empty bar." },
  low: { type: "color", label: "Low", fallback: "#ff5d5d", help: "A bar under its threshold." },
  panel: { type: "color", label: "Panel colour", fallback: "#000000" },
  panelAlpha: { type: "range", label: "Panel opacity", min: 0, max: 1, step: 0.05, fallback: 0 },
  panelBorder: { type: "color", label: "Panel border", fallback: "#ffffff" },
  borderWidth: { type: "integer", label: "Border width", min: 0, max: 8, unit: "px", fallback: 0 },
  radius: { type: "integer", label: "Panel radius", min: 0, max: 48, unit: "px", fallback: 0 },
  padding: { type: "integer", label: "Panel padding", min: 0, max: 48, unit: "px", fallback: 6 },
  gap: { type: "integer", label: "Gap between readouts", min: 0, max: 64, unit: "px", fallback: 18 },
  inset: { type: "integer", label: "Inset from the edge", min: 0, max: 96, unit: "px", fallback: 14 },
  letterSpacing: { type: "range", label: "Letter spacing", min: 0, max: 0.5, step: 0.01, unit: "em", fallback: 0.04 },
  uppercase: { type: "boolean", label: "Uppercase labels", fallback: true },
  glow: { type: "integer", label: "Glow", min: 0, max: 40, unit: "px", fallback: 0 },
  shadow: { type: "integer", label: "Drop shadow", min: 0, max: 8, unit: "px", fallback: 0 },
  iconSize: { type: "integer", label: "Icon size", min: 8, max: 96, unit: "px", fallback: 20 },
  barWidth: { type: "integer", label: "Bar width", min: 40, max: 600, unit: "px", fallback: 140 },
  barHeight: { type: "integer", label: "Bar height", min: 2, max: 60, unit: "px", fallback: 10 },
});

export const hudStyleTokenNames = Object.freeze(Object.keys(HUD_STYLE_TOKENS));

/** @param {any} [input] */
export function normalizeHudStyle(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const style = {};
  for (const [name, token] of Object.entries(HUD_STYLE_TOKENS)) {
    const raw = source[name];
    switch (token.type) {
      case "font":
        style[name] = hudFont(raw, token.fallback);
        break;
      case "color":
        style[name] = hudColor(raw, token.fallback);
        break;
      case "boolean":
        style[name] = asBoolean(raw, Boolean(token.fallback));
        break;
      case "integer":
        style[name] = boundedInteger(raw, token.fallback, token.min, token.max);
        break;
      default:
        style[name] = boundedNumber(raw, token.fallback, token.min, token.max);
    }
  }
  return style;
}

/**
 * One readout. Every option is carried whatever the kind, with a default
 * that suits the kind — the same shape `burst` layers take, so an editor
 * can switch a field's kind without losing what was typed under the old one.
 *
 * @param {any} [input]
 * @param {number} [index] Position in the list, for the default id.
 */
export function normalizeHudField(input = {}, index = 0) {
  const source = input && typeof input === "object" ? input : {};
  const kind = oneOf(source.kind, [...HUD_FIELD_KINDS], "number");
  const id = hudSlug(source.id, `field-${index + 1}`);
  return {
    id,
    kind,
    label: boundedString(source.label, hudTitle(id), 40),
    showLabel: asBoolean(source.showLabel, true),
    slot: oneOf(source.slot, [...HUD_SLOTS], "top-left"),
    size: oneOf(source.size, [...HUD_SIZES], "normal"),

    // number: `pad` is the digit count a score is zero-filled to, and the
    // leading zeros get their own span so the classic dimmed-zeros look is
    // one CSS rule rather than a second renderer.
    pad: boundedInteger(source.pad, 0, 0, 12),
    group: asBoolean(source.group, false),
    decimals: boundedInteger(source.decimals, 0, 0, 3),
    prefix: typeof source.prefix === "string" ? source.prefix.slice(0, 8) : "",
    suffix: typeof source.suffix === "string" ? source.suffix.slice(0, 8) : "",

    // icons: `max` glyphs are drawn and switched on or off; past `max` the
    // row either counts ("×12") or says nothing.
    icon: boundedString(source.icon, "♥", 4),
    max: boundedInteger(source.max, 5, 1, 24),
    showEmpty: asBoolean(source.showEmpty, true),
    overflow: oneOf(source.overflow, [...HUD_ICON_OVERFLOWS], "count"),

    // time
    format: oneOf(source.format, [...HUD_TIME_FORMATS], "m:ss"),

    // bar: `full` is the maximum when the game sends a bare number; a
    // `{ value, max }` at runtime overrides it. `low` is a fraction.
    full: boundedNumber(source.full, 100, 1, 1e9),
    low: boundedNumber(source.low, 0.25, 0, 1),
    readout: oneOf(source.readout, [...HUD_BAR_READOUTS], "none"),

    // text
    maxLength: boundedInteger(source.maxLength, 24, 1, 200),
    placeholder: typeof source.placeholder === "string" ? source.placeholder.trim().slice(0, 40) : "",
  };
}

/**
 * The whole document. Ids are made unique in order, so a file with two
 * `score` fields keeps both rather than silently merging their values.
 *
 * `css` arrives here as whatever the file held; `hud/css` owns the rules
 * about what is allowed in it, and `normalizeHud` calls that, so a document
 * that has been through here never carries a stylesheet a mount would refuse.
 *
 * @param {any} [input]
 * @param {object} [options]
 * @param {(css: string) => { css: string, rejected: string[] }} [options.sanitizeCss]
 *        Injected by `hud/css` through `normalizeHud`; this module does not
 *        import upward.
 */
export function normalizeHudBody(input = {}, { sanitizeCss } = {}) {
  const source = input && typeof input === "object" ? input : {};
  const seen = new Set();
  const fields = (Array.isArray(source.fields) ? source.fields : [])
    .slice(0, 32)
    .map((field, index) => normalizeHudField(field, index))
    .map((field) => {
      let id = field.id;
      let suffix = 2;
      while (seen.has(id)) id = `${field.id}-${suffix++}`;
      seen.add(id);
      return id === field.id ? field : { ...field, id };
    });
  const rawCss = typeof source.css === "string" ? source.css : "";
  const cleaned = sanitizeCss ? sanitizeCss(rawCss) : { css: rawCss, rejected: [] };
  return {
    version: HUD_VERSION,
    id: boundedString(source.id, "hud-1", 60),
    name: boundedString(source.name, "Untitled HUD", 80),
    fields,
    style: normalizeHudStyle(source.style),
    css: cleaned.css,
  };
}

/** A blank HUD: no readouts, default tokens, no stylesheet. */
export function emptyHud(name = "Untitled HUD") {
  return normalizeHudBody({ name });
}

/** A new readout of a kind, with an id no field in `hud` already uses. */
export function newHudField(hud, kind = "number", id) {
  const taken = new Set((hud?.fields ?? []).map((field) => field.id));
  let base = hudSlug(id, kind);
  let candidate = base;
  let suffix = 2;
  while (taken.has(candidate)) candidate = `${base}-${suffix++}`;
  return normalizeHudField({ id: candidate, kind }, hud?.fields?.length ?? 0);
}

// -- schemas for a property panel ----------------------------------------

const hudStyleFieldSpec = (name, token) => ({
  key: name,
  path: `style.${name}`,
  label: token.label,
  type: token.type === "font" ? "text" : token.type === "range" ? "range" : token.type,
  min: token.min,
  max: token.max,
  step: token.step ?? (token.type === "integer" ? 1 : undefined),
  unit: token.unit ? token.unit : "",
  fallback: token.fallback,
  maxLength: token.type === "font" ? 120 : undefined,
  help: token.help ?? "",
});

const hudPickTokens = (names) => names.map((name) => hudStyleFieldSpec(name, HUD_STYLE_TOKENS[name]));

/** The style tokens as a `defineFields` schema, grouped the way the designer shows them. */
export const HUD_STYLE_FIELDS = defineFields([
  { title: "Type", fields: hudPickTokens(["font", "size", "labelFont", "labelSize", "letterSpacing", "uppercase"]) },
  { title: "Colour", fields: hudPickTokens(["color", "labelColor", "accent", "dim", "low"]) },
  { title: "Panel", fields: hudPickTokens(["panel", "panelAlpha", "panelBorder", "borderWidth", "radius", "padding"]) },
  { title: "Layout", fields: hudPickTokens(["gap", "inset", "iconSize", "barWidth", "barHeight"]) },
  { title: "Effects", fields: hudPickTokens(["glow", "shadow"]) },
]);

/**
 * One readout's options as a schema, with the kind-specific rows hidden
 * unless they apply. Paths are relative to the field object, so a panel
 * edits a field draft directly.
 */
export const HUD_FIELD_FIELDS = defineFields([
  {
    title: "Readout",
    fields: [
      { key: "label", type: "text", label: "Label", maxLength: 40 },
      { key: "showLabel", type: "boolean", label: "Show label", fallback: true },
      { key: "kind", type: "enum", label: "Kind", options: HUD_FIELD_KINDS },
      { key: "slot", type: "enum", label: "Slot", options: HUD_SLOTS },
      { key: "size", type: "enum", label: "Size", options: HUD_SIZES, fallback: "normal" },
    ],
  },
  {
    title: "Number",
    when: (field) => field.kind === "number",
    fields: [
      { key: "pad", type: "integer", label: "Zero-pad to", min: 0, max: 12, fallback: 0, unit: " digits" },
      { key: "group", type: "boolean", label: "Thousands separator" },
      { key: "decimals", type: "integer", label: "Decimals", min: 0, max: 3, fallback: 0 },
      { key: "prefix", type: "text", label: "Prefix", maxLength: 8 },
      { key: "suffix", type: "text", label: "Suffix", maxLength: 8 },
    ],
  },
  {
    title: "Icons",
    when: (field) => field.kind === "icons",
    fields: [
      { key: "icon", type: "text", label: "Glyph", maxLength: 4, fallback: "♥" },
      { key: "max", type: "integer", label: "Icons shown", min: 1, max: 24, fallback: 5 },
      { key: "showEmpty", type: "boolean", label: "Show lost ones dimmed", fallback: true },
      { key: "overflow", type: "enum", label: "Past the last icon", options: HUD_ICON_OVERFLOWS, fallback: "count" },
    ],
  },
  {
    title: "Time",
    when: (field) => field.kind === "time",
    fields: [
      { key: "format", type: "enum", label: "Format", options: HUD_TIME_FORMATS, fallback: "m:ss" },
    ],
  },
  {
    title: "Bar",
    when: (field) => field.kind === "bar",
    fields: [
      { key: "full", type: "range", label: "Full at", min: 1, max: 1000, step: 1, fallback: 100 },
      { key: "low", type: "range", label: "Low below", min: 0, max: 1, step: 0.05, fallback: 0.25 },
      { key: "readout", type: "enum", label: "Readout", options: HUD_BAR_READOUTS, fallback: "none" },
    ],
  },
  {
    title: "Text",
    when: (field) => field.kind === "text",
    fields: [
      { key: "maxLength", type: "integer", label: "Longest text", min: 1, max: 200, fallback: 24 },
      { key: "placeholder", type: "text", label: "When empty", maxLength: 40 },
    ],
  },
]);
