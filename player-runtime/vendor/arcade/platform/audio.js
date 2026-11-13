// A small WebAudio synth: declared sounds, one master bus, per-effect cooldowns.
//
// From Pinball, which is the fuller of the two implementations. SpeegeBall's
// `tone()` is a strict subset. The cooldown map is the part worth keeping —
// without it a burst of simultaneous collisions stacks a dozen oscillators on
// the same frequency and the result is a click, not a sound.

const DEFAULT_COOLDOWN_MS = 95;

/**
 * A sound is an array of layers, each either:
 *   { type: "tone", frequency, endFrequency?, duration?, volume?, wave?, delay? }
 *   { type: "noise", frequency?, duration?, volume?, q?, delay? }
 *
 * @param {object} [options]
 * @param {Record<string, object[]>} [options.sounds]
 * @param {number} [options.masterGain]
 * @param {boolean} [options.enabled]
 * @param {number|Record<string, number>} [options.cooldownMs]
 * @param {typeof AudioContext} [options.AudioContextClass] Swappable so a test
 *        can run without a real audio device.
 */
export function createAudio({
  sounds = {},
  masterGain = 0.24,
  enabled = true,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext,
} = {}) {
  const lastPlayed = new Map();
  let context = null;
  let master = null;
  let active = Boolean(enabled);

  const cooldownFor = (name) => (typeof cooldownMs === "number" ? cooldownMs : cooldownMs[name] ?? DEFAULT_COOLDOWN_MS);

  function ensure() {
    if (!active || !AudioContextClass) return null;
    if (!context) {
      context = new AudioContextClass();
      master = context.createGain();
      master.gain.value = masterGain;
      master.connect(context.destination);
    }
    // Browsers start the context suspended until a user gesture; resuming on
    // every play is cheap and removes the need for a separate unlock path.
    if (context.state === "suspended") context.resume().catch(() => {});
    return context;
  }

  function playTone(layer) {
    const audio = ensure();
    if (!audio || !master) return;
    const start = audio.currentTime + (layer.delay ?? 0);
    const duration = layer.duration ?? 0.08;
    const end = start + duration;
    const oscillator = audio.createOscillator();
    const envelope = audio.createGain();
    oscillator.type = layer.wave ?? "sine";
    // exponentialRamp cannot touch zero, hence the tiny floors throughout.
    oscillator.frequency.setValueAtTime(Math.max(20, layer.frequency ?? 220), start);
    oscillator.frequency.exponentialRampToValueAtTime(
      Math.max(20, layer.endFrequency ?? layer.frequency ?? 220),
      end,
    );
    const volume = Math.max(0.0002, layer.volume ?? 0.12);
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(volume, start + Math.min(0.008, duration / 3));
    envelope.gain.exponentialRampToValueAtTime(0.0001, end);
    oscillator.connect(envelope);
    envelope.connect(master);
    oscillator.start(start);
    oscillator.stop(end + 0.02);
  }

  function playNoise(layer) {
    const audio = ensure();
    if (!audio || !master) return;
    const duration = layer.duration ?? 0.05;
    const frames = Math.max(1, Math.floor(audio.sampleRate * duration));
    const buffer = audio.createBuffer(1, frames, audio.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < frames; index += 1) data[index] = Math.random() * 2 - 1;
    const source = audio.createBufferSource();
    const filter = audio.createBiquadFilter();
    const envelope = audio.createGain();
    const start = audio.currentTime + (layer.delay ?? 0);
    source.buffer = buffer;
    filter.type = "bandpass";
    filter.frequency.value = layer.frequency ?? 900;
    filter.Q.value = layer.q ?? 1.4;
    envelope.gain.setValueAtTime(Math.max(0.0002, layer.volume ?? 0.05), start);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    source.connect(filter);
    filter.connect(envelope);
    envelope.connect(master);
    source.start(start);
    source.stop(start + duration);
  }

  return {
    get enabled() { return active; },
    set enabled(value) {
      active = Boolean(value);
      if (!active && context?.state === "running") context.suspend().catch(() => {});
    },
    get supported() { return Boolean(AudioContextClass); },

    /**
     * @param {string} name
     * @param {object} [options]
     * @param {string|number} [options.key] Distinguishes concurrent sources of
     *        the same sound so each gets its own cooldown — one per bumper,
     *        rather than one globally.
     * @param {number} [options.cooldownMs] Overrides the configured cooldown
     *        for this one call.
     */
    play(name, { key, cooldownMs: override } = {}) {
      if (!active) return false;
      const layers = sounds[name];
      if (!layers) return false;
      const now = performance.now();
      const slot = key === undefined ? name : `${name}:${key}`;
      const window = override ?? cooldownFor(name);
      if (now - (lastPlayed.get(slot) ?? 0) < window) return false;
      lastPlayed.set(slot, now);
      for (const layer of layers) {
        if (layer.type === "noise") playNoise(layer);
        else playTone(layer);
      }
      return true;
    },

    /**
     * A one-shot that skips the sound table and the cooldown. Not every blip
     * deserves a name, and both games already have a `tone()`-shaped call —
     * this keeps those on the shared master bus and gesture unlock.
     */
    tone(layer) {
      if (!active) return false;
      if (layer.type === "noise") playNoise(layer);
      else playTone(layer);
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

    /** Add or replace sounds after construction. */
    define(name, layers) { sounds[name] = layers; },

    destroy() {
      lastPlayed.clear();
      context?.close?.().catch(() => {});
      context = null;
      master = null;
    },
  };
}
