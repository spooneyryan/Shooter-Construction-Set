// A ride as the inputs that produced it — over `net/input-log`, the one
// recorder this repository keeps. Four bits and two analogue channels per
// seat, written only on change.
//
// This genre replays for a reason the others do not have to argue for: the
// simulation is continuous physics, so a recording is the only compact way
// to store a lap at all. A ghost is this file; so is a time attack's
// leaderboard entry, and so is the "watch how they did it" that a course
// with a hard section wants.
//
// A recording is **not self-contained**: it replays against a course, and
// nothing in it can detect being played against the wrong one — so store
// them together. The same warning every replay module here carries.

import { createInputPlayer, createInputRecorder } from "../net/input-log.js";
import { WHEELS_ACTIONS, WHEELS_STICKS, neutralWheelsInput } from "./contract.js";
import { createRide } from "./world.js";

/**
 * The action names for an N-seat recording, in wire order:
 * `p0:jump, p0:fireForward, p0:fireUp, p0:reset, p1:jump …`. The order is
 * part of the format.
 * @param {number} players
 */
export function wheelsPadActions(players) {
  const actions = [];
  for (let index = 0; index < players; index += 1) {
    for (const name of WHEELS_ACTIONS) actions.push(`p${index}:${name}`);
  }
  return actions;
}

/** The analogue channels, same scheme — appended, never reordered.
 * @param {number} players
 */
export function wheelsPadSticks(players) {
  const sticks = [];
  for (let index = 0; index < players; index += 1) {
    for (const name of WHEELS_STICKS) sticks.push(`p${index}:${name}`);
  }
  return sticks;
}

/**
 * Record a ride's inputs. Call `capture(inputs)` once per step, BEFORE
 * `ride.step`, with the same array of per-seat inputs the step gets.
 *
 * @param {object} [options]
 * @param {number} [options.players]
 * @param {object} [options.meta] Carried in the log: course name, versions.
 */
export function createWheelsRecorder({ players = 1, meta = {} } = {}) {
  const actions = wheelsPadActions(players);
  const sticks = wheelsPadSticks(players);
  const recorder = createInputRecorder({ actions, sticks, meta: { players, ...meta } });
  // `p2:reset` -> seat 2, `reset`. One parse, used by both readers.
  const seatOf = (name) => {
    const split = name.indexOf(":");
    return { player: Number(name.slice(1, split)), field: name.slice(split + 1) };
  };
  return {
    /** @param {Array<import("./contract.js").WheelsInput | undefined>} inputs */
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
    /** Rewind the tape for a host that rewound its ride — pass
     *  `ride.state.tick` straight after a `restore`. */
    rewindTo: (tick) => recorder.rewindTo(tick),
    toJSON: () => recorder.toJSON(),
  };
}

/**
 * Re-simulate a recording against a course. Returns the finished ride; the
 * caller compares whatever it fingerprints — in this repository's tests,
 * the JSON of `snapshot()`.
 *
 * @param {object} course Normalized or raw, as `createRide` accepts.
 * @param {object} log A `createWheelsRecorder().toJSON()`.
 * @param {object} [options]
 * @param {number} [options.dt] Step size; the recording is steps, not
 *        time, so this must match the recording ride's. Default 1/60.
 */
export function replayWheelsRide(course, log, options = {}) {
  const players = log?.meta?.players ?? 1;
  const player = createInputPlayer(log);
  const ride = createRide(course, { players });
  const dt = options.dt ?? 1 / 60;
  const inputs = Array.from({ length: players }, () => neutralWheelsInput());
  while (!player.finished) {
    player.advance();
    for (let index = 0; index < players; index += 1) {
      for (const name of WHEELS_ACTIONS) {
        inputs[index][name] = player.isDown(`p${index}:${name}`);
      }
      for (const name of WHEELS_STICKS) {
        inputs[index][name] = player.stick(`p${index}:${name}`);
      }
    }
    ride.step(dt, inputs);
  }
  return ride;
}
