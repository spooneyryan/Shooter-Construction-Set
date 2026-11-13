// What an explosion is made of.
//
// The `sfx` designer's architecture, one medium over: a document plus pure
// arithmetic — params in, frames out — with the same document format, the
// same presets-and-sliders shape, and the same promise that the thing a
// designer previews is bit-for-bit the thing a game draws.
//
// **This is presentation, and that is a licence rather than an
// oversight.** The house rule (AGENTS.md) is that particles, shake and
// sparks live outside the simulation and may differ between two players.
// So nothing here is bound by the determinism the genre modules are, and
// a game may fire a burst inside a rollback without corrupting anything.
// The randomness is seeded anyway, for two reasons that have nothing to do
// with netcode: a designer must be able to preview the burst a player will
// see, and a baked sprite sheet needs a stable cache key.
//
// `burst` is not a new word. `runnjump`'s reaction table has listed a
// `burst` effect since it was written, with nothing behind it; this is
// what was missing.

import {
  boundedInteger,
  boundedNumber,
  boundedString,
  hexColor,
  oneOf,
  uniqueId,
} from "../core/validate.js";

export const BURST_VERSION = 1;

/**
 * What a layer's particles look like. The shape is drawn by
 * `burst/draw`; nothing here knows a canvas.
 *
 * `spark`   a bright dot that fades — the fast, thin stuff
 * `smoke`   a soft blob that grows and fades
 * `shard`   an oriented sliver that spins — debris
 * `ring`    an expanding outline; one per layer, not `count` of them
 * `flash`   a filled disc at the origin, gone in a few frames
 */
export const BURST_LAYER_KINDS = Object.freeze(["spark", "smoke", "shard", "ring", "flash"]);

/** @param {any} [input] */
export function normalizeBurstLayer(input = {}) {
  const kind = oneOf(input.kind, [...BURST_LAYER_KINDS], "spark");
  return {
    id: boundedString(input.id, uniqueId("layer"), 60),
    kind,
    /** A ring and a flash are one thing each, whatever the count says. */
    count: boundedInteger(input.count, kind === "ring" || kind === "flash" ? 1 : 24, 1, 400),
    /** Pixels per second, and how much each particle may differ. */
    speed: boundedNumber(input.speed, kind === "smoke" ? 40 : 120, 0, 4000),
    speedVary: boundedNumber(input.speedVary, 0.4, 0, 1),
    /** Which way, and how wide. A full circle is the default. */
    angle: boundedNumber(input.angle, 0, -6.3, 6.3),
    spread: boundedNumber(input.spread, 6.2832, 0, 6.2832),
    /** Downward pull and air resistance, both px/s². */
    gravity: boundedNumber(input.gravity, kind === "smoke" ? -30 : 240, -4000, 4000),
    drag: boundedNumber(input.drag, 1.6, 0, 20),
    /** Radius in pixels, start and end; a shard reads it as length. */
    size: boundedNumber(input.size, kind === "smoke" ? 7 : 2.5, 0.2, 200),
    sizeEnd: boundedNumber(input.sizeEnd, kind === "smoke" ? 16 : 0.4, 0, 400),
    /** Seconds, and the stagger across the layer's particles. */
    life: boundedNumber(input.life, 0.55, 0.02, 8),
    lifeVary: boundedNumber(input.lifeVary, 0.35, 0, 1),
    delay: boundedNumber(input.delay, 0, 0, 8),
    /** Radians per second, for shards. */
    spin: boundedNumber(input.spin, kind === "shard" ? 8 : 0, -60, 60),
    /** The colour ramp a particle walks as it ages. */
    colorFrom: hexColor(input.colorFrom, kind === "smoke" ? "#6b6f7a" : "#ffe28a"),
    colorTo: hexColor(input.colorTo, kind === "smoke" ? "#20242c" : "#d95d45"),
    /** How much of its life is spent at full opacity before fading. */
    hold: boundedNumber(input.hold, 0.25, 0, 1),
  };
}

/**
 * The whole document. `palette` is the pixel-art half's other knob: bake
 * with it and every colour snaps to the nearest entry, which is what makes
 * a smooth gradient read as era art rather than as a blurry photograph.
 *
 * @param {string} [name]
 */
export function emptyBurst(name = "Untitled Burst") {
  return {
    version: BURST_VERSION,
    id: "burst-1",
    name: boundedString(name, "Untitled Burst", 80),
    /** Reproducibility for the preview and the bake, not for the wire. */
    seed: 1,
    layers: [normalizeBurstLayer({ kind: "flash" }), normalizeBurstLayer({ kind: "spark" })],
    palette: ["#ffffff", "#ffe28a", "#ff9d4d", "#d95d45", "#7a2f2a", "#2b2b33"],
    /** A hint a game may read for camera shake; nothing here shakes. */
    shake: 4,
    /** How far from the origin the art may reach, for the baked frame size. */
    reach: 48,
  };
}

/** @param {any} [input] */
export function normalizeBurst(input = {}) {
  const blank = emptyBurst();
  const layers = (Array.isArray(input.layers) ? input.layers : [])
    .slice(0, 12)
    .map((layer) => normalizeBurstLayer(layer));
  const palette = (Array.isArray(input.palette) ? input.palette : [])
    .slice(0, 32)
    .map((entry) => hexColor(entry, "#ffffff"));
  return {
    version: BURST_VERSION,
    id: boundedString(input.id, blank.id, 60),
    name: boundedString(input.name, blank.name, 80),
    seed: boundedInteger(input.seed, 1, -2147483648, 2147483647),
    layers: layers.length > 0 ? layers : blank.layers,
    palette: palette.length > 0 ? palette : blank.palette,
    shake: boundedNumber(input.shake, blank.shake, 0, 200),
    reach: boundedNumber(input.reach, blank.reach, 4, 1024),
  };
}

/**
 * The presets, which exist for the reason the sfx ones do: nobody has ever
 * got an explosion right by reading numbers, and hearing — or here seeing —
 * five of them next to each other is the tool that works.
 */
export const BURST_PRESETS = Object.freeze({
  Blast: {
    name: "Blast",
    seed: 7,
    reach: 60,
    shake: 8,
    layers: [
      { kind: "flash", size: 22, sizeEnd: 2, life: 0.12, colorFrom: "#ffffff", colorTo: "#ffe28a" },
      { kind: "ring", size: 6, sizeEnd: 52, life: 0.34, colorFrom: "#ffe28a", colorTo: "#d95d45" },
      { kind: "spark", count: 34, speed: 220, life: 0.5, size: 3, sizeEnd: 0.5, colorFrom: "#fff3c4", colorTo: "#d95d45" },
      { kind: "smoke", count: 14, speed: 46, life: 0.9, size: 7, sizeEnd: 20, colorFrom: "#7c6a5e", colorTo: "#22242b" },
    ],
  },
  Puff: {
    name: "Puff",
    seed: 21,
    reach: 34,
    shake: 1,
    layers: [
      { kind: "smoke", count: 12, speed: 34, gravity: -26, life: 0.8, size: 5, sizeEnd: 15, colorFrom: "#b9c8dd", colorTo: "#2b3240" },
    ],
  },
  Sparkle: {
    name: "Sparkle",
    seed: 99,
    reach: 40,
    shake: 0,
    layers: [
      { kind: "spark", count: 26, speed: 150, gravity: 40, drag: 2.4, life: 0.7, size: 2, sizeEnd: 0.3, colorFrom: "#ffffff", colorTo: "#65d6c3" },
    ],
  },
  Shockwave: {
    name: "Shockwave",
    seed: 4,
    reach: 90,
    shake: 12,
    layers: [
      { kind: "ring", size: 4, sizeEnd: 86, life: 0.45, colorFrom: "#ffffff", colorTo: "#42f5ec" },
      { kind: "ring", size: 2, sizeEnd: 58, life: 0.3, delay: 0.08, colorFrom: "#9fe0f2", colorTo: "#1b3a5c" },
    ],
  },
  Debris: {
    name: "Debris",
    seed: 55,
    reach: 72,
    shake: 6,
    layers: [
      { kind: "shard", count: 18, speed: 180, gravity: 520, drag: 0.6, life: 1.1, size: 5, sizeEnd: 4, spin: 12, colorFrom: "#8a5a33", colorTo: "#4a3220" },
      { kind: "smoke", count: 8, speed: 40, life: 0.7, size: 5, sizeEnd: 13, colorFrom: "#6b6f7a", colorTo: "#20242c" },
    ],
  },
});

/**
 * One of the presets as a fresh document. Unknown names give the first,
 * rather than throwing: a document naming a preset a later version renamed
 * should still open.
 *
 * @param {string} [name]
 */
export function createBurstPreset(name = "Blast") {
  const preset = BURST_PRESETS[name] ?? BURST_PRESETS.Blast;
  return normalizeBurst({ ...emptyBurst(preset.name), ...preset, id: `burst-${preset.name.toLowerCase()}` });
}

/** Every preset name, for a designer's dropdown. */
export function burstPresetNames() {
  return Object.keys(BURST_PRESETS);
}

/**
 * How long the whole burst lasts: the slowest layer's delay plus its
 * longest possible life. A bake needs this to know how many frames to
 * make, and a game needs it to know when to stop drawing.
 *
 * @param {object} burst
 */
export function burstDuration(burst) {
  let longest = 0;
  for (const layer of burst.layers) {
    const life = layer.life * (1 + layer.lifeVary);
    const total = layer.delay + life;
    if (total > longest) longest = total;
  }
  return longest;
}
