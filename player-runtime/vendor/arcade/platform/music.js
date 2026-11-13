// Background music: recorded pieces, assigned per level, crossfaded on change.
//
// The third audio module, and the one that plays *files*. `platform/audio`
// plays declared oscillator stacks ("the bumper went bing"), `sfx` renders
// designed documents to a buffer — this one fetches whatever the browser can
// decode (MP3, OGG, WAV, M4A/AAC, FLAC — `decodeAudioData` decides, not this
// module) and keeps exactly one piece sounding at a time. None of the three
// imports another; a game may use all of them.
//
// Music is presentation, always. A track choice never goes inside `step()` —
// the game maps its own state (usually the level) to a track name out here,
// which is what `assign`/`playFor` exist for. `playFor` is deliberately a
// no-op when the assigned piece is already sounding, so calling it on every
// level start is the whole integration: retries of a level, and two adjacent
// levels sharing a track, do not restart the music.
//
// Follows the family manners: lazy context, resume on every play, a swappable
// AudioContextClass (and fetch) so a test can run without an audio device.

import { createReporter } from "../core/report.js";

/**
 * @typedef {object} MusicTrack
 * @property {string} src URL of the audio file, any format the browser decodes.
 * @property {number} [volume] This track's level, 0..1, under the master gain.
 * @property {boolean} [loop] Repeat forever. Defaults to true — unless `next`
 *           is set, which implies the piece is meant to end.
 * @property {string|null} [next] Track to start when this one ends. An intro
 *           that hands off to its loop, or an album that plays through.
 * @property {number} [loopStart] Loop region start, in seconds. Encoder
 *           padding makes many MP3s gap at the seam; a trimmed region is the fix.
 * @property {number} [loopEnd] Loop region end, in seconds. 0 means the
 *           natural end of the buffer.
 */

/** @param {MusicTrack|string|null|undefined} input */
function normalizeMusicTrack(input) {
  /** @type {MusicTrack} */
  const track = typeof input === "string" ? { src: input } : input && typeof input === "object" ? input : { src: "" };
  const next = typeof track.next === "string" && track.next ? track.next : null;
  const seconds = (value) => Math.max(0, Number(value) || 0);
  return {
    src: typeof track.src === "string" ? track.src : "",
    volume: Math.min(1, Math.max(0, Number(track.volume ?? 1) || 0)),
    loop: Boolean(track.loop ?? next === null),
    next,
    loopStart: seconds(track.loopStart),
    loopEnd: seconds(track.loopEnd),
  };
}

/** Fades are seconds a human chose; anything longer than a minute is a typo. */
const MUSIC_MAX_FADE = 60;

/**
 * @param {object} [options]
 * @param {Record<string, MusicTrack|string>} [options.tracks] Named pieces.
 *        A bare string is shorthand for `{ src }`.
 * @param {Record<string|number, string|null>} [options.levels] Level → track
 *        name. `null` means that level is deliberately silent.
 * @param {number} [options.masterGain]
 * @param {boolean} [options.enabled]
 * @param {number} [options.crossfadeSeconds] Default fade when switching
 *        pieces, overridable per call.
 * @param {typeof AudioContext} [options.AudioContextClass] Swappable so a test
 *        can run without a real audio device.
 * @param {typeof fetch} [options.fetchImpl] Swappable for the same reason.
 * @param {{event?: Function} | ((name: string, data?: unknown) => unknown)} [options.report]
 */
export function createMusic({
  tracks = {},
  levels = {},
  masterGain = 0.5,
  enabled = true,
  crossfadeSeconds = 1,
  AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext,
  fetchImpl = globalThis.fetch,
  report,
} = {}) {
  const reportEvent = createReporter(report);
  /** @type {Map<string, ReturnType<typeof normalizeMusicTrack>>} */
  const defined = new Map();
  /** @type {Map<string, string|null>} */
  const levelTracks = new Map();
  /** Decoded buffers by src, as promises so concurrent loads share one fetch. */
  const buffers = new Map();
  const crossfade = Math.min(MUSIC_MAX_FADE, Math.max(0, Number(crossfadeSeconds) || 0));

  let context = null;
  let master = null;
  let active = Boolean(enabled);
  /** The piece the game last asked for — kept while disabled or still loading. */
  let desired = null;
  /** What is actually sounding: { name, def, source, gain, stopped }. */
  let handle = null;
  /** Bumped by every play/stop; a decode that returns stale is discarded. */
  let generation = 0;

  for (const [name, track] of Object.entries(tracks)) defined.set(name, normalizeMusicTrack(track));
  for (const [key, name] of Object.entries(levels)) levelTracks.set(key, name === null ? null : String(name));

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

  /** @param {ReturnType<typeof normalizeMusicTrack>} def */
  function load(def) {
    let pending = buffers.get(def.src);
    if (!pending) {
      pending = Promise.resolve(fetchImpl(def.src))
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.arrayBuffer();
        })
        .then((bytes) => context.decodeAudioData(bytes))
        .catch((error) => {
          // A failed load must not poison the cache — the next play retries.
          buffers.delete(def.src);
          reportEvent("music.load-failed", { src: def.src, reason: error?.message ?? String(error) });
          throw error;
        });
      buffers.set(def.src, pending);
    }
    return pending;
  }

  /** Ramp a sounding piece to silence and schedule its source's end. */
  function fadeOut(target, fade) {
    target.stopped = true;
    const gainParam = target.gain.gain;
    const now = context.currentTime;
    gainParam.cancelScheduledValues(now);
    if (fade > 0) {
      gainParam.setValueAtTime(gainParam.value, now);
      gainParam.linearRampToValueAtTime(0, now + fade);
      target.source.stop(now + fade + 0.05);
    } else {
      gainParam.setValueAtTime(0, now);
      target.source.stop(now);
    }
  }

  function beginTrack(name, def, buffer, fade, fadeExplicit) {
    const previous = handle;
    if (previous && !previous.stopped) fadeOut(previous, fade);
    const now = context.currentTime;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = def.loop;
    if (def.loopStart > 0) source.loopStart = def.loopStart;
    if (def.loopEnd > 0) source.loopEnd = def.loopEnd;
    const gain = context.createGain();
    // Crossfade when replacing a piece; from silence, start at level unless a
    // fade was explicitly asked for — a level's first bar should not creep in.
    const fadeIn = previous || fadeExplicit ? fade : 0;
    if (fadeIn > 0) {
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(def.volume, now + fadeIn);
    } else {
      gain.gain.setValueAtTime(def.volume, now);
    }
    source.connect(gain);
    gain.connect(master);
    const started = { name, def, source, gain, stopped: false };
    source.onended = () => {
      // Fires for manual stops too; only a natural end hands off. The splice
      // to `next` is a butt joint on purpose — the old piece already finished.
      if (started.stopped || handle !== started) return;
      handle = null;
      if (def.next) void play(def.next, { fadeSeconds: 0 });
      else desired = null;
    };
    source.start(now);
    handle = started;
  }

  /**
   * @param {string} name
   * @param {object} [options]
   * @param {number} [options.fadeSeconds] Fade length for this switch,
   *        instead of the configured crossfade.
   * @param {boolean} [options.restart] Begin again even if this piece is
   *        already sounding.
   * @returns {Promise<boolean>} Whether the piece is (still) sounding.
   */
  async function play(name, { fadeSeconds, restart = false } = {}) {
    const def = defined.get(name);
    if (!def || !def.src) {
      reportEvent("music.unknown-track", { name });
      return false;
    }
    desired = name;
    // Disabled remembers the request: enabling starts the right piece.
    if (!active) return false;
    if (!restart && handle && handle.name === name && !handle.stopped) return true;
    const audio = ensure();
    if (!audio) return false;
    const token = ++generation;
    let buffer;
    try {
      buffer = await load(def);
    } catch {
      return false;
    }
    // Decoding is slow enough for the game to have moved on — a later play,
    // a stop, or a disable wins over a load that comes back stale.
    if (token !== generation || !active) return false;
    if (!restart && handle && handle.name === name && !handle.stopped) return true;
    const fadeExplicit = fadeSeconds !== undefined;
    const fade = fadeExplicit ? Math.min(MUSIC_MAX_FADE, Math.max(0, Number(fadeSeconds) || 0)) : crossfade;
    beginTrack(name, def, buffer, fade, fadeExplicit);
    return true;
  }

  /**
   * @param {object} [options]
   * @param {number} [options.fadeSeconds]
   */
  function stop({ fadeSeconds } = {}) {
    desired = null;
    generation += 1;
    if (!handle) return;
    if (context) {
      const fade = fadeSeconds === undefined ? crossfade : Math.min(MUSIC_MAX_FADE, Math.max(0, Number(fadeSeconds) || 0));
      fadeOut(handle, fade);
    }
    handle = null;
  }

  return {
    get enabled() { return active; },
    set enabled(value) {
      const next = Boolean(value);
      if (next === active) return;
      active = next;
      if (!active) {
        // Suspending pauses in place, so re-enabling picks the piece back up.
        if (context?.state === "running") context.suspend().catch(() => {});
        return;
      }
      // The game kept playing while the music was off — catch up to where it
      // is now rather than resuming a level the player already left.
      if (desired && desired !== handle?.name) void play(desired, { fadeSeconds: 0 });
      else if (context?.state === "suspended") context.resume().catch(() => {});
    },
    get supported() { return Boolean(AudioContextClass); },

    /** The piece most recently asked for; null after a stop or a finished, un-chained track. */
    get current() { return desired; },

    /**
     * Add or replace a track. A piece already sounding keeps its old
     * definition until the next play.
     * @param {string} name
     * @param {MusicTrack|string} track
     */
    define(name, track) { defined.set(name, normalizeMusicTrack(track)); },

    /**
     * Map a level to a track name, or pass a whole map at once. `null` marks
     * a level deliberately silent — `playFor` stops the music there, where an
     * unmapped level leaves it alone.
     * @param {string|number|Record<string|number, string|null>} level
     * @param {string|null} [track]
     */
    assign(level, track) {
      if (level && typeof level === "object") {
        for (const [key, name] of Object.entries(level)) levelTracks.set(key, name === null ? null : String(name));
        return;
      }
      levelTracks.set(String(level), track === null ? null : String(track));
    },

    play,
    stop,

    /**
     * Start whatever the level is assigned. Already sounding → no-op, which is
     * what makes "call this on every level start" the entire integration.
     * @param {string|number} level
     * @param {object} [options]
     * @param {number} [options.fadeSeconds]
     * @param {boolean} [options.restart]
     * @returns {Promise<boolean>}
     */
    playFor(level, options) {
      const key = String(level);
      if (!levelTracks.has(key)) return Promise.resolve(false);
      const name = levelTracks.get(key);
      if (name === null) {
        stop(options);
        return Promise.resolve(true);
      }
      return play(name, options);
    },

    /**
     * Fetch and decode ahead of a load screen, without starting anything.
     * @param {string|string[]} [names] Defaults to every defined track.
     * @returns {Promise<boolean>} Whether every requested piece decoded.
     */
    preload(names) {
      const audio = ensure();
      if (!audio) return Promise.resolve(false);
      const list = names === undefined ? [...defined.keys()] : Array.isArray(names) ? names : [names];
      const jobs = list
        .map((name) => defined.get(name))
        .filter((def) => Boolean(def?.src))
        .map((def) => load(def).then(() => true, () => false));
      return Promise.all(jobs).then((results) => results.every(Boolean));
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
      generation += 1;
      handle = null;
      desired = null;
      buffers.clear();
      context?.close?.().catch(() => {});
      context = null;
      master = null;
    },
  };
}
