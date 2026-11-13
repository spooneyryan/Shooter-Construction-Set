// What a scrolling-shooter level is made of.
//
// Lifted from Starline, which is the only game here that had an authoring model
// for this genre at all — so this is promotion of the implementation that
// already existed rather than a new design, which is how every other module in
// this package arrived.
//
// The split that matters is between this file and `world.js`: everything here
// is what a level *says*, and nothing here changes while a run is in progress.
// The world reads it and never writes to it, which is what lets one authored
// level be replayed, raced or rewound without being copied first.

import { uniqueId } from "../core/validate.js";
import { normalizeHitbox } from "./hitbox.js";
import { normalizeAssets } from "../sprite/assets.js";
// A level can carry designed explosions and sounds the way it already carries
// sprite assets and bullet patterns: as documents, normalized by the module
// that owns the format. shmup does not know what a burst or a sound IS, only
// that it has an owner who can clean one.
import { normalizeBurst } from "../burst/contract.js";
import { normalizeSfx } from "../sfx/synth.js";
import { createPatternPreset, normalizeBulletPattern } from "./patterns.js";

// Sprite assets were promoted to their own module (`../sprite`) on
// 2026-08-22; this re-export is why no consumer had to notice. New code
// should import from `@ccllc/arcade/sprite`.
export { normalizeAssets };

/**
 * Plain clamp, and deliberately not `core/validate`'s `boundedNumber`.
 *
 * That one takes a fallback and exists for values arriving from outside the
 * program, where "not a number" is a case you have to answer. Most of the
 * arithmetic here already holds a real number and only wants it kept in range;
 * routing it through a sanitizer would say something untrue about where the
 * value came from.
 */
export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/** The design resolution a level is authored and simulated in. */
export const VIEW_W = 1280;
export const VIEW_H = 640;

/**
 * The three shapes a level can take. An item's x is always "how far along the
 * level" and its y "where across it", whatever the mode -- what changes is
 * only which way that maps onto the screen, and, for the arena, whether the
 * camera shifts positions at all (there it is purely the wave clock).
 */
export const LEVEL_MODES = ["horizontal", "vertical", "arena"];

/**
 * The view's extent along the scroll axis and across it, per mode.
 *
 * Vertical swaps the pair: the scroll window is the screen's height and the
 * playfield is its full width. The arena is one unscrolled screen, so it keeps
 * the horizontal spans -- its `along` is the activation clock's window, which
 * is what keeps `length`, progress and victory meaning what they always have.
 *
 * @param {"horizontal"|"vertical"|"arena"} [mode]
 * @returns {{along: number, cross: number}}
 */
export function viewSpans(mode) {
  // Vertical is the 640 square, letterboxed on the wide screen: the scroll
  // window is the screen's height and the playfield is that same height
  // across, because the editor's strip is 640 tall and an authoring surface
  // must be able to reach everything the mode can play. The wide screen's
  // flanks are the renderer's to dress.
  return mode === "vertical" ? { along: VIEW_H, cross: VIEW_H } : { along: VIEW_W, cross: VIEW_H };
}
/** The player's collision radius. Sprites vary; the hitbox does not. */
export const PLAYER_R = 20;

/**
 * How wide the player's ship actually is, so collision can be the sprite
 * rather than a constant.
 *
 * A custom sprite is drawn at its own dimensions, so those ARE the ship's
 * size. A built-in hull has no pixels and falls back to the `2 * PLAYER_R` it
 * has always been drawn at, which is what keeps every existing level playing
 * exactly as it did at `scale: 1`.
 *
 * It lives here rather than in a renderer because that is what stops the drawn
 * ship and the hit ship drifting apart — the engine already reads
 * `level.assets`, so this costs nothing new.
 */
export function playerExtent(player, assets = []) {
  const scale = Number(player?.scale) || 1;
  const sprite = player?.sprite ?? "dart";
  if (typeof sprite === "string" && sprite.startsWith("asset:")) {
    const asset = assets.find((entry) => `asset:${entry.id}` === sprite);
    if (asset) return Math.max(1, Math.max(Number(asset.width) || 0, Number(asset.height) || 0)) * scale;
  }
  return PLAYER_R * 2 * scale;
}

/** Half {@link playerExtent}: what the collision checks compare against. */
export function playerRadius(player, assets = []) {
  return playerExtent(player, assets) / 2;
}

/** How wide the satellite is struck, in units. Its sprite is drawn larger. */
export const SATELLITE_HIT_RADIUS = 15;

/**
 * How wide a thing is struck, in units: the radius of the circle the world
 * tests against, for a given striker.
 *
 * The number depends on WHAT is striking, and always has -- an enemy is a
 * wider target to a bullet than to the ship's nose, and wider to the nose
 * than to the satellite. The three were literals sitting in three collision
 * loops; they are one table here because the editor draws these circles and
 * must draw the circles the world actually uses, not a copy that drifts.
 *
 * A striker that cannot hit this kind of thing gets 0: nothing collides with
 * a decoration, and only the ship collects a pickup. The world's loops filter
 * by type before they ask, so a 0 never decides anything there; it is the
 * overlay that needs "no circle" to mean no circle.
 */
export function itemHitRadius(item, against = "bullet") {
  // A group is answered as one of its members, because that is what it becomes:
  // `expandLevel` turns a group into one enemy per offset, each carrying this
  // item's size. The world therefore never asks about a "group" -- it only ever
  // holds expanded enemies -- but an editor holds the authored item, and this
  // has to answer for what the author is looking at.
  const solid = item.type === "enemy" || item.type === "terrain" || item.type === "group";
  const collectable = item.type === "powerup" || item.type === "upgrade";
  const share = against === "bullet" ? (solid ? 0.78 : 0)
    : against === "satellite" ? (solid ? 0.65 : 0)
    : against === "ship" ? (solid ? 0.7 : collectable ? 1 : 0)
    : 0;
  return share ? item.size * item.scale * share : 0;
}

/**
 * @typedef {"horizontal"|"vertical"|"arena"} LevelMode
 * @typedef {"enemy"|"terrain"|"group"|"powerup"|"upgrade"|"decoration"} ItemType
 * @typedef {"straight"|"sine"|"zigzag"|"arc"|"bezier"|"stationary"|"lane"|"figureEight"|"arcWeave"|"surge"|"charge"|"dart"|"plunge"} MovePattern
 * @typedef {"line"|"vee"|"ring"|"column"|"block"|"wedge"|"ladder"|"crescent"|"cluster"} GroupPattern
 * @typedef {"pulse"|"spread"|"rapid"} GunType
 * @typedef {"none"|"standard"|"heavy"|"ablative"|"forcefield"} ArmorType
 * @typedef {"orbit"|"tether"|"aim"} SatelliteMode
 */

/**
 * @typedef {object} Movement
 * @property {MovePattern} pattern
 * @property {number} speed Pixels per second, leftward.
 * @property {number} amplitude
 * @property {number} frequency Cycles per second.
 */

/**
 * @typedef {object} Weapon
 * @property {boolean} enabled
 * @property {string} projectile
 * @property {number} shotsPerSecond
 * @property {number} cooldown Extra seconds between bursts.
 * @property {number} projectileSpeed
 * @property {number} power
 * @property {"straight"|"sine"} projectileMovement
 */

/**
 * @typedef {object} ArmorSettings
 * @property {ArmorType} type
 * @property {number} capacity Damage units for a field, hull pips otherwise.
 * @property {number} damageMultiplier
 * @property {number} rechargeDelay
 * @property {number} rechargeRate
 */

/**
 * @typedef {object} GroupSettings
 * @property {number} count
 * @property {GroupPattern} pattern
 * @property {number} spacing
 */

const ARMOR_DEFAULTS = {
  forcefield: { capacity: 300, damageMultiplier: 1, rechargeDelay: 2.5, rechargeRate: 70 },
  heavy: { capacity: 5, damageMultiplier: 0.55, rechargeDelay: 0, rechargeRate: 0 },
  ablative: { capacity: 4, damageMultiplier: 0.72, rechargeDelay: 0, rechargeRate: 0 },
  none: { capacity: 3, damageMultiplier: 1, rechargeDelay: 0, rechargeRate: 0 },
  standard: { capacity: 3, damageMultiplier: 0.82, rechargeDelay: 0, rechargeRate: 0 },
};

/**
 * @param {ArmorType} [type]
 * @returns {ArmorSettings}
 */
export function defaultArmor(type = "standard") {
  const base = ARMOR_DEFAULTS[type] ?? ARMOR_DEFAULTS.standard;
  return { type, ...base };
}

export function defaultSatellite() {
  return { enabled: false, mode: "orbit", range: 105, speed: 360, weaponId: "weapon-pulse", armor: defaultArmor("forcefield") };
}

export function defaultPlayer() {
  return {
    sprite: "dart", tint: 0, xSpeed: 330, ySpeed: 330, limits: { left: 4, right: 42, top: 7, bottom: 7 }, shotSpeed: 800, shotPower: 100, gun: "pulse",
    weaponSlots: [{ id: "slot-primary", name: "PRIMARY", accepts: "standard", weaponId: "weapon-pulse" }],
    inventoryLimit: 5,
    inventory: ["weapon-pulse", "weapon-spread", "weapon-rapid"],
    armor: defaultArmor("standard"),
    satellite: defaultSatellite(),
  };
}

/**
 * @param {MovePattern} [pattern]
 * @returns {Movement}
 */
/** Every way a thing can fly. An unknown one has always flown straight. */
export const MOVE_PATTERNS = [
  "straight", "sine", "zigzag", "arc", "bezier", "stationary",
  // Appended, never reordered: this array is the gate normalizeMovement checks,
  // and a value missing from it is silently rewritten to "straight" on every
  // save and load rather than failing loudly.
  "lane", "figureEight", "arcWeave", "surge", "charge", "dart", "plunge",
];

/**
 * The shapes a formation can take. `vee` is also the fallback an unrecognised
 * pattern lands on, which is what every level saved before this array existed
 * relied on.
 */
export const GROUP_PATTERNS = ["line", "vee", "ring", "column", "block", "wedge", "ladder", "crescent", "cluster"];

/**
 * The curve a fresh bezier starts as: ahead and up, ahead and down, then
 * straight ahead -- an S that shows all three handles doing something, in the
 * angle-0 frame where ahead is leftward.
 */
export function defaultBezierPoints() {
  return [{ x: -140, y: -90 }, { x: -280, y: 90 }, { x: -420, y: 0 }];
}

/**
 * A movement keeps every field it arrived with; only the two this version
 * added are clamped, and only when present. Adding `angle: 0` to every saved
 * level would change how each one serialises for no change in how it flies, so
 * absent stays absent and the world reads absent as zero.
 */
function normalizeMovement(movement) {
  const { angle: rawAngle, curve: rawCurve, points: rawPoints, spin: rawSpin, gravity: rawGravity, stall: rawStall, lock: rawLock, ...rest } = movement && typeof movement === "object" ? movement : baseMovement("straight");
  const angle = Number(rawAngle);
  const curve = Number(rawCurve);
  const spin = Number(rawSpin);
  const gravity = Number(rawGravity);
  const stall = Number(rawStall);
  const lock = Number(rawLock);
  const pattern = MOVE_PATTERNS.includes(rest.pattern) ? rest.pattern : "straight";
  // A bezier always has three good points -- a missing or nonsense one takes
  // its slot's default -- and a shape authored under another pattern is kept,
  // so switching away and back does not lose the curve.
  const point = (raw, fallback) => (raw && Number.isFinite(Number(raw.x)) && Number.isFinite(Number(raw.y))
    ? { x: clamp(Number(raw.x), -2000, 2000), y: clamp(Number(raw.y), -2000, 2000) }
    : fallback);
  const points = pattern === "bezier" || Array.isArray(rawPoints)
    ? defaultBezierPoints().map((fallback, index) => point(Array.isArray(rawPoints) ? rawPoints[index] : undefined, fallback))
    : undefined;
  return {
    ...rest,
    pattern,
    ...(points ? { points } : {}),
    // Wrapped into [-180, 180): 0 is leftward flight, positive toward the top.
    ...(Number.isFinite(angle) ? { angle: ((angle % 360) + 540) % 360 - 180 } : {}),
    // Degrees per second the arc turns its heading, same sign convention.
    ...(Number.isFinite(curve) ? { curve: clamp(curve, -360, 360) } : {}),
    // Degrees per second the sprite turns as it flies -- a tumbling rock, a
    // spinning mine. Absent is the still sprite every level before this had.
    ...(Number.isFinite(spin) ? { spin: clamp(spin, -720, 720) } : {}),
    // How hard a plunge falls, in units per second per second. Absent is the
    // 240 the path uses by default; ignored by every other pattern.
    ...(Number.isFinite(gravity) ? { gravity: clamp(gravity, 0, 2000) } : {}),
    // Seconds it waits, in view, before flying its path at all. The wait is
    // timed from the moment the player can SEE it rather than from its spawn:
    // an entity wakes well off the right edge, and a wait keyed on age alone
    // would be spent where nobody could watch it happen.
    ...(Number.isFinite(stall) ? { stall: clamp(stall, 0, 8) } : {}),
    // How far the path turns toward the player's row when the wait ends: 0
    // flies the authored angle, 1 goes straight at where they were standing.
    // Resolved once, by the world, at the instant of release -- so the dive is
    // a constant from there and the path stays a closed form in age.
    ...(Number.isFinite(lock) ? { lock: clamp(lock, 0, 1) } : {}),
  };
}

export function baseMovement(pattern = "straight") {
  return {
    pattern,
    speed: pattern === "stationary" ? 0 : 72,
    // Every pattern whose shape IS a wobble needs one to start with, or it
    // is placed looking exactly like a straight line and reads as broken.
    amplitude: ["sine", "zigzag", "lane", "figureEight", "arcWeave", "surge"].includes(pattern) ? 70 : 0,
    frequency: 0.45,
  };
}

/**
 * @param {boolean} [enabled]
 * @returns {Weapon}
 */
export function baseWeapon(enabled = true) {
  return {
    enabled,
    projectile: "bolt",
    shotsPerSecond: 0.7,
    cooldown: 1.1,
    projectileSpeed: 300,
    power: 1,
    projectileMovement: "straight",
  };
}

/**
 * The weapons, armour and satellites every level starts with.
 *
 * These carry fixed ids rather than generated ones, because a level references
 * its equipment by id and a level authored against one copy of these must open
 * against another.
 */
export function defaultComponents() {
  return [
    { id: "weapon-pulse", name: "Pulse Cannon", kind: "weapon", weapon: { ...baseWeapon(true), tag: "standard", gun: "pulse", spread: 1, shotsPerSecond: 6.8, cooldown: 0, projectileSpeed: 800, power: 100, color: "#eaff62" } },
    { id: "weapon-spread", name: "Spread Cannon", kind: "weapon", weapon: { ...baseWeapon(true), tag: "standard", gun: "spread", spread: 3, shotsPerSecond: 4.2, cooldown: 0, projectileSpeed: 760, power: 100, color: "#64e3ff" } },
    { id: "weapon-rapid", name: "Rapid Blaster", kind: "weapon", weapon: { ...baseWeapon(true), tag: "light", gun: "rapid", spread: 1, shotsPerSecond: 12.5, cooldown: 0, projectileSpeed: 900, power: 70, color: "#ffcf61" } },
    { id: "armor-forcefield", name: "Recharge Field", kind: "armor", armor: defaultArmor("forcefield") },
    { id: "satellite-orbiter", name: "Orbiter Satellite", kind: "satellite", satellite: defaultSatellite() },
    // Ids inside the seeded pattern are deterministic for the same reason the
    // component ids above are fixed: every copy of the built-ins must be the
    // same built-ins, or two normalizations of one level would disagree.
    { id: "pattern-pendulum", name: "Pendulum Sweep", kind: "pattern", pattern: { ...createPatternPreset("Pendulum Sweep", pendulumIds()), id: "pattern-pendulum-definition" } },
  ];
}

/** Stable, sequenced ids for the one built-in pattern. */
function pendulumIds() {
  let counter = 0;
  return () => `pendulum-${counter += 1}`;
}

/**
 * Whether a component may go in a slot. `any` accepts everything; otherwise the
 * weapon's tag has to match exactly.
 */
export function weaponFitsSlot(component, accepts) {
  if (!component || component.kind !== "weapon" || !component.weapon) return false;
  return accepts === "any" || component.weapon.tag === accepts;
}

/**
 * The built-in object types, with the labels an editor palette wants.
 *
 * Kept beside `makeItem` rather than in a game, because the key and its label
 * are one fact and splitting them puts the enum in two places.
 */
export const palette = [
  { key: "scout", label: "Scout", meta: "Straight / light", sprite: "orb", category: "ENEMIES" },
  { key: "brute", label: "Brute", meta: "Straight / heavy", sprite: "diamond", category: "ENEMIES" },
  { key: "gunship", label: "Gunship", meta: "Sine / armed", sprite: "turret", category: "ENEMIES" },
  { key: "raider", label: "Raider", meta: "Fast zigzag", sprite: "raider", category: "ENEMIES" },
  { key: "wraith", label: "Wraith", meta: "Wide sine", sprite: "wraith", category: "ENEMIES" },
  { key: "carrier", label: "Carrier", meta: "Heavy weapons", sprite: "carrier", category: "ENEMIES" },
  { key: "asteroid", label: "Asteroid", meta: "Static terrain", sprite: "asteroid", category: "TERRAIN" },
  { key: "lineGroup", label: "Line", meta: "5-unit formation", sprite: "orb", category: "GROUPS" },
  { key: "veeGroup", label: "V Formation", meta: "5-unit formation", sprite: "blade", category: "GROUPS" },
  { key: "ringGroup", label: "Ring", meta: "8-unit formation", sprite: "diamond", category: "GROUPS" },
  { key: "columnGroup", label: "Column", meta: "Single file", sprite: "orb", category: "GROUPS" },
  { key: "blockGroup", label: "Block", meta: "9-unit phalanx", sprite: "diamond", category: "GROUPS" },
  { key: "wedgeGroup", label: "Wedge", meta: "10-unit delta", sprite: "blade", category: "GROUPS" },
  { key: "overdrive", label: "Overdrive", meta: "Temporary multi-boost", sprite: "energy", category: "POWERUPS" },
  { key: "powerCore", label: "Power Core", meta: "Timed firepower", sprite: "energy", category: "POWERUPS" },
  { key: "spreadUpgrade", label: "Spread Cannon", meta: "Permanent new gun", sprite: "upgrade", category: "UPGRADES" },
  { key: "reactorUpgrade", label: "Reactor", meta: "Permanent stat boost", sprite: "upgrade", category: "UPGRADES" },
  { key: "planet", label: "Planet", meta: "Background parallax", sprite: "planet", category: "DECORATIONS" },
  { key: "nebula", label: "Nebula", meta: "Translucent backdrop", sprite: "nebula", category: "DECORATIONS" },
  { key: "wreck", label: "Shipwreck", meta: "Foreground object", sprite: "wreck", category: "DECORATIONS" },
  { key: "comet", label: "Comet", meta: "Moving foreground", sprite: "comet", category: "DECORATIONS" },
];

/**
 * One placed object of a built-in type.
 *
 * @param {string} key A `palette` key.
 * @param {number} x
 * @param {number} y
 * @param {() => string} [makeId] Injected so a test, or a replay, can have
 *        stable ids. The default reaches for `crypto.randomUUID`, which is
 *        exactly what a recorded simulation must not do.
 */
export function makeItem(key, x, y, makeId = () => uniqueId("item")) {
  const common = { id: makeId(), x, y, scale: 1, rotation: 0, tint: 0, hitPoints: 100 };
  if (key === "scout") return { ...common, type: "enemy", name: "Scout", sprite: "orb", size: 28, movement: baseMovement("straight"), weapon: baseWeapon(true) };
  if (key === "brute") return { ...common, type: "enemy", name: "Brute", sprite: "diamond", size: 46, hitPoints: 300, movement: { ...baseMovement("straight"), speed: 38 }, weapon: { ...baseWeapon(true), projectile: "plasma", shotsPerSecond: 0.4, power: 2 } };
  if (key === "gunship") return { ...common, type: "enemy", name: "Sine Gunship", sprite: "turret", size: 34, hitPoints: 200, movement: { ...baseMovement("sine"), speed: 55, amplitude: 90 }, weapon: { ...baseWeapon(true), shotsPerSecond: 1.1, projectileMovement: "sine" } };
  if (key === "raider") return { ...common, type: "enemy", name: "Raider", sprite: "raider", size: 30, hitPoints: 100, movement: { ...baseMovement("zigzag"), speed: 105, amplitude: 54, frequency: 0.7 }, weapon: baseWeapon(false) };
  if (key === "wraith") return { ...common, type: "enemy", name: "Wraith", sprite: "wraith", size: 36, hitPoints: 200, movement: { ...baseMovement("sine"), speed: 92, amplitude: 120, frequency: 0.32 }, weapon: { ...baseWeapon(true), shotsPerSecond: 0.8 } };
  if (key === "carrier") return { ...common, type: "enemy", name: "Carrier", sprite: "carrier", size: 62, hitPoints: 600, movement: { ...baseMovement("straight"), speed: 26 }, weapon: { ...baseWeapon(true), projectile: "plasma", shotsPerSecond: 0.65, power: 2 } };
  if (key === "asteroid") return { ...common, type: "terrain", name: "Asteroid", sprite: "asteroid", size: 58, hitPoints: 500, movement: baseMovement("stationary"), weapon: baseWeapon(false) };
  if (key === "overdrive") return { ...common, type: "powerup", name: "Overdrive", sprite: "energy", size: 22, hitPoints: 0, movement: baseMovement("stationary"), weapon: baseWeapon(false), pickup: { duration: 8, xSpeedBoost: 80, ySpeedBoost: 80, shotSpeedBoost: 160, shotPowerBoost: 100, gun: "rapid" } };
  if (key === "powerCore") return { ...common, type: "powerup", name: "Power Core", sprite: "energy", size: 24, hitPoints: 0, movement: { ...baseMovement("sine"), speed: 10, amplitude: 35 }, weapon: baseWeapon(false), pickup: { duration: 12, xSpeedBoost: 0, ySpeedBoost: 0, shotSpeedBoost: 80, shotPowerBoost: 200, gun: "none" } };
  if (key === "spreadUpgrade") return { ...common, type: "upgrade", name: "Spread Cannon", sprite: "upgrade", size: 24, hitPoints: 0, movement: baseMovement("stationary"), weapon: baseWeapon(false), pickup: { duration: 0, xSpeedBoost: 0, ySpeedBoost: 0, shotSpeedBoost: 0, shotPowerBoost: 0, gun: "spread" } };
  if (key === "reactorUpgrade") return { ...common, type: "upgrade", name: "Reactor Upgrade", sprite: "upgrade", size: 24, hitPoints: 0, movement: baseMovement("stationary"), weapon: baseWeapon(false), pickup: { duration: 0, xSpeedBoost: 35, ySpeedBoost: 35, shotSpeedBoost: 100, shotPowerBoost: 100, gun: "none" } };
  if (key === "planet" || key === "nebula" || key === "wreck" || key === "comet") {
    const foreground = key === "wreck" || key === "comet";
    return {
      ...common, type: "decoration", name: key[0].toUpperCase() + key.slice(1), sprite: key,
      size: key === "nebula" ? 170 : key === "planet" ? 110 : 80,
      hitPoints: 0,
      movement: key === "comet" ? { ...baseMovement("straight"), speed: 45 } : baseMovement("stationary"),
      weapon: baseWeapon(false),
      decoration: { layer: foreground ? "foreground" : "background", opacity: foreground ? 0.75 : 0.38, parallax: foreground ? 1.35 : 0.42 },
    };
  }
  const pattern = key === "lineGroup" ? "line"
    : key === "ringGroup" ? "ring"
    : key === "columnGroup" ? "column"
    : key === "blockGroup" ? "block"
    : key === "wedgeGroup" ? "wedge"
    : "vee";
  return {
    ...common,
    type: "group",
    name: pattern === "line" ? "Line Formation"
      : pattern === "ring" ? "Ring Formation"
      : pattern === "column" ? "Column"
      : pattern === "block" ? "Block Formation"
      : pattern === "wedge" ? "Wedge Formation"
      : "V Formation",
    sprite: key === "ringGroup" ? "blade" : "orb",
    size: 25,
    hitPoints: 100,
    movement: { ...baseMovement(key === "lineGroup" ? "zigzag" : key === "columnGroup" ? "lane" : key === "wedgeGroup" ? "charge" : "sine"), speed: 52, amplitude: 55 },
    weapon: { ...baseWeapon(true), shotsPerSecond: 0.35 },
    group: { count: pattern === "ring" ? 8 : pattern === "block" ? 9 : pattern === "wedge" ? 10 : 5, pattern, spacing: 68 },
  };
}

/** An empty level, ready to place things into. */
export function emptyLevel(name = "Untitled Sector") {
  return {
    version: LEVEL_VERSION,
    name,
    mode: "horizontal",
    length: 9000,
    player: defaultPlayer(),
    assets: [],
    components: defaultComponents(),
    items: [],
  };
}

// 4: levels carry a `mode`. A v3 document still parses -- the field defaults
// to horizontal below -- while a v4 vertical level handed to a pre-mode build
// is refused as `future` by the envelope rather than silently played sideways.
export const LEVEL_VERSION = 4;

/**
 * Clamp every field of a level into range, filling in whatever is absent.
 *
 * This is the half of loading a document that genuinely differs per game, which
 * is why `core/document` leaves it to the caller — `defineFormat` owns the
 * envelope and the transport, and hands the body to something like this. See
 * `shmup/document.js`, which wires the two together.
 */
/**
 * What an item does when things happen to it, as references into
 * `Level.components` rather than inline documents.
 *
 * References, because "per enemy type" is the whole point: a dozen raiders
 * should share one explosion, and editing it should reach all of them. Inlining
 * would make each copy drift the moment one was edited, and would put a
 * multi-layer burst document on every item in the level.
 *
 * An id that names nothing is kept rather than dropped. A level whose
 * explosion Component was deleted should draw the default and still remember
 * what it wanted, so that re-adding the Component restores it; silently
 * clearing the field turns a recoverable mistake into a lost edit.
 */
/**
 * The halo a sprite is drawn with.
 *
 * Presentation, and in the level for the same reason `tint` is: it belongs to
 * the thing rather than to the renderer, and a shared sector should arrive
 * looking the way its author left it. The engine never draws it.
 *
 * Absent means "whatever the renderer's default is for this sprite", which is
 * how every level saved before this keeps its current look — the alternative,
 * writing a default in on normalize, would silently freeze today's art
 * direction into every old file.
 */
function normalizeGlow(glow) {
  if (!glow || typeof glow !== "object") return undefined;
  const colour = typeof glow.color === "string" && /^#[0-9a-fA-F]{3,8}$/.test(glow.color) ? glow.color : undefined;
  const blur = Number(glow.blur);
  if (colour === undefined && !Number.isFinite(blur)) return undefined;
  return {
    color: colour ?? "#ff6a4d",
    // Zero is meaningful: it is how a sprite is drawn with no halo at all.
    blur: clamp(Number.isFinite(blur) ? blur : 11, 0, 60),
  };
}

/**
 * How far back a sprite sits in the scene: darkened toward the backdrop and
 * softened at the edges, rather than faded.
 *
 * Deliberately NOT alpha, which is the whole point of the field. The starfield
 * is drawn behind everything, so any transparency puts stars *inside* the
 * artwork -- which is exactly what an author reaching for "distant" does not
 * want. Darkening keeps the sprite opaque and mixes it toward the dark the
 * backdrop already is; blurring softens the outline. A sprite can be pushed
 * back without being seen through.
 *
 * Absent by default, so every level saved before this draws as it did. Zero is
 * meaningful once the object exists: it is "authored, and set to none".
 */
function normalizeDepth(depth) {
  if (!depth || typeof depth !== "object") return undefined;
  const darken = Number(depth.darken);
  const blur = Number(depth.blur);
  if (!Number.isFinite(darken) && !Number.isFinite(blur)) return undefined;
  return {
    darken: clamp(Number.isFinite(darken) ? darken : 0, 0, 1),
    blur: clamp(Number.isFinite(blur) ? blur : 0, 0, 40),
  };
}

/**
 * How far a sprite turns to face the way it is flying.
 *
 * A rocket riding a sine wave should nose into the wave rather than stay level
 * and bob. `follow` is how much of the heading it takes: 0 stays level (what
 * every level saved before this did), 1 points straight along its velocity, and
 * the numbers between lean without fully committing -- which is the amount
 * Ryan asked to be adjustable. The engine only stores this; the renderer reads
 * the heading off `vx`/`vy` and turns the picture, so nothing here affects
 * collision or replay.
 */
function normalizeHeading(heading) {
  if (!heading || typeof heading !== "object") return undefined;
  const follow = Number(heading.follow);
  if (!Number.isFinite(follow)) return undefined;
  return { follow: clamp(follow, 0, 1) };
}

/**
 * Where a weapon sits on its ship: an offset from the ship's centre in the
 * ship's own frame, `x` forward -- the way it faces and fires -- and `y`
 * across, positive toward the bottom of the screen for an unrotated ship. The
 * sprite's rotation turns it. Absent is where every weapon has always fired
 * from, the nose, so a level saved before this is placed bit for bit.
 */
function normalizeMount(mount) {
  if (!mount || typeof mount !== "object") return undefined;
  const x = Number(mount.x);
  const y = Number(mount.y);
  if (!Number.isFinite(x) && !Number.isFinite(y)) return undefined;
  return { x: clamp(Number.isFinite(x) ? x : 0, -240, 240), y: clamp(Number.isFinite(y) ? y : 0, -240, 240) };
}

/**
 * A weapon keeps what it arrived with; its pattern and its mount are the two
 * fields that are clamped, and each only when present.
 */
function normalizeWeaponFields(weapon) {
  if (!weapon || typeof weapon !== "object") return weapon;
  const { mount: rawMount, ...rest } = weapon;
  const mount = normalizeMount(rawMount);
  return {
    ...rest,
    ...(rest.pattern ? { pattern: normalizeBulletPattern(rest.pattern) } : {}),
    ...(mount ? { mount } : {}),
  };
}

/**
 * A formation, validated. Nothing checked this before: `normalizeItem` spread
 * the item and let `group` through untouched, so a hand-edited or pasted level
 * could reach `groupOffsets` with a count of -3 (no members at all), a spacing
 * of "wide" (every member at NaN, drawn nowhere and hittable by nothing) or a
 * pattern nobody implemented. An unrecognised pattern still becomes the vee,
 * because that is the branch every such level has always fallen into.
 */
/**
 * A screen-blocker: a body the scroll waits for.
 *
 * `station` is where along the view it parks, as a percentage of the view's own
 * along span measured from the near edge -- the same unit the ship's flight
 * limits are authored in. The camera may not pass `x - along * station / 100`
 * while the thing is alive, so the stop line is a pure function of authored
 * data: an editor can draw exactly where play will park. What neither can know
 * is how LONG it parks, because that is the player's kill.
 *
 * Only a body that can die may hold one. Nothing in the world ever clears a
 * decoration's `alive` -- every collision loop filters to enemy or terrain, or
 * to the pickups the ship's nose collects -- so a decoration given a blocker
 * would stop the scroll for the rest of the run with nothing the player could
 * do about it. A group would be `count` hold lines rather than one.
 *
 * `indestructible` is the same hole by another road, and the only thing holding
 * it shut. Nothing in the world clears such a body's `alive`: shots spark off it
 * and never reach its hit points, and contact sparks too -- it costs whatever
 * rammed it and leaves the body standing -- so the camera would wait on a kill
 * that cannot happen. The blocker is what gives way rather than the
 * indestructibility, because dropping the blocker leaves a coherent thing -- an
 * obstacle you fly around -- where dropping the other leaves a boss whose
 * durability the author never chose.
 *
 * Bounded away from both edges: 100 parks it off the right of the screen where
 * it could never be shot, 0 parks it on top of the player.
 */
function normalizeBlocker(blocker, type, indestructible) {
  if (!blocker || typeof blocker !== "object") return undefined;
  if (type !== "enemy" && type !== "terrain") return undefined;
  if (indestructible) return undefined;
  const station = Number(blocker.station);
  return { station: clamp(Number.isFinite(station) ? station : 72, 25, 90) };
}

function normalizeGroup(group) {
  if (!group || typeof group !== "object") return undefined;
  return {
    pattern: GROUP_PATTERNS.includes(group.pattern) ? group.pattern : "vee",
    count: clamp(Math.round(Number(group.count) || 5), 1, 24),
    spacing: clamp(Number(group.spacing) || 60, 8, 400),
    // Seconds between one member leaving and the next. With a stall, this is
    // the peeling escort: the formation holds together in view and then goes
    // one at a time. Absent, every member leaves at once, as they always have.
    ...(Number.isFinite(Number(group.peel)) && Number(group.peel) > 0 ? { peel: clamp(Number(group.peel), 0, 4) } : {}),
  };
}

function normalizeItemEffects(fx) {
  if (!fx || typeof fx !== "object") return undefined;
  const id = (value) => (typeof value === "string" && value ? value : undefined);
  const out = {
    explosionId: id(fx.explosionId),
    deathSoundId: id(fx.deathSoundId),
    fireSoundId: id(fx.fireSoundId),
  };
  return out.explosionId || out.deathSoundId || out.fireSoundId ? out : undefined;
}

/**
 * Where the ship may fly: how far in from each edge of the screen it must
 * stay, as a percentage of the view's width (left, right) or height (top,
 * bottom), measured from that edge. In the sector's own frame; a vertical
 * level turns them with it.
 *
 * A level from before the four-edge box carried `forwardLimit`, the far edge
 * as a share of the width measured from the LEFT: it becomes `right` measured
 * from its own edge, and the other three take the margins the world always
 * clamped to -- 4% of the width and 7% of the height, which is 52 and 45
 * units of the 1280 x 640 view give or take a unit.
 *
 * `right` may reach 80, because a `forwardLimit` of 20 could; the others stop
 * at 45 so the box can never close.
 */
function normalizeLimits(limits, forwardLimit) {
  const source = limits && typeof limits === "object" ? limits : {};
  const legacy = Number(forwardLimit);
  const legacyRight = forwardLimit !== undefined && forwardLimit !== null && forwardLimit !== "" && Number.isFinite(legacy) ? 100 - clamp(legacy, 20, 92) : undefined;
  const pick = (key, fallback, max) => {
    const raw = source[key];
    const value = raw === undefined || raw === null || raw === "" ? NaN : Number(raw);
    return clamp(Number.isFinite(value) ? value : fallback, 0, max);
  };
  return { left: pick("left", 4, 45), right: pick("right", legacyRight ?? 42, 80), top: pick("top", 7, 45), bottom: pick("bottom", 7, 45) };
}

export function normalizeLevel(input = {}) {
  const player = { ...defaultPlayer(), ...(input.player ?? {}) };

  const normalizeArmor = (armor, fallback = "standard") => {
    const base = defaultArmor(armor?.type ?? fallback);
    return {
      ...base,
      ...armor,
      capacity: Math.max(0, Number(armor?.capacity ?? base.capacity)),
      damageMultiplier: clamp(Number(armor?.damageMultiplier ?? base.damageMultiplier), 0.1, 2),
      rechargeDelay: Math.max(0, Number(armor?.rechargeDelay ?? base.rechargeDelay)),
      rechargeRate: Math.max(0, Number(armor?.rechargeRate ?? base.rechargeRate)),
    };
  };

  const normalizeItem = (item) => ({
    ...item,
    scale: clamp(Number(item.scale) || 1, 0.25, 4),
    rotation: Number.isFinite(Number(item.rotation)) ? Number(item.rotation) : 0,
    tint: ((Number(item.tint) || 0) % 360 + 360) % 360,
    hitPoints: item.hitPoints ?? (item.type === "terrain" ? 500 : 100),
    armor: item.armor ? normalizeArmor(item.armor, "none") : undefined,
    weapon: normalizeWeaponFields(item.weapon),
    pickup: item.pickup,
    decoration: item.decoration,
    fx: normalizeItemEffects(item.fx),
    glow: normalizeGlow(item.glow),
    depth: normalizeDepth(item.depth),
    heading: normalizeHeading(item.heading),
    group: normalizeGroup(item.group),
    movement: normalizeMovement(item.movement),
    // Only ever true or absent, so a level that never set it saves as it did.
    indestructible: item.indestructible === true ? true : undefined,
    // The body the scroll waits for. Absent is every level before this, which
    // waits for nothing.
    blocker: normalizeBlocker(item.blocker, item.type, item.indestructible === true),
    // The shape it is struck within, when a circle is not enough. Absent is
    // the circle, as always; see hitbox.js for the frame it is authored in.
    hitbox: normalizeHitbox(item.hitbox),
  });

  const items = Array.isArray(input.items) ? input.items.map(normalizeItem) : [];

  const incoming = Array.isArray(input.components) ? input.components.map((component) => ({
    ...component,
    object: component.object ? normalizeItem(component.object) : undefined,
    weapon: component.weapon
      ? {
        ...baseWeapon(true), ...component.weapon,
        tag: component.weapon.tag || "standard",
        gun: component.weapon.gun || "pulse",
        spread: clamp(Number(component.weapon.spread) || 1, 1, 5),
        color: component.weapon.color || "#eaff62",
        pattern: component.weapon.pattern ? normalizeBulletPattern(component.weapon.pattern) : undefined,
      }
      : undefined,
    pattern: component.pattern ? normalizeBulletPattern(component.pattern) : undefined,
    explosion: component.explosion ? normalizeBurst(component.explosion) : undefined,
    sound: component.sound ? normalizeSfx(component.sound) : undefined,
    armor: component.armor ? normalizeArmor(component.armor) : undefined,
    satellite: component.satellite
      ? { ...defaultSatellite(), ...component.satellite, armor: normalizeArmor(component.satellite.armor, "forcefield") }
      : undefined,
  })) : [];

  // The built-ins are always present, and an incoming definition with the same
  // id replaces one rather than sitting beside it. A level that shipped a
  // tweaked Pulse Cannon must not end up with two of them.
  const components = defaultComponents();
  for (const component of incoming) {
    const index = components.findIndex((entry) => entry.id === component.id);
    if (index >= 0) components[index] = component;
    else components.push(component);
  }

  const slots = Array.isArray(player.weaponSlots) && player.weaponSlots.length
    ? player.weaponSlots.map((slot, index) => {
      // The slot is the hardpoint, so the mount lives here rather than on the
      // weapon that happens to be in it.
      const mount = normalizeMount(slot.mount);
      return {
        id: slot.id || `slot-${index}`,
        name: slot.name || `SLOT ${index + 1}`,
        accepts: slot.accepts || "standard",
        weaponId: slot.weaponId || "weapon-pulse",
        ...(mount ? { mount } : {}),
      };
    })
    : [{
      id: "slot-primary", name: "PRIMARY", accepts: "standard",
      weaponId: player.gun === "spread" ? "weapon-spread" : player.gun === "rapid" ? "weapon-rapid" : "weapon-pulse",
    }];

  const inventoryLimit = clamp(Number(player.inventoryLimit) || 5, 1, 12);

  return {
    version: LEVEL_VERSION,
    name: typeof input.name === "string" ? input.name : "Untitled Sector",
    mode: LEVEL_MODES.includes(input.mode) ? input.mode : "horizontal",
    length: Math.max(1600, Number(input.length) || 9000),
    player: {
      // The three size knobs `scale` replaced are stripped rather than carried
      // through by this spread: a level holding both `scale: 4` and a stale
      // `size: 54` invites the next reader to wonder which one wins.
      ...(({ size, scaleX, scaleY, forwardLimit, ...rest }) => rest)(player),
      tint: ((Number(player.tint) || 0) % 360 + 360) % 360,
      xSpeed: Math.max(50, Number(player.xSpeed) || 330),
      ySpeed: Math.max(50, Number(player.ySpeed) || 330),
      // The raw input's box, not the merged one: the default box would
      // otherwise stand in front of a legacy forwardLimit and hide it.
      limits: normalizeLimits(input.player?.limits, player.forwardLimit),
      shotSpeed: Math.max(100, Number(player.shotSpeed) || 800),
      shotPower: Math.max(100, Number(player.shotPower) || 100),
      // ONE number, because the three it replaces said overlapping things: a
      // "size" plus an X and a Y scale could each make the ship bigger, and no
      // combination of them was obviously canonical. The sprite's own
      // dimensions are the ship's size; this scales that.
      //
      // Migrated rather than dropped, so a level authored against the three
      // keeps the ship it had: the old pair multiplied a 27-unit base, which
      // is what `size / 27 * scaleX` recovers.
      scale: clamp(
        Number(player.scale)
          || (player.size || player.scaleX ? (Number(player.size) || 27) / 27 * (Number(player.scaleX) || 1) : 1),
        0.05, 8,
      ),
      glow: normalizeGlow(player.glow),
      weaponSlots: slots.slice(0, 4),
      inventoryLimit,
      inventory: Array.isArray(player.inventory) ? player.inventory.slice(0, inventoryLimit) : ["weapon-pulse"],
      armor: normalizeArmor(player.armor),
      satellite: { ...defaultSatellite(), ...(player.satellite ?? {}), armor: normalizeArmor(player.satellite?.armor, "forcefield") },
    },
    items,
    assets: normalizeAssets(input.assets),
    components,
    // The piece that plays while this level does, named by id. The audio
    // itself is not here and never will be: a track is megabytes where a whole
    // level is kilobytes, so the editor keeps the files beside the level
    // rather than inside it, and a level names one. Absent is silence.
    ...(typeof input.music === "string" && input.music ? { music: input.music } : {}),
  };
}
