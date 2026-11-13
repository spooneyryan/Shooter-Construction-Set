// A race as the inputs that produced it — over `net/input-log`, the one
// recorder this repository keeps. Four bits and two analogue channels per
// seat, written only on change. The field needs no tape at all: it is
// driven from state, so replaying the seats replays it too.
//
// This genre replays for the reason every racing game has one: a lap is
// continuous physics, so a recording is the only compact way to store it. A
// ghost car is this file; so is a time-trial leaderboard entry that can be
// checked, and so is "watch how they took the chicane".
//
// A recording is **not self-contained**: it replays against a track and the
// options the race was created with, and nothing in it can detect being
// played against the wrong track — so store them together. The options it
// needs are written into the tape's `meta`; the same warning every replay
// module here carries.

import { createInputPlayer, createInputRecorder } from "../net/input-log.js";
import { RACING_ACTIONS, RACING_STICKS, neutralRacingInput } from "./contract.js";
import { createRace } from "./world.js";

/**
 * The action names for an N-seat recording, in wire order:
 * `p0:fire, p0:drop, p0:handbrake, p0:reset, p1:fire …`. The order is part of
 * the format.
 * @param {number} players
 */
export function racingPadActions(players) {
  const actions = [];
  for (let index = 0; index < players; index += 1) {
    for (const name of RACING_ACTIONS) actions.push(`p${index}:${name}`);
  }
  return actions;
}

/** The analogue channels, same scheme — appended, never reordered.
 * @param {number} players
 */
export function racingPadSticks(players) {
  const sticks = [];
  for (let index = 0; index < players; index += 1) {
    for (const name of RACING_STICKS) sticks.push(`p${index}:${name}`);
  }
  return sticks;
}

/**
 * Record a race's inputs. Call `capture(inputs)` once per step, BEFORE
 * `race.step`, with the same array of per-seat inputs the step gets.
 *
 * @param {object} [options]
 * @param {number} [options.players]
 * @param {object} [options.race] The options the race was created with —
 *        `cpu`, `rules`, `steering`, `cars` — carried in the tape so the
 *        replay builds the same race.
 * @param {object} [options.meta] Anything else worth keeping: track name,
 *        versions, the driver's initials.
 */
export function createRacingRecorder({ players = 1, race = {}, meta = {} } = {}) {
  const actions = racingPadActions(players);
  const sticks = racingPadSticks(players);
  const recorder = createInputRecorder({ actions, sticks, meta: { ...meta, players, race } });
  // `p2:reset` -> seat 2, `reset`. One parse, used by both readers.
  const seatOf = (name) => {
    const split = name.indexOf(":");
    return { player: Number(name.slice(1, split)), field: name.slice(split + 1) };
  };
  return {
    /** @param {Array<import("./contract.js").RacingInput | undefined>} inputs */
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
    /** Rewind the tape for a host that rewound its race — pass
     *  `race.state.tick` straight after a `restore`. */
    rewindTo: (tick) => recorder.rewindTo(tick),
    toJSON: () => recorder.toJSON(),
  };
}

/**
 * Re-simulate a recording against a track. Returns the finished race; the
 * caller compares whatever it fingerprints — in this repository's tests, the
 * JSON of `snapshot()`.
 *
 * @param {object} track Normalized or raw, as `createRace` accepts.
 * @param {object} log A `createRacingRecorder().toJSON()`.
 * @param {object} [options]
 * @param {number} [options.dt] Step size; the recording is steps, not time,
 *        so this must match the recorded race's. Default 1/60.
 */
export function replayRacingRace(track, log, options = {}) {
  const players = log?.meta?.players ?? 1;
  const player = createInputPlayer(log);
  const race = createRace(track, { ...(log?.meta?.race ?? {}), players });
  const dt = options.dt ?? 1 / 60;
  const inputs = Array.from({ length: players }, () => neutralRacingInput());
  while (!player.finished) {
    player.advance();
    for (let index = 0; index < players; index += 1) {
      for (const name of RACING_ACTIONS) inputs[index][name] = player.isDown(`p${index}:${name}`);
      for (const name of RACING_STICKS) inputs[index][name] = player.stick(`p${index}:${name}`);
    }
    race.step(dt, inputs);
  }
  return race;
}
