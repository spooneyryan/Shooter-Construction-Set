// The ride: one course, one to four seats, and the rules that make it a
// game rather than a physics demo.
//
// The split this module is built on: `vehicle.js` knows about forces and
// nothing about scoring, and everything a substep must not see twice —
// lives, checkpoints, the clock, the wreck timer, events — lives out here
// and runs once per step. That is not tidiness. A rollback re-runs steps,
// and anything counted inside a substep would be counted `substeps` times
// the first time and again on every correction.
//
// **Both games are this one loop.** `patrol` turns the guns on, gives the
// buggy lives and a course clock, and wakes flying and rolling props as
// the camera reaches them; `trials` turns the guns off, makes a wreck a
// checkpoint restart with a time penalty, and lets the clock run. Nothing
// below branches on the flavour more than a handful of times, which is the
// evidence for the decision to build one module instead of two.

import { cos, hypot, sin } from "../core/trig.js";
import {
  WHEELS_SURFACES,
  neutralWheelsInput,
  normalizeWheelsCourse,
} from "./contract.js";
import { buildWheelsTerrain, terrainHeightAt, terrainSurfaceAt } from "./terrain.js";
import { createWheelsRider, seatWheelsRider, stepWheelsRider, wheelsCrashPoints } from "./vehicle.js";

/** How far a player's shot travels per second, and how long it lives. */
const WHEELS_SHOT_SPEED = 620;
const WHEELS_SHOT_LIFE = 2.2;
/** A dropped bomb starts with the ship's speed and gains gravity. */
const WHEELS_BOMB_SPEED = 210;
/** Seconds between a seat's shots. Both guns share the cooldown. */
const WHEELS_FIRE_EVERY = 0.22;
/** How far past the last point of ground the finish line sits. */
const WHEELS_FINISH_INSET = 40;
/** Where a rider starts, and where a course with no checkpoints restarts. */
const WHEELS_START_INSET = 60;
/** Substeps off the ground before a touchdown counts as a landing. */
const WHEELS_JUMP_TICKS = 8;
/** How far below the chassis centre the forward gun sits. */
const WHEELS_GUN_DROP = 8;

function wheelsBoxesOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
  return Math.abs(ax - bx) * 2 < aw + bw && Math.abs(ay - by) * 2 < ah + bh;
}

/**
 * Create a ride over a course.
 *
 * @param {any} course Raw or normalized; it is normalized either way, so
 *        a half-finished document from an editor loads rather than throws.
 * @param {object} [options]
 * @param {number} [options.players] Seats, 1..4. Every seat rides the same
 *        course from the same start; co-op and versus are the same world.
 */
export function createRide(course, { players = 1 } = {}) {
  const spec = normalizeWheelsCourse(course);
  const seats = Math.max(1, Math.min(4, Math.round(players) || 1));
  const feel = spec.feel;
  const vehicle = spec.vehicle;
  const terrain = buildWheelsTerrain(spec.ground);
  const startX = terrain.minX + WHEELS_START_INSET;
  const finishX = terrain.maxX - WHEELS_FINISH_INSET;
  /** Below this a rider has left the world, whatever the ground was doing. */
  const floorY = terrain.maxY + 600;

  let nextId = 1;
  const makeId = () => nextId++;

  /** @type {any[]} */
  let queued = [];
  const emit = (event) => { queued.push(event); };

  /** Where seat `seat` restarts: its last checkpoint, or the start. */
  const restartX = (rider) => (rider.checkpoint > 0 ? spec.checkpoints[rider.checkpoint - 1] : startX);

  const spawnRider = (seat) => {
    const rider = createWheelsRider(vehicle, startX, 0);
    seatWheelsRider(rider, vehicle, terrain, startX, feel.gravity);
    rider.vx = spec.rules.startSpeed;
    return Object.assign(rider, {
      seat,
      lives: spec.rules.lives,
      score: 0,
      faults: 0,
      checkpoint: 0,
      furthest: startX,
      finished: false,
      finishTime: 0,
      wreckTicks: 0,
      graceTicks: spec.rules.checkpointGrace,
      fireTicks: 0,
      jumpHeld: false,
      resetHeld: false,
    });
  };

  /** @type {any[]} */
  let riders = Array.from({ length: seats }, (_, seat) => spawnRider(seat));
  /** @type {any[]} */
  let props = spec.props.map((prop, index) => ({
    id: makeId(),
    def: index,
    x: prop.x,
    y: terrainHeightAt(terrain, prop.x) - prop.height - prop.tall / 2,
    health: prop.health,
    alive: true,
    awake: false,
    fireTimer: prop.fireEvery,
  }));
  /** @type {any[]} */
  let shots = [];

  const state = {
    tick: 0,
    time: 0,
    outcome: /** @type {"playing" | "won" | "lost"} */ ("playing"),
    camera: { x: startX, y: terrainHeightAt(terrain, startX) - 80 },
    riders,
    props,
    shots,
  };

  const wreck = (rider, reason) => {
    if (rider.wreckTicks > 0 || rider.finished || rider.graceTicks > 0) return;
    rider.wreckTicks = feel.wreckTicks;
    rider.faults += 1;
    emit({ type: "wreck", seat: rider.seat, reason, x: rider.x, y: rider.y });
  };

  const respawn = (rider) => {
    if (spec.flavour === "patrol") {
      rider.lives -= 1;
      if (rider.lives <= 0) {
        emit({ type: "out", seat: rider.seat });
        rider.finished = true;
        rider.finishTime = state.time;
        return;
      }
    }
    seatWheelsRider(rider, vehicle, terrain, restartX(rider), feel.gravity);
    rider.vx = spec.rules.startSpeed;
    rider.graceTicks = spec.rules.checkpointGrace;
    emit({ type: "respawn", seat: rider.seat, x: rider.x, lives: rider.lives });
  };

  // The whole vehicle as an axis-aligned box: the top of the body down to
  // the bottom of the tyres, measured once because it cannot change.
  //
  // Down to the TYRES, not to the chassis. A box that stopped at the body
  // left a gap the height of the suspension underneath, and a mine lying
  // on the road drove straight through it — the one obstacle in Moon
  // Patrol you are most obviously supposed to hit. Rotation is ignored
  // here on purpose: a prop is a thing you drove into, and a swept
  // rectangle would be precision the outcome does not use.
  const boxTop = vehicle.drop - vehicle.height / 2;
  const boxBottom = vehicle.wheels.reduce(
    (low, wheel) => Math.max(low, wheel.y + wheel.rest + wheel.radius),
    vehicle.drop + vehicle.height / 2,
  );
  const riderBox = (rider) => ({
    x: rider.x,
    y: rider.y + (boxTop + boxBottom) / 2,
    w: vehicle.width,
    h: boxBottom - boxTop,
  });

  const fire = (rider, up) => {
    if (spec.flavour !== "patrol" || rider.fireTicks > 0) return;
    rider.fireTicks = Math.max(1, Math.round(WHEELS_FIRE_EVERY * 60));
    // The muzzle is bolted to the chassis, so it rides and pitches with it.
    // The forward gun sits low — a rock is a thing on the ground, and a
    // barrel level with the driver's eyeline shoots straight over one.
    const cosA = cos(rider.angle);
    const sinA = sin(rider.angle);
    const muzzleX = up ? 0 : vehicle.nose;
    const muzzleY = up ? -vehicle.height : WHEELS_GUN_DROP;
    shots.push({
      id: makeId(),
      seat: rider.seat,
      x: rider.x + muzzleX * cosA - muzzleY * sinA,
      y: rider.y + muzzleX * sinA + muzzleY * cosA,
      vx: up ? 0 : WHEELS_SHOT_SPEED + Math.max(0, rider.vx),
      vy: up ? -WHEELS_SHOT_SPEED : 0,
      life: WHEELS_SHOT_LIFE,
      hostile: false,
    });
    emit({ type: "shot", seat: rider.seat, up });
  };

  const stepProps = (dt) => {
    for (let index = 0; index < props.length; index += 1) {
      const live = props[index];
      if (!live.alive) continue;
      const def = spec.props[live.def];
      if (!live.awake) {
        if (live.x > state.camera.x + feel.activateAhead) continue;
        live.awake = true;
        emit({ type: "wake", id: live.id, kind: def.kind, x: live.x });
      }
      if (def.speed !== 0) {
        live.x += def.speed * dt;
        // A ground enemy keeps its feet; a flyer keeps its altitude above
        // whatever it happens to be over, which is what makes a UFO follow
        // the horizon the way the original's does.
        live.y = terrainHeightAt(terrain, live.x) - def.height - def.tall / 2;
      }
      if (def.fireEvery > 0) {
        live.fireTimer -= dt;
        if (live.fireTimer <= 0) {
          live.fireTimer = def.fireEvery;
          const downward = def.kind === "ufo";
          shots.push({
            id: makeId(),
            seat: -1,
            x: live.x,
            y: live.y + (downward ? def.tall / 2 : 0),
            vx: downward ? def.speed : -WHEELS_SHOT_SPEED * 0.55,
            vy: downward ? WHEELS_BOMB_SPEED : 0,
            life: WHEELS_SHOT_LIFE * 2,
            hostile: true,
          });
          emit({ type: "enemyShot", id: live.id, kind: def.kind, x: live.x, y: live.y });
        }
      }
    }
  };

  const stepShots = (dt) => {
    const kept = [];
    for (const shot of shots) {
      shot.life -= dt;
      shot.x += shot.vx * dt;
      shot.y += shot.vy * dt;
      // A bomb falls; a bullet flies flat. One branch beats two shot kinds.
      if (shot.hostile && shot.vy > 0) shot.vy += feel.gravity * dt;
      if (shot.life <= 0) continue;
      if (shot.y > terrainHeightAt(terrain, shot.x)) {
        emit({ type: "shotEnded", x: shot.x, y: shot.y, hostile: shot.hostile });
        continue;
      }

      let consumed = false;
      if (shot.hostile) {
        for (const rider of riders) {
          if (rider.wreckTicks > 0 || rider.finished) continue;
          const box = riderBox(rider);
          if (wheelsBoxesOverlap(shot.x, shot.y, 6, 6, box.x, box.y, box.w, box.h)) {
            wreck(rider, "shot");
            consumed = true;
            break;
          }
        }
      } else {
        for (const live of props) {
          if (!live.alive || !live.awake) continue;
          const def = spec.props[live.def];
          if (!def.shootable) continue;
          if (!wheelsBoxesOverlap(shot.x, shot.y, 6, 6, live.x, live.y, def.width, def.tall)) continue;
          live.health -= 1;
          consumed = true;
          if (live.health <= 0) {
            live.alive = false;
            const owner = riders[shot.seat];
            if (owner) owner.score += def.points;
            emit({ type: "destroyed", id: live.id, kind: def.kind, x: live.x, y: live.y, seat: shot.seat, points: def.points });
          } else {
            emit({ type: "hit", id: live.id, x: live.x, y: live.y });
          }
          break;
        }
      }
      if (!consumed) kept.push(shot);
    }
    shots.length = 0;
    for (const shot of kept) shots.push(shot);
    state.shots = shots;
  };

  const touchProps = (rider) => {
    const box = riderBox(rider);
    for (const live of props) {
      if (!live.alive || !live.awake) continue;
      const def = spec.props[live.def];
      if (!def.solid) continue;
      if (!wheelsBoxesOverlap(box.x, box.y, box.w, box.h, live.x, live.y, def.width, def.tall)) continue;
      // A mine is spent on the vehicle that finds it; a rock is not.
      if (def.kind === "mine") {
        live.alive = false;
        emit({ type: "destroyed", id: live.id, kind: def.kind, x: live.x, y: live.y, seat: -1, points: 0 });
      }
      wreck(rider, def.kind);
      return;
    }
  };

  const stepRider = (rider, input, dt) => {
    if (rider.finished) return;

    if (rider.wreckTicks > 0) {
      rider.wreckTicks -= 1;
      if (rider.wreckTicks === 0) respawn(rider);
      return;
    }
    if (rider.graceTicks > 0) rider.graceTicks -= 1;
    if (rider.fireTicks > 0) rider.fireTicks -= 1;

    // Restart: the trials button, and an honest way out of a rover wedged
    // nose-down in a crater. It costs whatever a wreck costs.
    if (input.reset && !rider.resetHeld) wreck(rider, "reset");
    rider.resetHeld = input.reset === true;
    if (rider.wreckTicks > 0) return;

    const substeps = feel.substeps;
    const h = dt / substeps;
    // How long the vehicle had been off the ground before this step. The
    // landing-angle rule reads it, because a wheel skipping over a bump
    // technically "lands" every few substeps, and judging those the way a
    // jump is judged wrecks a rider for crossing rough ground upright.
    const airBefore = rider.airTicks;
    let landed = false;
    let fatal = false;
    let bodyHit = false;
    let impact = 0;
    let grounded = false;

    for (let step = 0; step < substeps; step += 1) {
      const report = stepWheelsRider(rider, vehicle, terrain, feel, input, h);
      if (report.landed) landed = true;
      if (report.fatal) fatal = true;
      if (report.bodyHit) bodyHit = true;
      if (report.grounded) grounded = true;
      if (report.impact > impact) impact = report.impact;
    }

    // The hop. Rising edge, on the ground, along the chassis's up axis, so
    // a rover on a slope leaves it perpendicular the way the original's
    // does rather than always straight up.
    if (input.jump && !rider.jumpHeld && grounded && vehicle.jump > 0) {
      const cosA = cos(rider.angle);
      const sinA = sin(rider.angle);
      rider.vx += sinA * vehicle.jump;
      rider.vy -= cosA * vehicle.jump;
      emit({ type: "jump", seat: rider.seat, x: rider.x, y: rider.y });
    }
    rider.jumpHeld = input.jump === true;

    if (landed) {
      emit({ type: "land", seat: rider.seat, x: rider.x, y: rider.y, impact });
      // The landing rule, and the whole reason speed has to be controlled:
      // arriving sideways is survivable, arriving upside down is not.
      if (airBefore >= WHEELS_JUMP_TICKS && Math.abs(rider.angle) > vehicle.rollTolerance) {
        wreck(rider, "angle");
      }
    }
    if (bodyHit) wreck(rider, "body");
    if (fatal) wreck(rider, "surface");
    if (rider.y > floorY) wreck(rider, "fell");
    // The GUNS are the patrol flavour's; the props are not. Driving into a
    // rock has to hurt whatever the course calls itself, because a prop
    // list is legal on either flavour, both demos draw whatever is in it,
    // and the enemy shots below have never had a flavour guard — so
    // gating this made a trials course where a tank's bullets killed you
    // and the tank itself did not exist.
    if (spec.flavour === "patrol") {
      if (input.fireForward) fire(rider, false);
      if (input.fireUp) fire(rider, true);
    }
    touchProps(rider);

    if (rider.x > rider.furthest) rider.furthest = rider.x;
    while (rider.checkpoint < spec.checkpoints.length && rider.x >= spec.checkpoints[rider.checkpoint]) {
      rider.checkpoint += 1;
      emit({ type: "checkpoint", seat: rider.seat, index: rider.checkpoint, time: state.time });
    }
    // Not while wrecked. `wreck` and the finish check both run in this one
    // pass, so a rider who landed badly ON the line used to collect a
    // `wreck` and a `finish` on the same tick: the wreck was then never
    // paid — no life lost, no restart — and `finished` froze the rider
    // with a wreck timer that could never tick down. Wrecking on the line
    // costs the last stretch, the same as wrecking anywhere else.
    if (rider.wreckTicks === 0 && rider.x >= finishX) {
      rider.finished = true;
      rider.finishTime = state.time + rider.faults * spec.rules.faultPenalty;
      emit({ type: "finish", seat: rider.seat, time: rider.finishTime, faults: rider.faults, score: rider.score });
    }
  };

  const stepCamera = (dt) => {
    // The camera is simulation, not presentation, because it decides when
    // a prop wakes. Two machines whose cameras drifted would wake the same
    // UFO on different ticks, which is a desync with a very long fuse.
    let leader = riders[0];
    for (const rider of riders) if (rider.x > leader.x) leader = rider;
    const ahead = feel.cameraAhead * Math.max(-0.4, Math.min(1, leader.vx / vehicle.topSpeed));
    const targetX = leader.x + ahead;
    const targetY = leader.y - feel.cameraLift;
    const ease = Math.min(1, feel.cameraEase * dt);
    state.camera.x += (targetX - state.camera.x) * ease;
    state.camera.y += (targetY - state.camera.y) * ease;
  };

  return {
    /** The normalized course. Read-only; the ride never writes to it. */
    get course() { return spec; },
    /** The ground, built once. Renderers walk `xs`/`ys` straight out of it. */
    get terrain() { return terrain; },
    get vehicle() { return vehicle; },
    get flavour() { return spec.flavour; },
    get finishX() { return finishX; },
    get startX() { return startX; },
    /** Live state. Read after a step; never write to it. */
    state,

    /**
     * Advance one fixed step.
     *
     * @param {number} dt Seconds. Fixed — 1/60 in every consumer here.
     * @param {Array<import("./contract.js").WheelsInput | undefined>} inputs
     *        One per seat, in seat order. A missing seat rides neutral.
     */
    step(dt, inputs = []) {
      if (state.outcome !== "playing") return state;
      state.tick += 1;
      state.time += dt;

      for (let seat = 0; seat < riders.length; seat += 1) {
        stepRider(riders[seat], inputs[seat] ?? neutralWheelsInput(), dt);
      }
      stepProps(dt);
      stepShots(dt);
      stepCamera(dt);

      const everyoneDone = riders.every((rider) => rider.finished);
      if (everyoneDone) {
        const anyoneHome = riders.some((rider) => rider.x >= finishX);
        state.outcome = anyoneHome ? "won" : "lost";
        emit({ type: state.outcome, time: state.time });
      } else if (spec.rules.timeLimit > 0 && state.time >= spec.rules.timeLimit) {
        state.outcome = "lost";
        emit({ type: "lost", time: state.time, reason: "time" });
      }
      return state;
    },

    /** The prop definition behind a live prop, for a renderer. */
    propDef(live) { return spec.props[live.def]; },

    /** The surface a rider is over — the renderer's cue and the HUD's. */
    surfaceUnder(rider) {
      return WHEELS_SURFACES[terrainSurfaceAt(terrain, rider.x)] ?? WHEELS_SURFACES[0];
    },

    /** The chassis outline in world space, for drawing and for debugging. */
    outline(rider) {
      return wheelsCrashPoints(vehicle, rider.x, rider.y, cos(rider.angle), sin(rider.angle)).slice(0, 4);
    },

    /** How fast a rider is going, in px/s. */
    speedOf(rider) { return hypot(rider.vx, rider.vy); },

    /**
     * Everything noteworthy since the last drain, oldest first: `wake`,
     * `shot`, `enemyShot`, `shotEnded`, `hit`, `destroyed`, `jump`,
     * `land`, `wreck`, `respawn`, `out`, `checkpoint`, `finish`, `won`,
     * `lost`. Drive sounds and effects from these — never from inside the
     * step, which a rollback re-runs.
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
        outcome: state.outcome,
        nextId,
        camera: { ...state.camera },
        riders: riders.map((rider) => ({ ...rider, wheels: rider.wheels.map((wheel) => ({ ...wheel })) })),
        props: props.map((prop) => ({ ...prop })),
        shots: shots.map((shot) => ({ ...shot })),
      };
    },

    restore(snap) {
      state.tick = snap.tick;
      state.time = snap.time;
      state.outcome = snap.outcome;
      nextId = snap.nextId;
      state.camera = { ...snap.camera };
      riders = snap.riders.map((rider) => ({ ...rider, wheels: rider.wheels.map((wheel) => ({ ...wheel })) }));
      props = snap.props.map((prop) => ({ ...prop }));
      shots = snap.shots.map((shot) => ({ ...shot }));
      state.riders = riders;
      state.props = props;
      state.shots = shots;
      queued = [];
    },
  };
}
