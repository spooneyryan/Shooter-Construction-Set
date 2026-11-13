// Built-in skins.
//
// The first three are the palettes the three games already ship, transcribed
// onto the token names. That mapping is the whole migration: every game already
// defines --ink, --muted, --panel and --line, so adopting the contract is a
// rename rather than a redesign, and each game keeps looking like itself.
//
// The last four come from the Game Skin Lab, extended with the canvas group.

import { SKIN_CONTRACT_VERSION } from "./contract.js";

const shared = {
  "radius.control": "6px",
  "radius.panel": "10px",
  "shadow.panel": "0 18px 50px rgba(0, 0, 0, 0.35)",
  "font.display": "Impact, 'Arial Black', 'Segoe UI', sans-serif",
  "font.body": "ui-sans-serif, system-ui, 'Segoe UI', Roboto, sans-serif",
  "motion.fast": "150ms",
};

/** Pinball Construction Set — pinball.css `:root`. */
const workshop = {
  ...shared,
  "surface.canvas": "#07070a",
  "surface.panel": "#111117",
  "surface.raised": "#12151c",
  "text.primary": "#f5f7ff",
  "text.muted": "#9699aa",
  "border.default": "#30303b",
  "action.primary": "#42f5ec",
  "action.primaryHover": "#7ffff7",
  "action.onPrimary": "#07070a",
  "status.success": "#66f59a",
  "status.warning": "#f8f06b",
  "radius.control": "8px",
  "radius.panel": "8px",
  "font.body": "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
  "canvas.ground": "#07070a",
  "canvas.grid": "rgba(122, 139, 165, 0.055)",
  "canvas.accent": "#42f5ec",
  "canvas.accentBright": "#ff45df",
  "canvas.danger": "#ff45df",
  "canvas.alt": "#8c6cff",
  "canvas.dim": "#575b6d",
  "canvas.ink": "#f5f7ff",
};

/** Starline — app/globals.css `:root`. */
const sector = {
  ...shared,
  "surface.canvas": "#050a0f",
  "surface.panel": "#09131b",
  "surface.raised": "#0d1c26",
  "text.primary": "#eaf7fb",
  "text.muted": "#77909d",
  "border.default": "rgba(133, 177, 195, 0.2)",
  "action.primary": "#eaff62",
  "action.primaryHover": "#f4ff9a",
  "action.onPrimary": "#09131b",
  "status.success": "#64e3ff",
  "status.warning": "#ff6a4d",
  "font.display": "'Cascadia Mono', ui-monospace, Consolas, monospace",
  "canvas.ground": "#03070b",
  "canvas.grid": "rgba(126, 174, 194, 0.09)",
  "canvas.accent": "#eaff62",
  "canvas.accentBright": "#f7ffc4",
  "canvas.danger": "#ff6a4d",
  "canvas.alt": "#64e3ff",
  "canvas.dim": "#72838b",
  "canvas.ink": "#eaf7fb",
};

/** SpeegeBall / Voidcut — the default hue-84 palette. */
const voidcut = {
  ...shared,
  "surface.canvas": "#11140f",
  "surface.panel": "#191d16",
  "surface.raised": "#222719",
  "text.primary": "#e9eedb",
  "text.muted": "#8e9880",
  "border.default": "#343b2c",
  "action.primary": "#d9ff55",
  "action.primaryHover": "#e8ff8f",
  "action.onPrimary": "#11140f",
  "status.success": "#6bc7ff",
  "status.warning": "#ff6b5f",
  "canvas.ground": "#12150f",
  "canvas.grid": "rgba(217, 255, 85, 0.028)",
  "canvas.accent": "#d9ff55",
  "canvas.accentBright": "#f0ffc2",
  "canvas.danger": "#ff6b5f",
  "canvas.alt": "#6bc7ff",
  "canvas.dim": "#2b3024",
  "canvas.ink": "#e9eedb",
};

/** Game Skin Lab — Starship. */
const starship = {
  "surface.canvas": "#070b16",
  "surface.panel": "#0f1729",
  "surface.raised": "#18233a",
  "text.primary": "#f4f7ff",
  "text.muted": "#8fa2c5",
  "border.default": "#293958",
  "action.primary": "#7c5cff",
  "action.primaryHover": "#947cff",
  "action.onPrimary": "#ffffff",
  "status.success": "#52e3b3",
  "status.warning": "#ffca69",
  "radius.control": "10px",
  "radius.panel": "18px",
  "shadow.panel": "0 24px 80px rgba(0, 0, 0, 0.36)",
  "font.display": "'Arial Black', 'Segoe UI', sans-serif",
  "font.body": "'Segoe UI', Arial, sans-serif",
  "motion.fast": "160ms",
  "canvas.ground": "#050810",
  "canvas.grid": "rgba(143, 162, 197, 0.06)",
  "canvas.accent": "#7c5cff",
  "canvas.accentBright": "#c3b4ff",
  "canvas.danger": "#ff6f91",
  "canvas.alt": "#52e3b3",
  "canvas.dim": "#293958",
  "canvas.ink": "#f4f7ff",
};

const skin = (id, name, description, tokens) => ({
  id, name, description, contractVersion: SKIN_CONTRACT_VERSION, tokens,
});

export const builtInSkins = [
  skin("workshop", "Workshop", "Pinball Construction Set's neon-on-black bench", workshop),
  skin("sector", "Sector", "Starline's lime-and-cyan tactical display", sector),
  skin("voidcut", "Voidcut", "SpeegeBall's acid-green field", voidcut),
  skin("starship", "Starship", "Deep-space glass and ultraviolet signals", starship),
  skin("ember", "Ember Forge", "Smoked steel, warm brass, and firelight", {
    ...starship,
    "surface.canvas": "#160d09",
    "surface.panel": "#24140e",
    "surface.raised": "#342017",
    "text.primary": "#fff5df",
    "text.muted": "#c9a982",
    "border.default": "#68412a",
    "action.primary": "#e85d24",
    "action.primaryHover": "#ff773d",
    "action.onPrimary": "#fffaf2",
    "status.success": "#a9d36e",
    "status.warning": "#ffc15a",
    "radius.control": "4px",
    "radius.panel": "8px",
    "shadow.panel": "0 24px 80px rgba(18, 5, 0, 0.52)",
    "font.display": "Georgia, 'Times New Roman', serif",
    "canvas.ground": "#120a06",
    "canvas.grid": "rgba(201, 169, 130, 0.05)",
    "canvas.accent": "#e85d24",
    "canvas.accentBright": "#ffc15a",
    "canvas.danger": "#ff773d",
    "canvas.alt": "#a9d36e",
    "canvas.dim": "#4a2c1d",
    "canvas.ink": "#fff5df",
  }),
  skin("paper", "Paper & Ink", "A calm tabletop skin with editorial type", {
    ...starship,
    "surface.canvas": "#eee9dd",
    "surface.panel": "#fffdf7",
    "surface.raised": "#f3efe4",
    "text.primary": "#26241f",
    "text.muted": "#6f6a5e",
    "border.default": "#c8c0ad",
    "action.primary": "#1f6257",
    "action.primaryHover": "#174b43",
    "action.onPrimary": "#ffffff",
    "status.success": "#297a55",
    "status.warning": "#a56216",
    "radius.control": "3px",
    "radius.panel": "5px",
    "shadow.panel": "0 16px 45px rgba(65, 54, 36, 0.14)",
    "font.display": "Georgia, 'Times New Roman', serif",
    "font.body": "Georgia, 'Times New Roman', serif",
    "motion.fast": "110ms",
    "canvas.ground": "#e6e0d2",
    "canvas.grid": "rgba(38, 36, 31, 0.06)",
    "canvas.accent": "#1f6257",
    "canvas.accentBright": "#2f8f7f",
    "canvas.danger": "#a8341f",
    "canvas.alt": "#a56216",
    "canvas.dim": "#c8c0ad",
    "canvas.ink": "#26241f",
  }),
  skin("high-contrast", "High Contrast", "Strong focus, clear boundaries, minimal effects", {
    ...starship,
    "surface.canvas": "#000000",
    "surface.panel": "#0b0b0b",
    "surface.raised": "#161616",
    "text.primary": "#ffffff",
    "text.muted": "#dedede",
    "border.default": "#ffffff",
    "action.primary": "#ffe500",
    "action.primaryHover": "#ffffff",
    "action.onPrimary": "#000000",
    "status.success": "#62ff8f",
    "status.warning": "#ffe500",
    "radius.control": "0px",
    "radius.panel": "0px",
    "shadow.panel": "0 0 0 2px #ffffff",
    "font.display": "Arial, Helvetica, sans-serif",
    "font.body": "Arial, Helvetica, sans-serif",
    "motion.fast": "0ms",
    "canvas.ground": "#000000",
    "canvas.grid": "rgba(255, 255, 255, 0.14)",
    "canvas.accent": "#ffe500",
    "canvas.accentBright": "#ffffff",
    "canvas.danger": "#ff5b5b",
    "canvas.alt": "#62ff8f",
    "canvas.dim": "#4a4a4a",
    "canvas.ink": "#ffffff",
  }),
];

export const skinsById = Object.freeze(
  Object.fromEntries(builtInSkins.map((entry) => [entry.id, entry])),
);

export const defaultSkin = builtInSkins[0];

export function findSkin(id, fallback = defaultSkin) {
  return skinsById[id] ?? fallback;
}
