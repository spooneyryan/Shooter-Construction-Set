// What a top-down world is made of.
//
// Everything here is what a game *says*, and nothing here changes while a
// run is in progress — the same split every genre module in this package
// states at its top, and for the same reason: the world reads it and never
// writes to it, so one authored map can be replayed, raced or rewound
// without being copied first.
//
// **The format's centre is that a room is a rectangle over the tile grid,
// not a different structure.** That one decision is what lets this serve
// both world models Ryan asked for. A Zelda dungeon is many rooms tiling
// the map with doors between them, played under a `roomFlip` camera; a
// free-roaming field is the degenerate case — one room covering
// everything, under `followXY`. Nothing forks, and a map may mix: an
// overworld whose dungeon wing is room-paged is one map with two regions.
//
// Names carry a `TOPDOWN_`/`Topdown` prefix, which began as insurance
// against the module being renamed and is now simply the convention
// (decided 2026-08-30; docs/TOPDOWN.md). It is also what keeps this module
// concatenation-safe beside its siblings; see tests/flat-scope.test.mjs —
// `FEEL_RANGES` collided with `runnjump`'s the first time it ran.

import {
  asBoolean,
  boundedInteger,
  boundedNumber,
  boundedString,
  oneOf,
  uniqueId,
} from "../core/validate.js";
import { normalizeBulletPattern } from "../patterns/patterns.js";

export const TOPDOWN_VERSION = 1;

// -- tiles --------------------------------------------------------------

/** Walkable. */
export const TOPDOWN_FLOOR = 0;
/** Blocks everything, including projectiles. */
export const TOPDOWN_WALL = 1;
/** A hole: blocks bodies, but a projectile or a swing passes over it. */
export const TOPDOWN_PIT = 2;
/** Walkable, slower. */
export const TOPDOWN_WATER = 3;
/** Walkable and it hurts — spikes, lava, a cursed floor. */
export const TOPDOWN_HAZARD = 4;

const TILE_CODES = [TOPDOWN_FLOOR, TOPDOWN_WALL, TOPDOWN_PIT, TOPDOWN_WATER, TOPDOWN_HAZARD];

/** Whether a tile stops a body. Projectiles ask `tileStopsShot` instead. */
export function tileStopsBody(code) {
  return code === TOPDOWN_WALL || code === TOPDOWN_PIT;
}

/** Whether a tile stops a projectile or a swing. A pit does not. */
export function tileStopsShot(code) {
  return code === TOPDOWN_WALL;
}

// -- input --------------------------------------------------------------

/**
 * One seat's frame of intent: two vectors and three buttons.
 *
 * `move` walks and `aim` points, both quantized at the edge through
 * `core/stick` — free for a stick, eight-way for a keyboard, and the
 * horde's twin-stick is simply both at once. A centred `aim` means "no new
 * instruction": the hero keeps facing where they were left, which is the
 * lesson the satellite aim paid for on 2026-08-23.
 *
 * There is no pointer-to-walk and there will not be: click-to-move implies
 * pathfinding, which docs/TOPDOWN.md excludes from version one.
 *
 * @typedef {object} TopdownInput
 * @property {boolean} attack Swing. Rising edge; the swing owns its ticks.
 * @property {boolean} cast Fire the equipped weapon's pattern.
 * @property {boolean} use Doors, switches, pickups underfoot.
 * @property {{x: number, y: number}} move
 * @property {{x: number, y: number}} aim
 */

/** The action names, in wire order — append-only, the `net/input-log` rule. */
export const TOPDOWN_ACTIONS = Object.freeze(["attack", "cast", "use"]);

/** The analogue channels, in wire order. Same append-only rule. */
export const TOPDOWN_STICKS = Object.freeze(["move", "aim"]);

/** @returns {TopdownInput} Nothing held, both sticks centred. */
export function neutralTopdownInput() {
  return { attack: false, cast: false, use: false, move: { x: 0, y: 0 }, aim: { x: 0, y: 0 } };
}

// -- feel ---------------------------------------------------------------

/**
 * Every number that decides how moving and fighting feel. All data, all
 * clamped, and the three presets exist because nobody has ever got combat
 * timing right by reading numbers — flipping the set in one click and
 * feeling the difference is the tool that works.
 *
 * Units are pixels and seconds, except `*Ticks`, which are fixed steps —
 * an invulnerability window measured in seconds would change length with
 * the step rate, and i-frames are exactly the thing that must not.
 */
export const TOPDOWN_FEEL_PRESETS = Object.freeze({
  classic: {
    speed: 90, waterSpeed: 45, knockbackSpeed: 260, knockbackTicks: 8,
    invulnTicks: 48, hazardDamage: 1, hazardTicks: 30,
    swingDamage: 1, swingRadius: 26, swingHalfAngle: 0.9, swingTicks: 10,
    swingCooldown: 18, swingKnockback: 200,
  },
  brisk: {
    speed: 120, waterSpeed: 70, knockbackSpeed: 300, knockbackTicks: 6,
    invulnTicks: 36, hazardDamage: 1, hazardTicks: 24,
    swingDamage: 1, swingRadius: 30, swingHalfAngle: 1.1, swingTicks: 8,
    swingCooldown: 12, swingKnockback: 240,
  },
  heavy: {
    speed: 74, waterSpeed: 36, knockbackSpeed: 220, knockbackTicks: 12,
    invulnTicks: 60, hazardDamage: 2, hazardTicks: 36,
    swingDamage: 2, swingRadius: 30, swingHalfAngle: 0.7, swingTicks: 14,
    swingCooldown: 26, swingKnockback: 300,
  },
});

const TOPDOWN_FEEL_RANGES = {
  speed: [8, 600], waterSpeed: [4, 600], knockbackSpeed: [0, 1200],
  knockbackTicks: [0, 240], invulnTicks: [0, 600], hazardDamage: [0, 99],
  hazardTicks: [1, 600], swingDamage: [0, 99], swingRadius: [1, 400],
  swingHalfAngle: [0.05, 3.15], swingTicks: [1, 240], swingCooldown: [0, 600],
  swingKnockback: [0, 1200],
};

const INTEGER_FEEL = new Set([
  "knockbackTicks", "invulnTicks", "hazardDamage", "hazardTicks",
  "swingDamage", "swingTicks", "swingCooldown",
]);

/** @param {any} [input] @param {string} [preset] */
export function normalizeTopdownFeel(input, preset = "classic") {
  const base = TOPDOWN_FEEL_PRESETS[preset] ?? TOPDOWN_FEEL_PRESETS.classic;
  const raw = input && typeof input === "object" ? input : {};
  const feel = {};
  for (const [name, fallback] of Object.entries(base)) {
    const [low, high] = TOPDOWN_FEEL_RANGES[name];
    feel[name] = INTEGER_FEEL.has(name)
      ? boundedInteger(raw[name], fallback, low, high)
      : boundedNumber(raw[name], fallback, low, high);
  }
  return feel;
}

// -- definitions --------------------------------------------------------

export const TOPDOWN_ACTOR_KINDS = Object.freeze(["enemy", "prop", "pickup"]);
export const TOPDOWN_PICKUPS = Object.freeze(["heart", "maxHeart", "key", "coin", "damage", "rate", "speed"]);
export const TOPDOWN_LOCKS = Object.freeze(["none", "key", "boss", "switch"]);
export const TOPDOWN_GATES = Object.freeze(["none", "clear"]);
export const TOPDOWN_FLAVOURS = Object.freeze(["quest", "crawl", "horde"]);
export const TOPDOWN_VICTORIES = Object.freeze(["clearAll", "reachExit", "waves"]);
export const TOPDOWN_CAMERAS = Object.freeze(["roomFlip", "followXY", "fixed"]);

/**
 * An actor definition: what a skeleton IS, once, referenced by every
 * skeleton placed. The behaviour is a registry name and its parameters,
 * never code — nothing in a document is executable.
 *
 * @param {any} [input]
 */
export function normalizeTopdownActor(input = {}) {
  const kind = oneOf(input.kind, [...TOPDOWN_ACTOR_KINDS], "enemy");
  return {
    id: boundedString(input.id, uniqueId("actor"), 60),
    name: boundedString(input.name, "Unnamed", 60),
    kind,
    w: boundedInteger(input.w, 12, 2, 256),
    h: boundedInteger(input.h, 12, 2, 256),
    health: boundedInteger(input.health, kind === "enemy" ? 2 : 1, 1, 9999),
    speed: boundedNumber(input.speed, kind === "enemy" ? 40 : 0, 0, 600),
    touchDamage: boundedInteger(input.touchDamage, kind === "enemy" ? 1 : 0, 0, 99),
    /** Registry name; `behaviorParams` is its data. Unknown names resolve
     *  to `still` at run time rather than being rejected here, so a game
     *  that registers its own behaviours can author them before the code
     *  that implements them exists. */
    behavior: boundedString(input.behavior, kind === "enemy" ? "chase" : "still", 40),
    behaviorParams: input.behaviorParams && typeof input.behaviorParams === "object"
      ? { ...input.behaviorParams }
      : {},
    /** A `patterns` document id, for anything that shoots. */
    patternId: boundedString(input.patternId, "", 60),
    /** What it leaves behind: a pickup kind, or "" for nothing. */
    drop: input.drop ? oneOf(input.drop, [...TOPDOWN_PICKUPS], "heart") : "",
    dropChance: boundedNumber(input.dropChance, 0.25, 0, 1),
    points: boundedInteger(input.points, kind === "enemy" ? 10 : 0, 0, 1e6),
    /** Immovable scenery: a pillar, a chest, a boulder. */
    solid: asBoolean(input.solid, kind === "prop"),
  };
}

/** The hero, as settings rather than code. */
export function defaultTopdownHero() {
  return {
    w: 12, h: 12, maxHearts: 3, hearts: 3,
    /** Melee is on by default; `patternId` arms the ranged attack. */
    melee: true,
    patternId: "",
    /** Ranged shots cost nothing in v1; a mana system is not in scope. */
    lives: 3,
  };
}

/** @param {any} [input] */
export function normalizeTopdownHero(input = {}) {
  const base = defaultTopdownHero();
  const maxHearts = boundedInteger(input.maxHearts, base.maxHearts, 1, 99);
  return {
    w: boundedInteger(input.w, base.w, 2, 256),
    h: boundedInteger(input.h, base.h, 2, 256),
    maxHearts,
    hearts: boundedInteger(input.hearts, maxHearts, 1, maxHearts),
    melee: asBoolean(input.melee, base.melee),
    patternId: boundedString(input.patternId, base.patternId, 60),
    lives: boundedInteger(input.lives, base.lives, 1, 99),
  };
}

// -- rooms, doors and placements ----------------------------------------

/**
 * A room: a rectangle in TILE space with an id and a gate rule. Not a
 * container — an actor is not "in" a room in the document, it stands
 * somewhere, and the room it is in follows from where that is.
 *
 * @param {any} [input] @param {number} cols @param {number} rows
 */
export function normalizeTopdownRoom(input = {}, cols = 1, rows = 1) {
  const col = boundedInteger(input.col, 0, 0, Math.max(0, cols - 1));
  const row = boundedInteger(input.row, 0, 0, Math.max(0, rows - 1));
  return {
    id: boundedString(input.id, uniqueId("room"), 60),
    col,
    row,
    cols: boundedInteger(input.cols, cols - col, 1, cols - col),
    rows: boundedInteger(input.rows, rows - row, 1, rows - row),
    /** `clear` seals the doors until the room's enemies are down. */
    gate: oneOf(input.gate, [...TOPDOWN_GATES], "none"),
  };
}

/**
 * A door: a tile the hero may pass through, once whatever locks it is
 * answered. `to` names a room; an empty `to` is a door onto the map's
 * exit, which is what `reachExit` reads.
 *
 * @param {any} [input] @param {number} cols @param {number} rows
 */
export function normalizeTopdownDoor(input = {}, cols = 1, rows = 1) {
  return {
    id: boundedString(input.id, uniqueId("door"), 60),
    col: boundedInteger(input.col, 0, 0, Math.max(0, cols - 1)),
    row: boundedInteger(input.row, 0, 0, Math.max(0, rows - 1)),
    to: boundedString(input.to, "", 60),
    lock: oneOf(input.lock, [...TOPDOWN_LOCKS], "none"),
    /** For `lock: "switch"`, which switch id opens it. */
    switchId: boundedString(input.switchId, "", 60),
    /** Doors start shut only when they lock or gate something. */
    open: asBoolean(input.open, false),
  };
}

/** A placed instance: a definition id and where it stands. */
export function normalizeTopdownPlacement(input = {}, cols = 1, rows = 1, tile = 16) {
  const spanX = Math.max(1, cols * tile - 1);
  const spanY = Math.max(1, rows * tile - 1);
  return {
    id: boundedString(input.id, uniqueId("at"), 60),
    defId: boundedString(input.defId, "", 60),
    x: boundedNumber(input.x, 0, 0, spanX),
    y: boundedNumber(input.y, 0, 0, spanY),
    /** Which pickup a `pickup` placement gives; ignored for other kinds. */
    pickup: input.pickup ? oneOf(input.pickup, [...TOPDOWN_PICKUPS], "heart") : "",
    /** A switch's id, so a door can name it. */
    switchId: boundedString(input.switchId, "", 60),
  };
}

// -- the map ------------------------------------------------------------

/** The classic starting room: a bordered chamber, one room, no doors. */
export function emptyTopdownMap(name = "Untitled Map") {
  const cols = 20;
  const rows = 15;
  const tiles = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const border = col === 0 || row === 0 || col === cols - 1 || row === rows - 1;
      tiles.push(border ? TOPDOWN_WALL : TOPDOWN_FLOOR);
    }
  }
  return {
    id: "map-1",
    name: boundedString(name, "Untitled Map", 80),
    cols,
    rows,
    tile: 16,
    tiles,
    // The blank carries its one room rather than leaning on the repair
    // below: a starting document should already be a legal one, so
    // `normalize(empty()) === empty()` holds and a test can say so.
    rooms: [{ id: "room-all", col: 0, row: 0, cols, rows, gate: "none" }],
    doors: [],
    actors: [],
    items: [],
    spawn: { x: 32, y: 32 },
    camera: { mode: "followXY", viewCols: 20, viewRows: 15, deadZoneW: 48, deadZoneH: 40 },
  };
}

/**
 * Clamp a map, trusting nothing, and repair it into something playable:
 * the border becomes wall, unknown tile codes become floor, and **a map
 * with no rooms gains one covering everything** — which is what makes a
 * free-roaming field the same document as a dungeon rather than a
 * special case downstream.
 *
 * @param {any} [input]
 */
export function normalizeTopdownMap(input = {}) {
  const blank = emptyTopdownMap();
  const cols = boundedInteger(input.cols, blank.cols, 4, 400);
  const rows = boundedInteger(input.rows, blank.rows, 4, 400);
  const tile = boundedInteger(input.tile, blank.tile, 8, 64);
  const raw = Array.isArray(input.tiles) ? input.tiles : [];

  const tiles = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const border = col === 0 || row === 0 || col === cols - 1 || row === rows - 1;
      tiles.push(border ? TOPDOWN_WALL : oneOf(raw[row * cols + col], TILE_CODES, TOPDOWN_FLOOR));
    }
  }

  const rooms = (Array.isArray(input.rooms) ? input.rooms : [])
    .slice(0, 400)
    .map((room) => normalizeTopdownRoom(room, cols, rows));
  // The degenerate room is the free-roaming field. One rule, both models.
  if (rooms.length === 0) {
    rooms.push(normalizeTopdownRoom({ id: "room-all", col: 0, row: 0, cols, rows }, cols, rows));
  }

  const rawCamera = input.camera && typeof input.camera === "object" ? input.camera : {};
  return {
    id: boundedString(input.id, blank.id, 60),
    name: boundedString(input.name, blank.name, 80),
    cols,
    rows,
    tile,
    tiles,
    rooms,
    doors: (Array.isArray(input.doors) ? input.doors : [])
      .slice(0, 400)
      .map((door) => normalizeTopdownDoor(door, cols, rows)),
    actors: (Array.isArray(input.actors) ? input.actors : [])
      .slice(0, 600)
      .map((placement) => normalizeTopdownPlacement(placement, cols, rows, tile)),
    items: (Array.isArray(input.items) ? input.items : [])
      .slice(0, 600)
      .map((placement) => normalizeTopdownPlacement(placement, cols, rows, tile)),
    spawn: {
      x: boundedNumber(input.spawn?.x, tile * 2, 0, cols * tile),
      y: boundedNumber(input.spawn?.y, tile * 2, 0, rows * tile),
    },
    camera: {
      mode: oneOf(rawCamera.mode, [...TOPDOWN_CAMERAS], "followXY"),
      viewCols: boundedInteger(rawCamera.viewCols, Math.min(20, cols), 4, cols),
      viewRows: boundedInteger(rawCamera.viewRows, Math.min(15, rows), 4, rows),
      deadZoneW: boundedNumber(rawCamera.deadZoneW, 48, 0, 4096),
      deadZoneH: boundedNumber(rawCamera.deadZoneH, 40, 0, 4096),
    },
  };
}

// -- waves --------------------------------------------------------------

/**
 * A horde's spawn table. Rolled with the run's own dice, so a seed
 * reproduces a night exactly — which is what makes "beat my wave nine"
 * a shareable claim rather than a boast.
 *
 * @param {any} [input]
 */
export function normalizeTopdownWaves(input = {}) {
  const raw = input && typeof input === "object" ? input : {};
  return {
    /** Steps between waves. */
    everyTicks: boundedInteger(raw.everyTicks, 420, 30, 100000),
    /** How many spawn in wave one; each wave adds `growth`. */
    count: boundedInteger(raw.count, 3, 1, 200),
    growth: boundedNumber(raw.growth, 1.5, 0, 50),
    /** Never more than this alive at once — the entity-scale decision. */
    alive: boundedInteger(raw.alive, 60, 1, 1000),
    /** How many waves win the run; 0 means endless. */
    waves: boundedInteger(raw.waves, 0, 0, 9999),
    /** Weighted actor definition ids. */
    table: (Array.isArray(raw.table) ? raw.table : [])
      .slice(0, 60)
      .map((row) => ({
        defId: boundedString(row?.defId, "", 60),
        weight: boundedNumber(row?.weight, 1, 0, 1e6),
      })),
  };
}

// -- the world ----------------------------------------------------------

/** @returns {object} A blank world: one map, one hero, no enemies. */
export function emptyTopdownWorld(name = "Untitled World") {
  return {
    version: TOPDOWN_VERSION,
    name: boundedString(name, "Untitled World", 80),
    flavour: "quest",
    hero: defaultTopdownHero(),
    feel: normalizeTopdownFeel({}),
    actors: [],
    /** Spell and weapon documents, by id — `patternId` on a hero or an
     *  actor names one. They belong to the WORLD rather than to the run
     *  because a saved game that lost its spells is not the game that was
     *  saved; the crawl flavour found that the hard way. */
    patterns: [],
    maps: [emptyTopdownMap("First Room")],
    rules: {
      victory: "clearAll",
      seed: 1,
      waves: normalizeTopdownWaves({}),
    },
  };
}

/**
 * Clamp a world, trusting nothing. Idempotent, and `createRun` runs it on
 * whatever it is given — a bare JSON.parse is a legal input, just not a
 * trusted one.
 *
 * @param {any} [input]
 */
export function normalizeTopdownWorld(input = {}) {
  const blank = emptyTopdownWorld();
  const rawRules = input.rules && typeof input.rules === "object" ? input.rules : {};
  const maps = (Array.isArray(input.maps) ? input.maps : [])
    .slice(0, 100)
    .map((map) => normalizeTopdownMap(map));
  return {
    version: TOPDOWN_VERSION,
    name: boundedString(input.name, blank.name, 80),
    flavour: oneOf(input.flavour, [...TOPDOWN_FLAVOURS], "quest"),
    hero: normalizeTopdownHero(input.hero),
    feel: normalizeTopdownFeel(input.feel, typeof input.feelPreset === "string" ? input.feelPreset : "classic"),
    actors: (Array.isArray(input.actors) ? input.actors : [])
      .slice(0, 400)
      .map((actor) => normalizeTopdownActor(actor)),
    patterns: (Array.isArray(input.patterns) ? input.patterns : [])
      .slice(0, 100)
      .map((pattern) => normalizeBulletPattern(pattern)),
    maps: maps.length > 0 ? maps : blank.maps,
    rules: {
      victory: oneOf(rawRules.victory, [...TOPDOWN_VICTORIES], "clearAll"),
      /** The run's dice. One number reproduces a procedural night. */
      seed: boundedInteger(rawRules.seed, 1, -2147483648, 2147483647),
      waves: normalizeTopdownWaves(rawRules.waves),
    },
  };
}
