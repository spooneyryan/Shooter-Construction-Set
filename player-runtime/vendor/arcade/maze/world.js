// The round: what a run of a maze level does.
//
// Lane movement with cornering assist, bombs on a fuse, blasts that stop at
// masonry and chain through each other in the tick they start, authored
// drops, deterministic enemies, and the outcome rules — co-op clears the
// enemies, versus is the last seat standing.
//
// The same contract as every world here. **Data in, state out** — nothing
// draws, nothing reads a clock; everything noteworthy is a queued event the
// renderer drains. **Deterministic across machines** — the arithmetic is
// `+ - * /` and comparisons (the four-way gate's magnitude goes through
// `core/trig`'s hypot), there is no randomness anywhere in the genre, and
// the banned-Math test steps a full round. **It snapshots** — plain data,
// the mutable tile grid included, because rollback cannot be retrofitted.
//
// The step's phase order is part of the simulation and must never be
// reshuffled: players (snap, move, place) → enemies → fuses and chains →
// pickups → deaths → flames age → outcome. Two machines disagreeing about
// whether a pickup was grabbed before the flame crossed it is a desync,
// not a nuance.

import { snapStick } from "../core/stick.js";
import {
  MAZE_BRICK,
  MAZE_ENEMY_KINDS,
  MAZE_FLOOR,
  MAZE_WALL,
  normalizeMazeLevel,
} from "./contract.js";

/** A speed pickup's px/s bonus, and the most a seat can stack. */
const MAZE_SPEED_STEP = 10;
const MAZE_SPEED_CAP = 60;
/** Scored to the blast's owner. */
const MAZE_ENEMY_POINTS = 100;
const MAZE_BRICK_POINTS = 10;

/**
 * @param {import("./contract.js").MazeLevel | object} level Normalized or
 *        raw — `normalizeMazeLevel` runs here either way.
 * @param {object} [options]
 * @param {number} [options.players] Seats, 1 to 4, wrapped onto the
 *        level's spawns in order.
 */
export function createMaze(level, { players = 1 } = {}) {
  const spec = normalizeMazeLevel(level);
  const seats = Math.max(1, Math.min(4, Math.round(players) || 1));
  const { cols, rows } = spec;
  const tile = spec.rules.tile;

  /** Mutable during the round — bricks break out of it. */
  const tiles = [...spec.tiles];
  const cellIndex = (col, row) => row * cols + col;
  const centerOf = (cell) => cell * tile + tile / 2;
  const cellOf = (coordinate) => Math.floor(coordinate / tile);

  /** Authored drops by cell, looked up when a brick breaks. */
  const dropAt = new Map(spec.drops.map((drop) => [cellIndex(drop.col, drop.row), drop.kind]));

  const playerSeats = [];
  for (let seat = 0; seat < seats; seat += 1) {
    const spawn = spec.playerSpawns[seat % spec.playerSpawns.length];
    playerSeats.push({
      seat,
      x: centerOf(spawn.col),
      y: centerOf(spawn.row),
      alive: true,
      facing: { x: 0, y: 1 },
      /** The four-way gate's history — what it last returned and what the
       *  edge last sent. Simulation state; both snapshot. */
      held: { x: 0, y: 0 },
      rawHeld: { x: 0, y: 0 },
      /** Last tick's bomb bit, for the rising edge. */
      pressing: false,
      stock: spec.rules.bombs,
      /** Bombs currently burning down; they return to stock on detonation. */
      active: 0,
      range: spec.rules.range,
      speedBonus: 0,
      score: 0,
    });
  }

  const enemies = spec.enemies.map((enemy) => ({
    kind: enemy.kind,
    x: centerOf(enemy.col),
    y: centerOf(enemy.row),
    dir: { x: 0, y: 1 },
    targetCol: enemy.col,
    targetRow: enemy.row,
    alive: true,
  }));
  const startingEnemies = enemies.length;

  /** @type {Array<{col: number, row: number, seat: number, range: number, ticksLeft: number}>} */
  let bombs = [];
  /** @type {Array<{cells: number[], seat: number, ticksLeft: number}>} lethal while ticksLeft > 0. */
  let blasts = [];
  /** @type {Array<{col: number, row: number, kind: string}>} */
  let pickups = [];

  const state = {
    tick: 0,
    /** "" while playing, then "won" | "lost" | "draw". A co-op level with
     *  no enemies is a sandbox and ends no way at all. */
    outcome: "",
    /** The surviving seat in a versus win; -1 otherwise. */
    winner: -1,
    players: playerSeats,
    enemies,
    get bombs() { return bombs; },
    get blasts() { return blasts; },
    get pickups() { return pickups; },
  };

  /** @type {any[]} presentation events, drained by the renderer. */
  let queued = [];

  /**
   * Whether a cell blocks movement. A bomb is solid — except to whoever is
   * still standing in its cell, so placing one under your own feet lets you
   * walk off it and never back onto it.
   */
  function solidAt(col, row, occupantCol, occupantRow) {
    if (col < 0 || row < 0 || col >= cols || row >= rows) return true;
    if (tiles[cellIndex(col, row)] !== MAZE_FLOOR) return true;
    for (const bomb of bombs) {
      if (bomb.col === col && bomb.row === row && !(col === occupantCol && row === occupantRow)) return true;
    }
    return false;
  }

  /**
   * Lane movement with the assist that makes the genre feel right: moving
   * along one axis first spends distance aligning to the lane's centre on
   * the other, so a turn taken a few pixels early still rounds the corner
   * instead of rubbing it. An entity never leaves its lane band, so the
   * nearest lane is always the current cell's — which is walkable by
   * invariant — and the assist can never push through a wall.
   */
  function moveAlong(entity, dirX, dirY, distance) {
    const col = cellOf(entity.x);
    const row = cellOf(entity.y);
    // Arrivals here are assignments too, for the same reason as stepEnemy's:
    // accumulating toward a limit can land one ulp off it, and a lane or a
    // clamp held one ulp off is a residue every later comparison inherits.
    if (dirX !== 0) {
      const lane = centerOf(row);
      const offset = lane - entity.y;
      if (offset !== 0) {
        const align = Math.min(Math.abs(offset), distance);
        if (align === Math.abs(offset)) entity.y = lane;
        else entity.y += offset > 0 ? align : -align;
        distance -= align;
      }
      if (distance <= 0) return;
      if (solidAt(col + dirX, row, col, row)) {
        // The next cell is shut: advance only as far as this cell's centre.
        const room = dirX > 0 ? centerOf(col) - entity.x : entity.x - centerOf(col);
        if (room > 0) {
          if (distance >= room) entity.x = centerOf(col);
          else entity.x += dirX * distance;
        }
      } else {
        entity.x += dirX * distance;
      }
    } else if (dirY !== 0) {
      const lane = centerOf(col);
      const offset = lane - entity.x;
      if (offset !== 0) {
        const align = Math.min(Math.abs(offset), distance);
        if (align === Math.abs(offset)) entity.x = lane;
        else entity.x += offset > 0 ? align : -align;
        distance -= align;
      }
      if (distance <= 0) return;
      if (solidAt(col, row + dirY, col, row)) {
        const room = dirY > 0 ? centerOf(row) - entity.y : entity.y - centerOf(row);
        if (room > 0) {
          if (distance >= room) entity.y = centerOf(row);
          else entity.y += dirY * distance;
        }
      } else {
        entity.y += dirY * distance;
      }
    }
  }

  function placeBomb(player) {
    const col = cellOf(player.x);
    const row = cellOf(player.y);
    if (player.active >= player.stock) return;
    for (const bomb of bombs) if (bomb.col === col && bomb.row === row) return;
    bombs.push({ col, row, seat: player.seat, range: player.range, ticksLeft: spec.rules.fuseTicks });
    player.active += 1;
    queued.push({ type: "placed", seat: player.seat, col, row });
  }

  /** Clockwise and anticlockwise of a cardinal, +y down. */
  const turnRight = (dir) => ({ x: -dir.y, y: dir.x });
  const turnLeft = (dir) => ({ x: dir.y, y: -dir.x });
  const turnBack = (dir) => ({ x: -dir.x, y: -dir.y });

  /** The first open direction in an enemy kind's preference order. */
  function chooseEnemyDirection(enemy) {
    const col = enemy.targetCol;
    const row = enemy.targetRow;
    const ahead = enemy.dir;
    let order;
    if (enemy.kind === "lefty") {
      order = [ahead, turnLeft(ahead), turnRight(ahead), turnBack(ahead)];
    } else if (enemy.kind === "chaser") {
      const prey = nearestPlayer(enemy);
      if (prey) {
        const dx = prey.x - enemy.x;
        const dy = prey.y - enemy.y;
        const first = Math.abs(dx) >= Math.abs(dy)
          ? { x: dx < 0 ? -1 : 1, y: 0 }
          : { x: 0, y: dy < 0 ? -1 : 1 };
        const second = Math.abs(dx) >= Math.abs(dy)
          ? { x: 0, y: dy < 0 ? -1 : 1 }
          : { x: dx < 0 ? -1 : 1, y: 0 };
        order = [first, second, ahead, turnRight(ahead), turnLeft(ahead), turnBack(ahead)];
      } else {
        order = [ahead, turnRight(ahead), turnLeft(ahead), turnBack(ahead)];
      }
    } else {
      order = [ahead, turnRight(ahead), turnLeft(ahead), turnBack(ahead)];
    }
    for (const dir of order) {
      if ((dir.x !== 0 || dir.y !== 0) && !solidAt(col + dir.x, row + dir.y, col, row)) return dir;
    }
    return null;
  }

  /** Nearest living player by squared distance; the lowest seat on a tie. */
  function nearestPlayer(enemy) {
    let best = null;
    let bestDistance = Infinity;
    for (const player of playerSeats) {
      if (!player.alive) continue;
      const dx = player.x - enemy.x;
      const dy = player.y - enemy.y;
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = player;
      }
    }
    return best;
  }

  /**
   * Enemies walk cell centre to cell centre, deciding only when they
   * arrive — which is what keeps a replay from hinging on sub-pixel phase.
   * The while loop spends the whole step's distance even across a centre.
   */
  function stepEnemy(enemy, distance) {
    let remaining = distance;
    let decisions = 0;
    while (remaining > 0 && enemy.alive) {
      const targetX = centerOf(enemy.targetCol);
      const targetY = centerOf(enemy.targetRow);
      const dx = targetX - enemy.x;
      const dy = targetY - enemy.y;
      const gap = Math.abs(dx) + Math.abs(dy); // one axis is always zero
      if (gap === 0) {
        // At a centre: pick the next cell, or stand until something opens.
        if (decisions >= 2) return; // walled in tighter than the step; wait
        decisions += 1;
        const dir = chooseEnemyDirection(enemy);
        if (!dir) return;
        enemy.dir = dir;
        enemy.targetCol += dir.x;
        enemy.targetRow += dir.y;
        continue;
      }
      const step = Math.min(remaining, gap);
      if (step === gap) {
        // Arrival is an assignment, never an accumulation: `x += (target - x)`
        // can land one ulp short when the speed is not binary-exact (0.85 is
        // not; 0.75 is, which is why the walkers never showed this), and the
        // residual gap then shrinks `remaining` by subnormal slivers — a
        // while-loop with ~1e14 iterations left in it. The co-op match test
        // is what found it, by running a chaser far longer than any unit
        // test had.
        enemy.x = targetX;
        enemy.y = targetY;
      } else {
        enemy.x += dx === 0 ? 0 : (dx > 0 ? step : -step);
        enemy.y += dy === 0 ? 0 : (dy > 0 ? step : -step);
      }
      remaining -= step;
    }
  }

  /**
   * Detonate every due bomb, chains included, in one pass: a blast that
   * reaches another bomb pushes it onto the same queue, so a chain's shape
   * is decided entirely inside the tick it starts.
   */
  function detonateDue() {
    const due = [];
    for (const bomb of bombs) {
      bomb.ticksLeft -= 1;
      if (bomb.ticksLeft <= 0) due.push(bomb);
    }
    for (let next = 0; next < due.length; next += 1) {
      const bomb = due[next];
      const index = bombs.indexOf(bomb);
      if (index < 0) continue; // already consumed by an earlier chain link
      bombs.splice(index, 1);
      const owner = playerSeats[bomb.seat];
      if (owner) owner.active = Math.max(0, owner.active - 1);

      const cells = [cellIndex(bomb.col, bomb.row)];
      for (const dir of [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }]) {
        for (let reach = 1; reach <= bomb.range; reach += 1) {
          const col = bomb.col + dir.x * reach;
          const row = bomb.row + dir.y * reach;
          if (col < 0 || row < 0 || col >= cols || row >= rows) break;
          const cell = cellIndex(col, row);
          const kind = tiles[cell];
          if (kind === MAZE_WALL) break;
          cells.push(cell);
          if (kind === MAZE_BRICK) {
            // The flame breaks the brick and is spent on it.
            tiles[cell] = MAZE_FLOOR;
            if (owner) owner.score += MAZE_BRICK_POINTS;
            const reveal = dropAt.get(cell);
            if (reveal) {
              dropAt.delete(cell);
              pickups.push({ col, row, kind: reveal });
            }
            queued.push({ type: "brickBroke", col, row, revealed: reveal ?? null });
            break;
          }
          // A blast crossing a revealed pickup burns it.
          pickups = pickups.filter((pickup) => {
            if (pickup.col !== col || pickup.row !== row) return true;
            queued.push({ type: "pickupBurned", col, row, kind: pickup.kind });
            return false;
          });
          for (const other of bombs) {
            if (other.col === col && other.row === row && !due.includes(other)) due.push(other);
          }
        }
      }
      blasts.push({ cells, seat: bomb.seat, ticksLeft: spec.rules.flameTicks });
      queued.push({ type: "exploded", seat: bomb.seat, col: bomb.col, row: bomb.row, cells: [...cells] });
    }
  }

  function killPlayer(player) {
    if (!player.alive) return;
    player.alive = false;
    queued.push({ type: "died", who: "player", seat: player.seat, col: cellOf(player.x), row: cellOf(player.y) });
  }

  /**
   * @param {number} dt The fixed step, seconds — the same every call and on
   *        every machine.
   * @param {Array<import("./contract.js").MazeInput | undefined>} [inputs]
   *        One per seat. A missing entry reads as neutral.
   */
  function step(dt, inputs = []) {
    if (!(dt > 0)) return;
    const playing = state.outcome === "";

    // Phase 1 — players: snap the stick through the four-way gate, move,
    // then place on the rising edge (a bomb lands in the cell you moved to).
    for (let seat = 0; seat < seats; seat += 1) {
      const player = playerSeats[seat];
      const input = inputs[seat];
      const move = input && input.move ? input.move : { x: 0, y: 0 };
      const snapped = snapStick(move, "four", { previous: player.held, previousRaw: player.rawHeld });
      player.rawHeld = { x: Number(move.x) || 0, y: Number(move.y) || 0 };
      player.held = { x: snapped.x, y: snapped.y };
      const pressed = input ? input.bomb === true : false;
      const rising = pressed && !player.pressing;
      player.pressing = pressed;
      if (!playing || !player.alive) continue;
      if (snapped.x !== 0 || snapped.y !== 0) {
        const dirX = snapped.x === 0 ? 0 : snapped.x < 0 ? -1 : 1;
        const dirY = snapped.y === 0 ? 0 : snapped.y < 0 ? -1 : 1;
        player.facing = { x: dirX, y: dirY };
        const speed = spec.rules.speed + player.speedBonus;
        moveAlong(player, dirX, dirY, speed * dt);
      }
      if (rising) placeBomb(player);
    }

    // Phase 2 — enemies.
    if (playing) {
      for (const enemy of enemies) {
        if (!enemy.alive) continue;
        const factor = MAZE_ENEMY_KINDS[enemy.kind]?.speed ?? 0.75;
        stepEnemy(enemy, spec.rules.speed * factor * dt);
      }
    }

    // Phase 3 — fuses burn down and due bombs chain.
    detonateDue();

    // Phase 4 — pickups are grabbed by whoever stands on them.
    for (const player of playerSeats) {
      if (!player.alive) continue;
      const col = cellOf(player.x);
      const row = cellOf(player.y);
      pickups = pickups.filter((pickup) => {
        if (pickup.col !== col || pickup.row !== row) return true;
        if (pickup.kind === "bombs") player.stock = Math.min(8, player.stock + 1);
        else if (pickup.kind === "range") player.range = Math.min(12, player.range + 1);
        else player.speedBonus = Math.min(MAZE_SPEED_CAP, player.speedBonus + MAZE_SPEED_STEP);
        queued.push({ type: "pickedUp", seat: player.seat, kind: pickup.kind, col, row });
        return false;
      });
    }

    // Phase 5 — deaths: flames first, then an enemy's touch.
    if (playing) {
      for (const blast of blasts) {
        for (const player of playerSeats) {
          if (player.alive && blast.cells.includes(cellIndex(cellOf(player.x), cellOf(player.y)))) {
            killPlayer(player);
          }
        }
        for (const enemy of enemies) {
          if (!enemy.alive) continue;
          if (blast.cells.includes(cellIndex(cellOf(enemy.x), cellOf(enemy.y)))) {
            enemy.alive = false;
            const owner = playerSeats[blast.seat];
            if (owner) owner.score += MAZE_ENEMY_POINTS;
            queued.push({ type: "died", who: "enemy", kind: enemy.kind, col: cellOf(enemy.x), row: cellOf(enemy.y) });
          }
        }
      }
      const touch = tile * 0.6;
      for (const enemy of enemies) {
        if (!enemy.alive) continue;
        for (const player of playerSeats) {
          if (!player.alive) continue;
          if (Math.abs(enemy.x - player.x) < touch && Math.abs(enemy.y - player.y) < touch) killPlayer(player);
        }
      }
    }

    // Phase 6 — flames age, after they have had this tick's bite, so a
    // blast is lethal for exactly flameTicks steps including its first.
    blasts = blasts.filter((blast) => {
      blast.ticksLeft -= 1;
      return blast.ticksLeft > 0;
    });

    // Phase 7 — outcome.
    if (playing) {
      const alive = playerSeats.filter((player) => player.alive);
      if (spec.rules.versus) {
        if (seats > 1 && alive.length === 1) {
          state.outcome = "won";
          state.winner = alive[0].seat;
          queued.push({ type: "won", winner: state.winner, scores: playerSeats.map((player) => player.score) });
        } else if (alive.length === 0) {
          state.outcome = "draw";
          queued.push({ type: "draw" });
        }
      } else if (alive.length === 0) {
        state.outcome = "lost";
        queued.push({ type: "lost" });
      } else if (startingEnemies > 0 && enemies.every((enemy) => !enemy.alive)) {
        state.outcome = "won";
        queued.push({ type: "won", winner: -1, scores: playerSeats.map((player) => player.score) });
      }
    }

    state.tick += 1;
  }

  return {
    /** Live and mutable — read it, do not write it. */
    get state() { return state; },
    /** The level as the round plays it, normalized. The live grid is
     *  `tiles()`; `level.tiles` stays as authored. */
    get level() { return spec; },

    step,

    /** The live grid, bricks and all — the renderer's tile source. */
    tiles() { return tiles; },
    /** The tile at a cell, wall beyond the edge. */
    tileAt(col, row) {
      if (col < 0 || row < 0 || col >= cols || row >= rows) return MAZE_WALL;
      return tiles[cellIndex(col, row)];
    },

    /**
     * Everything noteworthy since the last drain, oldest first: `placed`,
     * `exploded` (with the blast's cell indices, so a renderer draws the
     * cross without recomputing it), `brickBroke`, `pickupBurned`,
     * `pickedUp`, `died`, `won`, `lost`, `draw`. Drive sounds and effects
     * from these — never from inside the step.
     */
    drainEvents() {
      const drained = queued;
      queued = [];
      return drained;
    },

    /** Plain data all the way down; survives JSON. */
    snapshot() {
      return {
        tick: state.tick,
        outcome: state.outcome,
        winner: state.winner,
        tiles: [...tiles],
        players: playerSeats.map((player) => ({
          ...player,
          facing: { ...player.facing },
          held: { ...player.held },
          rawHeld: { ...player.rawHeld },
        })),
        enemies: enemies.map((enemy) => ({ ...enemy, dir: { ...enemy.dir } })),
        bombs: bombs.map((bomb) => ({ ...bomb })),
        blasts: blasts.map((blast) => ({ ...blast, cells: [...blast.cells] })),
        pickups: pickups.map((pickup) => ({ ...pickup })),
        drops: [...dropAt.entries()],
      };
    },

    restore(snap) {
      state.tick = snap.tick;
      state.outcome = snap.outcome;
      state.winner = snap.winner;
      tiles.length = 0;
      tiles.push(...snap.tiles);
      snap.players.forEach((saved, index) => {
        Object.assign(playerSeats[index], saved, {
          facing: { ...saved.facing },
          held: { ...saved.held },
          rawHeld: { ...saved.rawHeld },
        });
      });
      snap.enemies.forEach((saved, index) => {
        Object.assign(enemies[index], saved, { dir: { ...saved.dir } });
      });
      bombs = snap.bombs.map((bomb) => ({ ...bomb }));
      blasts = snap.blasts.map((blast) => ({ ...blast, cells: [...blast.cells] }));
      pickups = snap.pickups.map((pickup) => ({ ...pickup }));
      dropAt.clear();
      for (const [cell, kind] of snap.drops) dropAt.set(cell, kind);
      queued = [];
    },
  };
}
