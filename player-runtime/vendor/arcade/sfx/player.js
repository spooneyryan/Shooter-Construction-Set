// Playback for designed sounds: render on first use, cache, and hand the
// buffer to WebAudio. Everything audible lives in synth.js; this file only
// moves air, and follows platform/audio's manners — lazy context, resume on
// every play (browsers start suspended until a gesture), a swappable
// AudioContextClass so a test can run without an audio device.

import { normalizeSfx, renderSfx } from "./synth.js";

/**
 * @param {object} [options]
 * @param {number} [options.masterGain]
 * @param {boolean} [options.enabled]
 * @param {number} [options.cacheSize] Rendered buffers kept, oldest out first.
 * @param {typeof AudioContext} [options.AudioContextClass]
 */
export function createSfxPlayer({
  masterGain = 0.8,
  enabled = true,
  cacheSize = 32,
  AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext,
} = {}) {
  let context = null;
  let master = null;
  let active = Boolean(enabled);
  /** @type {Map<string, Float32Array>} A Map remembers insertion order, which is all the eviction policy needed. */
  const cache = new Map();

  function ensure() {
    if (!active || !AudioContextClass) return null;
    if (!context) {
      context = new AudioContextClass();
      master = context.createGain();
      master.gain.value = masterGain;
      master.connect(context.destination);
    }
    if (context.state === "suspended") context.resume().catch(() => {});
    return context;
  }

  /** Render through the cache. Exposed so a host can pre-warm during a load screen. */
  function render(definition, sampleRate) {
    const sfx = normalizeSfx(definition);
    const key = `${sampleRate}:${JSON.stringify(sfx)}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const samples = renderSfx(sfx, { sampleRate });
    cache.set(key, samples);
    if (cache.size > cacheSize) cache.delete(cache.keys().next().value);
    return samples;
  }

  return {
    get enabled() { return active; },
    set enabled(value) {
      active = Boolean(value);
      if (!active && context?.state === "running") context.suspend().catch(() => {});
    },
    get supported() { return Boolean(AudioContextClass); },

    render,

    /**
     * @param {import("./synth.js").SfxDefinition | unknown} definition
     * @param {object} [options]
     * @param {number} [options.volume] A per-play multiplier over the document's own.
     * @returns {boolean} Whether a sound actually started.
     */
    play(definition, { volume = 1 } = {}) {
      const audio = ensure();
      if (!audio || !master) return false;
      const samples = render(definition, audio.sampleRate);
      const buffer = audio.createBuffer(1, samples.length, audio.sampleRate);
      buffer.getChannelData(0).set(samples);
      const source = audio.createBufferSource();
      source.buffer = buffer;
      if (volume === 1) source.connect(master);
      else {
        const gain = audio.createGain();
        gain.gain.value = Math.max(0, volume);
        source.connect(gain);
        gain.connect(master);
      }
      source.start();
      return true;
    },

    /** Call from a real user gesture if you want the context warm early. */
    resume() {
      const audio = ensure();
      return audio ? audio.resume().catch(() => {}) : Promise.resolve();
    },

    setMasterGain(value) {
      masterGain = Math.min(1, Math.max(0, value));
      if (master) master.gain.value = masterGain;
    },

    destroy() {
      cache.clear();
      context?.close?.().catch(() => {});
      context = null;
      master = null;
    },
  };
}
