import { normalizeRunNJumpMotion, normalizeRunNJumpMount } from "./motion.js";
import { normalizeRunNJumpWeapon, normalizeRunNJumpLoadout, normalizeRunNJumpDefense } from "./equipment.js";
export { normalizeRunNJumpWeapon, normalizeRunNJumpLoadout, normalizeRunNJumpDefense } from "./equipment.js";
import { normalizeRunNJumpSound, normalizeRunNJumpExplosion, normalizeRunNJumpEffects } from "./effects.js";
export { normalizeRunNJumpSound, normalizeRunNJumpExplosion, normalizeRunNJumpEffects } from "./effects.js";
// What a 2DRunNJump game is made of.
//
// The split is the one `shmup` proved out: everything here is what a game
// *says*, and nothing here changes while a run is in progress. The stage
// reads it and never writes to it, which is what lets one authored game be
// replayed, rolled back or raced without being copied first.
//
// Definitions and instances. A game holds definitions — actors, tilesets,
// the player — with stable ids; a level holds *placements* that reference a
// definition by id. Editing "Walker" once changes every walker in the game,
// which is the behaviour a construction set has to have, and it is also what
// keeps a level small enough to fit in a share link.

import { normalizeAssets, clampTo } from "../sprite/assets.js";
import { createPatternPreset, normalizeBulletPattern } from "../patterns/patterns.js";
import { normalizeAnimationSet } from "../sprite/animation.js";
import { INPUT_LOG_VERSION } from "../net/input-log.js";
import { defaultTileset, normalizeTileset, packGrid, unpackGrid } from "./tiles.js";

/** The game schema version. */
export const RUNNJUMP_VERSION = 4;

/** @typedef {"fixed"|"roomFlip"|"followX"|"followXY"|"autoScroll"} CameraMode */
/** @typedef {"power"|"hits"|"oneHit"} HealthModel */
/** @typedef {"enemy"|"object"|"pickup"|"solid"|"decoration"} ActorKind */

// -- input --

/**
 * One player's frame of intent: eleven booleans and two vectors.
 *
 * It was booleans and nothing else, because that is what lets
 * `net/input-log` record a run as bits and a co-op frame pack into a byte.
 * The two vectors are what a stick, a mouse or a second stick needs, and they
 * cost nothing when unused: **both default to centred, and a centred `move`
 * means the four buttons decide**. A game written before they existed
 * therefore behaves identically, key for key, which is why the boolean list
 * below did not have to change or be reordered.
 *
 * Both are quantized — they come from `core/stick`, never raw off the
 * hardware — so they compare exactly, record exactly, and agree between two
 * machines. Putting an unquantized float in either is the one way to misuse
 * this type, and it fails as a desync rather than as an error.
 *
 * @typedef {object} PadInput
 * @property {boolean} left
 * @property {boolean} right
 * @property {boolean} up
 * @property {boolean} down
 * @property {boolean} jump
 * @property {boolean} run
 * @property {boolean} fire
 * @property {boolean} action
 * @property {boolean} satCCW Swing the satellite anticlockwise.
 * @property {boolean} satCW Swing it clockwise.
 * @property {boolean} satLock Hold: the satellite stays put and the two
 *           above turn its AIM instead of its position.
 * @property {boolean} [equipNext] Equipment control.
 * @property {boolean} [equipPrev] Equipment control.
 * @property {boolean} [slotNext] Equipment control.
 * @property {boolean} [satEquip] Equipment control.
 * @property {boolean} [equip1] Equipment control.
 * @property {boolean} [equip2] Equipment control.
 * @property {boolean} [equip3] Equipment control.
 * @property {boolean} [equip4] Equipment control.
 * @property {boolean} [equip5] Equipment control.
 * @property {boolean} [equip6] Equipment control.
 * @property {boolean} [equip7] Equipment control.
 * @property {boolean} [equip8] Equipment control.
 * @property {{x: number, y: number}} [satAim] Independent satellite direction.
 * @property {{x: number, y: number}} [move] Analogue movement. Centred hands
 *           the decision back to left/right/up/down, so a keyboard run is
 *           unchanged; pushed, its magnitude is how fast, which is how a
 *           stick walks slowly.
 * @property {{x: number, y: number}} [aim] Where the weapon points, when the
 *           hero's `aimSource` is `stick`. Centred means "no new instruction",
 *           NOT "point at nothing" — a gun keeps pointing where it was left.
 */

/**
 * The action names, in wire order. The order is part of the format, so names
 * are APPENDED and never reordered: an old recording lists its own actions
 * and `createInputPlayer` looks them up by name, so a log written before the
 * satellite existed still replays -- the three it does not carry simply read
 * as unheld.
 */
export const PAD_ACTIONS = Object.freeze([
  "left", "right", "up", "down", "jump", "run", "fire", "action",
  "satCCW", "satCW", "satLock",
  "equipNext", "equipPrev", "slotNext", "satEquip", "equip1", "equip2", "equip3", "equip4", "equip5", "equip6", "equip7", "equip8",
]);

/**
 * The analogue channels, in wire order — the same append-only rule as
 * `PAD_ACTIONS` and for the same reason: `net/input-log` stores them
 * positionally, so a name may be added at the end and never moved.
 *
 * Kept as a second list rather than folded into the first, because they are
 * not the same kind of thing on the wire: an action is a bit and a stick is
 * two quantized integers. A recording declares both and carries both.
 */
export const PAD_STICKS = Object.freeze(["move", "aim", "satAim"]);

/** @returns {PadInput} A neutral input: nothing held, both sticks centred. */
export function neutralInput() {
  return {
    left: false, right: false, up: false, down: false,
    jump: false, run: false, fire: false, action: false,
    satCCW: false, satCW: false, satLock: false,
    equipNext: false, equipPrev: false, slotNext: false, satEquip: false, equip1: false, equip2: false, equip3: false, equip4: false, equip5: false, equip6: false, equip7: false, equip8: false,
    move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, satAim: { x: 0, y: 0 },
  };
}

// -- feel --

/**
 * Every number that decides how moving and jumping feel. All of it is data,
 * all of it is a `core/fields` row, and the presets below exist because
 * nobody has ever got a jump right by reading numbers — flipping the whole
 * set in one click and feeling the difference is the tool that works.
 *
 * Units: pixels and seconds, at the default 16px tile.
 */
export const FEEL_PRESETS = Object.freeze({
  classic: {
    walkSpeed: 90, runSpeed: 160, accelGround: 800, accelAir: 550,
    frictionGround: 1000, frictionAir: 120, turnBoost: 2,
    gravity: 1400, gravityWhileHolding: 820, maxFall: 420, fastFallScale: 1.5,
    jumpSpeed: 385, jumpCutScale: 0.45, coyoteTime: 0.08, jumpBuffer: 0.1, headBumpNudge: 4,
    wallSlideSpeed: 70, wallJumpX: 190, wallJumpY: 350, wallJumpLockout: 0.12,
    climbSpeed: 85, swimGravity: 320, swimMaxFall: 110, swimStroke: 250,
    dashSpeed: 280, dashTime: 0.14, dashCooldown: 0.4,
    stompBounce: 250, throwX: 170, throwY: 210,
  },
  floaty: {
    walkSpeed: 85, runSpeed: 140, accelGround: 600, accelAir: 500,
    frictionGround: 700, frictionAir: 60, turnBoost: 1.6,
    gravity: 880, gravityWhileHolding: 540, maxFall: 300, fastFallScale: 1.6,
    jumpSpeed: 330, jumpCutScale: 0.55, coyoteTime: 0.12, jumpBuffer: 0.12, headBumpNudge: 4,
    wallSlideSpeed: 50, wallJumpX: 160, wallJumpY: 300, wallJumpLockout: 0.14,
    climbSpeed: 80, swimGravity: 220, swimMaxFall: 80, swimStroke: 220,
    dashSpeed: 240, dashTime: 0.18, dashCooldown: 0.5,
    stompBounce: 230, throwX: 150, throwY: 200,
  },
  heavy: {
    walkSpeed: 80, runSpeed: 140, accelGround: 1100, accelAir: 420,
    frictionGround: 1500, frictionAir: 150, turnBoost: 2.2,
    gravity: 2100, gravityWhileHolding: 1350, maxFall: 540, fastFallScale: 1.3,
    jumpSpeed: 470, jumpCutScale: 0.4, coyoteTime: 0.06, jumpBuffer: 0.08, headBumpNudge: 3,
    wallSlideSpeed: 95, wallJumpX: 200, wallJumpY: 400, wallJumpLockout: 0.1,
    climbSpeed: 75, swimGravity: 420, swimMaxFall: 150, swimStroke: 300,
    dashSpeed: 320, dashTime: 0.12, dashCooldown: 0.35,
    stompBounce: 280, throwX: 190, throwY: 230,
  },
  precise: {
    walkSpeed: 95, runSpeed: 165, accelGround: 2400, accelAir: 1400,
    frictionGround: 2600, frictionAir: 400, turnBoost: 1.5,
    gravity: 1600, gravityWhileHolding: 980, maxFall: 440, fastFallScale: 1.7,
    jumpSpeed: 400, jumpCutScale: 0.35, coyoteTime: 0.07, jumpBuffer: 0.1, headBumpNudge: 5,
    wallSlideSpeed: 60, wallJumpX: 200, wallJumpY: 370, wallJumpLockout: 0.09,
    climbSpeed: 95, swimGravity: 340, swimMaxFall: 120, swimStroke: 260,
    dashSpeed: 300, dashTime: 0.13, dashCooldown: 0.3,
    stompBounce: 260, throwX: 180, throwY: 210,
  },
  icy: {
    walkSpeed: 90, runSpeed: 160, accelGround: 320, accelAir: 500,
    frictionGround: 140, frictionAir: 100, turnBoost: 1.4,
    gravity: 1400, gravityWhileHolding: 820, maxFall: 420, fastFallScale: 1.5,
    jumpSpeed: 385, jumpCutScale: 0.45, coyoteTime: 0.09, jumpBuffer: 0.1, headBumpNudge: 4,
    wallSlideSpeed: 70, wallJumpX: 190, wallJumpY: 350, wallJumpLockout: 0.12,
    climbSpeed: 85, swimGravity: 320, swimMaxFall: 110, swimStroke: 250,
    dashSpeed: 280, dashTime: 0.14, dashCooldown: 0.4,
    stompBounce: 250, throwX: 170, throwY: 210,
  },
});

/** @typedef {keyof typeof FEEL_PRESETS} FeelPresetName */

export const FEEL_RANGES = {
  walkSpeed: [10, 400], runSpeed: [10, 600], accelGround: [50, 5000], accelAir: [0, 5000],
  frictionGround: [0, 6000], frictionAir: [0, 6000], turnBoost: [1, 6],
  gravity: [100, 4000], gravityWhileHolding: [50, 4000], maxFall: [60, 1200], fastFallScale: [1, 3],
  jumpSpeed: [60, 900], jumpCutScale: [0, 1], coyoteTime: [0, 0.4], jumpBuffer: [0, 0.4], headBumpNudge: [0, 8],
  wallSlideSpeed: [10, 400], wallJumpX: [0, 600], wallJumpY: [60, 900], wallJumpLockout: [0, 0.5],
  climbSpeed: [10, 300], swimGravity: [0, 2000], swimMaxFall: [20, 600], swimStroke: [40, 700],
  dashSpeed: [60, 900], dashTime: [0.05, 0.6], dashCooldown: [0, 3],
  stompBounce: [60, 700], throwX: [0, 600], throwY: [0, 700],
};

/**
 * The feel as a `core/fields` schema: hand these to `defineFields` with
 * `feelFieldRanges()` and an inspector renders itself — which was the whole
 * point of promoting the field-descriptor idea into core. Grouped the way a
 * person tunes: movement, then the jump, then the specialties.
 */
export const FEEL_FIELD_GROUPS = [
  {
    title: "Moving",
    fields: [
      { key: "walkSpeed", label: "walk speed", step: 5, unit: " px/s" },
      { key: "runSpeed", label: "run speed", step: 5, unit: " px/s" },
      { key: "accelGround", label: "ground accel", step: 50, unit: " px/s²" },
      { key: "accelAir", label: "air accel", step: 50, unit: " px/s²" },
      { key: "frictionGround", label: "ground friction", step: 50, unit: " px/s²" },
      { key: "frictionAir", label: "air friction", step: 10, unit: " px/s²" },
      { key: "turnBoost", label: "turn boost", step: 0.1, decimals: 1, help: "acceleration multiplier when reversing" },
    ],
  },
  {
    title: "Jumping",
    fields: [
      { key: "jumpSpeed", label: "jump power", step: 5, unit: " px/s" },
      { key: "gravity", label: "gravity", step: 25, unit: " px/s²" },
      { key: "gravityWhileHolding", label: "gravity, jump held", step: 25, unit: " px/s²", help: "lower = floatier held jumps" },
      { key: "maxFall", label: "max fall speed", step: 10, unit: " px/s" },
      { key: "fastFallScale", label: "fast-fall scale", step: 0.05, decimals: 2 },
      { key: "jumpCutScale", label: "release cut", step: 0.05, decimals: 2, help: "what remains of the rise when jump is released" },
      { key: "coyoteTime", label: "coyote time", step: 0.01, unit: " s", decimals: 2 },
      { key: "jumpBuffer", label: "jump buffer", step: 0.01, unit: " s", decimals: 2 },
      { key: "headBumpNudge", label: "corner nudge", type: "integer", unit: " px" },
    ],
  },
  {
    title: "Walls",
    fields: [
      { key: "wallSlideSpeed", label: "slide speed", step: 5, unit: " px/s" },
      { key: "wallJumpX", label: "wall jump, away", step: 5, unit: " px/s" },
      { key: "wallJumpY", label: "wall jump, up", step: 5, unit: " px/s" },
      { key: "wallJumpLockout", label: "steering lockout", step: 0.01, unit: " s", decimals: 2 },
    ],
  },
  {
    title: "Water and ladders",
    fields: [
      { key: "climbSpeed", label: "climb speed", step: 5, unit: " px/s" },
      { key: "swimGravity", label: "water gravity", step: 20, unit: " px/s²" },
      { key: "swimMaxFall", label: "sink speed", step: 5, unit: " px/s" },
      { key: "swimStroke", label: "stroke power", step: 5, unit: " px/s" },
    ],
  },
  {
    title: "Dash, stomp, throw",
    fields: [
      { key: "dashSpeed", label: "dash speed", step: 5, unit: " px/s" },
      { key: "dashTime", label: "dash length", step: 0.01, unit: " s", decimals: 2 },
      { key: "dashCooldown", label: "dash cooldown", step: 0.05, unit: " s", decimals: 2 },
      { key: "stompBounce", label: "stomp bounce", step: 10, unit: " px/s" },
      { key: "throwX", label: "throw, forward", step: 5, unit: " px/s" },
      { key: "throwY", label: "throw, up", step: 5, unit: " px/s" },
    ],
  },
];

/**
 * `defineFields`' ranges table for the feel: min and max from FEEL_RANGES —
 * the same table `normalizeFeel` clamps by, so the inspector and the
 * sanitizer cannot disagree — with the classic preset as every fallback.
 */
export function feelFieldRanges() {
  const ranges = {};
  for (const [key, [min, max]] of Object.entries(FEEL_RANGES)) {
    ranges[key] = [min, max, FEEL_PRESETS.classic[key]];
  }
  return ranges;
}

/**
 * A complete feel: the named preset, with any explicit numbers laid over it.
 *
 * @param {any} [input]
 * @param {FeelPresetName} [preset]
 */
export function normalizeFeel(input, preset = "classic") {
  const base = FEEL_PRESETS[input?.preset in FEEL_PRESETS ? input.preset : preset];
  const feel = { preset: input?.preset in FEEL_PRESETS ? input.preset : preset };
  for (const [key, [min, max]] of Object.entries(FEEL_RANGES)) {
    const raw = Number(input?.[key]);
    feel[key] = Number.isFinite(raw) ? clampTo(raw, min, max) : base[key];
  }
  return feel;
}

// -- the player definition --

/**
 * The orbiting companion: a satellite that circles the player, that the
 * player can swing around themselves, and whose fire can be pointed
 * somewhere other than where it happens to be sitting.
 *
 * Those are two different things and the design turns on keeping them
 * apart. `angle` is WHERE IT IS, `aim` is WHERE IT SHOOTS. Normally the aim
 * turns WITH the orbit -- by the same delta, not set equal to it -- so the
 * rig rotates rigidly, fires outward by default, and one pair of keys is
 * the whole interface. Hold `satLock` and the satellite freezes in place
 * while the same two keys turn the aim alone; the offset that leaves behind
 * is kept, which is what makes it a shield you can park between yourself
 * and a turret while still shooting upward.
 *
 * Angles are degrees, and everything trigonometric goes through
 * `core/trig`, so a satellite is as bit-deterministic as the rest of the
 * simulation and rides co-op unchanged.
 *
 * Named `defaultPlayerSatellite` and not `defaultSatellite` because
 * `shmup/contract` already declares the latter, and Pinball concatenates
 * this package into ONE FLAT SCOPE where two top-level names of the same
 * spelling is a SyntaxError rather than a style question. flat-scope.test
 * caught it on the first run; its known-clash list is deliberately
 * expensive to join, and a module this new is the cheap side of a rename.
 */
export function defaultPlayerSatellite() {
  return {
    enabled: false,
    distance: 26,
    /** Degrees per second the player can swing it. */
    orbitSpeed: 220,
    /** Degrees per second the aim turns under `satLock`. */
    aimSpeed: 180,
    /** Free rotation, degrees per second, for a satellite that never sits still. */
    autoSpin: 0,
    /** Where it starts, and where `recentre` returns it to. Degrees; 0 is right. */
    restAngle: -90,
    /** The aim turns with the orbit (keeping any locked-in offset). Off, the
     *  satellite can be swung without the gun ever moving. */
    aimFollowsOrbit: true,
    /** It shoots on `fire` with the player, or on its own timer when > 0. */
    autoFireRate: 0,
    fireRate: 4,
    projectileSpeed: 300,
    projectileGravity: 0,
    ttl: 1.2,
    size: 5,
    damage: 1,
    /** Enemies that touch it take this; 0 makes it purely a gun. */
    touchDamage: 0,
    /** It blocks enemy pattern bullets that hit it. */
    blocks: true,
  };
}

/** @param {any} input */
export function normalizeSatellite(input) {
  const base = defaultPlayerSatellite();
  const merged = { ...base, ...(input ?? {}) };
  return {
    ...(input?.loadout ? { loadout: normalizeRunNJumpLoadout(input.loadout) } : {}),
    ...(typeof input?.patternId === "string" ? { patternId: input.patternId.slice(0, 80), customEdited: input.customEdited === true } : {}),
    ...(input?.effects ? { effects: normalizeRunNJumpEffects(input.effects) } : {}),
    ...(input?.control ? { control: { mode: input.control.mode === "tether" ? "tether" : "orbit", aimSource: input.control.aimSource === "independent" ? "independent" : "shared", speed: Math.min(900, Math.max(20, Number(input.control.speed) || 180)) } } : {}),
    ...(input?.durability ? { durability: { hp: Math.round(Math.min(99, Math.max(1, Number(input.durability.hp) || 3))), respawn: Math.min(30, Math.max(0.5, Number(input.durability.respawn) || 3)), defenseId: typeof input.durability.defenseId === "string" ? input.durability.defenseId.slice(0, 80) : "" } } : {}),
    enabled: merged.enabled === true,
    distance: clampTo(Math.round(Number(merged.distance) || base.distance), 8, 160),
    orbitSpeed: clampTo(Number(merged.orbitSpeed) || base.orbitSpeed, 20, 900),
    aimSpeed: clampTo(Number(merged.aimSpeed) || base.aimSpeed, 20, 900),
    autoSpin: clampTo(Number(merged.autoSpin) || 0, -900, 900),
    restAngle: ((Number(merged.restAngle) || 0) % 360 + 360) % 360,
    aimFollowsOrbit: merged.aimFollowsOrbit !== false,
    autoFireRate: clampTo(Number(merged.autoFireRate) || 0, 0, 20),
    fireRate: clampTo(Number(merged.fireRate) || base.fireRate, 0.2, 20),
    projectileSpeed: clampTo(Number(merged.projectileSpeed) || base.projectileSpeed, 40, 900),
    projectileGravity: clampTo(Number(merged.projectileGravity) || 0, 0, 3000),
    ttl: clampTo(Number(merged.ttl) || base.ttl, 0.1, 6),
    size: clampTo(Math.round(Number(merged.size) || base.size), 2, 24),
    damage: clampTo(Math.round(Number(merged.damage) || 1), 1, 99),
    touchDamage: clampTo(Math.round(Number(merged.touchDamage) || 0), 0, 99),
    blocks: merged.blocks !== false,
  };
}

/** The satellite's rows, for the editor. Same ParamSpec shape as the rest. */
export const SATELLITE_FIELDS = [
  { key: "enabled", label: "satellite", type: "boolean", fallback: false },
  { key: "distance", label: "orbit radius", type: "integer", min: 8, max: 160, fallback: 26, unit: " px" },
  { key: "orbitSpeed", label: "swing speed", min: 20, max: 900, step: 10, fallback: 220, unit: " °/s" },
  { key: "aimSpeed", label: "aim speed (locked)", min: 20, max: 900, step: 10, fallback: 180, unit: " °/s" },
  { key: "autoSpin", label: "free spin", min: -900, max: 900, step: 10, fallback: 0, unit: " °/s" },
  { key: "restAngle", label: "starting angle", min: 0, max: 359, step: 5, fallback: 270, unit: " °" },
  { key: "aimFollowsOrbit", label: "aim turns with orbit", type: "boolean", fallback: true },
  { key: "fireRate", label: "shots per second", min: 0.2, max: 20, step: 0.2, fallback: 4, decimals: 1 },
  { key: "autoFireRate", label: "auto-fire (0 = with player)", min: 0, max: 20, step: 0.2, fallback: 0, decimals: 1 },
  { key: "projectileSpeed", label: "shot speed", min: 40, max: 900, step: 10, fallback: 300, unit: " px/s" },
  { key: "projectileGravity", label: "shot gravity", min: 0, max: 3000, step: 50, fallback: 0, unit: " px/s²" },
  { key: "ttl", label: "shot lifetime", min: 0.1, max: 6, step: 0.1, fallback: 1.2, unit: " s", decimals: 1 },
  { key: "size", label: "shot size", type: "integer", min: 2, max: 24, fallback: 5, unit: " px" },
  { key: "damage", label: "damage", type: "integer", min: 1, max: 99, fallback: 1 },
  { key: "touchDamage", label: "hurts on contact", type: "integer", min: 0, max: 99, fallback: 0 },
  { key: "blocks", label: "blocks enemy bullets", type: "boolean", fallback: true },
];

export function defaultHero() {
  return {
    name: "Hero",
    sprite: { assetId: "", animations: "", tint: 0 },
    hitbox: { w: 12, h: 20 },
    duckHitbox: { w: 12, h: 12 },
    abilities: {
      run: true, jumpCount: 1, wallJump: false, wallSlide: false,
      duck: true, crawl: true, climb: true, swim: true, dash: false,
      stomp: true, shoot: false, melee: false, carry: false,
    },
    feel: normalizeFeel(undefined, "classic"),
    satellite: defaultPlayerSatellite(),
    health: { model: /** @type {HealthModel} */ ("power"), max: 3, invulnTime: 1.4, knockbackX: 130, knockbackY: 200 },
    weapon: {
      projectileSpeed: 280, projectileGravity: 0, fireRate: 3, ttl: 1.1, size: 6,
      meleeRange: 18, meleeTime: 0.18, meleeCooldown: 0.35, damage: 1,
      aimSource: "facing", aimResolution: "eight",
    },
  };
}

/** @param {any} input */
export function normalizeHero(input) {
  const base = defaultHero();
  const abilities = { ...base.abilities, ...(input?.abilities ?? {}) };
  for (const key of Object.keys(base.abilities)) {
    if (key === "jumpCount") abilities.jumpCount = clampTo(Math.round(Number(abilities.jumpCount) || 1), 0, 4);
    else abilities[key] = abilities[key] === true;
  }
  const box = (raw, fallback) => ({
    w: clampTo(Math.round(Number(raw?.w) || fallback.w), 4, 64),
    h: clampTo(Math.round(Number(raw?.h) || fallback.h), 4, 96),
  });
  const health = { ...base.health, ...(input?.health ?? {}) };
  return {
    ...(input?.loadout ? { loadout: normalizeRunNJumpLoadout(input.loadout) } : {}),
    ...(typeof input?.defenseId === "string" ? { defenseId: input.defenseId.slice(0, 80) } : {}),
    name: typeof input?.name === "string" && input.name ? input.name.slice(0, 40) : base.name,
    sprite: {
      assetId: typeof input?.sprite?.assetId === "string" ? input.sprite.assetId.slice(0, 80) : "",
      animations: typeof input?.sprite?.animations === "string" ? input.sprite.animations.slice(0, 80) : "",
      tint: ((Number(input?.sprite?.tint) || 0) % 360 + 360) % 360,
    },
    ...(input?.effects ? { effects: normalizeRunNJumpEffects(input.effects) } : {}),
    ...(input?.appearance ? { appearance: normalizeAppearance(input.appearance) } : {}),
    hitbox: box(input?.hitbox, base.hitbox),
    duckHitbox: box(input?.duckHitbox, base.duckHitbox),
    abilities,
    feel: normalizeFeel(input?.feel),
    satellite: normalizeSatellite(input?.satellite),
    health: {
      model: health.model === "hits" || health.model === "oneHit" ? health.model : "power",
      max: clampTo(Math.round(Number(health.max) || 3), 1, 99),
      invulnTime: clampTo(Number(health.invulnTime) || 1.4, 0, 5),
      knockbackX: clampTo(Number(health.knockbackX) || 130, 0, 600),
      knockbackY: clampTo(Number(health.knockbackY) || 200, 0, 700),
    },
    weapon: normalizeHeroWeapon(input?.weapon, base.weapon),
  };
}

/**
 * Where the gun points, which is the whole of the run-and-gun question.
 *
 * `facing` is the default and is what every game written before this had:
 * the shot goes the way the body faces, and nothing about a run changes.
 * `move` is Contra — the same d-pad steers the legs and the barrel, so
 * holding up-right runs right and shoots diagonally. `stick` is Abuse, Time
 * Soldiers and Geometry Wars: a second source aims independently of the feet,
 * whether that source is a mouse, a second stick, or a touch thumbstick.
 *
 * @typedef {"facing"|"move"|"stick"} AimSource
 */
export const AIM_SOURCES = Object.freeze(["facing", "move", "stick"]);

/** The gate the aim passes through. `core/stick`'s three, no more. */
export const AIM_RESOLUTIONS = Object.freeze(["free", "eight", "four"]);

/**
 * The aim as `core/fields` rows, so a construction set can offer it instead of
 * an author having to know the word `aimSource` and hand-edit a document.
 *
 * Bare keys, no paths, exactly as `FEEL_FIELD_GROUPS` has them: the document a
 * host binds this to is `game.player.weapon`, the way it binds those to
 * `game.player.feel`. Same convention, so a host that renders one renders the
 * other without learning anything new.
 *
 * A separate group rather than an addition to `FEEL_FIELD_GROUPS`, because it
 * is not feel: feel is how the body moves and every row of it is a number with
 * a range, while this is two enums about a weapon. It is offered as one group
 * a host drops into whatever inspector it already has, rather than as a schema
 * for the whole weapon, which is hand-written today and not this slice's
 * business to redefine.
 *
 * The resolution row hides itself when there is nothing to gate — `facing` has
 * one direction per side and a four-way version of it would be the same thing.
 */
export const AIM_FIELD_GROUP = {
  title: "Aiming",
  fields: [
    {
      key: "aimSource",
      label: "aim with",
      type: "enum",
      options: AIM_SOURCES,
      fallback: "facing",
      help: "facing: the gun is the body · move: the d-pad aims it too, and releasing levels it · stick: a second stick, or the mouse, aiming apart from the feet",
    },
    {
      key: "aimResolution",
      label: "aim in",
      type: "enum",
      options: AIM_RESOLUTIONS,
      fallback: "eight",
      help: "free: any angle · eight: eight ways · four: up, down, left, right",
      when: (weapon) => weapon?.aimSource !== "facing",
    },
  ],
};

function normalizeHeroWeapon(input, base) {
  const weapon = { ...base, ...(input ?? {}) };
  return {
    ...(typeof input?.patternId === "string" ? { patternId: input.patternId.slice(0, 80), customEdited: input.customEdited === true } : {}),
    ...(input?.effects ? { effects: normalizeRunNJumpEffects(input.effects) } : {}),
    ...(normalizeRunNJumpMount(input?.mount) ? {mount:normalizeRunNJumpMount(input.mount)} : {}),
    aimSource: AIM_SOURCES.includes(weapon.aimSource) ? weapon.aimSource : "facing",
    aimResolution: AIM_RESOLUTIONS.includes(weapon.aimResolution) ? weapon.aimResolution : "eight",
    projectileSpeed: clampTo(Number(weapon.projectileSpeed) || base.projectileSpeed, 40, 900),
    projectileGravity: clampTo(Number(weapon.projectileGravity) || 0, 0, 3000),
    fireRate: clampTo(Number(weapon.fireRate) || base.fireRate, 0.2, 20),
    ttl: clampTo(Number(weapon.ttl) || base.ttl, 0.1, 6),
    size: clampTo(Math.round(Number(weapon.size) || base.size), 2, 24),
    meleeRange: clampTo(Math.round(Number(weapon.meleeRange) || base.meleeRange), 4, 64),
    meleeTime: clampTo(Number(weapon.meleeTime) || base.meleeTime, 0.05, 1),
    meleeCooldown: clampTo(Number(weapon.meleeCooldown) || base.meleeCooldown, 0, 3),
    damage: clampTo(Math.round(Number(weapon.damage) || 1), 1, 99),
  };
}

// -- actor definitions --

/** Reaction triggers, the closed list. */
export const REACTION_WHEN = Object.freeze([
  "stomped", "hurt", "touchedPlayer", "died", "spottedPlayer", "lostSight",
  "landed", "hitWall", "hitFromBelow", "leftScreen", "timer", "healthBelow", "crushed",
]);

/** Reaction effects, the closed list. A boss is phases over this same table. */
export const REACTION_DO = Object.freeze([
  "damage", "die", "becomeKind", "setBehavior", "spawn", "dropPickup",
  "score", "sfx", "burst", "shakeCamera", "setVelocity", "makeInvulnerable",
  "toggleSwitchGroup", "endLevel", "bouncePlayer", "setCheckpoint", "unlock",
]);

/**
 * What each reaction trigger's own parameters are, for the editor. Empty
 * lists are stated rather than omitted so a completeness test can hold this
 * table to REACTION_WHEN, the same discipline as the behaviour specs.
 */
export const REACTION_WHEN_FIELDS = {
  stomped: [],
  hurt: [],
  touchedPlayer: [],
  died: [],
  spottedPlayer: [
    { key: "range", label: "sight range", min: 16, max: 800, step: 8, fallback: 120, unit: " px" },
  ],
  lostSight: [],
  landed: [],
  hitWall: [],
  hitFromBelow: [],
  leftScreen: [],
  timer: [
    { key: "every", label: "every", min: 0.2, max: 30, step: 0.1, fallback: 2, unit: " s", decimals: 1 },
  ],
  healthBelow: [
    { key: "threshold", label: "at or below", type: "integer", min: 1, max: 998, fallback: 1, unit: " hp" },
  ],
  crushed: [],
};

/**
 * And each effect's. `reference` fields name which definition list the
 * editor should offer, through `core/fields`' refKind.
 */
export const REACTION_DO_FIELDS = {
  damage: [
    { key: "amount", label: "damage", type: "integer", min: 1, max: 99, fallback: 1 },
  ],
  die: [],
  becomeKind: [
    { key: "defId", label: "becomes", type: "reference", refKind: "actor", fallback: "walker" },
  ],
  setBehavior: [
    { key: "behavior", label: "behaviour", type: "text", maxLength: 40, fallback: "" },
  ],
  spawn: [
    { key: "defId", label: "spawns", type: "reference", refKind: "actor", fallback: "walker" },
    { key: "dx", label: "offset x", min: -200, max: 200, step: 2, fallback: 0, unit: " px" },
    { key: "dy", label: "offset y", min: -200, max: 200, step: 2, fallback: 0, unit: " px" },
    { key: "vx", label: "launch vx", min: -500, max: 500, step: 5, fallback: 0, unit: " px/s" },
    { key: "vy", label: "launch vy", min: -500, max: 500, step: 5, fallback: 0, unit: " px/s" },
  ],
  dropPickup: [
    { key: "defId", label: "drops", type: "reference", refKind: "actor", fallback: "coin" },
  ],
  score: [
    { key: "amount", label: "points", type: "integer", min: 0, max: 100000, fallback: 100 },
  ],
  sfx: [
    { key: "name", label: "sound", type: "text", maxLength: 40, fallback: "hit" },
  ],
  burst: [
    { key: "color", label: "colour", type: "text", maxLength: 24, fallback: "" },
    { key: "count", label: "particles", type: "integer", min: 1, max: 60, fallback: 8 },
  ],
  shakeCamera: [
    { key: "power", label: "power", min: 0.2, max: 8, step: 0.2, fallback: 1, decimals: 1 },
  ],
  setVelocity: [
    { key: "vx", label: "vx", min: -600, max: 600, step: 5, fallback: 0, unit: " px/s" },
    { key: "vy", label: "vy", min: -600, max: 600, step: 5, fallback: 0, unit: " px/s" },
    { key: "fromPlayer", label: "away from player", type: "boolean", fallback: false },
  ],
  makeInvulnerable: [
    { key: "time", label: "for", min: 0.2, max: 10, step: 0.1, fallback: 1, unit: " s", decimals: 1 },
  ],
  toggleSwitchGroup: [
    { key: "tag", label: "group", type: "text", maxLength: 40, fallback: "" },
  ],
  endLevel: [
    { key: "result", label: "result", type: "enum", options: ["cleared", "failed"], fallback: "cleared" },
  ],
  bouncePlayer: [
    { key: "power", label: "power (0 = stomp default)", min: 0, max: 1200, step: 20, fallback: 0, unit: " px/s" },
  ],
  setCheckpoint: [],
  unlock: [],
};

/**
 * Clamp one parameter bag the generic way: numbers into a sane range, short
 * strings kept, waypoint lists capped, everything else dropped. Behaviours
 * and effects have heterogeneous parameters, and a whitelist per type would
 * be a second copy of the registry — this is the stance `normalizeAssets`
 * takes with shapes, applied to numbers.
 */
function normalizeParams(input) {
  const params = {};
  if (!input || typeof input !== "object") return params;
  for (const [key, value] of Object.entries(input)) {
    if (key === "type" || key === "when" || key === "do") continue;
    if (typeof value === "number" && Number.isFinite(value)) params[key] = clampTo(value, -20000, 20000);
    else if (typeof value === "string") params[key] = value.slice(0, 80);
    else if (typeof value === "boolean") params[key] = value;
    else if (key === "waypoints" && Array.isArray(value)) {
      params.waypoints = value.slice(0, 32).map((point) => ({
        x: clampTo(Math.round(Number(point?.x) || 0), -100000, 100000),
        y: clampTo(Math.round(Number(point?.y) || 0), -100000, 100000),
      }));
    }
  }
  return params;
}

/** @param {any} input */
export function normalizeBehaviors(input) {
  return (Array.isArray(input) ? input : [])
    .slice(0, 8)
    .filter((entry) => entry && typeof entry.type === "string" && entry.type.length > 0)
    .map((entry) => ({ type: entry.type.slice(0, 40), ...normalizeParams(entry) }));
}

/** @param {any} input */
export function normalizeReactions(input) {
  return (Array.isArray(input) ? input : [])
    .slice(0, 16)
    .filter((entry) => entry && REACTION_WHEN.includes(entry.when))
    .map((entry) => ({
      when: entry.when,
      ...normalizeParams(entry),
      do: (Array.isArray(entry.do) ? entry.do : [])
        .slice(0, 8)
        .filter((effect) => effect && REACTION_DO.includes(effect.type))
        .map((effect) => ({ type: effect.type, ...normalizeParams(effect) })),
    }));
}

/** @param {any} input @returns {object} */
export function normalizeActorDef(input) {
  const kind = ["enemy", "object", "pickup", "solid", "decoration"].includes(input?.kind) ? input.kind : "enemy";
  return {
    id: typeof input?.id === "string" && input.id ? input.id.slice(0, 80) : "actor",
    name: typeof input?.name === "string" && input.name ? input.name.slice(0, 40) : "Actor",
    kind: /** @type {ActorKind} */ (kind),
    hitbox: {
      w: clampTo(Math.round(Number(input?.hitbox?.w) || 14), 2, 128),
      h: clampTo(Math.round(Number(input?.hitbox?.h) || 14), 2, 128),
    },
    sprite: {
      assetId: typeof input?.sprite?.assetId === "string" ? input.sprite.assetId.slice(0, 80) : "",
      animations: typeof input?.sprite?.animations === "string" ? input.sprite.animations.slice(0, 80) : "",
      tint: ((Number(input?.sprite?.tint) || 0) % 360 + 360) % 360,
    },
    ...(input?.effects ? { effects: normalizeRunNJumpEffects(input.effects) } : {}),
    ...(typeof input?.defenseId === "string" ? { defenseId: input.defenseId.slice(0, 80) } : {}),
    ...(input?.local === true ? { local: true } : {}),
    ...(input?.motion ? { motion: normalizeRunNJumpMotion(input.motion) } : {}),
    ...(input?.indestructible === true ? { indestructible: true } : {}),
    gravity: input?.gravity !== false,
    solid: input?.solid === true,
    platform: input?.platform === true,
    carryable: input?.carryable === true,
    projectileWhenMoving: input?.projectileWhenMoving === true,
    hp: clampTo(Math.round(Number(input?.hp) || 1), 1, 999),
    touchDamage: clampTo(Math.round(Number(input?.touchDamage ?? (kind === "enemy" ? 1 : 0))), 0, 99),
    stompable: input?.stompable !== false,
    score: clampTo(Math.round(Number(input?.score) || 0), 0, 100000),
    behaviors: normalizeBehaviors(input?.behaviors),
    weapon: input?.weapon ? { patternId: typeof input.weapon.patternId === "string" ? input.weapon.patternId.slice(0, 80) : "", ...normalizeParams(input.weapon), ...(normalizeRunNJumpMount(input.weapon.mount) ? { mount: normalizeRunNJumpMount(input.weapon.mount) } : {}) } : null,
    reactions: normalizeReactions(input?.reactions),
    pickup: input?.pickup
      ? {
        effect: ["coin", "health", "power", "invincible", "life", "key", "score", "clearEnemies", "weapon", "satelliteWeapon", "defense"].includes(input.pickup.effect) ? input.pickup.effect : "coin",
        value: clampTo(Math.round(Number(input.pickup.value ?? 1)), 0, 10000),
        ...(typeof input.pickup.weaponId === "string" ? { weaponId: input.pickup.weaponId.slice(0, 80) } : {}),
        ...(typeof input.pickup.defenseId === "string" ? { defenseId: input.pickup.defenseId.slice(0, 80) } : {}),
        duration: clampTo(Number(input.pickup.duration) || 0, 0, 120),
      }
      : null,
    activation: { range: clampTo(Math.round(Number(input?.activation?.range ?? 96)), 0, 4000) },
    warp: input?.warp
      ? {
        tag: typeof input.warp.tag === "string" ? input.warp.tag.slice(0, 40) : "",
        entry: ["down", "touch", "action"].includes(input.warp.entry) ? input.warp.entry : "down",
      }
      : null,
    switchGroup: typeof input?.switchGroup === "string" ? input.switchGroup.slice(0, 40) : "",
  };
}

/**
 * The one built-in bullet pattern, with deterministic ids for the same
 * reason every other built-in has fixed ids: two normalizations of one
 * game must agree.
 */
export function defaultPatterns() {
  let counter = 0;
  const makeId = () => `rj-pendulum-${counter += 1}`;
  return [{ ...createPatternPreset("Pendulum Sweep", makeId), id: "pattern-pendulum" }];
}

/**
 * The built-in actors every game starts with. Fixed ids, same ratchet as the
 * tileset: a level placed against one copy of these must open against
 * another, so entries are appended and never renamed. This list grows with
 * the behaviour library; the editor palette in `actorPalette` grows with it.
 */
export function defaultActors() {
  const define = (input) => normalizeActorDef(input);
  return [
    define({
      id: "walker", name: "Walker", kind: "enemy", hitbox: { w: 14, h: 14 },
      behaviors: [{ type: "patrol", speed: 40 }], score: 100,
      reactions: [{ when: "stomped", do: [{ type: "die" }, { type: "score", amount: 100 }, { type: "sfx", name: "stomp" }, { type: "bouncePlayer" }] }],
    }),
    define({
      id: "ledge-walker", name: "Ledge Walker", kind: "enemy", hitbox: { w: 14, h: 14 },
      behaviors: [{ type: "patrolLedge", speed: 36 }], score: 150,
      reactions: [{ when: "stomped", do: [{ type: "die" }, { type: "score", amount: 150 }, { type: "sfx", name: "stomp" }, { type: "bouncePlayer" }] }],
    }),
    define({
      id: "coin", name: "Coin", kind: "pickup", hitbox: { w: 10, h: 10 }, gravity: false,
      touchDamage: 0, stompable: false, pickup: { effect: "coin", value: 1 }, score: 50,
    }),
    define({
      id: "goal", name: "Goal", kind: "object", hitbox: { w: 16, h: 32 }, gravity: false,
      touchDamage: 0, stompable: false,
      reactions: [{ when: "touchedPlayer", do: [{ type: "endLevel", result: "cleared" }, { type: "sfx", name: "clear" }] }],
    }),
    define({
      id: "checkpoint", name: "Checkpoint", kind: "object", hitbox: { w: 12, h: 24 }, gravity: false,
      touchDamage: 0, stompable: false,
      reactions: [{ when: "touchedPlayer", do: [{ type: "setCheckpoint" }, { type: "sfx", name: "checkpoint" }] }],
    }),
    define({
      id: "flyer", name: "Flyer", kind: "enemy", hitbox: { w: 14, h: 12 }, gravity: false,
      behaviors: [{ type: "fly", mode: "sine", speed: 44, amplitude: 22, frequency: 0.5 }], score: 200,
    }),
    define({
      id: "hopper", name: "Hopper", kind: "enemy", hitbox: { w: 12, h: 12 },
      behaviors: [{ type: "hop", speed: 46, power: 240, pause: 0.5 }], score: 150,
    }),
    define({
      id: "chaser", name: "Chaser", kind: "enemy", hitbox: { w: 14, h: 14 },
      behaviors: [{ type: "chase", speed: 46 }], score: 200,
    }),
    define({
      id: "charger", name: "Charger", kind: "enemy", hitbox: { w: 16, h: 14 },
      behaviors: [{ type: "charge", speed: 150, range: 130, pause: 0.7 }], score: 300,
    }),
    define({
      id: "swooper", name: "Swooper", kind: "enemy", hitbox: { w: 14, h: 10 }, gravity: false,
      behaviors: [{ type: "swoop", range: 110, speed: 170, rest: 1.1 }], score: 250,
    }),
    define({
      id: "barrel", name: "Barrel", kind: "enemy", hitbox: { w: 12, h: 12 },
      touchDamage: 1, stompable: false, score: 0,
      behaviors: [{ type: "roll", speed: 78, takeLadders: "alternate" }],
      reactions: [{ when: "hitWall", do: [] }],
    }),
    define({
      id: "barrel-spawner", name: "Barrel Spawner", kind: "object", hitbox: { w: 24, h: 24 }, gravity: false,
      touchDamage: 0, stompable: false,
      behaviors: [{ type: "spawner", defId: "barrel", interval: 3, limit: 4, dir: 1, vx: 40 }],
    }),
    define({
      id: "shell-walker", name: "Shell Walker", kind: "enemy", hitbox: { w: 14, h: 16 },
      behaviors: [{ type: "patrol", speed: 34 }], score: 200,
      reactions: [{ when: "stomped", do: [{ type: "becomeKind", defId: "shell" }, { type: "bouncePlayer" }, { type: "sfx", name: "stomp" }] }],
    }),
    define({
      id: "shell", name: "Shell", kind: "enemy", hitbox: { w: 14, h: 12 },
      touchDamage: 0, stompable: true, projectileWhenMoving: true, carryable: true, score: 0,
      behaviors: [{ type: "slide", speed: 190 }],
      reactions: [
        { when: "touchedPlayer", do: [{ type: "setVelocity", vx: 190, fromPlayer: true }, { type: "sfx", name: "kick" }] },
        { when: "stomped", do: [{ type: "setVelocity", vx: 0 }, { type: "bouncePlayer" }] },
      ],
    }),
    define({
      id: "spikeball", name: "Spikeball", kind: "enemy", hitbox: { w: 14, h: 14 },
      touchDamage: 1, stompable: false,
      behaviors: [{ type: "patrol", speed: 30 }], score: 0,
    }),
    define({
      id: "turret-bot", name: "Turret", kind: "enemy", hitbox: { w: 16, h: 16 }, gravity: true,
      behaviors: [{ type: "still" }, { type: "turret", interval: 1.8, speed: 150, defId: "enemy-shot" }], score: 300,
    }),
    define({
      id: "lobber", name: "Lobber", kind: "enemy", hitbox: { w: 16, h: 16 },
      behaviors: [{ type: "still" }, { type: "thrower", interval: 2.4, power: 250, speed: 90, defId: "enemy-lob" }], score: 300,
    }),
    define({
      id: "enemy-shot", name: "Shot", kind: "enemy", hitbox: { w: 6, h: 6 }, gravity: false,
      touchDamage: 1, stompable: false, hp: 1, score: 0,
      behaviors: [{ type: "shot", ttl: 3 }],
      activation: { range: 2000 },
    }),
    define({
      id: "enemy-lob", name: "Lob", kind: "enemy", hitbox: { w: 8, h: 8 }, gravity: true,
      touchDamage: 1, stompable: false, hp: 1, score: 0,
      behaviors: [{ type: "shot", ttl: 4 }],
      activation: { range: 2000 },
    }),
    define({
      id: "spring", name: "Spring", kind: "enemy", hitbox: { w: 14, h: 10 },
      touchDamage: 0, stompable: true, score: 0,
      reactions: [{ when: "stomped", do: [{ type: "bouncePlayer", power: 540 }, { type: "sfx", name: "spring" }] }],
    }),
    define({
      id: "item-block", name: "Item Block", kind: "solid", hitbox: { w: 16, h: 16 }, gravity: false,
      solid: true, touchDamage: 0, stompable: false,
      reactions: [{
        when: "hitFromBelow",
        do: [
          { type: "spawn", defId: "pickup-power", dy: -20, vy: -150 },
          { type: "becomeKind", defId: "item-block-used" },
          { type: "sfx", name: "item" },
        ],
      }],
    }),
    define({
      id: "item-block-used", name: "Used Block", kind: "solid", hitbox: { w: 16, h: 16 }, gravity: false,
      solid: true, touchDamage: 0, stompable: false,
    }),
    define({
      id: "pickup-power", name: "Power-Up", kind: "pickup", hitbox: { w: 12, h: 12 },
      touchDamage: 0, stompable: false, pickup: { effect: "power", value: 1 }, score: 1000,
    }),
    define({
      id: "pickup-star", name: "Star", kind: "pickup", hitbox: { w: 12, h: 12 },
      touchDamage: 0, stompable: false, pickup: { effect: "invincible", value: 1, duration: 8 }, score: 1000,
    }),
    define({
      id: "pickup-1up", name: "1-Up", kind: "pickup", hitbox: { w: 12, h: 12 },
      touchDamage: 0, stompable: false, pickup: { effect: "life", value: 1 }, score: 0,
    }),
    define({
      id: "pickup-clear", name: "Smart Bomb", kind: "pickup", hitbox: { w: 12, h: 12 },
      touchDamage: 0, stompable: false, pickup: { effect: "clearEnemies", value: 1 }, score: 500,
    }),
    define({
      id: "key", name: "Key", kind: "pickup", hitbox: { w: 10, h: 10 },
      touchDamage: 0, stompable: false, pickup: { effect: "key", value: 1 }, score: 100,
    }),
    define({
      id: "door", name: "Locked Door", kind: "solid", hitbox: { w: 16, h: 32 }, gravity: false,
      solid: true, touchDamage: 0, stompable: false,
      reactions: [{ when: "touchedPlayer", do: [{ type: "unlock" }] }],
    }),
    define({
      id: "switch-block", name: "Switch", kind: "enemy", hitbox: { w: 14, h: 8 },
      touchDamage: 0, stompable: true, score: 0,
      reactions: [{ when: "stomped", do: [{ type: "toggleSwitchGroup", tag: "gate-a" }, { type: "bouncePlayer" }, { type: "sfx", name: "switch" }] }],
    }),
    define({
      id: "gate", name: "Gate", kind: "solid", hitbox: { w: 16, h: 48 }, gravity: false,
      solid: true, touchDamage: 0, stompable: false, switchGroup: "gate-a",
    }),
    define({
      id: "elevator", name: "Elevator", kind: "solid", hitbox: { w: 32, h: 8 }, gravity: false,
      solid: true, touchDamage: 0, stompable: false,
      behaviors: [{ type: "path", speed: 40, mode: "pingpong", waypoints: [{ x: 0, y: 0 }, { x: 0, y: -64 }] }],
    }),
    define({
      id: "falling-platform", name: "Falling Platform", kind: "object", hitbox: { w: 24, h: 6 }, gravity: false,
      platform: true, touchDamage: 0, stompable: false,
      behaviors: [{ type: "falling", delay: 0.4 }],
    }),
    define({
      id: "crumble-platform", name: "Crumbling Platform", kind: "object", hitbox: { w: 24, h: 6 }, gravity: false,
      platform: true, touchDamage: 0, stompable: false,
      behaviors: [{ type: "crumble", delay: 0.5, respawn: 2.5 }],
    }),
    define({
      id: "warp-pipe", name: "Warp Pipe", kind: "object", hitbox: { w: 24, h: 16 }, gravity: false,
      touchDamage: 0, stompable: false, warp: { tag: "pipe-a", entry: "down" },
    }),
    define({
      id: "pattern-turret", name: "Pattern Turret", kind: "enemy", hitbox: { w: 16, h: 16 },
      score: 500, hp: 3,
      weapon: { patternId: "pattern-pendulum" },
      behaviors: [{ type: "still" }],
    }),
  ];
}

/** What an editor palette shows for the built-ins, keyed by definition id. */
export function actorPalette() {
  return [
    { defId: "walker", label: "Walker", meta: "Turns at walls", category: "ENEMIES" },
    { defId: "ledge-walker", label: "Ledge Walker", meta: "Turns at drops", category: "ENEMIES" },
    { defId: "coin", label: "Coin", meta: "Collect", category: "PICKUPS" },
    { defId: "flyer", label: "Flyer", meta: "Sine wave", category: "ENEMIES" },
    { defId: "hopper", label: "Hopper", meta: "Jumps along", category: "ENEMIES" },
    { defId: "chaser", label: "Chaser", meta: "Walks at you", category: "ENEMIES" },
    { defId: "charger", label: "Charger", meta: "Waits, then rushes", category: "ENEMIES" },
    { defId: "swooper", label: "Swooper", meta: "Dives from above", category: "ENEMIES" },
    { defId: "barrel", label: "Barrel", meta: "Rolls downhill", category: "ENEMIES" },
    { defId: "shell-walker", label: "Shell Walker", meta: "Stomp for a shell", category: "ENEMIES" },
    { defId: "spikeball", label: "Spikeball", meta: "No stomping this", category: "ENEMIES" },
    { defId: "turret-bot", label: "Turret", meta: "Aimed shots", category: "ENEMIES" },
    { defId: "lobber", label: "Lobber", meta: "Arcing lobs", category: "ENEMIES" },
    { defId: "pattern-turret", label: "Pattern Turret", meta: "Designed fire", category: "ENEMIES" },
    { defId: "barrel-spawner", label: "Barrel Spawner", meta: "Rolls them out", category: "OBJECTS" },
    { defId: "spring", label: "Spring", meta: "Big bounce", category: "OBJECTS" },
    { defId: "item-block", label: "Item Block", meta: "Bump from below", category: "OBJECTS" },
    { defId: "key", label: "Key", meta: "Opens doors", category: "PICKUPS" },
    { defId: "door", label: "Locked Door", meta: "Needs a key", category: "OBJECTS" },
    { defId: "switch-block", label: "Switch", meta: "Toggles gates", category: "OBJECTS" },
    { defId: "gate", label: "Gate", meta: "Switch-controlled", category: "OBJECTS" },
    { defId: "elevator", label: "Elevator", meta: "Rides a path", category: "OBJECTS" },
    { defId: "falling-platform", label: "Falling Platform", meta: "Drops when ridden", category: "OBJECTS" },
    { defId: "crumble-platform", label: "Crumbling Platform", meta: "Gives way, comes back", category: "OBJECTS" },
    { defId: "warp-pipe", label: "Warp Pipe", meta: "Press down to travel", category: "OBJECTS" },
    { defId: "pickup-power", label: "Power-Up", meta: "One power step", category: "PICKUPS" },
    { defId: "pickup-star", label: "Star", meta: "Brief invincibility", category: "PICKUPS" },
    { defId: "pickup-1up", label: "1-Up", meta: "One more life", category: "PICKUPS" },
    { defId: "pickup-clear", label: "Smart Bomb", meta: "Clears the screen", category: "PICKUPS" },
    { defId: "goal", label: "Goal", meta: "Clears the level", category: "OBJECTS" },
    { defId: "checkpoint", label: "Checkpoint", meta: "Respawn here", category: "OBJECTS" },
  ];
}

// -- levels --

/** @param {any} input */
export function normalizeCamera(input) {
  const mode = ["fixed", "roomFlip", "followX", "followXY", "autoScroll"].includes(input?.mode) ? input.mode : "followX";
  return {
    mode: /** @type {CameraMode} */ (mode),
    viewCols: clampTo(Math.round(Number(input?.viewCols) || 20), 8, 60),
    viewRows: clampTo(Math.round(Number(input?.viewRows) || 15), 6, 40),
    speed: clampTo(Number(input?.speed) || 40, 4, 400),
    lookAhead: clampTo(Math.round(Number(input?.lookAhead ?? 24)), 0, 200),
    deadZoneW: clampTo(Math.round(Number(input?.deadZoneW ?? 40)), 0, 300),
    deadZoneH: clampTo(Math.round(Number(input?.deadZoneH ?? 32)), 0, 300),
  };
}

/**
 * @param {any} input
 * @param {{tileSize?: number, makeId?: () => string}} [context]
 */
export function normalizeLevelDef(input, { tileSize = 16, makeId = () => "level" } = {}) {
  const cols = clampTo(Math.round(Number(input?.cols) || 40), 8, 1000);
  const rows = clampTo(Math.round(Number(input?.rows) || 15), 6, 100);
  const grid = (raw) => {
    // Accept either the packed pairs a document carries or a plain cell
    // array an editor holds, and store packed: the document form is the
    // normal form, and `unpackGrid` is one call away at stage creation.
    if (Array.isArray(raw?.rle)) return packGrid(unpackGrid(raw.rle, cols * rows));
    if (Array.isArray(raw)) {
      const cells = raw.slice(0, cols * rows).map((value) => clampTo(Math.round(Number(value) || 0), 0, 1023));
      while (cells.length < cols * rows) cells.push(0);
      return packGrid(cells);
    }
    return packGrid(new Array(cols * rows).fill(0));
  };
  const spawns = (Array.isArray(input?.spawns) ? input.spawns : [])
    .slice(0, 4)
    .map((point) => ({
      x: clampTo(Math.round(Number(point?.x) || 0), 0, cols * tileSize),
      y: clampTo(Math.round(Number(point?.y) || 0), 0, rows * tileSize),
    }));
  if (spawns.length === 0) spawns.push({ x: tileSize * 2, y: tileSize * 2 });
  return {
    id: typeof input?.id === "string" && input.id ? input.id.slice(0, 80) : makeId(),
    name: typeof input?.name === "string" && input.name ? input.name.slice(0, 60) : "Untitled Level",
    cols,
    rows,
    tilesetId: typeof input?.tilesetId === "string" && input.tilesetId ? input.tilesetId.slice(0, 80) : "tileset-basic",
    tiles: { rle: grid(input?.tiles) },
    back: { rle: grid(input?.back) },
    front: { rle: grid(input?.front) },
    parallax: {
      back: clampTo(Number(input?.parallax?.back ?? 0.5), 0, 2),
      front: clampTo(Number(input?.parallax?.front ?? 1.2), 0, 3),
    },
    camera: normalizeCamera(input?.camera),
    spawns,
    actors: (Array.isArray(input?.actors) ? input.actors : [])
      .slice(0, 500)
      .filter((placed) => placed && typeof placed.defId === "string" && placed.defId)
      .map((placed, index) => ({
        id: typeof placed.id === "string" && placed.id ? placed.id.slice(0, 80) : `placed-${index + 1}`,
        defId: placed.defId.slice(0, 80),
        ...(placed.appearance ? { appearance: normalizeAppearance(placed.appearance) } : {}),
        ...(typeof placed.componentId === "string" ? { componentId: placed.componentId.slice(0, 80) } : {}),
        x: clampTo(Math.round(Number(placed.x) || 0), -tileSize * 4, cols * tileSize + tileSize * 4),
        y: clampTo(Math.round(Number(placed.y) || 0), -tileSize * 8, rows * tileSize + tileSize * 8),
        dir: Number(placed.dir) === 1 ? 1 : -1,
      })),
    wind: {
      x: clampTo(Number(input?.wind?.x) || 0, -600, 600),
      y: clampTo(Number(input?.wind?.y) || 0, -600, 600),
    },
    timeLimit: clampTo(Math.round(Number(input?.timeLimit) || 0), 0, 3600),
    walls: input?.walls === "open" ? "open" : "solid",
  };
}

/** A blank level, ready to paint into. */
export function blankLevel(name = "Untitled Level", options = {}) {
  return normalizeLevelDef({ name, ...options });
}

// -- the game --

export function emptyGame(name = "Untitled Game") {
  return {
    version: RUNNJUMP_VERSION,
    name,
    tileSize: 16,
    rules: { lives: 3 },
    player: defaultHero(),
    tilesets: [defaultTileset(16)],
    actors: defaultActors(),
    assets: [],
    attract: null,
    patterns: defaultPatterns(),
    animations: [],
    levels: [blankLevel("Level 1")],
  };
}

/** Analogue channels an attract tape may carry. */
const ATTRACT_MAX_STICKS = 12;

/**
 * The longest legal frame state: 64 action bits, `|`, and two codes per stick
 * at five characters each (`-2047`) with commas between.
 *
 * This cap is load-bearing rather than decorative. It was 64 — exactly the
 * action limit — which was right while a state was only bits, and would have
 * silently truncated the stick codes off the end of every frame the day one
 * carried them. A tape that loses its analogue tail does not fail to load; it
 * plays a run where nobody aims.
 */
const ATTRACT_MAX_STATE = 64 + 1 + (ATTRACT_MAX_STICKS * 2 * 5) + (ATTRACT_MAX_STICKS * 2 - 1);

/**
 * The attract-mode demo: an authored run, riding the document, so an
 * exported game can play itself until a key is pressed — the oldest way a
 * game on a screen has ever said "someone made this, and it moves".
 *
 * The log is `net/input-log`'s own shape, validated structurally with caps
 * (a document a stranger shares). A recording is meaningful only against
 * the game it rides in and the level it names, which is exactly why it
 * travels INSIDE the document rather than beside it — the pairing cannot
 * be lost in the mail.
 *
 * @param {any} input
 */
export function normalizeAttract(input) {
  const log = input?.log;
  if (!input || typeof input !== "object" || !log || typeof log !== "object") return null;
  if (log.format !== "arcade-input-log") return null;
  // Refuse a tape this build cannot play, HERE, where documents are judged.
  // `createInputPlayer` throws on a future version, and the one consumer that
  // matters is an exported game booting straight into attract mode: a throw
  // there is a blank screen with no way in. A document from a newer build
  // still opens, minus a demo it was never going to be able to play.
  if (Number(log.version) > INPUT_LOG_VERSION) return null;
  if (!Array.isArray(log.actions) || log.actions.length === 0 || log.actions.length > 128) return null;
  if (!Array.isArray(log.frames)) return null;
  const steps = clampTo(Math.round(Number(log.steps) || 0), 0, 72000);
  if (steps === 0) return null;
  const sticks = Array.isArray(log.sticks)
    ? log.sticks.slice(0, ATTRACT_MAX_STICKS).map((name) => String(name).slice(0, 24))
    : [];
  return {
    levelIndex: clampTo(Math.round(Number(input.levelIndex) || 0), 0, 63),
    log: {
      format: "arcade-input-log",
      version: clampTo(Math.round(Number(log.version) || 1), 1, INPUT_LOG_VERSION),
      id: typeof log.id === "string" ? log.id.slice(0, 80) : "attract",
      seed: Math.round(Number(log.seed) || 1),
      actions: log.actions.slice(0, 128).map((name) => String(name).slice(0, 24)),
      sticks,
      steps,
      frames: log.frames.slice(0, 20000).map((frame) => [
        clampTo(Math.round(Number(frame?.[0]) || 0), 0, 72000),
        String(frame?.[1] ?? "").slice(0, ATTRACT_MAX_STATE),
      ]),
      meta: { players: clampTo(Math.round(Number(log.meta?.players) || 1), 1, 4), ...(log.meta?.runnjumpInput === 2 ? { runnjumpInput: 2 } : {}) },
    },
  };
}

/**
 * Clamp every field of a game into range, filling in whatever is absent.
 * The built-ins are always present, and an incoming definition with the same
 * id replaces one rather than sitting beside it — a game that shipped a
 * tweaked Walker must not end up with two of them.
 *
 * @param {any} [input]
 */
export function normalizeGame(input = {}) {
  const tileSize = clampTo(Math.round(Number(input.tileSize) || 16), 8, 32);

  const mergeById = (defaults, incoming, normalize) => {
    const list = defaults;
    for (const raw of Array.isArray(incoming) ? incoming.slice(0, 200) : []) {
      const entry = normalize(raw);
      const index = list.findIndex((existing) => existing.id === entry.id);
      if (index >= 0) list[index] = entry;
      else list.push(entry);
    }
    return list;
  };

  const tilesets = mergeById([defaultTileset(tileSize)], input.tilesets, (raw) => normalizeTileset(raw, tileSize));
  const actors = mergeById(defaultActors(), input.actors, normalizeActorDef);

  let levelCounter = 0;
  const makeId = () => `level-${levelCounter += 1}`;
  const levels = (Array.isArray(input.levels) ? input.levels : [])
    .slice(0, 64)
    .map((raw) => normalizeLevelDef(raw, { tileSize, makeId }));
  if (levels.length === 0) levels.push(blankLevel("Level 1"));

  return {
    version: RUNNJUMP_VERSION,
    name: typeof input.name === "string" && input.name ? input.name.slice(0, 80) : "Untitled Game",
    tileSize,
    rules: {
      lives: clampTo(Math.round(Number(input.rules?.lives) || 3), 1, 99),
    },
    player: normalizeHero(input.player),
    tilesets,
    actors,
    assets: normalizeAssets(input.assets),
    ...(Array.isArray(input.components) ? { components: [...new Map(input.components.slice(0, 100).map((entry) => { const component = normalizeComponent(entry); return [component.id, component]; })).values()] } : {}),
    ...(Array.isArray(input.weapons) ? { weapons: [...new Map(input.weapons.slice(0, 64).map((entry) => { const weapon = normalizeRunNJumpWeapon(entry); return [weapon.id, weapon]; })).values()] } : {}),
    ...(Array.isArray(input.defenses) ? { defenses: [...new Map(input.defenses.slice(0, 64).map((entry) => { const defense = normalizeRunNJumpDefense(entry); return [defense.id, defense]; })).values()] } : {}),
    ...(Array.isArray(input.sounds) ? { sounds: [...new Map(input.sounds.slice(0, 64).map((entry) => { const sound = normalizeRunNJumpSound(entry); return [sound.id, sound]; })).values()] } : {}),
    ...(Array.isArray(input.explosions) ? { explosions: [...new Map(input.explosions.slice(0, 64).map((entry) => { const explosion = normalizeRunNJumpExplosion(entry); return [explosion.id, explosion]; })).values()] } : {}),
    ...(input.effectDefaults ? { effectDefaults: normalizeRunNJumpEffects(input.effectDefaults) } : {}),
    attract: normalizeAttract(input.attract),
    patterns: mergeById(defaultPatterns(), input.patterns, (raw) => {
      let counter = 0;
      const anonymous = `pattern-anonymous-${counter += 1}`;
      return {
        ...normalizeBulletPattern(raw),
        id: typeof raw?.id === "string" && raw.id ? raw.id.slice(0, 80) : anonymous,
      };
    }),
    animations: (Array.isArray(input.animations) ? input.animations : [])
      .slice(0, 64)
      .map((raw, index) => ({
        id: typeof raw?.id === "string" && raw.id ? raw.id.slice(0, 80) : `animations-${index + 1}`,
        ...normalizeAnimationSet(raw),
      })),
    levels,
  };
}


/** Visual authoring values only: collision and deterministic movement are unchanged. */
export function normalizeAppearance(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) input = {};
  const number = (value, fallback, min, max) => {
    const n = Number(value ?? fallback);
    return Number.isFinite(n) ? clampTo(n, min, max) : fallback;
  };
  return {
    rotation: number(input.rotation, 0, -360, 360),
    scaleX: number(input.scaleX, 1, 0.1, 8), scaleY: number(input.scaleY, 1, 0.1, 8),
    tint: number(input.tint, 0, -360, 360), opacity: number(input.opacity, 1, 0, 1),
    glow: number(input.glow, 0, 0, 32), darken: number(input.darken, 0, 0, 1),
    soften: number(input.soften, 0, 0, 16), parallax: number(input.parallax, 1, 0, 3),
    layer: ["back", "main", "front"].includes(input.layer) ? input.layer : "main",
    depth: Math.round(number(input.depth, 0, -1000, 1000)),
  };
}

/** Flat templates cannot contain recursive components. Equipment reuses existing hero contracts. */
export function normalizeComponent(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) input = {};
  const kind = ["actors", "weapon", "armor", "satellite"].includes(input.kind) ? input.kind : "actors";
  const definitions = [...new Map((Array.isArray(input.definitions) ? input.definitions : []).filter((def) => def && typeof def === "object").slice(0, 64).map((def) => { const normalized = normalizeActorDef(def); return [normalized.id, normalized]; })).values()];
  const ids = new Set(definitions.map((def) => def.id));
  const coord = (value) => Number.isFinite(Number(value)) ? clampTo(Math.round(Number(value)), -32000, 32000) : 0;
  return {
    id: typeof input.id === "string" && input.id ? input.id.slice(0, 80) : "component",
    name: typeof input.name === "string" && input.name ? input.name.slice(0, 80) : "Component",
    kind,
    definitions: kind === "actors" ? definitions : [],
    placements: kind === "actors" ? (Array.isArray(input.placements) ? input.placements : []).slice(0, 64)
      .filter((placed) => placed && ids.has(placed.defId)).map((placed, index) => ({
        id: `member-${index + 1}`, defId: placed.defId, x: coord(placed.x), y: coord(placed.y),
        dir: Number(placed.dir) === 1 ? 1 : -1,
        ...(placed.appearance ? { appearance: normalizeAppearance(placed.appearance) } : {}),
      })) : [],
    ...(kind !== "actors" ? { hero: normalizeHero(input.hero) } : {}),
  };
}
