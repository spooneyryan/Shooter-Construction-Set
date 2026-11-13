// Shared sanitizers. Every other module funnels untrusted input through these,
// so there is exactly one place that decides what "a safe number" means.
//
// The rule throughout: never throw on a bad value that has an obvious safe
// substitute, and never silently accept one that does not. Saved files,
// imported skins, and share links all arrive from outside the program.

/** The set of characters that let a CSS value escape its declaration.
 *
 * `/*` is in there for `skinToCss`, which writes these values into a stylesheet
 * as text. An unterminated comment is not a parse error in CSS -- it is closed
 * for you at the end of the sheet -- so one arriving in a token swallows every
 * declaration after it, the closing brace, and whatever rule follows. Through
 * `setProperty` it is harmless, which is exactly why it survived a browser and
 * would have shipped. */
const CSS_ESCAPE = /[;{}]|\/\*|url\s*\(|var\s*\(|expression\s*\(|@import/i;

export function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Clamp `value` into [min, max], substituting `fallback` when it is not a
 * finite number. Accepts numeric strings so form values work unchanged.
 */
export function boundedNumber(value, fallback, min, max) {
  const numeric = typeof value === "string" ? Number(value.trim()) : Number(value);
  const base = Number.isFinite(numeric) ? numeric : fallback;
  if (!Number.isFinite(base)) return min;
  return Math.min(max, Math.max(min, base));
}

export function boundedInteger(value, fallback, min, max) {
  return Math.round(boundedNumber(value, fallback, min, max));
}

/** Snap to the nearest multiple of `step`, then clamp. Order matters: snapping
 *  first can push a value past a bound, so the clamp has to come last. */
export function snapped(value, fallback, min, max, step) {
  const bounded = boundedNumber(value, fallback, min, max);
  if (!Number.isFinite(step) || step <= 0) return bounded;
  return Math.min(max, Math.max(min, Math.round(bounded / step) * step));
}

export function boundedString(value, fallback, maxLength = 120) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : fallback;
}

export function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

export function asBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "on" || value === 1 || value === "1") return true;
  if (value === "false" || value === "off" || value === 0 || value === "0") return false;
  return fallback;
}

export function isHexColor(value) {
  return typeof value === "string" && /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value.trim());
}

export function hexColor(value, fallback) {
  return isHexColor(value) ? value.trim() : fallback;
}

/** Wrap into [0, 360) — hues arrive negative and over-rotated often enough. */
export function wrapHue(value, fallback = 0) {
  const numeric = Number(value);
  const base = Number.isFinite(numeric) ? numeric : fallback;
  return ((base % 360) + 360) % 360;
}

/**
 * True when a string is safe to write into a CSS declaration. This is the
 * guard from the skin lab, generalized: it is used for skin tokens and for any
 * other place a saved file supplies a value that ends up in a stylesheet.
 */
export function isSafeCssValue(value, maxLength = 180) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !CSS_ESCAPE.test(value);
}

/**
 * `CSS.supports` is the only honest way to know whether a browser will accept a
 * colour or shadow, but it does not exist under Node. Callers get a permissive
 * answer off-platform so tests and server-side rendering still run; the browser
 * remains the enforcing side.
 */
export function cssSupports(property, value) {
  const api = globalThis.CSS;
  if (!api || typeof api.supports !== "function") return true;
  try {
    return api.supports(property, value);
  } catch {
    return false;
  }
}

/** A filesystem-safe slug for download filenames. */
export function safeFilename(name, fallback = "download", extension = "json") {
  const base = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 52);
  return `${base || fallback}.${extension}`;
}

/** A random identifier, preferring the platform UUID when one is available. */
export function uniqueId(prefix = "id") {
  const crypto = globalThis.crypto;
  if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
