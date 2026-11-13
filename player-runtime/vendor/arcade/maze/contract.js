// What a maze level is made of.
//
// The grid genre: corridors, soft walls, bombs on a fuse, blasts that stop
// at masonry, pickups under the rubble, and the last one standing.
// Everything here is what a level *says*, and nothing here changes while a
// round is in progress — the world copies the tile grid before it starts
// breaking bricks out of it.
//
// There is no randomness anywhere in this genre, on purpose. Drops are
// authored under their bricks, enemy behaviour is a fixed rule per kind, and
// the only inputs are four directions and a button — which is what makes
// this the most deterministic genre in the package and the cheapest honest
// demonstration of co-op carrying a real game.

import {
  asBoolean,
  boundedInteger,
  boundedNumber,
  boundedString,
  oneOf,
} from "../core/validate.js";

export const MAZE_VERSION = 1;

/** The whole tile vocabulary, deliberately: floor, wall, brick. */
export const MAZE_FLOOR = 0;
/** Indestructible. The border and the pillars. */
export const MAZE_WALL = 1;
/** Destructible. Breaking one may reveal an authored drop. */
export const MAZE_BRICK = 2;

/**
 * One seat's frame of intent: a vector and a button.
 *
 * `move` is quantized at the edge (`core/stick`) and may arrive free or
 * already four-snapped — the world runs it through the four-way gate either
 * way, holding the gate's history per seat, so a stick rolled around the
 * gate keeps its direction and a key pressed over another turns at once
 * when the edge used `stickFromKeys`. `bomb` places on the rising edge.
 *
 * @typedef {object} MazeInput
 * @property {boolean} bomb
 * @property {{x: number, y: number}} move
 */

/** The action names, in wire order — append-only, the `net/input-log` rule. */
export const MAZE_ACTIONS = Object.freeze(["bomb"]);

/** The analogue channels, in wire order. Same append-only rule. */
export const MAZE_STICKS = Object.freeze(["move"]);

/** @returns {MazeInput} Nothing held, the stick centred. */
export function neutralMazeInput() {
  return { bomb: false, move: { x: 0, y: 0 } };
}

/** What a broken brick may reveal. */
export const MAZE_PICKUPS = Object.freeze(["bombs", "range", "speed"]);

/**
 * The enemy kinds, each a deterministic rule and a speed factor over the
 * level's base speed. `walker` goes straight until blocked and then prefers
 * a clockwise turn; `lefty` is its mirror — two of them diverge at the
 * first junction, which reads as variety without a die roll; `chaser`
 * walks axis-greedy toward the nearest living player, deciding only at
 * cell centres, x before y on ties.
 */
export const MAZE_ENEMY_KINDS = Object.freeze({
  walker: { speed: 0.75 },
  lefty: { speed: 0.75 },
  chaser: { speed: 0.85 },
});

/**
 * @typedef {object} MazeRules
 * @property {number} tile Cell size in px; positions are px, cells are
 *           column and row.
 * @property {number} speed Base walk speed, px/s. Enemies scale it by
 *           their kind; speed pickups add to it.
 * @property {number} bombs Starting bomb stock per seat.
 * @property {number} range Starting blast reach in cells, each direction.
 * @property {number} fuseTicks Steps from placement to detonation.
 * @property {number} flameTicks Steps a blast stays lethal after it fires.
 * @property {boolean} versus Last seat standing wins, instead of the
 *           co-op clear-the-enemies round.
 */

/**
 * @typedef {object} MazeLevel
 * @property {number} version
 * @property {string} name
 * @property {number} cols @property {number} rows
 * @property {number[]} tiles Row-major, `cols × rows`, values from the
 *           tile vocabulary. The border is always wall — the round is a
 *           sealed arena, and `normalizeMazeLevel` enforces it.
 * @property {Array<{col: number, row: number}>} playerSpawns Up to four;
 *           seats wrap onto them in order.
 * @property {Array<{kind: string, col: number, row: number}>} enemies
 * @property {Array<{col: number, row: number, kind: string}>} drops
 *           Authored under bricks — a drop on a floor cell grows its brick
 *           during normalization, because a drop with nothing to hide
 *           under is dead data.
 * @property {MazeRules} rules
 */

/**
 * The classic sealed field: a wall border, a pillar at every even-even
 * interior cell, four corner spawns, no bricks, no enemies. A playable
 * arena the moment it exists, and the canvas levels are authored on.
 *
 * @returns {MazeLevel}
 */
export function emptyMazeLevel(name = "Untitled Maze") {
  const cols = 15;
  const rows = 13;
  const tiles = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const border = col === 0 || row === 0 || col === cols - 1 || row === rows - 1;
      const pillar = col % 2 === 0 && row % 2 === 0;
      tiles.push(border || pillar ? MAZE_WALL : MAZE_FLOOR);
    }
  }
  return {
    version: MAZE_VERSION,
    name: boundedString(name, "Untitled Maze", 80),
    cols,
    rows,
    tiles,
    playerSpawns: [
      { col: 1, row: 1 },
      { col: cols - 2, row: rows - 2 },
      { col: cols - 2, row: 1 },
      { col: 1, row: rows - 2 },
    ],
    enemies: [],
    drops: [],
    rules: { tile: 16, speed: 60, bombs: 1, range: 2, fuseTicks: 150, flameTicks: 30, versus: false },
  };
}

/**
 * Clamp a level, trusting nothing — and repair it into a playable arena:
 * the border becomes wall, a tile code outside the vocabulary becomes
 * floor, spawn and enemy cells are cleared to floor (an author's placement
 * wins over an author's pillar), a drop grows its brick, and a level with
 * no spawns at all gets one.
 *
 * Idempotent, and `createMaze` runs it on whatever it is given.
 *
 * @param {any} [input]
 * @returns {MazeLevel}
 */
export function normalizeMazeLevel(input = {}) {
  const blank = emptyMazeLevel();
  const cols = boundedInteger(input.cols, blank.cols, 5, 99);
  const rows = boundedInteger(input.rows, blank.rows, 5, 99);
  const raw = Array.isArray(input.tiles) ? input.tiles : blank.cols === cols && blank.rows === rows ? blank.tiles : [];

  const tiles = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const value = raw[row * cols + col];
      const border = col === 0 || row === 0 || col === cols - 1 || row === rows - 1;
      tiles.push(border ? MAZE_WALL : oneOf(value, [MAZE_FLOOR, MAZE_WALL, MAZE_BRICK], MAZE_FLOOR));
    }
  }

  const interior = (cell, fallbackCol, fallbackRow) => ({
    col: boundedInteger(cell?.col, fallbackCol, 1, cols - 2),
    row: boundedInteger(cell?.row, fallbackRow, 1, rows - 2),
  });

  const playerSpawns = (Array.isArray(input.playerSpawns) ? input.playerSpawns : blank.playerSpawns)
    .slice(0, 4)
    .map((cell) => interior(cell, 1, 1));
  if (playerSpawns.length === 0) playerSpawns.push({ col: 1, row: 1 });
  for (const spawn of playerSpawns) tiles[spawn.row * cols + spawn.col] = MAZE_FLOOR;

  const enemies = (Array.isArray(input.enemies) ? input.enemies : [])
    .slice(0, 32)
    .map((enemy) => ({
      kind: oneOf(enemy?.kind, Object.keys(MAZE_ENEMY_KINDS), "walker"),
      ...interior(enemy, 1, 1),
    }));
  for (const enemy of enemies) tiles[enemy.row * cols + enemy.col] = MAZE_FLOOR;

  const occupied = new Set([
    ...playerSpawns.map((cell) => cell.row * cols + cell.col),
    ...enemies.map((cell) => cell.row * cols + cell.col),
  ]);
  const drops = (Array.isArray(input.drops) ? input.drops : [])
    .slice(0, 64)
    .map((drop) => ({
      ...interior(drop, 1, 1),
      kind: oneOf(drop?.kind, [...MAZE_PICKUPS], "bombs"),
    }))
    // A drop under a wall can never be revealed, and a drop under someone's
    // spawn would brick them in; refuse both rather than quietly shipping
    // unreachable data or an unplayable arena.
    .filter((drop) => tiles[drop.row * cols + drop.col] !== MAZE_WALL && !occupied.has(drop.row * cols + drop.col));
  for (const drop of drops) tiles[drop.row * cols + drop.col] = MAZE_BRICK;

  const rawRules = input.rules && typeof input.rules === "object" ? input.rules : {};
  return {
    version: MAZE_VERSION,
    name: boundedString(input.name, blank.name, 80),
    cols,
    rows,
    tiles,
    playerSpawns,
    enemies,
    drops,
    rules: {
      tile: boundedInteger(rawRules.tile, blank.rules.tile, 8, 64),
      speed: boundedNumber(rawRules.speed, blank.rules.speed, 20, 240),
      bombs: boundedInteger(rawRules.bombs, blank.rules.bombs, 1, 8),
      range: boundedInteger(rawRules.range, blank.rules.range, 1, 12),
      fuseTicks: boundedInteger(rawRules.fuseTicks, blank.rules.fuseTicks, 30, 1000),
      flameTicks: boundedInteger(rawRules.flameTicks, blank.rules.flameTicks, 1, 300),
      versus: asBoolean(rawRules.versus, false),
    },
  };
}
