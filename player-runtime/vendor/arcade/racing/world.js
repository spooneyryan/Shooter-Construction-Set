// The race: one track, up to four seats and a computer field, and the rules
// that make it a race rather than a driving demo.
//
// The split this module is built on: `car.js` knows about tyres and walls
// and nothing about racing, and everything a substep must not see twice —
// laps, positions, pickups, weapons, falls, events — lives out here and runs
// once per step. That is not tidiness. A rollback re-runs steps, and anything
// counted inside a substep would be counted `substeps` times the first time
// and again on every correction. The one thing that must happen inside the
// substeps is cars touching each other and the props, because that needs
// every car at once and is exactly as fast as the cars are.
//
// **Both games are this one loop.** RC Pro-Am is `mode: "race"` with walls,
// weapons and pickups on the track; Micro Machines is the same race on an
// open table whose edge is a drop, or `mode: "elimination"` for its
// head-to-head. Nothing below branches on the flavour at all — the flavour
// only chose the defaults the track document was normalized with, which is
// the evidence for building one module rather than two.
//
// **The computer's cars are simulation.** At the top of every step the world
// asks `racingDriverInput` for each of them, from state alone, before any car
// moves. Two machines racing the same field therefore see it drive the same
// way, and a rollback re-drives it through the corrected past.

import { atan2, cos, hypot, sin } from "../core/trig.js";
import {
  RACING_HOLE,
  RACING_MAX_CARS,
  RACING_OIL,
  neutralRacingInput,
  normalizeRacingCar,
  normalizeRacingRules,
  normalizeRacingTrack,
  racingSurface,
} from "./contract.js";
import { buildRacingTrack, racingGroundInto, racingPointAt, racingProgressInto, racingWallInto } from "./track.js";
import { createRacingCar, racingCarCorners, racingResolveFixed, racingTune, seatRacingCar, stepRacingCar } from "./car.js";
import { racingDriverInput, racingPace } from "./driver.js";

/** A missile leaves the nose this much faster than the car was going. */
const RACING_MISSILE_SPEED = 720;
/** Seconds a missile flies before it fizzles. */
const RACING_MISSILE_LIFE = 1.6;
/** Seconds a dropped bomb waits on the road, and before it is live. */
const RACING_BOMB_LIFE = 14;
const RACING_BOMB_ARM = 0.4;
/** Touch radius of a bomb and of a pickup. */
const RACING_BOMB_RADIUS = 8;
const RACING_PICKUP_RADIUS = 12;
/** The most rounds of either weapon a car can carry. */
const RACING_AMMO_CAP = 9;
/** What a turbo does to the engine while it lasts. */
const RACING_TURBO_PACE = 1.35;
/** Two cars further apart in height than this pass over one another. */
const RACING_CAR_TALL = 10;
/** Closing speeds below these are scrapes, not events. */
const RACING_WALL_EVENT = 90;
const RACING_BUMP_EVENT = 60;
/** Slowest a car can meet oil and still be spun by it. */
const RACING_OIL_SPEED = 140;
/** Backwards along the route faster than this counts as the wrong way. */
const RACING_WRONG_SPEED = 40;
/** A car slower than this that is not gaining ground is stuck. */
const RACING_STUCK_SPEED = 30;
/** How much a hit leaves of a car's speed. */
const RACING_HIT_KEEP = 0.35;

function racingClampValue(value, low, high) {
  return value < low ? low : value > high ? high : value;
}

/** The distance from (px, py) to the segment (ax, ay)-(bx, by), squared. */
function racingSweepGap(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const run = dx * dx + dy * dy;
  let t = run > 0 ? ((px - ax) * dx + (py - ay) * dy) / run : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const ox = px - (ax + dx * t);
  const oy = py - (ay + dy * t);
  return ox * ox + oy * oy;
}

/**
 * Create a race on a track.
 *
 * @param {any} track Raw or normalized; it is normalized either way, so a
 *        half-finished document from an editor races rather than throws.
 * @param {object} [options]
 * @param {number} [options.players] Seats, 0..4. Zero races the field on its
 *        own — an attract mode.
 * @param {number} [options.cpu] How many of the track's field to enter.
 *        Defaults to all of them; the total is capped at `RACING_MAX_CARS`.
 * @param {object} [options.rules] Overrides for the track's rules — the same
 *        table raced as a lap race alone and as elimination with a friend.
 * @param {string | string[]} [options.steering] `"rotate"` or `"point"`, for
 *        every seat or per seat.
 * @param {any[]} [options.cars] Per-seat cars, overriding the track's. A
 *        championship builds these from the upgrades it has been awarding.
 * @param {{along?: number, offset?: number, speed?: number}} [options.start]
 *        A practice run — "drive from here": the first seat starts `along` px
 *        past the line and `offset` px right, facing the lap, at `speed`
 *        px/s; everyone else lines up behind in single file. No lights
 *        unless `rules.countdown` says so, and the lap clock starts at the
 *        line, so every lap reported is a whole one.
 */
export function createRace(track, options = {}) {
  const spec = normalizeRacingTrack(track);
  const overrides = options.rules && typeof options.rules === "object" ? options.rules : null;
  // A practice run — "drive from here": see the grid, below.
  const start = options.start && typeof options.start === "object" ? options.start : null;
  const merged = overrides
    ? normalizeRacingRules({
      ...spec.rules,
      ...overrides,
      view: { ...spec.rules.view, ...(overrides.view ?? {}) },
      ammo: { ...spec.rules.ammo, ...(overrides.ammo ?? {}) },
    }, spec.flavour)
    : spec.rules;
  // A practice run has no lights, unless the options ask for them.
  const rules = start && overrides?.countdown === undefined ? { ...merged, countdown: 0 } : merged;
  const feel = spec.feel;
  const route = buildRacingTrack(spec);
  const seats = racingClampValue(Math.round(Number(options.players ?? 1)) || 0, 0, 4);
  const wantCpu = options.cpu === undefined ? spec.field.length : Math.round(Number(options.cpu)) || 0;
  const cpu = racingClampValue(wantCpu, 0, Math.min(spec.field.length, RACING_MAX_CARS - seats));
  const steering = (seat) => {
    const choice = Array.isArray(options.steering) ? options.steering[seat] : options.steering;
    return choice === "point" ? "point" : "rotate";
  };

  // -- who is racing ----------------------------------------------------
  /** @type {any[]} */
  const entrants = [];
  for (let seat = 0; seat < seats; seat += 1) {
    const car = options.cars?.[seat] !== undefined ? normalizeRacingCar(options.cars[seat], spec.car.preset) : spec.car;
    entrants.push({ seat, cpu: -1, name: `Player ${seat + 1}`, car, steering: steering(seat), skill: 1, line: 0, aggression: 0 });
  }
  for (let index = 0; index < cpu; index += 1) {
    const driver = spec.field[index];
    entrants.push({
      seat: -1, cpu: index, name: driver.name, car: driver.car, steering: "rotate",
      skill: driver.skill, line: driver.line, aggression: driver.aggression,
    });
  }
  const tunes = entrants.map((entrant) => racingTune(entrant.car));
  // Derived from the document, so built once and never in a snapshot.
  const paces = entrants.map((entrant, index) => racingPace(route, tunes[index], entrant.skill));
  const lap = route.length;
  const checkpoints = route.checkpoints;
  const longest = tunes.reduce((most, tune) => Math.max(most, tune.length), 0);
  const widest = tunes.reduce((most, tune) => Math.max(most, tune.width), 0);

  let nextId = 1;
  /** @type {any[]} */
  let queued = [];
  const emit = (event) => { queued.push(event); };

  // -- the grid ---------------------------------------------------------
  // Two lanes, staggered, behind the start line — which is node 0 and
  // distance zero, so every car begins the race a little negative and its
  // first crossing of the line is the start, not a lap.
  const slotBack = (slot) => {
    const row = Math.floor(slot / 2);
    return 20 + longest * 0.6 + row * longest * 2.2 + (slot % 2) * longest * 0.9;
  };
  const place = (car, s, lane, offset = 0) => {
    const spot = racingPointAt(route, s, 0);
    const across = Math.min(spot.half * 0.45, widest * 1.4) * lane + offset;
    seatRacingCar(car, spot.x - spot.ty * across, spot.y + spot.tx * across, atan2(spot.ty, spot.tx));
    const along = s - Math.floor(s / lap) * lap;
    car.along = along;
    car.cursor = Math.min(route.count - 1, Math.floor(along / route.ds));
  };
  const order = entrants.map((_, index) => index);
  if (rules.pole === "field" && !start) order.sort((a, b) => (entrants[b].cpu >= 0 ? 1 : 0) - (entrants[a].cpu >= 0 ? 1 : 0) || a - b);

  /** @type {any[]} */
  let cars = entrants.map((entrant, index) => Object.assign(createRacingCar(), {
    index,
    seat: entrant.seat,
    cpu: entrant.cpu,
    along: 0,
    cursor: 0,
    /** Race distance from the start line, px. Negative on the grid. */
    distance: 0,
    lateral: 0,
    lap: 0,
    checkpoint: 0,
    lapStart: 0,
    lastLap: 0,
    bestLap: 0,
    finished: false,
    finishTime: 0,
    place: 0,
    position: index + 1,
    ammo: { missile: rules.ammo.missile, bomb: rules.ammo.bomb },
    score: 0,
    points: 0,
    out: false,
    falling: 0,
    grace: 0,
    turbo: 0,
    wrongWay: 0,
    stuck: 0,
    fireHeld: false,
    dropHeld: false,
    resetHeld: false,
  }));
  if (start) {
    // Drive from here: the first seat's car sits `along` px past the line
    // and `offset` px right, facing the way the lap goes, and everyone else
    // lines up behind it in single file on the same line. Its distance is
    // the ground to the line, negative, so the lap clock starts when a car
    // first crosses it — the run-up is practice, and every lap reported is
    // a whole one. `speed` makes it a rolling start.
    const along = Number(start.along);
    const at = Number.isFinite(along) ? along - Math.floor(along / lap) * lap : 0;
    const toLine = at > 0 ? lap - at : 0;
    const wanted = Number(start.offset);
    const speed = racingClampValue(Number(start.speed) || 0, 0, 2000);
    const gap = longest * 1.6;
    order.forEach((index, slot) => {
      const car = cars[index];
      const s = at - slot * gap;
      const spot = racingPointAt(route, s, 0);
      // Kept on the ground a car may stand on: the road and its verge.
      const room = Math.max(0, spot.half + route.verge[spot.index] - widest * 0.5);
      place(car, s, 0, racingClampValue(Number.isFinite(wanted) ? wanted : 0, -room, room));
      car.distance = -toLine - slot * gap;
      car.vx = spot.tx * speed;
      car.vy = spot.ty * speed;
    });
  } else {
    order.forEach((index, slot) => {
      const car = cars[index];
      const back = slotBack(slot);
      place(car, -back, slot % 2 === 0 ? -1 : 1);
      car.distance = -back;
    });
  }

  /** @type {any[]} */
  let pickups = spec.pickups.map(() => ({ active: true, respawnAt: -1 }));
  /** @type {any[]} */
  let props = spec.props.map((_, index) => ({
    x: route.props[index].x, y: route.props[index].y, vx: 0, vy: 0, alive: true,
  }));
  /** @type {any[]} */
  let shots = [];
  /** @type {any[]} */
  let mines = [];

  const state = {
    tick: 0,
    time: 0,
    /** `countdown` before the lights, `racing`, `round` between eliminations. */
    phase: /** @type {"countdown" | "racing" | "round"} */ ("countdown"),
    countdown: rules.countdown,
    announced: 0,
    raceStart: 0,
    roundTimer: 0,
    round: 1,
    /** Who leads the restart after an elimination round. */
    leader: 0,
    outcome: /** @type {"playing" | "won" | "lost"} */ ("playing"),
    winner: -1,
    finishers: 0,
    camera: { x: cars[0]?.x ?? 0, y: cars[0]?.y ?? 0 },
    cars,
    pickups,
    props,
    shots,
    mines,
  };

  // -- small rules ------------------------------------------------------
  const tag = (car) => ({ index: car.index, seat: car.seat });
  const solid = (car) => !car.out && car.falling === 0 && car.grace === 0;
  const present = (car) => !car.out && car.falling === 0;

  const startFall = (car, reason) => {
    if (car.falling > 0 || car.out) return;
    car.falling = feel.fallTicks;
    car.spinTicks = 0;
    car.turbo = 0;
    emit({ type: "fall", ...tag(car), reason, x: car.x, y: car.y });
  };

  // Back onto the route at the last safe sample at or behind where the car
  // was, on the centreline, pointing the right way. The distance it had
  // not legitimately kept is taken off it, so a fall costs places as well
  // as time.
  const respawn = (car) => {
    const safe = route.safe[car.cursor] ?? car.cursor;
    const s = safe * route.ds;
    let delta = s - car.along;
    if (delta > lap / 2) delta -= lap;
    else if (delta < -lap / 2) delta += lap;
    const spot = racingPointAt(route, s, 0);
    seatRacingCar(car, spot.x, spot.y, atan2(spot.ty, spot.tx));
    car.along = s;
    car.cursor = safe;
    car.distance += delta;
    car.lateral = 0;
    car.grace = feel.respawnGrace;
    car.stuck = 0;
    car.wrongWay = 0;
    emit({ type: "respawn", ...tag(car), x: car.x, y: car.y });
  };

  const spin = (car, reason) => {
    if (car.spinTicks > 0 || car.grace > 0) return;
    car.spinTicks = feel.spinTicks;
    car.spinDir = car.w >= 0 ? 1 : -1;
    emit({ type: "spin", ...tag(car), reason });
  };

  const hit = (car, weapon, by, x, y) => {
    if (car.grace > 0 || car.out || car.falling > 0) return false;
    car.vx *= RACING_HIT_KEEP;
    car.vy *= RACING_HIT_KEEP;
    car.spinTicks = 0;
    spin(car, weapon);
    emit({ type: "hit", ...tag(car), by, weapon, x, y });
    return true;
  };

  const finish = (car) => {
    car.finished = true;
    state.finishers += 1;
    car.place = state.finishers;
    car.finishTime = state.time - state.raceStart;
    emit({ type: "finish", ...tag(car), place: car.place, time: car.finishTime });
  };

  const fire = (car) => {
    if (!rules.weapons || car.ammo.missile <= 0) return;
    car.ammo.missile -= 1;
    const hx = cos(car.heading);
    const hy = sin(car.heading);
    const forward = car.vx * hx + car.vy * hy;
    const nose = tunes[car.index].length / 2 + 6;
    const id = nextId++;
    shots.push({
      id, owner: car.index,
      x: car.x + hx * nose, y: car.y + hy * nose,
      vx: hx * (Math.max(0, forward) + RACING_MISSILE_SPEED),
      vy: hy * (Math.max(0, forward) + RACING_MISSILE_SPEED),
      life: RACING_MISSILE_LIFE,
    });
    emit({ type: "fire", ...tag(car), weapon: "missile", id });
  };

  const drop = (car) => {
    if (!rules.weapons || car.ammo.bomb <= 0) return;
    car.ammo.bomb -= 1;
    const tail = tunes[car.index].length / 2 + RACING_BOMB_RADIUS + 2;
    const id = nextId++;
    mines.push({
      id, owner: car.index,
      x: car.x - cos(car.heading) * tail, y: car.y - sin(car.heading) * tail,
      life: RACING_BOMB_LIFE, arm: RACING_BOMB_ARM,
    });
    emit({ type: "drop", ...tag(car), weapon: "bomb", id });
  };

  /** The field's rubber band: behind the best player, a stronger engine. */
  const catchupOf = (index) => {
    const car = cars[index];
    if (!car || car.cpu < 0 || rules.mode !== "race" || rules.catchup <= 0) return 1;
    let best = -Infinity;
    for (const other of cars) if (other.seat >= 0 && other.distance > best) best = other.distance;
    if (best === -Infinity) return 1;
    return 1 + rules.catchup * racingClampValue((best - car.distance) / 900, -1, 1) * 0.2;
  };

  // -- the input edge, inside the simulation -----------------------------
  // `steer` for a "point" seat is the direction the player wants to face;
  // the wheel is turned towards it here, against the true heading, so a
  // rollback re-steers against the corrected one.
  const steerFrom = (car, input, mode) => {
    const sx = Number(input?.steer?.x) || 0;
    const sy = Number(input?.steer?.y) || 0;
    if (mode !== "point") return racingClampValue(sx, -1, 1);
    const push = sx * sx + sy * sy;
    if (push < 0.0625) return 0;
    const reach = Math.sqrt(push);
    const dx = sx / reach;
    const dy = sy / reach;
    const hx = cos(car.heading);
    const hy = sin(car.heading);
    const cross = hx * dy - hy * dx;
    const dot = hx * dx + hy * dy;
    let steer = dot < 0 ? (cross >= 0 ? 1 : -1) : racingClampValue(cross * 2.5, -1, 1);
    // Reversing, the wheel turns the car the other way.
    if (car.vx * hx + car.vy * hy < -20) steer = -steer;
    return steer;
  };

  // -- collisions: inside the substeps ----------------------------------
  const COS = new Float64Array(cars.length);
  const SIN = new Float64Array(cars.length);
  const bumps = new Float64Array(cars.length * cars.length);

  const collideCars = () => {
    for (let index = 0; index < cars.length; index += 1) {
      COS[index] = cos(cars[index].heading);
      SIN[index] = sin(cars[index].heading);
    }
    for (let i = 0; i < cars.length; i += 1) {
      const a = cars[i];
      if (!solid(a)) continue;
      const ta = tunes[i];
      for (let j = i + 1; j < cars.length; j += 1) {
        const b = cars[j];
        if (!solid(b)) continue;
        if (Math.abs(a.z - b.z) > RACING_CAR_TALL) continue;
        const tb = tunes[j];
        const near = ta.reach + ta.radius + tb.reach + tb.radius;
        const cx = b.x - a.x;
        const cy = b.y - a.y;
        if (cx * cx + cy * cy > near * near) continue;
        for (let da = 0; da < 2; da += 1) {
          const offA = da === 0 ? ta.reach : -ta.reach;
          for (let db = 0; db < 2; db += 1) {
            const offB = db === 0 ? tb.reach : -tb.reach;
            const ax = a.x + COS[i] * offA;
            const ay = a.y + SIN[i] * offA;
            const bx = b.x + COS[j] * offB;
            const by = b.y + SIN[j] * offB;
            const dx = bx - ax;
            const dy = by - ay;
            const sum = ta.radius + tb.radius;
            const gap2 = dx * dx + dy * dy;
            if (gap2 >= sum * sum) continue;
            const gap = Math.sqrt(gap2);
            const nx = gap > 1e-9 ? dx / gap : 1;
            const ny = gap > 1e-9 ? dy / gap : 0;
            const depth = sum - gap;
            const px = ax + nx * ta.radius;
            const py = ay + ny * ta.radius;
            const rax = px - a.x;
            const ray = py - a.y;
            const rbx = px - b.x;
            const rby = py - b.y;
            const relX = (b.vx - b.w * rby) - (a.vx - a.w * ray);
            const relY = (b.vy + b.w * rbx) - (a.vy + a.w * rax);
            const vn = relX * nx + relY * ny;
            const invA = 1 / ta.mass;
            const invB = 1 / tb.mass;
            if (vn < 0) {
              const raN = rax * ny - ray * nx;
              const rbN = rbx * ny - rby * nx;
              const k = invA + invB + (raN * raN) / ta.inertia + (rbN * rbN) / tb.inertia;
              const impulse = (-(1 + feel.carBounce) * vn) / k;
              a.vx -= impulse * nx * invA;
              a.vy -= impulse * ny * invA;
              a.w -= (raN * impulse) / ta.inertia;
              b.vx += impulse * nx * invB;
              b.vy += impulse * ny * invB;
              b.w += (rbN * impulse) / tb.inertia;
              const at = i * cars.length + j;
              if (-vn > bumps[at]) bumps[at] = -vn;
            }
            const share = depth / (invA + invB);
            a.x -= nx * share * invA;
            a.y -= ny * share * invA;
            b.x += nx * share * invB;
            b.y += ny * share * invB;
          }
        }
      }
    }
  };

  const WALL = { nx: 0, ny: 0, depth: 0 };
  const GROUND = { surface: 0, dirX: 1, dirY: 0 };

  const collideProps = (h) => {
    // Pushable props move first, then everything touches everything.
    for (let index = 0; index < props.length; index += 1) {
      const prop = props[index];
      const def = spec.props[index];
      if (!prop.alive || def.mass <= 0) continue;
      prop.x += prop.vx * h;
      prop.y += prop.vy * h;
      const keep = 1 - def.drag * h;
      prop.vx *= keep > 0 ? keep : 0;
      prop.vy *= keep > 0 ? keep : 0;
      if (racingWallInto(route, prop.x, prop.y, def.radius, WALL)) {
        const vn = prop.vx * WALL.nx + prop.vy * WALL.ny;
        if (vn < 0) {
          prop.vx -= (1 + def.bounce) * vn * WALL.nx;
          prop.vy -= (1 + def.bounce) * vn * WALL.ny;
        }
        prop.x += WALL.nx * WALL.depth;
        prop.y += WALL.ny * WALL.depth;
      }
    }
    for (let i = 0; i < props.length; i += 1) {
      const p = props[i];
      const pd = spec.props[i];
      if (!p.alive) continue;
      for (let j = i + 1; j < props.length; j += 1) {
        const q = props[j];
        const qd = spec.props[j];
        if (!q.alive || (pd.mass <= 0 && qd.mass <= 0)) continue;
        const dx = q.x - p.x;
        const dy = q.y - p.y;
        const sum = pd.radius + qd.radius;
        const gap2 = dx * dx + dy * dy;
        if (gap2 >= sum * sum) continue;
        const gap = Math.sqrt(gap2);
        const nx = gap > 1e-9 ? dx / gap : 1;
        const ny = gap > 1e-9 ? dy / gap : 0;
        const invP = pd.mass > 0 ? 1 / pd.mass : 0;
        const invQ = qd.mass > 0 ? 1 / qd.mass : 0;
        const vn = (q.vx - p.vx) * nx + (q.vy - p.vy) * ny;
        if (vn < 0) {
          const impulse = (-(1 + Math.min(pd.bounce, qd.bounce)) * vn) / (invP + invQ);
          p.vx -= impulse * nx * invP;
          p.vy -= impulse * ny * invP;
          q.vx += impulse * nx * invQ;
          q.vy += impulse * ny * invQ;
        }
        const share = (sum - gap) / (invP + invQ);
        p.x -= nx * share * invP;
        p.y -= ny * share * invP;
        q.x += nx * share * invQ;
        q.y += ny * share * invQ;
      }
    }
    for (let index = 0; index < cars.length; index += 1) {
      const car = cars[index];
      if (!present(car)) continue;
      const tune = tunes[index];
      for (let at = 0; at < props.length; at += 1) {
        const prop = props[at];
        const def = spec.props[at];
        if (!prop.alive || car.z > def.tall) continue;
        // A car coming back from a fall is a ghost to everything that can
        // move, so it cannot be put down inside a pushable prop and fire it
        // across the table. Fixed props stay solid: they are scenery.
        if (car.grace > 0 && def.mass > 0) continue;
        const hx = cos(car.heading);
        const hy = sin(car.heading);
        for (let disc = 0; disc < 2; disc += 1) {
          const along = disc === 0 ? tune.reach : -tune.reach;
          const cx = car.x + hx * along;
          const cy = car.y + hy * along;
          const dx = cx - prop.x;
          const dy = cy - prop.y;
          const sum = tune.radius + def.radius;
          const gap2 = dx * dx + dy * dy;
          if (gap2 >= sum * sum) continue;
          const gap = Math.sqrt(gap2);
          const nx = gap > 1e-9 ? dx / gap : 1;
          const ny = gap > 1e-9 ? dy / gap : 0;
          const depth = sum - gap;
          const px = cx - nx * tune.radius;
          const py = cy - ny * tune.radius;
          if (def.mass <= 0) {
            // Scenery hits the car as a wall does, and is reported as one:
            // once per step, the hardest, by the loop after the substeps.
            const closing = racingResolveFixed(car, tune, px, py, nx, ny, depth, def.bounce, feel.wallFriction);
            if (closing > reports[index].wall) reports[index].wall = closing;
            continue;
          }
          // A pushable prop: two bodies, the prop without spin.
          const invCar = 1 / tune.mass;
          const invProp = 1 / def.mass;
          const rx = px - car.x;
          const ry = py - car.y;
          const relX = (car.vx - car.w * ry) - prop.vx;
          const relY = (car.vy + car.w * rx) - prop.vy;
          const vn = relX * nx + relY * ny;
          if (vn < 0) {
            const rn = rx * ny - ry * nx;
            const impulse = (-(1 + def.bounce) * vn) / (invCar + invProp + (rn * rn) / tune.inertia);
            car.vx += impulse * nx * invCar;
            car.vy += impulse * ny * invCar;
            car.w += (rn * impulse) / tune.inertia;
            prop.vx -= impulse * nx * invProp;
            prop.vy -= impulse * ny * invProp;
          }
          const share = depth / (invCar + invProp);
          car.x += nx * share * invCar;
          car.y += ny * share * invCar;
          prop.x -= nx * share * invProp;
          prop.y -= ny * share * invProp;
        }
      }
    }
  };

  // -- once per step, after the physics -----------------------------------
  const PROBE = { segment: 0, t: 0, px: 0, py: 0, distance: 0, side: 1 };

  const advance = (car) => {
    racingProgressInto(route, car.x, car.y, car.cursor, PROBE);
    const s = (PROBE.segment + PROBE.t) * route.ds;
    let delta = s - car.along;
    if (delta > lap / 2) delta -= lap;
    else if (delta < -lap / 2) delta += lap;
    car.along = s;
    car.cursor = PROBE.segment;
    car.distance += delta;
    car.lateral = PROBE.distance * PROBE.side;
    // A practice run's lap clock starts at the line, not at the lights.
    if (start && car.distance >= 0 && car.distance - delta < 0) car.lapStart = state.time;

    // Checkpoints are split times; the lap is the distance. A lap counts
    // when the car's distance passes a whole lap beyond the last one AND it
    // has passed every checkpoint of this lap on the way — which the
    // distance alone already implies, since progress cannot skip ground.
    const base = car.lap * lap;
    while (car.checkpoint < checkpoints.length && car.distance >= base + checkpoints[car.checkpoint]) {
      car.checkpoint += 1;
      emit({ type: "checkpoint", ...tag(car), checkpoint: car.checkpoint, time: state.time - car.lapStart });
    }
    if (car.checkpoint >= checkpoints.length && car.distance >= base + lap) {
      car.lap += 1;
      car.checkpoint = 0;
      const time = state.time - car.lapStart;
      car.lastLap = time;
      if (car.bestLap === 0 || time < car.bestLap) car.bestLap = time;
      car.lapStart = state.time;
      emit({ type: "lap", ...tag(car), lap: car.lap, time });
      if (rules.mode === "race" && rules.laps > 0 && car.lap >= rules.laps && !car.finished) finish(car);
    }
    return delta;
  };

  const collect = (car) => {
    const reach = tunes[car.index].radius + RACING_PICKUP_RADIUS;
    for (let index = 0; index < pickups.length; index += 1) {
      const pickup = pickups[index];
      if (!pickup.active) continue;
      const spot = route.pickups[index];
      const dx = car.x - spot.x;
      const dy = car.y - spot.y;
      if (dx * dx + dy * dy > reach * reach) continue;
      const def = spec.pickups[index];
      pickup.active = false;
      pickup.respawnAt = def.respawn > 0 ? state.time + def.respawn : -1;
      if (def.kind === "missile") car.ammo.missile = Math.min(RACING_AMMO_CAP, car.ammo.missile + Math.round(def.amount));
      else if (def.kind === "bomb") car.ammo.bomb = Math.min(RACING_AMMO_CAP, car.ammo.bomb + Math.round(def.amount));
      else if (def.kind === "turbo") car.turbo = Math.max(car.turbo, Math.round(def.amount * 60));
      else if (def.kind === "bonus") car.score += def.amount;
      else if (def.kind === "upgrade") car.upgrade[def.stat] = Math.min(1, car.upgrade[def.stat] + def.amount);
      emit({ type: "pickup", ...tag(car), kind: def.kind, pickup: index, id: def.id, x: spot.x, y: spot.y });
    }
  };

  const stepShots = (dt) => {
    const kept = [];
    for (const shot of shots) {
      const fromX = shot.x;
      const fromY = shot.y;
      shot.x += shot.vx * dt;
      shot.y += shot.vy * dt;
      shot.life -= dt;
      let spent = shot.life <= 0;
      if (!spent && racingWallInto(route, shot.x, shot.y, 3, WALL)) spent = true;
      for (let at = 0; !spent && at < props.length; at += 1) {
        const prop = props[at];
        if (!prop.alive) continue;
        const reach = spec.props[at].radius + 3;
        if (racingSweepGap(prop.x, prop.y, fromX, fromY, shot.x, shot.y) < reach * reach) spent = true;
      }
      for (const car of cars) {
        if (spent) break;
        if (car.index === shot.owner || !present(car) || car.z > RACING_CAR_TALL) continue;
        const tune = tunes[car.index];
        const hx = cos(car.heading);
        const hy = sin(car.heading);
        const reach = tune.radius + 4;
        for (let disc = 0; disc < 2 && !spent; disc += 1) {
          const along = disc === 0 ? tune.reach : -tune.reach;
          if (racingSweepGap(car.x + hx * along, car.y + hy * along, fromX, fromY, shot.x, shot.y) < reach * reach) {
            hit(car, "missile", shot.owner, shot.x, shot.y);
            spent = true;
          }
        }
      }
      if (spent) {
        if (shot.life > 0) emit({ type: "explode", weapon: "missile", id: shot.id, x: shot.x, y: shot.y });
        continue;
      }
      kept.push(shot);
    }
    shots = kept;
    state.shots = shots;

    const armed = [];
    for (const mine of mines) {
      mine.life -= dt;
      mine.arm -= dt;
      if (mine.life <= 0) continue;
      let spent = false;
      if (mine.arm <= 0) {
        for (const car of cars) {
          if (car.index === mine.owner || !present(car) || car.z > 2) continue;
          const reach = tunes[car.index].radius + RACING_BOMB_RADIUS;
          const dx = car.x - mine.x;
          const dy = car.y - mine.y;
          if (dx * dx + dy * dy < reach * reach) {
            hit(car, "bomb", mine.owner, mine.x, mine.y);
            emit({ type: "explode", weapon: "bomb", id: mine.id, x: mine.x, y: mine.y });
            spent = true;
            break;
          }
        }
      }
      if (!spent) armed.push(mine);
    }
    mines = armed;
    state.mines = mines;
  };

  const rank = () => {
    const ranking = cars.slice().sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished) return a.place - b.place;
      if (a.distance !== b.distance) return b.distance - a.distance;
      return a.index - b.index;
    });
    for (let at = 0; at < ranking.length; at += 1) ranking[at].position = at + 1;
  };

  /** The car the camera follows: the leader in elimination, else the best seat. */
  const focusOf = () => {
    let focus = null;
    for (const car of cars) {
      if (rules.mode === "elimination") {
        if (car.out) continue;
        if (focus === null || car.distance > focus.distance) focus = car;
      } else if (car.seat >= 0 && (focus === null || car.position < focus.position)) {
        focus = car;
      }
    }
    if (focus === null) for (const car of cars) if (focus === null || car.position < focus.position) focus = car;
    return focus;
  };

  // The camera is simulation, not presentation, because in elimination it
  // decides who is out: two machines whose cameras drifted would knock out
  // different cars. Outside elimination a game is free to ignore it and
  // frame each player itself — a split screen, say.
  const stepCamera = (dt, snap) => {
    const focus = focusOf();
    if (!focus) return;
    const targetX = focus.x + focus.vx * feel.cameraAhead;
    const targetY = focus.y + focus.vy * feel.cameraAhead;
    const ease = snap ? 1 : Math.min(1, feel.cameraEase * dt);
    state.camera.x += (targetX - state.camera.x) * ease;
    state.camera.y += (targetY - state.camera.y) * ease;
  };

  const end = (reason) => {
    rank();
    let best = Infinity;
    let seated = 0;
    for (const car of cars) {
      if (car.seat < 0) continue;
      seated += 1;
      if (car.position < best) best = car.position;
    }
    let winner = cars[0];
    for (const car of cars) {
      if (rules.mode === "elimination") {
        if (car.points > winner.points || (car.points === winner.points && car.position < winner.position)) winner = car;
      } else if (car.position < winner.position) winner = car;
    }
    state.winner = winner ? winner.index : -1;
    // With no seats at all — the field racing itself — a race that ran to
    // its end is simply over, and "won" is the only answer that is not a
    // claim about somebody.
    const won = rules.mode === "elimination"
      ? seated === 0 || (winner !== undefined && winner.seat >= 0)
      : seated === 0 || best <= rules.qualify;
    state.outcome = won ? "won" : "lost";
    emit({ type: state.outcome, time: state.time - state.raceStart, winner: state.winner, reason });
  };

  // Elimination: back to a standing start, together, at the leader's place.
  const newRound = (leader) => {
    const s = (route.safe[leader.cursor] ?? leader.cursor) * route.ds;
    const lineup = cars.slice().sort((a, b) => (b === leader ? 1 : 0) - (a === leader ? 1 : 0) || b.distance - a.distance || a.index - b.index);
    const lead = leader.distance;
    lineup.forEach((car, slot) => {
      const back = slot === 0 ? 0 : slotBack(slot - 1);
      place(car, s - back, slot === 0 ? 0 : slot % 2 === 0 ? 1 : -1);
      car.distance = lead - back;
      car.lap = Math.max(0, Math.floor(car.distance / lap));
      car.checkpoint = 0;
      while (car.checkpoint < checkpoints.length && car.distance >= car.lap * lap + checkpoints[car.checkpoint]) car.checkpoint += 1;
      car.out = false;
      car.falling = 0;
      car.grace = 0;
      car.turbo = 0;
      car.stuck = 0;
      car.wrongWay = 0;
    });
    shots = [];
    mines = [];
    state.shots = shots;
    state.mines = mines;
    state.round += 1;
    state.phase = "countdown";
    state.countdown = 1;
    state.announced = 0;
    stepCamera(0, true);
    emit({ type: "round", round: state.round, leader: leader.index });
  };

  const eliminate = () => {
    if (cars.length < 2) return;
    const halfW = rules.view.w / 2;
    const halfH = rules.view.h / 2;
    for (const car of cars) {
      if (car.out) continue;
      if (Math.abs(car.x - state.camera.x) > halfW || Math.abs(car.y - state.camera.y) > halfH) {
        car.out = true;
        emit({ type: "eliminated", ...tag(car), round: state.round });
      }
    }
    const left = cars.filter((car) => !car.out);
    if (left.length > 1) return;
    const survivor = left[0] ?? null;
    if (survivor) {
      survivor.points += 1;
      emit({ type: "point", ...tag(survivor), points: survivor.points, round: state.round });
    }
    if (survivor && survivor.points >= rules.target) {
      end("points");
      return;
    }
    // The survivor leads the restart. Nobody survived — two cars knocked out
    // on the same tick — and the restart is at whoever was furthest round.
    let leader = survivor;
    if (!leader) for (const car of cars) if (leader === null || car.distance > leader.distance) leader = car;
    state.leader = leader ? leader.index : 0;
    state.phase = "round";
    state.roundTimer = rules.roundDelay;
  };

  // -- the step ----------------------------------------------------------
  const controls = cars.map(() => ({ throttle: 0, brake: 0, steer: 0, handbrake: false, pace: 1 }));
  const reports = cars.map(() => ({ wall: 0, launched: 0, landed: 0 }));

  const race = {
    /** The normalized track document. Read-only; the race never writes to it. */
    get track() { return spec; },
    /** The route, built once. Renderers walk its arrays straight out of it. */
    get route() { return route; },
    /** The rules in force: the track's, with the options' overrides. */
    get rules() { return rules; },
    get flavour() { return spec.flavour; },
    /** Who is in each car, in `state.cars` order: seats first, then the field. */
    get entrants() { return entrants; },
    /** Live state. Read after a step; never write to it. */
    state,

    /**
     * Advance one fixed step.
     *
     * @param {number} dt Seconds. Fixed — 1/60 in every consumer here.
     * @param {Array<any>} inputs One `RacingInput` per seat, in seat order.
     *        A missing seat drives nothing. The field needs none.
     */
    step(dt, inputs = []) {
      if (state.outcome !== "playing") return state;
      state.tick += 1;
      state.time += dt;

      if (state.phase === "round") {
        state.roundTimer -= dt;
        if (state.roundTimer <= 0) {
          newRound(cars[state.leader] ?? cars[0]);
          return state;
        }
      }

      if (state.phase === "countdown") {
        const count = Math.ceil(state.countdown - 1e-9);
        if (count > 0 && count !== state.announced) {
          state.announced = count;
          emit({ type: "countdown", count });
        }
        state.countdown -= dt;
        if (state.countdown > 1e-9) {
          stepCamera(dt, false);
          return state;
        }
        state.countdown = 0;
        state.phase = "racing";
        state.raceStart = state.time;
        for (const car of cars) car.lapStart = state.time;
        emit({ type: "go", round: state.round });
      }

      // 1. What every car wants, before any of them moves. The field and
      //    any finished seat are driven by the computer from this state.
      for (let index = 0; index < cars.length; index += 1) {
        const car = cars[index];
        const entrant = entrants[index];
        const byComputer = entrant.seat < 0 || (car.finished && rules.mode === "race");
        const input = byComputer ? racingDriverInput(race, index) : (inputs[entrant.seat] ?? neutralRacingInput());
        const control = controls[index];
        const pedal = racingClampValue(Number(input?.drive?.x) || 0, -1, 1);
        control.throttle = pedal > 0 ? pedal : 0;
        control.brake = pedal < 0 ? -pedal : 0;
        control.steer = steerFrom(car, input, entrant.steering);
        control.handbrake = input?.handbrake === true;
        control.pace = (car.turbo > 0 ? RACING_TURBO_PACE : 1) * catchupOf(index);

        const reset = input?.reset === true;
        const firing = input?.fire === true;
        const dropping = input?.drop === true;
        const pressedReset = reset && !car.resetHeld;
        const pressedFire = firing && !car.fireHeld;
        const pressedDrop = dropping && !car.dropHeld;
        car.resetHeld = reset;
        car.fireHeld = firing;
        car.dropHeld = dropping;
        if (car.out) continue;
        if (car.falling > 0) {
          car.falling -= 1;
          if (car.falling === 0) respawn(car);
          continue;
        }
        if (car.grace > 0) car.grace -= 1;
        if (car.turbo > 0) car.turbo -= 1;
        if (car.spinTicks > 0) car.spinTicks -= 1;
        if (pressedReset) {
          startFall(car, "reset");
          continue;
        }
        if (pressedFire) fire(car);
        if (pressedDrop) drop(car);
      }

      // 2. The physics, in substeps, with every contact between cars and
      //    props resolved inside each one.
      const substeps = feel.substeps;
      const h = dt / substeps;
      for (const report of reports) {
        report.wall = 0;
        report.launched = 0;
        report.landed = 0;
      }
      bumps.fill(0);
      for (let sub = 0; sub < substeps; sub += 1) {
        for (let index = 0; index < cars.length; index += 1) {
          const car = cars[index];
          if (!present(car)) continue;
          const report = stepRacingCar(car, tunes[index], route, feel, controls[index], h);
          const total = reports[index];
          if (report.wall > total.wall) total.wall = report.wall;
          if (report.launched > total.launched) total.launched = report.launched;
          if (report.landed > total.landed) total.landed = report.landed;
        }
        collideCars();
        collideProps(h);
      }

      // 3. Everything that happens once per step.
      for (let index = 0; index < cars.length; index += 1) {
        const car = cars[index];
        if (!present(car)) continue;
        const report = reports[index];
        if (report.wall > RACING_WALL_EVENT) emit({ type: "wall", ...tag(car), impact: report.wall, x: car.x, y: car.y });
        if (report.launched > 0) emit({ type: "jump", ...tag(car), speed: report.launched });
        if (report.landed > 0) emit({ type: "land", ...tag(car), impact: report.landed });

        const grounded = car.z <= 0 && car.vz <= 0;
        if (grounded) {
          racingGroundInto(route, car.x, car.y, GROUND);
          if (GROUND.surface === RACING_HOLE) {
            startFall(car, "hole");
            continue;
          }
          const speed = hypot(car.vx, car.vy);
          if (speed > RACING_OIL_SPEED && car.spinTicks === 0) {
            for (const code of car.ground) {
              if (code === RACING_OIL) {
                spin(car, "oil");
                break;
              }
            }
          }
        }
        if (car.z <= RACING_CAR_TALL) collect(car);

        const before = car.distance;
        advance(car);
        const gained = car.distance - before;

        if (rules.leash > 0 && Math.abs(car.lateral) > rules.leash + route.half[car.cursor]) {
          startFall(car, "leash");
          continue;
        }

        // Wrong way: moving backwards along the route for long enough.
        const along = car.vx * route.txs[car.cursor] + car.vy * route.tys[car.cursor];
        if (along < -RACING_WRONG_SPEED) {
          car.wrongWay += 1;
          if (car.wrongWay === feel.wrongWayTicks) emit({ type: "wrongWay", ...tag(car) });
        } else {
          car.wrongWay = 0;
        }

        // Stuck: slow and not gaining ground. The computer's driver reads it.
        const speed = hypot(car.vx, car.vy);
        car.stuck = speed < RACING_STUCK_SPEED && gained < 0.5 && !car.finished ? car.stuck + 1 : 0;
      }
      for (let i = 0; i < cars.length; i += 1) {
        for (let j = i + 1; j < cars.length; j += 1) {
          const impact = bumps[i * cars.length + j];
          if (impact > RACING_BUMP_EVENT) {
            emit({ type: "bump", a: i, b: j, impact, x: (cars[i].x + cars[j].x) / 2, y: (cars[i].y + cars[j].y) / 2 });
          }
        }
      }

      // Props that fell off the world are gone for the race.
      for (let index = 0; index < props.length; index += 1) {
        const prop = props[index];
        if (!prop.alive || spec.props[index].mass <= 0) continue;
        racingGroundInto(route, prop.x, prop.y, GROUND);
        if (GROUND.surface === RACING_HOLE) {
          prop.alive = false;
          emit({ type: "propLost", prop: index, x: prop.x, y: prop.y });
        }
      }
      for (const pickup of pickups) {
        if (!pickup.active && pickup.respawnAt >= 0 && state.time >= pickup.respawnAt) {
          pickup.active = true;
          pickup.respawnAt = -1;
        }
      }
      stepShots(dt);
      rank();
      stepCamera(dt, false);

      // 4. Is it over?
      if (rules.mode === "elimination") {
        if (state.phase === "racing") eliminate();
        if (state.outcome === "playing" && rules.laps > 0) {
          for (const car of cars) {
            if (car.lap >= rules.laps) {
              end("laps");
              break;
            }
          }
        }
      } else {
        const seated = cars.filter((car) => car.seat >= 0);
        const home = seated.length > 0 ? seated.every((car) => car.finished) : cars.every((car) => car.finished);
        if (home && (rules.laps > 0)) end("finish");
        else if (rules.timeLimit > 0 && state.time - state.raceStart >= rules.timeLimit) end("time");
      }
      return state;
    },

    /** The car's numbers in the solver's units, for a renderer. */
    tuneOf(index) { return tunes[index]; },
    /** The computer's speed profile for car `index`. */
    paceOf(index) { return paces[index]; },
    /** The field's catch-up multiplier for car `index` right now. */
    catchupOf,
    /** The car's body as four corners, for drawing. */
    corners(car) { return racingCarCorners(car, tunes[car.index]); },
    /** What the car is standing on, at its centre. */
    surfaceUnder(car) {
      racingGroundInto(route, car.x, car.y, GROUND);
      return racingSurface(GROUND.surface);
    },
    /** How fast a car is going, px/s. */
    speedOf(car) { return hypot(car.vx, car.vy); },

    /** The finishing order so far, best first. */
    results() {
      return cars.slice().sort((a, b) => a.position - b.position).map((car) => ({
        index: car.index,
        seat: car.seat,
        cpu: car.cpu,
        name: entrants[car.index].name,
        position: car.position,
        place: car.place,
        finished: car.finished,
        time: car.finishTime,
        laps: car.lap,
        bestLap: car.bestLap,
        points: car.points,
        score: car.score,
      }));
    },

    /**
     * Everything noteworthy since the last drain, oldest first: `countdown`,
     * `go`, `checkpoint`, `lap`, `finish`, `wall`, `bump`, `jump`, `land`,
     * `fall`, `respawn`, `spin`, `pickup`, `fire`, `drop`, `hit`, `explode`,
     * `wrongWay`, `propLost`, `eliminated`, `point`, `round`, `won`, `lost`.
     * Drive sounds and effects from these — never from inside the step,
     * which a rollback re-runs.
     */
    drainEvents() {
      const drained = queued;
      queued = [];
      return drained;
    },

    /** Plain data all the way down; survives JSON. */
    snapshot() {
      return {
        tick: state.tick,
        time: state.time,
        phase: state.phase,
        countdown: state.countdown,
        announced: state.announced,
        raceStart: state.raceStart,
        roundTimer: state.roundTimer,
        round: state.round,
        leader: state.leader,
        outcome: state.outcome,
        winner: state.winner,
        finishers: state.finishers,
        nextId,
        camera: { ...state.camera },
        cars: cars.map((car) => ({ ...car, upgrade: { ...car.upgrade }, ground: [...car.ground], ammo: { ...car.ammo } })),
        pickups: pickups.map((pickup) => ({ ...pickup })),
        props: props.map((prop) => ({ ...prop })),
        shots: shots.map((shot) => ({ ...shot })),
        mines: mines.map((mine) => ({ ...mine })),
      };
    },

    restore(snap) {
      state.tick = snap.tick;
      state.time = snap.time;
      state.phase = snap.phase;
      state.countdown = snap.countdown;
      state.announced = snap.announced;
      state.raceStart = snap.raceStart;
      state.roundTimer = snap.roundTimer;
      state.round = snap.round;
      state.leader = snap.leader;
      state.outcome = snap.outcome;
      state.winner = snap.winner;
      state.finishers = snap.finishers;
      nextId = snap.nextId;
      state.camera = { ...snap.camera };
      cars = snap.cars.map((car) => ({ ...car, upgrade: { ...car.upgrade }, ground: [...car.ground], ammo: { ...car.ammo } }));
      pickups = snap.pickups.map((pickup) => ({ ...pickup }));
      props = snap.props.map((prop) => ({ ...prop }));
      shots = snap.shots.map((shot) => ({ ...shot }));
      mines = snap.mines.map((mine) => ({ ...mine }));
      state.cars = cars;
      state.pickups = pickups;
      state.props = props;
      state.shots = shots;
      state.mines = mines;
      queued = [];
    },
  };

  rank();
  stepCamera(0, true);
  return race;
}
