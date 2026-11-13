// Five HUDs to start from, one per house the games here come from.
//
// A preset is a whole document, not a theme: it decides which readouts
// exist and where they sit as well as how they look, because "a pinball
// backglass" is a score, a ball count and a bonus, and "a modern shooter"
// is a health bar and an ammo row. The designer's kind switch and slot
// picker turn any of them into any other; these are starting points, and
// the field ids are the ones the site demo feeds.
//
// Every value in here goes through `normalizeHud` on the way out, so a
// preset cannot carry anything a file could not, and the tests hold each
// one to that: a preset normalized twice is the preset.

import { normalizeHud } from "./document.js";

export const HUD_PRESETS = Object.freeze([
  {
    id: "arcade",
    name: "Arcade",
    fields: [
      { id: "score", kind: "number", label: "1UP", slot: "top-left", pad: 6 },
      { id: "hiscore", kind: "number", label: "High score", slot: "top-center", pad: 6 },
      { id: "wave", kind: "number", label: "Wave", slot: "top-right", pad: 2 },
      { id: "lives", kind: "icons", label: "Ships", slot: "bottom-left", icon: "▲", max: 5, showEmpty: false },
      { id: "message", kind: "text", label: "", showLabel: false, slot: "center", size: "large", maxLength: 16 },
    ],
    style: {
      font: "Impact, 'Arial Black', sans-serif",
      labelFont: "Impact, 'Arial Black', sans-serif",
      size: 28,
      labelSize: 13,
      color: "#ffffff",
      labelColor: "#ff5d8f",
      accent: "#ffd166",
      dim: "#2b2f3a",
      low: "#ff5d5d",
      panelAlpha: 0,
      gap: 26,
      inset: 16,
      letterSpacing: 0.06,
      uppercase: true,
      glow: 10,
      iconSize: 18,
    },
    css: "",
  },
  {
    id: "modern",
    name: "Modern",
    fields: [
      { id: "health", kind: "bar", label: "Health", slot: "top-left", full: 100, low: 0.3, readout: "percent" },
      { id: "objective", kind: "text", label: "Objective", slot: "top-center", maxLength: 40 },
      { id: "score", kind: "number", label: "Score", slot: "top-right", group: true },
      { id: "ammo", kind: "icons", label: "Ammo", slot: "bottom-left", icon: "▮", max: 8, overflow: "hide" },
      { id: "time", kind: "time", label: "Time", slot: "bottom-center", format: "mm:ss" },
      { id: "wave", kind: "number", label: "Wave", slot: "bottom-right" },
    ],
    style: {
      font: "Inter, ui-sans-serif, system-ui, sans-serif",
      labelFont: "Inter, ui-sans-serif, system-ui, sans-serif",
      size: 20,
      labelSize: 10,
      color: "#f4f6fb",
      labelColor: "#a9b1c3",
      accent: "#4ade80",
      dim: "#2a3040",
      low: "#f87171",
      panel: "#0b0f1a",
      panelAlpha: 0.55,
      radius: 8,
      padding: 10,
      gap: 14,
      inset: 18,
      letterSpacing: 0.08,
      uppercase: true,
      glow: 0,
      iconSize: 14,
      barWidth: 160,
      barHeight: 8,
    },
    css: "",
  },
  {
    id: "lcd",
    name: "LCD",
    fields: [
      { id: "score", kind: "number", label: "Score", slot: "top-left", pad: 8 },
      { id: "time", kind: "time", label: "Time", slot: "top-right", format: "m:ss.t" },
      { id: "lives", kind: "icons", label: "Lives", slot: "bottom-left", icon: "■", max: 3 },
      { id: "bonus", kind: "number", label: "Bonus", slot: "bottom-right", pad: 4 },
    ],
    style: {
      font: "'Courier New', ui-monospace, monospace",
      labelFont: "'Courier New', ui-monospace, monospace",
      size: 24,
      labelSize: 11,
      color: "#9dff8a",
      labelColor: "#4d8a44",
      accent: "#9dff8a",
      dim: "#1c3a19",
      low: "#ffb347",
      panel: "#061206",
      panelAlpha: 0.85,
      panelBorder: "#2f7a2a",
      borderWidth: 2,
      radius: 2,
      padding: 8,
      gap: 16,
      inset: 14,
      letterSpacing: 0.12,
      uppercase: true,
      glow: 6,
      iconSize: 16,
    },
    css: "",
  },
  {
    id: "backglass",
    name: "Backglass",
    fields: [
      { id: "score", kind: "number", label: "Score", slot: "bottom-center", size: "large", pad: 8 },
      { id: "ball", kind: "icons", label: "Ball", slot: "bottom-left", icon: "●", max: 3 },
      { id: "multiplier", kind: "number", label: "Multiplier", slot: "top-right", suffix: "×" },
      { id: "bonus", kind: "number", label: "Bonus", slot: "bottom-right", group: true },
      { id: "message", kind: "text", label: "", showLabel: false, slot: "center", size: "large", maxLength: 20 },
    ],
    style: {
      font: "Impact, 'Arial Black', sans-serif",
      labelFont: "Georgia, 'Times New Roman', serif",
      size: 34,
      labelSize: 12,
      color: "#ffe08a",
      labelColor: "#c98f2e",
      accent: "#ff7a3d",
      dim: "#5a3a1d",
      low: "#ff5d5d",
      panel: "#1a0b05",
      panelAlpha: 0.7,
      panelBorder: "#ff7a3d",
      borderWidth: 2,
      radius: 12,
      padding: 12,
      gap: 22,
      inset: 20,
      letterSpacing: 0.1,
      uppercase: true,
      glow: 14,
      shadow: 2,
      iconSize: 22,
    },
    // The escape hatch in use: the tokens cannot express a gradient, and a
    // backglass score is nothing without one.
    css: `.hud-field[data-field="score"] .hud-text {
  background: linear-gradient(#fff6d0, #ffb02e 60%, #ff7a3d);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}`,
  },
  {
    id: "platformer",
    name: "Platformer",
    fields: [
      { id: "hearts", kind: "icons", label: "", showLabel: false, slot: "top-left", icon: "♥", max: 3 },
      { id: "coins", kind: "number", label: "", showLabel: false, slot: "top-center", prefix: "◎ ", pad: 2 },
      { id: "time", kind: "time", label: "Time", slot: "top-right", format: "s" },
      { id: "world", kind: "text", label: "", showLabel: false, slot: "bottom-left", maxLength: 16 },
      { id: "message", kind: "text", label: "", showLabel: false, slot: "center", size: "large", maxLength: 16 },
    ],
    style: {
      font: "'Press Start 2P', 'Courier New', monospace",
      labelFont: "'Press Start 2P', 'Courier New', monospace",
      size: 18,
      labelSize: 10,
      color: "#ffffff",
      labelColor: "#ffd7a8",
      accent: "#ff4f6d",
      dim: "#4a2a33",
      low: "#ff5d5d",
      panelAlpha: 0,
      gap: 24,
      inset: 16,
      letterSpacing: 0.05,
      uppercase: true,
      shadow: 3,
      iconSize: 22,
    },
    css: "",
  },
]);

/** The names the designer offers, from the list rather than a copy of it. */
export function hudPresetNames() {
  return HUD_PRESETS.map((preset) => preset.name);
}

/**
 * A fresh, normalized copy of a preset by name or id. An unknown name gives
 * the first preset rather than throwing, the same way `createBurstPreset`
 * does: a stale name in a saved settings blob should open something.
 *
 * @param {string} [name]
 */
export function createHudPreset(name = "Arcade") {
  const wanted = String(name).trim().toLowerCase();
  const preset = HUD_PRESETS.find((entry) => entry.id === wanted || entry.name.toLowerCase() === wanted) ?? HUD_PRESETS[0];
  return normalizeHud(preset);
}
