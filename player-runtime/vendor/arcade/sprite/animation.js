// Animation: named clips over sprite assets.
//
// The part of the sprite module that is new rather than promoted. Every game
// here that has ever drawn a walk cycle has hand-rolled the same arithmetic —
// hold a frame for its duration, wrap or stop or bounce at the end — and the
// construction set needs it as a *document*, because which frame a character
// shows is something an author designs, saves and shares.
//
// A clip references sprite assets by id and owns nothing else: no drawing, no
// clock, no state. `clipFrameAt` is a pure function of the clip and a time, so
// a renderer asks fresh every frame and a rolled-back simulation cannot be
// holding a stale animation cursor — there is no cursor.

import { defineFormat } from "../core/document.js";
import { clampTo } from "./assets.js";

/**
 * Animation schema version.
 *
 * **2 adds the state bindings.** A v1 set is a complete v2 set with no
 * bindings, so nothing about an existing file changes and `clipForState`
 * falls through to the name match v1 relied on. A v2 file is refused by an
 * older build, which is the point of the number: a set whose "walk" state
 * points at a clip named "Stroll" would otherwise open silently in an old
 * reader and show the wrong art. A set EMBEDDED in another document (a
 * runnjump level does this) carries no envelope and so no version, and
 * there the bindings simply appear or are dropped by whichever normalizer
 * runs -- both directions degrade to the name match.
 */
export const ANIMATION_VERSION = 2;

/**
 * @typedef {object} AnimationFrame
 * @property {string} assetId Sprite asset drawn for this frame.
 * @property {number} duration Seconds the frame holds.
 * @property {boolean} [flipX] Drawn mirrored. Presentation-only; the
 *          simulation never reads it.
 * @property {boolean} [flipY]
 */

/**
 * @typedef {"loop"|"once"|"pingpong"} AnimationMode
 */

/**
 * @typedef {object} AnimationClip
 * @property {string} id
 * @property {string} name The name a behaviour asks for: "walk", "idle", "hurt".
 * @property {AnimationMode} mode
 * @property {AnimationFrame[]} frames
 */

/**
 * @typedef {object} AnimationSet
 * @property {string} name
 * @property {AnimationClip[]} clips
 * @property {Record<string, string>} states Which clip plays for a state the
 *          game is in -- "walk", "idle", "hurt". The value is a clip id, or
 *          a clip name for a file somebody wrote by hand. See `clipForState`.
 * @property {string} fallback Clip shown for a state with no binding and no
 *          clip of its own name. Empty for none, which is a game that would
 *          rather draw nothing than the wrong thing.
 */

/**
 * Clamp one clip into range. Returns null for anything with no usable frame,
 * because a clip that cannot show anything is not a clip — the set-level
 * normalizer drops those the way `normalizeAssets` drops unreadable sprites.
 *
 * @param {any} input
 * @returns {AnimationClip | null}
 */
export function normalizeClip(input) {
  if (!input || typeof input !== "object") return null;
  const frames = (Array.isArray(input.frames) ? input.frames : [])
    .slice(0, 64)
    .filter((frame) => frame && typeof frame.assetId === "string" && frame.assetId.length > 0)
    .map((frame) => ({
      assetId: frame.assetId.slice(0, 80),
      // The floor is one 240Hz tick: a zero-length frame makes `clipFrameAt`'s
      // walk order-dependent, and nothing an eye can see is shorter anyway.
      duration: clampTo(Number(frame.duration) || 0.1, 1 / 240, 10),
      flipX: frame.flipX === true,
      flipY: frame.flipY === true,
    }));
  if (frames.length === 0) return null;
  return {
    id: typeof input.id === "string" && input.id ? input.id.slice(0, 80) : "clip",
    name: typeof input.name === "string" && input.name ? input.name.slice(0, 40) : "clip",
    mode: input.mode === "once" || input.mode === "pingpong" ? input.mode : "loop",
    frames,
  };
}

/**
 * The state bindings, clamped. Keys and values are bounded strings and
 * nothing more: a binding that names a clip which no longer exists is KEPT,
 * the same rule `core/fields` states for every reference here. A designer
 * who deletes a clip and undoes it has not lost the state that pointed at
 * it, and resolution already answers "nothing" for a dangling one.
 *
 * @param {any} input
 * @returns {Record<string, string>}
 */
function normalizeStateBindings(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  /** @type {Record<string, string>} */
  const states = {};
  for (const [state, clip] of Object.entries(input).slice(0, 64)) {
    const key = String(state).trim().slice(0, 40);
    if (!key || typeof clip !== "string" || !clip.trim()) continue;
    states[key] = clip.trim().slice(0, 80);
  }
  return states;
}

/**
 * @param {any} input
 * @returns {AnimationSet}
 */
export function normalizeAnimationSet(input) {
  const clips = (Array.isArray(input?.clips) ? input.clips : [])
    .slice(0, 64)
    .map(normalizeClip)
    .filter((clip) => clip !== null);
  return {
    name: typeof input?.name === "string" && input.name ? input.name.slice(0, 80) : "Animations",
    clips: /** @type {AnimationClip[]} */ (clips),
    states: normalizeStateBindings(input?.states),
    fallback: typeof input?.fallback === "string" ? input.fallback.trim().slice(0, 80) : "",
  };
}

/** @param {string} [name] @returns {AnimationSet} */
export function emptyAnimationSet(name = "Animations") {
  return { name, clips: [], states: {}, fallback: "" };
}

/**
 * One full cycle of a clip, in seconds. For pingpong that is forward plus the
 * way back — the way back skips both endpoints, so a bounce does not hold the
 * turnaround frame twice.
 *
 * @param {AnimationClip} clip
 */
export function clipDuration(clip) {
  const forward = clip.frames.reduce((sum, frame) => sum + frame.duration, 0);
  if (clip.mode !== "pingpong" || clip.frames.length < 2) return forward;
  const back = forward - clip.frames[0].duration - clip.frames[clip.frames.length - 1].duration;
  return forward + Math.max(back, 0);
}

/**
 * Which frame a clip shows at a given time. Pure arithmetic — additions,
 * comparisons and one modulo — so it is deterministic across machines and
 * free to be asked again during a rollback.
 *
 * @param {AnimationClip} clip
 * @param {number} time Seconds since the clip started. Negative time folds
 *        into the cycle for the looping modes and clamps to the first frame
 *        for `once`.
 * @returns {number} An index into `clip.frames`.
 */
export function clipFrameAt(clip, time) {
  const frames = clip.frames;
  const forward = frames.reduce((sum, frame) => sum + frame.duration, 0);
  let t;
  if (clip.mode === "once") {
    if (time >= forward) return frames.length - 1;
    t = Math.max(time, 0);
  } else if (clip.mode === "pingpong" && frames.length > 1) {
    const cycle = clipDuration(clip);
    // Fold only when negative. `((t % c) + c) % c` would be the one-liner, but
    // its second modulo turns an exact positive `0.1` into `0.09999…8` and
    // moves every frame boundary a hair early.
    t = time % cycle;
    if (t < 0) t += cycle;
    if (t >= forward) {
      let remaining = t - forward;
      for (let index = frames.length - 2; index >= 1; index -= 1) {
        if (remaining < frames[index].duration) return index;
        remaining -= frames[index].duration;
      }
      return 0;
    }
  } else {
    t = time % forward;
    if (t < 0) t += forward;
  }
  let remaining = t;
  for (let index = 0; index < frames.length; index += 1) {
    if (remaining < frames[index].duration) return index;
    remaining -= frames[index].duration;
  }
  return frames.length - 1;
}

/**
 * Find a clip by name, case-sensitively. Returns undefined rather than a
 * fallback: which clip stands in for a missing one ("walk" when there is no
 * "run") is a game's decision, not this module's.
 *
 * @param {AnimationSet} set
 * @param {string} name
 */
export function findClip(set, name) {
  return set.clips.find((clip) => clip.name === name);
}

/**
 * Resolve one reference -- a clip id, or a clip name for a file somebody
 * wrote by hand. Id first, because an id survives a rename and a name does
 * not; name second, because a hand-written `states: { walk: "Walk" }` is
 * the obvious thing to type and refusing it would be pedantry.
 *
 * @param {AnimationSet} set
 * @param {string} reference
 * @returns {AnimationClip | undefined}
 */
function clipByReference(set, reference) {
  if (!reference) return undefined;
  return set.clips.find((clip) => clip.id === reference) ??
    set.clips.find((clip) => clip.name === reference);
}

/**
 * Which clip plays while the game is in `state`.
 *
 * This is the whole of "apply an animation to a character's states", and it
 * is four steps in one order:
 *
 * 1. the binding the set declares for that state;
 * 2. failing that, a clip **named** for the state -- which is exactly what
 *    `findClip` does, so every set authored before bindings existed keeps
 *    behaving as it did;
 * 3. failing that, the set's declared `fallback`;
 * 4. failing that, nothing.
 *
 * Step 4 is `undefined` rather than the first clip on purpose. Which clip
 * stands in for a missing one is a decision, and a set that wants one says
 * so in `fallback` -- a renderer quietly showing clip zero is how a missing
 * "hurt" animation ships as a character who idles while being hit.
 *
 * @param {AnimationSet} set
 * @param {string} state
 * @returns {AnimationClip | undefined}
 */
export function clipForState(set, state) {
  if (!set || !Array.isArray(set.clips)) return undefined;
  const bound = set.states?.[state];
  return (bound ? clipByReference(set, bound) : undefined) ??
    set.clips.find((clip) => clip.name === state) ??
    clipByReference(set, set.fallback ?? "");
}

/**
 * The frame a character in `state` shows, `age` seconds after entering it.
 *
 * The one call a renderer makes per animated thing per frame, and pure, so
 * a rollback that replays a tick asks again and gets the same answer. Every
 * game here that draws a walk cycle otherwise writes these six lines
 * itself: look the set up, find the clip, walk the durations, take the
 * frame, remember the flips.
 *
 * @param {AnimationSet} set
 * @param {string} state
 * @param {number} age Seconds since the state was entered.
 * @returns {{clip: AnimationClip, frame: AnimationFrame, index: number} | null}
 */
export function animationFrameAt(set, state, age) {
  const clip = clipForState(set, state);
  if (!clip || clip.frames.length === 0) return null;
  const index = clipFrameAt(clip, age);
  return { clip, frame: clip.frames[index], index };
}

/**
 * Every state this set has an answer for: the ones it binds, plus the ones
 * a clip is named after. What an editor lists, and what a game can check
 * its own vocabulary against.
 *
 * @param {AnimationSet} set
 * @returns {string[]}
 */
export function animationStates(set) {
  const named = new Set(Object.keys(set?.states ?? {}));
  for (const clip of set?.clips ?? []) named.add(clip.name);
  return [...named].sort();
}

/**
 * @param {object} [options]
 * @param {string} [options.format]
 * @param {number} [options.maxBytes] Cap for share links. Clips are ids and
 *        numbers, so this is the smallest cap in the sprite module.
 * @param {(raw: any, fromVersion: number) => any} [options.migrate]
 * @param {{event?: Function} | ((name: string, data?: unknown) => unknown)} [options.report]
 */
export function defineAnimationFormat({
  format = "arcade-animation-set",
  maxBytes = 128 * 1024,
  migrate,
  report,
} = {}) {
  return defineFormat({
    format,
    version: ANIMATION_VERSION,
    maxBytes,
    migrate,
    report,
    extension: "animation.json",
    sanitize: normalizeAnimationSet,
  });
}
