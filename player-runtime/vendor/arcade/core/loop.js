// One frame loop with an optional fixed timestep.
//
// The three games currently clamp delta three different ways (25 ms, 34 ms, and
// a fixed-step accumulator). Only the accumulator is deterministic, and
// determinism is the prerequisite for replays and for any input-synchronised
// multiplayer, so it is the default here and the variable path is opt-in.

import { createReporter } from "./report.js";

const DEFAULT_MAX_FRAME_SECONDS = 0.25;

/**
 * @param {object} options
 * @param {number|null} [options.fixedStep] Seconds per simulation step. Pass
 *        null for a variable-delta loop, where `update` receives the clamped
 *        frame time directly.
 * @param {number} [options.maxFrameTime] Upper bound on one frame's delta, in
 *        seconds. Guards the spiral of death after a tab restore.
 * @param {number} [options.maxStepsPerFrame]
 * @param {(step: number, context: object) => void} [options.update]
 * @param {(dt: number, alpha: number, context: object) => void} [options.render]
 * @param {{event?: Function} | ((name: string, data?: unknown) => void)} [options.report]
 *        Sink for `loop.overrun`, reported when the simulation falls behind
 *        real time and discards a step budget.
 * @param {(callback: (timestamp: number) => void) => number} [options.requestFrame]
 *        Swappable so a test can drive the loop without a display.
 * @param {(handle: number) => void} [options.cancelFrame]
 */
export function createLoop({
  fixedStep = 1 / 120,
  maxFrameTime = DEFAULT_MAX_FRAME_SECONDS,
  maxStepsPerFrame = 8,
  update,
  render,
  report,
  requestFrame = (callback) => requestAnimationFrame(callback),
  cancelFrame = (handle) => cancelAnimationFrame(handle),
} = {}) {
  const variable = !fixedStep;
  // Exhausting the step budget means the simulation is falling behind real
  // time — the single most useful thing this loop knows about itself. It can
  // happen every frame, so repeats are counted rather than sent.
  const emit = createReporter(report, { throttleMs: 5000 });
  let handle = null;
  let last = null;
  let accumulator = 0;
  let frame = 0;
  let elapsed = 0;
  let running = false;
  let paused = false;

  let timestamp = 0;
  const context = {
    get frame() { return frame; },
    get elapsed() { return elapsed; },
    get paused() { return paused; },
    /** The raw scheduler timestamp — what a frame sampler wants. */
    get timestamp() { return timestamp; },
  };

  /** One frame of work. Shared by the rAF path and by manual stepping. */
  function advance(now) {
    timestamp = now;
    if (last === null) {
      // The first frame after a start, a pause, or a reset has no previous
      // timestamp to measure against, so it cannot simulate — but it still
      // renders. Skipping the draw here shows as a dropped frame every time
      // the game resumes.
      last = now;
      render?.(0, 0, context);
      return;
    }
    // A negative delta means the clock moved backwards — it happens when a
    // caller mixes time sources. Treat it as a dropped frame rather than
    // running the simulation in reverse.
    const raw = (now - last) / 1000;
    last = now;
    const dt = raw > 0 ? Math.min(raw, maxFrameTime) : 0;

    if (paused) {
      render?.(0, 0, context);
      return;
    }

    frame += 1;
    elapsed += dt;

    if (variable) {
      update?.(dt, context);
      render?.(dt, 0, context);
      return;
    }

    accumulator += dt;
    let steps = 0;
    while (accumulator >= fixedStep && steps < maxStepsPerFrame) {
      update?.(fixedStep, context);
      accumulator -= fixedStep;
      steps += 1;
    }
    // Whatever could not be simulated inside the budget is discarded rather
    // than carried forward, or one slow frame compounds into a slower one.
    if (steps === maxStepsPerFrame) {
      emit("loop.overrun", {
        steps,
        droppedMs: Math.round(accumulator * 1000),
        frameMs: Math.round(dt * 1000),
      });
      accumulator = 0;
    }
    render?.(dt, accumulator / fixedStep, context);
  }

  function tick(now) {
    handle = requestFrame(tick);
    advance(now);
  }

  return {
    get running() { return running; },
    get paused() { return paused; },
    get frame() { return frame; },
    get elapsed() { return elapsed; },
    get fixedStep() { return variable ? null : fixedStep; },

    start() {
      if (running) return;
      running = true;
      last = null;
      accumulator = 0;
      handle = requestFrame(tick);
    },

    stop() {
      if (!running) return;
      running = false;
      if (handle !== null) cancelFrame(handle);
      handle = null;
      last = null;
    },

    /** Keeps rendering but stops advancing the simulation. */
    setPaused(value) {
      const next = Boolean(value);
      if (next === paused) return;
      paused = next;
      // Dropping the timestamp keeps the pause duration out of the next delta.
      last = null;
      accumulator = 0;
    },

    /** Forget accumulated time — after a load, a resize, or a tab restore. */
    reset() {
      last = null;
      accumulator = 0;
    },

    /** Advance by hand: frame-stepping debug tools, and tests. */
    step(now) {
      advance(now);
    },
  };
}
