// Where a scroll-mode entity is after `age` seconds, from its origin.
//
// One function, used by the world to place enemies and by an editor to draw
// the path they will take -- so the two cannot disagree. Everything here is a
// closed form in `age`: a rewind is a subtraction, not a replay, which is the
// property the scroll modes have always kept and the arena never had.
//
// The frame is the path's own: `d` is distance flown along it, `w` the wobble
// across it. `angle` turns that frame -- 0 is the leftward flight every level
// before it had, positive is toward the top of the screen -- and the arc turns
// the heading itself as it flies. Angle zero takes an arithmetic-only branch so
// a level that never set it is placed bit for bit as before.
//
// Trig is the deterministic set from core, never Math: this runs inside the
// simulation, and a replay has to land on the same numbers everywhere.

import { asin, cos, hypot, sin } from "./trig.js";

const RAD = Math.PI / 180;

/**
 * How sharply a lane-hold squares off its triangle. 1 IS the zigzag; the flats
 * take up 1 - 1/k of each cycle, so 3 holds a lane for two thirds of it.
 * Fixed rather than authored: exposing it would make triangle-to-square a
 * slider, and nothing else here needs a second shape knob.
 */
const LANE_SQUARE = 3;

/**
 * The wobble across the path, for the patterns whose shape is a wobble.
 *
 * Exported because the arena is a second, integrating code path that has to
 * agree with this one about what a sine looks like. It used to name "sine" and
 * "zigzag" in its own copy of these two lines, which meant every pattern added
 * here was silently flat over there; now both ask the same function.
 *
 * @param {string} pattern
 * @param {number} cycle Radians: age x frequency x 2pi, plus the phase.
 * @param {number} amplitude
 */
export function crossWobble(pattern, cycle, amplitude) {
  if (pattern === "sine" || pattern === "surge" || pattern === "arcWeave" || pattern === "figureEight") return sin(cycle) * amplitude;
  if (pattern === "zigzag") return asin(sin(cycle)) * 2 / Math.PI * amplitude;
  if (pattern === "lane") {
    // The zigzag triangle steepened and clipped to the lane edges, so the
    // thing dwells at the extremes and snaps between them rather than sweeping.
    const triangle = asin(sin(cycle)) * 2 / Math.PI * LANE_SQUARE;
    return Math.max(-1, Math.min(1, triangle)) * amplitude;
  }
  return 0;
}

/**
 * The age a surge has effectively flown by `age`: its speed pulses as
 * `speed x (1 - cos cycle)`, and this is that pulse's integral written out
 * rather than accumulated, so the path stays a closed form and a rewind stays
 * a subtraction. Never negative, so it never retrogrades; zero once a cycle,
 * twice speed at the crest, and mean exactly speed -- a path swapped over from
 * straight still covers the same ground per whole cycle.
 *
 * The `sin(phase)` term holds it at its origin at age 0 whatever the phase.
 * A frequency of zero has no pulse to integrate and the quotient would be
 * NaN -- an enemy drawn nowhere, which nothing could hit -- so it flies
 * straight instead. `normalizeMovement` does not clamp frequency, so a
 * hand-edited level can carry a zero and the guard has to be here.
 */
function surgeAge(age, cycle, phase, frequency) {
  const omega = frequency * Math.PI * 2;
  if (!Number.isFinite(omega) || omega === 0) return age;
  return age - (sin(cycle) - sin(phase)) / omega;
}

/**
 * How far a charge has flown: it enters at `speed` and gains a constant
 * `2 x speed x frequency` units per second per second.
 *
 * Age is taken apart rather than squared whole, because an editor samples
 * backward to draw where a thing came from and an unclamped square would turn
 * that tail into a U-turn the enemy never flew. Behind its spawn a charge flew
 * the straight entry it arrives on, which is also what keeps its speed
 * continuous through age 0.
 */
function chargeDistance(speed, frequency, age) {
  const gain = Math.max(0, Number(frequency) || 0);
  const ahead = Math.max(age, 0);
  const behind = Math.min(age, 0);
  return speed * ahead * (1 + gain * ahead) + speed * behind;
}

/**
 * How far a dart has flown: it covers `speed / frequency` every cycle, all of
 * it in the first half and held through the second, so the average over whole
 * cycles is exactly `speed` and the peak is three times it. A smoothstep
 * rather than a bare ramp, so it is at rest at both ends of the dash instead
 * of snapping there.
 *
 * Frequency zero has no cycles to dart in and would divide by it, so it flies
 * straight -- the same answer the arc gives when its turn is zero.
 */
function dartDistance(speed, frequency, age, phase) {
  if (!frequency) return speed * age;
  const turns = frequency * age + phase / (Math.PI * 2);
  const whole = Math.floor(turns);
  const t = Math.min(1, 2 * (turns - whole));
  return (speed / frequency) * (whole + t * t * (3 - 2 * t));
}

// -- the bezier -------------------------------------------------------------
//
// A cubic from the origin through two control points to an end point, flown
// by DISTANCE rather than by its parameter: a bezier's t is not arc length,
// and flying it by t would speed up and slow down along the way. The table
// below turns distance into t, measured once per movement object -- which is
// stable for the life of a runtime enemy and replaced on every edit in an
// editor, so the WeakMap is a cache that can never go stale. Past either end
// the flight continues straight along the tangent, which is what a rocket
// would do and keeps the whole thing a closed form in age.

/** How many straight pieces a curve is measured in. */
const BEZIER_SEGMENTS = 64;
const bezierTables = new WeakMap();

/** The cubic at parameter `t`, with P0 at the origin. */
function cubic(points, t) {
  const [p1, p2, p3] = points;
  const mt = 1 - t;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return { x: b * p1.x + c * p2.x + d * p3.x, y: b * p1.y + c * p2.y + d * p3.y };
}

function bezierTable(movement) {
  let table = bezierTables.get(movement);
  if (table) return table;
  const lengths = [0];
  let prev = { x: 0, y: 0 };
  for (let i = 1; i <= BEZIER_SEGMENTS; i += 1) {
    const next = cubic(movement.points, i / BEZIER_SEGMENTS);
    lengths.push(lengths[i - 1] + hypot(next.x - prev.x, next.y - prev.y));
    prev = next;
  }
  table = { lengths, total: lengths[BEZIER_SEGMENTS] };
  bezierTables.set(movement, table);
  return table;
}

/** A unit vector along the curve at its start or its end, for flying on past it. */
function tangent(points, atEnd) {
  const [p1, p2, p3] = points;
  let dx = atEnd ? p3.x - p2.x : p1.x;
  let dy = atEnd ? p3.y - p2.y : p1.y;
  // A handle sitting on its neighbour gives no direction; take it from the
  // next point along instead of dividing by zero.
  if (dx === 0 && dy === 0) { dx = atEnd ? p3.x - p1.x : p2.x; dy = atEnd ? p3.y - p1.y : p2.y; }
  const length = hypot(dx, dy) || 1;
  return { x: dx / length, y: dy / length };
}

/** Where along the curve a thing is after flying `distance`, in the angle-0 frame. */
function bezierAt(movement, distance) {
  const { lengths, total } = bezierTable(movement);
  const points = movement.points;
  if (distance <= 0) { const t = tangent(points, false); return { x: t.x * distance, y: t.y * distance }; }
  if (distance >= total) { const t = tangent(points, true); return { x: points[2].x + t.x * (distance - total), y: points[2].y + t.y * (distance - total) }; }
  let lo = 0;
  let hi = BEZIER_SEGMENTS;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (lengths[mid] <= distance) lo = mid; else hi = mid; }
  const span = lengths[hi] - lengths[lo] || 1;
  return cubic(points, (lo + (distance - lengths[lo]) / span) / BEZIER_SEGMENTS);
}

/**
 * How far a path runs before it is a straight line: a bezier's measured
 * length, and infinite for everything else. An editor uses it to draw the
 * whole curve rather than a fixed stretch of it.
 */
export function movementPathLength(movement) {
  return movement.pattern === "bezier" && movement.points ? bezierTable(movement).total : Infinity;
}

/**
 * @param {import("../shmup/index.js").Movement} movement
 * @param {number} originX
 * @param {number} originY
 * @param {number} age Seconds since spawn. Negative extrapolates backward, which an editor uses to draw where a thing came from.
 * @param {{holds?: boolean, phase?: number, pinAlong?: boolean}} [options] `holds` keeps the entity at its origin along the path and only wobbles -- terrain, as it always has. `pinAlong` is the stricter pin below.
 */
export function movementPosition(movement, originX, originY, age, options = {}) {
  const spot = placeAlongPath(movement, originX, originY, age, options);
  // `holds` pins the TRAVEL and keeps the wobble, which is right for terrain --
  // a nebula bobs where it stands. It is not enough for a body the camera is
  // parked in front of: the figure eight's fore-and-aft term runs along the
  // axis at any angle, and a path `angle` or an arc's `curve` turns the cross
  // wobble into the along axis outright, up to the whole amplitude. A blocker's
  // along coordinate has to BE its origin, because that is the line the camera
  // stops at. A projection of a closed form is a closed form, and the flag is a
  // constant of the authored item, so a rewind is still a subtraction.
  return options.pinAlong ? { x: originX, y: spot.y } : spot;
}

/** The path itself, unprojected. */
function placeAlongPath(movement, originX, originY, age, options = {}) {
  const { holds = false, phase = 0 } = options;
  const { pattern, speed, amplitude, frequency } = movement;
  if (pattern === "stationary") return { x: originX, y: originY };
  const cycle = age * frequency * Math.PI * 2 + phase;
  const w = crossWobble(pattern, cycle, amplitude);
  // Distance along the path. Three patterns vary their speed along it and the
  // rest fly `speed * age`, in the arithmetic they always used.
  const travelled = pattern === "surge" ? speed * surgeAge(age, cycle, phase, frequency)
    : pattern === "charge" ? chargeDistance(speed, frequency, age)
    : pattern === "dart" ? dartDistance(speed, frequency, age, phase)
    : speed * age;
  // The figure eight is the one shape with a fore-and-aft term: the cross
  // wobble at the cycle and this at twice it and half the size, which is what
  // makes a lemniscate rather than a circle. `holds` pins the travel but not
  // the figure, so terrain given one traces its eight where it stands.
  const weave = pattern === "figureEight" ? sin(cycle * 2) * amplitude / 2 : 0;
  const d = (holds ? 0 : travelled) + weave;
  const angle = (movement.angle ?? 0) * RAD;
  if (pattern === "plunge") {
    // The one path that accelerates in WORLD down rather than along or across
    // its own frame: rocks, bombs, anything that falls. It is added after the
    // frame is turned, so a plunge at any path angle still falls downward.
    const fall = holds ? 0 : 0.5 * (movement.gravity ?? 240) * age * age;
    if (angle === 0) return { x: originX - d, y: originY + w + fall };
    return { x: originX - cos(angle) * d - sin(angle) * w, y: originY - sin(angle) * d + cos(angle) * w + fall };
  }
  if (pattern === "bezier" && movement.points) {
    // The curve's own offsets, turned by the path angle the same way a
    // straight path's forward vector is -- so a bezier and the arc agree
    // about which way "ahead" is. Angle zero stays arithmetic.
    const local = bezierAt(movement, d);
    if (angle === 0) return { x: originX + local.x, y: originY + local.y };
    return { x: originX + cos(angle) * local.x - sin(angle) * local.y, y: originY + sin(angle) * local.x + cos(angle) * local.y };
  }
  const turn = pattern === "arc" || pattern === "arcWeave" ? (movement.curve ?? 0) * RAD : 0;
  // The path every earlier level flew, in the arithmetic it always used.
  if (angle === 0 && turn === 0) return { x: originX - d, y: originY + w };
  let ax;
  let ay;
  let heading = angle;
  if (turn === 0) {
    ax = -cos(angle) * d;
    ay = -sin(angle) * d;
  } else {
    // Constant speed at a constant turn is a circle of radius speed / turn.
    // This is that circle from the origin, the heading having turned by
    // `turn x age` -- which is also the axis the wobble is measured across.
    heading = angle + turn * age;
    const radius = (holds ? 0 : speed) / turn;
    ax = -radius * (sin(heading) - sin(angle));
    ay = radius * (cos(heading) - cos(angle));
  }
  return { x: originX + ax - sin(heading) * w, y: originY + ay + cos(heading) * w };
}
