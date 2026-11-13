// A small rigid-body world: boxes and circles under gravity, resolved with
// sequential impulses. Enough physics for the cannon-and-crates genre — things
// stack, topple, slide, bounce, and get launched — while staying inside this
// package's rules:
//
// **Data in, state out.** Nothing here draws, reads a clock, or calls back.
// The game reads `world.bodies` after `step` and draws them however it likes.
//
// **It is deterministic.** The arithmetic is + - * / with Math.sqrt/abs/min/
// max (all pinned exactly by the spec); rotation goes through core/trig; there
// is no Math.random and no wall clock. Same bodies, same steps, same bits —
// which is what lets a run replay and two machines agree.
//
// **The world snapshots.** `snapshot()`/`restore()` are plain-data copies,
// because rollback needs them and they cannot be retrofitted. `data` on a
// body rides along BY REFERENCE and is never touched by the engine — treat it
// as immutable if you snapshot.
//
// The solver is the well-trodden one (Box2D-Lite's): accumulate normal and
// friction impulses over a few iterations per step, with a Baumgarte bias
// pushing overlap out. No warm starting across steps; a dozen iterations
// keeps a ten-crate stack standing, which is the scale this is for. Bodies
// that stop moving go to sleep and cost nothing until something touches them.

import { cos, sin } from "../core/trig.js";
import {
  boxAabb,
  closestOnBox,
  collideBoxCircle,
  collideBoxes,
  collideCircles,
  pointInBox,
} from "./shapes.js";

/**
 * Pixels are big units, so raw area would make crates weigh thousands. One
 * mass unit per thousand square pixels keeps masses and the impulses a game
 * types (fire, explode) in the same friendly range.
 */
const MASS_PER_AREA = 1 / 1000;

/** Broadphase fattening, px — how far a resting joint may breathe apart. */
const AABB_SLACK = 2;

const clampNumber = (value, low, high, fallback) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return number < low ? low : number > high ? high : number;
};

/**
 * @param {object} [options]
 * @param {{x?: number, y?: number}} [options.gravity] px/s². +y is down, like
 *        the rest of the package. Default {x: 0, y: 900}.
 * @param {number} [options.iterations] Impulse iterations per step. More is
 *        stiffer stacks for more arithmetic. Default 12.
 * @param {number} [options.slop] Overlap in px tolerated before positional
 *        correction pushes back. Default 0.5.
 * @param {number} [options.correction] Baumgarte factor, 0..1. Default 0.2.
 * @param {number} [options.bounceThreshold] Approach speed in px/s below
 *        which restitution is ignored, so resting contact does not buzz.
 * @param {number} [options.maxSpeed] Speed clamp in px/s — the tunnelling
 *        guard for explosion-launched bodies. Default 5000.
 * @param {boolean} [options.sleep] Let still bodies sleep. Default true.
 * @param {number} [options.sleepLinear] Speed below which a body counts as
 *        still, px/s. @param {number} [options.sleepAngular] Likewise, rad/s.
 * @param {number} [options.sleepAfter] Still steps before sleeping.
 * @param {{minX: number, minY: number, maxX: number, maxY: number}} [options.bounds]
 *        Bodies fully outside this rectangle (plus margin) are removed and
 *        reported as a "left" event — endless cannonballs do not accumulate.
 * @param {number} [options.boundsMargin] Default 200.
 */
export function createPhysicsWorld({
  gravity = {},
  iterations = 12,
  slop = 0.5,
  correction = 0.2,
  bounceThreshold = 60,
  maxSpeed = 5000,
  sleep = true,
  sleepLinear = 5,
  sleepAngular = 0.07,
  sleepAfter = 45,
  bounds = null,
  boundsMargin = 200,
} = {}) {
  const gravityX = Number(gravity.x) || 0;
  const gravityY = gravity.y === undefined ? 900 : Number(gravity.y) || 0;
  const iterationCount = Math.max(1, Math.round(iterations) || 1);
  const sleepLinearSq = sleepLinear * sleepLinear;

  /** @type {any[]} insertion order — which is also solve order, which is why removal keeps it. */
  let bodies = [];
  /** @type {Map<number, any>} */
  let byId = new Map();
  /** Pair keys touching last step, for begin-contact events. */
  let touching = new Set();
  /**
   * Last step's accumulated impulses per pair, for warm starting. Without
   * this the solver starts every step from zero, and a stack of boxes creeps
   * sideways a pixel a second forever; starting from yesterday's answer is
   * what lets a dozen iterations hold a stack still. It is simulation state,
   * so it snapshots.
   * @type {Map<string, any[]>}
   */
  let warm = new Map();
  let events = [];
  let nextId = 1;

  function makeBody(shape, options) {
    const isStatic = Boolean(options.static);
    const friction = clampNumber(options.friction, 0, 2, 0.4);
    const restitution = clampNumber(options.restitution, 0, 1, 0.1);
    const body = {
      id: nextId,
      shape,
      x: Number(options.x) || 0,
      y: Number(options.y) || 0,
      angle: Number(options.angle) || 0,
      vx: Number(options.velocity?.x) || 0,
      vy: Number(options.velocity?.y) || 0,
      w: Number(options.angularVelocity) || 0,
      static: isStatic,
      friction,
      restitution,
      mass: 0,
      invMass: 0,
      inertia: 0,
      invInertia: 0,
      sleeping: false,
      still: 0,
      data: options.data ?? null,
    };
    nextId += 1;
    return body;
  }

  function finishBody(body, area, inertiaPerMass, options) {
    if (!body.static) {
      const density = clampNumber(options.density, 0.01, 1000, 1);
      const mass = options.mass !== undefined
        ? clampNumber(options.mass, 0.0001, 1e9, 1)
        : Math.max(0.0001, density * area * MASS_PER_AREA);
      body.mass = mass;
      body.invMass = 1 / mass;
      body.inertia = mass * inertiaPerMass;
      body.invInertia = body.inertia > 0 ? 1 / body.inertia : 0;
    }
    bodies.push(body);
    byId.set(body.id, body);
    return body;
  }

  /**
   * @param {object} options x, y, width, height, plus the shared body options:
   *        angle, static, density (or mass), friction, restitution,
   *        velocity {x, y}, angularVelocity, data.
   */
  function addBox(options = {}) {
    const width = clampNumber(options.width, 1, 1e6, 40);
    const height = clampNumber(options.height, 1, 1e6, 40);
    const body = makeBody("box", options);
    body.width = width;
    body.height = height;
    return finishBody(body, width * height, (width * width + height * height) / 12, options);
  }

  /** @param {object} options x, y, radius, plus the shared body options. */
  function addCircle(options = {}) {
    const radius = clampNumber(options.radius, 0.5, 1e6, 12);
    const body = makeBody("circle", options);
    body.radius = radius;
    return finishBody(body, radius * radius * 3.141592653589793, (radius * radius) / 2, options);
  }

  function wake(body) {
    if (!body || body.static) return;
    body.sleeping = false;
    body.still = 0;
  }

  /** Moving fast enough that touching it should wake a sleeper. */
  function moving(body) {
    if (body.static || body.sleeping) return false;
    return body.vx * body.vx + body.vy * body.vy > sleepLinearSq * 4 || Math.abs(body.w) > sleepAngular * 2;
  }

  function aabbOf(body) {
    if (body.shape === "circle") {
      return {
        minX: body.x - body.radius,
        minY: body.y - body.radius,
        maxX: body.x + body.radius,
        maxY: body.y + body.radius,
      };
    }
    return boxAabb(body.x, body.y, body.width / 2, body.height / 2, cos(body.angle), sin(body.angle));
  }

  /**
   * Geometry's contacts become the solver's working objects — presolve
   * decorates them with effective masses and accumulated impulses, which is
   * why the return type widens here.
   * @returns {any[]}
   */
  function contactsBetween(a, b) {
    if (a.shape === "box" && b.shape === "box") {
      return collideBoxes(
        a.x, a.y, a.width / 2, a.height / 2, cos(a.angle), sin(a.angle),
        b.x, b.y, b.width / 2, b.height / 2, cos(b.angle), sin(b.angle),
      );
    }
    if (a.shape === "circle" && b.shape === "circle") {
      return collideCircles(a.x, a.y, a.radius, b.x, b.y, b.radius);
    }
    // Box-circle, normal handed back as A -> B whichever way round they came.
    if (a.shape === "box") {
      return collideBoxCircle(a.x, a.y, a.width / 2, a.height / 2, cos(a.angle), sin(a.angle), b.x, b.y, b.radius);
    }
    const flipped = collideBoxCircle(b.x, b.y, b.width / 2, b.height / 2, cos(b.angle), sin(b.angle), a.x, a.y, a.radius);
    for (const contact of flipped) {
      contact.nx = -contact.nx;
      contact.ny = -contact.ny;
    }
    return flipped;
  }

  /** @param {number} dt The fixed step, in seconds. Feed it from createLoop. */
  function step(dt) {
    if (!(dt > 0)) return;

    // Gravity, awake dynamics only. A sleeping body is exactly still.
    for (const body of bodies) {
      if (body.static || body.sleeping) continue;
      body.vx += gravityX * dt;
      body.vy += gravityY * dt;
    }

    // Broadphase: insertion-ordered pairs, AABB-rejected. At the couple of
    // hundred bodies this module is for, n² beats any structure worth its
    // bookkeeping — and the fixed order is part of determinism.
    const arbiters = [];
    const nowTouching = new Set();
    const nextWarm = new Map();
    for (let i = 0; i < bodies.length; i += 1) {
      const a = bodies[i];
      const boxA = aabbOf(a);
      for (let j = i + 1; j < bodies.length; j += 1) {
        const b = bodies[j];
        if (a.static && b.static) continue;
        const key = a.id + ":" + b.id;
        const aAsleep = a.static || a.sleeping;
        const bAsleep = b.static || b.sleeping;
        if (aAsleep && bAsleep) {
          // Sleeping bodies have not moved, so whatever touched still does.
          // Carrying the key (and the warm impulses) forward is what stops a
          // woken stack re-firing a begin-contact event for every joint it
          // was already resting on, and what lets it wake without a jolt.
          if (touching.has(key)) nowTouching.add(key);
          const kept = warm.get(key);
          if (kept) nextWarm.set(key, kept);
          continue;
        }
        const boxB = aabbOf(b);
        // The AABBs are fattened a couple of pixels: a resting joint breathes
        // — separates by fractions of a pixel and re-touches — and a pair
        // that falls out of the broadphase on each breath loses its warm
        // impulses and its touching key, which reads as chatter and a fresh
        // hit every few steps.
        if (
          boxA.maxX + AABB_SLACK < boxB.minX || boxB.maxX + AABB_SLACK < boxA.minX ||
          boxA.maxY + AABB_SLACK < boxB.minY || boxB.maxY + AABB_SLACK < boxA.minY
        ) continue;
        const contacts = contactsBetween(a, b);
        if (contacts.length === 0) {
          // Still in each other's broad neighbourhood: a sub-pixel bounce at
          // a resting joint must not read as a brand-new hit, and its warm
          // impulses must survive to the re-touch or every breath lands cold.
          if (touching.has(key)) {
            nowTouching.add(key);
            const kept = warm.get(key);
            if (kept) nextWarm.set(key, kept);
          }
          continue;
        }
        // A sleeper wakes only for a partner that is actually moving. An
        // awake-but-still neighbour — one settling toward sleep itself — must
        // not keep resetting it, or a pile plays wake-tag forever and none of
        // it ever sleeps. A sleeper that stays asleep is solved as static
        // below, so whatever rests on it stays supported.
        if (a.sleeping && moving(b)) wake(a);
        if (b.sleeping && moving(a)) wake(b);
        nowTouching.add(key);
        arbiters.push({
          a,
          b,
          key,
          fresh: !touching.has(key),
          friction: Math.sqrt(a.friction * b.friction),
          restitution: a.restitution > b.restitution ? a.restitution : b.restitution,
          aInvMass: a.sleeping ? 0 : a.invMass,
          aInvInertia: a.sleeping ? 0 : a.invInertia,
          bInvMass: b.sleeping ? 0 : b.invMass,
          bInvInertia: b.sleeping ? 0 : b.invInertia,
          contacts,
        });
      }
    }

    // Presolve: effective masses, bias velocities, restitution targets.
    const inverseDt = 1 / dt;
    for (const arbiter of arbiters) {
      const { a, b, aInvMass, aInvInertia, bInvMass, bInvInertia } = arbiter;
      for (const contact of arbiter.contacts) {
        const rax = contact.x - a.x;
        const ray = contact.y - a.y;
        const rbx = contact.x - b.x;
        const rby = contact.y - b.y;
        const crossAN = rax * contact.ny - ray * contact.nx;
        const crossBN = rbx * contact.ny - rby * contact.nx;
        const tx = contact.ny;
        const ty = -contact.nx;
        const crossAT = rax * ty - ray * tx;
        const crossBT = rbx * ty - rby * tx;
        contact.rax = rax;
        contact.ray = ray;
        contact.rbx = rbx;
        contact.rby = rby;
        contact.massNormal = 1 / (aInvMass + bInvMass + crossAN * crossAN * aInvInertia + crossBN * crossBN * bInvInertia);
        contact.massTangent = 1 / (aInvMass + bInvMass + crossAT * crossAT * aInvInertia + crossBT * crossBT * bInvInertia);
        contact.bias = correction * inverseDt * Math.max(0, contact.penetration - slop);
        const approach =
          (b.vx - b.w * rby - a.vx + a.w * ray) * contact.nx +
          (b.vy + b.w * rbx - a.vy - a.w * rax) * contact.ny;
        // Restitution belongs to the moment of impact — the first step a
        // pair touches. A persistent joint deep in a settling stack sees
        // internal approach speeds too, and bouncing those injects energy
        // until the stack shakes itself apart; gating on freshness is what
        // keeps a cannonball lively and a pile still.
        contact.restitutionTarget = arbiter.fresh && approach < -bounceThreshold ? -arbiter.restitution * approach : 0;
        contact.approachSpeed = approach < 0 ? -approach : 0;
        contact.impulseNormal = 0;
        contact.impulseTangent = 0;
      }

      // Warm start: begin from last step's impulses at whichever cached point
      // sits nearest each new one (a resting contact barely moves between
      // steps). Restitution above was read from the untouched velocities, so
      // the order here does not change what a bounce aims for.
      const cached = warm.get(arbiter.key);
      if (cached) {
        for (const contact of arbiter.contacts) {
          let bestIndex = -1;
          let bestDistance = 4; // px², beyond which a point is a different feature
          for (let index = 0; index < cached.length; index += 1) {
            const old = cached[index];
            if (old.claimed) continue;
            const dx = old.x - contact.x;
            const dy = old.y - contact.y;
            const distance = dx * dx + dy * dy;
            if (distance < bestDistance) {
              bestDistance = distance;
              bestIndex = index;
            }
          }
          if (bestIndex < 0) continue;
          const old = cached[bestIndex];
          old.claimed = true;
          contact.impulseNormal = old.impulseNormal;
          contact.impulseTangent = old.impulseTangent;
          const px = contact.impulseNormal * contact.nx + contact.impulseTangent * contact.ny;
          const py = contact.impulseNormal * contact.ny - contact.impulseTangent * contact.nx;
          a.vx -= px * aInvMass;
          a.vy -= py * aInvMass;
          a.w -= (contact.rax * py - contact.ray * px) * aInvInertia;
          b.vx += px * bInvMass;
          b.vy += py * bInvMass;
          b.w += (contact.rbx * py - contact.rby * px) * bInvInertia;
        }
      }
    }

    // Sequential impulses. Accumulate and clamp, so an early over-correction
    // is taken back by a later iteration instead of adding energy.
    for (let iteration = 0; iteration < iterationCount; iteration += 1) {
      for (const arbiter of arbiters) {
        const { a, b, aInvMass, aInvInertia, bInvMass, bInvInertia } = arbiter;
        for (const contact of arbiter.contacts) {
          const { nx, ny, rax, ray, rbx, rby } = contact;
          let relX = b.vx - b.w * rby - a.vx + a.w * ray;
          let relY = b.vy + b.w * rbx - a.vy - a.w * rax;
          const alongNormal = relX * nx + relY * ny;
          const wantedNormal = contact.massNormal * (contact.bias + contact.restitutionTarget - alongNormal);
          const previousNormal = contact.impulseNormal;
          contact.impulseNormal = Math.max(0, previousNormal + wantedNormal);
          const applyNormal = contact.impulseNormal - previousNormal;
          a.vx -= applyNormal * nx * aInvMass;
          a.vy -= applyNormal * ny * aInvMass;
          a.w -= applyNormal * (rax * ny - ray * nx) * aInvInertia;
          b.vx += applyNormal * nx * bInvMass;
          b.vy += applyNormal * ny * bInvMass;
          b.w += applyNormal * (rbx * ny - rby * nx) * bInvInertia;

          relX = b.vx - b.w * rby - a.vx + a.w * ray;
          relY = b.vy + b.w * rbx - a.vy - a.w * rax;
          const tx = ny;
          const ty = -nx;
          const alongTangent = relX * tx + relY * ty;
          const wantedTangent = -contact.massTangent * alongTangent;
          const limit = arbiter.friction * contact.impulseNormal;
          const previousTangent = contact.impulseTangent;
          contact.impulseTangent = Math.min(limit, Math.max(-limit, previousTangent + wantedTangent));
          const applyTangent = contact.impulseTangent - previousTangent;
          a.vx -= applyTangent * tx * aInvMass;
          a.vy -= applyTangent * ty * aInvMass;
          a.w -= applyTangent * (rax * ty - ray * tx) * aInvInertia;
          b.vx += applyTangent * tx * bInvMass;
          b.vy += applyTangent * ty * bInvMass;
          b.w += applyTangent * (rbx * ty - rby * tx) * bInvInertia;
        }
      }
    }

    // Integrate, clamp, and count stillness toward sleep.
    for (const body of bodies) {
      if (body.static || body.sleeping) continue;
      const speedSq = body.vx * body.vx + body.vy * body.vy;
      if (speedSq > maxSpeed * maxSpeed) {
        const scale = maxSpeed / Math.sqrt(speedSq);
        body.vx *= scale;
        body.vy *= scale;
      }
      body.x += body.vx * dt;
      body.y += body.vy * dt;
      body.angle += body.w * dt;
      if (sleep) {
        const still =
          body.vx * body.vx + body.vy * body.vy < sleepLinearSq &&
          Math.abs(body.w) < sleepAngular;
        body.still = still ? body.still + 1 : 0;
        if (body.still >= sleepAfter) {
          body.sleeping = true;
          body.vx = 0;
          body.vy = 0;
          body.w = 0;
        }
      }
    }

    // A contact the last step did not have is a hit; its accumulated impulse
    // is how hard. Resting contact repeats every step and stays silent.
    for (const arbiter of arbiters) {
      if (!arbiter.fresh || arbiter.contacts.length === 0) continue;
      let impulse = 0;
      let atX = 0;
      let atY = 0;
      for (const contact of arbiter.contacts) {
        if (contact.impulseNormal > impulse) {
          impulse = contact.impulseNormal;
          atX = contact.x;
          atY = contact.y;
        }
      }
      let speed = 0;
      for (const contact of arbiter.contacts) {
        if (contact.approachSpeed > speed) speed = contact.approachSpeed;
      }
      events.push({
        type: "contact",
        a: arbiter.a.id,
        b: arbiter.b.id,
        impulse,
        speed,
        x: atX,
        y: atY,
      });
    }
    for (const arbiter of arbiters) {
      nextWarm.set(arbiter.key, arbiter.contacts.map((contact) => ({
        x: contact.x,
        y: contact.y,
        impulseNormal: contact.impulseNormal,
        impulseTangent: contact.impulseTangent,
        claimed: false,
      })));
    }
    warm = nextWarm;
    touching = nowTouching;

    // Cull what has clearly left the field.
    if (bounds) {
      for (let index = bodies.length - 1; index >= 0; index -= 1) {
        const body = bodies[index];
        if (body.static) continue;
        const box = aabbOf(body);
        if (
          box.maxX < bounds.minX - boundsMargin ||
          box.minX > bounds.maxX + boundsMargin ||
          box.maxY < bounds.minY - boundsMargin ||
          box.minY > bounds.maxY + boundsMargin
        ) {
          bodies.splice(index, 1);
          byId.delete(body.id);
          events.push({ type: "left", id: body.id, data: body.data });
        }
      }
    }
  }

  return {
    /** Insertion-ordered; read for rendering, do not reorder. */
    get bodies() { return bodies; },
    get count() { return bodies.length; },

    addBox,
    addCircle,

    /** @param {number} id */
    body(id) { return byId.get(id) ?? null; },

    /** @param {number} id @returns {boolean} whether anything was removed. */
    remove(id) {
      const body = byId.get(id);
      if (!body) return false;
      byId.delete(id);
      bodies.splice(bodies.indexOf(body), 1);
      return true;
    },

    clear() {
      bodies = [];
      byId = new Map();
      touching = new Set();
      warm = new Map();
      events = [];
    },

    step,

    /** @param {number} id */
    wake(id) { wake(byId.get(id)); },

    /**
     * An instantaneous impulse at a world point (the body centre when omitted).
     * Off-centre application spins the body, which is the point.
     * @param {number} id @param {number} ix @param {number} iy
     * @param {number} [px] @param {number} [py]
     */
    applyImpulse(id, ix, iy, px, py) {
      const body = byId.get(id);
      if (!body || body.static) return;
      wake(body);
      body.vx += ix * body.invMass;
      body.vy += iy * body.invMass;
      if (px !== undefined && py !== undefined) {
        body.w += ((px - body.x) * iy - (py - body.y) * ix) * body.invInertia;
      }
    },

    /**
     * A radial blast: every dynamic body whose surface lies within `radius`
     * takes an impulse away from the centre, scaled by how close it stands
     * and applied at its nearest point — which is what tips and spins a
     * crate instead of sliding it out like a puck.
     *
     * @param {object} blast
     * @param {number} blast.x @param {number} blast.y
     * @param {number} blast.radius
     * @param {number} blast.impulse Impulse at the centre, falling off
     *        linearly to zero at the radius.
     * @returns {number} how many bodies it reached.
     */
    explode({ x, y, radius, impulse }) {
      if (!(radius > 0) || !impulse) return 0;
      let reached = 0;
      for (const body of bodies) {
        if (body.static) continue;
        const nearest = body.shape === "circle"
          ? nearestOnCircle(x, y, body)
          : closestOnBox(x, y, body.x, body.y, body.width / 2, body.height / 2, cos(body.angle), sin(body.angle));
        const gapX = nearest.x - x;
        const gapY = nearest.y - y;
        const distance = Math.sqrt(gapX * gapX + gapY * gapY);
        if (distance >= radius) continue;
        let directionX = body.x - x;
        let directionY = body.y - y;
        const length = Math.sqrt(directionX * directionX + directionY * directionY);
        if (length > 0) {
          directionX /= length;
          directionY /= length;
        } else {
          // Blast dead centre: straight up, the same on every machine.
          directionX = 0;
          directionY = -1;
        }
        const strength = impulse * (1 - distance / radius);
        wake(body);
        body.vx += directionX * strength * body.invMass;
        body.vy += directionY * strength * body.invMass;
        body.w += ((nearest.x - body.x) * directionY * strength - (nearest.y - body.y) * directionX * strength) * body.invInertia;
        reached += 1;
      }
      return reached;
    },

    /**
     * The topmost body containing a world point — topmost meaning latest
     * added, which is also what a painter's-order renderer drew on top.
     * @param {number} x @param {number} y
     */
    bodyAt(x, y) {
      for (let index = bodies.length - 1; index >= 0; index -= 1) {
        const body = bodies[index];
        if (body.shape === "circle") {
          const dx = x - body.x;
          const dy = y - body.y;
          if (dx * dx + dy * dy <= body.radius * body.radius) return body;
        } else if (pointInBox(x, y, body.x, body.y, body.width / 2, body.height / 2, cos(body.angle), sin(body.angle))) {
          return body;
        }
      }
      return null;
    },

    /**
     * Everything noteworthy since the last drain, oldest first:
     * `{type: "contact", a, b, impulse, speed, x, y}` the first step a pair
     * touches (resting contact stays silent), and `{type: "left", id, data}`
     * when bounds culling removes a body. Drive sounds and effects from
     * these — never from inside the step.
     */
    drainEvents() {
      const drained = events;
      events = [];
      return drained;
    },

    /** Plain data. `data` fields ride along by reference. */
    snapshot() {
      return {
        nextId,
        touching: [...touching],
        // The warm-start impulses are simulation state: leave them out and a
        // restored run solves its first step cold, which is different bits.
        warm: [...warm.entries()].map(([key, contacts]) => [
          key,
          contacts.map((contact) => ({
            x: contact.x,
            y: contact.y,
            impulseNormal: contact.impulseNormal,
            impulseTangent: contact.impulseTangent,
          })),
        ]),
        bodies: bodies.map((body) => ({ ...body })),
      };
    },

    /** @param {{nextId: number, touching: string[], warm?: any[], bodies: any[]}} snap */
    restore(snap) {
      nextId = snap.nextId;
      touching = new Set(snap.touching);
      warm = new Map((snap.warm ?? []).map(([key, contacts]) => [
        key,
        contacts.map((contact) => ({ ...contact, claimed: false })),
      ]));
      bodies = snap.bodies.map((body) => ({ ...body }));
      byId = new Map(bodies.map((body) => [body.id, body]));
      events = [];
    },
  };

  function nearestOnCircle(px, py, body) {
    const dx = px - body.x;
    const dy = py - body.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance <= body.radius || distance === 0) return { x: px, y: py };
    return {
      x: body.x + (dx / distance) * body.radius,
      y: body.y + (dy / distance) * body.radius,
    };
  }
}
