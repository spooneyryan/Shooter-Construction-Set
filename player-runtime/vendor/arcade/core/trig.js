// Trigonometry that is the same on every machine.
//
// `Math.sin` and friends are the one part of JavaScript arithmetic the
// specification declines to pin down: ECMAScript says the result is
// "implementation-approximated", so V8, SpiderMonkey and JavaScriptCore are all
// free to return different last bits, and they do. That is harmless for a
// shadow or a screen shake and fatal for a lockstep simulation, where the two
// machines must agree bit for bit forever -- one differing ulp in an enemy's
// position compounds into two players watching different games.
//
// WHAT IS ACTUALLY GUARANTEED. `+ - * /` are IEEE-754 binary64 with
// round-to-nearest-even, exactly specified, and `Math.sqrt` is required to be
// correctly rounded. `Math.abs`, `Math.floor`, `Math.round`, `Math.min` and
// `Math.max` are pure comparisons and sign work. Everything here is built out
// of exactly that set and nothing else, so two engines cannot disagree about
// it -- not "should not", cannot.
//
// HOW. Each function reduces its argument into a small interval and evaluates a
// truncated Maclaurin series there. The series coefficients are written as
// `1 / <factorial>` with the factorial spelled out as an integer literal: every
// one of those integers is under 2^53 and therefore exact, so the division is
// correctly rounded and lands on the same double everywhere. That form was
// chosen over the tighter minimax coefficients you would find in fdlibm
// precisely because it can be audited by reading it -- a mistyped digit in a
// magic constant is still perfectly deterministic, just quietly wrong, which is
// the worst failure this repository knows.
//
// WHAT THIS IS NOT FOR. Presentation. A flame flicker, a screen shake, a
// parallax drift and a rotation passed to `ctx.rotate` may all use `Math.sin`
// and should -- they are allowed to differ between the two players, and the
// native version is faster. The rule is the same one that decides everything
// else in a co-op game: does it affect what HAPPENS, or only what it looks
// like? Only the first belongs in here.
//
// Accuracy against the platform `Math` is measured in tests/trig.test.mjs and
// asserted there rather than promised here: within 2e-15 absolute for sin, cos
// and tan -- holding out to 1e8 radians, which is what the reduction below buys
// -- and within 1e-14 for the inverse functions. `hypot` agrees exactly. All of
// which is far below anything a game can see, and accuracy was never the point
// anyway: agreement was.

/** Half a turn. The double nearest pi, and identical on every engine. */
export const PI = Math.PI;
/** A whole turn. Exact: multiplying by two only moves the exponent. */
export const TAU = Math.PI * 2;
/** A quarter turn. Exact for the same reason. */
export const HALF_PI = Math.PI / 2;

// -- range reduction ---------------------------------------------------------

// Reducing `x` to a small interval means computing x - k*(pi/2), and doing that
// naively throws away precision: k*(pi/2) rounds, and the error it introduces
// is relative to k*(pi/2) rather than to the small remainder we actually want.
// By the time an angle is in the thousands the answer is visibly wrong.
//
// The fix is Cody-Waite: split pi/2 into pieces and subtract them one at a
// time, so each product is exact and the error never gets a chance to
// accumulate. HI holds the top 27 bits, which makes k*HI exact as long as k
// fits in the remaining 26 -- comfortably true for any angle a game produces.
//
// The split itself is Veltkamp's, done here in arithmetic rather than by
// masking the mantissa through a Uint32Array. Bit-twiddling a double would
// depend on the platform's endianness, and a determinism module that assumes
// little-endian is a joke with a long fuse.
const SPLITTER = 134217729; // 2^27 + 1
const HALF_PI_HI = (() => {
  const scaled = SPLITTER * HALF_PI;
  return scaled - (scaled - HALF_PI);
})();
/** The rest of the double. Exact: HALF_PI and HALF_PI_HI share an exponent. */
const HALF_PI_MID = HALF_PI - HALF_PI_HI;
/**
 * And the part of the true pi/2 that the double never had.
 *
 * `Math.PI` is the nearest double to pi, not pi, and it sits low by about
 * 1.2246467991473532e-16 -- which is exactly why `Math.sin(Math.PI)` returns
 * that number instead of zero. Half of it is the correction below. Without this
 * term the reduction is only ever as good as the constant it started from.
 */
const HALF_PI_LO = 6.123233995736766e-17;

/**
 * Fold `x` onto [-pi/4, pi/4] and report which quadrant it came from.
 *
 * Returns the remainder; the quadrant is left in `quadrant` rather than
 * returned in an object, because this runs inside the simulation step of a game
 * that may call it thousands of times a tick, and an allocation per call is a
 * collection pause per second.
 */
let quadrant = 0;
function reduce(x) {
  const k = Math.round(x / HALF_PI);
  // `k % 4` rather than `k & 3`: the bitwise form coerces to int32 and would
  // wrap silently once an angle passed a couple of billion radians. Nobody
  // should be there, but "wrong" and "wrong without saying so" are different.
  quadrant = ((k % 4) + 4) % 4;
  return ((x - k * HALF_PI_HI) - k * HALF_PI_MID) - k * HALF_PI_LO;
}

// -- kernels -----------------------------------------------------------------

// Maclaurin coefficients. On |x| <= pi/4 the first omitted term of each series
// is below 1e-19, so truncation costs less than the rounding already in the
// arithmetic.
const S3 = -1 / 6;
const S5 = 1 / 120;
const S7 = -1 / 5040;
const S9 = 1 / 362880;
const S11 = -1 / 39916800;
const S13 = 1 / 6227020800;
const S15 = -1 / 1307674368000;

const C2 = -1 / 2;
const C4 = 1 / 24;
const C6 = -1 / 720;
const C8 = 1 / 40320;
const C10 = -1 / 3628800;
const C12 = 1 / 479001600;
const C14 = -1 / 87178291200;

/**
 * sin on [-pi/4, pi/4].
 * @param {number} x
 * @returns {number}
 */
function sinKernel(x) {
  const z = x * x;
  return x + x * z * (S3 + z * (S5 + z * (S7 + z * (S9 + z * (S11 + z * (S13 + z * S15))))));
}

/**
 * cos on [-pi/4, pi/4].
 * @param {number} x
 * @returns {number}
 */
function cosKernel(x) {
  const z = x * x;
  return 1 + z * (C2 + z * (C4 + z * (C6 + z * (C8 + z * (C10 + z * (C12 + z * C14))))));
}

// -- the forward functions ---------------------------------------------------

/**
 * Sine, identical on every engine.
 * @param {number} x Angle in radians.
 * @returns {number} NaN for a non-finite argument, as `Math.sin` does.
 */
export function sin(x) {
  if (!Number.isFinite(x)) return NaN;
  const r = reduce(x);
  switch (quadrant) {
    case 0: return sinKernel(r);
    case 1: return cosKernel(r);
    case 2: return -sinKernel(r);
    default: return -cosKernel(r);
  }
}

/**
 * Cosine, identical on every engine.
 * @param {number} x Angle in radians.
 * @returns {number}
 */
export function cos(x) {
  if (!Number.isFinite(x)) return NaN;
  const r = reduce(x);
  switch (quadrant) {
    case 0: return cosKernel(r);
    case 1: return -sinKernel(r);
    case 2: return -cosKernel(r);
    default: return sinKernel(r);
  }
}

/**
 * Tangent, identical on every engine.
 *
 * Computed as sin/cos, so it blows up near the poles exactly as `Math.tan`
 * does. That is a property of tangent rather than of this implementation.
 * @param {number} x Angle in radians.
 * @returns {number}
 */
export function tan(x) {
  if (!Number.isFinite(x)) return NaN;
  const r = reduce(x);
  const s = sinKernel(r);
  const c = cosKernel(r);
  return quadrant === 0 || quadrant === 2 ? s / c : -c / s;
}

// -- the inverse functions ---------------------------------------------------

// atan's series converges slowly as its argument approaches 1, so the argument
// is folded into [-(sqrt2 - 1), sqrt2 - 1] first, where it converges quickly
// enough that a truncated series is cheaper than being clever. Both bounds come
// out of `Math.sqrt`, which is correctly rounded, so they are the same number
// everywhere and there is no constant to mistype.
const TAN_PI_8 = Math.sqrt(2) - 1;
const TAN_3PI_8 = Math.sqrt(2) + 1;
const QUARTER_PI = Math.PI / 4;

// atan's series needs many more terms than sine's, so the coefficients live in
// an array evaluated by an explicit Horner loop rather than as a fifteen-deep
// nest of parentheses. The loop runs highest power first, in a fixed order, so
// the sequence of floating-point operations is as fixed as writing it out --
// and unlike the written-out form, it cannot be silently mis-nested.
const ATAN_COEFFICIENTS = [
  -1 / 31, 1 / 29, -1 / 27, 1 / 25, -1 / 23,
  1 / 21, -1 / 19, 1 / 17, -1 / 15, 1 / 13,
  -1 / 11, 1 / 9, -1 / 7, 1 / 5, -1 / 3,
];

/**
 * atan on |x| <= sqrt(2) - 1.
 * @param {number} x
 * @returns {number}
 */
function atanKernel(x) {
  const z = x * x;
  let acc = 0;
  for (let i = 0; i < ATAN_COEFFICIENTS.length; i++) {
    acc = ATAN_COEFFICIENTS[i] + z * acc;
  }
  return x + x * z * acc;
}

/**
 * Arctangent, identical on every engine.
 * @param {number} x
 * @returns {number} An angle in [-pi/2, pi/2].
 */
export function atan(x) {
  if (Number.isNaN(x)) return NaN;
  if (x === Infinity) return HALF_PI;
  if (x === -Infinity) return -HALF_PI;
  const negative = x < 0;
  const a = negative ? -x : x;
  let result;
  if (a > TAN_3PI_8) {
    result = HALF_PI - atanKernel(1 / a);
  } else if (a > TAN_PI_8) {
    result = QUARTER_PI + atanKernel((a - 1) / (a + 1));
  } else {
    result = atanKernel(a);
  }
  return negative ? -result : result;
}

/**
 * Two-argument arctangent, identical on every engine.
 *
 * The signed-zero corners of `Math.atan2` are simplified: this treats a zero
 * `y` as unsigned, so `atan2(-0, -1)` gives pi where the platform gives -pi. A
 * simulation that can tell those apart has a bigger problem than trigonometry,
 * and the simplification is at least the same on both machines.
 *
 * @param {number} y
 * @param {number} x
 * @returns {number} An angle in [-pi, pi].
 */
export function atan2(y, x) {
  if (Number.isNaN(y) || Number.isNaN(x)) return NaN;
  if (y === 0) return x < 0 ? PI : 0;
  if (x === 0) return y > 0 ? HALF_PI : -HALF_PI;
  if (!Number.isFinite(y) || !Number.isFinite(x)) {
    // Both infinite lands on a diagonal; one infinite pins the axis.
    if (!Number.isFinite(y) && !Number.isFinite(x)) {
      const d = QUARTER_PI + (x > 0 ? 0 : QUARTER_PI);
      return y > 0 ? d : -d;
    }
    if (!Number.isFinite(y)) return y > 0 ? HALF_PI : -HALF_PI;
    return x > 0 ? 0 : (y > 0 ? PI : -PI);
  }
  const base = atan(y / x);
  if (x > 0) return base;
  return y > 0 ? base + PI : base - PI;
}

/**
 * Arcsine, identical on every engine.
 * @param {number} x
 * @returns {number} An angle in [-pi/2, pi/2], or NaN outside [-1, 1].
 */
export function asin(x) {
  if (!(x >= -1 && x <= 1)) return NaN;
  return atan2(x, Math.sqrt(1 - x * x));
}

/**
 * Arccosine, identical on every engine.
 * @param {number} x
 * @returns {number} An angle in [0, pi], or NaN outside [-1, 1].
 */
export function acos(x) {
  if (!(x >= -1 && x <= 1)) return NaN;
  return atan2(Math.sqrt(1 - x * x), x);
}

// -- the rest ----------------------------------------------------------------

/**
 * Length of the vector (x, y), identical on every engine.
 *
 * `Math.hypot` is implementation-approximated like the trigonometric functions,
 * and is also the one most likely to be reached for by accident, since it looks
 * like plain arithmetic. Two arguments only: the variadic form would have to
 * fix a summation order to stay reproducible, and a game asking for the length
 * of a 2D vector should not pay for that.
 *
 * Scaled by the larger component before squaring, so a long vector cannot
 * overflow on its way to a representable answer.
 *
 * @param {number} x
 * @param {number} y
 * @returns {number}
 */
export function hypot(x, y) {
  const a = Math.abs(x);
  const b = Math.abs(y);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return a === Infinity || b === Infinity ? Infinity : NaN;
  }
  if (a === 0) return b;
  if (b === 0) return a;
  const hi = a > b ? a : b;
  const lo = a > b ? b : a;
  const ratio = lo / hi;
  return hi * Math.sqrt(1 + ratio * ratio);
}

/**
 * Fold an angle onto [-pi, pi], identical on every engine.
 *
 * The reason to have this rather than `x % TAU` is that the difference between
 * two angles is meaningless until it is wrapped -- a turret at 0.1 radians and
 * a target at 6.2 are a tenth of a turn apart, not most of one -- and doing it
 * with `%` reintroduces the precision loss the reduction above exists to avoid.
 *
 * @param {number} x Angle in radians.
 * @returns {number}
 */
export function normalizeAngle(x) {
  if (!Number.isFinite(x)) return NaN;
  const turns = Math.round(x / TAU);
  // Four quarter-turns, and multiplying by four is exact: it only moves the
  // exponent, so the Cody-Waite pieces stay as accurate as they are above.
  const k = turns * 4;
  return ((x - k * HALF_PI_HI) - k * HALF_PI_MID) - k * HALF_PI_LO;
}
