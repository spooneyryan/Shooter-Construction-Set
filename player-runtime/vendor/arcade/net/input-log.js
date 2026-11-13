// Deterministic input recording and playback.
//
// This is the cheapest useful thing the net layer can offer, and it needs no
// server: a replay is a document plus the inputs that were pressed on each
// simulation step. It buys ghost runs, attract-mode demos, verified
// leaderboards and bug reports that reproduce, and it is the same determinism
// that any later input-synchronised multiplayer will require — so proving it
// here de-risks that work rather than deferring it.
//
// It only holds if the simulation is deterministic: a fixed timestep (see
// core/loop.js) and no `Math.random` in the update path. `createSeededRandom`
// is here so a game has a substitute.
//
// ANALOGUE CHANNELS. This started as bits and nothing else, which is why
// `shmup/replay.js` exists: that world takes sticks and a pointer, and
// rounding those to held/not-held would make a replay of a pad session diverge
// from the run it claims to be, so it wrote a second recorder with the same
// change-detection trick. A stick is now a channel here — two quantized
// integers beside the bits — which is what a twin-stick game needs and what
// lets those two recorders become one. The quantization is what makes it safe:
// an analogue reading that has been through `core/stick` is an integer, and an
// integer compares exactly, so the entry-per-change trick survives contact
// with a stick that never quite stops moving.

import { uniqueId } from "../core/validate.js";
import { packStick, unpackStick, neutralStick } from "../core/stick.js";

/**
 * 2 adds analogue channels. A recording that declares no sticks is written as
 * **version 1 and is byte-identical to what version 1 produced**, so a build
 * that predates this still reads every tape it could read before; only a tape
 * that actually carries a stick is stamped 2, and refusing that one is the
 * correct behaviour for a player that cannot decode it.
 */
export const INPUT_LOG_VERSION = 2;

/** The version a stickless recording claims, which is all it needs to claim. */
const INPUT_LOG_DIGITAL_VERSION = 1;

/**
 * A state string is the action bits, then optionally `|` and the stick codes:
 * `"0101|2047,0,-1024,512"`. Two integers per stick, in the order `sticks`
 * names them, which is why that order is part of the format exactly as the
 * action order is.
 *
 * Keeping it one string is not tidiness. The recorder's whole storage trick is
 * that it compares this step's state with the last one and writes an entry
 * only when they differ; a single `!==` is what makes that cheap, and a tuple
 * of a string and an array would need a deep compare on every step of every
 * recording.
 */
function splitLogState(state) {
  const bar = state.indexOf("|");
  if (bar < 0) return { bits: state, codes: [] };
  const tail = state.slice(bar + 1);
  return {
    bits: state.slice(0, bar),
    codes: tail === "" ? [] : tail.split(",").map((code) => Number(code) || 0),
  };
}

/**
 * xorshift128. Small, fast, and identical across engines — which `Math.random`
 * explicitly is not, so it cannot appear anywhere in a recorded simulation.
 */
export function createSeededRandom(seed = 1) {
  let x = seed | 0 || 1;
  let y = 362436069;
  let z = 521288629;
  let w = 88675123;
  return function random() {
    const t = x ^ (x << 11);
    x = y; y = z; z = w;
    w = w ^ (w >>> 19) ^ t ^ (t >>> 8);
    // >>> 0 first, so the result is in [0, 1) rather than occasionally negative.
    return (w >>> 0) / 0x100000000;
  };
}

/**
 * Records one entry per step on which the held-action set changed. A run that
 * holds "left" for 600 steps is three bytes of log, not six hundred.
 *
 * @param {object} options
 * @param {string[]} options.actions Recorded in this order; the order is part
 *        of the format, so changing it invalidates old logs.
 * @param {string[]} [options.sticks] Analogue channels, by name, in wire
 *        order — the same append-only rule as `actions`. Each is read from
 *        `input.stick(name)` and stored as two quantized integers. Omit this
 *        and nothing changes: no channels, no `|`, and a version 1 log.
 * @param {number} [options.seed] Written into the log, so a replay can rebuild
 *        the same run rather than a differently-random one.
 * @param {object} [options.meta] Anything the game wants to carry alongside.
 */
export function createInputRecorder({ actions, sticks = [], seed = 1, meta = {} }) {
  const frames = [];
  let step = 0;
  let previous = "";

  const encode = (input) => {
    const bits = actions.map((name) => (input.isDown(name) ? "1" : "0")).join("");
    if (sticks.length === 0) return bits;
    const codes = [];
    for (const name of sticks) {
      // Quantized on the way in, which is the point: an unquantized float
      // here would make the tape disagree with the run that produced it on
      // any machine that rounds differently. `core/stick` has already done it
      // if the value came from `resolveStick`, and doing it twice is exact.
      const [x, y] = packStick(input.stick?.(name) ?? null);
      codes.push(x, y);
    }
    return `${bits}|${codes.join(",")}`;
  };

  return {
    get step() { return step; },
    get frames() { return frames.length; },

    /** Call once per fixed simulation step, before the step runs. */
    capture(input) {
      const state = encode(input);
      if (state !== previous) {
        frames.push([step, state]);
        previous = state;
      }
      step += 1;
    },

    reset() {
      frames.length = 0;
      step = 0;
      previous = "";
    },

    /**
     * Drop everything recorded after `target` and continue from there.
     *
     * A tape is only honest if it matches the run that produced it, and a
     * host that can rewind its simulation -- a playtest scrubbing backwards,
     * an editor stepping back a second -- desynchronises the two the moment
     * it does. Without this the recorder keeps counting while the world goes
     * back, and every later entry is filed against a tick the run never
     * reached again.
     *
     * `step` is the step about to be captured, so an entry filed AT the
     * target describes a step that is being undone and goes with the rest --
     * the cut is `>= target`, not `>`. What survives is the tape a fresh
     * recording would have produced up to this point, and `previous` becomes
     * the state those surviving entries leave in force, so the first capture
     * after a rewind writes an entry exactly when the state really changed.
     *
     * @param {number} target Step to resume from. Clamped at zero.
     * @returns {number} The step the recorder now stands on.
     */
    rewindTo(target) {
      const at = Math.max(0, Math.floor(Number(target) || 0));
      while (frames.length > 0 && frames[frames.length - 1][0] >= at) frames.pop();
      previous = frames.length > 0 ? frames[frames.length - 1][1] : "";
      step = at;
      return step;
    },

    toJSON() {
      return {
        format: "arcade-input-log",
        version: sticks.length > 0 ? INPUT_LOG_VERSION : INPUT_LOG_DIGITAL_VERSION,
        id: uniqueId("replay"),
        seed,
        actions: [...actions],
        sticks: [...sticks],
        steps: step,
        frames,
        meta,
      };
    },
  };
}

/**
 * Replays a recorded log. Exposes the same read surface as `createInput`
 * (`isDown`, `pressed`, `released`, `axis`) so game code does not branch on
 * whether it is being played or replayed.
 *
 * **Where that promise stops: `stick`.** A live input *derives* a vector from
 * hardware, so `createInput().stick({left, right, up, down})` names four
 * actions to read. A recording has no hardware and already holds the answer,
 * so `stick(name)` here names one stored channel. The two cannot share a
 * signature without one of them pretending — a player would need gamepad
 * bindings it has no use for. A game that records its sticks therefore has one
 * line that differs between playing and replaying, and it is the line that
 * asks where the stick is.
 */
export function createInputPlayer(log) {
  if (log?.format !== "arcade-input-log") throw new Error("This is not an input log.");
  if (log.version > INPUT_LOG_VERSION) throw new Error("This replay was recorded by a newer version.");

  const actions = log.actions;
  const sticks = Array.isArray(log.sticks) ? log.sticks : [];
  const frames = log.frames ?? [];
  let cursor = 0;
  let step = 0;
  // A version 1 log has no `|` and no codes, and decodes here unchanged.
  const neutral = sticks.length > 0
    ? `${"0".repeat(actions.length)}|${new Array(sticks.length * 2).fill(0).join(",")}`
    : "0".repeat(actions.length);
  let current = neutral;
  let previous = current;
  let codes = splitLogState(current).codes;

  const indexOf = (name) => actions.indexOf(name);
  const held = (state, name) => {
    const index = indexOf(name);
    return index >= 0 && state[index] === "1";
  };

  return {
    get step() { return step; },
    get finished() { return step >= (log.steps ?? 0); },
    get seed() { return log.seed ?? 1; },

    /** Call once per fixed step, before the step runs. */
    advance() {
      previous = current;
      let changed = false;
      while (cursor < frames.length && frames[cursor][0] === step) {
        current = frames[cursor][1];
        cursor += 1;
        changed = true;
      }
      // Decoded once per change rather than once per read: a step reads a
      // stick as often as it likes and pays for the split no more than once.
      if (changed) codes = splitLogState(current).codes;
      step += 1;
    },

    isDown(name) { return held(current, name); },
    pressed(name) { return held(current, name) && !held(previous, name); },
    released(name) { return !held(current, name) && held(previous, name); },
    axis(negative, positive) {
      return (held(current, positive) ? 1 : 0) - (held(current, negative) ? 1 : 0);
    },

    /**
     * One recorded analogue channel, by name. Unknown names — a tape written
     * before the channel existed, replayed by a build that has it — read as
     * centred, which is the same forgiveness `isDown` gives an action the tape
     * does not carry.
     *
     * @param {string} name
     */
    stick(name) {
      const index = sticks.indexOf(name);
      if (index < 0) return neutralStick();
      return unpackStick([codes[index * 2] ?? 0, codes[index * 2 + 1] ?? 0]);
    },
    // Present so a player is drop-in wherever an input is expected.
    poll() {},
    releaseAll() {},

    reset() {
      cursor = 0;
      step = 0;
      current = neutral;
      previous = current;
      codes = splitLogState(current).codes;
    },
  };
}
