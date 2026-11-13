// The skin token contract.
//
// The DOM half is the Game Skin Lab's `contract.ts`, kept name-for-name so the
// lab keeps working. The addition is the `canvas.*` group: games draw with
// `ctx.fillStyle`, not CSS custom properties, and a skin system that only
// reaches the DOM leaves the actual game unskinned. SpeegeBall already keeps a
// parallel `COLORS` object for exactly this reason — here it is part of the
// contract instead of a second source of truth.

export const SKIN_CONTRACT_VERSION = 2;

export const tokenDefinitions = {
  // -- surfaces and text (DOM) --
  "surface.canvas": { type: "color", label: "Canvas", group: "dom" },
  "surface.panel": { type: "color", label: "Panel", group: "dom" },
  "surface.raised": { type: "color", label: "Raised surface", group: "dom" },
  "text.primary": { type: "color", label: "Primary text", group: "dom" },
  "text.muted": { type: "color", label: "Muted text", group: "dom" },
  "border.default": { type: "color", label: "Default border", group: "dom" },
  "action.primary": { type: "color", label: "Primary action", group: "dom" },
  "action.primaryHover": { type: "color", label: "Primary action hover", group: "dom" },
  "action.onPrimary": { type: "color", label: "Text on primary action", group: "dom" },
  "status.success": { type: "color", label: "Success", group: "dom" },
  "status.warning": { type: "color", label: "Warning", group: "dom" },
  "radius.control": { type: "dimension", label: "Control radius", group: "dom" },
  "radius.panel": { type: "dimension", label: "Panel radius", group: "dom" },
  "shadow.panel": { type: "shadow", label: "Panel shadow", group: "dom" },
  "font.display": { type: "fontFamily", label: "Display font", group: "dom" },
  "font.body": { type: "fontFamily", label: "Body font", group: "dom" },
  "motion.fast": { type: "duration", label: "Fast motion", group: "dom" },

  // -- play-field colours (canvas) --
  "canvas.ground": { type: "color", label: "Play-field ground", group: "canvas" },
  "canvas.grid": { type: "color", label: "Play-field grid", group: "canvas" },
  "canvas.accent": { type: "color", label: "Play-field accent", group: "canvas" },
  "canvas.accentBright": { type: "color", label: "Accent highlight", group: "canvas" },
  "canvas.danger": { type: "color", label: "Hazard", group: "canvas" },
  "canvas.alt": { type: "color", label: "Secondary signal", group: "canvas" },
  "canvas.dim": { type: "color", label: "Inactive fill", group: "canvas" },
  "canvas.ink": { type: "color", label: "On-field text", group: "canvas" },
};

export const skinTokenNames = Object.keys(tokenDefinitions);

export const domTokenNames = skinTokenNames.filter((name) => tokenDefinitions[name].group === "dom");
export const canvasTokenNames = skinTokenNames.filter((name) => tokenDefinitions[name].group === "canvas");

/** `surface.panel` -> `--game-surface-panel`. Unchanged from the lab. */
export function tokenToCssVariable(name) {
  return `--game-${name.replaceAll(".", "-")}`;
}

/** `canvas.accentBright` -> `accentBright`, the key games actually read. */
export function canvasTokenKey(name) {
  return name.slice("canvas.".length);
}
