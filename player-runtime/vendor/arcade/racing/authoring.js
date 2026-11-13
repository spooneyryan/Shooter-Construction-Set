// The editor's half of a track, headless.
//
// A track editor needs three things a race does not: edits that keep every
// placed thing where it is on the ground, answers about how a track will
// drive before anyone drives it, and the suite's reference driver as a
// button. They live here rather than in an editor because a track is this
// genre's own document — the Platformer's lesson, that the engine owns what
// describes its own document — and because here every one of them is pinned
// by a node test, which is where this pack pins its semantics first.
//
// **Every edit takes a track and returns a new, normalized one.** Nothing is
// mutated, so an editor's undo is simply the document before. And before any
// edit, everything placed by fraction of the lap is anchored to a node: a
// fraction slides whenever the lap's length changes, which is the drift
// contract version 2 exists to stop. After any edit here, a track is
// anchored throughout, and its numbers are rounded to a hundredth of a pixel
// so a share link does not carry sixteen digits of noise.
//
// None of this runs inside a race. The headless check runs races of its own,
// through `createRace` like anyone else.

import { hypot } from "../core/trig.js";
import {
  RACING_BOOST,
  RACING_HOLE,
  RACING_ICE,
  RACING_OIL,
  RACING_RAMP,
  RACING_SAND,
  RACING_SURFACES,
  RACING_WATER,
  normalizeRacingTrack,
  racingSurface,
} from "./contract.js";
import { RACING_LAUNCH_FLOOR, racingCarCorners, racingTune } from "./car.js";
import { RACING_STUCK_TICKS, racingDriverInput, racingPace } from "./driver.js";
import {
  RACING_EDGE_OPEN,
  buildRacingTrack,
  racingNearest,
  racingPointAt,
  racingSurfaceAt,
} from "./track.js";
import { createRace } from "./world.js";

/** Fewest nodes a route may have: fewer is not a loop. */
export const RACING_MIN_NODES = 3;

// -- small helpers ----------------------------------------------------------

/** A hundredth of a pixel: finer than anything a race can feel. Never -0. */
function racingTidy(value) {
  return Math.round(value * 100) / 100 || 0;
}

function racingWrapS(s, lap) {
  const at = s - Math.floor(s / lap) * lap;
  return at >= 0 && at < lap ? at : 0;
}

/** The last node at or before distance `s` round the lap. */
function racingNodeBefore(route, s) {
  const nodeS = route.nodeS;
  let low = 0;
  let high = nodeS.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (nodeS[mid] <= s) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** Distance `s` round the lap as an anchor: the node before it, and how far past. */
function racingAnchorFor(route, s, offset) {
  const at = racingWrapS(s, route.length);
  const node = racingNodeBefore(route, at);
  return { node: route.nodeIds[node], along: racingTidy(at - route.nodeS[node]), offset: racingTidy(offset) };
}

/** A fresh node id, deterministic: the first `n<k>` nobody uses, from the count up. */
function racingFreshNodeId(nodes) {
  const taken = new Set(nodes.map((node) => node.id));
  let k = nodes.length;
  while (taken.has(`n${k}`)) k += 1;
  return `n${k}`;
}

/** Every list whose members are placed, and the checkpoints, which are anchors of their own. */
const RACING_PLACED_LISTS = ["patches", "pickups", "props", "decor"];

/**
 * Rewrite every node-anchored placement in a track through `move`, which
 * takes an anchor `{node, along, offset}` and returns one.
 */
function racingRemapAnchors(spec, move) {
  const remap = (item) => {
    if (item.node === undefined) return item;
    const next = move({ node: item.node, along: item.along, offset: item.offset ?? 0 });
    return { ...item, node: next.node, along: racingTidy(next.along), offset: racingTidy(next.offset) };
  };
  const out = { ...spec };
  for (const list of RACING_PLACED_LISTS) out[list] = spec[list].map(remap);
  out.checkpoints = spec.checkpoints.map((checkpoint) => {
    if (typeof checkpoint === "number") return checkpoint;
    const next = move({ node: checkpoint.node, along: checkpoint.along, offset: 0 });
    return { node: next.node, along: racingTidy(next.along) };
  });
  return out;
}

/** A normalized track with every lap-fraction placement anchored to a node. */
function racingAnchoredSpec(track) {
  const spec = normalizeRacingTrack(track);
  const route = buildRacingTrack(spec);
  const anchor = (item) => {
    if (item.at === undefined) return item;
    const { at, ...rest } = item;
    return { ...rest, ...racingAnchorFor(route, at * route.length, item.offset ?? 0) };
  };
  const out = { ...spec };
  for (const list of RACING_PLACED_LISTS) out[list] = spec[list].map(anchor);
  out.checkpoints = spec.checkpoints.map((checkpoint) => {
    if (typeof checkpoint !== "number") return checkpoint;
    const { node, along } = racingAnchorFor(route, checkpoint * route.length, 0);
    return { node, along };
  });
  return { spec: out, route };
}

// -- placement ----------------------------------------------------------------

/**
 * Anchor everything placed by fraction of the lap to the node before it, at
 * the same place on the ground. What an editor does to a track once, on
 * opening it; every edit below does it anyway.
 *
 * @param {any} track
 */
export function anchorRacingTrack(track) {
  return normalizeRacingTrack(racingAnchoredSpec(track).spec);
}

/**
 * Where a point in the world is, on the route: the nearest place on the
 * centreline as a distance round the lap, and as the anchor an editor would
 * write for something dropped there — exact, so `racingPlacementPoint` of
 * the anchor is the point again. `lateral` is px right of the line.
 * Null when the point is beyond the route's reach: place that at `x, y`.
 * At a crossing the nearer stretch wins, as it does for a wheel.
 *
 * @param {any} route From `buildRacingTrack`.
 * @param {number} x
 * @param {number} y
 */
export function racingAnchorAt(route, x, y) {
  const near = racingNearest(route, x, y);
  if (!near) return null;
  // The nearest query measures from the chord between two samples; placing
  // measures square to the curve between them, which differs by pixels on
  // the inside of a tight bend. So find, by halving, the distance at which
  // the point is square across the route: how far it lies ahead there
  // changes sign across it.
  const ahead = (at) => {
    const spot = racingPointAt(route, at, 0);
    return (x - spot.x) * spot.tx + (y - spot.y) * spot.ty;
  };
  let low = near.s - route.ds * 2;
  let high = near.s + route.ds * 2;
  let s = near.s;
  if (ahead(low) > 0 && ahead(high) < 0) {
    for (let round = 0; round < 40; round += 1) {
      const mid = (low + high) / 2;
      if (ahead(mid) > 0) low = mid;
      else high = mid;
    }
    s = (low + high) / 2;
  }
  const spot = racingPointAt(route, s, 0);
  const lateral = -(x - spot.x) * spot.ty + (y - spot.y) * spot.tx;
  const at = racingWrapS(s, route.length);
  return { ...racingAnchorFor(route, at, lateral), s: at, lateral };
}

/**
 * Where a placement is in the world, whichever way it was written: past a
 * node, at a fraction of the lap, or at `x, y`. `tx, ty` is the direction
 * the route runs there — east for a plain point.
 *
 * @param {any} route From `buildRacingTrack`.
 * @param {any} placement
 */
export function racingPlacementPoint(route, placement) {
  if (placement && typeof placement.node === "string") {
    const index = route.nodeIds.indexOf(placement.node);
    const s = route.nodeS[index < 0 ? 0 : index] + (Number(placement.along) || 0);
    const spot = racingPointAt(route, s, Number(placement.offset) || 0);
    return { x: spot.x, y: spot.y, tx: spot.tx, ty: spot.ty };
  }
  if (placement && placement.at !== undefined) {
    const spot = racingPointAt(route, (Number(placement.at) || 0) * route.length, Number(placement.offset) || 0);
    return { x: spot.x, y: spot.y, tx: spot.tx, ty: spot.ty };
  }
  return { x: Number(placement?.x) || 0, y: Number(placement?.y) || 0, tx: 1, ty: 0 };
}

// -- route edits ----------------------------------------------------------------

/**
 * Split the stretch at `s` px round the lap with a new node on the curve —
 * "click the road to add a node". The new node takes the stretch's edges and
 * surface, and a width and verge in proportion between its neighbours; the
 * things past it on that stretch are re-anchored to it, so moving it later
 * carries them. Returns the track and the new node's index.
 *
 * @param {any} track
 * @param {number} s
 * @returns {{track: any, index: number}}
 */
export function insertRacingNode(track, s) {
  const { spec, route } = racingAnchoredSpec(track);
  const at = racingWrapS(Number(s) || 0, route.length);
  const before = racingNodeBefore(route, at);
  const nodes = spec.route.nodes;
  const after = (before + 1) % nodes.length;
  const spanEnd = after === 0 ? route.length : route.nodeS[after];
  const past = at - route.nodeS[before];
  const t = spanEnd > route.nodeS[before] ? past / (spanEnd - route.nodeS[before]) : 0;
  const spot = racingPointAt(route, at, 0);
  const from = nodes[before];
  const to = nodes[after];
  const node = {
    ...from,
    id: racingFreshNodeId(nodes),
    x: racingTidy(spot.x),
    y: racingTidy(spot.y),
    width: racingTidy(from.width + (to.width - from.width) * t),
    verge: racingTidy(from.verge + (to.verge - from.verge) * t),
  };
  const moved = racingRemapAnchors(spec, (anchor) => (anchor.node === from.id && anchor.along >= past
    ? { ...anchor, node: node.id, along: anchor.along - past }
    : anchor));
  const out = { ...moved, route: { ...spec.route, nodes: [...nodes.slice(0, before + 1), node, ...nodes.slice(before + 1)] } };
  return { track: normalizeRacingTrack(out), index: before + 1 };
}

/**
 * Add a node after node `after` at a point off the curve — "click open
 * ground to add one after the selected node". It is inserted where that
 * point meets the stretch and then moved out to it, so what lay past that
 * place on the stretch goes with the new node. Returns the track and the
 * new node's index.
 *
 * @param {any} track
 * @param {number} after
 * @param {number} x
 * @param {number} y
 * @returns {{track: any, index: number}}
 */
export function addRacingNode(track, after, x, y) {
  const { spec, route } = racingAnchoredSpec(track);
  const count = spec.route.nodes.length;
  const from = Math.max(0, Math.min(count - 1, Math.round(Number(after)) || 0));
  // The sample on that stretch nearest the point.
  const first = Math.round(route.nodeS[from] / route.ds);
  const last = Math.round((from + 1 < count ? route.nodeS[from + 1] : route.length) / route.ds);
  let best = first;
  let nearest = Infinity;
  for (let sample = first; sample <= last; sample += 1) {
    const index = sample % route.count;
    const d = hypot(route.xs[index] - x, route.ys[index] - y);
    if (d < nearest) {
      nearest = d;
      best = sample;
    }
  }
  // Just short of the next node, so the split never lands on it.
  const s = Math.min(best * route.ds, (last - 0.5) * route.ds);
  const inserted = insertRacingNode(spec, Math.max(route.nodeS[from] + route.ds * 0.5, s));
  return { track: moveRacingNode(inserted.track, inserted.index, x, y), index: inserted.index };
}

/**
 * Move node `index` to `(x, y)`. Everything anchored to any node stays
 * anchored to it; only the stretches this node bends move what is on them.
 *
 * @param {any} track
 * @param {number} index
 * @param {number} x
 * @param {number} y
 */
export function moveRacingNode(track, index, x, y) {
  const { spec } = racingAnchoredSpec(track);
  const nodes = spec.route.nodes.map((node, at) => (at === index
    ? { ...node, x: racingTidy(Number(x) || 0), y: racingTidy(Number(y) || 0) }
    : node));
  return normalizeRacingTrack({ ...spec, route: { ...spec.route, nodes } });
}

/**
 * Remove node `index` — never below `RACING_MIN_NODES`. What was anchored to
 * it is re-anchored to the node before, the same distance round the lap.
 * Removing node 0 makes the next node the start line.
 *
 * @param {any} track
 * @param {number} index
 */
export function removeRacingNode(track, index) {
  const { spec, route } = racingAnchoredSpec(track);
  const nodes = spec.route.nodes;
  if (nodes.length <= RACING_MIN_NODES || !(index >= 0 && index < nodes.length)) return normalizeRacingTrack(spec);
  const prev = (index - 1 + nodes.length) % nodes.length;
  const gap = index === 0 ? route.length - route.nodeS[prev] : route.nodeS[index] - route.nodeS[prev];
  const gone = nodes[index].id;
  const moved = racingRemapAnchors(spec, (anchor) => (anchor.node === gone
    ? { ...anchor, node: nodes[prev].id, along: anchor.along + gap }
    : anchor));
  return normalizeRacingTrack({ ...moved, route: { ...spec.route, nodes: nodes.filter((_, at) => at !== index) } });
}

/**
 * Make node `index` the start line. The loop is the same loop — a closed
 * spline does not care which node is first — so everything anchored stays
 * exactly where it is on the ground; the grid, the laps and the splits
 * move to the new line.
 *
 * @param {any} track
 * @param {number} index
 */
export function setRacingStart(track, index) {
  const { spec } = racingAnchoredSpec(track);
  const nodes = spec.route.nodes;
  const first = Math.max(0, Math.min(nodes.length - 1, Math.round(Number(index)) || 0));
  return normalizeRacingTrack({ ...spec, route: { ...spec.route, nodes: [...nodes.slice(first), ...nodes.slice(0, first)] } });
}

/**
 * Turn the lap round, keeping the start line where it is. Each stretch keeps
 * its surface and its walls — the left wall becomes the right, since it is
 * driven the other way — and everything placed stays where it is on the
 * ground. Zippers and ramps keep their angle to the road, so they work the
 * new way round; decorations keep the way they face in the world.
 *
 * A jump reversed is a hole before its ramp. Nothing here can fix that;
 * `racingTrackChecks` says so.
 *
 * @param {any} track
 */
export function reverseRacingRoute(track) {
  const { spec, route } = racingAnchoredSpec(track);
  const nodes = spec.route.nodes;
  const count = nodes.length;
  const order = [0];
  for (let k = count - 1; k >= 1; k -= 1) order.push(k);
  // The stretch from old node k-1 to k is driven from k now, so k carries it.
  const reversedNodes = order.map((k) => {
    const stretch = nodes[(k - 1 + count) % count];
    return { ...nodes[k], edgeLeft: stretch.edgeRight, edgeRight: stretch.edgeLeft, surface: stretch.surface };
  });
  const reversed = normalizeRacingTrack({ ...spec, route: { ...spec.route, nodes: reversedNodes } });
  const back = buildRacingTrack(reversed);
  const moveAnchor = (anchor) => {
    const index = route.nodeIds.indexOf(anchor.node);
    const s = route.nodeS[index < 0 ? 0 : index] + anchor.along;
    return racingAnchorFor(back, back.length - racingWrapS(s, route.length), -anchor.offset);
  };
  const moved = racingRemapAnchors({ ...reversed }, moveAnchor);
  // A decoration's angle is to the road, which now runs the other way.
  moved.decor = moved.decor.map((item) => {
    if (item.node === undefined) return item;
    const turned = item.angle + 180;
    return { ...item, angle: racingTidy(turned - 360 * Math.floor((turned + 180) / 360)) };
  });
  return normalizeRacingTrack(moved);
}

// -- how it drives ------------------------------------------------------------

/**
 * How far a car's centre flies off a ramp met at `speed` px/s: the engine's
 * own flight, substep for substep — launched at the ramp's share of the
 * speed along it, pulled down by `gravity`, slowed by the car's drag —
 * rather than a formula that would drift from it.
 *
 * @param {any} feel A normalized track's `feel`.
 * @param {any} tune From `racingTune`.
 * @param {number} speed
 */
export function racingJumpDistance(feel, tune, speed) {
  const h = 1 / 60 / feel.substeps;
  let v = speed > feel.maxSpeed ? feel.maxSpeed : speed;
  if (!(v > RACING_LAUNCH_FLOOR)) return 0;
  let vz = v * RACING_SURFACES[RACING_RAMP].launch;
  let z = vz * h;
  let x = 0;
  for (let step = 0; step < 100000 && z > 0; step += 1) {
    vz -= feel.gravity * h;
    z += vz * h;
    v -= v * tune.drag * v * h;
    x += v * h;
  }
  return x;
}

/**
 * The slowest a car can meet a ramp and still fly `distance` px — or null
 * when no car in this feel can, even at its speed limit.
 *
 * @param {any} feel
 * @param {any} tune
 * @param {number} distance
 */
export function racingJumpSpeed(feel, tune, distance) {
  if (racingJumpDistance(feel, tune, feel.maxSpeed) < distance) return null;
  let low = RACING_LAUNCH_FLOOR;
  let high = feel.maxSpeed;
  for (let round = 0; round < 40; round += 1) {
    const mid = (low + high) / 2;
    if (racingJumpDistance(feel, tune, mid) >= distance) high = mid;
    else low = mid;
  }
  return high;
}

/**
 * How far the racing line runs from each sample to the next, px. It cuts
 * every bend, so a lap on it is shorter than the centreline — by 9% round
 * the stadium — and an estimate that forgot that was 9% slow.
 */
function racingLineSteps(route) {
  const { count, xs, ys, txs, tys, line } = route;
  const steps = new Float64Array(count);
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count;
    const dx = (xs[next] - tys[next] * line[next]) - (xs[index] - tys[index] * line[index]);
    const dy = (ys[next] + txs[next] * line[next]) - (ys[index] + txs[index] * line[index]);
    steps[index] = Math.sqrt(dx * dx + dy * dy);
  }
  return steps;
}

/**
 * The speed a car can actually carry at every sample of the route, px/s,
 * driven on the racing line: the field's pace profile — the bends and the
 * braking before them — with the forward pass it leaves out, the motor
 * fading towards top speed against the surface's drag and the air's. What a
 * speed overlay draws, and what the lap estimate sums; the estimate is
 * within 2% of the reference driver's flying lap round both samples.
 *
 * @param {any} route
 * @param {any} tune
 * @param {number} [skill]
 */
export function racingSpeedProfile(route, tune, skill = 1) {
  const pace = racingPace(route, tune, skill);
  const { count } = route;
  const steps = racingLineSteps(route);
  let slowest = 0;
  for (let index = 1; index < count; index += 1) if (pace[index] < pace[slowest]) slowest = index;
  const speed = new Float64Array(count);
  speed[slowest] = pace[slowest];
  for (let k = 1; k <= count; k += 1) {
    const prev = (slowest + k - 1) % count;
    const index = (slowest + k) % count;
    const v = speed[prev];
    const ground = racingSurface(route.surface[prev]);
    const motor = tune.power * Math.max(0, 1 - v / tune.topSpeed);
    const traction = tune.grip * ground.grip;
    const push = (motor < traction ? motor : traction) - ground.drag * v - tune.drag * v * v;
    const reachable = Math.sqrt(Math.max(0, v * v + 2 * push * steps[prev]));
    speed[index] = reachable < pace[index] ? reachable : pace[index];
  }
  return speed;
}

/** Seconds round a lap on the racing line at a speed profile. */
function racingLapSeconds(route, speed) {
  const steps = racingLineSteps(route);
  let seconds = 0;
  for (let index = 0; index < route.count; index += 1) {
    const next = (index + 1) % route.count;
    const mean = (speed[index] + speed[next]) / 2;
    seconds += steps[index] / (mean > 1 ? mean : 1);
  }
  return seconds;
}

/**
 * What the ground is along the racing line, sample by sample — the line
 * the field drives, so the one whose hazards matter.
 */
function racingLineGround(route) {
  const ground = new Uint8Array(route.count);
  for (let index = 0; index < route.count; index += 1) {
    const offset = route.line[index];
    const x = route.xs[index] - route.tys[index] * offset;
    const y = route.ys[index] + route.txs[index] * offset;
    ground[index] = racingSurfaceAt(route, x, y);
  }
  return ground;
}

/** The racing line's point `s` px round the lap, between samples. */
function racingLinePoint(route, s) {
  const at = racingWrapS(s, route.length) / route.ds;
  const index = Math.min(route.count - 1, Math.floor(at));
  const next = (index + 1) % route.count;
  const offset = route.line[index] + (route.line[next] - route.line[index]) * (at - index);
  return racingPointAt(route, s, offset);
}

/**
 * Where on the racing line, between sample `from` and the one after it, the
 * ground stops or starts being `code` — found by halving, to a sixteenth of
 * a pixel, so a jump's numbers do not jump a sample at a time as a ramp is
 * dragged.
 */
function racingLineEdge(route, from, code) {
  let low = from * route.ds;
  let high = low + route.ds;
  const inside = (s) => {
    const spot = racingLinePoint(route, s);
    return racingSurfaceAt(route, spot.x, spot.y) === code;
  };
  const startsInside = inside(low);
  for (let round = 0; round < 8; round += 1) {
    const mid = (low + high) / 2;
    if (inside(mid) === startsInside) low = mid;
    else high = mid;
  }
  return racingLinePoint(route, high);
}

/** Runs of one surface round the loop, as [first, last] sample pairs. */
function racingRuns(ground, code) {
  const count = ground.length;
  let start = -1;
  for (let index = 0; index < count; index += 1) {
    if (ground[index] !== code) {
      start = index;
      break;
    }
  }
  if (start < 0) return [[0, count - 1]];
  const runs = [];
  let open = -1;
  for (let k = 1; k <= count; k += 1) {
    const index = (start + k) % count;
    if (ground[index] === code && open < 0) open = start + k;
    if (ground[index] !== code && open >= 0) {
      runs.push([open % count, (start + k - 1) % count]);
      open = -1;
    }
  }
  return runs;
}

/**
 * Every jump on the racing line: a ramp, and the hole after it if there is
 * one. `needs` is the speed that clears the hole — null for a jump over
 * nothing, or for a gap no car in this feel can clear — and `reaches` the
 * speed the car can carry onto the ramp, so `clears` is the question an
 * author asks while dragging a ramp: will this car make it?
 *
 * @param {any} track
 * @param {{car?: unknown}} [options] Whose car; the track's by default.
 */
export function racingJumps(track, options = {}) {
  const spec = normalizeRacingTrack(track);
  const route = buildRacingTrack(spec);
  return racingJumpsOn(spec, route, racingTune(racingCarFor(spec, options.car))).jumps;
}

/** The track's car, or another normalized as the track would. */
function racingCarFor(spec, car) {
  return car === undefined ? spec.car : normalizeRacingTrack({ ...spec, car }).car;
}

/**
 * The jumps on the racing line, and which of the line's holes they are
 * over — the part `racingTrackChecks` needs to find the holes nobody can
 * jump.
 */
function racingJumpsOn(spec, route, tune) {
  const ground = racingLineGround(route);
  const speed = racingSpeedProfile(route, tune, 1);
  const holes = racingRuns(ground, RACING_HOLE).filter(([first]) => ground[first] === RACING_HOLE);
  const jumped = new Set();
  const reachMax = racingJumpDistance(spec.feel, tune, spec.feel.maxSpeed) + tune.length * 2;
  const forward = (from, to) => ((to - from + route.count) % route.count) * route.ds;
  const jumps = racingRuns(ground, RACING_RAMP).filter(([first]) => ground[first] === RACING_RAMP).map(([first, last]) => {
    // Where the ramp begins, exactly: between the sample before it and its first.
    const spot = racingLineEdge(route, (first - 1 + route.count) % route.count, RACING_RAMP);
    // The first hole that starts after the ramp does, within any jump's reach.
    let hole = null;
    for (const run of holes) {
      const ahead = forward(first, run[0]);
      if (ahead > 0 && ahead <= reachMax && (hole === null || ahead < forward(first, hole[0]))) hole = run;
    }
    // The car launches as its front wheels meet the ramp, and falls if its
    // centre lands in the hole: so it must fly from where its centre is then
    // to the hole's far edge — in a straight line, since nothing steers in
    // the air.
    const far = hole ? racingLineEdge(route, hole[1], RACING_HOLE) : null;
    const gap = far ? hypot(far.x - spot.x, far.y - spot.y) + tune.front : 0;
    const needs = hole ? racingJumpSpeed(spec.feel, tune, gap) : null;
    const reaches = speed[first];
    if (hole) jumped.add(hole[0]);
    return {
      x: spot.x,
      y: spot.y,
      s: first * route.ds,
      ramp: forward(first, last) + route.ds,
      gap,
      hole: hole !== null,
      needs,
      reaches,
      clears: !hole || (needs !== null && reaches >= needs),
    };
  });
  return { jumps, holes, jumped };
}

/**
 * The numbers an editor shows beside a track: the lap's length, what the
 * car would lap it in driven by the reference driver, the tightest bend and
 * the speed it allows, and every jump.
 *
 * @param {any} track
 * @param {{car?: unknown, skill?: number}} [options]
 */
export function racingTrackNumbers(track, options = {}) {
  const spec = normalizeRacingTrack(track);
  const route = buildRacingTrack(spec);
  const tune = racingTune(racingCarFor(spec, options.car));
  const speed = racingSpeedProfile(route, tune, options.skill ?? 1);
  let tightest = 0;
  for (let index = 1; index < route.count; index += 1) {
    if (Math.abs(route.bend[index]) > Math.abs(route.bend[tightest])) tightest = index;
  }
  const bend = Math.abs(route.bend[tightest]);
  return {
    length: route.length,
    nodes: spec.route.nodes.length,
    lapTime: racingLapSeconds(route, speed),
    tightest: {
      x: route.xs[tightest],
      y: route.ys[tightest],
      s: tightest * route.ds,
      radius: bend > 1e-9 ? 1 / bend : Infinity,
      speed: speed[tightest],
    },
    jumps: racingJumpsOn(spec, route, tune).jumps,
  };
}

// -- checks ---------------------------------------------------------------------

/** Surfaces that make a grid slot a hazard. */
const RACING_GRID_HAZARDS = new Set([RACING_ICE, RACING_OIL, RACING_WATER, RACING_SAND, RACING_BOOST, RACING_RAMP, RACING_HOLE]);

/**
 * What can be seen wrong with a track without driving it, each located:
 * `{code, severity, message, x, y}`, and `list` and `index` when it is one
 * thing's fault. Errors stop a car; warnings are worth a look.
 *
 * - `fold` — a bend tighter than the road is wide: its inside kerb folds.
 * - `crowded` — two nodes almost on top of each other.
 * - `off-table` — the road runs past the world's edge.
 * - `no-ramp` — a hole across the racing line with no ramp before it.
 * - `short-jump` — a jump the car cannot carry the speed to clear.
 * - `pickup-unreachable`, `pickup-hole` — a pickup nobody can collect, or
 *   whoever collects it falls.
 * - `patch-unreachable` — a patch beyond a wall or a drop: no car will touch it.
 * - `grid` — a hazard or a prop where the cars line up, reported once as
 *   that patch's or prop's fault.
 *
 * @param {any} track
 */
export function racingTrackChecks(track) {
  const spec = normalizeRacingTrack(track);
  const route = buildRacingTrack(spec);
  const tune = racingTune(spec.car);
  const problems = [];
  const add = (problem) => problems.push(problem);

  // Bends that fold, one report per run, at its tightest.
  let worst = -1;
  const flushFold = () => {
    if (worst < 0) return;
    add({
      code: "fold", severity: "warning", x: route.xs[worst], y: route.ys[worst],
      message: "This bend is tighter than the road is wide: its inside kerb folds over itself.",
    });
    worst = -1;
  };
  for (let index = 0; index < route.count; index += 1) {
    const folds = Math.abs(route.curve[index]) * route.half[index] >= 1;
    if (folds && (worst < 0 || Math.abs(route.curve[index]) > Math.abs(route.curve[worst]))) worst = index;
    if (!folds) flushFold();
  }
  flushFold();

  const nodes = spec.route.nodes;
  const close = Math.max(8, spec.route.resolution);
  nodes.forEach((node, index) => {
    const next = nodes[(index + 1) % nodes.length];
    if (hypot(next.x - node.x, next.y - node.y) < close) {
      add({
        code: "crowded", severity: "warning", x: next.x, y: next.y, list: "nodes", index: (index + 1) % nodes.length,
        message: "Two nodes almost on top of each other: the road between them can kink.",
      });
    }
  });

  if (spec.bounds) {
    const { x0, y0, x1, y1, beyond } = route.bounds;
    const { roadLeft, roadRight } = route.edges;
    let inside = true;
    for (let index = 0; index < route.count; index += 1) {
      let out = -1;
      for (const edge of [roadLeft, roadRight]) {
        const x = edge[index * 2];
        const y = edge[index * 2 + 1];
        if (x < x0 || x > x1 || y < y0 || y > y1) out = index;
      }
      if (out >= 0 && inside) {
        add({
          code: "off-table", severity: beyond === "drop" ? "error" : "warning", x: route.xs[out], y: route.ys[out],
          message: beyond === "drop" ? "The road runs off the edge of the world: cars will fall." : "The road runs into the edge of the world.",
        });
      }
      inside = out < 0;
    }
  }

  // Holes on the racing line, and the jumps over them.
  const { jumps, holes, jumped } = racingJumpsOn(spec, route, tune);
  for (const jump of jumps) {
    if (!jump.clears) {
      add({
        code: "short-jump", severity: "error", x: jump.x, y: jump.y,
        message: jump.needs === null
          ? `No car can clear this gap: it needs a flight of ${Math.round(jump.gap)} px.`
          : `The car reaches this ramp at about ${Math.round(jump.reaches)} px/s, and the gap needs ${Math.round(jump.needs)}.`,
      });
    }
  }
  for (const [start] of holes) {
    if (jumped.has(start)) continue;
    const spot = racingPointAt(route, start * route.ds, route.line[start]);
    add({
      code: "no-ramp", severity: "error", x: spot.x, y: spot.y,
      message: "A hole across the racing line with no ramp before it: every car will fall in.",
    });
  }

  // Whether something reaching `reach` px from (x, y) is somewhere a car
  // can get to: not inside or beyond a wall or a drop, nor past the world's
  // edge. Open ground past the verge is still ground.
  const reachable = (x, y, reach) => {
    const edge = route.bounds;
    if (x + reach < edge.x0 || x - reach > edge.x1 || y + reach < edge.y0 || y - reach > edge.y1) return false;
    const near = racingNearestSample(route, x, y);
    const side = near.lateral > 0 ? route.edgeRight[near.index] : route.edgeLeft[near.index];
    return side === RACING_EDGE_OPEN || near.distance - reach <= route.half[near.index] + route.verge[near.index];
  };

  spec.pickups.forEach((pickup, index) => {
    const spot = route.pickups[index];
    if (!reachable(spot.x, spot.y, 0)) {
      add({
        code: "pickup-unreachable", severity: "warning", x: spot.x, y: spot.y, list: "pickups", index,
        message: "No car can reach this pickup: it is in a wall, or beyond a wall or a drop.",
      });
    } else if (racingSurfaceAt(route, spot.x, spot.y) === RACING_HOLE) {
      add({
        code: "pickup-hole", severity: "warning", x: spot.x, y: spot.y, list: "pickups", index,
        message: "This pickup is over a hole: whoever takes it falls.",
      });
    }
  });

  route.patches.forEach((patch, index) => {
    const reach = patch.circle ? patch.radius : hypot(patch.halfLength, patch.halfWidth);
    if (!reachable(patch.x, patch.y, reach)) {
      add({
        code: "patch-unreachable", severity: "warning", x: patch.x, y: patch.y, list: "patches", index,
        message: "No car can reach this patch: it is beyond a wall or a drop.",
      });
    }
  });

  // The grid, where the cars actually line up: a hazard or a prop under any
  // of them is reported once, as that thing's fault.
  const race = createRace(spec, { players: 1 });
  const hazards = new Set();
  const blockers = new Set();
  race.state.cars.forEach((car, index) => {
    const tune = race.tuneOf(index);
    for (const point of [{ x: car.x, y: car.y }, ...racingCarCorners(car, tune)]) {
      let top = -1;
      route.patches.forEach((patch, at) => {
        if (racingInPatch(patch, point.x, point.y)) top = at;
      });
      if (top >= 0 && RACING_GRID_HAZARDS.has(route.patches[top].surface)) hazards.add(top);
    }
    spec.props.forEach((prop, at) => {
      if (hypot(route.props[at].x - car.x, route.props[at].y - car.y) < prop.radius + tune.radius) blockers.add(at);
    });
  });
  for (const index of [...hazards].sort((a, b) => a - b)) {
    const patch = route.patches[index];
    add({
      code: "grid", severity: "warning", x: patch.x, y: patch.y, list: "patches", index,
      message: `${racingSurface(patch.surface).name[0].toUpperCase()}${racingSurface(patch.surface).name.slice(1)} on the starting grid: a car starts on it.`,
    });
  }
  for (const index of [...blockers].sort((a, b) => a - b)) {
    add({
      code: "grid", severity: "warning", x: route.props[index].x, y: route.props[index].y, list: "props", index,
      message: "A prop on the starting grid, where a car starts.",
    });
  }

  return problems;
}

/** The nearest sample of the centreline to (x, y), however far: every sample, looked at. */
function racingNearestSample(route, x, y) {
  let best = 0;
  let closest = Infinity;
  for (let index = 0; index < route.count; index += 1) {
    const dx = x - route.xs[index];
    const dy = y - route.ys[index];
    const d = dx * dx + dy * dy;
    if (d < closest) {
      closest = d;
      best = index;
    }
  }
  const dx = x - route.xs[best];
  const dy = y - route.ys[best];
  return { index: best, distance: Math.sqrt(closest), lateral: -dx * route.tys[best] + dy * route.txs[best] };
}

/** Whether (x, y) is on a built patch. */
function racingInPatch(patch, x, y) {
  const dx = x - patch.x;
  const dy = y - patch.y;
  if (patch.circle) return dx * dx + dy * dy <= patch.radius * patch.radius;
  const along = dx * patch.dirX + dy * patch.dirY;
  const across = -dx * patch.dirY + dy * patch.dirX;
  return along >= -patch.halfLength && along <= patch.halfLength && across >= -patch.halfWidth && across <= patch.halfWidth;
}

/** Merge reports of one kind within `radius` px into one, counting them. */
function racingCluster(reports, radius) {
  const out = [];
  for (const report of reports) {
    const same = out.find((seen) => seen.code === report.code && hypot(seen.x - report.x, seen.y - report.y) < radius);
    if (same) same.count += 1;
    else out.push({ ...report, count: 1 });
  }
  return out;
}

/**
 * **Check track**: the suite's reference driver as a button. Races the whole
 * field headless for `laps` laps — weapons off and no catch-up, so what it
 * finds is the track's doing — and marks every place a car fell, stuck or hit
 * a wall hard, merged by place and counted; then adds the static checks.
 * Answers the question every track author has: can this be driven?
 *
 * @param {any} track
 * @param {{laps?: number, seconds?: number}} [options] `seconds` caps the run;
 *        by default, three times the estimated race and half a minute more.
 * @returns {{finished: boolean, laps: number[], time: number, problems: any[]}}
 */
export function checkRacingTrack(track, options = {}) {
  const spec = normalizeRacingTrack(track);
  const laps = Math.max(1, Math.min(9, Math.round(Number(options.laps ?? 2)) || 2));
  const race = createRace(spec, {
    players: 1,
    rules: { mode: "race", laps, weapons: false, catchup: 0, countdown: 0, timeLimit: 0 },
  });
  const estimate = racingLapSeconds(race.route, racingSpeedProfile(race.route, race.tuneOf(0), 1));
  const seconds = Number(options.seconds) > 0 ? Number(options.seconds) : estimate * laps * 3 + 30;
  const reports = [];
  const lapTimes = [];
  const cars = race.state.cars;
  for (let tick = 0; tick < seconds * 60; tick += 1) {
    race.step(1 / 60, [racingDriverInput(race, 0)]);
    for (const event of race.drainEvents()) {
      if (event.type === "fall" && event.reason !== "reset") {
        reports.push({ code: "fall", severity: "error", x: event.x, y: event.y, message: event.reason === "hole" ? "A car fell here." : "A car left the track here." });
      } else if (event.type === "wall" && event.impact > 200) {
        reports.push({ code: "wall", severity: "warning", x: event.x, y: event.y, message: "A car hit the wall hard here." });
      } else if (event.type === "lap" && event.index === 0) {
        lapTimes.push(event.time);
      }
    }
    for (const car of cars) {
      if (car.stuck === RACING_STUCK_TICKS) {
        reports.push({ code: "stuck", severity: "error", x: car.x, y: car.y, message: "A car got stuck here." });
      }
    }
    if (cars.every((car) => car.finished)) break;
  }
  const reference = cars[0];
  const problems = racingCluster(reports, 48);
  if (!reference.finished) {
    problems.unshift({
      code: "unfinished", severity: "error", x: reference.x, y: reference.y, count: 1,
      message: `The reference driver did not finish ${laps} laps in ${Math.round(seconds)} s: it was here.`,
    });
  }
  return { finished: reference.finished, laps: lapTimes, time: race.state.time, problems: [...problems, ...racingTrackChecks(spec)] };
}

