// The ground, as a line.
//
// A course's segment list is authoring; this is what the solver reads. One
// pass turns the segments into three parallel arrays — `xs`, `ys` and a
// surface code per span — and every query after that is a binary search
// and a lerp.
//
// Three properties are worth stating because everything downstream leans
// on them:
//
//   1. `xs` strictly increases. The ground is therefore a function of x,
//      a wheel can never be under two pieces of it, and the search cannot
//      fail to terminate.
//   2. Queries outside the course clamp to the end points rather than
//      returning nothing: the ground continues as a horizontal ray at each
//      end vertex's height. A rider who overshoots the finish is standing
//      on solid ground — which is a playable world, where a null is a
//      crash in the renderer. Both `terrainHeightAt` and `terrainContact`
//      honour it, and it is worth naming as one property because for a
//      while only the first of them did.
//   3. Nothing here allocates during a step, and nothing here is stateful.
//      Terrain is built once from the document and never appears in a
//      snapshot: it cannot change, so rollback has nothing to rewind.
//
// The cost of (1), said plainly: no overhangs, no loops. That is the
// decision recorded in docs/WHEELS.md, and it is what buys an exact
// contact test at any speed.

import { WHEELS_FATAL, WHEELS_SURFACES, WHEELS_TARMAC } from "./contract.js";

/**
 * The most points a course may be sampled into.
 *
 * A budget rather than a limit, because the alternative is worse. The
 * normalizer's own caps — 4,000 segments, 20,000 px each, a resolution
 * floor of one — allow a document to demand eighty million points across
 * three arrays, and that document is 168 KB of JSON: comfortably inside
 * the share-link cap in `document.js`, which is exactly the untrusted path
 * this format was built for. Opening such a link used to hang the tab
 * inside `createRide`, before any game code ran.
 *
 * So a course over budget is COARSENED, never truncated. Truncating loses
 * the far end of the level and a rider rides off into nothing; coarsening
 * keeps every segment and every surface and only spends fewer points
 * describing the curves. Real content is nowhere near this: Ridge Run is
 * 294 points, and a five-screen course sampled every two pixels is 25,000.
 */
const WHEELS_MAX_POINTS = 250000;

/** Smoothstep. Pure `+ - *`, so every engine agrees on the last bit. */
function wheelsSmooth(t) {
  return t * t * (3 - 2 * t);
}

/**
 * How many points a segment emits at `resolution` — the same arithmetic
 * the builder uses, kept here so the estimate cannot drift from the thing
 * it is estimating.
 */
function wheelsPointsFor(segment, resolution) {
  const kind = segment.kind;
  if (kind === "flat" || kind === "slope" || kind === "step") return 1;
  if (kind === "pit") return 3;
  const steps = Math.max(1, Math.ceil(segment.length / resolution));
  if (kind === "bumps") return Math.max(1, Math.ceil(steps / segment.count)) * segment.count;
  if (kind === "crater") return steps + 1;
  return steps;
}

/**
 * The resolution this course will actually be sampled at: the author's,
 * unless honouring it would blow the budget above.
 *
 * The loop is because `Math.ceil` means one scaling does not land exactly
 * on the target; it converges in two or three passes and is bounded at
 * eight so nothing pathological can spin here. A floor of `bumps` counts
 * cannot be coarsened away at all, which is fine — that floor is hundreds
 * of thousands of points rather than tens of millions.
 */
function wheelsResolution(ground) {
  let resolution = ground.resolution;
  for (let pass = 0; pass < 8; pass += 1) {
    let demand = 0;
    for (const segment of ground.segments) demand += wheelsPointsFor(segment, resolution);
    if (demand <= WHEELS_MAX_POINTS) return resolution;
    resolution = resolution * (demand / WHEELS_MAX_POINTS);
  }
  return resolution;
}

/** A single bump: up over the first half, down over the second. */
function wheelsBump(t) {
  return t < 0.5 ? wheelsSmooth(t * 2) : wheelsSmooth(2 - t * 2);
}

/**
 * Turn a normalized course's `ground` into the line the solver reads.
 *
 * @param {{x: number, y: number, resolution: number, segments: any[]}} ground
 * @returns {{xs: number[], ys: number[], surfaces: number[], minX: number, maxX: number, minY: number, maxY: number, length: number}}
 *          `surfaces[i]` is the span from point `i` to point `i + 1`, so it
 *          is one shorter than `xs`.
 */
export function buildWheelsTerrain(ground) {
  const xs = [ground.x];
  const ys = [ground.y];
  const surfaces = [];
  let x = ground.x;
  let y = ground.y;

  // Append a point and the surface of the span that reaches it. Points
  // that would not advance x are dropped rather than rejected: a zero
  // length segment is an authoring slip, and swallowing it keeps property
  // (1) true without losing the rest of the course.
  const put = (nextX, nextY, surface) => {
    if (!(nextX > xs[xs.length - 1])) return;
    xs.push(nextX);
    ys.push(nextY);
    surfaces.push(surface);
  };

  // Not `ground.resolution` directly: see wheelsResolution above.
  const resolution = wheelsResolution(ground);

  for (const segment of ground.segments) {
    const { kind, length, rise, surface } = segment;
    const steps = Math.max(1, Math.ceil(length / resolution));

    if (kind === "flat") {
      put(x + length, y, surface);
    } else if (kind === "slope" || kind === "step") {
      // A straight line needs exactly two points, and a step is a straight
      // line that happens to be nearly vertical.
      put(x + length, y + rise, surface);
    } else if (kind === "hill") {
      // Eased at both ends: the shape a road takes over a rise, and the
      // one that does not launch a rover that merely drove over it.
      for (let step = 1; step <= steps; step += 1) {
        const t = step / steps;
        put(x + length * t, y + rise * wheelsSmooth(t), surface);
      }
    } else if (kind === "ramp") {
      // Eased in and steepest at the lip, which is what makes it a
      // take-off rather than a hill. `t * t` is the whole trick.
      for (let step = 1; step <= steps; step += 1) {
        const t = step / steps;
        put(x + length * t, y + rise * t * t, surface);
      }
    } else if (kind === "bumps") {
      const perBump = Math.max(1, Math.ceil(steps / segment.count));
      const total = perBump * segment.count;
      for (let step = 1; step <= total; step += 1) {
        const t = step / total;
        const withinBump = ((step - 1) % perBump + 1) / perBump;
        put(x + length * t, y - rise * wheelsBump(withinBump), surface);
      }
    } else if (kind === "crater") {
      // A bowl. Down the near wall, along a floor that is usually fatal,
      // and back up — Moon Patrol's hole, and the reason its buggy jumps.
      const floor = segment.floor ?? WHEELS_FATAL;
      for (let step = 1; step <= steps; step += 1) {
        const t = step / steps;
        const depth = rise * wheelsBump(t);
        // The floor's surface owns the middle third; the walls keep the
        // segment's own, so a rider who clips the near lip is not killed
        // by a surface they never reached the bottom of.
        put(x + length * t, y + depth, t > 0.34 && t < 0.72 ? floor : surface);
      }
      // The bowl returns to the height it started at; say so exactly
      // rather than trusting the last sample's arithmetic.
      put(x + length, y, surface);
    } else if (kind === "pit") {
      // Square-edged: a trials gap, where the walls are walls and the only
      // way across is over. Two pixels of run gives the near wall a slope
      // the search can still resolve without a special case.
      //
      // Only the FLOOR is fatal, never the walls — the same rule the
      // crater states above, and here it is not a nicety. A contact test
      // sweeps the spans a wheel's diameter can reach, so a rider still on
      // the take-off ramp is within twelve pixels of the near wall well
      // before the lip. Marking that wall fatal killed every approach to
      // every gap, at the exact moment the player was doing it right.
      const floor = segment.floor ?? WHEELS_FATAL;
      const wall = Math.min(2, length / 4);
      put(x + wall, y + rise, surface);
      put(x + length - wall, y + rise, floor);
      put(x + length, y, surface);
    }

    x = xs[xs.length - 1];
    y = ys[ys.length - 1];
  }

  // A course of one point is not a course. Give it a metre of floor so
  // every query below has a span to land in.
  if (xs.length < 2) {
    xs.push(xs[0] + 100);
    ys.push(ys[0]);
    surfaces.push(WHEELS_TARMAC);
  }

  let minY = ys[0];
  let maxY = ys[0];
  for (const value of ys) {
    if (value < minY) minY = value;
    if (value > maxY) maxY = value;
  }

  return {
    xs,
    ys,
    surfaces,
    minX: xs[0],
    maxX: xs[xs.length - 1],
    minY,
    maxY,
    length: xs[xs.length - 1] - xs[0],
  };
}

/**
 * The index of the span containing `x`, clamped into range.
 *
 * A binary search rather than a cursor: a cursor is faster for one rider
 * walking forwards and wrong for four of them, for a rewind, and for a
 * renderer asking about the left edge of the screen.
 *
 * @param {ReturnType<typeof buildWheelsTerrain>} terrain
 * @param {number} x
 */
export function terrainSpanAt(terrain, x) {
  const { xs } = terrain;
  const last = xs.length - 2;
  if (x <= xs[0]) return 0;
  if (x >= xs[last + 1]) return last;
  let low = 0;
  let high = last;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (xs[mid] <= x) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** The ground height at `x`. Clamped at both ends, never null. */
export function terrainHeightAt(terrain, x) {
  const span = terrainSpanAt(terrain, x);
  const { xs, ys } = terrain;
  const run = xs[span + 1] - xs[span];
  let t = run > 0 ? (x - xs[span]) / run : 0;
  // `terrainSpanAt` clamps the SPAN, not the position, so a query past
  // either end arrives here with a `t` outside 0..1 and would extrapolate
  // the end segment forever — a rider who overshot the finish by 900px
  // would be standing 450px in the air. Clamping is what makes the
  // promise at the top of this file true.
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return ys[span] + (ys[span + 1] - ys[span]) * t;
}

/** The surface code under `x`. */
export function terrainSurfaceAt(terrain, x) {
  return terrain.surfaces[terrainSpanAt(terrain, x)] ?? WHEELS_TARMAC;
}

/** The surface's tyre numbers under `x`, never undefined. */
export function terrainGripAt(terrain, x) {
  return WHEELS_SURFACES[terrainSurfaceAt(terrain, x)] ?? WHEELS_SURFACES[WHEELS_TARMAC];
}

/**
 * The upward unit normal of the span under `x`.
 *
 * "Upward" is -y, so a flat span returns `{x: 0, y: -1}`. The sign is
 * chosen once here and every force in `vehicle.js` depends on it.
 */
export function terrainNormalAt(terrain, x) {
  const span = terrainSpanAt(terrain, x);
  const { xs, ys } = terrain;
  const dx = xs[span + 1] - xs[span];
  const dy = ys[span + 1] - ys[span];
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length === 0) return { x: 0, y: -1 };
  return { x: dy / length, y: -dx / length };
}

/**
 * The deepest contact between a circle and the ground, or null.
 *
 * Only the spans the circle's x-extent can reach are tested, which is what
 * makes this affordable per wheel per substep. Each span is treated as the
 * segment it is — closest point to the circle centre, clamped to the
 * segment's ends — so a wheel resting exactly on a vertex is one case, not
 * two competing ones.
 *
 * The returned `normal` points from the ground towards the circle centre,
 * except when the centre is *below* the line, where it keeps the span's
 * upward normal: a wheel that has been pushed through the floor must be
 * pushed back out of the top, not sucked further down.
 *
 * **The end aprons are part of the ground**, not an edge case. Property
 * (2) at the top of this file says a query outside the course clamps to
 * the end points, and `terrainHeightAt` honours that by clamping its
 * interpolation — so past either end there IS ground, at the end vertex's
 * height. This function used to disagree: it clamped the closest point to
 * the segment's ends, which turns the extension into a single vertex and
 * lets the distance grow without limit. The two queries then contradicted
 * each other, and the vehicle paid for it — reversing off the start of a
 * course dropped the overhanging wheel through ground that
 * `terrainHeightAt` still reported, and the crash-point test, which reads
 * heights, wrecked the rider for a body contact the wheels were never
 * given the chance to prevent.
 *
 * @param {ReturnType<typeof buildWheelsTerrain>} terrain
 * @param {number} cx
 * @param {number} cy
 * @param {number} radius
 * @returns {{x: number, y: number, nx: number, ny: number, depth: number, span: number} | null}
 */
export function terrainContact(terrain, cx, cy, radius) {
  const { xs, ys } = terrain;
  let best = null;

  // One segment against the circle. Shared by the spans and by the two
  // horizontal aprons, so the extension cannot pick up different contact
  // maths from the course it extends.
  const consider = (ax, ay, bx, by, span) => {
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    let t = lengthSquared > 0 ? ((cx - ax) * dx + (cy - ay) * dy) / lengthSquared : 0;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const px = ax + dx * t;
    const py = ay + dy * t;
    let nx = cx - px;
    let ny = cy - py;
    const distance = Math.sqrt(nx * nx + ny * ny);
    const depth = radius - distance;
    if (depth <= 0) return;

    if (distance > 1e-9) {
      nx /= distance;
      ny /= distance;
    } else {
      nx = 0;
      ny = -1;
    }
    // Below the line: the closest-point normal points down, which would
    // resolve the overlap by burying the wheel. Take the span's up normal
    // and the full diameter's worth of correction instead.
    //
    // The sign is the standard cross product of the span with the centre,
    // and +y being down is exactly what makes it worth spelling out: a
    // centre BELOW the ground has a positive cross here. Writing the two
    // terms the other way round is the same expression negated, which
    // reads identically and reports every resting wheel as buried — the
    // springs then fire at full travel and launch the vehicle off a flat
    // road, which is how this was found.
    const side = dx * (cy - ay) - dy * (cx - ax);
    let resolved = depth;
    if (side > 0) {
      const length = Math.sqrt(lengthSquared);
      if (length > 0) {
        nx = dy / length;
        ny = -dx / length;
      } else {
        nx = 0;
        ny = -1;
      }
      resolved = radius + distance;
    }
    if (best === null || resolved > best.depth) {
      best = { x: px, y: py, nx, ny, depth: resolved, span };
    }
  };

  const first = terrainSpanAt(terrain, cx - radius);
  const last = terrainSpanAt(terrain, cx + radius);
  for (let span = first; span <= last; span += 1) {
    consider(xs[span], ys[span], xs[span + 1], ys[span + 1], span);
  }

  // The aprons, only when the circle actually reaches past an end. Each is
  // a horizontal segment long enough to cover the circle's reach, at the
  // end vertex's height — which is precisely the ground `terrainHeightAt`
  // reports out there.
  const lastPoint = xs.length - 1;
  if (cx - radius < xs[0]) {
    consider(cx - radius - 1, ys[0], xs[0], ys[0], 0);
  }
  if (cx + radius > xs[lastPoint]) {
    consider(xs[lastPoint], ys[lastPoint], cx + radius + 1, ys[lastPoint], lastPoint - 1);
  }
  return best;
}

/**
 * Whether a point is below the ground. The cheap test, for chassis
 * corners and props — a box does not need a contact, only a verdict.
 */
export function terrainCovers(terrain, x, y) {
  return y > terrainHeightAt(terrain, x);
}
