// A run as the inputs that produced it — over `net/input-log`, the one
// recorder this repository keeps. Three bits and two analogue channels per
// seat, written only on change.
//
// This genre is the first whose replay also depends on the DICE, and it
// costs nothing: the seed is in the world document and the generator is
// plain state inside the snapshot, so a recording that replays the same
// inputs against the same world rolls the same loot in the same order. A
// procedural floor reproduces from the seed it was found with.
//
// A recording is **not self-contained**: it replays against a world, and
// nothing in it can detect being played against the wrong one — so store
// them together. The same warning every replay module here carries.

import { createInputPlayer, createInputRecorder } from "../net/input-log.js";
import { TOPDOWN_ACTIONS, TOPDOWN_STICKS, neutralTopdownInput } from "./contract.js";
import { createRun } from "./world.js";

/**
 * The action names for an N-seat recording, in wire order:
 * `p0:attack, p0:cast, p0:use, p1:attack …`. The order is part of the
 * format.
 * @param {number} players
 */
export function topdownPadActions(players) {
  const actions = [];
  for (let index = 0; index < players; index += 1) {
    for (const name of TOPDOWN_ACTIONS) actions.push(`p${index}:${name}`);
  }
  return actions;
}

/** The analogue channels, same scheme — appended, never reordered.
 * @param {number} players
 */
export function topdownPadSticks(players) {
  const sticks = [];
  for (let index = 0; index < players; index += 1) {
    for (const name of TOPDOWN_STICKS) sticks.push(`p${index}:${name}`);
  }
  return sticks;
}

/**
 * Record a run's inputs. Call `capture(inputs)` once per step, BEFORE
 * `run.step`, with the same array of per-seat inputs the step gets.
 *
 * @param {object} [options]
 * @param {number} [options.players]
 * @param {object} [options.meta] Carried in the log: world name, versions.
 */
export function createTopdownRecorder({ players = 1, meta = {} } = {}) {
  const actions = topdownPadActions(players);
  const sticks = topdownPadSticks(players);
  const recorder = createInputRecorder({ actions, sticks, meta: { players, ...meta } });
  // `p2:cast` -> seat 2, `cast`. One parse, used by both readers.
  const seatOf = (name) => {
    const split = name.indexOf(":");
    return { player: Number(name.slice(1, split)), field: name.slice(split + 1) };
  };
  return {
    /** @param {Array<import("./contract.js").TopdownInput | undefined>} inputs */
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
    /** Rewind the tape for a host that rewound its run — pass
     *  `run.state.tick` straight after a `restore`. */
    rewindTo: (tick) => recorder.rewindTo(tick),
    toJSON: () => recorder.toJSON(),
  };
}

/**
 * Re-simulate a recording against a world. Returns the finished run; the
 * caller compares whatever it fingerprints — in this repository's tests,
 * the JSON of `snapshot()`.
 *
 * @param {object} world Normalized or raw, as `createRun` accepts.
 * @param {object} log A `createTopdownRecorder().toJSON()`.
 * @param {object} [options]
 * @param {number} [options.dt] Step size; the recording is steps, not
 *        time, so this must match the recording run's. Default 1/60.
 */
export function replayTopdownRun(world, log, options = {}) {
  const players = log?.meta?.players ?? 1;
  const player = createInputPlayer(log);
  const run = createRun(world, { players });
  const dt = options.dt ?? 1 / 60;
  const inputs = Array.from({ length: players }, () => neutralTopdownInput());
  while (!player.finished) {
    player.advance();
    for (let index = 0; index < players; index += 1) {
      for (const name of TOPDOWN_ACTIONS) {
        inputs[index][name] = player.isDown(`p${index}:${name}`);
      }
      for (const name of TOPDOWN_STICKS) {
        inputs[index][name] = player.stick(`p${index}:${name}`);
      }
    }
    run.step(dt, inputs);
  }
  return run;
}
