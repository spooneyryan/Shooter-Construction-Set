// The three proof games.
//
// docs/TOPDOWN.md defines "done" as three playable worlds rather than a
// feature list, for the reason PLATFORMER.md gave first: a feature list is
// a thing you can finish while the result is unplayable. They are here, as
// data, because that is the claim being tested — **one module, three
// flavours, differing in data rather than in kind**. If a flavour needed
// engine work these functions could not exist, and the bet would have been
// wrong.
//
//   sampleKeepOfKeys   the Zelda shape — screens, a locked vault, a gate
//   sampleTheDeep      the Diablo shape — seeded floors, a spell, stairs
//   sampleLastStand    the horde — one arena, waves, twin-stick, upgrades
//
// Each returns a raw world DOCUMENT: plain data for `createRun` to
// normalize like anything an author typed. Nothing here is privileged, and
// a game may take one as a starting point and edit it into its own.

import { createPatternPreset } from "../patterns/patterns.js";
import { TOPDOWN_FLOOR, TOPDOWN_HAZARD, TOPDOWN_WALL } from "./contract.js";
import { generateTopdownFloor } from "./generate.js";

/** The bestiary the three samples draw from. */
function sampleActors() {
  return [
    {
      id: "slime", name: "Slime", kind: "enemy", w: 12, h: 12,
      health: 2, speed: 34, touchDamage: 1,
      behavior: "chase", behaviorParams: { sight: 140 },
      drop: "heart", dropChance: 0.35, points: 10,
    },
    {
      id: "guard", name: "Guard", kind: "enemy", w: 14, h: 14,
      health: 3, speed: 46, touchDamage: 1,
      behavior: "charge", behaviorParams: { windup: 36, dash: 22, rest: 40, boost: 3 },
      drop: "coin", dropChance: 0.8, points: 25,
    },
    {
      id: "wisp", name: "Wisp", kind: "enemy", w: 10, h: 10,
      health: 1, speed: 52, touchDamage: 1,
      behavior: "orbit", behaviorParams: { range: 70 },
      drop: "coin", dropChance: 0.5, points: 15,
    },
    {
      id: "sentry", name: "Sentry", kind: "enemy", w: 14, h: 14,
      health: 4, speed: 0, touchDamage: 1,
      behavior: "turret", behaviorParams: { sight: 220 },
      drop: "heart", dropChance: 0.4, points: 30,
    },
    {
      id: "swarmer", name: "Swarmer", kind: "enemy", w: 10, h: 10,
      health: 1, speed: 62, touchDamage: 1,
      behavior: "swarm", drop: "", points: 5,
    },
    {
      id: "brute", name: "Brute", kind: "enemy", w: 18, h: 18,
      health: 8, speed: 30, touchDamage: 2,
      behavior: "chase", behaviorParams: { sight: 260 },
      drop: "damage", dropChance: 1, points: 100,
    },
    { id: "statue", name: "Statue", kind: "prop", w: 16, h: 16, solid: true, behavior: "still", touchDamage: 0 },
  ];
}

/**
 * **Keep of Keys** — the Zelda shape. Two screens over one grid, a locked
 * vault, and a room whose doors seal until it is cleared. The camera pages
 * screen by screen; the rooms are what it pages between.
 */
export function sampleKeepOfKeys() {
  const cols = 40;
  const rows = 15;
  const tiles = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const border = col === 0 || row === 0 || col === cols - 1 || row === rows - 1;
      const divide = col === 20 && row !== 7;
      tiles.push(border || divide ? TOPDOWN_WALL : TOPDOWN_FLOOR);
    }
  }
  for (let col = 6; col < 9; col += 1) tiles[10 * cols + col] = TOPDOWN_HAZARD;

  return {
    name: "Keep of Keys",
    flavour: "quest",
    hero: { maxHearts: 3, hearts: 3, lives: 3, melee: true },
    actors: sampleActors(),
    maps: [{
      id: "keep",
      name: "The Keep",
      cols,
      rows,
      tile: 16,
      tiles,
      rooms: [
        { id: "hall", col: 0, row: 0, cols: 20, rows, gate: "none" },
        { id: "vault", col: 20, row: 0, cols: 20, rows, gate: "clear" },
      ],
      doors: [{ id: "vault-door", col: 20, row: 7, to: "vault", lock: "key" }],
      camera: { mode: "roomFlip", viewCols: 20, viewRows: rows, deadZoneW: 48, deadZoneH: 40 },
      spawn: { x: 40, y: 112 },
      actors: [
        { defId: "slime", x: 150, y: 60 },
        { defId: "slime", x: 210, y: 170 },
        { defId: "statue", x: 120, y: 120 },
        { defId: "guard", x: 470, y: 100 },
        { defId: "guard", x: 540, y: 160 },
      ],
      items: [
        { pickup: "key", x: 260, y: 60 },
        { pickup: "heart", x: 90, y: 190 },
      ],
    }],
    rules: { victory: "clearAll", seed: 20260830 },
  };
}

/**
 * **The Deep** — the Diablo shape. Two procedurally generated floors under
 * a following camera, a wand that throws a real `patterns` spell, enemies
 * that drop what they drop, and a stairway down that the second floor's
 * exit ends the run on.
 *
 * The whole dungeon is one integer: change the seed and it is a different
 * night, on every machine that opens the document.
 *
 * @param {number} [seed]
 */
export function sampleTheDeep(seed = 424242) {
  const wand = createPatternPreset("Spiral");
  wand.id = "wand";
  wand.name = "Wand";
  const enemies = [
    { defId: "slime", weight: 4 },
    { defId: "wisp", weight: 2 },
    { defId: "sentry", weight: 1 },
    { defId: "brute", weight: 1 },
  ];
  const items = [
    { pickup: "heart", weight: 3 },
    { pickup: "coin", weight: 3 },
    { pickup: "damage", weight: 1 },
    { pickup: "rate", weight: 1 },
  ];
  return {
    name: "The Deep",
    flavour: "crawl",
    hero: { maxHearts: 4, hearts: 4, lives: 2, melee: true, patternId: "wand" },
    feel: { speed: 100, swingRadius: 24 },
    actors: sampleActors(),
    patterns: [wand],
    maps: [
      generateTopdownFloor({
        seed, cols: 48, rows: 32, enemies, items, density: 2,
        id: "deep-1", name: "The Deep, first floor",
      }),
      generateTopdownFloor({
        // The second floor is a different roll of the same run's dice, so
        // one seed still describes the whole descent.
        seed: seed + 1, cols: 56, rows: 36, enemies, items, density: 3, puddles: 5,
        id: "deep-2", name: "The Deep, second floor",
      }),
    ],
    // The stairs are a door onto nothing, which is what `reachExit` reads;
    // clearing the last map's stairs wins the run.
    rules: { victory: "reachExit", seed },
  };
}

/**
 * **Last Stand** — the horde. One open arena, waves from a seeded spawn
 * table that grows, twin-stick play (walk with one hand, aim with the
 * other), and upgrades that drop and stack. Ten waves wins.
 *
 * @param {number} [seed]
 */
export function sampleLastStand(seed = 7777) {
  const cols = 32;
  const rows = 24;
  const tiles = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const border = col === 0 || row === 0 || col === cols - 1 || row === rows - 1;
      // Four pillars, so a horde has something to break around and a
      // player has something to kite behind.
      const pillar = (col === 8 || col === 23) && (row === 7 || row === 16);
      tiles.push(border || pillar ? TOPDOWN_WALL : TOPDOWN_FLOOR);
    }
  }
  return {
    name: "Last Stand",
    flavour: "horde",
    hero: { maxHearts: 5, hearts: 5, lives: 1, melee: true },
    feel: { speed: 110, swingRadius: 30, swingCooldown: 12, invulnTicks: 40 },
    actors: sampleActors(),
    maps: [{
      id: "arena",
      name: "The Arena",
      cols,
      rows,
      tile: 16,
      tiles,
      // No rooms authored: the free-field case, and the whole arena is
      // where waves may spawn.
      rooms: [],
      doors: [],
      camera: { mode: "followXY", viewCols: 20, viewRows: 15, deadZoneW: 56, deadZoneH: 44 },
      spawn: { x: 250, y: 190 },
      actors: [],
      items: [{ pickup: "damage", x: 130, y: 120 }, { pickup: "speed", x: 370, y: 260 }],
    }],
    rules: {
      victory: "waves",
      seed,
      waves: {
        everyTicks: 360,
        count: 4,
        growth: 2,
        alive: 40,
        waves: 10,
        table: [
          { defId: "swarmer", weight: 6 },
          { defId: "slime", weight: 3 },
          { defId: "guard", weight: 2 },
          { defId: "brute", weight: 1 },
        ],
      },
    },
  };
}

/** All three, for a menu that wants to list them. */
export function topdownSamples() {
  return [
    { id: "keep-of-keys", label: "Keep of Keys", flavour: "quest", build: sampleKeepOfKeys },
    { id: "the-deep", label: "The Deep", flavour: "crawl", build: sampleTheDeep },
    { id: "last-stand", label: "Last Stand", flavour: "horde", build: sampleLastStand },
  ];
}
