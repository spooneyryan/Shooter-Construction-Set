// What a course is made of.
//
// Everything here is what a game *says*, and nothing here changes while a
// ride is in progress — the same split every genre module in this package
// states at its top, and for the same reason: the world reads it and never
// writes to it, so one authored course can be replayed, raced or rewound
// without being copied first.
//
// **The format's centre is that the ground is a line, not a grid.** That
// is the whole reason this module exists next to `runnjump` rather than
// inside it. A platformer's floor is a tile whose slope is two edge
// heights; a rover's and a bike's floor is a continuous surface their
// wheels roll along, and the entire feel of both games is a chassis that
// pitches while its wheels follow that surface independently. A grid
// cannot express a 4° rise, and rounding one to a tile is the difference
// between a landing and a wall.
//
// The line is a **heightfield**: a polyline whose x strictly increases, so
// the ground is a function of x. That buys exact, branch-free queries and
// a solver that cannot tunnel, and it costs overhangs and loops — said out
// loud in docs/WHEELS.md rather than discovered later. Everything both
// games need is expressible: ExciteBike's ramps, Moon Patrol's craters,
// and jumps as big as the author likes.
//
// Names carry a `WHEELS_`/`Wheels` prefix, the convention `topdown` settled
// on (2026-08-30), which is also what keeps this module concatenation-safe
// beside its siblings; see tests/flat-scope.test.mjs.

import {
  asBoolean,
  boundedInteger,
  boundedNumber,
  boundedString,
  oneOf,
  uniqueId,
} from "../core/validate.js";

export const WHEELS_VERSION = 1;

// -- surfaces -----------------------------------------------------------

// A surface code belongs to a SEGMENT — the span between two polyline
// points — not to a point, because grip is a property of the ground you
// are on, and a point is on two of them. This is the heightfield's answer
// to `runnjump`'s tile codes, and it is what makes ice, sand, a boost pad
// and a fatal crater floor one mechanism instead of four.

/** Grip. The default everywhere. */
export const WHEELS_TARMAC = 0;
/** Loose: less grip, a little drag. */
export const WHEELS_DIRT = 1;
/** Almost no grip. Throttle spins, brakes do nothing. */
export const WHEELS_ICE = 2;
/** Grips, but drags hard. ExciteBike's mud. */
export const WHEELS_SAND = 3;
/** Free acceleration while a driven wheel is on it. */
export const WHEELS_BOOST = 4;
/** Touching it wrecks: a crater floor, lava, the bottom of a gap. */
export const WHEELS_FATAL = 5;

/**
 * What each surface does to a tyre, as plain numbers the solver reads.
 *
 * `grip` multiplies the tyre's friction limit, `drag` is rolling
 * resistance per unit of normal load, and `boost` is a forward
 * acceleration in px/s² applied while a driven wheel touches it — the same
 * units as a vehicle's `power`, so a pad can be read against an engine
 * without knowing what either weighs.
 */
export const WHEELS_SURFACES = Object.freeze({
  [WHEELS_TARMAC]: { name: "tarmac", grip: 1, drag: 0.015, boost: 0, fatal: false },
  [WHEELS_DIRT]: { name: "dirt", grip: 0.78, drag: 0.05, boost: 0, fatal: false },
  [WHEELS_ICE]: { name: "ice", grip: 0.12, drag: 0.005, boost: 0, fatal: false },
  [WHEELS_SAND]: { name: "sand", grip: 0.85, drag: 0.22, boost: 0, fatal: false },
  [WHEELS_BOOST]: { name: "boost", grip: 1.1, drag: 0.01, boost: 900, fatal: false },
  [WHEELS_FATAL]: { name: "fatal", grip: 0.4, drag: 0.1, boost: 0, fatal: true },
});

const WHEELS_SURFACE_CODES = [
  WHEELS_TARMAC, WHEELS_DIRT, WHEELS_ICE, WHEELS_SAND, WHEELS_BOOST, WHEELS_FATAL,
];

/** Whether landing on this surface ends the ride. */
export function wheelsSurfaceIsFatal(code) {
  return (WHEELS_SURFACES[code] ?? WHEELS_SURFACES[WHEELS_TARMAC]).fatal === true;
}

// -- input --------------------------------------------------------------

/**
 * One seat's frame of intent: two analogue channels and four buttons.
 *
 * `drive.x` is the throttle/brake axis — forward past zero, brake and then
 * reverse below it. `lean.x` is the rider: negative leans back and lifts
 * the nose, positive leans forward and drops it. In the air that is the
 * only control there is, which is precisely the ExciteBike/Trials game;
 * on the ground the same torque transfers weight between the wheels, so a
 * wheelie is not a special case in the code — it is the front tyre's
 * normal load reaching zero.
 *
 * Both go through `core/stick` at the edge, so a keyboard's left/right
 * arrow and a gamepad's analogue stick arrive here as the same shape.
 *
 * @typedef {object} WheelsInput
 * @property {boolean} jump Hop. The rover's leap; zero-powered on a bike.
 * @property {boolean} fireForward Patrol's forward gun.
 * @property {boolean} fireUp Patrol's anti-air gun.
 * @property {boolean} reset Give up and restart at the last checkpoint.
 * @property {{x: number, y: number}} drive
 * @property {{x: number, y: number}} lean
 */

/** The action names, in wire order — append-only, the `net/input-log` rule. */
export const WHEELS_ACTIONS = Object.freeze(["jump", "fireForward", "fireUp", "reset"]);

/** The analogue channels, in wire order. Same append-only rule. */
export const WHEELS_STICKS = Object.freeze(["drive", "lean"]);

/** @returns {WheelsInput} Nothing held, both channels centred. */
export function neutralWheelsInput() {
  return {
    jump: false,
    fireForward: false,
    fireUp: false,
    reset: false,
    drive: { x: 0, y: 0 },
    lean: { x: 0, y: 0 },
  };
}

// -- feel ---------------------------------------------------------------

/**
 * The world's physics, as opposed to the vehicle's. Units are pixels,
 * seconds and newtons throughout; a "kilogram" here is whatever mass makes
 * these numbers feel right, which is the only honest definition a game has.
 *
 * `maxSpin` and `maxTurn` are two limiters and not one. `maxSpin` caps a
 * WHEEL, in rad/s of tread, so it has to be large — a 12 px tyre needs 125
 * of it just to reach 1,500 px/s. `maxTurn` caps the CHASSIS. Using the
 * wheel's number for both, which is what this did first, leaves the body
 * free to rotate at fifty revolutions a second: the guard reads as present
 * and does nothing, and lowering it to mean anything silently geared the
 * vehicle down instead.
 *
 * `substeps` is the one number that is not taste. The solver is explicit,
 * so its stability depends on how far anything moves in one integration —
 * and a bike at 1,400 px/s crosses eleven pixels per 60 Hz frame with
 * wheels ten pixels across. Four substeps is what keeps a landing a
 * landing instead of a teleport, and it is fixed rather than adaptive
 * because an adaptive count is a different simulation on a slower machine.
 */
export const WHEELS_FEEL_PRESETS = Object.freeze({
  moon: {
    gravity: 520, substeps: 4, airDrag: 0.00018, angularDrag: 0.9,
    maxSpeed: 1400, maxSpin: 260, maxTurn: 30, wreckTicks: 96, respawnBack: 0,
    cameraAhead: 190, cameraLift: 40, cameraEase: 7, activateAhead: 420,
  },
  earth: {
    gravity: 1750, substeps: 4, airDrag: 0.00030, angularDrag: 1.4,
    maxSpeed: 2200, maxSpin: 320, maxTurn: 40, wreckTicks: 72, respawnBack: 0,
    cameraAhead: 230, cameraLift: 30, cameraEase: 9, activateAhead: 520,
  },
  heavy: {
    gravity: 2400, substeps: 6, airDrag: 0.00042, angularDrag: 1.8,
    maxSpeed: 2600, maxSpin: 360, maxTurn: 40, wreckTicks: 72, respawnBack: 0,
    cameraAhead: 260, cameraLift: 26, cameraEase: 10, activateAhead: 560,
  },
});

const WHEELS_FEEL_RANGES = {
  gravity: [0, 6000], substeps: [1, 16], airDrag: [0, 0.01],
  angularDrag: [0, 20], maxSpeed: [100, 8000], maxSpin: [10, 2000],
  maxTurn: [1, 400], wreckTicks: [1, 600], respawnBack: [0, 4000],
  cameraAhead: [0, 2000], cameraLift: [0, 1000], cameraEase: [0.5, 60],
  activateAhead: [0, 4000],
};

const WHEELS_INTEGER_FEEL = new Set(["substeps", "wreckTicks"]);

/** @param {any} [input] @param {string} [preset] */
export function normalizeWheelsFeel(input, preset = "earth") {
  const base = WHEELS_FEEL_PRESETS[preset] ?? WHEELS_FEEL_PRESETS.earth;
  const raw = input && typeof input === "object" ? input : {};
  const feel = {};
  for (const [name, fallback] of Object.entries(base)) {
    const [low, high] = WHEELS_FEEL_RANGES[name];
    feel[name] = WHEELS_INTEGER_FEEL.has(name)
      ? boundedInteger(raw[name], fallback, low, high)
      : boundedNumber(raw[name], fallback, low, high);
  }
  return feel;
}

// -- the vehicle --------------------------------------------------------

/**
 * A wheel, in the chassis's own coordinates: `x` forward of centre, `y`
 * below it, both in pixels. `radius` is the tyre.
 *
 * `drive` and `brake` are shares, not booleans, so a rear-drive bike is
 * `drive: 0` in front and `drive: 1` behind, and a rover with a handbrake
 * on the back axle is a number rather than a branch.
 *
 * The suspension is a spring-damper along the chassis's own down axis —
 * it leans when the body leans, which is what a fork does and what makes
 * a hard landing pitch the body instead of merely stopping it. `travel`
 * is how far it may compress before it bottoms out, and bottoming out is
 * not clamped away: it becomes a rigid contact, because that jolt is the
 * single most important piece of feedback a big jump gives.
 */
export function normalizeWheelsWheel(input = {}, fallback = {}) {
  return {
    x: boundedNumber(input.x, fallback.x ?? 0, -400, 400),
    y: boundedNumber(input.y, fallback.y ?? 10, -400, 400),
    radius: boundedNumber(input.radius, fallback.radius ?? 12, 1, 200),
    drive: boundedNumber(input.drive, fallback.drive ?? 1, 0, 1),
    brake: boundedNumber(input.brake, fallback.brake ?? 1, 0, 1),
    rest: boundedNumber(input.rest, fallback.rest ?? 14, 0, 400),
    travel: boundedNumber(input.travel, fallback.travel ?? 14, 0, 400),
    stiffness: boundedNumber(input.stiffness, fallback.stiffness ?? 30000, 1, 4000000),
    damping: boundedNumber(input.damping, fallback.damping ?? 2400, 0, 200000),
    grip: boundedNumber(input.grip, fallback.grip ?? 1, 0, 8),
    mass: boundedNumber(input.mass, fallback.mass ?? 14, 0.1, 4000),
  };
}

/**
 * Two vehicles, and they are the two games. Neither is a mode: the same
 * solver reads both, and everything that separates a moon rover from a
 * trials bike is in these numbers — a heavy body on soft long-travel
 * springs that hops, against a light body on stiff ones with enough air
 * control to turn a backflip and a crash tolerance that means it.
 *
 * **Every driver number here is an acceleration, not a torque.** `power`
 * and `braking` are px/s² at the contact patch and `leanRate`/`airRate`
 * are rad/s² about the centre; the solver multiplies them by the mass and
 * the wheel radius, or by the moment of inertia, on the way in. Torques
 * were the first attempt and they are unauthorable: the engine's number
 * has to be compared against the tyre's reaction, which is `mu` times the
 * normal load times the radius, so "is 190,000 a lot?" has no answer
 * without doing that arithmetic — and the honest answer the first time was
 * "no, it is a twentieth of what the tyre pushes back with", which read on
 * screen as a bike that would not accelerate.
 *
 * Written this way the numbers say what they do. `power` above `mu *
 * gravity` spins the tyre; below it, the vehicle simply goes. There is a
 * second ceiling worth knowing: past `gravity * halfWheelbase / rideHeight`
 * the drive torque lifts the front wheel on its own, and a vehicle that
 * wheelies whenever the throttle is held is not drivable. The bike's 1,400
 * sits just under its 1,720, so a hard launch squats and the rider's weight
 * is what finishes the wheelie — which is the control the game is about.
 */
export const WHEELS_VEHICLE_PRESETS = Object.freeze({
  rover: {
    name: "Rover",
    mass: 460, width: 64, height: 18, nose: 30, drop: -4,
    power: 500, topSpeed: 620, braking: 900, reverse: 0.45,
    leanRate: 20, airRate: 9, jump: 300,
    gripStiffness: 10, mu: 1.5, rollTolerance: 1.15, headY: -22,
    wheels: [
      { x: -30, y: 6, radius: 10, drive: 1, brake: 1, rest: 15, travel: 12, stiffness: 30000, damping: 3600, mass: 16 },
      { x: 30, y: 6, radius: 10, drive: 1, brake: 1, rest: 15, travel: 12, stiffness: 30000, damping: 3600, mass: 16 },
    ],
  },
  bike: {
    name: "Trials bike",
    mass: 190, width: 54, height: 16, nose: 30, drop: 4,
    power: 1400, topSpeed: 1500, braking: 2600, reverse: 0.3,
    leanRate: 55, airRate: 24, jump: 0,
    gripStiffness: 12, mu: 1.85, rollTolerance: 0.95, headY: -16,
    wheels: [
      { x: -26, y: 6, radius: 12, drive: 1, brake: 0.35, rest: 14, travel: 12, stiffness: 30000, damping: 2400, mass: 11 },
      { x: 26, y: 6, radius: 12, drive: 0, brake: 1, rest: 14, travel: 14, stiffness: 30000, damping: 2400, mass: 9 },
    ],
  },
});

const WHEELS_VEHICLE_RANGES = {
  mass: [1, 20000], width: [4, 600], height: [2, 400], nose: [0, 600], drop: [-200, 200],
  power: [0, 40000], topSpeed: [10, 8000], braking: [0, 40000], reverse: [0, 1],
  leanRate: [0, 400], airRate: [0, 400], jump: [0, 4000],
  gripStiffness: [0.1, 500], mu: [0, 8], rollTolerance: [0, 3.15], headY: [-400, 400],
};

/**
 * @param {any} [input] A preset name, a full definition, or a preset name
 *        in `preset` with overrides beside it.
 */
export function normalizeWheelsVehicle(input = {}) {
  const raw = typeof input === "string" ? { preset: input } : (input && typeof input === "object" ? input : {});
  const presetName = oneOf(raw.preset, Object.keys(WHEELS_VEHICLE_PRESETS), "bike");
  const base = WHEELS_VEHICLE_PRESETS[presetName];
  const vehicle = { preset: presetName, name: boundedString(raw.name, base.name, 60) };
  for (const [field, fallback] of Object.entries(base)) {
    if (field === "wheels" || field === "name") continue;
    const [low, high] = WHEELS_VEHICLE_RANGES[field];
    vehicle[field] = boundedNumber(raw[field], fallback, low, high);
  }
  const wheels = Array.isArray(raw.wheels) && raw.wheels.length > 0 ? raw.wheels : base.wheels;
  vehicle.wheels = wheels
    .slice(0, 8)
    .map((wheel, index) => normalizeWheelsWheel(wheel, base.wheels[Math.min(index, base.wheels.length - 1)]));
  // A one-wheeled vehicle is a unicycle and the solver is fine with it; a
  // zero-wheeled one is a crate, and it would fall through the world.
  if (vehicle.wheels.length === 0) vehicle.wheels = base.wheels.map((wheel) => normalizeWheelsWheel(wheel, wheel));
  return vehicle;
}

// -- the ground ---------------------------------------------------------

/**
 * The segment kinds an author writes. Each one emits polyline points; the
 * shapes that curve are sampled at the course's `resolution`, and the ones
 * that do not emit two points and cost nothing.
 *
 * Curves are smoothstep polynomials rather than cosines — not for speed,
 * but because `t * t * (3 - 2 * t)` is `+ - *` on doubles, which the
 * language specification pins down exactly, and a cosine is the one thing
 * it declines to. `core/trig` exists for the places that genuinely need an
 * angle; the ground is not one of them.
 */
export const WHEELS_SEGMENTS = Object.freeze([
  "flat", "slope", "hill", "ramp", "bumps", "crater", "pit", "step",
]);

const WHEELS_SEGMENT_DEFAULTS = {
  flat: { length: 200 },
  slope: { length: 160, rise: -60 },
  hill: { length: 220, rise: -80 },
  ramp: { length: 150, rise: -90 },
  bumps: { length: 260, rise: 14, count: 4 },
  crater: { length: 150, rise: 90 },
  pit: { length: 110, rise: 260 },
  step: { length: 6, rise: -24 },
};

/**
 * One piece of ground.
 *
 * `rise` is signed screen-space: negative goes UP, because +y is down
 * everywhere in this package and a segment that quietly flipped the
 * convention would be a bug in every course written after it. `crater`
 * and `pit` are the exception that proves it — their `rise` is a depth, so
 * it is positive, and they are the only two kinds where that reads
 * naturally.
 *
 * @param {any} [input]
 */
export function normalizeWheelsSegment(input = {}) {
  const raw = typeof input === "string" ? { kind: input } : (input && typeof input === "object" ? input : {});
  const kind = oneOf(raw.kind, [...WHEELS_SEGMENTS], "flat");
  const fallback = WHEELS_SEGMENT_DEFAULTS[kind];
  const segment = {
    kind,
    length: boundedNumber(raw.length, fallback.length, 1, 20000),
    rise: boundedNumber(raw.rise, fallback.rise ?? 0, -20000, 20000),
    surface: oneOf(raw.surface, WHEELS_SURFACE_CODES, WHEELS_TARMAC),
  };
  if (kind === "bumps") segment.count = boundedInteger(raw.count, fallback.count, 1, 200);
  // A crater and a pit own their floor's surface: the whole point of both
  // is that the bottom is not somewhere to be. An author may still say
  // otherwise -- a shallow "crater" of sand is a legal, useful thing.
  if ((kind === "crater" || kind === "pit") && raw.surface === undefined) segment.floor = WHEELS_FATAL;
  else if (kind === "crater" || kind === "pit") segment.floor = oneOf(raw.floor, WHEELS_SURFACE_CODES, segment.surface);
  return segment;
}

// -- props --------------------------------------------------------------

/** What can be standing on the course. `rock` and `mine` suit both games. */
export const WHEELS_PROP_KINDS = Object.freeze(["rock", "mine", "ufo", "tank"]);

const WHEELS_PROP_DEFAULTS = {
  rock: { width: 24, height: 30, health: 1, speed: 0, fireEvery: 0, points: 50 },
  mine: { width: 16, height: 10, health: 1, speed: 0, fireEvery: 0, points: 100 },
  ufo: { width: 34, height: 16, health: 1, speed: -90, fireEvery: 1.4, points: 300 },
  tank: { width: 40, height: 20, health: 2, speed: -60, fireEvery: 2.2, points: 200 },
};

/**
 * A prop is placed at an x along the course and sits on the ground unless
 * it flies. It wakes when the camera comes within the feel's
 * `activateAhead`, which is what keeps a long course cheap and is also
 * why the camera lives in the simulation rather than beside it.
 *
 * @param {any} [input]
 */
export function normalizeWheelsProp(input = {}) {
  const raw = input && typeof input === "object" ? input : {};
  const kind = oneOf(raw.kind, [...WHEELS_PROP_KINDS], "rock");
  const fallback = WHEELS_PROP_DEFAULTS[kind];
  return {
    id: boundedString(raw.id, uniqueId("prop"), 60),
    kind,
    x: boundedNumber(raw.x, 0, -100000, 1000000),
    /** Height above the ground beneath it; a `ufo` flies, a rock sits. */
    height: boundedNumber(raw.height, kind === "ufo" ? 150 : 0, -1000, 4000),
    width: boundedNumber(raw.width, fallback.width, 1, 600),
    tall: boundedNumber(raw.tall, fallback.height, 1, 600),
    health: boundedInteger(raw.health, fallback.health, 1, 999),
    speed: boundedNumber(raw.speed, fallback.speed, -2000, 2000),
    fireEvery: boundedNumber(raw.fireEvery, fallback.fireEvery, 0, 60),
    points: boundedInteger(raw.points, fallback.points, 0, 100000),
    /** Shooting it clears the way; driving into it does not. */
    shootable: asBoolean(raw.shootable, true),
    /** Hitting it wrecks. A decorative rock says false. */
    solid: asBoolean(raw.solid, true),
  };
}

// -- the course ---------------------------------------------------------

/** Which game this course is. The flavour picks the rules, not the solver. */
export const WHEELS_FLAVOURS = Object.freeze(["patrol", "trials"]);

const WHEELS_RULE_RANGES = {
  lives: [1, 99], timeLimit: [0, 6000], startSpeed: [0, 4000],
  checkpointGrace: [0, 600], faultPenalty: [0, 600],
};

/** The rules a flavour reads. Both flavours read all of them. */
export function normalizeWheelsRules(input = {}, flavour = "trials") {
  const raw = input && typeof input === "object" ? input : {};
  const base = flavour === "patrol"
    ? { lives: 3, timeLimit: 120, startSpeed: 260, checkpointGrace: 45, faultPenalty: 0 }
    : { lives: 99, timeLimit: 0, startSpeed: 0, checkpointGrace: 30, faultPenalty: 3 };
  const rules = {};
  for (const [name, fallback] of Object.entries(base)) {
    const [low, high] = WHEELS_RULE_RANGES[name];
    rules[name] = name === "timeLimit"
      ? boundedNumber(raw[name], fallback, low, high)
      : boundedInteger(raw[name], fallback, low, high);
  }
  return rules;
}

/** A blank course: a hundred metres of nothing and a bike to cross it. */
export function emptyWheelsCourse(name = "Untitled Course") {
  return {
    version: WHEELS_VERSION,
    name,
    flavour: "trials",
    feel: { ...WHEELS_FEEL_PRESETS.earth },
    vehicle: { preset: "bike" },
    ground: { x: 0, y: 320, resolution: 8, segments: [{ kind: "flat", length: 900 }] },
    props: [],
    checkpoints: [],
    rules: normalizeWheelsRules({}, "trials"),
  };
}

/**
 * Repair anything into a course this module will run.
 *
 * Every genre here normalizes rather than validates, and this one has a
 * reason of its own: a course is the natural thing for a level editor to
 * emit half-finished, and a segment list with one bad entry should lose
 * that entry, not the level.
 *
 * @param {any} [input]
 */
export function normalizeWheelsCourse(input = {}) {
  const raw = input && typeof input === "object" ? input : {};
  const flavour = oneOf(raw.flavour, [...WHEELS_FLAVOURS], "trials");
  const ground = raw.ground && typeof raw.ground === "object" ? raw.ground : {};
  const segments = (Array.isArray(ground.segments) ? ground.segments : [])
    .slice(0, 4000)
    .map((segment) => normalizeWheelsSegment(segment));
  // A course with no ground is a fall, so give it floor rather than
  // refusing to load: the editor that produced it is mid-thought.
  if (segments.length === 0) segments.push(normalizeWheelsSegment({ kind: "flat", length: 900 }));

  return {
    version: WHEELS_VERSION,
    name: boundedString(raw.name, "Untitled Course", 80),
    flavour,
    feel: normalizeWheelsFeel(raw.feel, flavour === "patrol" ? "moon" : "earth"),
    vehicle: normalizeWheelsVehicle(raw.vehicle ?? (flavour === "patrol" ? "rover" : "bike")),
    ground: {
      x: boundedNumber(ground.x, 0, -100000, 100000),
      y: boundedNumber(ground.y, 320, -100000, 100000),
      resolution: boundedNumber(ground.resolution, 8, 1, 200),
      segments,
    },
    props: (Array.isArray(raw.props) ? raw.props : []).slice(0, 2000).map((prop) => normalizeWheelsProp(prop)),
    checkpoints: (Array.isArray(raw.checkpoints) ? raw.checkpoints : [])
      .slice(0, 200)
      .map((x) => boundedNumber(x, 0, -100000, 1000000))
      .sort((a, b) => a - b),
    rules: normalizeWheelsRules(raw.rules, flavour),
  };
}
