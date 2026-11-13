// An off-thread renderer for designed sounds: the client half of `worker.js`.
//
// `renderSfx` is a pure function of a document, which makes it the easiest
// thing in this package to move off the main thread and the one that most
// needs moving. Measured on the presets, a render costs between 0.3 ms and
// 3.7 ms; a browser frame is 16.6 ms. One sound at load time is fine. An
// editor re-rendering on every slider movement is not, and that is exactly
// what `SfxStudio` does.
//
// Three things this owns beyond "call postMessage":
//
//  - **Coalescing.** A slider drag emits changes far faster than a render
//    completes. Queuing them all means the buffer you finally hear is one from
//    several seconds ago, having burned every millisecond in between. Only the
//    newest request survives; the ones it overtook resolve `null`.
//  - **A cache that is cheap to miss.** `player.js` keys its cache on
//    `JSON.stringify(sfx)`, which serialises twenty-eight fields on every
//    lookup including the hits. Here the key is an integer fold, and a hit is
//    confirmed by comparing the fields rather than trusting the fold — a
//    32-bit hash that silently returns the wrong sound is a bug worth two
//    dozen numeric comparisons to rule out.
//  - **Working without a worker.** Node has no `Worker` of this kind, jsdom has
//    none, and a browser can refuse one. Every path falls back to rendering
//    synchronously, so a caller never has to branch on whether it got lucky.

import { normalizeSfx, renderSfx, SFX_RANGES, SFX_WAVES, SFX_NOISE_MODES } from "./synth.js";

/** The fields a render actually reads. `name` is not one of them. */
const RENDER_FIELDS = Object.freeze(Object.keys(SFX_RANGES));

/**
 * An integer fold over everything that changes a render, `name` excluded.
 *
 * Fractions are folded at six decimal places and the integer part separately,
 * so `seed` — which runs to 2^31 — cannot collide with its own neighbours the
 * way a single scaled multiply would.
 *
 * @param {import("./synth.js").SfxDefinition} sfx A NORMALIZED definition.
 * @param {number} sampleRate
 * @returns {number}
 */
export function sfxRenderKey(sfx, sampleRate) {
  let hash = 0x811c9dc5;
  const mix = (value) => { hash = Math.imul(hash ^ (value | 0), 0x01000193) >>> 0; };
  for (const field of RENDER_FIELDS) {
    const value = sfx[field];
    const whole = Math.floor(value);
    mix(whole);
    mix(Math.round((value - whole) * 1e6));
  }
  mix(SFX_WAVES.indexOf(sfx.wave));
  mix(SFX_NOISE_MODES.indexOf(sfx.noiseMode));
  mix(sampleRate);
  return hash >>> 0;
}

/** Do these two normalized definitions render the same buffer? */
function sameRender(a, b) {
  if (a.wave !== b.wave || a.noiseMode !== b.noiseMode) return false;
  for (const field of RENDER_FIELDS) if (a[field] !== b[field]) return false;
  return true;
}

/**
 * @param {object} [options]
 * @param {number} [options.sampleRate] Default for calls that omit one.
 * @param {number} [options.cacheSize] Rendered buffers kept, oldest out first.
 * @param {boolean} [options.useWorker] Force the worker off — for tests, and
 *        for a host that would rather not spend a thread.
 * @param {typeof Worker} [options.WorkerImpl] Swappable so a test can drive the
 *        protocol without a real thread.
 * @param {URL|string} [options.workerUrl] Overridable for a host whose bundler
 *        needs to be told where the worker went.
 */
export function createSfxRenderer({
  sampleRate: defaultRate = 44100,
  cacheSize = 32,
  useWorker = true,
  WorkerImpl = globalThis.Worker,
  workerUrl,
} = {}) {
  /** @type {Map<number, {sfx: any, samples: Float32Array}>} */
  const cache = new Map();
  let worker = null;
  let workerBroken = false;
  let nextId = 1;
  /** @type {null | {id: number, resolve: Function, sfx: any, rate: number, key: number}} */
  let inFlight = null;
  /** @type {null | {resolve: Function, sfx: any, rate: number, key: number}} */
  let queued = null;
  let destroyed = false;
  let renderedHere = 0;
  let renderedThere = 0;

  function remember(key, sfx, samples) {
    cache.set(key, { sfx, samples });
    if (cache.size > cacheSize) cache.delete(cache.keys().next().value);
    return samples;
  }

  function cached(key, sfx) {
    const hit = cache.get(key);
    // The fold is 32 bits; confirm before trusting it.
    if (!hit || !sameRender(hit.sfx, sfx)) return null;
    // Refresh recency: a slider dragged back and forth should stay warm.
    cache.delete(key);
    cache.set(key, hit);
    return hit.samples;
  }

  /** Bring up the worker on first use. Returns null if it cannot be had. */
  function ensureWorker() {
    if (worker || workerBroken || destroyed) return worker;
    if (!useWorker || typeof WorkerImpl !== "function") { workerBroken = true; return null; }
    try {
      const url = workerUrl ?? new URL("./worker.js", import.meta.url);
      worker = new WorkerImpl(url, { type: "module" });
      worker.onmessage = (event) => settle(event.data);
      // A worker that dies mid-flight must not strand the promise waiting on
      // it: fall back to this thread, for that render and for every one after.
      worker.onerror = () => {
        workerBroken = true;
        try { worker?.terminate(); } catch { /* already gone */ }
        worker = null;
        const stranded = inFlight;
        inFlight = null;
        if (stranded) stranded.resolve(remember(stranded.key, stranded.sfx, renderHere(stranded.sfx, stranded.rate)));
        pump();
      };
    } catch {
      workerBroken = true;
      worker = null;
    }
    return worker;
  }

  function renderHere(sfx, rate) {
    renderedHere += 1;
    return renderSfx(sfx, { sampleRate: rate });
  }

  function settle(message) {
    if (!inFlight || !message || message.id !== inFlight.id) return;
    const job = inFlight;
    inFlight = null;
    if (message.samples) {
      renderedThere += 1;
      job.resolve(remember(job.key, job.sfx, message.samples));
    } else {
      // The worker refused this document. Whatever went wrong there will go
      // wrong here too, but here it throws where somebody can see it.
      job.resolve(remember(job.key, job.sfx, renderHere(job.sfx, job.rate)));
    }
    pump();
  }

  /** Start the queued job, if there is one and nothing is in flight. */
  function pump() {
    if (inFlight || !queued || destroyed) return;
    const job = queued;
    queued = null;
    const active = ensureWorker();
    if (!active) {
      job.resolve(remember(job.key, job.sfx, renderHere(job.sfx, job.rate)));
      pump();
      return;
    }
    const id = nextId++;
    inFlight = { id, resolve: job.resolve, sfx: job.sfx, rate: job.rate, key: job.key };
    active.postMessage({ id, definition: job.sfx, sampleRate: job.rate });
  }

  return {
    /**
     * Render off-thread.
     *
     * Resolves with the samples, or with **null** when a later call overtook
     * this one — which is the normal outcome for every intermediate position of
     * a dragged slider. Callers treat null as "nothing to do":
     *
     *     renderer.render(sound).then((samples) => { if (samples) show(samples) })
     *
     * Never rejects. A worker that fails falls back to this thread.
     *
     * @param {import("./synth.js").SfxDefinition | unknown} definition
     * @param {object} [options]
     * @param {number} [options.sampleRate]
     * @returns {Promise<Float32Array | null>}
     */
    render(definition, { sampleRate = defaultRate } = {}) {
      if (destroyed) return Promise.resolve(null);
      const sfx = normalizeSfx(definition);
      const key = sfxRenderKey(sfx, sampleRate);
      const hit = cached(key, sfx);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve) => {
        // Whatever was waiting behind the in-flight render is now stale: the
        // caller has asked for something newer, and nobody wants the buffer
        // for a slider position that is two moves old.
        if (queued) queued.resolve(null);
        queued = { resolve, sfx, rate: sampleRate, key };
        pump();
      });
    },

    /**
     * Render on this thread, right now. For a load screen pre-warming the
     * cache, and for callers that genuinely cannot proceed without the buffer.
     *
     * @param {import("./synth.js").SfxDefinition | unknown} definition
     * @param {object} [options]
     * @param {number} [options.sampleRate]
     * @returns {Float32Array}
     */
    renderSync(definition, { sampleRate = defaultRate } = {}) {
      const sfx = normalizeSfx(definition);
      const key = sfxRenderKey(sfx, sampleRate);
      return cached(key, sfx) ?? remember(key, sfx, renderHere(sfx, sampleRate));
    },

    /** Whether renders are actually leaving this thread. */
    get offThread() { return Boolean(worker) && !workerBroken; },
    get busy() { return inFlight !== null || queued !== null; },
    /** Renders done here vs. on the worker — what a test asserts on. */
    get stats() { return { onThread: renderedHere, offThread: renderedThere, cached: cache.size }; },

    clearCache() { cache.clear(); },

    destroy() {
      destroyed = true;
      queued?.resolve(null);
      queued = null;
      inFlight?.resolve(null);
      inFlight = null;
      try { worker?.terminate(); } catch { /* already gone */ }
      worker = null;
      cache.clear();
    },
  };
}
