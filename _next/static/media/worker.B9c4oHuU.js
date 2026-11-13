// The render worker: `renderSfx` on a thread that is not the one drawing.
//
// This file is a worker ENTRY POINT, not a module to import. Nothing in the
// package re-exports it — `sfx/index.js` deliberately leaves it out — because
// importing it on the main thread would attach a message handler there and
// achieve precisely nothing. Start it through `createSfxRenderer` in
// `renderer.js`, which owns the URL and the protocol.
//
// Why a worker at all, when the synth is "just arithmetic": measured, the
// Explosion preset renders 42,777 samples in about 3.7 ms, and a browser frame
// is 16.6 ms. That is a fifth of a frame for one sound — survivable once at a
// load screen, and not survivable at all in an editor where every slider
// movement re-renders. Moving it off-thread costs a structured-clone of a
// small object each way and buys the main thread all of it back.
//
// The buffer comes home as a transfer rather than a copy: a Float32Array is
// the one thing in this protocol big enough to care about, and transferring it
// hands over the memory instead of duplicating it.

import { renderSfx } from "./synth.js";

/**
 * @typedef {object} SfxRenderRequest
 * @property {number} id Echoed back, so the client can match a reply to a
 *           request it may since have superseded.
 * @property {unknown} definition
 * @property {number} sampleRate
 */

/**
 * Handle one request. Exported so a test can exercise the protocol without
 * standing up a real worker, which is most of what there is to get wrong here.
 *
 * @param {SfxRenderRequest} request
 * @returns {{id: number, samples?: Float32Array, error?: string}}
 */
export function handleRenderRequest({ id, definition, sampleRate }) {
  try {
    return { id, samples: renderSfx(definition, { sampleRate }) };
  } catch (error) {
    // A render that throws is a bug, but it must not take the worker with it —
    // the client would then wait forever on a promise nobody will settle.
    return { id, error: error instanceof Error ? error.message : String(error) };
  }
}

// Only wire up when this really is a worker. `DedicatedWorkerGlobalScope` is
// the honest test; `importScripts` is absent in module workers, and checking
// for `self` alone is true on every window in the world.
const inWorker =
  typeof self !== "undefined" &&
  typeof globalThis.DedicatedWorkerGlobalScope !== "undefined" &&
  self instanceof globalThis.DedicatedWorkerGlobalScope;

if (inWorker) {
  self.onmessage = (event) => {
    const reply = handleRenderRequest(event.data);
    // Transfer the samples; there is no reader left on this side.
    self.postMessage(reply, reply.samples ? [reply.samples.buffer] : []);
  };
}
