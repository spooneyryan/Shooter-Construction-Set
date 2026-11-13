// Two vectors, and every control scheme in this repository is two of them.
//
// A game's input is a **move** vector and an **aim** vector. Geometry Wars
// gives each one its own analogue stick; Contra derives aim from move, so the
// gun points wherever the d-pad does; Abuse takes move from the keyboard and
// aim from the mouse; Forgotten Worlds drives move with the pad and aim with a
// satellite that orbits independently. None of those is a mode. Each one is a
// choice of **source** for each vector, crossed with a choice of
// **resolution** -- any angle, eight ways, or four -- and that is the whole
// vocabulary.
//
// WHY THIS IS IN core/ AND NOT platform/. Reading a gamepad is a browser job
// and lives in `platform/input.js`. Deciding that a stick at 12 degrees counts
// as "right" is a *game rule*: it is data, it belongs in a recording, and both
// machines in a co-op session must decide it identically. So the resolution
// and the arithmetic are here, built out of `core/trig`, and the hardware
// stays over there.
//
// THE COORDINATE CONVENTION, stated once: **+x is right and +y is DOWN**,
// which is screen space and is what every other module here already uses --
// gravity is positive, a tile's surface height grows downward. An angle from
// `stickAngle` is therefore measured clockwise from east, which is the
// direction a sprite drawn at that angle will actually face.
//
// QUANTIZATION IS NOT OPTIONAL, and it is not a size optimisation. An
// analogue axis is a float off the hardware, and INTEGRATION.md gives the rule
// this module exists to enforce: quantize at the edge, before the value enters
// the simulation, never somewhere downstream. Two machines that each round a
// raw stick reading in their own physics code diverge over a number the
// players would call identical, and it only shows up once something rewinds.
//
// The quantization here is **signed and symmetric**, which is the one way it
// differs from `quantize` in `@ccllc/coop/determinism`. That one maps a range
// onto `0 .. 2^bits-1`, so for a range of [-1, 1] and an even bit count the
// centre falls between two codes and a resting stick cannot be exactly zero.
// A stick that cannot be exactly zero drifts, forever, in the direction of the
// nearer code. Here the codes run -2047 .. 2047 and zero is one of them.
//
// Every operation below is `+ - * /`, `Math.abs`, `Math.round`, `Math.min`,
// `Math.max` and `Math.sqrt`, or a call into `core/trig` -- the set ECMAScript
// actually pins down. Nothing here can differ between two engines.

import { atan2, cos, sin, hypot } from "./trig.js";

/** Bits per axis on the wire. 12 is finer than any real stick resolves. */
export const STICK_BITS = 12;

/** Codes run -STICK_STEPS .. STICK_STEPS, so zero is exactly representable. */
export const STICK_STEPS = (1 << (STICK_BITS - 1)) - 1;

/**
 * How finely a stick is allowed to point.
 *
 * `four` is not a rounding of `eight`: it has to resolve a diagonal to one
 * direction, and which one it picks is a feel decision. See `snapStick`.
 */
export const STICK_RESOLUTIONS = Object.freeze(["free", "eight", "four"]);

/**
 * tan(22.5 degrees), the half-angle of an eight-way sector, as `sqrt(2) - 1`.
 * `Math.sqrt` is required to be correctly rounded, so this is the same double
 * everywhere -- which a decimal literal copied out of a calculator would not
 * reliably be.
 */
const STICK_OCTANT = Math.sqrt(2) - 1;

/**
 * Half of a diagonal unit vector, as `sqrt(0.5)`. Two keys held together must
 * produce a vector of length one, or diagonal movement is 41% faster than
 * straight movement -- the oldest bug in the genre.
 */
const STICK_DIAGONAL = Math.sqrt(0.5);

/**
 * How much an axis must beat the one a four-way gate is already holding
 * before the gate lets go. Without it a stick resting near 45 degrees
 * alternates between the two on consecutive steps, which reads as the actor
 * shivering. A quarter is about 12 degrees of stickiness either side of the
 * diagonal: enough to hold a rolled stick steady, small enough that nobody
 * aiming at a direction fails to get it.
 */
const STICK_HYSTERESIS = 0.25;

/**
 * How far outside the unit disc a vector may sit before it is clamped.
 *
 * Not slop. Rounding each axis to its nearest code moves the magnitude by up
 * to `sqrt(2)/2` of a code, so a vector scaled to exactly 1 can quantize to
 * slightly *more* than 1. Clamp on `> 1` and that result gets scaled down
 * again on the next pass, and again, so `resolveStick` is not idempotent and a
 * value depends on how many times it has been through the normalizer. A
 * pipeline that quantizes at the edge and re-quantizes defensively at the
 * simulation boundary -- which is exactly what this repository tells people to
 * do -- would then disagree with itself. That is a desync. It was found in one
 * input in three thousand, by replaying a recorded run.
 *
 * Tolerating the rounding error in the TRIGGER rather than shrinking the
 * TARGET is what makes one pass a fixed point: anything at most this far out
 * is left alone, and anything clamped lands at most `sqrt(2)/2` of a code out,
 * which is inside the tolerance. `1.5` codes is comfortably above the
 * `0.707` needed and still under a thousandth of full deflection.
 */
const STICK_DISC_SLACK = 1.5 / STICK_STEPS;

/** A stick at rest. */
export function neutralStick() {
  return { x: 0, y: 0 };
}

/**
 * One axis, -1..1, to its integer wire code.
 *
 * The magnitude is rounded and the sign reapplied, rather than rounding the
 * signed value directly, because `Math.round` breaks ties toward +Infinity:
 * `Math.round(1023.5)` is 1024 and `Math.round(-1023.5)` is -1023, so a stick
 * pushed exactly half way left would read one code weaker than the same stick
 * pushed half way right. Deterministic either way -- the tie rule is
 * specified -- but a game whose left is quietly slower than its right is a
 * bug report nobody would ever guess the cause of.
 *
 * @param {number} value
 * @returns {number} -STICK_STEPS .. STICK_STEPS
 */
export function quantizeStickAxis(value) {
  const finite = Number.isFinite(value) ? value : 0;
  const clamped = Math.max(-1, Math.min(1, finite));
  const code = Math.round(Math.abs(clamped) * STICK_STEPS);
  return clamped < 0 ? -code : code;
}

/**
 * The inverse. Exact for anything `quantizeStickAxis` produced, which is what
 * lets `sameStick` compare with `===` and lets a recorder store one entry per
 * change rather than one per step.
 *
 * @param {number} code
 */
export function dequantizeStickAxis(code) {
  const finite = Number.isFinite(code) ? code : 0;
  const clamped = Math.max(-STICK_STEPS, Math.min(STICK_STEPS, Math.round(finite)));
  const value = clamped / STICK_STEPS;
  // Negative zero is a real value that compares equal to zero and serialises
  // as zero, so it would survive `===` and die in a deep comparison of two
  // snapshots. Collapse it here, once.
  return value === 0 ? 0 : value;
}

/** Both axes at once, for a caller packing a vector onto the wire. */
export function packStick(stick) {
  return [quantizeStickAxis(stick?.x ?? 0), quantizeStickAxis(stick?.y ?? 0)];
}

/** The inverse of `packStick`. */
export function unpackStick(packed) {
  return {
    x: dequantizeStickAxis(packed?.[0] ?? 0),
    y: dequantizeStickAxis(packed?.[1] ?? 0),
  };
}

/** Are two sticks the same reading? Quantized, so `===` is honest here. */
export function sameStick(a, b) {
  return (a?.x ?? 0) === (b?.x ?? 0) && (a?.y ?? 0) === (b?.y ?? 0);
}

/** Length, 0..1. */
export function stickMagnitude(stick) {
  return hypot(stick?.x ?? 0, stick?.y ?? 0);
}

/** True when nothing is being asked for. */
export function stickIsCentred(stick) {
  return (stick?.x ?? 0) === 0 && (stick?.y ?? 0) === 0;
}

/**
 * The direction, in radians, measured clockwise from east because +y is down.
 * A centred stick has no direction; this returns 0 rather than inventing one,
 * so a caller must check `stickIsCentred` before believing it.
 */
export function stickAngle(stick) {
  const x = stick?.x ?? 0;
  const y = stick?.y ?? 0;
  if (x === 0 && y === 0) return 0;
  return atan2(y, x);
}

/**
 * A stick pointing a given way -- the other direction, for a satellite whose
 * angle the simulation owns rather than the player.
 *
 * @param {number} angle Radians, clockwise from east.
 * @param {number} [magnitude] 0..1.
 */
export function stickFromAngle(angle, magnitude = 1) {
  const m = Math.max(0, Math.min(1, Number.isFinite(magnitude) ? magnitude : 0));
  if (m === 0) return neutralStick();
  return {
    x: dequantizeStickAxis(quantizeStickAxis(cos(angle) * m)),
    y: dequantizeStickAxis(quantizeStickAxis(sin(angle) * m)),
  };
}

/**
 * Snap a direction to a coarser gate, preserving its magnitude.
 *
 * `eight` splits the circle into 45-degree sectors by comparing the two axes
 * against `tan(22.5)` -- no trigonometry, no rounding of an angle, just two
 * multiplications, which is both faster and more obviously identical across
 * engines than going via `atan2` and back.
 *
 * `four` has to throw one axis away, and there is no single right rule for
 * doing it, because the two devices that need it disagree:
 *
 * - **A stick rolled around the gate** must keep the direction it is holding
 *   until the other axis clearly wins, or it shivers between two directions at
 *   45 degrees. That is `tiebreak: "dominant"`, the default, and the
 *   stickiness is `STICK_HYSTERESIS`.
 * - **A key pressed while another is held** must turn *immediately*: holding
 *   right and pressing down means down, in every maze game ever made. That is
 *   `tiebreak: "recent"`, which `stickFromKeys` selects, and it is not a
 *   refinement of the first rule but its opposite -- dominance would keep the
 *   player going right.
 *
 * The two need different history, and each asks only for the history it
 * needs. `previous` is what this function last **returned**: which way the
 * gate is currently held, which is what hysteresis is measured against.
 * `previousRaw` is what was last **passed in**: which axes were already
 * engaged, which is how a newly-engaged one is recognised. Both are plain
 * data and both survive a snapshot; a caller using only one tiebreak need
 * only keep the one field it reads.
 *
 * @param {{x: number, y: number}} stick
 * @param {"free"|"eight"|"four"} resolution
 * @param {object} [options]
 * @param {{x: number, y: number}} [options.previous] Last result, for `four`.
 * @param {{x: number, y: number}} [options.previousRaw] Last reading.
 * @param {"dominant"|"recent"} [options.tiebreak]
 */
export function snapStick(stick, resolution, options = {}) {
  const x = stick?.x ?? 0;
  const y = stick?.y ?? 0;
  if (resolution === "free" || (x === 0 && y === 0)) return { x, y };

  const magnitude = hypot(x, y);
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const sx = x < 0 ? -1 : 1;
  const sy = y < 0 ? -1 : 1;

  if (resolution === "eight") {
    if (ay <= ax * STICK_OCTANT) return { x: sx * magnitude, y: 0 };
    if (ax <= ay * STICK_OCTANT) return { x: 0, y: sy * magnitude };
    return { x: sx * magnitude * STICK_DIAGONAL, y: sy * magnitude * STICK_DIAGONAL };
  }

  // four
  const heldX = (options.previous?.x ?? 0) !== 0;
  const heldY = (options.previous?.y ?? 0) !== 0;
  let horizontal;
  if (options.tiebreak === "recent") {
    const newX = ax !== 0 && (options.previousRaw?.x ?? 0) === 0;
    const newY = ay !== 0 && (options.previousRaw?.y ?? 0) === 0;
    if (newX !== newY) horizontal = newX;
    else if (ax !== ay) horizontal = ax > ay;
    else horizontal = heldX || !heldY;
  } else if (heldX && !heldY) {
    horizontal = !(ay > ax * (1 + STICK_HYSTERESIS));
  } else if (heldY && !heldX) {
    horizontal = ax > ay * (1 + STICK_HYSTERESIS);
  } else {
    horizontal = ax >= ay;
  }
  return horizontal ? { x: sx * magnitude, y: 0 } : { x: 0, y: sy * magnitude };
}

/**
 * A raw reading -- a gamepad's two axes, a virtual stick, a touch drag --
 * turned into the vector a simulation may hold.
 *
 * Four things happen, in this order, and the order is the design:
 *
 * 1. **A radial deadzone**, not a per-axis one. Deadzoning each axis
 *    separately carves a dead *cross* out of the circle, so a stick pushed
 *    gently up-right loses its horizontal component entirely and the shallow
 *    angles -- the ones a twin-stick game is played in -- cannot be reached at
 *    all. Beyond the deadzone the magnitude is rescaled so full deflection is
 *    still 1 rather than jumping from 0 to `deadzone` the moment it engages.
 * 2. **Clamped to the unit disc**, because a square-gated stick reads about
 *    1.41 on the diagonal and would otherwise aim faster than it walks.
 * 3. **Snapped** to the resolution, if it is not `free`.
 * 4. **Quantized**, last, so the value that reaches the simulation is exactly
 *    the value that would reach it from the wire.
 *
 * @param {number} x
 * @param {number} y
 * @param {object} [options]
 * @param {number} [options.deadzone] 0..1, radial.
 * @param {"free"|"eight"|"four"} [options.resolution]
 * @param {{x: number, y: number}} [options.previous] For `four`; see `snapStick`.
 * @param {{x: number, y: number}} [options.previousRaw] For `four`.
 * @param {"dominant"|"recent"} [options.tiebreak] For `four`.
 */
export function resolveStick(x, y, options = {}) {
  const rawX = Number.isFinite(x) ? x : 0;
  const rawY = Number.isFinite(y) ? y : 0;
  const deadzone = Math.max(0, Math.min(0.95, options.deadzone ?? 0));
  const resolution = STICK_RESOLUTIONS.includes(options.resolution) ? options.resolution : "free";

  const raw = hypot(rawX, rawY);
  if (raw === 0 || raw <= deadzone) return neutralStick();

  const expanded = (raw - deadzone) / (1 - deadzone);
  const scaled = expanded > 1 + STICK_DISC_SLACK ? 1 : expanded;
  const unit = scaled / raw;
  const snapped = snapStick({ x: rawX * unit, y: rawY * unit }, resolution, options);
  return {
    x: dequantizeStickAxis(quantizeStickAxis(snapped.x)),
    y: dequantizeStickAxis(quantizeStickAxis(snapped.y)),
  };
}

/**
 * Four booleans as a vector -- the keyboard, the d-pad, and the on-screen
 * controls, all of which produce holds rather than deflections.
 *
 * A diagonal comes out at length one, not 1.41. Note that keys can only ever
 * express eight directions, so `resolution: "free"` and `"eight"` are the same
 * thing here; `"four"` is the one that changes anything, and it defaults to
 * the `recent` tiebreak because that is what a key press means.
 *
 * That tiebreak reads only the *zero-ness* of each axis of `previousRaw`, so
 * a caller with last step's four booleans can build it directly --
 * `{x: (wasRight ? 1 : 0) - (wasLeft ? 1 : 0), y: ...}` -- without keeping a
 * second vector around.
 *
 * @param {boolean} left
 * @param {boolean} right
 * @param {boolean} up
 * @param {boolean} down
 * @param {object} [options] As `resolveStick`, minus the deadzone.
 */
export function stickFromKeys(left, right, up, down, options = {}) {
  const x = (right ? 1 : 0) - (left ? 1 : 0);
  const y = (down ? 1 : 0) - (up ? 1 : 0);
  if (x === 0 && y === 0) return neutralStick();
  const scale = x !== 0 && y !== 0 ? STICK_DIAGONAL : 1;
  return resolveStick(x * scale, y * scale, {
    tiebreak: "recent",
    ...options,
    deadzone: 0,
  });
}

/**
 * A pointer position as an aim vector -- the Abuse row of the table, where the
 * mouse says where the crosshair *is* and the actor has to work out which way
 * that is from here.
 *
 * The magnitude is the distance scaled by `range` and clamped to 1, so a
 * caller that only wants the direction reads the angle and a caller that wants
 * "how far is it reaching" gets that for free. Both points must be in the same
 * space -- both world pixels or both view pixels, never one of each.
 *
 * @param {number} fromX
 * @param {number} fromY
 * @param {number} toX
 * @param {number} toY
 * @param {object} [options]
 * @param {number} [options.range] Distance that reads as full deflection.
 * @param {"free"|"eight"|"four"} [options.resolution]
 * @param {{x: number, y: number}} [options.previous]
 */
export function stickFromPointer(fromX, fromY, toX, toY, options = {}) {
  const dx = (Number.isFinite(toX) ? toX : 0) - (Number.isFinite(fromX) ? fromX : 0);
  const dy = (Number.isFinite(toY) ? toY : 0) - (Number.isFinite(fromY) ? fromY : 0);
  const distance = hypot(dx, dy);
  if (distance === 0) return neutralStick();
  const range = Math.max(1, Number.isFinite(options.range) ? options.range : 64);
  const magnitude = Math.min(1, distance / range);
  const unit = magnitude / distance;
  return resolveStick(dx * unit, dy * unit, { ...options, deadzone: 0 });
}
