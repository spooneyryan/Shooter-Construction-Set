// What a track is made of.
//
// Everything here is what a game *says*, and nothing here changes while a
// race is running — the split every genre module in this package states at
// its top, and for the same reason: the world reads it and never writes to
// it, so one authored track can be raced, replayed or rewound without being
// copied first.
//
// **The format's centre is that a track is a route, not a picture.** One
// closed centreline, with a width at every node, is the only geometry an
// author has to draw, and everything a racing game needs falls out of it:
//
//   - what the car is standing on: road inside the width, a verge beside
//     it, and past the verge a wall, a drop or open ground, per side;
//   - where the car is in the race: distance along the loop, which is laps,
//     positions, split times and the start grid;
//   - where a car goes back to after it falls off the table;
//   - where the computer's cars drive, and how fast they take each bend.
//
// A tile grid was the other candidate, and it is what both games this pack
// is modelled on actually shipped with. It loses on everything but nostalgia:
// a grid says nothing about progress, so laps, positions and the AI's line
// all need a second authored path laid over it that has to agree with the
// tiles forever; a wall made of tiles has a normal that points at a
// staircase, and a car glancing off a curved barrier is the one collision a
// racing game is made of; and a painted grid is tens of thousands of cells
// where a route is a few dozen points, which is the difference between a
// track that fits in a share link and one that does not.
//
// The simulation is flat — top-down, `+y` down like everything here — with a
// height channel for ramps. RC Pro-Am's three-quarter view and Micro
// Machines' overhead one are both presentation of the same state, which is
// the same answer `wheels` gave to "raster or vector".
//
// Names carry a `RACING_`/`Racing` prefix, the convention `topdown` settled
// on, which is also what keeps this module concatenation-safe beside its
// siblings; see tests/flat-scope.test.mjs.

import { asBoolean, boundedInteger, boundedNumber, boundedString, hexColor, oneOf } from "../core/validate.js";
import { normalizeAssets } from "../sprite/assets.js";
import { normalizeSfx } from "../sfx/synth.js";

/**
 * 2 added what an editor needs: stable node ids and placement anchored to a
 * node, and the track's own look — a theme, decorations, sprites, sounds and
 * music — which the simulation never reads. A version 1 track is a legal
 * version 2 track as it stands: every field it had means what it meant, so
 * it needs no migration and moves nothing.
 */
export const RACING_VERSION = 2;

// -- surfaces -----------------------------------------------------------

// A surface code is what a wheel is standing on. The route decides the road
// and the verge, a patch laid over it decides everything else, and the
// solver reads the numbers below — so a puddle, an oil slick, a zipper and a
// hole in the table are one mechanism and not four.

/** Grip. The default road. */
export const RACING_TARMAC = 0;
/** The verge and the infield: holds you, slows you hard. */
export const RACING_GRASS = 1;
/** A loose road: less grip, some drag. */
export const RACING_DIRT = 2;
/** Almost no grip. The car goes where it was already going. */
export const RACING_ICE = 3;
/** Less grip than ice, and entering it at speed spins the car out. */
export const RACING_OIL = 4;
/** A puddle: grips, but drags harder than anything else. */
export const RACING_WATER = 5;
/** Soft ground: grips, drags. */
export const RACING_SAND = 6;
/** A zipper: free acceleration along the patch's own direction. */
export const RACING_BOOST = 7;
/** A ramp: crossing it along its direction launches the car. */
export const RACING_RAMP = 8;
/** Nothing underneath. A grounded car whose centre is over it falls. */
export const RACING_HOLE = 9;

/**
 * What each surface does to a car, as plain numbers the solver reads.
 *
 * `grip` multiplies the tyres' friction limit. `drag` is speed damping per
 * second — so on a surface whose drag is `k`, a car with engine `power` and
 * `topSpeed` can reach roughly `power / (power / topSpeed + k)`, which is how
 * grass halves a lap's pace without anything in the code called "offroad".
 * `boost` is an acceleration in px/s² along the patch, the same units as a
 * car's `power`, so a zipper can be read against an engine without knowing
 * what either weighs. `launch` is the fraction of the speed along a ramp that
 * becomes vertical speed.
 */
export const RACING_SURFACES = Object.freeze({
  [RACING_TARMAC]: { name: "tarmac", grip: 1, drag: 0.12, boost: 0, launch: 0, spin: false, hole: false },
  [RACING_GRASS]: { name: "grass", grip: 0.62, drag: 1.7, boost: 0, launch: 0, spin: false, hole: false },
  [RACING_DIRT]: { name: "dirt", grip: 0.8, drag: 0.4, boost: 0, launch: 0, spin: false, hole: false },
  [RACING_ICE]: { name: "ice", grip: 0.16, drag: 0.05, boost: 0, launch: 0, spin: false, hole: false },
  [RACING_OIL]: { name: "oil", grip: 0.08, drag: 0.12, boost: 0, launch: 0, spin: true, hole: false },
  [RACING_WATER]: { name: "water", grip: 0.55, drag: 2.6, boost: 0, launch: 0, spin: false, hole: false },
  [RACING_SAND]: { name: "sand", grip: 0.7, drag: 1.3, boost: 0, launch: 0, spin: false, hole: false },
  [RACING_BOOST]: { name: "boost", grip: 1.05, drag: 0.1, boost: 1500, launch: 0, spin: false, hole: false },
  [RACING_RAMP]: { name: "ramp", grip: 1, drag: 0.12, boost: 0, launch: 0.5, spin: false, hole: false },
  [RACING_HOLE]: { name: "hole", grip: 0, drag: 0, boost: 0, launch: 0, spin: false, hole: true },
});

const RACING_SURFACE_CODES = [
  RACING_TARMAC, RACING_GRASS, RACING_DIRT, RACING_ICE, RACING_OIL,
  RACING_WATER, RACING_SAND, RACING_BOOST, RACING_RAMP, RACING_HOLE,
];

/** The numbers for a surface code, never undefined. */
export function racingSurface(code) {
  return RACING_SURFACES[code] ?? RACING_SURFACES[RACING_TARMAC];
}

// -- input --------------------------------------------------------------

/**
 * One seat's frame of intent: two analogue channels and four buttons.
 *
 * `drive.x` is the pedal axis — throttle above zero, brake below it, and
 * reverse once the car has stopped, which is what "back" on a stick means in
 * every racing game. `steer.x` is the wheel. With a seat whose steering is
 * `"point"` the whole `steer` vector is read instead, as the direction the
 * player wants the car to face, and the simulation turns the wheel for them
 * — the scheme a touch stick and a thumbstick want, decided inside the step
 * so that a rollback re-steers against the corrected heading rather than the
 * one the player happened to see.
 *
 * Both channels go through `core/stick` at the edge, so a keyboard and a
 * gamepad arrive here as the same shape.
 *
 * @typedef {object} RacingInput
 * @property {{x: number, y: number}} steer
 * @property {{x: number, y: number}} drive
 * @property {boolean} fire Forward weapon: a missile, if one is held.
 * @property {boolean} drop Rear weapon: a bomb left on the road.
 * @property {boolean} handbrake Locks the rear axle. The drift button.
 * @property {boolean} reset Back onto the route, at the price of a fall.
 */

/** The action names, in wire order — append-only, the `net/input-log` rule. */
export const RACING_ACTIONS = Object.freeze(["fire", "drop", "handbrake", "reset"]);

/** The analogue channels, in wire order. Same append-only rule. */
export const RACING_STICKS = Object.freeze(["steer", "drive"]);

/** @returns {RacingInput} Nothing held, both channels centred. */
export function neutralRacingInput() {
  return {
    steer: { x: 0, y: 0 },
    drive: { x: 0, y: 0 },
    fire: false,
    drop: false,
    handbrake: false,
    reset: false,
  };
}

/** How a seat's `steer` channel is read. See `RacingInput`. */
export const RACING_STEERING = Object.freeze(["rotate", "point"]);

// -- feel ---------------------------------------------------------------

/**
 * The world's physics, as opposed to the car's.
 *
 * `substeps` is the one number that is not taste. The solver is explicit and
 * its walls are bands of finite thickness, so the rule is that nothing may
 * cross half a band in one integration: at `maxSpeed` 1,400 and four
 * substeps a car moves under six pixels per substep, against a band sixteen
 * wide at its thinnest. It is fixed rather than adaptive because an adaptive
 * count is a different simulation on a slower machine.
 *
 * `gravity` only pulls on height — the track is flat — so it decides how long
 * a ramp jump hangs and nothing else.
 */
export const RACING_FEEL_PRESETS = Object.freeze({
  stadium: {
    substeps: 4, gravity: 900, maxSpeed: 1400, maxYaw: 14,
    wallBounce: 0.3, wallFriction: 0.2, carBounce: 0.35,
    spinTicks: 54, fallTicks: 50, respawnGrace: 75, turboTicks: 90,
    cameraAhead: 0.3, cameraEase: 6, wrongWayTicks: 50,
  },
  tabletop: {
    substeps: 4, gravity: 1000, maxSpeed: 1400, maxYaw: 16,
    wallBounce: 0.45, wallFriction: 0.15, carBounce: 0.55,
    spinTicks: 54, fallTicks: 60, respawnGrace: 75, turboTicks: 90,
    cameraAhead: 0.35, cameraEase: 5, wrongWayTicks: 50,
  },
});

/**
 * `[min, max]` for every number in a feel — what the normalizer clamps to,
 * exported so an editor's panel reads the same numbers (`RACING_FEEL_FIELDS`)
 * rather than a copy that drifts. Frozen, all the way down.
 */
export const RACING_FEEL_RANGES = racingFrozenRanges({
  substeps: [1, 16], gravity: [0, 20000], maxSpeed: [50, 8000], maxYaw: [1, 200],
  wallBounce: [0, 1], wallFriction: [0, 2], carBounce: [0, 1],
  spinTicks: [0, 600], fallTicks: [1, 600], respawnGrace: [0, 600], turboTicks: [0, 1200],
  cameraAhead: [0, 5], cameraEase: [0.5, 60], wrongWayTicks: [1, 600],
});

/** The feel's whole numbers: counts of substeps and ticks. */
export const RACING_FEEL_INTEGERS = Object.freeze(["substeps", "spinTicks", "fallTicks", "respawnGrace", "turboTicks", "wrongWayTicks"]);

/**
 * @param {Record<string, [number, number]>} table
 * @returns {Readonly<Record<string, readonly [number, number]>>}
 */
function racingFrozenRanges(table) {
  for (const range of Object.values(table)) Object.freeze(range);
  return Object.freeze(table);
}

/**
 * @param {any} [input] A preset name, a full feel, or a preset name in
 *        `preset` with overrides beside it.
 * @param {string} [preset] The fallback preset.
 */
export function normalizeRacingFeel(input, preset = "stadium") {
  const raw = typeof input === "string" ? { preset: input } : (input && typeof input === "object" ? input : {});
  const presetName = oneOf(raw.preset, Object.keys(RACING_FEEL_PRESETS), preset);
  const base = RACING_FEEL_PRESETS[presetName] ?? RACING_FEEL_PRESETS.stadium;
  const feel = { preset: presetName };
  for (const [name, fallback] of Object.entries(base)) {
    const [low, high] = RACING_FEEL_RANGES[name];
    feel[name] = RACING_FEEL_INTEGERS.includes(name)
      ? boundedInteger(raw[name], fallback, low, high)
      : boundedNumber(raw[name], fallback, low, high);
  }
  return feel;
}

// -- the car ------------------------------------------------------------

/**
 * Two cars, and they are the two games. Neither is a mode: the same solver
 * reads both, and everything that separates an RC truck from a toy car on a
 * breakfast table is in these numbers.
 *
 * **Every driver number is an acceleration or a speed, never a force.**
 * `power` is px/s² at a standstill, fading to nothing at `topSpeed`, which is
 * how an electric motor behaves and why the pace comes in a curve rather than
 * a line; `braking` is px/s². `grip` is the most sideways acceleration one
 * axle can hold on tarmac — the cornering limit, in the units a designer can
 * check against a bend: a car at speed `v` round a radius `r` needs `v²/r`,
 * and past `grip` it slides. `cornering` is how steeply the tyre's force
 * builds with slip: at `cornering` 8 it saturates at a slip of an eighth,
 * about seven degrees. This is `wheels`' lesson carried across — forces are
 * unauthorable, because every one of them has to be compared against a mass
 * the author never chose.
 *
 * `rearGrip` below one is a loose tail; `handbrake` multiplies the rear's
 * grip while the button is held; `drive` is the front axle's share of the
 * engine, so a rear-drive truck is 0 and power oversteer is the friction
 * circle doing its job rather than a special case. `steer` is degrees of
 * front-wheel lock, which fades with speed at `steerFade`, the speed where
 * the lock has halved.
 *
 * The body is a capsule for collisions — two discs of the car's width along
 * its length — which is the shape that lets a car be clipped on the rear
 * quarter and spin, and is cheap enough that four cars and a dozen props
 * collide every substep.
 */
export const RACING_CAR_PRESETS = Object.freeze({
  truck: {
    name: "RC truck",
    length: 26, width: 15, wheelbase: 17, balance: 0.46, mass: 1,
    power: 820, topSpeed: 470, braking: 1150, reverse: 0.45, drive: 0,
    steer: 30, steerRate: 360, steerFade: 700,
    grip: 800, rearGrip: 1, cornering: 8, handbrake: 0.45, transfer: 0.12,
    inertia: 1, drag: 0.0002, bounce: 0.3,
  },
  micro: {
    name: "Micro racer",
    length: 16, width: 9, wheelbase: 10, balance: 0.5, mass: 0.6,
    power: 700, topSpeed: 360, braking: 950, reverse: 0.5, drive: 0,
    steer: 32, steerRate: 380, steerFade: 620,
    grip: 750, rearGrip: 0.9, cornering: 7, handbrake: 0.45, transfer: 0.1,
    inertia: 1, drag: 0.0003, bounce: 0.35,
  },
});

/** `[min, max]` for every number in a car; see `RACING_FEEL_RANGES`. */
export const RACING_CAR_RANGES = racingFrozenRanges({
  length: [4, 400], width: [2, 200], wheelbase: [1, 400], balance: [0.1, 0.9], mass: [0.05, 100],
  power: [0, 20000], topSpeed: [10, 8000], braking: [0, 40000], reverse: [0, 1], drive: [0, 1],
  steer: [0, 80], steerRate: [1, 5000], steerFade: [1, 20000],
  grip: [1, 40000], rearGrip: [0.05, 4], cornering: [0.5, 100], handbrake: [0, 1], transfer: [0, 1],
  inertia: [0.1, 10], drag: [0, 0.05], bounce: [0, 1],
});

/**
 * @param {any} [input] A preset name, a full definition, or a preset name
 *        in `preset` with overrides beside it.
 * @param {string} [preset] The preset used when `input` names none.
 */
export function normalizeRacingCar(input = {}, preset = "truck") {
  const raw = typeof input === "string" ? { preset: input } : (input && typeof input === "object" ? input : {});
  const presetName = oneOf(raw.preset, Object.keys(RACING_CAR_PRESETS), oneOf(preset, Object.keys(RACING_CAR_PRESETS), "truck"));
  const base = RACING_CAR_PRESETS[presetName];
  const car = { preset: presetName, name: boundedString(raw.name, base.name, 60) };
  for (const [field, fallback] of Object.entries(base)) {
    if (field === "name") continue;
    const [low, high] = RACING_CAR_RANGES[field];
    car[field] = boundedNumber(raw[field], fallback, low, high);
  }
  // A capsule needs its length to be at least its width, or its two discs
  // swap ends; a wheelbase longer than the body puts an axle in mid-air.
  if (car.length < car.width) car.length = car.width;
  if (car.wheelbase > car.length) car.wheelbase = car.length;
  // How it looks, which the solver never reads: a colour for a car drawn as
  // a shape, and a sprite for one drawn from art — see `normalizeRacingTrack`
  // for how a renderer resolves one.
  car.livery = hexColor(raw.livery, presetName === "micro" ? "#4fa3ff" : "#ff5a4f");
  car.sprite = boundedString(raw.sprite, "", 60);
  return car;
}

// -- the route ----------------------------------------------------------

/**
 * What lies past the verge on one side of the road.
 *
 * - `wall` — a barrier. Cars glance off it and cannot pass, whatever they
 *   are doing; a ramp does not clear it.
 * - `drop` — the ground ends. A grounded car whose centre goes over falls.
 * - `open` — more of the offroad surface. Micro Machines' tables are open:
 *   you may leave the route, and the table's edge is what punishes it.
 *
 * Both `wall` and `drop` are bands of finite width rather than half-planes,
 * with ordinary ground beyond, so two stretches of road may sit close
 * without their barriers claiming each other's tarmac.
 */
export const RACING_EDGES = Object.freeze(["open", "wall", "drop"]);

/**
 * A route node's `edge`: one kind for both sides, or `{left, right}`.
 * @param {any} raw
 * @param {{left: string, right: string}} fallback
 */
function racingEdgePair(raw, fallback) {
  if (typeof raw === "string") {
    const kind = oneOf(raw, [...RACING_EDGES], fallback.left);
    return { left: kind, right: kind };
  }
  if (raw && typeof raw === "object") {
    return {
      left: oneOf(raw.left, [...RACING_EDGES], fallback.left),
      right: oneOf(raw.right, [...RACING_EDGES], fallback.right),
    };
  }
  return { left: fallback.left, right: fallback.right };
}

/**
 * One point the centreline passes through.
 *
 * `width` is the whole road, kerb to kerb; `verge` is the strip of offroad
 * surface on each side before the edge. Both are interpolated between
 * nodes, eased, so a road that narrows does so as a curve. `edge` and
 * `surface` belong to the stretch that STARTS at this node and runs to the
 * next — a property of the road you are on, the way `wheels` gives a
 * surface to a span rather than a point.
 * 
 * @param {any} [input]
 * @param {any} [defaults] The route's own width, verge, edges and surface.
 */
export function normalizeRacingNode(input = {}, defaults = {}) {
  const raw = input && typeof input === "object" ? input : {};
  // A normalized node spells its edges out as two fields; accept that shape
  // too, or normalizing a track twice would quietly reset every edge.
  const spelled = raw.edgeLeft !== undefined || raw.edgeRight !== undefined
    ? { left: raw.edgeLeft, right: raw.edgeRight }
    : undefined;
  const edge = racingEdgePair(raw.edge ?? spelled, { left: defaults.edgeLeft ?? "wall", right: defaults.edgeRight ?? "wall" });
  return {
    /** Stable across edits; what a placement anchored to this node names. */
    id: typeof raw.id === "string" && RACING_NODE_ID.test(raw.id) ? raw.id : "",
    x: boundedNumber(raw.x, 0, -100000, 100000),
    y: boundedNumber(raw.y, 0, -100000, 100000),
    width: boundedNumber(raw.width, defaults.width ?? 90, 8, 2000),
    verge: boundedNumber(raw.verge, defaults.verge ?? 16, 0, 2000),
    edgeLeft: edge.left,
    edgeRight: edge.right,
    surface: oneOf(raw.surface, RACING_SURFACE_CODES, defaults.surface ?? RACING_TARMAC),
  };
}

/** What a node id may look like: short, and safe in a URL and a selector. */
const RACING_NODE_ID = /^[A-Za-z0-9_-]{1,24}$/;

/**
 * Give every node an id, keeping the ones it has.
 *
 * An id is what lets a puddle say "forty pixels after this node" and still
 * mean the same place after the node before it moved, so it has to survive
 * every edit — which rules out the node's index, the one thing an insert
 * changes. The first node to claim an id keeps it; a missing or repeated
 * one is filled from the node's index, bumped past anything already taken.
 * Nothing here is random, so a document normalizes to the same ids on every
 * machine and a second time on the same one.
 */
function racingNodeIds(nodes) {
  const used = new Set();
  for (const node of nodes) {
    if (node.id && !used.has(node.id)) used.add(node.id);
    else node.id = "";
  }
  nodes.forEach((node, index) => {
    if (node.id) return;
    let candidate = `n${index}`;
    for (let bump = 1; used.has(candidate); bump += 1) candidate = `n${index}-${bump}`;
    node.id = candidate;
    used.add(candidate);
  });
  return nodes;
}

/** A small oval, for a route that has too few nodes to be a loop. */
function racingDefaultNodes() {
  return [
    { x: 200, y: 200 }, { x: 800, y: 200 }, { x: 1000, y: 400 },
    { x: 800, y: 600 }, { x: 200, y: 600 }, { x: 0, y: 400 },
  ];
}

/**
 * The route: a closed loop through `nodes`, drawn as a smooth curve.
 *
 * The curve is a centripetal Catmull-Rom spline, which passes through every
 * node, cannot overshoot into a cusp or a knot however unevenly the nodes
 * are spaced, and is `+ - * /` and `Math.sqrt` from end to end — all of which
 * the specification pins down exactly, so two machines build the same road.
 *
 * `resolution` is the distance between samples of the built line, in
 * pixels. The start and finish line is node 0, and the race runs in node
 * order.
 * 
 * @param {any} [input]
 * @param {string} [defaultEdge] The flavour's default edge.
 */
export function normalizeRacingRoute(input = {}, defaultEdge = "wall") {
  const raw = input && typeof input === "object" ? input : {};
  const fallbackEdge = oneOf(defaultEdge, [...RACING_EDGES], "wall");
  const edge = racingEdgePair(raw.edge, { left: fallbackEdge, right: fallbackEdge });
  const defaults = {
    width: boundedNumber(raw.width, 90, 8, 2000),
    verge: boundedNumber(raw.verge, 16, 0, 2000),
    edgeLeft: edge.left,
    edgeRight: edge.right,
    surface: oneOf(raw.surface, RACING_SURFACE_CODES, RACING_TARMAC),
  };
  let nodes = (Array.isArray(raw.nodes) ? raw.nodes : []).slice(0, 512).map((node) => normalizeRacingNode(node, defaults));
  // Fewer than three nodes is a line, not a loop, and three nodes piled on
  // one spot is not a loop either. Give either an oval rather than refuse
  // the track: the editor that produced it is mid-thought.
  let perimeter = 0;
  for (let index = 0; index < nodes.length; index += 1) {
    const next = nodes[(index + 1) % nodes.length];
    const dx = next.x - nodes[index].x;
    const dy = next.y - nodes[index].y;
    perimeter += Math.sqrt(dx * dx + dy * dy);
  }
  if (nodes.length < 3 || perimeter < 60) nodes = racingDefaultNodes().map((node) => normalizeRacingNode(node, defaults));
  racingNodeIds(nodes);
  return {
    resolution: boundedNumber(raw.resolution, 12, 2, 200),
    width: defaults.width,
    verge: defaults.verge,
    edge: { left: defaults.edgeLeft, right: defaults.edgeRight },
    surface: defaults.surface,
    /** How thick a wall or a drop is, measured out from the verge. */
    band: boundedNumber(raw.band, 32, 16, 2000),
    nodes,
  };
}

// -- things laid on the track --------------------------------------------

/**
 * Where something sits. Three ways, in the order an editor should reach for
 * them:
 *
 * - **Anchored to a node** — `node` is a node's id, `along` the distance
 *   past it along the route (negative is before it), `offset` the distance
 *   to the right of the centreline in the direction of travel. Moving a node
 *   disturbs only the things anchored near it.
 * - **A fraction of the lap** — `at` from the start line, with `offset`.
 *   Right for a track written by hand, and wrong for one being edited: a
 *   fraction of a longer lap is somewhere else, so lengthening one straight
 *   moved pickups on the far side of the stadium 6–18 px where the road had
 *   not moved at all (measured, docs/RACER-CONSTRUCTION-SET.md, G1).
 * - **In the world** — a plain `x, y`, for things that belong to the
 *   scenery rather than the road: the sugar bowl, not the spill beside it.
 *
 * A node id that names no node is repaired to the first node rather than
 * refused, the stance of every normalizer here.
 *
 * @param {any} raw
 * @param {string[]} [nodeIds] The route's node ids, for anchored placement.
 * @returns {{node: string, along: number, offset: number} | {at: number, offset: number} | {x: number, y: number}}
 */
function racingPlacement(raw, nodeIds = []) {
  if (typeof raw.node === "string" && raw.node !== "" && nodeIds.length > 0) {
    return {
      node: nodeIds.includes(raw.node) ? raw.node : nodeIds[0],
      along: boundedNumber(raw.along, 0, -200000, 200000),
      offset: boundedNumber(raw.offset, 0, -20000, 20000),
    };
  }
  const along = typeof raw.at === "string" && raw.at.trim() !== "" ? Number(raw.at) : raw.at;
  if (typeof along === "number" && Number.isFinite(along)) {
    const at = boundedNumber(along, 0, -1000, 1000);
    return {
      at: at - Math.floor(at),
      offset: boundedNumber(raw.offset, 0, -20000, 20000),
    };
  }
  return {
    x: boundedNumber(raw.x, 0, -100000, 100000),
    y: boundedNumber(raw.y, 0, -100000, 100000),
  };
}

/** The shapes a patch can take. */
export const RACING_PATCH_SHAPES = Object.freeze(["circle", "rect"]);

/**
 * A patch of different ground: a puddle, an oil slick, a zipper, a ramp, a
 * hole. Later patches are laid over earlier ones.
 *
 * A patch has a direction, which only a zipper and a ramp read: along the
 * route for a route-placed patch, turned by `angle` (degrees) from there,
 * and plain `angle` from east for a world-placed one. A `rect`'s `length`
 * runs along that direction and its `width` across it.
 * 
 * @param {any} [input]
 * @param {number} [index] Its place in the list, for a default id.
 * @param {string[]} [nodeIds] The route's node ids, for anchored placement.
 */
export function normalizeRacingPatch(input = {}, index = 0, nodeIds = []) {
  const raw = input && typeof input === "object" ? input : {};
  const shape = oneOf(raw.shape, [...RACING_PATCH_SHAPES], raw.radius !== undefined ? "circle" : "rect");
  const surface = oneOf(raw.surface, RACING_SURFACE_CODES, RACING_WATER);
  /** @type {any} */
  const patch = {
    id: boundedString(raw.id, `patch-${index}`, 60),
    ...racingPlacement(raw, nodeIds),
    shape,
    surface,
    angle: boundedNumber(raw.angle, 0, -3600, 3600),
  };
  if (shape === "circle") patch.radius = boundedNumber(raw.radius, 30, 1, 4000);
  else {
    patch.length = boundedNumber(raw.length, 40, 1, 8000);
    patch.width = boundedNumber(raw.width, 40, 1, 8000);
  }
  return patch;
}

/** What can be picked up. */
export const RACING_PICKUP_KINDS = Object.freeze(["missile", "bomb", "turbo", "bonus", "upgrade"]);

/** Which of a car's numbers an `upgrade` pickup improves. */
export const RACING_UPGRADE_STATS = Object.freeze(["power", "topSpeed", "grip"]);

/**
 * A pickup: collected by driving over it, and back after `respawn` seconds
 * so a later lap finds it again (zero: once per race).
 *
 * `missile` and `bomb` add `amount` rounds; `turbo` fires the car's boost at
 * once for `amount` seconds; `bonus` is `amount` points; `upgrade` raises
 * one of the car's numbers by `amount` as a fraction, for the rest of the
 * race — RC Pro-Am's engine, tyre and speed pickups, which is also the
 * thing a championship carries from one race to the next by building the
 * next race's car from them.
 * 
 * @param {any} [input]
 * @param {number} [index]
 * @param {string[]} [nodeIds]
 */
export function normalizeRacingPickup(input = {}, index = 0, nodeIds = []) {
  const raw = input && typeof input === "object" ? input : {};
  const kind = oneOf(raw.kind, [...RACING_PICKUP_KINDS], "bonus");
  const defaults = { missile: 2, bomb: 2, turbo: 1.5, bonus: 100, upgrade: 0.1 };
  return {
    id: boundedString(raw.id, `pickup-${index}`, 60),
    kind,
    ...racingPlacement(raw, nodeIds),
    amount: boundedNumber(raw.amount, defaults[kind], 0, 100000),
    stat: oneOf(raw.stat, [...RACING_UPGRADE_STATS], "power"),
    respawn: boundedNumber(raw.respawn, kind === "upgrade" ? 0 : 8, 0, 600),
    /** A letter or a label for the renderer; the simulation never reads it. */
    label: boundedString(raw.label, "", 12),
  };
}

/**
 * A prop: a solid disc on the track. Mass zero never moves — a tyre stack, a
 * juice glass. Anything heavier is pushed, rolls and slows: the cones on a
 * chicane, the cereal on a breakfast table. `tall` is how high it stands, so
 * a car in the air clears a cone and not a glass.
 * 
 * @param {any} [input]
 * @param {number} [index]
 * @param {string[]} [nodeIds]
 */
export function normalizeRacingProp(input = {}, index = 0, nodeIds = []) {
  const raw = input && typeof input === "object" ? input : {};
  return {
    id: boundedString(raw.id, `prop-${index}`, 60),
    kind: boundedString(raw.kind, "block", 24),
    ...racingPlacement(raw, nodeIds),
    radius: boundedNumber(raw.radius, 10, 1, 2000),
    mass: boundedNumber(raw.mass, 0, 0, 1000),
    tall: boundedNumber(raw.tall, 20, 0, 4000),
    bounce: boundedNumber(raw.bounce, 0.4, 0, 1),
    /** Rolling resistance of a pushable prop, per second. */
    drag: boundedNumber(raw.drag, 2.5, 0, 60),
    /** Drawn from this sprite in the track's `assets`, when it names one. */
    sprite: boundedString(raw.sprite, "", 60),
  };
}

/** Where a decoration is drawn: beneath the cars, or over them. */
export const RACING_DECOR_LAYERS = Object.freeze(["under", "over"]);

/**
 * A decoration: scenery the simulation never reads. The grandstand, the
 * cereal box art, the lines painted on a car park — anything that should be
 * seen and never hit, which is exactly the thing a prop is not. A circle or a
 * rectangle with a colour, or a sprite; placed the way everything else is;
 * drawn `under` the cars or `over` them. `tall` is how high it stands,
 * which only a three-quarter view uses.
 *
 * @param {any} [input]
 * @param {number} [index]
 * @param {string[]} [nodeIds]
 */
export function normalizeRacingDecor(input = {}, index = 0, nodeIds = []) {
  const raw = input && typeof input === "object" ? input : {};
  const shape = oneOf(raw.shape, [...RACING_PATCH_SHAPES], raw.radius !== undefined ? "circle" : "rect");
  /** @type {any} */
  const decor = {
    id: boundedString(raw.id, `decor-${index}`, 60),
    kind: boundedString(raw.kind, "scenery", 24),
    ...racingPlacement(raw, nodeIds),
    shape,
    angle: boundedNumber(raw.angle, 0, -3600, 3600),
    layer: oneOf(raw.layer, [...RACING_DECOR_LAYERS], "under"),
    color: hexColor(raw.color, "#8a8f98"),
    sprite: boundedString(raw.sprite, "", 60),
    tall: boundedNumber(raw.tall, 0, 0, 4000),
  };
  if (shape === "circle") decor.radius = boundedNumber(raw.radius, 20, 1, 8000);
  else {
    decor.length = boundedNumber(raw.length, 40, 1, 20000);
    decor.width = boundedNumber(raw.width, 40, 1, 20000);
  }
  return decor;
}

/** The field's liveries, in grid order, none of them either player's. */
const RACING_FIELD_LIVERIES = ["#ffd23f", "#57d17a", "#b86bff", "#ff8c3a", "#3fd6e0", "#ff6fb5", "#c8c8c8"];

/**
 * A computer driver in the field.
 *
 * `skill` scales how hard it drives each bend, `line` shifts its racing line
 * to the right by that many pixels so four cars do not queue on one, and
 * `aggression` is how readily it uses what it is carrying. None of these is
 * randomness: the field is deterministic, which is what lets two machines
 * race it together.
 * 
 * @param {any} [input]
 * @param {number} [index]
 * @param {string} [carPreset] The flavour's car, for a driver that names none.
 */
export function normalizeRacingDriver(input = {}, index = 0, carPreset = "truck") {
  const raw = input && typeof input === "object" ? input : {};
  const car = normalizeRacingCar(raw.car ?? {}, carPreset);
  // A field of one colour is a field nobody can follow, so a driver whose
  // car names no livery gets the next of the field's own.
  car.livery = hexColor(raw.car?.livery, RACING_FIELD_LIVERIES[index % RACING_FIELD_LIVERIES.length]);
  return {
    name: boundedString(raw.name, `CPU ${index + 1}`, 40),
    car,
    skill: boundedNumber(raw.skill, 0.85, 0, 1),
    line: boundedNumber(raw.line, 0, -2000, 2000),
    aggression: boundedNumber(raw.aggression, 0.5, 0, 1),
  };
}

// -- the look ------------------------------------------------------------

/** How a track is drawn by default. The same state either way. */
export const RACING_VIEWS = Object.freeze(["overhead", "three-quarter"]);

/**
 * The two flavours' default looks: a colour per surface code, in code order,
 * and the chrome round them. The site demo's palettes, promoted — surfaces
 * are identity, so ice reads as ice whatever the theme is doing.
 */
const RACING_LOOK_DEFAULTS = {
  circuit: {
    view: "three-quarter",
    background: "#233520",
    surfaces: ["#4b4f5c", "#3d6e37", "#8a6440", "#cfefff", "#111116", "#3a70c4", "#c9a76a", "#58d27a", "#e9b949", "#060608"],
    wall: "#c8423a",
    kerb: "#e9e9e9",
  },
  tabletop: {
    view: "overhead",
    background: "#07070a",
    surfaces: ["#e2d2ad", "#3d6e37", "#a8764a", "#f5fbff", "#111116", "#3a70c4", "#8e2230", "#58d27a", "#c9c3b5", "#07070a"],
    wall: "#6b4a2e",
    kerb: "#fff6de",
  },
};

/**
 * How a track looks, which the simulation never reads. It lives in the track
 * rather than beside it so that a shared track arrives looking the way its
 * author left it — Starline's music lives beside its levels, and its shared
 * levels arrive silent. `music` names a piece the game resolves: a URL, or a
 * name in the game's own list.
 *
 * @param {any} [input]
 * @param {string} [flavour]
 */
export function normalizeRacingLook(input = {}, flavour = "circuit") {
  const raw = input && typeof input === "object" ? input : {};
  const base = RACING_LOOK_DEFAULTS[flavour === "tabletop" ? "tabletop" : "circuit"];
  const surfaces = Array.isArray(raw.surfaces) ? raw.surfaces : [];
  return {
    view: oneOf(raw.view, [...RACING_VIEWS], base.view),
    background: hexColor(raw.background, base.background),
    surfaces: RACING_SURFACE_CODES.map((code) => hexColor(surfaces[code], base.surfaces[code])),
    wall: hexColor(raw.wall, base.wall),
    kerb: hexColor(raw.kerb, base.kerb),
    music: boundedString(raw.music, "", 400),
  };
}

/**
 * The moments a track may give a sound of its own, each an `SfxDefinition`
 * from `arcade/sfx` — a sound as data, so it shares with the track. The
 * names are every event `drainEvents` returns, plus `engine`, which a game
 * loops and pitches by speed. A track sets the ones it wants; a game plays
 * its own for the rest.
 */
export const RACING_SOUND_EVENTS = Object.freeze([
  "engine", "countdown", "go", "checkpoint", "lap", "finish", "wall", "bump",
  "jump", "land", "fall", "respawn", "spin", "pickup", "fire", "drop", "hit",
  "explode", "wrongWay", "propLost", "eliminated", "point", "round", "won", "lost",
]);

/** @param {any} [input] */
export function normalizeRacingSounds(input) {
  const raw = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  /** @type {Record<string, any>} */
  const sounds = {};
  for (const event of RACING_SOUND_EVENTS) {
    if (raw[event] && typeof raw[event] === "object") sounds[event] = normalizeSfx(raw[event]);
  }
  return sounds;
}

// -- rules --------------------------------------------------------------

/**
 * How a race is won.
 *
 * - `race` — laps against the field; a seat that finishes at `qualify` or
 *   better has won. RC Pro-Am's "finish in the top three".
 * - `elimination` — Micro Machines' head-to-head. One shared view follows
 *   the leader, a car that falls out of it is out of the round, the last car
 *   in view takes a point, and everyone restarts together at the leader's
 *   place. First to `target` points.
 */
export const RACING_MODES = Object.freeze(["race", "elimination"]);

/** Which cars start at the front. */
export const RACING_POLES = Object.freeze(["field", "players"]);

/** `[min, max]` for every number in the rules; see `RACING_FEEL_RANGES`. */
export const RACING_RULE_RANGES = racingFrozenRanges({
  laps: [0, 99], qualify: [1, 8], countdown: [0, 10], catchup: [0, 1], target: [1, 99],
  timeLimit: [0, 6000], leash: [0, 20000], roundDelay: [0, 10],
});

/** The rules that are not whole numbers. */
export const RACING_RULE_DECIMALS = Object.freeze(["catchup", "timeLimit", "roundDelay"]);

/** @param {any} [input] @param {string} [flavour] */
export function normalizeRacingRules(input = {}, flavour = "circuit") {
  const raw = input && typeof input === "object" ? input : {};
  const circuit = flavour !== "tabletop";
  const base = {
    laps: circuit ? 4 : 3,
    qualify: circuit ? 3 : 2,
    countdown: 3,
    catchup: circuit ? 0.35 : 0.2,
    target: 3,
    timeLimit: 0,
    leash: circuit ? 0 : 420,
    roundDelay: 1.5,
  };
  const rules = {
    mode: oneOf(raw.mode, [...RACING_MODES], "race"),
    weapons: asBoolean(raw.weapons, circuit),
    pole: oneOf(raw.pole, [...RACING_POLES], "field"),
  };
  for (const [name, fallback] of Object.entries(base)) {
    const [low, high] = RACING_RULE_RANGES[name];
    rules[name] = RACING_RULE_DECIMALS.includes(name)
      ? boundedNumber(raw[name], fallback, low, high)
      : boundedInteger(raw[name], fallback, low, high);
  }
  const view = raw.view && typeof raw.view === "object" ? raw.view : {};
  /** The shared screen elimination is judged against, in world pixels. */
  rules.view = {
    w: boundedNumber(view.w, 640, 64, 20000),
    h: boundedNumber(view.h, 360, 64, 20000),
  };
  const ammo = raw.ammo && typeof raw.ammo === "object" ? raw.ammo : {};
  rules.ammo = {
    missile: boundedInteger(ammo.missile, 0, 0, 99),
    bomb: boundedInteger(ammo.bomb, 0, 0, 99),
  };
  return rules;
}

// -- the track ----------------------------------------------------------

/** Which game this track is. The flavour picks defaults, never the solver. */
export const RACING_FLAVOURS = Object.freeze(["circuit", "tabletop"]);

/** The most cars a race will run, seats and field together. */
export const RACING_MAX_CARS = 8;

/**
 * Past the edge of the world. `beyond: "drop"` is a table: drive off it and
 * you fall. Omitted, the bounds sit well clear of the route and are a wall,
 * so nothing can wander off forever.
 * 
 * @param {any} raw
 */
function racingBounds(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    x: boundedNumber(raw.x, 0, -100000, 100000),
    y: boundedNumber(raw.y, 0, -100000, 100000),
    w: boundedNumber(raw.w, 1000, 32, 200000),
    h: boundedNumber(raw.h, 1000, 32, 200000),
    beyond: oneOf(raw.beyond, ["wall", "drop"], "wall"),
  };
}

/**
 * Checkpoints: fractions of a lap strictly inside (0, 1), sorted, or
 * `{node, along}` anchors, which stay put when another stretch is edited
 * (see `racingPlacement`). The anchors cannot be sorted without the built
 * route, so they follow the fractions in the order given and the route sorts
 * the lot by distance when it is built.
 *
 * @param {any} raw
 * @param {string[]} [nodeIds]
 */
function racingCheckpoints(raw, nodeIds = []) {
  const list = Array.isArray(raw) ? raw : [0.25, 0.5, 0.75];
  const fractions = [];
  const anchored = [];
  for (const value of list.slice(0, 64)) {
    if (value && typeof value === "object") {
      if (typeof value.node !== "string" || !nodeIds.includes(value.node)) continue;
      const along = boundedNumber(value.along, 0, -200000, 200000);
      if (!anchored.some((kept) => kept.node === value.node && kept.along === along)) anchored.push({ node: value.node, along });
      continue;
    }
    const at = boundedNumber(value, NaN, 0, 1);
    if (Number.isFinite(at) && at > 0 && at < 1) fractions.push(at);
  }
  fractions.sort((a, b) => a - b);
  return [...fractions.filter((at, index) => index === 0 || at !== fractions[index - 1]), ...anchored];
}

/** A blank track: a plain oval, one car, nothing on it. */
export function emptyRacingTrack(name = "Untitled Track") {
  return normalizeRacingTrack({ name, flavour: "circuit", route: { nodes: racingDefaultNodes() } });
}

/**
 * Repair anything into a track this module will race.
 *
 * Every genre here normalizes rather than validates, and a track has the
 * usual reason: it is the natural thing for an editor to emit half-finished,
 * and a node list with one bad entry should lose that entry, not the track.
 * Ids are derived from position in their list rather than minted, so the
 * same document normalizes to the same track on every machine.
 *
 * @param {any} [input]
 */
export function normalizeRacingTrack(input = {}) {
  const raw = input && typeof input === "object" ? input : {};
  const flavour = oneOf(raw.flavour, [...RACING_FLAVOURS], "circuit");
  const circuit = flavour === "circuit";
  const carPreset = circuit ? "truck" : "micro";
  const route = normalizeRacingRoute(raw.route, circuit ? "wall" : "open");
  const nodeIds = route.nodes.map((node) => node.id);
  const track = {
    version: RACING_VERSION,
    name: boundedString(raw.name, "Untitled Track", 80),
    flavour,
    feel: normalizeRacingFeel(raw.feel, circuit ? "stadium" : "tabletop"),
    car: normalizeRacingCar(raw.car ?? carPreset, carPreset),
    route,
    offroad: oneOf(raw.offroad, RACING_SURFACE_CODES, circuit ? RACING_GRASS : RACING_DIRT),
    bounds: racingBounds(raw.bounds),
    checkpoints: racingCheckpoints(raw.checkpoints, nodeIds),
    patches: (Array.isArray(raw.patches) ? raw.patches : []).slice(0, 1000).map((patch, index) => normalizeRacingPatch(patch, index, nodeIds)),
    pickups: (Array.isArray(raw.pickups) ? raw.pickups : []).slice(0, 1000).map((pickup, index) => normalizeRacingPickup(pickup, index, nodeIds)),
    props: (Array.isArray(raw.props) ? raw.props : []).slice(0, 500).map((prop, index) => normalizeRacingProp(prop, index, nodeIds)),
    field: (Array.isArray(raw.field) ? raw.field : []).slice(0, RACING_MAX_CARS - 1).map((driver, index) => normalizeRacingDriver(driver, index, carPreset)),
    rules: normalizeRacingRules(raw.rules, flavour),
    look: normalizeRacingLook(raw.look, flavour),
    decor: (Array.isArray(raw.decor) ? raw.decor : []).slice(0, 2000).map((item, index) => normalizeRacingDecor(item, index, nodeIds)),
    // Sprites for cars, props and decorations, in `arcade/sprite`'s own
    // shape and through its own normalizer — one unreadable sprite costs
    // that sprite, not the track it rode in on.
    //
    // A `sprite` on a car, a prop or a decoration is resolved by the
    // renderer: an asset here first, then whatever art the game carries,
    // and the plain shape in its colour when neither has it. So a sprite
    // name this track does not carry is kept, not cleared — it may be one
    // of the game's own, and a track that travels between games keeps its
    // intent. Pointing out a name nothing resolves is an editor's job.
    assets: normalizeAssets(raw.assets),
    sounds: normalizeRacingSounds(raw.sounds),
  };
  return track;
}
