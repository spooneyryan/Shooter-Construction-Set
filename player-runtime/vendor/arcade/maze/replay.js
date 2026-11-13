// A round as the inputs that produced it — over `net/input-log`, the one
// recorder this repository keeps. One bit per seat (`bomb`) and one
// analogue channel (`move`), written only on change: a held direction is
// one entry, so a round records small.
//
// A recording is **not self-contained**: it replays against a level, and
// nothing in it can detect being played against the wrong one — store them
// together. The same warning every replay module here carries.

import { createInputPlayer, createInputRecorder } from "../net/input-log.js";
import { MAZE_ACTIONS, MAZE_STICKS, neutralMazeInput } from "./contract.js";
import { createMaze } from "./world.js";

/**
 * The action names for an N-seat recording, in wire order:
 * `p0:bomb, p1:bomb, …`. The order is part of the format.
 * @param {number} players
 */
export function mazePadActions(players) {
  const actions = [];
  for (let index = 0; index < players; index += 1) {
    for (const name of MAZE_ACTIONS) actions.push(`p${index}:${name}`);
  }
  return actions;
}

/** The analogue channels, same scheme — appended, never reordered.
 * @param {number} players
 */
export function mazePadSticks(players) {
  const sticks = [];
  for (let index = 0; index < players; index += 1) {
    for (const name of MAZE_STICKS) sticks.push(`p${index}:${name}`);
  }
  return sticks;
}

/**
 * Record a round's inputs. Call `capture(inputs)` once per step, BEFORE
 * `maze.step`, with the same array of per-seat inputs the step gets.
 *
 * @param {object} [options]
 * @param {number} [options.players]
 * @param {object} [options.meta] Carried in the log: level name, versions.
 */
export function createMazeRecorder({ players = 1, meta = {} } = {}) {
  const actions = mazePadActions(players);
  const sticks = mazePadSticks(players);
  const recorder = createInputRecorder({ actions, sticks, meta: { players, ...meta } });
  // `p2:bomb` -> seat 2, `bomb`. One parse, used by both readers.
  const seatOf = (name) => {
    const split = name.indexOf(":");
    return { player: Number(name.slice(1, split)), field: name.slice(split + 1) };
  };
  return {
    /** @param {Array<import("./contract.js").MazeInput | undefined>} inputs */
    capture(inputs) {
      recorder.capture({
        isDown(name) {
          const { player, field } = seatOf(name);
          return (inputs[player] ?? {})[field] === true;
        },
        stick(name) {
          const { player, field } = seatOf(name);
          return (inputs[player] ?? {})[field] ?? { x: 0, y: 0 };
        },
      });
    },
    get steps() { return recorder.step; },
    /** Rewind the tape for a host that rewound its round — pass
     *  `maze.state.tick` straight after a `restore`. */
    rewindTo: (tick) => recorder.rewindTo(tick),
    toJSON: () => recorder.toJSON(),
  };
}

/**
 * Re-simulate a recording against a level. Returns the finished round; the
 * caller compares whatever it fingerprints — in this repository's tests,
 * the JSON of `snapshot()`.
 *
 * @param {object} level Normalized or raw, as `createMaze` accepts.
 * @param {object} log A `createMazeRecorder().toJSON()`.
 * @param {object} [options]
 * @param {number} [options.dt] Step size; the recording is steps, not time,
 *        so this must match the recording run's. Default 1/60.
 */
export function replayMaze(level, log, options = {}) {
  const players = log?.meta?.players ?? 1;
  const player = createInputPlayer(log);
  const maze = createMaze(level, { players });
  const dt = options.dt ?? 1 / 60;
  const inputs = Array.from({ length: players }, () => neutralMazeInput());
  while (!player.finished) {
    player.advance();
    for (let index = 0; index < players; index += 1) {
      for (const name of MAZE_ACTIONS) {
        inputs[index][name] = player.isDown(`p${index}:${name}`);
      }
      for (const name of MAZE_STICKS) {
        inputs[index][name] = player.stick(`p${index}:${name}`);
      }
    }
    maze.step(dt, inputs);
  }
  return maze;
}
