// Designed sound effects: an Atari-2600-to-NES-era synthesizer, as a document
// plus arithmetic. A SfxDefinition says what the sound is — wave, pitch,
// envelope, the era's tricks — and `renderSfx` turns one into a Float32Array
// of samples with nothing but math: no AudioContext, no DOM, no clock, no
// `Math.random`. Playback is `player.js`'s job and drawing is nobody's here,
// for the same reason the shmup generator will never own a sprite.
//
// The parameter model is sfxr's — Dr. Petter's little tool taught a
// generation what "coin", "laser" and "explosion" sliders feel like, and
// there is no sense inventing a stranger vocabulary — but the implementation
// is this repository's, with the hardware character kept rather than
// approximated: the square wave has a duty cycle (the NES had four), the
// triangle is the NES's 32-step staircase, and noise is a 15-bit LFSR with
// the short-mode tap that makes the metallic buzz, clocked at a pitch rather
// than filtered from white noise.
//
// One document is one sound, bit for bit, on every machine. Noise comes from
// the LFSR seeded out of the document, sine and vibrato come from
// `core/trig`, and the octave math comes from an `exp2` built the same
// audited-series way — so a render is a pure function of (definition,
// sampleRate). Sound is presentation and two players' machines never need to
// agree about it; the reproducibility is for the document's sake, not the
// wire's. A designed sound is a shareable artifact like a level, the tests
// assert on exact samples, and a WAV exported today matches one exported on
// somebody else's laptop next year.

import { sin } from "../core/trig.js";
// A sideways import, acknowledged: the seeded PRNG lives with the input log
// because replays needed it first. Randomize and mutate need the same
// property — same seed, same sound — and a second xorshift here would be a
// second copy of the thing this repository keeps exactly one of.
import { createSeededRandom } from "../net/input-log.js";

export const SFX_VERSION = 1;

/** @typedef {"square" | "triangle" | "saw" | "noise" | "sine"} SfxWave */
/** @typedef {"long" | "short"} SfxNoiseMode */

/** The waves, in the order a designer should meet them: the era's four, then sine. */
export const SFX_WAVES = ["square", "triangle", "saw", "noise", "sine"];
export const SFX_NOISE_MODES = ["long", "short"];

/**
 * One range per numeric parameter: [min, max, default]. The single source the
 * sanitizer clamps to and a designer builds its sliders from, so the two
 * cannot drift apart.
 *
 * Units are chosen to be readable rather than faithful to sfxr's normalized
 * knobs: pitch in Hz, slides in octaves per second, times in seconds.
 */
export const SFX_RANGES = {
  seed: [1, 2147483647, 1],
  frequency: [20, 4000, 440],
  minFrequency: [0, 2000, 0],
  slide: [-8, 8, 0],
  deltaSlide: [-12, 12, 0],
  vibratoDepth: [0, 6, 0],
  vibratoRate: [0, 30, 8],
  arpAmount: [-24, 24, 0],
  arpTime: [0.01, 1, 0.1],
  duty: [0.05, 0.95, 0.5],
  dutySweep: [-2, 2, 0],
  attack: [0, 2, 0],
  sustain: [0, 2, 0.1],
  decay: [0, 3, 0.25],
  punch: [0, 1, 0],
  repeatRate: [0, 32, 0],
  flangerOffset: [-8, 8, 0],
  flangerSweep: [-8, 8, 0],
  lowPassCutoff: [200, 22050, 22050],
  lowPassSweep: [-6, 6, 0],
  resonance: [0, 1, 0],
  highPassCutoff: [0, 4000, 0],
  highPassSweep: [-6, 6, 0],
  bitDepth: [2, 16, 16],
  sampleHold: [1, 32, 1],
  volume: [0, 1, 0.5],
};

/**
 * How those parameters are presented: label, step, precision, unit, grouping,
 * and which of them only make sense for some waveforms.
 *
 * `SFX_RANGES` above says what a value may be; this says what a control for it
 * looks like. Both designers needed the second half and neither had it, so both
 * wrote it out — and by the time they were compared they had drifted:
 * `minFrequency` stepped by 5 in one and 1 in the other, `vibratoRate` by .25
 * against .5, and `flangerSweep` rendered its unit with a leading space on one
 * side only. Twenty-two of the twenty-five matched exactly, superscripts
 * included, which is how you could tell one was copied from the other and then
 * edited once.
 *
 * Deliberately NOT a general schema system. It is this instrument's own field
 * table, living beside its own ranges, and it is small enough to read.
 *
 * Labels are sentence case, which is the canonical form. A designer that wants
 * them shouted — Starline's does, as house style — uppercases at the point of
 * render rather than storing a second copy of every string here.
 *
 * `waves` means "only meaningful for these waveforms": duty cycle is a square
 * wave's business and the LFSR mode is noise's. Absent means always shown.
 */
export const SFX_FIELDS = Object.freeze([
  {
    title: "Tone",
    fields: Object.freeze([
      { key: "wave", label: "Wave", type: "enum", options: SFX_WAVES },
      { key: "noiseMode", label: "LFSR mode", type: "enum", options: SFX_NOISE_MODES, waves: ["noise"] },
      { key: "duty", label: "Duty cycle", type: "range", step: 0.005, decimals: 3, waves: ["square"] },
      { key: "dutySweep", label: "Duty sweep", type: "range", step: 0.01, decimals: 2, unit: "/s", waves: ["square"] },
    ]),
  },
  {
    title: "Pitch",
    fields: Object.freeze([
      { key: "frequency", label: "Frequency", type: "range", step: 1, decimals: 0, unit: "Hz" },
      { key: "slide", label: "Slide", type: "range", step: 0.05, decimals: 2, unit: " oct/s" },
      { key: "deltaSlide", label: "Delta slide", type: "range", step: 0.05, decimals: 2, unit: " oct/s²" },
      // Step 5, not 1: the range is 0-2000 Hz, and a 1 Hz step is two thousand
      // slider positions for a control nobody nudges by single hertz.
      { key: "minFrequency", label: "Min frequency cutoff", type: "range", step: 5, decimals: 0, unit: "Hz" },
      { key: "vibratoDepth", label: "Vibrato depth", type: "range", step: 0.05, decimals: 2, unit: " st" },
      // Step .25 over a 0-30 range, the finer of the two that disagreed.
      { key: "vibratoRate", label: "Vibrato rate", type: "range", step: 0.25, decimals: 2, unit: "Hz" },
      { key: "arpAmount", label: "Arpeggio jump", type: "range", step: 1, decimals: 0, unit: " st" },
      { key: "arpTime", label: "Arpeggio after", type: "range", step: 0.01, decimals: 2, unit: "s" },
    ]),
  },
  {
    title: "Envelope",
    fields: Object.freeze([
      { key: "attack", label: "Attack", type: "range", step: 0.01, decimals: 2, unit: "s" },
      { key: "sustain", label: "Sustain", type: "range", step: 0.01, decimals: 2, unit: "s" },
      { key: "decay", label: "Decay", type: "range", step: 0.01, decimals: 2, unit: "s" },
      { key: "punch", label: "Punch", type: "range", step: 0.01, decimals: 2 },
    ]),
  },
  {
    title: "Motion",
    fields: Object.freeze([
      { key: "repeatRate", label: "Repeat rate", type: "range", step: 0.5, decimals: 2, unit: "Hz" },
      { key: "flangerOffset", label: "Flanger offset", type: "range", step: 0.1, decimals: 2, unit: "ms" },
      // "ms/s" with no leading space, to match flangerOffset directly above it.
      // The side that disagreed was internally inconsistent with its own
      // neighbour, which is what settled it.
      { key: "flangerSweep", label: "Flanger sweep", type: "range", step: 0.1, decimals: 2, unit: "ms/s" },
    ]),
  },
  {
    title: "Filters",
    fields: Object.freeze([
      { key: "lowPassCutoff", label: "Low-pass cutoff", type: "range", step: 50, decimals: 0, unit: "Hz" },
      { key: "lowPassSweep", label: "LP sweep", type: "range", step: 0.05, decimals: 2, unit: " oct/s" },
      { key: "resonance", label: "Resonance", type: "range", step: 0.01, decimals: 2 },
      { key: "highPassCutoff", label: "High-pass cutoff", type: "range", step: 10, decimals: 0, unit: "Hz" },
      { key: "highPassSweep", label: "HP sweep", type: "range", step: 0.05, decimals: 2, unit: " oct/s" },
    ]),
  },
  {
    title: "Output",
    fields: Object.freeze([
      { key: "bitDepth", label: "Bit depth", type: "range", step: 1, decimals: 0, unit: " bit" },
      { key: "sampleHold", label: "Sample hold", type: "range", step: 1, decimals: 0, unit: "×" },
      { key: "volume", label: "Volume", type: "range", step: 0.01, decimals: 2 },
    ]),
  },
]);

/** Every field, ungrouped — for a designer that lays them out its own way. */
// Spread rather than returning `group.fields` straight through: those arrays
// are frozen, so the callback returns `readonly Field[]`, and `flatMap` is
// declared to take `U | U[]`. Nothing about this was wrong at runtime, and
// nothing caught it until `shmup` began importing this file and pulled it into
// that package's typecheck graph for the first time.
export const SFX_FIELD_LIST = Object.freeze(SFX_FIELDS.flatMap((group) => [...group.fields]));

/**
 * Whether a field applies to a waveform. `seed` and anything without a `waves`
 * list always does.
 *
 * @param {{waves?: readonly string[]}} field
 * @param {string} wave
 */
export function sfxFieldApplies(field, wave) {
  return !field.waves || field.waves.includes(wave);
}

/**
 * @typedef {object} SfxDefinition
 * @property {number} version
 * @property {string} name
 * @property {number} seed Starts the noise LFSR; nothing else reads it.
 * @property {SfxWave} wave
 * @property {SfxNoiseMode} noiseMode
 * @property {number} frequency Start pitch, Hz. For noise this is the LFSR clock, heard as roughness.
 * @property {number} minFrequency Hz. A slide that reaches it ends the sound — the classic laser tail-off. 0 disables.
 * @property {number} slide Octaves per second.
 * @property {number} deltaSlide Octaves per second, per second.
 * @property {number} vibratoDepth Semitones, peak.
 * @property {number} vibratoRate Hz.
 * @property {number} arpAmount Semitones jumped once `arpTime` elapses. 0 disables.
 * @property {number} arpTime Seconds from trigger to the jump.
 * @property {number} duty Square high fraction. The NES offered .125, .25, .5, .75.
 * @property {number} dutySweep Duty change per second.
 * @property {number} attack Seconds, silence to full.
 * @property {number} sustain Seconds held at full.
 * @property {number} decay Seconds, full to silence.
 * @property {number} punch Extra gain at the top of sustain, fading over it. The "coin" spike.
 * @property {number} repeatRate Hz. Re-triggers pitch, duty and arpeggio without touching the envelope. 0 disables.
 * @property {number} flangerOffset Milliseconds of delayed copy. Sign only steers the sweep's start.
 * @property {number} flangerSweep Milliseconds per second.
 * @property {number} lowPassCutoff Hz. At the top of its range the filter is bypassed entirely.
 * @property {number} lowPassSweep Octaves per second on the cutoff.
 * @property {number} resonance 0 dull to 1 ringing.
 * @property {number} highPassCutoff Hz. 0 disables.
 * @property {number} highPassSweep Octaves per second on the cutoff.
 * @property {number} bitDepth Output quantized to this many bits. 16 is clean; 4 is a period DAC.
 * @property {number} sampleHold Each source sample held this many output samples — sample-rate grit. 1 is off.
 * @property {number} volume 0..1.
 */

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const finite = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

/**
 * Exact powers of two for what `renderSfx` needs, without `Math.pow` —
 * which, like the trig it sits beside, ECMAScript leaves
 * implementation-approximated. Integer part by repeated doubling (each step
 * exact in binary64), fractional part as the Maclaurin series of
 * exp(x · ln 2) with the coefficients written as divisions by integer
 * factorial literals, all under 2^53 and therefore exact. |x| is clamped to
 * 20 by every caller's construction: pitch spans under eight octaves and the
 * octave offset is clamped before it gets here.
 */
export function exp2(x) {
  const LN2 = 0.6931471805599453;
  const n = Math.floor(x);
  const f = (x - n) * LN2;
  let term = 1;
  let sum = 1;
  // Seventeen terms: the remainder is (ln 2)^18/18! before the argument even
  // shrinks, comfortably under an ulp, where thirteen terms measurably was not.
  for (let k = 1; k <= 17; k += 1) {
    term = term * f / k;
    sum += term;
  }
  let scale = 1;
  if (n >= 0) for (let i = 0; i < n; i += 1) scale *= 2;
  else for (let i = 0; i > n; i -= 1) scale /= 2;
  return sum * scale;
}

/**
 * Clamp, never throw, and unrecognizable input comes back as the default —
 * the same stance as every document in this package. Numbers land inside
 * SFX_RANGES, enums fall back to their first legal value, and the result is
 * always a fresh object safe to mutate.
 *
 * @param {unknown} [input]
 * @returns {SfxDefinition}
 */
export function normalizeSfx(input) {
  const source = input && typeof input === "object" ? /** @type {Record<string, unknown>} */ (input) : {};
  /** @type {SfxDefinition} */
  const sfx = {
    version: SFX_VERSION,
    name: typeof source.name === "string" ? source.name.slice(0, 64) : "Untitled",
    seed: 1,
    wave: SFX_WAVES.includes(/** @type {string} */ (source.wave)) ? /** @type {SfxWave} */ (source.wave) : "square",
    noiseMode: SFX_NOISE_MODES.includes(/** @type {string} */ (source.noiseMode)) ? /** @type {SfxNoiseMode} */ (source.noiseMode) : "long",
    frequency: 0, minFrequency: 0, slide: 0, deltaSlide: 0,
    vibratoDepth: 0, vibratoRate: 0, arpAmount: 0, arpTime: 0,
    duty: 0, dutySweep: 0,
    attack: 0, sustain: 0, decay: 0, punch: 0, repeatRate: 0,
    flangerOffset: 0, flangerSweep: 0,
    lowPassCutoff: 0, lowPassSweep: 0, resonance: 0,
    highPassCutoff: 0, highPassSweep: 0,
    bitDepth: 0, sampleHold: 0, volume: 0,
  };
  for (const key of Object.keys(SFX_RANGES)) {
    const [min, max, fallback] = SFX_RANGES[key];
    sfx[key] = clamp(finite(source[key], fallback), min, max);
  }
  sfx.seed = Math.floor(sfx.seed);
  sfx.bitDepth = Math.round(sfx.bitDepth);
  sfx.sampleHold = Math.round(sfx.sampleHold);
  return sfx;
}

/** A plain beep to start designing from. */
export function createDefaultSfx(name = "Untitled") {
  return normalizeSfx({ name });
}

/** Seconds a definition renders: the envelope is the whole sound. */
export function sfxDuration(definition) {
  const sfx = normalizeSfx(definition);
  return sfx.attack + sfx.sustain + sfx.decay;
}

// The NES noise channel in five lines: 15-bit shift register, feedback from
// bit 0 xor bit 1 — or bit 6 in short mode, which collapses the sequence to
// 93 steps and turns hiss into that metallic buzz. Deterministic by
// construction, which is why noise needs no random source here.
const stepLfsr = (state, short) => {
  const feedback = (state ^ (state >> (short ? 6 : 1))) & 1;
  return (state >> 1) | (feedback << 14);
};

const TWO_PI = Math.PI * 2;
const FLANGER_SIZE = 2048; // power of two so the ring index is a mask

/**
 * The renderer. A pure function: (definition, sampleRate) in, samples out,
 * same bits every time. Runs at authoring or load time, not per frame — at
 * 44.1kHz a one-second effect is ~44k iterations of plain arithmetic, which
 * is nothing.
 *
 * @param {SfxDefinition | unknown} definition Normalized on the way in, so a
 *        stale or hand-written document degrades to a clamped sound rather
 *        than an exception.
 * @param {object} [options]
 * @param {number} [options.sampleRate]
 * @returns {Float32Array}
 */
export function renderSfx(definition, { sampleRate = 44100 } = {}) {
  const sfx = normalizeSfx(definition);
  const rate = clamp(finite(sampleRate, 44100), 8000, 96000);
  const total = Math.max(1, Math.floor((sfx.attack + sfx.sustain + sfx.decay) * rate));
  const out = new Float32Array(total);

  // Oscillator state. `triggerTime` restarts on every repeat tick; the
  // envelope, filters and flanger deliberately do not — that is what makes a
  // repeat sound like one effect stuttering rather than many effects queued.
  let phase = 0;
  let triggerTime = 0;
  let lfsr = (sfx.seed & 0x7fff) || 1;
  let noiseAccumulator = 0;
  let noiseLevel = (lfsr & 1) ? 1 : -1;
  let held = 0;

  // Two Chamberlin state-variable filters: the low-pass reads its `low`
  // output, the high-pass its `high`. Coefficient f = 2·sin(π·fc/rate),
  // stable while fc stays under about rate/6, which the clamp enforces —
  // and, less famously, only while f² + 2·f·damping < 4. The second bound
  // is the one that bites: at the rate/6.5 ceiling f is 0.93, which a damping
  // above 1.69 (resonance under 0.16) pushes over the line, and the filter
  // then diverges into a full-scale whine at the Nyquist frequency. A dull,
  // wide-open low-pass is the most ordinary setting there is, so the
  // coefficient is capped from the damping too, with a little margin. A
  // document the old ceiling already kept stable renders bit for bit as
  // before, because the cap only lowers what would have blown up.
  let lpCutoff = sfx.lowPassCutoff;
  let hpCutoff = sfx.highPassCutoff;
  const lpBypassed = sfx.lowPassCutoff >= 20000 && sfx.lowPassSweep >= 0;
  const lpDamp = clamp(2 * (1 - sfx.resonance), 0.07, 2);
  const lpCoefficientCap = 0.95 * (Math.sqrt(lpDamp * lpDamp + 4) - lpDamp);
  let lpLow = 0, lpBand = 0, hpLow = 0, hpBand = 0;

  const flangerOn = sfx.flangerOffset !== 0 || sfx.flangerSweep !== 0;
  const flanger = flangerOn ? new Float32Array(FLANGER_SIZE) : null;

  const repeatEvery = sfx.repeatRate > 0 ? 1 / sfx.repeatRate : Infinity;
  let nextRepeat = repeatEvery;

  const dt = 1 / rate;
  const nyquistish = rate * 0.45;
  const filterCeiling = rate / 6.5;

  // Everything below this line was being recomputed once per output sample —
  // 44,100 times a second — from operands that cannot change inside the loop.
  // Hoisting them is an exact transformation, not an approximation: each is a
  // pure function of values fixed before the first sample, so the buffer comes
  // out bit for bit as it did, which the golden-render test above pins.
  //
  // The two sweep factors are the expensive ones. `exp2` is a seventeen-term
  // series and the per-sample pitch call on line ~400 already has to pay for
  // one; paying for three was the difference between a sound effect rendering
  // in 5 ms and in 3 ms, and 5 ms is a dropped frame the first time a sound
  // plays.
  const lpSweeping = sfx.lowPassSweep !== 0;
  const hpSweeping = sfx.highPassSweep !== 0;
  const lpSweepFactor = lpSweeping ? exp2(sfx.lowPassSweep * dt) : 1;
  const hpSweepFactor = hpSweeping ? exp2(sfx.highPassSweep * dt) : 1;
  // A filter coefficient only moves when its cutoff is being swept. Standing
  // still — which is most documents — it is one `sin` for the whole render
  // instead of one per sample.
  const lpFixedCoefficient = lpSweeping
    ? 0
    : Math.min(lpCoefficientCap, 2 * sin(Math.PI * clamp(lpCutoff, 20, filterCeiling) / rate));
  const hpFixedCoefficient = hpSweeping
    ? 0
    : 2 * sin(Math.PI * clamp(hpCutoff, 20, filterCeiling) / rate);
  // The DAC's step count is 2^(bitDepth-1), and bitDepth is a constant.
  const crushing = sfx.bitDepth < 16;
  let bitLevels = 1;
  if (crushing) for (let b = 0; b < sfx.bitDepth - 1; b += 1) bitLevels *= 2;

  for (let i = 0; i < total; i += 1) {
    const t = i * dt;
    if (t >= nextRepeat) {
      triggerTime = t;
      nextRepeat += repeatEvery;
    }
    const sinceTrigger = t - triggerTime;

    // Pitch: base × 2^(slide + arpeggio + vibrato), all in octaves so they
    // compose by addition. The offset is clamped before exp2 so a runaway
    // delta-slide cannot ask for 2^500.
    let octaves = sfx.slide * sinceTrigger + 0.5 * sfx.deltaSlide * sinceTrigger * sinceTrigger;
    if (sfx.arpAmount !== 0 && sinceTrigger >= sfx.arpTime) octaves += sfx.arpAmount / 12;
    if (sfx.vibratoDepth > 0) octaves += sin(TWO_PI * sfx.vibratoRate * t) * sfx.vibratoDepth / 12;
    const frequency = sfx.frequency * exp2(clamp(octaves, -16, 16));
    if (sfx.minFrequency > 0 && frequency < sfx.minFrequency) break; // the laser has landed

    let sample;
    if (sfx.wave === "noise") {
      // The LFSR clocks at 32× the pitch slider and HOLDS between clocks —
      // pitched noise the way the hardware made it, not filtered hiss.
      noiseAccumulator += clamp(frequency * 32, 0, rate * 8) * dt;
      let steps = Math.min(64, Math.floor(noiseAccumulator));
      noiseAccumulator -= Math.floor(noiseAccumulator);
      while (steps > 0) {
        lfsr = stepLfsr(lfsr, sfx.noiseMode === "short");
        steps -= 1;
      }
      noiseLevel = (lfsr & 1) ? 1 : -1;
      sample = noiseLevel;
    } else {
      phase += clamp(frequency, 0, nyquistish) * dt;
      phase -= Math.floor(phase);
      if (sfx.wave === "square") {
        const duty = clamp(sfx.duty + sfx.dutySweep * sinceTrigger, 0.02, 0.98);
        sample = phase < duty ? 1 : -1;
      } else if (sfx.wave === "saw") {
        sample = 2 * phase - 1;
      } else if (sfx.wave === "triangle") {
        // The NES triangle is a 32-step staircase — 16 levels up, 16 down —
        // and the steps are the sound. A smooth triangle is a different era.
        const step = Math.floor(phase * 32) & 31;
        const level = step < 16 ? step : 31 - step;
        sample = level / 7.5 - 1;
      } else {
        sample = sin(TWO_PI * phase);
      }
    }

    // Sample-rate grit first, so the filters see the crunch the way a real
    // signal chain would.
    if (sfx.sampleHold > 1) {
      if (i % sfx.sampleHold === 0) held = sample;
      sample = held;
    }

    if (!lpBypassed) {
      const f = lpSweeping
        ? Math.min(lpCoefficientCap, 2 * sin(Math.PI * clamp(lpCutoff, 20, filterCeiling) / rate))
        : lpFixedCoefficient;
      lpLow += f * lpBand;
      const high = sample - lpLow - lpDamp * lpBand;
      lpBand += f * high;
      sample = lpLow;
      if (lpSweeping) lpCutoff = clamp(lpCutoff * lpSweepFactor, 20, 22050);
    }
    if (hpCutoff > 20) {
      const f = hpSweeping
        ? 2 * sin(Math.PI * clamp(hpCutoff, 20, filterCeiling) / rate)
        : hpFixedCoefficient;
      hpLow += f * hpBand;
      const high = sample - hpLow - 1.4 * hpBand;
      hpBand += f * high;
      sample = high;
    }
    if (hpSweeping) hpCutoff = clamp(hpCutoff * hpSweepFactor, 0, 4000);

    if (flanger) {
      const offsetMs = Math.abs(sfx.flangerOffset + sfx.flangerSweep * t);
      const offset = Math.min(FLANGER_SIZE - 1, Math.round(offsetMs * rate / 1000));
      flanger[i & (FLANGER_SIZE - 1)] = sample;
      if (offset > 0) sample += flanger[(i - offset) & (FLANGER_SIZE - 1)];
    }

    // Envelope: linear attack, sustain riding the punch down to 1, linear
    // decay. Punch can push past 1; the final clamp is the ceiling.
    let envelope;
    if (t < sfx.attack) envelope = sfx.attack > 0 ? t / sfx.attack : 1;
    else if (t < sfx.attack + sfx.sustain) {
      const progress = sfx.sustain > 0 ? (t - sfx.attack) / sfx.sustain : 1;
      envelope = 1 + sfx.punch * (1 - progress);
    } else {
      const progress = sfx.decay > 0 ? (t - sfx.attack - sfx.sustain) / sfx.decay : 1;
      envelope = 1 - progress;
    }
    sample *= envelope;

    // The DAC goes last: everything above it, envelope included, lands on
    // the same coarse grid — which is what a 4-bit tail actually did.
    if (crushing) sample = Math.round(sample * bitLevels) / bitLevels;

    out[i] = clamp(sample * sfx.volume, -1, 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Presets, randomize, mutate — the sfxr trio. All deterministic: presets are
// literals, and the two random ones take an explicit seed so a caller who
// wants surprise supplies the entropy (authoring-time code may use
// Math.random for the seed; this module may not).

export const SFX_PRESETS = ["Coin", "Laser", "Explosion", "Powerup", "Hit", "Jump", "Blip", "Buzzer"];

/** @type {Record<string, Partial<SfxDefinition>>} */
const PRESET_RECIPES = {
  Coin: { wave: "square", duty: 0.5, frequency: 1320, sustain: 0.05, decay: 0.35, punch: 0.55, arpAmount: 5, arpTime: 0.06 },
  Laser: { wave: "square", duty: 0.2, frequency: 1600, minFrequency: 260, slide: -5.5, sustain: 0.08, decay: 0.12, highPassCutoff: 120 },
  Explosion: { wave: "noise", frequency: 130, slide: -1.6, sustain: 0.12, decay: 0.85, punch: 0.6, lowPassCutoff: 7500, lowPassSweep: -2.5, resonance: 0.25 },
  Powerup: { wave: "square", duty: 0.5, frequency: 440, slide: 2.2, sustain: 0.3, decay: 0.3, repeatRate: 12 },
  Hit: { wave: "noise", noiseMode: "short", frequency: 320, slide: -3.5, sustain: 0.04, decay: 0.18, punch: 0.3 },
  Jump: { wave: "square", duty: 0.35, frequency: 330, slide: 1.6, sustain: 0.12, decay: 0.2, highPassCutoff: 180 },
  Blip: { wave: "square", duty: 0.5, frequency: 660, sustain: 0.04, decay: 0.06 },
  Buzzer: { wave: "noise", noiseMode: "short", frequency: 440, sustain: 0.18, decay: 0.12, bitDepth: 8 },
};

/**
 * A named starting point. Unknown names come back as the default beep, in
 * keeping with never throwing over a document.
 *
 * @param {string} name
 * @param {number} [seed]
 * @returns {SfxDefinition}
 */
export function createSfxPreset(name, seed = 1) {
  const recipe = PRESET_RECIPES[name];
  return normalizeSfx({ ...recipe, name: recipe ? name : "Untitled", seed });
}

const randomBetween = (random, min, max) => min + random() * (max - min);

/**
 * A whole sound from a seed: era wave, log-distributed pitch, short envelope,
 * and each trick rolled in with its own probability. Tuned to land on
 * something playable rather than uniform noise over 24 parameters.
 *
 * @param {number} seed
 * @returns {SfxDefinition}
 */
export function randomSfx(seed) {
  const random = createSeededRandom(seed | 0 || 1);
  const wave = ["square", "square", "triangle", "saw", "noise"][Math.floor(random() * 5)];
  /** @type {Record<string, unknown>} */
  const draft = {
    name: "Random",
    seed: Math.floor(random() * 2147483646) + 1,
    wave,
    noiseMode: random() < 0.35 ? "short" : "long",
    frequency: 100 * exp2(random() * 4.3), // 100Hz to ~2kHz, evenly by octave
    duty: randomBetween(random, 0.1, 0.9),
    attack: random() < 0.15 ? randomBetween(random, 0, 0.2) : 0,
    sustain: randomBetween(random, 0.02, 0.35),
    decay: randomBetween(random, 0.05, 0.6),
    punch: random() < 0.5 ? randomBetween(random, 0.1, 0.8) : 0,
    slide: random() < 0.6 ? randomBetween(random, -4, 4) : 0,
    volume: 0.5,
  };
  if (random() < 0.25) draft.deltaSlide = randomBetween(random, -6, 6);
  if (random() < 0.3) { draft.vibratoDepth = randomBetween(random, 0.3, 3); draft.vibratoRate = randomBetween(random, 4, 18); }
  if (random() < 0.3) { draft.arpAmount = Math.round(randomBetween(random, -12, 12)); draft.arpTime = randomBetween(random, 0.03, 0.3); }
  if (random() < 0.25) draft.repeatRate = randomBetween(random, 4, 20);
  if (random() < 0.2) { draft.flangerOffset = randomBetween(random, -4, 4); draft.flangerSweep = randomBetween(random, -2, 2); }
  if (random() < 0.3) { draft.lowPassCutoff = 400 * exp2(random() * 5); draft.resonance = randomBetween(random, 0, 0.8); }
  if (random() < 0.2) draft.highPassCutoff = randomBetween(random, 50, 800);
  if (random() < 0.25) draft.bitDepth = Math.round(randomBetween(random, 4, 10));
  if (random() < 0.2) draft.sampleHold = Math.round(randomBetween(random, 2, 12));
  return normalizeSfx(draft);
}

/**
 * Nudge a sound without losing it: each numeric parameter moves with
 * probability one-half, by at most `amount` of its full range. The sfxr
 * "mutate" button, and the fastest way to find the sound next door to a
 * preset.
 *
 * @param {SfxDefinition | unknown} definition
 * @param {number} seed
 * @param {number} [amount]
 * @returns {SfxDefinition}
 */
export function mutateSfx(definition, seed, amount = 0.05) {
  const sfx = normalizeSfx(definition);
  const random = createSeededRandom(seed | 0 || 1);
  for (const key of Object.keys(SFX_RANGES)) {
    if (key === "seed" || key === "volume") continue;
    const [min, max] = SFX_RANGES[key];
    if (random() < 0.5) sfx[key] += (random() * 2 - 1) * (max - min) * amount;
  }
  return normalizeSfx(sfx);
}

// ---------------------------------------------------------------------------
// WAV. A designer whose output cannot leave the page is a toy; sixteen-bit
// mono PCM in a RIFF container is forty-four bytes of header and every tool
// on earth opens it.

/**
 * @param {Float32Array} samples
 * @param {number} [sampleRate]
 * @returns {ArrayBuffer}
 */
export function samplesToWav(samples, sampleRate = 44100) {
  const rate = Math.floor(clamp(finite(sampleRate, 44100), 8000, 96000));
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const ascii = (offset, text) => { for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i)); };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);   // PCM chunk size
  view.setUint16(20, 1, true);    // PCM
  view.setUint16(22, 1, true);    // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // byte rate
  view.setUint16(32, 2, true);    // block align
  view.setUint16(34, 16, true);   // bits per sample
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(44 + i * 2, Math.round(clamp(samples[i], -1, 1) * 32767), true);
  }
  return buffer;
}

/**
 * Render a definition straight to a WAV file body.
 *
 * @param {SfxDefinition | unknown} definition
 * @param {object} [options]
 * @param {number} [options.sampleRate]
 * @returns {ArrayBuffer}
 */
export function sfxToWav(definition, { sampleRate = 44100 } = {}) {
  return samplesToWav(renderSfx(definition, { sampleRate }), sampleRate);
}
