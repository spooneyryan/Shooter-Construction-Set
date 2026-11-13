// A run as the inputs that produced it — over `net/input-log`, which records
// actions as bits and writes an entry only when something changes, so a
// minute of holding right is one entry.
//
// It could once record only bits, which is why `shmup` wrote its own; it now
// carries analogue channels beside them, so a run aimed with a stick or a
// mouse records as faithfully as one walked with the arrow keys. A recording
// of a game that never touches a stick is the same size it always was: the
// channels are declared, and two centred vectors are two zeroes that never
// change and therefore never write a second entry.
//
// A recording is **not self-contained**: it replays against a game and a
// level, and nothing in it can detect being played against the wrong one —
// so store them together, the same warning `shmup/replay` carries.

import { createInputRecorder, createInputPlayer } from "../net/input-log.js";
import { PAD_ACTIONS, PAD_STICKS, neutralInput } from "./contract.js";
import { createStage } from "./world.js";

/**
 * The action names for an N-player recording, in wire order:
 * `p0:left … p0:action, p1:left …`. The order is part of the format.
 *
 * @param {number} players
 */
export function stagePadActions(players) {
  const actions = [];
  for (let index = 0; index < players; index += 1) {
    for (const name of PAD_ACTIONS) actions.push(`p${index}:${name}`);
  }
  return actions;
}

/**
 * The analogue channel names, same scheme: `p0:move`, `p0:aim`, `p1:move` …
 * Same rule too — appended, never reordered.
 *
 * @param {number} players
 */
export function stagePadSticks(players) {
  const sticks = [];
  for (let index = 0; index < players; index += 1) {
    for (const name of PAD_STICKS) sticks.push(`p${index}:${name}`);
  }
  return sticks;
}

/**
 * Record a stage's inputs. Call `capture(inputs)` once per step, BEFORE
 * `stage.step`, with the same array of per-player inputs the step gets.
 *
 * @param {object} [options]
 * @param {number} [options.players]
 * @param {object} [options.meta] Carried in the log: level name, versions.
 */
export function createStageRecorder({ players = 1, meta = {} } = {}) {
  const actions = stagePadActions(players);
  const sticks = stagePadSticks(players);
  const recorder = createInputRecorder({ actions, sticks, meta: { ...meta, players, runnjumpInput: 2 } });
  // `p3:satLock` -> seat 3, `satLock`. One parse, used by both readers.
  const seatOf = (name) => {
    const split = name.indexOf(":");
    return { player: Number(name.slice(1, split)), field: name.slice(split + 1) };
  };
  return {
    /** @param {import("./contract.js").PadInput[]} inputs */
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
    /**
     * Rewind the tape to `tick`, for a host that rewound its stage. Pass
     * `stage.state.tick` straight after a `restore` and the recording stays
     * the run it claims to be.
     */
    rewindTo: (tick) => recorder.rewindTo(tick),
    toJSON: () => recorder.toJSON(),
  };
}

/**
 * Re-simulate a recording against a game. Returns the finished stage; the
 * caller compares whatever it fingerprints — in this repository's tests,
 * the JSON of `snapshot()`.
 *
 * @param {object} game A game, already normalized.
 * @param {object} log A `createStageRecorder().toJSON()`.
 * @param {object} [options] Passed through to `createStage`; `players` comes
 *        from the log.
 * @param {number} [options.dt] Step size; the recording is steps, not time,
 *        so this must match the recording run's.
 */
export function replayStage(game, log, options = {}) {
  const players = log?.meta?.players ?? 1;
  const player = createInputPlayer(log);
  const stage = createStage(game, { ...options, players });
  const dt = options.dt ?? 1 / 60;
  const inputs = Array.from({ length: players }, () => neutralInput());
  while (!player.finished) {
    player.advance();
    for (let index = 0; index < players; index += 1) {
      for (const name of PAD_ACTIONS) {
        inputs[index][name] = player.isDown(`p${index}:${name}`);
      }
      for (const name of PAD_STICKS) {
        inputs[index][name] = player.stick(`p${index}:${name}`);
      }
    }
    stage.step(dt, inputs);
  }
  return stage;
}
