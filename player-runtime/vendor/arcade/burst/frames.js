// The arithmetic: a document and a moment in, a list of shapes out.
//
// Nothing here draws. That split is what lets one explosion be a canvas of
// smooth shapes, a baked pixel-art sheet, or an SVG string, without three
// designs — the frame is the shared truth and the emitters in
// `burst/draw` are thin.
//
// **Particle properties come from a hash, not a stream.** A generator
// walked in order would make particle 40's angle depend on how many
// particles came before it, so adding one to a layer would reshuffle the
// whole burst under an author's hands. Hashing `(seed, layer, index)`
// instead means every particle owns its numbers: raise a count and the
// existing ones do not move, which is the difference between a designer
// and a slot machine.
//
// Two ways in, one step function, so they cannot drift:
//
//   createBurstRuntime + advanceBurst   live, incremental, cheap per frame
//   burstFrameAt                        any moment, computed from zero —
//                                       what a bake and a scrubbing
//                                       timeline need

import { cos, sin } from "../core/trig.js";
import { burstDuration } from "./contract.js";

/** The integration rate. Fixed so a bake and a live run agree. */
const BURST_STEP = 1 / 60;

/**
 * A 32-bit hash of three integers, in [0, 1). `Math.imul` is the exact
 * 32-bit multiply, so this is stable everywhere — which is what makes a
 * preview trustworthy and a bake cacheable.
 */
function burstHash(seed, layer, index, salt) {
  let h = (seed | 0) ^ Math.imul(layer + 1, 0x27d4eb2d) ^ Math.imul(index + 1, 0x165667b1) ^ Math.imul(salt + 1, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), h | 1);
  h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
  return ((h ^ (h >>> 14)) >>> 0) / 4294967296;
}

/** Linear blend of two `#rrggbb` colours; returns `#rrggbb`. */
export function mixBurstColor(from, to, amount) {
  const t = amount < 0 ? 0 : amount > 1 ? 1 : amount;
  const a = parseInt(from.slice(1), 16);
  const b = parseInt(to.slice(1), 16);
  const channel = (shift) => {
    const low = (a >> shift) & 255;
    const high = (b >> shift) & 255;
    return Math.round(low + (high - low) * t);
  };
  const value = (channel(16) << 16) | (channel(8) << 8) | channel(0);
  return "#" + value.toString(16).padStart(6, "0");
}

/**
 * Every particle's fixed properties, from the document alone. Called by
 * both entry points; exported because a designer may want to show what a
 * layer will produce before playing it.
 *
 * @param {object} burst A normalized burst document.
 */
export function burstParticles(burst) {
  const made = [];
  burst.layers.forEach((layer, layerIndex) => {
    const count = layer.kind === "ring" || layer.kind === "flash" ? 1 : layer.count;
    for (let index = 0; index < count; index += 1) {
      const spin = burstHash(burst.seed, layerIndex, index, 0);
      const speedRoll = burstHash(burst.seed, layerIndex, index, 1);
      const lifeRoll = burstHash(burst.seed, layerIndex, index, 2);
      const delayRoll = burstHash(burst.seed, layerIndex, index, 3);
      // Spread by the golden ratio rather than by `index / count`.
      // Dividing by the count is the obvious way and it is wrong here: it
      // makes every particle's angle depend on how many particles there
      // are, so nudging a layer's count from 8 to 40 rotates the eight
      // that were already there and the burst changes shape under the
      // author's hands. A golden-ratio walk covers the spread just as
      // evenly, is a pure function of the index, and fills the gaps when
      // the count grows instead of reshuffling.
      const step = count > 1 ? ((index * 0.6180339887498949) + spin * 0.04) % 1 : 0.5;
      const angle = layer.angle - layer.spread / 2 + layer.spread * step;
      const speed = layer.speed * (1 - layer.speedVary * speedRoll);
      const life = Math.max(0.02, layer.life * (1 - layer.lifeVary * lifeRoll));
      made.push({
        layer: layerIndex,
        kind: layer.kind,
        angle,
        vx: cos(angle) * speed,
        vy: sin(angle) * speed,
        life,
        delay: layer.delay * (0.5 + 0.5 * delayRoll),
        spinRate: layer.spin * (spin * 2 - 1),
      });
    }
  });
  return made;
}

function layerOf(burst, particle) {
  return burst.layers[particle.layer];
}

/**
 * A live burst at a place. Cheap to advance and cheap to have several of;
 * a game keeps a small array of these and drops the finished ones.
 *
 * @param {object} burst @param {number} [x] @param {number} [y]
 */
export function createBurstRuntime(burst, x = 0, y = 0) {
  return {
    burst,
    x,
    y,
    time: 0,
    duration: burstDuration(burst),
    particles: burstParticles(burst).map((particle) => ({
      ...particle,
      px: 0,
      py: 0,
      age: 0,
      live: false,
    })),
  };
}

/** One integration step, shared so the two paths cannot disagree. */
function stepBurst(runtime, dt) {
  runtime.time += dt;
  for (const particle of runtime.particles) {
    if (runtime.time < particle.delay) continue;
    particle.live = true;
    if (particle.age >= particle.life) continue;
    const layer = layerOf(runtime.burst, particle);
    // Drag first, then gravity: a heavy shard should still fall while it
    // slows, and doing it the other way lets drag eat the fall.
    const damp = 1 / (1 + layer.drag * dt);
    particle.vx *= damp;
    particle.vy = particle.vy * damp + layer.gravity * dt;
    particle.px += particle.vx * dt;
    particle.py += particle.vy * dt;
    particle.age += dt;
  }
}

/**
 * Advance a live burst. Returns true while anything is still showing, so
 * a game can write `if (!advanceBurst(b, dt)) drop(b)`.
 *
 * @param {object} runtime @param {number} dt
 */
export function advanceBurst(runtime, dt) {
  let remaining = Math.max(0, Math.min(0.25, dt));
  while (remaining > 0) {
    const slice = Math.min(BURST_STEP, remaining);
    stepBurst(runtime, slice);
    remaining -= slice;
  }
  return runtime.time < runtime.duration;
}

/**
 * The drawable shapes for a runtime's current moment. Plain data: kind,
 * position, size, colour, alpha — an emitter needs nothing else.
 *
 * @param {object} runtime
 */
export function burstFrame(runtime) {
  const shapes = [];
  for (const particle of runtime.particles) {
    if (!particle.live || particle.age >= particle.life) continue;
    const layer = layerOf(runtime.burst, particle);
    const t = particle.age / particle.life;
    const fade = t <= layer.hold ? 1 : 1 - (t - layer.hold) / Math.max(0.0001, 1 - layer.hold);
    shapes.push({
      kind: particle.kind,
      x: runtime.x + particle.px,
      y: runtime.y + particle.py,
      size: layer.size + (layer.sizeEnd - layer.size) * t,
      color: mixBurstColor(layer.colorFrom, layer.colorTo, t),
      alpha: fade < 0 ? 0 : fade > 1 ? 1 : fade,
      angle: particle.angle + particle.spinRate * particle.age,
    });
  }
  return { time: runtime.time, done: runtime.time >= runtime.duration, shapes };
}

/**
 * The frame at any moment, computed from zero. Slower than advancing a
 * runtime and the only way to address a frame directly, which is what a
 * bake and a scrubbing timeline both need.
 *
 * @param {object} burst @param {number} time @param {number} [x] @param {number} [y]
 */
export function burstFrameAt(burst, time, x = 0, y = 0) {
  const runtime = createBurstRuntime(burst, x, y);
  const target = Math.max(0, time);
  while (runtime.time + BURST_STEP <= target + 1e-9) stepBurst(runtime, BURST_STEP);
  return burstFrame(runtime);
}

/** How many frames a bake needs at a given rate. */
export function burstFrameCount(burst, fps = 30) {
  return Math.max(1, Math.ceil(burstDuration(burst) * fps));
}
