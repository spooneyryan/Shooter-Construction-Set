// Tiles: the vocabulary a 2DRunNJump level's geometry is written in.
//
// A tile is a *shape* plus flags — what blocks, what stands, what hurts —
// and nothing about how it looks beyond a sprite name the renderer may use.
// The grid is an array of indices into a tileset, and the built-in tileset
// carries fixed indices for the same reason `shmup`'s built-in components
// carry fixed ids: a level authored against one copy of the built-ins must
// open against another.
//
// Run-length encoding lives here too, because the interesting property of a
// platform level is that it is mostly the same number over and over — a
// 200×15 map is 3,000 cells and perhaps sixty runs — and a document that
// wants to fit in a share link cares about the difference.

import { clampTo } from "../sprite/assets.js";

/** @typedef {"empty"|"solid"|"oneWay"|"slope"|"ladder"|"hazard"|"liquid"|"bounce"|"breakable"|"conveyor"} TileShape */
/** @typedef {"normal"|"ice"|"mud"} TileSurface */

/**
 * @typedef {object} TileDef
 * @property {TileShape} shape
 * @property {string} name
 * @property {TileSurface} surface Friction override for whatever stands on it.
 * @property {{left: number, right: number}} slope Surface height at the tile's
 *           left and right edges, in pixels from the tile TOP — 16 is the
 *           floor of a 16px tile, 0 its ceiling. Only read when the shape is
 *           `slope`. Slopes have a floor and nothing else: no side or ceiling
 *           collision, which is what makes walking into one from the side a
 *           climb rather than a wall.
 * @property {number} conveyor Pixels per second added along the floor, signed.
 * @property {number} bouncePower Upward launch speed for `bounce`, px/s.
 * @property {number} damage For `hazard`.
 * @property {string} sprite Asset id. Presentation only; the simulation never
 *           reads it.
 * @property {number} tint Hue rotation, presentation only.
 */

export const TILE_SHAPES = Object.freeze([
  "empty", "solid", "oneWay", "slope", "ladder", "hazard",
  "liquid", "bounce", "breakable", "conveyor",
]);

/** Shapes a box may never occupy. Everything else is condition- or edge-based. */
const BLOCKING_SHAPES = new Set(["solid", "breakable", "bounce", "conveyor"]);

/** @param {TileDef} def */
export function tileBlocks(def) {
  return BLOCKING_SHAPES.has(def.shape);
}

/**
 * @param {any} input
 * @param {number} tileSize
 * @returns {TileDef}
 */
export function normalizeTile(input, tileSize = 16) {
  const shape = TILE_SHAPES.includes(input?.shape) ? input.shape : "empty";
  return {
    shape,
    name: typeof input?.name === "string" ? input.name.slice(0, 40) : shape,
    surface: input?.surface === "ice" || input?.surface === "mud" ? input.surface : "normal",
    slope: {
      left: clampTo(Math.round(Number(input?.slope?.left ?? tileSize)), 0, tileSize),
      right: clampTo(Math.round(Number(input?.slope?.right ?? tileSize)), 0, tileSize),
    },
    conveyor: clampTo(Number(input?.conveyor) || 0, -240, 240),
    bouncePower: clampTo(Number(input?.bouncePower) || 0, 0, 1200),
    damage: clampTo(Math.round(Number(input?.damage ?? 1)), 0, 99),
    sprite: typeof input?.sprite === "string" ? input.sprite.slice(0, 80) : "",
    tint: ((Number(input?.tint) || 0) % 360 + 360) % 360,
  };
}

/**
 * The built-in tileset. **The indices are the contract**: grids reference
 * tiles by position in this array, so entries are appended, never reordered
 * and never removed — the same one-way ratchet as a document version.
 *
 * @param {number} [tileSize]
 */
export function defaultTileset(tileSize = 16) {
  const t = (input) => normalizeTile(input, tileSize);
  const full = tileSize;
  const half = Math.round(tileSize / 2);
  return {
    id: "tileset-basic",
    name: "Basic",
    tiles: [
      t({ shape: "empty", name: "air" }),                                              // 0
      t({ shape: "solid", name: "block", sprite: "tile-block" }),                      // 1
      t({ shape: "oneWay", name: "platform", sprite: "tile-platform" }),               // 2
      t({ shape: "ladder", name: "ladder", sprite: "tile-ladder" }),                   // 3
      t({ shape: "hazard", name: "spikes", damage: 1, sprite: "tile-spikes" }),        // 4
      t({ shape: "slope", name: "slope up-right", slope: { left: full, right: 0 }, sprite: "tile-slope-ur" }),   // 5
      t({ shape: "slope", name: "slope up-left", slope: { left: 0, right: full }, sprite: "tile-slope-ul" }),    // 6
      t({ shape: "slope", name: "girder up-right low", slope: { left: full, right: half }, sprite: "tile-girder-ur-a" }), // 7
      t({ shape: "slope", name: "girder up-right high", slope: { left: half, right: 0 }, sprite: "tile-girder-ur-b" }),   // 8
      t({ shape: "slope", name: "girder up-left low", slope: { left: half, right: full }, sprite: "tile-girder-ul-a" }),  // 9
      t({ shape: "slope", name: "girder up-left high", slope: { left: 0, right: half }, sprite: "tile-girder-ul-b" }),    // 10
      t({ shape: "liquid", name: "water", sprite: "tile-water" }),                     // 11
      t({ shape: "bounce", name: "spring block", bouncePower: 520, sprite: "tile-spring" }), // 12
      t({ shape: "breakable", name: "brick", sprite: "tile-brick" }),                  // 13
      t({ shape: "conveyor", name: "belt left", conveyor: -60, sprite: "tile-belt-l" }), // 14
      t({ shape: "conveyor", name: "belt right", conveyor: 60, sprite: "tile-belt-r" }), // 15
      t({ shape: "solid", name: "ice block", surface: "ice", sprite: "tile-ice" }),    // 16
      t({ shape: "solid", name: "mud block", surface: "mud", sprite: "tile-mud" }),    // 17
      // Scenery. Solid in shape, because shape is only how a tile DRAWS on
      // the back and front layers -- collision reads the main grid alone --
      // and `tint` is what tells them apart from terrain on sight. Painted
      // on the main layer they behave as ordinary blocks, which is a useful
      // thing to have and not a trap.
      t({ shape: "solid", name: "hill", tint: 210, sprite: "tile-hill" }),             // 18
      t({ shape: "solid", name: "foliage", tint: 120, sprite: "tile-foliage" }),       // 19
      t({ shape: "solid", name: "far tower", tint: 260, sprite: "tile-tower" }),       // 20
    ],
  };
}

/**
 * @param {any} input
 * @param {number} tileSize
 */
export function normalizeTileset(input, tileSize = 16) {
  const tiles = (Array.isArray(input?.tiles) ? input.tiles : [])
    .slice(0, 256)
    .map((tile) => normalizeTile(tile, tileSize));
  if (tiles.length === 0) tiles.push(normalizeTile({ shape: "empty" }, tileSize));
  // Index 0 is air by fiat. A tileset whose zero blocks would make an empty
  // grid a solid wall, and an author cannot see why.
  if (tiles[0].shape !== "empty") tiles[0] = normalizeTile({ shape: "empty" }, tileSize);
  return {
    id: typeof input?.id === "string" && input.id ? input.id.slice(0, 80) : "tileset",
    name: typeof input?.name === "string" && input.name ? input.name.slice(0, 80) : "Tileset",
    tiles,
  };
}

/**
 * The floor height of a tile at a horizontal position inside it, in pixels
 * from the tile's top: `tileSize` is the very bottom, 0 the very top. Solid
 * shapes floor at 0 (their top edge); slopes interpolate.
 *
 * @param {TileDef} def
 * @param {number} xInTile 0..tileSize-1
 * @param {number} tileSize
 */
export function tileSurfaceAt(def, xInTile, tileSize) {
  if (def.shape !== "slope") return 0;
  const t = clampTo(xInTile, 0, tileSize - 1) / (tileSize - 1);
  return def.slope.left + (def.slope.right - def.slope.left) * t;
}

// -- run-length encoding --

/**
 * Pack a grid into `[value, count, value, count, …]` pairs.
 *
 * @param {ArrayLike<number>} cells
 * @returns {number[]}
 */
export function packGrid(cells) {
  const packed = [];
  let index = 0;
  while (index < cells.length) {
    const value = cells[index];
    let count = 1;
    while (index + count < cells.length && cells[index + count] === value) count += 1;
    packed.push(value, count);
    index += count;
  }
  return packed;
}

/**
 * Unpack to exactly `length` cells: excess is truncated, shortfall is
 * zero-filled, and garbage counts cannot make it allocate more than asked
 * for — a grid arrives inside documents strangers share.
 *
 * @param {ArrayLike<number>} packed
 * @param {number} length
 * @returns {number[]}
 */
export function unpackGrid(packed, length) {
  const cells = new Array(length).fill(0);
  let at = 0;
  for (let index = 0; index + 1 < packed.length && at < length; index += 2) {
    const value = clampTo(Math.round(Number(packed[index]) || 0), 0, 1023);
    const count = Math.min(Math.max(Math.round(Number(packed[index + 1]) || 0), 0), length - at);
    cells.fill(value, at, at + count);
    at += count;
  }
  return cells;
}
