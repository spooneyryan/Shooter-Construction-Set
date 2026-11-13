// A round as the inputs that produced it — over `net/input-log`, the one
// recorder this repository keeps. One bit per seat (`fire`) and one analogue
// channel (`aim`), written only on change: a match is mostly a held aim and
// a handful of presses, so a recording is tiny.
//
// A recording is **not self-contained**: it replays against a level, and
// nothing in it can detect being played against the wrong one — store them
// together. The same warning `runnjump/replay` and `shmup/replay` carry.

import { createInputPlayer, createInputRecorder } from "../net/input-log.js";
import { CANNON_ACTIONS, CANNON_STICKS, neutralCannonInput } from "./contract.js";
import { createSiege } from "./world.js";

/**
 * The action names for an N-seat recording, in wire order:
 * `p0:fire, p1:fire`. The order is part of the format.
 * @param {number} players
 */
export function cannonPadActions(players) {
  const actions = [];
  for (let index = 0; index < players; index += 1) {
    for (const name of CANNON_ACTIONS) actions.push(`p${index}:${name}`);
  }
  return actions;
}

/** The analogue channels, same scheme — appended, never reordered.
 * @param {number} players
 */
export function cannonPadSticks(players) {
  const sticks = [];
  for (let index = 0; index < players; index += 1) {
    for (const name of CANNON_STICKS) sticks.push(`p${index}:${name}`);
  }
  return sticks;
}

/**
 * Record a round's inputs. Call `capture(inputs)` once per step, BEFORE
 * `siege.step`, with the same array of per-seat inputs the step gets.
 *
 * @param {object} [options]
 * @param {number} [options.players]
 * @param {object} [options.meta] Carried in the log: level name, versions.
 */
export function createCannonRecorder({ players = 1, meta = {} } = {}) {
  const actions = cannonPadActions(players);
  const sticks = cannonPadSticks(players);
  const recorder = createInputRecorder({ actions, sticks, meta: { players, ...meta } });
  // `p1:fire` -> seat 1, `fire`. One parse, used by both readers.
  const seatOf = (name) => {
    const split = name.indexOf(":");
    return { player: Number(name.slice(1, split)), field: name.slice(split + 1) };
  };
  return {
    /** @param {Array<import("./contract.js").CannonInput | undefined>} inputs */
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
    /** Rewind the tape for a host that rewound its siege — pass
     *  `siege.state.tick` straight after a `restore`. */
    rewindTo: (tick) => recorder.rewindTo(tick),
    toJSON: () => recorder.toJSON(),
  };
}

/**
 * Re-simulate a recording against a level. Returns the finished siege; the
 * caller compares whatever it fingerprints — in this repository's tests,
 * the JSON of `snapshot()`.
 *
 * @param {object} level Normalized or raw, as `createSiege` accepts.
 * @param {object} log A `createCannonRecorder().toJSON()`.
 * @param {object} [options]
 * @param {number} [options.dt] Step size; the recording is steps, not time,
 *        so this must match the recording run's. Default 1/120, the rate
 *        the physics suite and demo run at.
 */
export function replaySiege(level, log, options = {}) {
  const players = log?.meta?.players ?? 1;
  const player = createInputPlayer(log);
  const siege = createSiege(level, { players });
  const dt = options.dt ?? 1 / 120;
  const inputs = Array.from({ length: players }, () => neutralCannonInput());
  while (!player.finished) {
    player.advance();
    for (let index = 0; index < players; index += 1) {
      for (const name of CANNON_ACTIONS) {
        inputs[index][name] = player.isDown(`p${index}:${name}`);
      }
      for (const name of CANNON_STICKS) {
        inputs[index][name] = player.stick(`p${index}:${name}`);
      }
    }
    siege.step(dt, inputs);
  }
  return siege;
}
