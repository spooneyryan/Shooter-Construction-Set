// The siege: what a run of a cannon level does.
//
// `../physics` owns motion — stacking, toppling, impacts, sleeping,
// explosions. This file owns the game around it: whose turn it is, what a
// shot costs, how a first-touch impulse becomes damage, when a block breaks
// or detonates, what scores, and how the round ends. The 2026-08-28 demo
// wrote all of this inline; this is that game as a package, so the next
// consumer does not write it again.
//
// The same contract as every world here. **Data in, state out** — nothing
// draws, nothing reads a clock, and everything noteworthy is a queued event
// the renderer drains and answers however it likes. **Deterministic** — the
// engine underneath is already guarded, and this layer adds arithmetic,
// comparisons, and `core/trig` only, so the banned-Math test covers the
// whole stack. **It snapshots** — the physics snapshot rides inside the
// genre's, plain data all the way down, because rollback cannot be
// retrofitted.
//
// The damage model is the engine's event stream read literally: a contact is
// reported once, on the first step a pair touches, carrying the hit's
// impulse — resting contact stays silent — so accumulating those impulses
// per block is sane by construction. A stack sitting still takes no damage,
// ever, and the `bruise` floor keeps settle-noise taps out of the tally.

import { atan2, cos, normalizeAngle, sin } from "../core/trig.js";
import { closestOnBox } from "../physics/shapes.js";
import { createPhysicsWorld } from "../physics/world.js";
import { cannonMaterialTable, normalizeCannonLevel } from "./contract.js";

/**
 * @param {import("./contract.js").CannonLevel | object} level Normalized or
 *        raw — `normalizeCannonLevel` runs here either way, so a bare
 *        JSON.parse is a legal input, just not a trusted one.
 * @param {object} [options]
 * @param {number} [options.players] Seats, 1 or 2. Seats map onto the
 *        level's cannons in order; two seats with one cannon share it.
 */
export function createSiege(level, { players = 1 } = {}) {
  const spec = normalizeCannonLevel(level);
  const seats = Math.max(1, Math.min(2, Math.round(players) || 1));
  const table = cannonMaterialTable(spec.materials);

  const world = createPhysicsWorld({
    gravity: spec.gravity,
    // The field is also the culling bounds: what leaves it is gone, and a
    // target that leaves counts as destroyed — knocked off the tower is as
    // dead as broken on it.
    bounds: { minX: 0, minY: 0, maxX: spec.width, maxY: spec.height },
  });

  if (spec.floor) {
    // A static apron along the bottom, overhanging the sides so nothing
    // slides off the end of the world's floor before the bounds cull it.
    world.addBox({
      x: spec.width / 2,
      y: spec.height - 20,
      width: spec.width * 3,
      height: 40,
      static: true,
      friction: 0.8,
    });
  }

  /**
   * Mutable per-block game state, keyed by body id. The body's `data`
   * carries only `{kind, index}` — the engine holds it by reference and
   * never touches it, so everything that changes lives here and snapshots
   * here.
   * @type {Map<number, {index: number, material: string, damage: number, target: boolean}>}
   */
  const blocksAlive = new Map();
  let startingTargets = 0;
  spec.blocks.forEach((block, index) => {
    const material = table[block.material];
    const common = {
      x: block.x,
      y: block.y,
      angle: block.angle,
      static: block.static,
      density: material.density,
      friction: material.friction,
      restitution: material.restitution,
      data: { kind: "block", index },
    };
    const body = block.shape === "circle"
      ? world.addCircle({ ...common, radius: block.radius })
      : world.addBox({ ...common, width: block.width, height: block.height });
    // Static blocks are terrain: unbreakable in v1, so they are not tracked.
    if (!block.static) {
      blocksAlive.set(body.id, { index, material: block.material, damage: 0, target: block.target });
      if (block.target) startingTargets += 1;
    }
  });

  const seatStates = [];
  for (let seat = 0; seat < seats; seat += 1) {
    const cannon = spec.cannons[seat % spec.cannons.length];
    seatStates.push({
      seat,
      // The barrel starts mid-arc at a middling charge, and a centred stick
      // leaves it there: aim is a delta from the last instruction, never an
      // assignment from nothing.
      angle: (cannon.minAngle + cannon.maxAngle) / 2,
      power: 0.6,
      shotsLeft: cannon.shots,
      score: 0,
      // Last tick's fire bit, for the rising edge. Simulation state — it
      // decides what a step does, so it snapshots with everything else.
      firing: false,
    });
  }

  const state = {
    tick: 0,
    /** Whose fire is honored. Advances when the live shot resolves. */
    turn: 0,
    /** "" while playing, then "won" | "lost". A level with no targets is a
     *  sandbox and ends neither way. */
    outcome: "",
    targetsLeft: startingTargets,
    /** The one shot allowed in flight: `{id, seat, ticksLeft}` or null. */
    liveShot: null,
    /** Everything that breaks attributes to the seat that fired last —
     *  chains included, which is the honest reading of a chain. */
    lastShooter: -1,
    players: seatStates,
  };

  /** @type {any[]} presentation events, drained by the renderer. */
  let queued = [];

  function applyAim(seatState, cannon, aim) {
    const x = Number(aim && aim.x) || 0;
    const y = Number(aim && aim.y) || 0;
    const magnitude = Math.sqrt(x * x + y * y);
    // Centred means "no new instruction" — the barrel and charge hold.
    if (magnitude === 0) return;
    // Clamp into the arc through its centre, so an arc crossing ±π (a
    // left-facing cannon) is as safe as any other.
    const centre = (cannon.minAngle + cannon.maxAngle) / 2;
    const half = (cannon.maxAngle - cannon.minAngle) / 2;
    let delta = normalizeAngle(atan2(y, x) - centre);
    if (delta < -half) delta = -half;
    if (delta > half) delta = half;
    seatState.angle = centre + delta;
    seatState.power = magnitude > 1 ? 1 : magnitude;
  }

  function fireShot(seatState, cannon) {
    const speed = cannon.minPower + (cannon.maxPower - cannon.minPower) * seatState.power;
    const directionX = cos(seatState.angle);
    const directionY = sin(seatState.angle);
    const ball = world.addCircle({
      x: cannon.x + directionX * cannon.barrel,
      y: cannon.y + directionY * cannon.barrel,
      radius: cannon.ballRadius,
      density: cannon.ballDensity,
      friction: 0.3,
      restitution: 0.25,
      velocity: { x: directionX * speed, y: directionY * speed },
      data: { kind: "ball", seat: seatState.seat },
    });
    seatState.shotsLeft -= 1;
    state.liveShot = { id: ball.id, seat: seatState.seat, ticksLeft: spec.rules.settleTicks };
    state.lastShooter = seatState.seat;
    queued.push({ type: "fired", seat: seatState.seat, x: ball.x, y: ball.y, angle: seatState.angle, speed });
  }

  /** The turn passes when the fired ball is asleep, gone, or out of time. */
  function resolveShot() {
    if (!state.liveShot) return;
    state.liveShot = null;
    if (state.outcome === "") state.turn = (state.turn + 1) % seats;
  }

  function award(points) {
    if (state.lastShooter >= 0 && points > 0) seatStates[state.lastShooter].score += points;
  }

  /** The nearest point of a body to a blast centre — the engine's own rule,
   *  so the damage falloff and the launch falloff agree about distance. */
  function nearestPointOn(body, x, y) {
    if (body.shape === "circle") {
      const dx = x - body.x;
      const dy = y - body.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance <= body.radius || distance === 0) return { x, y };
      return { x: body.x + (dx / distance) * body.radius, y: body.y + (dy / distance) * body.radius };
    }
    return closestOnBox(x, y, body.x, body.y, body.width / 2, body.height / 2, cos(body.angle), sin(body.angle));
  }

  /** Registry, score, targets, and the one event that reports it. */
  function destroyBlock(id, entry, event) {
    blocksAlive.delete(id);
    const material = table[entry.material];
    award(material.points);
    if (entry.target) state.targetsLeft -= 1;
    queued.push({
      material: entry.material,
      target: entry.target,
      points: material.points,
      index: entry.index,
      ...event,
    });
  }

  /**
   * @param {number} dt The fixed step, seconds. Must be the same every call
   *        and the same on every machine — it is part of the simulation.
   * @param {Array<import("./contract.js").CannonInput | undefined>} [inputs]
   *        One per seat. A missing entry reads as neutral.
   */
  function step(dt, inputs = []) {
    if (!(dt > 0)) return;

    for (let seat = 0; seat < seats; seat += 1) {
      const input = inputs[seat];
      const seatState = seatStates[seat];
      const cannon = spec.cannons[seat % spec.cannons.length];
      if (input) applyAim(seatState, cannon, input.aim);
      const pressed = input ? input.fire === true : false;
      const rising = pressed && !seatState.firing;
      seatState.firing = pressed;
      if (
        rising &&
        state.outcome === "" &&
        seat === state.turn &&
        !state.liveShot &&
        seatState.shotsLeft > 0
      ) {
        fireShot(seatState, cannon);
      }
    }

    world.step(dt);

    // The engine's events become the game's consequences. Deferred into
    // queues so a block hit twice in one step breaks once, in event order.
    const detonating = [];
    const breaking = [];
    for (const event of world.drainEvents()) {
      if (event.type === "left") {
        const data = event.data;
        if (data && data.kind === "ball") {
          if (state.liveShot && state.liveShot.id === event.id) resolveShot();
        } else if (data && data.kind === "block") {
          const entry = blocksAlive.get(event.id);
          // The body is already gone; the block died by falling off.
          if (entry) destroyBlock(event.id, entry, { type: "broke", fell: true });
        }
        continue;
      }
      if (event.impulse >= spec.rules.bruise) {
        queued.push({ type: "hit", impulse: event.impulse, speed: event.speed, x: event.x, y: event.y });
      }
      for (const id of [event.a, event.b]) {
        const entry = blocksAlive.get(id);
        if (!entry) continue;
        const material = table[entry.material];
        if (material.threshold !== undefined) {
          // TNT never bruises: one hit above the threshold, or nothing.
          if (event.impulse >= material.threshold) detonating.push(id);
        } else if (material.strength !== null && event.impulse >= spec.rules.bruise) {
          entry.damage += event.impulse;
          if (entry.damage >= material.strength) breaking.push(id);
        }
      }
    }

    // An index loop, because a chain grows the queue while it drains: a
    // charge inside a blast joins the end and detonates in the same step,
    // so a chain's shape is decided by the level, never by how the pieces
    // would later have happened to land.
    for (let next = 0; next < detonating.length; next += 1) {
      const id = detonating[next];
      const entry = blocksAlive.get(id);
      const body = world.body(id);
      if (!entry || !body) continue; // already destroyed this step
      const material = table[entry.material];
      world.remove(id);
      destroyBlock(id, entry, { type: "detonated", x: body.x, y: body.y, radius: material.radius });
      // The blast is a damage event as well as a launch: every breakable
      // block inside the radius takes the same linearly-falling impulse the
      // engine is about to push it with, measured to its nearest surface —
      // so TNT beside a wall matters even when nothing moves far.
      for (const other of world.bodies) {
        if (other.static) continue;
        const struck = blocksAlive.get(other.id);
        if (!struck) continue;
        const otherMaterial = table[struck.material];
        const nearest = nearestPointOn(other, body.x, body.y);
        const gapX = nearest.x - body.x;
        const gapY = nearest.y - body.y;
        const distance = Math.sqrt(gapX * gapX + gapY * gapY);
        if (distance >= material.radius) continue;
        const felt = material.impulse * (1 - distance / material.radius);
        if (otherMaterial.threshold !== undefined) {
          if (felt >= otherMaterial.threshold) detonating.push(other.id);
        } else if (otherMaterial.strength !== null && felt >= spec.rules.bruise) {
          struck.damage += felt;
          if (struck.damage >= otherMaterial.strength) breaking.push(other.id);
        }
      }
      world.explode({ x: body.x, y: body.y, radius: material.radius, impulse: material.impulse });
    }
    for (const id of breaking) {
      const entry = blocksAlive.get(id);
      const body = world.body(id);
      if (!entry || !body) continue;
      world.remove(id);
      destroyBlock(id, entry, { type: "broke", x: body.x, y: body.y });
    }

    if (state.liveShot) {
      const ball = world.body(state.liveShot.id);
      if (!ball || ball.sleeping) {
        resolveShot();
      } else {
        state.liveShot.ticksLeft -= 1;
        if (state.liveShot.ticksLeft <= 0) resolveShot();
      }
    }

    if (state.outcome === "") {
      if (startingTargets > 0 && state.targetsLeft === 0) {
        state.outcome = "won";
        // Unspent ammunition is worth something — it is the whole reason to
        // aim rather than spray.
        for (const seatState of seatStates) {
          seatState.score += seatState.shotsLeft * spec.rules.shotBonus;
        }
        queued.push({ type: "won", scores: seatStates.map((seatState) => seatState.score) });
      } else if (
        startingTargets > 0 &&
        !state.liveShot &&
        seatStates.every((seatState) => seatState.shotsLeft === 0)
      ) {
        state.outcome = "lost";
        queued.push({ type: "lost", targetsLeft: state.targetsLeft });
      }
    }

    state.tick += 1;
  }

  return {
    /** Live and mutable — read it, do not write it. */
    get state() { return state; },
    /** The level as the run plays it: normalized, materials merged. */
    get level() { return spec; },
    get materials() { return table; },
    /**
     * The engine underneath, exposed for rendering — `physics.bodies` is
     * the draw list, and a body's `data` says which block it is. Do not
     * step or mutate it directly; that is the one way to desync a pair.
     */
    get physics() { return world; },

    step,

    /**
     * Which block a body id is — `{index, material, target}` for a living
     * block, null for anything else (balls, terrain, the destroyed). What a
     * renderer colours by, so it never has to reach into `data`.
     */
    blockInfo(id) {
      const entry = blocksAlive.get(id);
      if (!entry) return null;
      return { index: entry.index, material: entry.material, target: entry.target };
    },

    /**
     * Remaining strength of a block's body id as a 0..1 fraction — 1 for
     * the unbreakable and for TNT (which does not bruise). A renderer's
     * crack tint; not simulation state.
     */
    blockHealth(id) {
      const entry = blocksAlive.get(id);
      if (!entry) return 0;
      const material = table[entry.material];
      if (material.strength === null || material.threshold !== undefined) return 1;
      const left = 1 - entry.damage / material.strength;
      return left < 0 ? 0 : left;
    },

    /**
     * Everything noteworthy since the last drain, oldest first: `fired`,
     * `hit`, `broke` (with `fell: true` when the bounds took it),
     * `detonated`, `won`, `lost`. Drive sounds and effects from these —
     * never from inside the step.
     */
    drainEvents() {
      const drained = queued;
      queued = [];
      return drained;
    },

    /** Plain data all the way down; survives JSON. */
    snapshot() {
      return {
        physics: world.snapshot(),
        tick: state.tick,
        turn: state.turn,
        outcome: state.outcome,
        targetsLeft: state.targetsLeft,
        lastShooter: state.lastShooter,
        liveShot: state.liveShot ? { ...state.liveShot } : null,
        seats: seatStates.map((seatState) => ({ ...seatState })),
        blocks: [...blocksAlive.entries()].map(([id, entry]) => ({ id, ...entry })),
      };
    },

    restore(snap) {
      world.restore(snap.physics);
      state.tick = snap.tick;
      state.turn = snap.turn;
      state.outcome = snap.outcome;
      state.targetsLeft = snap.targetsLeft;
      state.lastShooter = snap.lastShooter;
      state.liveShot = snap.liveShot ? { ...snap.liveShot } : null;
      snap.seats.forEach((saved, index) => Object.assign(seatStates[index], saved));
      blocksAlive.clear();
      for (const saved of snap.blocks) {
        blocksAlive.set(saved.id, {
          index: saved.index,
          material: saved.material,
          damage: saved.damage,
          target: saved.target,
        });
      }
      queued = [];
    },
  };
}
