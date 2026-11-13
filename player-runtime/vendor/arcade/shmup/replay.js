// Recording a run, and playing it back.
//
// A replay is a level plus the input on every simulation step. Nothing else is
// stored — no positions, no scores — because the world is deterministic and
// re-simulating from the same inputs produces the same run. That is the whole
// bargain, and it is why the fixed step and the absence of `Math.random` had to
// come first.
//
// **This was its own recorder, and is now `net/input-log`.** The reason it was
// written stood for as long as that module stored only bits: this world takes
// analogue sticks and a pointer, and rounding those to held/not-held would make
// a replay of a pad or mouse session diverge from the run it claims to be. That
// reason expired when `input-log` grew analogue channels, so the second
// recorder became a copy of the first with a different storage format and no
// remaining argument. What is left here is the part that was always this
// module's own: **which channels a shmup run has**, and how a pointer position
// becomes one.
//
// The two axes and the pointer ride as three stick channels; `fire` and
// whether the pointer is engaged ride as two bits. Positions are the
// interesting case — a pointer is not a direction, so it is mapped linearly
// across the view rather than clamped to the unit disc, and because the world
// rounds it to the whole pixel first that mapping round-trips with **zero**
// error across the entire 1280x640 view. Measured across every integer
// position, not assumed.
//
// **What a recording is not.** It is not self-contained: it replays against a
// level, and the same inputs against a different level are a different run.
// Store the level with it, or store an id and be sure you can find it again.

import { createInputPlayer, createInputRecorder } from "../net/input-log.js";
import { VIEW_H, VIEW_W, clamp } from "./contract.js";
import { idleInput, normalizeWorldInput } from "./world.js";

/**
 * 2 moved the storage onto `net/input-log`. Version 1 documents still play —
 * `migrateRunRecording` converts them — and the conversion is lossless,
 * because a version 1 tape stored raw floats that `world.step` was going to
 * quantize on the way in anyway. What the world sees is identical either way.
 */
export const RUN_RECORDING_VERSION = 2;
export const RUN_RECORDING_FORMAT = "arcade-shmup-run";

/** The bits, in wire order. Appended, never reordered. */
export const RUN_RECORDING_ACTIONS = Object.freeze(["fire", "pointerActive"]);

/** The analogue channels, in wire order. Same rule. */
export const RUN_RECORDING_STICKS = Object.freeze(["move", "satellite", "pointer"]);

/** A view position onto a channel: 0..span becomes -1..1. */
function pointerToStick(value, span) {
  return (clamp(Number(value) || 0, 0, span) / span) * 2 - 1;
}

/** And back, to the whole pixel the world rounds to anyway. */
function stickToPointer(value, span) {
  return Math.round(clamp((value + 1) / 2, 0, 1) * span);
}

/** One `WorldInput` as the five channels a log stores. */
function runChannels(input) {
  const normalized = normalizeWorldInput(input);
  return {
    isDown(name) {
      if (name === "fire") return normalized.fire === true;
      if (name === "pointerActive") return normalized.satellitePointer.active === true;
      return false;
    },
    stick(name) {
      if (name === "move") return { x: normalized.dx, y: normalized.dy };
      if (name === "satellite") return normalized.satelliteAxis;
      if (name === "pointer") {
        return {
          x: pointerToStick(normalized.satellitePointer.x, VIEW_W),
          y: pointerToStick(normalized.satellitePointer.y, VIEW_H),
        };
      }
      return { x: 0, y: 0 };
    },
  };
}

/** And back: the five channels as the input the world consumes. */
function runInputFrom(player) {
  const move = player.stick("move");
  const pointer = player.stick("pointer");
  return {
    dx: move.x,
    dy: move.y,
    fire: player.isDown("fire"),
    satelliteAxis: player.stick("satellite"),
    satellitePointer: {
      x: stickToPointer(pointer.x, VIEW_W),
      y: stickToPointer(pointer.y, VIEW_H),
      active: player.isDown("pointerActive"),
    },
  };
}

/**
 * @param {object} [options]
 * @param {number} [options.step] Seconds per simulation step. Recorded so a
 *        playback cannot silently use a different one, which would produce a
 *        different run from the same inputs and look like a determinism bug.
 * @param {Record<string, unknown>} [options.meta] Anything the game wants back:
 *        a level id, a build number, why the recording was kept.
 */
export function createRunRecorder({ step = 1 / 120, meta = {} } = {}) {
  const recorder = createInputRecorder({
    actions: [...RUN_RECORDING_ACTIONS],
    sticks: [...RUN_RECORDING_STICKS],
    meta: { step },
  });

  return {
    get steps() { return recorder.step; },
    /** How many entries are actually stored — one per change, not per step. */
    get frames() { return recorder.frames; },

    /**
     * Record the input for the step about to be taken. Call once per step,
     * before `world.step`, and pass the same object you pass to it.
     *
     * A caller that keeps one input object and mutates it each frame is safe:
     * the channels are read and quantized here, so nothing of the caller's is
     * held on to.
     */
    capture(input) {
      recorder.capture(runChannels(input));
    },

    reset() {
      recorder.reset();
    },

    /**
     * Drop everything after `target` and resume there, for a host that rewound
     * its world. Inherited from the shared recorder rather than reimplemented.
     */
    rewindTo(target) {
      return recorder.rewindTo(target);
    },

    toJSON() {
      return {
        format: RUN_RECORDING_FORMAT,
        version: RUN_RECORDING_VERSION,
        step,
        steps: recorder.step,
        log: recorder.toJSON(),
        meta,
      };
    },
  };
}

/**
 * A version 1 recording as a version 2 one.
 *
 * Lossless in the only sense that matters: a version 1 tape held raw floats
 * straight off somebody's hardware, and `world.step` quantizes those on the
 * way in, so the numbers this conversion writes are exactly the numbers that
 * tape was already going to produce when played. The pointer is the same
 * story in pixels — the world rounds it, and a rounded position survives the
 * channel exactly.
 *
 * Passing an already-current recording back is a no-op, so a caller may run
 * everything it loads through this without checking first.
 *
 * @param {object} recording
 */
export function migrateRunRecording(recording) {
  if (!recording || recording.format !== RUN_RECORDING_FORMAT) {
    throw new Error("This is not a run recording.");
  }
  if (Number(recording.version) >= RUN_RECORDING_VERSION) return recording;

  const step = Number(recording.step) || 1 / 120;
  const recorder = createRunRecorder({ step, meta: recording.meta ?? {} });
  const frames = Array.isArray(recording.frames) ? recording.frames : [];
  const steps = Math.max(0, Math.round(Number(recording.steps) || 0));
  let index = 0;
  let current = idleInput();
  for (let at = 0; at < steps; at += 1) {
    while (index < frames.length && frames[index][0] <= at) {
      current = { ...idleInput(), ...(frames[index][1] ?? {}) };
      index += 1;
    }
    recorder.capture(current);
  }
  return recorder.toJSON();
}

/**
 * Play a recording back, one step at a time.
 *
 * @param {object} recording From `createRunRecorder().toJSON()`.
 */
export function createRunPlayer(recording) {
  if (!recording || recording.format !== RUN_RECORDING_FORMAT) {
    throw new Error("This is not a run recording.");
  }
  if (Number(recording.version) > RUN_RECORDING_VERSION) {
    throw new Error("This recording was made by a newer version of the game.");
  }
  const current = migrateRunRecording(recording);
  const steps = Math.max(0, Math.round(Number(current.steps) || 0));
  const step = Number(current.step) || 1 / 120;

  let player = createInputPlayer(current.log);
  let at = 0;
  // Primed one ahead: the inner player holds a step's state only after it has
  // advanced onto it, and `input` here means "the step about to be taken".
  if (steps > 0) player.advance();
  let input = steps > 0 ? runInputFrom(player) : null;

  return {
    get step() { return step; },
    get at() { return at; },
    get finished() { return at >= steps; },
    /** The input for the step about to be taken, or null for an empty tape. */
    get input() { return input; },

    /** Advance to the next step. Returns the input for it. */
    advance() {
      at += 1;
      player.advance();
      input = at < steps ? runInputFrom(player) : input;
      return input;
    },

    reset() {
      player = createInputPlayer(current.log);
      at = 0;
      if (steps > 0) player.advance();
      input = steps > 0 ? runInputFrom(player) : null;
    },
  };
}

/**
 * Replay a recording against a level and hand back the world it produced.
 *
 * The one-liner behind every use of this: a ghost run, an attract demo, a bug
 * report that reproduces. If the world it returns disagrees with the one the
 * recording was made from, the simulation is not as deterministic as it claims
 * — which is a thing worth being able to check in one line.
 *
 * @param {(level: object) => {state: object, step: Function}} createWorldFn
 *        Passed in rather than imported, so this module does not depend on the
 *        world and can be tested against a fake one.
 * @param {object} level
 * @param {object} recording
 */
export function replayRun(createWorldFn, level, recording) {
  const world = createWorldFn(level);
  const player = createRunPlayer(recording);
  while (!player.finished) {
    const input = player.input;
    if (input) world.step(player.step, input);
    player.advance();
  }
  return world;
}
