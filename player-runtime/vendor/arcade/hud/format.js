// What a readout shows for a value. Pure, and the reason the view is thin.
//
// Everything a HUD decides about a value — how many zeros a score wears,
// whether a timer shows tenths, which of five hearts are lit, whether a bar
// is "low" — is arithmetic on a field and a number, so it lives here where
// node can test it exactly. `hud/view` only copies the result into nodes.
//
// `hudPresent` returns one uniform record whatever the kind, so the view can
// diff two of them with a single comparison and touch the DOM only when
// something on screen would change. A HUD is updated every frame by most
// games, and a frame where nothing changed should cost nothing.

/**
 * @typedef {object} HudShown
 * @property {string} zeros   The zero-fill in front of a padded number.
 * @property {string} text    The digits, the clock, the string, the bar's readout.
 * @property {number} on      How many icons are lit.
 * @property {string} overflow  "×12" past the last icon, or "".
 * @property {string} fill    The bar's width as a CSS percentage.
 * @property {boolean} low    Whether a bar is under its threshold.
 * @property {number|null} numeric  What a change compares against, for the
 *           up/down pulse; null for text, which has no direction.
 */

const hudBlank = () => ({ zeros: "", text: "", on: 0, overflow: "", fill: "", low: false, numeric: null });

const hudFinite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : Number(value));

/** A count with the field's padding, grouping, decimals, and sign. */
export function hudFormatNumber(value, field) {
  const numeric = hudFinite(value);
  const n = Number.isFinite(numeric) ? numeric : 0;
  const fixed = Math.abs(n).toFixed(field.decimals);
  const dot = fixed.indexOf(".");
  let whole = dot === -1 ? fixed : fixed.slice(0, dot);
  const fraction = dot === -1 ? "" : fixed.slice(dot);
  const zeros = field.pad > whole.length ? "0".repeat(field.pad - whole.length) : "";
  if (field.group) whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return { zeros, text: `${n < 0 ? "-" : ""}${whole}${fraction}`, numeric: n };
}

/**
 * Seconds as a clock. Negative and non-finite read as zero rather than as
 * "-1:-05": a countdown that overshoots by a frame should show 0:00.
 */
export function hudFormatTime(seconds, format = "m:ss") {
  const numeric = hudFinite(seconds);
  const total = Math.max(0, Number.isFinite(numeric) ? numeric : 0);
  const whole = Math.floor(total);
  const tenths = Math.floor((total - whole) * 10);
  const two = (part) => String(part).padStart(2, "0");
  const minutes = Math.floor(whole / 60);
  const secs = whole % 60;
  switch (format) {
    case "s":
      return String(whole);
    case "mm:ss":
      return `${two(minutes)}:${two(secs)}`;
    case "m:ss.t":
      return `${minutes}:${two(secs)}.${tenths}`;
    case "h:mm:ss":
      return `${Math.floor(whole / 3600)}:${two(Math.floor((whole % 3600) / 60))}:${two(secs)}`;
    default:
      return `${minutes}:${two(secs)}`;
  }
}

/** How many of the field's icons are lit, and what to say past the last one. */
export function hudFormatIcons(value, field) {
  const numeric = hudFinite(value);
  const count = Math.max(0, Math.round(Number.isFinite(numeric) ? numeric : 0));
  const on = Math.min(count, field.max);
  const overflow = count > field.max && field.overflow === "count" ? `×${count}` : "";
  return { on, overflow, numeric: count };
}

/**
 * A bar from a bare number over the field's `full`, or from a
 * `{ value, max }` / `[value, max]` the game sends when the maximum moves —
 * a health bar after a heart container, an XP bar per level.
 */
export function hudFormatBar(value, field) {
  let current;
  let full;
  if (Array.isArray(value)) [current, full] = value;
  else if (value && typeof value === "object") ({ value: current, max: full } = value);
  else current = value;
  current = hudFinite(current);
  full = hudFinite(full);
  if (!Number.isFinite(current)) current = 0;
  if (!Number.isFinite(full) || full <= 0) full = field.full;
  const ratio = Math.min(1, Math.max(0, current / full));
  let text = "";
  if (field.readout === "value") text = String(Math.round(current));
  else if (field.readout === "percent") text = `${Math.round(ratio * 100)}%`;
  else if (field.readout === "fraction") text = `${Math.round(current)}/${Math.round(full)}`;
  return { ratio, fill: `${(ratio * 100).toFixed(1)}%`, low: ratio < field.low, text, numeric: ratio };
}

/** A string, capped, with the placeholder standing in for nothing. */
export function hudFormatText(value, field) {
  const text = value === null || value === undefined ? "" : String(value);
  return { text: text.slice(0, field.maxLength) || field.placeholder };
}

/**
 * The one entry point: what this field shows for this value.
 *
 * @param {object} field A normalized field.
 * @param {unknown} value Whatever the game sent; garbage reads as zero or empty.
 * @returns {HudShown}
 */
export function hudPresent(field, value) {
  const shown = hudBlank();
  switch (field.kind) {
    case "icons": {
      const icons = hudFormatIcons(value, field);
      shown.on = icons.on;
      shown.overflow = icons.overflow;
      shown.numeric = icons.numeric;
      break;
    }
    case "time": {
      const numeric = hudFinite(value);
      shown.text = hudFormatTime(numeric, field.format);
      shown.numeric = Number.isFinite(numeric) ? numeric : 0;
      break;
    }
    case "bar": {
      const bar = hudFormatBar(value, field);
      shown.fill = bar.fill;
      shown.low = bar.low;
      shown.text = bar.text;
      shown.numeric = bar.numeric;
      break;
    }
    case "text":
      shown.text = hudFormatText(value, field).text;
      break;
    default: {
      const number = hudFormatNumber(value, field);
      shown.zeros = number.zeros;
      shown.text = number.text;
      shown.numeric = number.numeric;
    }
  }
  return shown;
}

/** True when two presentations would put the same thing on screen. */
export function hudSameShown(left, right) {
  if (!left || !right) return false;
  return left.zeros === right.zeros && left.text === right.text && left.on === right.on &&
    left.overflow === right.overflow && left.fill === right.fill && left.low === right.low;
}

/** `up`, `down` or `same`: the direction a change went, for the pulse hook. */
export function hudDelta(before, after) {
  if (!before || before.numeric === null || after.numeric === null) return "same";
  if (after.numeric > before.numeric) return "up";
  if (after.numeric < before.numeric) return "down";
  return "same";
}
