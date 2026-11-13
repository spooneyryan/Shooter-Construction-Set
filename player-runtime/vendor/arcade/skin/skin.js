// Applying, emitting, deriving and validating skins.
//
// `parseSkinFile` is the Skin Lab's `parseUserTheme`, which is the only code in
// the repo that treats user-supplied content as hostile. It stays strict, and
// the same guards are exported so imported *documents* can use them too — a
// level file that carries a colour is exactly as untrusted as a skin file.

import { cssSupports, isSafeCssValue, wrapHue } from "../core/validate.js";
import {
  SKIN_CONTRACT_VERSION,
  canvasTokenKey,
  canvasTokenNames,
  skinTokenNames,
  tokenDefinitions,
  tokenToCssVariable,
} from "./contract.js";

/** True when a value is safe *and* plausible for the token's declared type. */
export function isValidTokenValue(name, value) {
  const definition = tokenDefinitions[name];
  if (!definition) return false;
  if (!isSafeCssValue(value)) return false;
  if (definition.type === "color") return cssSupports("color", value);
  if (definition.type === "shadow") return cssSupports("box-shadow", value);
  if (definition.type === "dimension") {
    const match = /^(\d{1,2})px$/.exec(value);
    return Boolean(match && Number(match[1]) <= 64);
  }
  if (definition.type === "duration") {
    const match = /^(\d{1,4})ms$/.exec(value);
    return Boolean(match && Number(match[1]) <= 2000);
  }
  // fontFamily: a family list, and nothing that could close the declaration.
  return /^[a-zA-Z0-9 ,'"-]+$/.test(value);
}

/** Write every token onto an element as a CSS custom property. */
export function applySkin(skin, target) {
  if (!target?.style) return;
  for (const name of skinTokenNames) {
    const value = skin.tokens[name];
    if (value !== undefined) target.style.setProperty(tokenToCssVariable(name), value);
  }
}

/**
 * The canvas half: a plain object of colours to assign to `ctx.fillStyle`.
 * This is what makes a skin reach the game rather than only its chrome.
 */
export function skinCanvasColors(skin) {
  const colors = {};
  for (const name of canvasTokenNames) {
    colors[canvasTokenKey(name)] = skin.tokens[name];
  }
  return Object.freeze(colors);
}

/** Static CSS, for a build step or a `<style>` block. */
export function skinToCss(skin, selector = ":root") {
  const declarations = skinTokenNames
    .filter((name) => skin.tokens[name] !== undefined)
    .map((name) => `  ${tokenToCssVariable(name)}: ${skin.tokens[name]};`)
    .join("\n");
  return `${selector} {\n${declarations}\n}`;
}

/** Keeps the browser tab colour in step with the skin. */
export function applyThemeColor(skin, documentRef = globalThis.document) {
  const meta = documentRef?.querySelector?.('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", skin.tokens["surface.canvas"]);
}

/**
 * Validate an imported skin file. Unknown tokens are dropped, unsafe values are
 * dropped, and whatever survives is layered over a known-good fallback so the
 * result is always complete.
 */
export function parseSkinFile(input, fallback) {
  if (!input || typeof input !== "object") throw new Error("A skin must be a JSON object.");
  if (input.contractVersion !== SKIN_CONTRACT_VERSION) {
    throw new Error(`This game expects skin contract v${SKIN_CONTRACT_VERSION}.`);
  }
  if (!input.tokens || typeof input.tokens !== "object") {
    throw new Error("The skin needs a tokens object.");
  }

  const accepted = {};
  for (const [name, value] of Object.entries(input.tokens)) {
    if (!(name in tokenDefinitions) || typeof value !== "string") continue;
    if (isValidTokenValue(name, value)) accepted[name] = value;
  }
  if (Object.keys(accepted).length === 0) throw new Error("No recognized tokens were found.");

  return {
    id: typeof input.id === "string" ? input.id.slice(0, 60) : "imported-skin",
    name: typeof input.name === "string" ? input.name.slice(0, 60) : "Imported skin",
    description: "Imported from a skin file",
    contractVersion: SKIN_CONTRACT_VERSION,
    tokens: { ...fallback.tokens, ...accepted },
  };
}

const clampPercent = (value) => Math.min(100, Math.max(0, value));

/**
 * Build a whole skin from one hue.
 *
 * SpeegeBall does this today: it rotates the base hue by +285 for the danger
 * colour and +175 for the alternate signal, which is what keeps a single hue
 * slider from producing muddy or clashing palettes. Those offsets are its
 * numbers, kept because they were tuned by eye and they work.
 *
 * @param {number} hue
 * @param {object} [options]
 * @param {string} [options.id]
 * @param {string} [options.name]
 * @param {boolean} [options.dark]
 * @param {number} [options.dangerOffset]
 * @param {number} [options.altOffset]
 * @param {object} [options.base] Tokens to start from, so a caller can derive
 *        a variant of an existing skin rather than a fresh one.
 */
export function deriveSkinFromHue(hue, {
  id = "custom",
  name = "Custom",
  dark = true,
  dangerOffset = 285,
  altOffset = 175,
  base,
} = {}) {
  const h = wrapHue(hue);
  const danger = wrapHue(h + dangerOffset);
  const alt = wrapHue(h + altOffset);
  const hsl = (hueValue, saturation, lightness, alpha) => (
    alpha === undefined
      ? `hsl(${Math.round(hueValue)} ${clampPercent(saturation)}% ${clampPercent(lightness)}%)`
      : `hsl(${Math.round(hueValue)} ${clampPercent(saturation)}% ${clampPercent(lightness)}% / ${alpha})`
  );

  // Lightness flips between the two grounds; hue and the offsets do not.
  const groundL = dark ? 7 : 95;
  const panelL = dark ? 10 : 99;
  const raisedL = dark ? 14 : 96;
  const lineL = dark ? 20 : 80;
  const inkL = dark ? 91 : 14;
  const mutedL = dark ? 56 : 42;
  const accentL = dark ? 67 : 40;

  const tokens = {
    ...(base?.tokens ?? {}),
    "surface.canvas": hsl(h, 17, groundL),
    "surface.panel": hsl(h, 15, panelL),
    "surface.raised": hsl(h, 15, raisedL),
    "text.primary": hsl(h, 28, inkL),
    "text.muted": hsl(h, 12, mutedL),
    "border.default": hsl(h, 15, lineL),
    "action.primary": hsl(h, 100, accentL),
    "action.primaryHover": hsl(h, 100, dark ? 78 : 32),
    "action.onPrimary": hsl(h, 30, dark ? 8 : 99),
    "status.success": hsl(alt, 70, dark ? 66 : 34),
    "status.warning": hsl(danger, 100, dark ? 69 : 40),
    "radius.control": base?.tokens?.["radius.control"] ?? "6px",
    "radius.panel": base?.tokens?.["radius.panel"] ?? "10px",
    "shadow.panel": base?.tokens?.["shadow.panel"] ?? "0 18px 50px rgba(0, 0, 0, 0.35)",
    "font.display": base?.tokens?.["font.display"] ?? "Impact, 'Arial Black', sans-serif",
    "font.body": base?.tokens?.["font.body"] ?? "ui-sans-serif, system-ui, 'Segoe UI', sans-serif",
    "motion.fast": base?.tokens?.["motion.fast"] ?? "150ms",

    "canvas.ground": hsl(h, 20, dark ? 7 : 93),
    "canvas.grid": hsl(h, 100, accentL, ".028"),
    "canvas.accent": hsl(h, 100, accentL),
    "canvas.accentBright": hsl(h, 100, dark ? 88 : 30),
    "canvas.danger": hsl(danger, 100, dark ? 69 : 46),
    "canvas.alt": hsl(alt, 100, dark ? 70 : 42),
    "canvas.dim": hsl(h, 14, dark ? 17 : 84),
    "canvas.ink": hsl(h, 28, dark ? 94 : 12),
  };

  return { id, name, description: `Derived from hue ${Math.round(h)}`, contractVersion: SKIN_CONTRACT_VERSION, tokens };
}

/**
 * Apply everything a skin touches in one call, and hand back the canvas
 * colours. This is the whole integration surface for a game.
 */
export function useSkin(skin, {
  target = globalThis.document?.documentElement,
  document: documentRef = globalThis.document,
  themeColor = true,
} = {}) {
  applySkin(skin, target);
  if (themeColor) applyThemeColor(skin, documentRef);
  return skinCanvasColors(skin);
}
