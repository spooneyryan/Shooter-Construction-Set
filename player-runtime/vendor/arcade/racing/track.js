// The route, built: one pass from nodes to a sampled loop, then queries.
//
// A track's node list is authoring; this is what the solver reads. The pass
// draws the centripetal Catmull-Rom through the nodes finely, then resamples
// that curve at an even spacing, so sample `i` sits exactly `i * ds` along
// the lap. Everything a race asks the route afterwards is a lookup against
// those samples: how far round a car is, what it is standing on, and
// whether it is touching a wall.
//
// Four properties are worth stating because everything downstream leans on
// them:
//
//   1. **Distance is an index.** Samples are evenly spaced, so a car's
//      progress is `(segment + t) * ds`, the start line is sample 0, and a
//      speed profile along the lap is an array walked backwards.
//   2. **The nearest centreline point decides the ground.** Where two
//      stretches of road come close, whichever is nearer claims the point —
//      so a crossing is the union of two roads, and a barrier only exists
//      where no other road is nearer than it. That is what lets a figure of
//      eight cross itself without a special case.
//   3. **Walls are bands, not half-planes.** A wall is a strip `band` wide
//      beyond the verge, and a disc is pushed out of whichever face its
//      centre is nearer. A car can therefore never be yanked through a
//      barrier by a road on its far side, and nothing moves half a band in
//      one substep (see `feel.substeps`), so nothing tunnels.
//   4. **Nothing here is state.** The track is built once from the document
//      and never appears in a snapshot: it cannot change, so a rollback has
//      nothing to rewind. No query allocates on the solver's path.
//
// The cost, said plainly: the route is one level. Two stretches that cross
// meet at a junction; there are no bridges. docs/RACING.md records it.

import { PI, cos, sin } from "../core/trig.js";
import {
  RACING_BOOST,
  RACING_HOLE,
  RACING_OIL,
  RACING_RAMP,
  racingSurface,
} from "./contract.js";

/** Nothing past the verge: more offroad. */
export const RACING_EDGE_OPEN = 0;
/** A barrier band past the verge. */
export const RACING_EDGE_WALL = 1;
/** A drop band past the verge: a hole. */
export const RACING_EDGE_DROP = 2;

const RACING_EDGE_CODE = { open: RACING_EDGE_OPEN, wall: RACING_EDGE_WALL, drop: RACING_EDGE_DROP };

/**
 * The most samples a route may be built into.
 *
 * A budget rather than a limit, for the reason `wheels` gave first: the
 * normalizer's own caps allow a document to ask for millions of samples from
 * a few kilobytes of JSON, which is inside the share-link cap and therefore
 * on the untrusted path. A route over budget is COARSENED — every node is
 * still on it — never truncated. Real tracks are nowhere near: a two-minute
 * circuit is under a thousand.
 */
const RACING_MAX_SAMPLES = 40000;

/** The most cells the lookup grid may have, for the same reason. */
const RACING_MAX_CELLS = 1 << 20;

/** How far short of a ramp or a hole a car is never put back, px. */
const RACING_RUN_UP = 300;

/**
 * How far past the route's reach the lookup grid still finds a segment.
 *
 * A disc can touch a wall band's far face while its centre is outside the
 * band — beyond the reach — and a grid that only knew about points within
 * the reach would say there was no wall there. The first test of the far
 * face found exactly that. Anything that collides is smaller than this.
 */
const RACING_GRID_SLACK = 64;

/** Degrees to radians. `PI / 180` is one correctly rounded division. */
const RACING_DEGREES = PI / 180;

/** Smoothstep. Pure `+ - *`, so every engine agrees on the last bit. */
function racingEase(t) {
  return t * t * (3 - 2 * t);
}

/**
 * The centripetal knot spacing between two nodes: the square root of their
 * distance. `Math.sqrt` twice rather than `Math.pow(d2, 0.25)`, because the
 * specification pins down one and not the other.
 */
function racingKnot(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const spacing = Math.sqrt(Math.sqrt(dx * dx + dy * dy));
  return spacing > 1e-6 ? spacing : 1e-6;
}

/**
 * One point of a Catmull-Rom span, by the Barry-Goldman pyramid — three
 * lerps, two lerps, one lerp, and nothing but arithmetic. `t` runs from
 * `t1` (node `p1`) to `t2` (node `p2`).
 */
function racingSpline(p0, p1, p2, p3, t0, t1, t2, t3, t, out) {
  const a1x = ((t1 - t) * p0.x + (t - t0) * p1.x) / (t1 - t0);
  const a1y = ((t1 - t) * p0.y + (t - t0) * p1.y) / (t1 - t0);
  const a2x = ((t2 - t) * p1.x + (t - t1) * p2.x) / (t2 - t1);
  const a2y = ((t2 - t) * p1.y + (t - t1) * p2.y) / (t2 - t1);
  const a3x = ((t3 - t) * p2.x + (t - t2) * p3.x) / (t3 - t2);
  const a3y = ((t3 - t) * p2.y + (t - t2) * p3.y) / (t3 - t2);
  const b1x = ((t2 - t) * a1x + (t - t0) * a2x) / (t2 - t0);
  const b1y = ((t2 - t) * a1y + (t - t0) * a2y) / (t2 - t0);
  const b2x = ((t3 - t) * a2x + (t - t1) * a3x) / (t3 - t1);
  const b2y = ((t3 - t) * a2y + (t - t1) * a3y) / (t3 - t1);
  out.x = ((t2 - t) * b1x + (t - t1) * b2x) / (t2 - t1);
  out.y = ((t2 - t) * b1y + (t - t1) * b2y) / (t2 - t1);
}

/**
 * A lookup grid in compressed rows: `start[cell]..start[cell + 1]` indexes
 * `items`. Built in two passes — count, then fill — so it is two typed
 * arrays and no per-cell objects.
 */
function racingGrid(originX, originY, cell, cols, rows, count, boxOf) {
  const cells = cols * rows;
  const start = new Int32Array(cells + 1);
  const box = [0, 0, 0, 0];
  const range = (index) => {
    boxOf(index, box);
    const c0 = Math.max(0, Math.floor((box[0] - originX) / cell));
    const r0 = Math.max(0, Math.floor((box[1] - originY) / cell));
    const c1 = Math.min(cols - 1, Math.floor((box[2] - originX) / cell));
    const r1 = Math.min(rows - 1, Math.floor((box[3] - originY) / cell));
    return [c0, r0, c1, r1];
  };
  for (let index = 0; index < count; index += 1) {
    const [c0, r0, c1, r1] = range(index);
    for (let row = r0; row <= r1; row += 1) {
      for (let col = c0; col <= c1; col += 1) start[row * cols + col + 1] += 1;
    }
  }
  for (let at = 0; at < cells; at += 1) start[at + 1] += start[at];
  const items = new Int32Array(start[cells]);
  const fill = start.slice(0, cells);
  for (let index = 0; index < count; index += 1) {
    const [c0, r0, c1, r1] = range(index);
    for (let row = r0; row <= r1; row += 1) {
      for (let col = c0; col <= c1; col += 1) {
        const at = row * cols + col;
        items[fill[at]] = index;
        fill[at] += 1;
      }
    }
  }
  return { start, items };
}

/**
 * Turn a normalized track into the route the solver reads.
 *
 * @param {any} spec A normalized track (`normalizeRacingTrack`).
 */
export function buildRacingTrack(spec) {
  const route = spec.route;
  const nodes = route.nodes;
  const nodeCount = nodes.length;

  // -- the curve, finely ------------------------------------------------
  let chord = 0;
  for (let index = 0; index < nodeCount; index += 1) {
    const a = nodes[index];
    const b = nodes[(index + 1) % nodeCount];
    chord += Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y));
  }
  // Not `route.resolution` directly: the budget above.
  const resolution = chord / route.resolution > RACING_MAX_SAMPLES ? chord / RACING_MAX_SAMPLES : route.resolution;
  const fine = resolution / 3;
  const denseX = [];
  const denseY = [];
  const denseSpan = [];
  const denseU = [];
  const spanStart = new Int32Array(nodeCount);
  const point = { x: 0, y: 0 };
  for (let index = 0; index < nodeCount; index += 1) {
    spanStart[index] = denseX.length;
    const p0 = nodes[(index - 1 + nodeCount) % nodeCount];
    const p1 = nodes[index];
    const p2 = nodes[(index + 1) % nodeCount];
    const p3 = nodes[(index + 2) % nodeCount];
    const t0 = 0;
    const t1 = t0 + racingKnot(p0, p1);
    const t2 = t1 + racingKnot(p1, p2);
    const t3 = t2 + racingKnot(p2, p3);
    const span = Math.sqrt((p2.x - p1.x) * (p2.x - p1.x) + (p2.y - p1.y) * (p2.y - p1.y));
    const steps = Math.max(1, Math.ceil(span / fine));
    for (let step = 0; step < steps; step += 1) {
      const u = step / steps;
      racingSpline(p0, p1, p2, p3, t0, t1, t2, t3, t1 + (t2 - t1) * u, point);
      denseX.push(point.x);
      denseY.push(point.y);
      denseSpan.push(index);
      denseU.push(u);
    }
  }
  const denseCount = denseX.length;
  const denseAt = new Float64Array(denseCount + 1);
  for (let index = 0; index < denseCount; index += 1) {
    const next = (index + 1) % denseCount;
    const dx = denseX[next] - denseX[index];
    const dy = denseY[next] - denseY[index];
    denseAt[index + 1] = denseAt[index] + Math.sqrt(dx * dx + dy * dy);
  }
  const length = denseAt[denseCount];
  // Where every node sits round the lap, exactly: the arc length of the
  // dense curve at the first point of its span. Resampling puts sample `i`
  // at exactly `i * ds` along the same curve, so these distances and the
  // samples agree, and a thing anchored to a node is placed from here.
  const nodeS = new Float64Array(nodeCount);
  for (let index = 0; index < nodeCount; index += 1) nodeS[index] = denseAt[spanStart[index]];

  // -- resampled evenly: property (1) -----------------------------------
  const count = Math.max(8, Math.round(length / resolution));
  const ds = length / count;
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  const half = new Float64Array(count);
  const verge = new Float64Array(count);
  const edgeLeft = new Uint8Array(count);
  const edgeRight = new Uint8Array(count);
  const surface = new Uint8Array(count);
  const node = new Uint16Array(count);
  let cursor = 0;
  for (let index = 0; index < count; index += 1) {
    const target = index * ds;
    while (cursor < denseCount - 1 && denseAt[cursor + 1] <= target) cursor += 1;
    const next = (cursor + 1) % denseCount;
    const run = denseAt[cursor + 1] - denseAt[cursor];
    const t = run > 0 ? (target - denseAt[cursor]) / run : 0;
    xs[index] = denseX[cursor] + (denseX[next] - denseX[cursor]) * t;
    ys[index] = denseY[cursor] + (denseY[next] - denseY[cursor]) * t;
    const spanIndex = denseSpan[cursor];
    const nextU = denseSpan[next] === spanIndex ? denseU[next] : 1;
    const u = denseU[cursor] + (nextU - denseU[cursor]) * t;
    const a = nodes[spanIndex];
    const b = nodes[(spanIndex + 1) % nodeCount];
    const eased = racingEase(u);
    half[index] = (a.width + (b.width - a.width) * eased) / 2;
    verge[index] = a.verge + (b.verge - a.verge) * eased;
    edgeLeft[index] = RACING_EDGE_CODE[a.edgeLeft] ?? RACING_EDGE_WALL;
    edgeRight[index] = RACING_EDGE_CODE[a.edgeRight] ?? RACING_EDGE_WALL;
    surface[index] = a.surface;
    node[index] = spanIndex;
  }

  // -- direction and bend -----------------------------------------------
  const txs = new Float64Array(count);
  const tys = new Float64Array(count);
  const curve = new Float64Array(count);
  for (let index = 0; index < count; index += 1) {
    const back = (index - 1 + count) % count;
    const ahead = (index + 1) % count;
    const dx = xs[ahead] - xs[back];
    const dy = ys[ahead] - ys[back];
    const run = Math.sqrt(dx * dx + dy * dy);
    txs[index] = run > 0 ? dx / run : 1;
    tys[index] = run > 0 ? dy / run : 0;
    // Signed Menger curvature over a two-sample stencil: positive bends
    // right, which with +y down is clockwise on screen.
    const a = (index - 2 + count) % count;
    const c = (index + 2) % count;
    const abx = xs[index] - xs[a];
    const aby = ys[index] - ys[a];
    const bcx = xs[c] - xs[index];
    const bcy = ys[c] - ys[index];
    const acx = xs[c] - xs[a];
    const acy = ys[c] - ys[a];
    const product = Math.sqrt((abx * abx + aby * aby) * (bcx * bcx + bcy * bcy) * (acx * acx + acy * acy));
    curve[index] = product > 0 ? (2 * (abx * bcy - aby * bcx)) / product : 0;
  }

  // -- the edges, for renderers and for the reach -----------------------
  const roadLeft = new Float64Array(count * 2);
  const roadRight = new Float64Array(count * 2);
  const outerLeft = new Float64Array(count * 2);
  const outerRight = new Float64Array(count * 2);
  let reach = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let index = 0; index < count; index += 1) {
    // Right of travel is (-ty, tx): east's right is south, with +y down.
    const rx = -tys[index];
    const ry = txs[index];
    const outer = half[index] + verge[index];
    roadLeft[index * 2] = xs[index] - rx * half[index];
    roadLeft[index * 2 + 1] = ys[index] - ry * half[index];
    roadRight[index * 2] = xs[index] + rx * half[index];
    roadRight[index * 2 + 1] = ys[index] + ry * half[index];
    outerLeft[index * 2] = xs[index] - rx * outer;
    outerLeft[index * 2 + 1] = ys[index] - ry * outer;
    outerRight[index * 2] = xs[index] + rx * outer;
    outerRight[index * 2 + 1] = ys[index] + ry * outer;
    if (outer > reach) reach = outer;
    if (xs[index] < minX) minX = xs[index];
    if (xs[index] > maxX) maxX = xs[index];
    if (ys[index] < minY) minY = ys[index];
    if (ys[index] > maxY) maxY = ys[index];
  }
  reach += route.band;

  const track = {
    count, ds, length, resolution,
    xs, ys, txs, tys, curve, half, verge, edgeLeft, edgeRight, surface, node,
    band: route.band,
    reach,
    offroad: spec.offroad,
    edges: { roadLeft, roadRight, outerLeft, outerRight },
    minX, minY, maxX, maxY,
    /** @type {any} */ bounds: null,
    /** @type {any[]} */ patches: [],
    /** @type {Array<{x: number, y: number}>} */ pickups: [],
    /** @type {Array<{x: number, y: number}>} */ props: [],
    /** @type {Array<{x: number, y: number, dirX: number, dirY: number}>} */ decor: [],
    /** Every node's id, in route order, and its distance round the lap. */
    nodeIds: nodes.map((node) => node.id),
    nodeS,
    /** Split distances, px from the line, sorted; filled in below. */
    /** @type {number[]} */ checkpoints: [],
    /** @type {any} */ grid: null,
    /** The racing line: an offset to the right of the centreline, per sample. */
    /** @type {Float64Array} */ line: new Float64Array(count),
    /** Curvature smoothed over about a car's length, per sample. */
    /** @type {Float64Array} */ bend: new Float64Array(count),
    /** @type {Int32Array} */ safe: new Int32Array(count),
    progressWindow: Math.max(8, Math.ceil(320 / ds)),
  };

  // -- things laid on it ------------------------------------------------
  const nodeIndex = new Map(track.nodeIds.map((id, index) => [id, index]));
  const anchorS = (item) => nodeS[nodeIndex.get(item.node) ?? 0] + item.along;
  const place = (item) => {
    if (item.node !== undefined) {
      const spot = racingPointAt(track, anchorS(item), item.offset);
      return { x: spot.x, y: spot.y, tx: spot.tx, ty: spot.ty };
    }
    if (item.at !== undefined) {
      const spot = racingPointAt(track, item.at * length, item.offset);
      return { x: spot.x, y: spot.y, tx: spot.tx, ty: spot.ty };
    }
    return { x: item.x, y: item.y, tx: 1, ty: 0 };
  };
  track.patches = spec.patches.map((patch) => {
    const spot = place(patch);
    // The patch's direction: the route's for a route-placed one, turned by
    // `angle`; east, turned by `angle`, for one placed in the world.
    const turn = patch.angle * RACING_DEGREES;
    const c = cos(turn);
    const s = sin(turn);
    const dirX = spot.tx * c - spot.ty * s;
    const dirY = spot.tx * s + spot.ty * c;
    const circle = patch.shape === "circle";
    const halfLength = circle ? patch.radius : patch.length / 2;
    const halfWidth = circle ? patch.radius : patch.width / 2;
    const extent = circle ? patch.radius : Math.sqrt(halfLength * halfLength + halfWidth * halfWidth);
    return {
      circle, x: spot.x, y: spot.y, dirX, dirY, halfLength, halfWidth,
      radius: circle ? patch.radius : extent,
      surface: patch.surface,
      minX: spot.x - extent, minY: spot.y - extent, maxX: spot.x + extent, maxY: spot.y + extent,
    };
  });
  track.pickups = spec.pickups.map((pickup) => {
    const spot = place(pickup);
    return { x: spot.x, y: spot.y };
  });
  track.props = spec.props.map((prop) => {
    const spot = place(prop);
    return { x: spot.x, y: spot.y };
  });
  // Decorations are placed like everything else, and drawn by the game; the
  // simulation never reads them.
  track.decor = (spec.decor ?? []).map((item) => {
    const spot = place(item);
    const turn = item.angle * RACING_DEGREES;
    const c = cos(turn);
    const s = sin(turn);
    return { x: spot.x, y: spot.y, dirX: spot.tx * c - spot.ty * s, dirY: spot.tx * s + spot.ty * c };
  });
  // Checkpoints, resolved to distances and sorted, whichever way each was
  // written. One within a pixel of the line or of another is dropped: a
  // split that lands on the start line is the lap, and two on one spot are
  // one.
  const splits = [];
  for (const checkpoint of spec.checkpoints) {
    const raw = typeof checkpoint === "number" ? checkpoint * length : anchorS(checkpoint);
    const at = raw - Math.floor(raw / length) * length;
    if (at > 1 && at < length - 1) splits.push(at);
  }
  splits.sort((a, b) => a - b);
  track.checkpoints = splits.filter((at, index) => index === 0 || at - splits[index - 1] > 1);

  // -- the world's edge -------------------------------------------------
  track.bounds = spec.bounds
    ? {
      x0: spec.bounds.x, y0: spec.bounds.y,
      x1: spec.bounds.x + spec.bounds.w, y1: spec.bounds.y + spec.bounds.h,
      beyond: spec.bounds.beyond,
    }
    : {
      // Well clear of the route, and a wall, so a car on open ground cannot
      // wander off forever — which is a world, where a null is a crash.
      x0: minX - reach - 240, y0: minY - reach - 240,
      x1: maxX + reach + 240, y1: maxY + reach + 240,
      beyond: "wall",
    };

  // -- the lookup grid: property (2) made affordable --------------------
  // Every segment is registered in every cell within `reach` of it, so the
  // one cell a point falls in holds every segment that could be its
  // nearest. A point with no candidates is simply far from the road.
  const register = reach + RACING_GRID_SLACK;
  let areaX0 = minX - register;
  let areaY0 = minY - register;
  let areaX1 = maxX + register;
  let areaY1 = maxY + register;
  for (const patch of track.patches) {
    areaX0 = Math.min(areaX0, patch.minX);
    areaY0 = Math.min(areaY0, patch.minY);
    areaX1 = Math.max(areaX1, patch.maxX);
    areaY1 = Math.max(areaY1, patch.maxY);
  }
  areaX0 = Math.max(areaX0, track.bounds.x0 - register);
  areaY0 = Math.max(areaY0, track.bounds.y0 - register);
  areaX1 = Math.min(areaX1, track.bounds.x1 + register);
  areaY1 = Math.min(areaY1, track.bounds.y1 + register);
  let cell = Math.max(32, register);
  let cols = Math.max(1, Math.ceil((areaX1 - areaX0) / cell));
  let rows = Math.max(1, Math.ceil((areaY1 - areaY0) / cell));
  if (cols * rows > RACING_MAX_CELLS) {
    cell *= Math.sqrt((cols * rows) / RACING_MAX_CELLS) * 1.01;
    cols = Math.max(1, Math.ceil((areaX1 - areaX0) / cell));
    rows = Math.max(1, Math.ceil((areaY1 - areaY0) / cell));
  }
  const segments = racingGrid(areaX0, areaY0, cell, cols, rows, count, (index, box) => {
    const next = (index + 1) % count;
    box[0] = Math.min(xs[index], xs[next]) - register;
    box[1] = Math.min(ys[index], ys[next]) - register;
    box[2] = Math.max(xs[index], xs[next]) + register;
    box[3] = Math.max(ys[index], ys[next]) + register;
  });
  const patchCells = racingGrid(areaX0, areaY0, cell, cols, rows, track.patches.length, (index, box) => {
    const patch = track.patches[index];
    box[0] = patch.minX;
    box[1] = patch.minY;
    box[2] = patch.maxX;
    box[3] = patch.maxY;
  });
  track.grid = { originX: areaX0, originY: areaY0, cell, cols, rows, segments, patches: patchCells };

  // -- safe ground, for putting a car back ------------------------------
  // A respawn point must not be a hole, a ramp, a zipper, an oil slick or a
  // static prop — and it must not be just short of a jump either. A car put
  // back at the lip of the gap it failed to clear rolls onto the ramp too
  // slowly to leave it, falls again, and is put back at the same lip for
  // ever; the first race run on the first sample track did exactly that,
  // with all four cars. So everything within a run-up of a ramp or a hole
  // is unsafe too, and `safe[i]` is the nearest safe sample at or behind `i`.
  const unsafe = new Uint8Array(count);
  const launching = new Uint8Array(count);
  const ground = { surface: 0, dirX: 1, dirY: 0 };
  for (let index = 0; index < count; index += 1) {
    racingGroundInto(track, xs[index], ys[index], ground);
    const code = ground.surface;
    if (code === RACING_HOLE || code === RACING_RAMP) launching[index] = 1;
    let blocked = code === RACING_HOLE || code === RACING_RAMP || code === RACING_BOOST || code === RACING_OIL;
    for (let at = 0; !blocked && at < spec.props.length; at += 1) {
      if (spec.props[at].mass > 0) continue;
      const dx = xs[index] - track.props[at].x;
      const dy = ys[index] - track.props[at].y;
      const clear = spec.props[at].radius + 24;
      if (dx * dx + dy * dy < clear * clear) blocked = true;
    }
    unsafe[index] = blocked ? 1 : 0;
  }
  const runUp = Math.ceil(RACING_RUN_UP / ds);
  let toLaunch = Infinity;
  for (let lap = 0; lap < 2; lap += 1) {
    for (let index = count - 1; index >= 0; index -= 1) {
      toLaunch = launching[index] === 1 ? 0 : toLaunch + 1;
      if (toLaunch <= runUp) unsafe[index] = 1;
    }
  }
  let lastSafe = -1;
  for (let lap = 0; lap < 2; lap += 1) {
    for (let index = 0; index < count; index += 1) {
      if (unsafe[index] === 0) lastSafe = index;
      track.safe[index] = lastSafe < 0 ? index : lastSafe;
    }
  }

  // -- the racing line --------------------------------------------------
  // Toward the inside of each bend, in proportion to how tight it is and to
  // the road there is to use: a bend of radius 160 takes the whole of it.
  // Smoothed twice over about a car's braking distance, so the line drifts
  // across on the way in rather than stepping. It is a good line, not the
  // optimal one, and the driver adds its own `line` on top.
  const window = Math.max(1, Math.round(60 / ds));
  const smooth = (source) => {
    const out = new Float64Array(count);
    for (let index = 0; index < count; index += 1) {
      let total = 0;
      for (let k = -window; k <= window; k += 1) total += source[(index + k + count) % count];
      out[index] = total / (window * 2 + 1);
    }
    return out;
  };
  const bend = smooth(curve);
  track.bend = bend;
  const raw = new Float64Array(count);
  for (let index = 0; index < count; index += 1) {
    const room = Math.max(0, half[index] - 14);
    const lean = bend[index] * 160;
    raw[index] = (lean < -1 ? -1 : lean > 1 ? 1 : lean) * room;
  }
  track.line = smooth(smooth(raw));
  return track;
}

/**
 * A point along the route: `s` pixels from the start line (any value; it
 * wraps), `offset` pixels to the right of the centreline.
 *
 * @returns {{x: number, y: number, tx: number, ty: number, half: number, index: number}}
 */
export function racingPointAt(track, s, offset = 0) {
  const { count, ds, xs, ys, txs, tys, half } = track;
  const lap = track.length;
  let along = s - Math.floor(s / lap) * lap;
  if (!(along >= 0 && along < lap)) along = 0;
  const position = along / ds;
  const index = Math.min(count - 1, Math.floor(position));
  const next = (index + 1) % count;
  const t = position - index;
  let tx = txs[index] + (txs[next] - txs[index]) * t;
  let ty = tys[index] + (tys[next] - tys[index]) * t;
  const run = Math.sqrt(tx * tx + ty * ty);
  tx = run > 0 ? tx / run : 1;
  ty = run > 0 ? ty / run : 0;
  const x = xs[index] + (xs[next] - xs[index]) * t;
  const y = ys[index] + (ys[next] - ys[index]) * t;
  return {
    x: x - ty * offset,
    y: y + tx * offset,
    tx,
    ty,
    half: half[index] + (half[next] - half[index]) * t,
    index,
  };
}

/**
 * The nearest point of segment `index` to (x, y), written into `out`.
 * Segment `i` runs from sample `i` to sample `i + 1`, wrapping.
 */
function racingSegmentInto(track, index, x, y, out) {
  const { count, xs, ys } = track;
  const next = (index + 1) % count;
  const ax = xs[index];
  const ay = ys[index];
  const dx = xs[next] - ax;
  const dy = ys[next] - ay;
  const run = dx * dx + dy * dy;
  let t = run > 0 ? ((x - ax) * dx + (y - ay) * dy) / run : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const px = ax + dx * t;
  const py = ay + dy * t;
  const ox = x - px;
  const oy = y - py;
  out.segment = index;
  out.t = t;
  out.px = px;
  out.py = py;
  out.distance = Math.sqrt(ox * ox + oy * oy);
  // The standard cross product of the segment with the offset, and +y
  // being down is what makes positive the RIGHT of travel.
  out.side = dx * oy - dy * ox >= 0 ? 1 : -1;
}

/** Scratch for the solver's queries, so nothing allocates per wheel. */
const RACING_PROBE = { segment: 0, t: 0, px: 0, py: 0, distance: 0, side: 1 };

/**
 * The nearest centreline point to (x, y) within `limit` — the route's
 * reach unless a caller asks for a little more — written into `out`, or
 * false when nothing is that close: the point is far from every road.
 * Property (2).
 */
function racingNearestInto(track, x, y, out, limit = track.reach) {
  const grid = track.grid;
  const col = Math.floor((x - grid.originX) / grid.cell);
  const row = Math.floor((y - grid.originY) / grid.cell);
  if (col < 0 || row < 0 || col >= grid.cols || row >= grid.rows) return false;
  const at = row * grid.cols + col;
  const { start, items } = grid.segments;
  let found = false;
  let best = Infinity;
  for (let k = start[at]; k < start[at + 1]; k += 1) {
    racingSegmentInto(track, items[k], x, y, RACING_PROBE);
    // Ties go to the lower index, and the scan order is the grid's, which
    // is the same on every machine — so a point equidistant from two
    // stretches of road is claimed by the same one everywhere.
    if (RACING_PROBE.distance < best) {
      best = RACING_PROBE.distance;
      out.segment = RACING_PROBE.segment;
      out.t = RACING_PROBE.t;
      out.px = RACING_PROBE.px;
      out.py = RACING_PROBE.py;
      out.distance = RACING_PROBE.distance;
      out.side = RACING_PROBE.side;
      found = true;
    }
  }
  return found && best <= limit;
}

/**
 * The nearest centreline point to (x, y), or null when the point is farther
 * than the route's reach from every stretch of it. `s` is how far round the
 * lap that point is, and `lateral` is signed: positive to the right.
 *
 * @returns {{segment: number, t: number, x: number, y: number, s: number, distance: number, lateral: number} | null}
 */
export function racingNearest(track, x, y) {
  const near = { segment: 0, t: 0, px: 0, py: 0, distance: 0, side: 1 };
  if (!racingNearestInto(track, x, y, near)) return null;
  return {
    segment: near.segment,
    t: near.t,
    x: near.px,
    y: near.py,
    s: (near.segment + near.t) * track.ds,
    distance: near.distance,
    lateral: near.distance * near.side,
  };
}

/**
 * Where a car is along the route, searched only near where it was.
 *
 * This is progress, not geometry, and the difference is the point: a car's
 * place in the race must follow the road it is on, not whichever road is
 * nearest. At a crossing the two answers differ, and a car that leaves the
 * route and drives across open ground to a later stretch must not be
 * credited with the distance it skipped. So the search is a window of
 * segments either side of the car's last `cursor`, and the car carries that
 * cursor in its own state — which is what makes it rewind.
 *
 * @returns {{segment: number, t: number, s: number, distance: number, lateral: number}}
 */
export function racingProgress(track, x, y, cursor) {
  const out = { segment: 0, t: 0, px: 0, py: 0, distance: 0, side: 1 };
  racingProgressInto(track, x, y, cursor, out);
  return {
    segment: out.segment,
    t: out.t,
    s: (out.segment + out.t) * track.ds,
    distance: out.distance,
    lateral: out.distance * out.side,
  };
}

/** `racingProgress`, into a caller's object. */
export function racingProgressInto(track, x, y, cursor, out) {
  const { count, progressWindow } = track;
  let best = Infinity;
  const from = cursor - progressWindow;
  for (let k = 0; k <= progressWindow * 2; k += 1) {
    const index = ((from + k) % count + count) % count;
    racingSegmentInto(track, index, x, y, RACING_PROBE);
    if (RACING_PROBE.distance < best) {
      best = RACING_PROBE.distance;
      out.segment = RACING_PROBE.segment;
      out.t = RACING_PROBE.t;
      out.px = RACING_PROBE.px;
      out.py = RACING_PROBE.py;
      out.distance = RACING_PROBE.distance;
      out.side = RACING_PROBE.side;
    }
  }
  return out;
}

const RACING_NEAR = { segment: 0, t: 0, px: 0, py: 0, distance: 0, side: 1 };

/**
 * What is underfoot at (x, y), written into `out`: the surface code, and
 * the direction a zipper pushes or a ramp launches along.
 *
 * Precedence, which is the whole of the ground model: past the world's edge
 * first — off the table is off the table — then the topmost patch, then the
 * route by distance from its nearest centreline point: road, verge, and
 * then the band past the verge, which is a hole on a `drop` side and
 * offroad on the others. A `wall` band reads as offroad because nothing
 * stands in it; the walls themselves are `racingWallInto`'s business.
 */
export function racingGroundInto(track, x, y, out) {
  const bounds = track.bounds;
  if (x < bounds.x0 || x > bounds.x1 || y < bounds.y0 || y > bounds.y1) {
    out.surface = bounds.beyond === "drop" ? RACING_HOLE : track.offroad;
    out.dirX = 1;
    out.dirY = 0;
    return out;
  }

  const grid = track.grid;
  const col = Math.floor((x - grid.originX) / grid.cell);
  const row = Math.floor((y - grid.originY) / grid.cell);
  if (col >= 0 && row >= 0 && col < grid.cols && row < grid.rows) {
    const at = row * grid.cols + col;
    const { start, items } = grid.patches;
    let top = -1;
    for (let k = start[at]; k < start[at + 1]; k += 1) {
      const index = items[k];
      if (index <= top) continue;
      const patch = track.patches[index];
      const dx = x - patch.x;
      const dy = y - patch.y;
      if (patch.circle) {
        if (dx * dx + dy * dy <= patch.radius * patch.radius) top = index;
      } else {
        const along = dx * patch.dirX + dy * patch.dirY;
        const across = -dx * patch.dirY + dy * patch.dirX;
        if (along >= -patch.halfLength && along <= patch.halfLength &&
            across >= -patch.halfWidth && across <= patch.halfWidth) top = index;
      }
    }
    if (top >= 0) {
      const patch = track.patches[top];
      out.surface = patch.surface;
      out.dirX = patch.dirX;
      out.dirY = patch.dirY;
      return out;
    }
  }

  if (!racingNearestInto(track, x, y, RACING_NEAR)) {
    out.surface = track.offroad;
    out.dirX = 1;
    out.dirY = 0;
    return out;
  }
  const index = RACING_NEAR.segment;
  const next = (index + 1) % track.count;
  const t = RACING_NEAR.t;
  const roadHalf = track.half[index] + (track.half[next] - track.half[index]) * t;
  const verge = track.verge[index] + (track.verge[next] - track.verge[index]) * t;
  out.dirX = track.txs[index];
  out.dirY = track.tys[index];
  const distance = RACING_NEAR.distance;
  if (distance <= roadHalf) {
    out.surface = track.surface[index];
    return out;
  }
  if (distance <= roadHalf + verge) {
    out.surface = track.offroad;
    return out;
  }
  const edge = RACING_NEAR.side > 0 ? track.edgeRight[index] : track.edgeLeft[index];
  out.surface = edge === RACING_EDGE_DROP && distance <= roadHalf + verge + track.band
    ? RACING_HOLE
    : track.offroad;
  return out;
}

/** The surface code at (x, y). */
export function racingSurfaceAt(track, x, y) {
  const out = { surface: 0, dirX: 1, dirY: 0 };
  return racingGroundInto(track, x, y, out).surface;
}

/**
 * What is underfoot at (x, y): the surface code, its numbers, and the
 * direction a zipper or a ramp there acts along.
 */
export function racingGroundAt(track, x, y) {
  const out = { surface: 0, dirX: 1, dirY: 0 };
  racingGroundInto(track, x, y, out);
  return { surface: out.surface, dirX: out.dirX, dirY: out.dirY, ...racingSurface(out.surface) };
}

/**
 * The deepest wall a disc at (x, y) is pressing into, written into `out` as
 * the direction to push it and how far — or false for none.
 *
 * Two kinds of wall: the band past the verge on a `wall` side of the route,
 * and the world's edge when it is a wall. A band pushes a disc out of the
 * face its centre is nearer (property 3): a car on the road is kept on it,
 * and a car that reached the far side by any other route is kept there,
 * rather than being dragged through.
 */
export function racingWallInto(track, x, y, radius, out) {
  let deepest = 0;
  if (racingNearestInto(track, x, y, RACING_NEAR, track.reach + Math.min(radius, RACING_GRID_SLACK))) {
    const index = RACING_NEAR.segment;
    const edge = RACING_NEAR.side > 0 ? track.edgeRight[index] : track.edgeLeft[index];
    if (edge === RACING_EDGE_WALL) {
      const next = (index + 1) % track.count;
      const t = RACING_NEAR.t;
      const inner = track.half[index] + (track.half[next] - track.half[index]) * t +
        track.verge[index] + (track.verge[next] - track.verge[index]) * t;
      const outer = inner + track.band;
      const distance = RACING_NEAR.distance;
      // From the centreline towards the disc. A disc sitting exactly on the
      // centreline cannot be touching a wall, so the zero case never pushes.
      const awayX = distance > 1e-9 ? (x - RACING_NEAR.px) / distance : 0;
      const awayY = distance > 1e-9 ? (y - RACING_NEAR.py) / distance : 0;
      if (distance < (inner + outer) / 2) {
        const depth = distance + radius - inner;
        if (depth > deepest && distance > 1e-9) {
          deepest = depth;
          out.nx = -awayX;
          out.ny = -awayY;
        }
      } else {
        const depth = outer - (distance - radius);
        if (depth > deepest) {
          deepest = depth;
          out.nx = awayX;
          out.ny = awayY;
        }
      }
    }
  }
  const bounds = track.bounds;
  if (bounds.beyond === "wall") {
    const left = bounds.x0 - (x - radius);
    const right = (x + radius) - bounds.x1;
    const top = bounds.y0 - (y - radius);
    const bottom = (y + radius) - bounds.y1;
    if (left > deepest) { deepest = left; out.nx = 1; out.ny = 0; }
    if (right > deepest) { deepest = right; out.nx = -1; out.ny = 0; }
    if (top > deepest) { deepest = top; out.nx = 0; out.ny = 1; }
    if (bottom > deepest) { deepest = bottom; out.nx = 0; out.ny = -1; }
  }
  out.depth = deepest;
  return deepest > 0;
}

/**
 * The wall contact for a disc, or null. The allocation-free form is
 * `racingWallInto`; this one is for tests, tools and editors.
 */
export function racingWallContact(track, x, y, radius) {
  const out = { nx: 0, ny: 0, depth: 0 };
  return racingWallInto(track, x, y, radius, out) ? { nx: out.nx, ny: out.ny, depth: out.depth } : null;
}
