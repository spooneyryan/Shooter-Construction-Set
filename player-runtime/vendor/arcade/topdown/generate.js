// A floor from a seed.
//
// The crawl flavour's missing piece: the Map document was specified as
// "either authored contents or a generator seed" (docs/TOPDOWN.md §4.1),
// and this is the second half. Rooms are placed where they fit and each is
// joined to the one before it, so **the floor is connected by
// construction** rather than by a check afterwards — the failure mode this
// avoids is the one that matters, a stairway walled off behind nothing.
//
// It rolls the module's own dice (`topdown/random`), which means a floor
// is reproducible from one integer. That is what makes "come and beat the
// dungeon I found" a share link rather than a payload, and it is the
// reason the generator lives here rather than in a game: the seed travels
// in the world document, so the same number produces the same night on
// every machine that opens it.
//
// What comes back is a raw map DOCUMENT, not a run — plain data for
// `normalizeTopdownMap` to clamp like anything an author typed. Nothing
// here is privileged.

import {
  TOPDOWN_FLOOR,
  TOPDOWN_HAZARD,
  TOPDOWN_WALL,
  TOPDOWN_WATER,
} from "./contract.js";
import { createRandomState, randomInt, randomNext, randomWeighted } from "./random.js";

/**
 * @param {object} [options]
 * @param {number} [options.seed] One integer reproduces the whole floor.
 * @param {number} [options.cols] @param {number} [options.rows]
 * @param {number} [options.tile]
 * @param {number} [options.tries] Room placement attempts; more tries is a
 *        denser floor, not a bigger one.
 * @param {number} [options.roomMin] @param {number} [options.roomMax] Room
 *        size in tiles, inclusive.
 * @param {Array<{defId: string, weight?: number}>} [options.enemies] Rolled
 *        per room after the first — the spawn room stays quiet, which is
 *        the oldest courtesy in the genre.
 * @param {number} [options.density] Enemies per room, on average.
 * @param {Array<{pickup: string, weight?: number}>} [options.items]
 * @param {number} [options.itemChance] Per room, after the first.
 * @param {boolean} [options.exit] Put a stairway in the last room.
 * @param {number} [options.puddles] How many water/hazard patches to dab in.
 * @param {string} [options.id] @param {string} [options.name]
 */
export function generateTopdownFloor({
  seed = 1,
  cols = 48,
  rows = 32,
  tile = 16,
  tries = 60,
  roomMin = 4,
  roomMax = 9,
  enemies = [],
  density = 2,
  items = [],
  itemChance = 0.5,
  exit = true,
  puddles = 3,
  id = "floor",
  name = "Generated Floor",
} = {}) {
  const random = createRandomState(seed);
  const tiles = new Array(cols * rows).fill(TOPDOWN_WALL);
  const at = (col, row) => row * cols + col;

  const carveRect = (col, row, width, height, code = TOPDOWN_FLOOR) => {
    for (let y = row; y < row + height; y += 1) {
      for (let x = col; x < col + width; x += 1) {
        if (x > 0 && y > 0 && x < cols - 1 && y < rows - 1) tiles[at(x, y)] = code;
      }
    }
  };

  /** @type {Array<{col: number, row: number, cols: number, rows: number}>} */
  const rooms = [];
  const overlaps = (col, row, width, height) => rooms.some((room) =>
    // One tile of margin, so two rooms never share a wall and the corridor
    // between them is always a real corridor.
    col - 1 < room.col + room.cols + 1 && room.col - 1 < col + width + 1 &&
    row - 1 < room.row + room.rows + 1 && room.row - 1 < row + height + 1);

  for (let attempt = 0; attempt < tries; attempt += 1) {
    const width = roomMin + randomInt(random, Math.max(1, roomMax - roomMin + 1));
    const height = roomMin + randomInt(random, Math.max(1, roomMax - roomMin + 1));
    const col = 1 + randomInt(random, Math.max(1, cols - width - 2));
    const row = 1 + randomInt(random, Math.max(1, rows - height - 2));
    if (overlaps(col, row, width, height)) continue;
    carveRect(col, row, width, height);
    rooms.push({ col, row, cols: width, rows: height });
  }

  const centreOf = (room) => ({
    col: room.col + Math.floor(room.cols / 2),
    row: room.row + Math.floor(room.rows / 2),
  });

  // Each room joined to the one before it: connectivity by construction.
  // The corner order is rolled, which is the only thing that makes two
  // floors with the same rooms feel different.
  for (let index = 1; index < rooms.length; index += 1) {
    const from = centreOf(rooms[index - 1]);
    const to = centreOf(rooms[index]);
    const horizontalFirst = randomNext(random) < 0.5;
    const corner = horizontalFirst ? { col: to.col, row: from.row } : { col: from.col, row: to.row };
    const line = (a, b) => {
      const stepCol = Math.sign(b.col - a.col);
      const stepRow = Math.sign(b.row - a.row);
      let { col, row } = a;
      // A two-tile-wide corridor: one tile reads as a crack, and a body
      // twelve pixels wide in a sixteen-pixel lane has no room to slide.
      while (col !== b.col || row !== b.row) {
        carveRect(col, row, 2, 2);
        if (col !== b.col) col += stepCol;
        else if (row !== b.row) row += stepRow;
      }
      carveRect(b.col, b.row, 2, 2);
    };
    line(from, corner);
    line(corner, to);
  }

  // A few puddles and spike patches, for texture rather than difficulty.
  for (let index = 0; index < puddles && rooms.length > 1; index += 1) {
    const room = rooms[1 + randomInt(random, rooms.length - 1)];
    const code = randomNext(random) < 0.5 ? TOPDOWN_WATER : TOPDOWN_HAZARD;
    const width = 1 + randomInt(random, Math.min(3, room.cols));
    const height = 1 + randomInt(random, Math.min(3, room.rows));
    carveRect(room.col + randomInt(random, Math.max(1, room.cols - width)),
      room.row + randomInt(random, Math.max(1, room.rows - height)), width, height, code);
  }

  const placedActors = [];
  const placedItems = [];
  for (let index = 1; index < rooms.length; index += 1) {
    const room = rooms[index];
    const many = Math.round(density);
    for (let count = 0; count < many; count += 1) {
      const defId = randomWeighted(random, enemies.map((row) => ({ weight: row.weight ?? 1, value: row.defId })));
      if (!defId) continue;
      placedActors.push({
        defId,
        x: (room.col + randomInt(random, room.cols)) * tile + 2,
        y: (room.row + randomInt(random, room.rows)) * tile + 2,
      });
    }
    if (items.length > 0 && randomNext(random) < itemChance) {
      const pickup = randomWeighted(random, items.map((row) => ({ weight: row.weight ?? 1, value: row.pickup })));
      if (pickup) {
        const spot = centreOf(room);
        placedItems.push({ pickup, x: spot.col * tile + 4, y: spot.row * tile + 4 });
      }
    }
  }

  const first = rooms[0] ?? { col: 1, row: 1, cols: 2, rows: 2 };
  const last = rooms[rooms.length - 1] ?? first;
  const spawnCell = centreOf(first);
  const exitCell = centreOf(last);

  return {
    id,
    name,
    cols,
    rows,
    tile,
    tiles,
    // ONE room over the whole floor: this is the free-roaming model, and
    // the reason it needs no second structure. The carved chambers are
    // shapes in the grid, not entries in the room list — a crawl wants a
    // camera that follows, not one that pages.
    rooms: [{ id: "floor", col: 0, row: 0, cols, rows, gate: "none" }],
    doors: exit && rooms.length > 1
      ? [{ id: "stairs", col: exitCell.col, row: exitCell.row, to: "", lock: "none" }]
      : [],
    actors: placedActors,
    items: placedItems,
    spawn: { x: spawnCell.col * tile + 2, y: spawnCell.row * tile + 2 },
    camera: { mode: "followXY", viewCols: 20, viewRows: 15, deadZoneW: 64, deadZoneH: 48 },
  };
}
