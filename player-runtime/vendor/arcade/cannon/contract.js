// What a cannon level is made of.
//
// The genre layer over `../physics`: artillery versus arrangement. A level
// says where the cannons stand, what the tower is built from, which blocks
// are the targets, and how many shots the round allows. Everything here is
// what a level *says*, and nothing here changes while a run is in progress —
// the same split `shmup` and `runnjump` state at their tops, and for the
// same reason: the world reads it and never writes to it, which is what lets
// one authored level be replayed or raced without being copied first.
//
// Materials are the genre's vocabulary. A block's material decides how the
// engine treats it (density, friction, restitution) and how the game does
// (how much accumulated impulse it absorbs before breaking, what it scores,
// whether it detonates instead). The engine reports every first-touch hit
// with its impulse; the strength numbers here are calibrated against that
// scale and are level-overridable data, because breakage thresholds are
// tuning, not arithmetic.

import {
  asBoolean,
  boundedInteger,
  boundedNumber,
  boundedString,
  oneOf,
} from "../core/validate.js";

export const CANNON_VERSION = 1;

/**
 * One seat's frame of intent: a vector and a button.
 *
 * `aim` is direction AND power in one stick — the angle is where the barrel
 * points (clamped to the cannon's arc by the world), and the magnitude
 * (0..1) spans the cannon's `minPower..maxPower`. A centred `aim` means "no
 * new instruction", NOT "point at nothing": the barrel and the charge stay
 * where they were left, the lesson the satellite aim taught on 2026-08-23.
 *
 * Both fields are quantized at the edge (`core/stick`), never raw off the
 * hardware, so a frame compares exactly, records exactly, and agrees
 * between two machines. An unquantized float here fails as a desync rather
 * than as an error.
 *
 * @typedef {object} CannonInput
 * @property {boolean} fire Fire on the rising edge, if it is this seat's
 *           turn, the seat has shots left, and no shot is still in flight.
 * @property {{x: number, y: number}} aim Direction and power.
 */

/**
 * The action names, in wire order — append-only, the `net/input-log` rule.
 */
export const CANNON_ACTIONS = Object.freeze(["fire"]);

/** The analogue channels, in wire order. Same append-only rule. */
export const CANNON_STICKS = Object.freeze(["aim"]);

/** @returns {CannonInput} Nothing held, the stick centred. */
export function neutralCannonInput() {
  return { fire: false, aim: { x: 0, y: 0 } };
}

/**
 * @typedef {object} CannonMaterial
 * @property {number} density Mass per area, the engine's unit.
 * @property {number} friction 0..2.
 * @property {number} restitution 0..1.
 * @property {number | null} strength Accumulated first-touch impulse a block
 *           absorbs before breaking; `null` never breaks by damage (JSON has
 *           no Infinity, and a snapshot must survive JSON).
 * @property {number} points Scored when the block is destroyed.
 * @property {number} [threshold] TNT only: the single-hit impulse above
 *           which it detonates rather than bruises.
 * @property {number} [radius] TNT only: blast radius, px.
 * @property {number} [impulse] TNT only: blast impulse at the centre.
 */

/**
 * The built-in materials. `strength` is calibrated against the engine's
 * impulse scale — a max-power round shot arrives carrying roughly its mass
 * times its speed, which for the default ball is on the order of a thousand
 * — so one clean hit fells wood, glass shatters at a graze, and stone wants
 * either a direct pounding or a long fall. `metal` is scenery that moves
 * but never breaks. `tnt` ignores damage entirely and answers one question:
 * was any single hit harder than `threshold`?
 *
 * @type {Readonly<Record<string, CannonMaterial>>}
 */
export const CANNON_MATERIALS = Object.freeze({
  wood: { density: 0.8, friction: 0.5, restitution: 0.15, strength: 420, points: 100 },
  stone: { density: 2.2, friction: 0.65, restitution: 0.08, strength: 1300, points: 250 },
  glass: { density: 0.5, friction: 0.35, restitution: 0.05, strength: 140, points: 50 },
  metal: { density: 4, friction: 0.5, restitution: 0.2, strength: null, points: 0 },
  tnt: { density: 0.9, friction: 0.5, restitution: 0.1, strength: null, points: 150, threshold: 320, radius: 130, impulse: 900 },
});

/**
 * @typedef {object} CannonEmplacement
 * @property {number} x @property {number} y Where the pivot sits.
 * @property {number} minAngle @property {number} maxAngle The firing arc,
 *           radians, +y down so negative aims upward. May cross ±π (a
 *           left-facing cannon is `min: 2.6, max: 4.0`); the world clamps
 *           aim into the arc through its centre, so the seam is safe.
 * @property {number} minPower @property {number} maxPower Muzzle speed,
 *           px/s, spanned by the aim stick's magnitude.
 * @property {number} barrel Muzzle offset from the pivot, px.
 * @property {number} ballRadius @property {number} ballDensity The round
 *           shot. Density 5 at radius 9 weighs about 1.3 engine units.
 * @property {number} shots Ammunition for the seat using this cannon.
 */

/** @returns {CannonEmplacement} The demo's left-side emplacement. */
export function defaultCannon() {
  return {
    x: 64,
    y: 308,
    minAngle: -1.35,
    maxAngle: 0.35,
    minPower: 300,
    maxPower: 900,
    barrel: 40,
    ballRadius: 9,
    ballDensity: 5,
    shots: 10,
  };
}

/**
 * @typedef {object} CannonBlock
 * @property {string} material A `CANNON_MATERIALS` key (or a level override).
 * @property {"box" | "circle"} shape
 * @property {number} x @property {number} y Centre, world px.
 * @property {number} width @property {number} height Boxes.
 * @property {number} radius Circles.
 * @property {number} angle Radians.
 * @property {boolean} static Terrain: immovable and unbreakable in v1.
 * @property {boolean} target Must be destroyed for the win. Never static —
 *           a static block cannot break or fall, so a static target would be
 *           an unwinnable level, and `normalizeCannonLevel` drops the flag.
 */

/**
 * @param {string} material
 * @param {number} x @param {number} y
 * @param {Partial<CannonBlock>} [options]
 * @returns {CannonBlock}
 */
export function makeCannonBlock(material, x, y, options = {}) {
  return normalizeCannonBlock({ material, x, y, ...options });
}

/** @param {any} [input] @returns {CannonBlock} */
export function normalizeCannonBlock(input = {}, materials = CANNON_MATERIALS) {
  const material = oneOf(input.material, Object.keys(materials), "wood");
  const shape = oneOf(input.shape, ["box", "circle"], "box");
  const isStatic = asBoolean(input.static, false);
  return {
    material,
    shape,
    x: boundedNumber(input.x, 0, -4096, 8192),
    y: boundedNumber(input.y, 0, -4096, 8192),
    width: boundedNumber(input.width, 36, 4, 600),
    height: boundedNumber(input.height, 36, 4, 600),
    radius: boundedNumber(input.radius, 18, 2, 300),
    angle: boundedNumber(input.angle, 0, -6.3, 6.3),
    static: isStatic,
    target: isStatic ? false : asBoolean(input.target, false),
  };
}

/**
 * @typedef {object} CannonRules
 * @property {number} settleTicks Steps a shot may hold the turn after
 *           firing before it is declared resolved regardless — the bound on
 *           a ball that neither sleeps nor leaves.
 * @property {number} bruise First-touch impulses below this do not
 *           accumulate as damage, so settle noise never whittles a tower
 *           down on its own.
 * @property {number} shotBonus Scored per unspent shot at the win.
 */

/**
 * @typedef {object} CannonLevel
 * @property {number} version
 * @property {string} name
 * @property {number} width @property {number} height The field; also the
 *           culling bounds — what leaves it is gone, and a target that
 *           leaves counts as destroyed.
 * @property {{x: number, y: number}} gravity px/s², +y down.
 * @property {boolean} floor A static apron along the bottom edge, 40px
 *           tall, spanning the width. Off for levels that author their own
 *           terrain from static blocks.
 * @property {CannonEmplacement[]} cannons One or two. Seats map onto
 *           cannons in order; two seats with one cannon share it.
 * @property {CannonBlock[]} blocks
 * @property {Record<string, Partial<CannonMaterial>>} materials Per-level
 *           overrides, merged over `CANNON_MATERIALS` field by field.
 * @property {CannonRules} rules
 */

/** @returns {CannonLevel} */
export function emptyCannonLevel(name = "Untitled Siege") {
  return {
    version: CANNON_VERSION,
    name: boundedString(name, "Untitled Siege", 80),
    width: 720,
    height: 360,
    gravity: { x: 0, y: 900 },
    floor: true,
    cannons: [defaultCannon()],
    blocks: [],
    materials: {},
    rules: { settleTicks: 600, bruise: 60, shotBonus: 500 },
  };
}

/**
 * The merged material table a level actually plays with: the built-ins,
 * with the level's overrides clamped field by field on top. Unknown
 * material names are dropped rather than invented — a document cannot add
 * a material, only re-tune one, which is what keeps the vocabulary the
 * module's and the tuning the author's.
 *
 * @param {any} [overrides]
 * @returns {Record<string, CannonMaterial>}
 */
export function cannonMaterialTable(overrides) {
  /** @type {Record<string, CannonMaterial>} */
  const table = {};
  for (const [name, base] of Object.entries(CANNON_MATERIALS)) {
    const raw = overrides && typeof overrides === "object" ? overrides[name] : undefined;
    const over = raw && typeof raw === "object" ? raw : {};
    const merged = {
      density: boundedNumber(over.density, base.density, 0.01, 1000),
      friction: boundedNumber(over.friction, base.friction, 0, 2),
      restitution: boundedNumber(over.restitution, base.restitution, 0, 1),
      strength: over.strength === null || base.strength === null
        ? (over.strength === undefined ? base.strength : null)
        : boundedNumber(over.strength, base.strength, 1, 1e6),
      points: boundedInteger(over.points, base.points, 0, 1e6),
    };
    if (base.threshold !== undefined) {
      merged.threshold = boundedNumber(over.threshold, base.threshold, 1, 1e6);
      merged.radius = boundedNumber(over.radius, base.radius, 1, 4096);
      merged.impulse = boundedNumber(over.impulse, base.impulse, 0, 1e6);
    }
    table[name] = merged;
  }
  return table;
}

/**
 * Clamp a level, trusting nothing. Every field of a hostile document comes
 * out bounded or defaulted; a strength of `"Infinity"`, a two-million-pixel
 * field, or a static target are all answered here rather than downstream.
 *
 * Idempotent, and `createSiege` runs it on whatever it is given — a raw
 * JSON.parse is a legal input to the world, just not a trusted one.
 *
 * @param {any} [input]
 * @returns {CannonLevel}
 */
export function normalizeCannonLevel(input = {}) {
  const blank = emptyCannonLevel();
  const width = boundedNumber(input.width, blank.width, 160, 4096);
  const height = boundedNumber(input.height, blank.height, 120, 4096);

  const gravity = input.gravity && typeof input.gravity === "object" ? input.gravity : {};

  const rawCannons = Array.isArray(input.cannons) && input.cannons.length > 0 ? input.cannons : [defaultCannon()];
  const cannons = rawCannons.slice(0, 2).map((raw) => {
    const base = defaultCannon();
    const one = raw && typeof raw === "object" ? raw : {};
    let minAngle = boundedNumber(one.minAngle, base.minAngle, -6.3, 6.3);
    let maxAngle = boundedNumber(one.maxAngle, base.maxAngle, -6.3, 6.3);
    if (maxAngle < minAngle) [minAngle, maxAngle] = [maxAngle, minAngle];
    let minPower = boundedNumber(one.minPower, base.minPower, 10, 5000);
    let maxPower = boundedNumber(one.maxPower, base.maxPower, 10, 5000);
    if (maxPower < minPower) [minPower, maxPower] = [maxPower, minPower];
    return {
      x: boundedNumber(one.x, base.x, 0, width),
      y: boundedNumber(one.y, base.y, 0, height),
      minAngle,
      maxAngle,
      minPower,
      maxPower,
      barrel: boundedNumber(one.barrel, base.barrel, 0, 200),
      ballRadius: boundedNumber(one.ballRadius, base.ballRadius, 2, 60),
      ballDensity: boundedNumber(one.ballDensity, base.ballDensity, 0.01, 1000),
      shots: boundedInteger(one.shots, base.shots, 1, 999),
    };
  });

  /** @type {Record<string, Partial<CannonMaterial>>} */
  const materials = {};
  if (input.materials && typeof input.materials === "object") {
    for (const name of Object.keys(CANNON_MATERIALS)) {
      if (input.materials[name] && typeof input.materials[name] === "object") {
        materials[name] = { ...input.materials[name] };
      }
    }
  }
  const table = cannonMaterialTable(materials);

  const blocks = (Array.isArray(input.blocks) ? input.blocks : [])
    .slice(0, 400)
    .map((raw) => normalizeCannonBlock(raw, table));

  const rawRules = input.rules && typeof input.rules === "object" ? input.rules : {};
  return {
    version: CANNON_VERSION,
    name: boundedString(input.name, blank.name, 80),
    width,
    height,
    gravity: {
      x: boundedNumber(gravity.x, 0, -4000, 4000),
      y: boundedNumber(gravity.y, 900, -4000, 4000),
    },
    floor: asBoolean(input.floor, true),
    cannons,
    blocks,
    materials,
    rules: {
      settleTicks: boundedInteger(rawRules.settleTicks, blank.rules.settleTicks, 30, 100000),
      bruise: boundedNumber(rawRules.bruise, blank.rules.bruise, 0, 1e6),
      shotBonus: boundedInteger(rawRules.shotBonus, blank.rules.shotBonus, 0, 1e6),
    },
  };
}
