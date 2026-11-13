// The rig: a rigid chassis carrying spring-damper wheels.
//
// This is the model every driving game uses and the reason the answer to
// "real physics?" was not "put it in `arcade/physics`". That module solves
// contacts between arbitrary bodies with sequential impulses, which is
// right for a stack of crates and wrong for a 12-pixel wheel crossing 25
// pixels in a frame: the case an impulse solver handles worst is exactly
// the case both these games live in.
//
// So the chassis is a genuine rigid body — mass, moment of inertia, force
// and torque accumulators, semi-implicit Euler — and each wheel is a
// spring-damper along the chassis's own down axis with a brush tyre at the
// bottom of it. Nothing is scripted, nothing is clamped to the ground, and
// nothing knows what a "jump" is. A backflip is torque; a wheelie is the
// front tyre's normal load reaching zero; a bad landing is a corner of the
// body reaching the ground before a wheel does. **The wheels bounce
// independently of the body because they are attached to it by springs,
// which is Ryan's first sentence about Moon Patrol, restated as code.**
//
// Determinism, since two machines must agree forever: the hot path is
// `+ - * /`, comparisons, and `Math.sqrt` — all of which the language
// specification pins down exactly — and the two angles go through
// `core/trig`, which exists for this. No `Math.sin`, no `Math.random`, no
// clock, and a fixed substep count so a slower machine runs the same
// simulation rather than a coarser one.

import { cos, hypot, normalizeAngle, sin } from "../core/trig.js";
import { WHEELS_SURFACES, WHEELS_TARMAC } from "./contract.js";
import { terrainContact, terrainHeightAt, terrainSurfaceAt } from "./terrain.js";

/** Bounce of the chassis and of a bottomed-out suspension. Deliberately low. */
const WHEELS_HARD_RESTITUTION = 0.12;
/** How much of an overlap one substep corrects. 1 would jitter. */
const WHEELS_CORRECTION = 0.8;
/** Below this the tyre is treated as rolling, not sliding. */
const WHEELS_SLIP_FLOOR = 40;
/** Bearing drag on a wheel that is not touching anything, per second. */
const WHEELS_BEARING_DRAG = 0.8;

function wheelsClamp(value, low, high) {
  return value < low ? low : value > high ? high : value;
}

/**
 * Spin one wheel by `torque` for `h` seconds, and return the reaction the
 * chassis owes it.
 *
 * Newton's third law, and the reason it is worth a function of its own:
 * whatever accelerates the wheel is pushing against the body, so the body
 * takes `-I * dω/dt`. On the ground that is a small correction — the tyre
 * force is already applied at the contact patch, a radius below the axle,
 * which accounts for the steady-state part. In the air it is the ONLY
 * thing acting, and it is exactly the control a trials rider uses: open
 * the throttle and the nose comes up, touch the brake and it drops. Both
 * fall out of this one line, which is the argument for modelling the
 * wheel's inertia rather than treating spin as a display value.
 *
 * Taking the reaction from the ACHIEVED change rather than from the
 * applied torque matters at the rev limiter: a wheel held at `maxSpin` is
 * no longer accelerating, so it can no longer push back, and a rider
 * cannot hold the throttle open at the limiter and keep rotating.
 */
function wheelsSpinWheel(state, torque, wheelInertia, maxSpin, h) {
  const before = state.spin;
  state.spin = wheelsClamp(before + (torque / wheelInertia) * h, -maxSpin, maxSpin);
  return (-wheelInertia * (state.spin - before)) / h;
}

/** A box's moment of inertia about its centre. */
export function wheelsInertia(vehicle) {
  return (vehicle.mass * (vehicle.width * vehicle.width + vehicle.height * vehicle.height)) / 12;
}

/**
 * A rider's simulation state: plain data, JSON-safe, and the whole of what
 * a snapshot has to carry for one vehicle.
 *
 * @param {object} vehicle A normalized vehicle.
 * @param {number} x
 * @param {number} y Chassis centre.
 */
export function createWheelsRider(vehicle, x, y) {
  return {
    x,
    y,
    angle: 0,
    vx: 0,
    vy: 0,
    w: 0,
    /** Per wheel: spin in rad/s, and the last step's suspension reading. */
    wheels: vehicle.wheels.map(() => ({ spin: 0, compression: 0, grounded: false, load: 0, surface: WHEELS_TARMAC })),
    airborne: true,
    /** Ticks since the last time any wheel touched. Drives the air torque. */
    airTicks: 0,
  };
}

/**
 * The four corners of the chassis plus the rider's head, in world space.
 *
 * These are the crash points, and which of them touches first is the whole
 * of both games' failure condition — Trials' "landed on my head", Moon
 * Patrol's "drove into the crater wall". `nose` extends the box forward so
 * a long bonnet is a crash point rather than decoration.
 */
export function wheelsCrashPoints(vehicle, x, y, cosA, sinA) {
  const halfW = vehicle.width / 2;
  const halfH = vehicle.height / 2;
  const local = [
    [-halfW, -halfH + vehicle.drop],
    [halfW, -halfH + vehicle.drop],
    [halfW, halfH + vehicle.drop],
    [-halfW, halfH + vehicle.drop],
    [vehicle.nose, vehicle.drop],
    [0, vehicle.headY],
  ];
  return local.map(([lx, ly]) => ({
    x: x + lx * cosA - ly * sinA,
    y: y + lx * sinA + ly * cosA,
  }));
}

/**
 * Resolve one rigid contact against the chassis: a normal impulse, a
 * Coulomb friction impulse, and a positional correction.
 *
 * Used where the springs have run out of travel and where the body itself
 * is touching — the two places a soft force would let the vehicle sink
 * through the world.
 */
function wheelsResolveContact(rider, invMass, invInertia, px, py, nx, ny, depth, friction) {
  const rx = px - rider.x;
  const ry = py - rider.y;
  const vpx = rider.vx - rider.w * ry;
  const vpy = rider.vy + rider.w * rx;
  const vn = vpx * nx + vpy * ny;

  if (vn < 0) {
    const rn = rx * ny - ry * nx;
    const invEffective = invMass + rn * rn * invInertia;
    const normalImpulse = (-(1 + WHEELS_HARD_RESTITUTION) * vn) / invEffective;
    rider.vx += normalImpulse * nx * invMass;
    rider.vy += normalImpulse * ny * invMass;
    rider.w += rn * normalImpulse * invInertia;

    const tx = -ny;
    const ty = nx;
    const vt = (rider.vx - rider.w * ry) * tx + (rider.vy + rider.w * rx) * ty;
    const rt = rx * ty - ry * tx;
    const invEffectiveT = invMass + rt * rt * invInertia;
    let tangentImpulse = -vt / invEffectiveT;
    const limit = friction * normalImpulse;
    tangentImpulse = wheelsClamp(tangentImpulse, -limit, limit);
    rider.vx += tangentImpulse * tx * invMass;
    rider.vy += tangentImpulse * ty * invMass;
    rider.w += rt * tangentImpulse * invInertia;
  }

  rider.x += nx * depth * WHEELS_CORRECTION;
  rider.y += ny * depth * WHEELS_CORRECTION;
}

/**
 * Advance one rider by one substep.
 *
 * Called `feel.substeps` times per simulation step. It reads the input and
 * the ground and writes only to `rider`; the caller owns everything a
 * substep must not see twice — scoring, events, the wreck timer.
 *
 * @param {object} rider State from `createWheelsRider`.
 * @param {object} vehicle A normalized vehicle.
 * @param {object} terrain From `buildWheelsTerrain`.
 * @param {object} feel A normalized feel.
 * @param {{drive: {x: number}, lean: {x: number}}} input
 * @param {number} h Substep seconds.
 * @returns {{grounded: boolean, fatal: boolean, bodyHit: boolean, landed: boolean, impact: number}}
 *          `impact` is the hardest normal closing speed seen this substep,
 *          which is what a landing thump and a damage rule both want.
 */
export function stepWheelsRider(rider, vehicle, terrain, feel, input, h) {
  const cosA = cos(rider.angle);
  const sinA = sin(rider.angle);
  const invMass = 1 / vehicle.mass;
  const inertia = wheelsInertia(vehicle);
  const invInertia = 1 / inertia;

  // The chassis's own down axis. The suspension leans with the body, which
  // is what a fork does and why a nose-down landing loads the front wheel.
  const downX = -sinA;
  const downY = cosA;

  const throttle = wheelsClamp(input?.drive?.x ?? 0, -1, 1);
  const lean = wheelsClamp(input?.lean?.x ?? 0, -1, 1);

  let fx = 0;
  let fy = vehicle.mass * feel.gravity;
  let torque = 0;
  let grounded = false;
  let fatal = false;
  let impact = 0;

  const bottomed = [];

  // The engine and the brakes are quoted as whole-vehicle accelerations,
  // so each wheel takes its share of them. A rear-drive bike puts all of
  // the engine through one tyre; a four-wheel-drive rover would put a
  // quarter through each, and neither needs a different number.
  let driveTotal = 0;
  let brakeTotal = 0;
  for (const wheel of vehicle.wheels) {
    driveTotal += wheel.drive;
    brakeTotal += wheel.brake;
  }
  if (driveTotal <= 0) driveTotal = 1;
  if (brakeTotal <= 0) brakeTotal = 1;

  for (let index = 0; index < vehicle.wheels.length; index += 1) {
    const wheel = vehicle.wheels[index];
    const state = rider.wheels[index];
    const wheelInertia = 0.5 * wheel.mass * wheel.radius * wheel.radius;

    // The suspension anchor, and the wheel centre at full droop.
    const anchorX = rider.x + wheel.x * cosA - wheel.y * sinA;
    const anchorY = rider.y + wheel.x * sinA + wheel.y * cosA;
    const freeX = anchorX + downX * wheel.rest;
    const freeY = anchorY + downY * wheel.rest;

    const contact = terrainContact(terrain, freeX, freeY, wheel.radius);
    if (contact === null) {
      // Airborne. The engine still turns the wheel, and what that does to
      // the vehicle is the whole of a trials rider's air control: spinning
      // a wheel up has to push back on the chassis somewhere, and the only
      // place left is the body. Throttle rotates the nose up, brake
      // rotates it down, and neither is scripted — both are the reaction
      // applied at the foot of this loop.
      state.grounded = false;
      state.compression = 0;
      state.load = 0;
      const freeTread = state.spin * wheel.radius;
      let freeTorque = -state.spin * WHEELS_BEARING_DRAG * wheelInertia;
      if (throttle > 0 && wheel.drive > 0 && freeTread < vehicle.topSpeed) {
        freeTorque += (vehicle.power * vehicle.mass * wheel.radius * throttle * wheel.drive) / driveTotal;
      } else if (throttle < 0 && wheel.brake > 0 && state.spin > 0) {
        freeTorque -= (vehicle.braking * vehicle.mass * wheel.radius * -throttle * wheel.brake) / brakeTotal;
      }
      torque += wheelsSpinWheel(state, freeTorque, wheelInertia, feel.maxSpin, h);
      continue;
    }

    // How far up the suspension axis the wheel must travel to sit on the
    // ground: the penetration, divided by how much of the axis the contact
    // normal actually opposes. The guard keeps a near-vertical wall — where
    // the axis and the normal are perpendicular — from asking for infinity.
    const opposed = -(contact.nx * downX + contact.ny * downY);
    const raw = opposed > 0.05 ? contact.depth / opposed : contact.depth;
    const compression = raw > wheel.travel ? wheel.travel : raw;

    grounded = true;
    state.grounded = true;
    state.compression = compression;
    state.surface = terrainSurfaceAt(terrain, contact.x);
    const surface = WHEELS_SURFACES[state.surface] ?? WHEELS_SURFACES[WHEELS_TARMAC];
    if (surface.fatal) fatal = true;

    const rx = contact.x - rider.x;
    const ry = contact.y - rider.y;
    const vpx = rider.vx - rider.w * ry;
    const vpy = rider.vy + rider.w * rx;

    // Spring plus damper along the axis. A suspension can push and cannot
    // pull, so the load floors at zero — and a zero load is exactly what a
    // wheelie is, with the tyre below losing its grip for the same reason.
    const closing = vpx * downX + vpy * downY;
    if (closing > impact) impact = closing;
    let load = wheel.stiffness * compression + wheel.damping * closing;
    if (load < 0) load = 0;
    state.load = load;

    fx += -downX * load;
    fy += -downY * load;
    torque += rx * (-downY * load) - ry * (-downX * load);

    // The tyre. Slip is the difference between how fast the tread is
    // moving and how fast the contact patch is: positive means the wheel
    // is driving the vehicle, negative means the vehicle is dragging the
    // wheel. Force is proportional to it until Coulomb's limit, and after
    // that the tyre is sliding and the limit is all there is.
    const tx = -contact.ny;
    const ty = contact.nx;
    const vt = vpx * tx + vpy * ty;
    const tread = state.spin * wheel.radius;
    const slip = tread - vt;
    const reference = Math.abs(vt) > WHEELS_SLIP_FLOOR ? Math.abs(vt) : WHEELS_SLIP_FLOOR;
    const limit = vehicle.mu * wheel.grip * surface.grip * load;
    let tyre = (vehicle.gripStiffness * slip * load) / reference;
    tyre = wheelsClamp(tyre, -limit, limit);

    fx += tx * tyre;
    fy += ty * tyre;
    torque += rx * (ty * tyre) - ry * (tx * tyre);

    if (surface.boost > 0 && wheel.drive > 0) {
      const push = (surface.boost * vehicle.mass * wheel.drive) / driveTotal;
      fx += tx * push;
      fy += ty * push;
    }

    // What the ground does back to the wheel, plus the engine, the brake
    // and rolling resistance. Reverse only engages once the vehicle has
    // very nearly stopped, so "back" on the stick is a brake first.
    let spinTorque = -tyre * wheel.radius;
    if (throttle > 0 && wheel.drive > 0 && tread < vehicle.topSpeed) {
      spinTorque += (vehicle.power * vehicle.mass * wheel.radius * throttle * wheel.drive) / driveTotal;
    } else if (throttle < 0) {
      const speed = hypot(rider.vx, rider.vy);
      if (speed < 30 && wheel.drive > 0) {
        spinTorque += (vehicle.power * vehicle.mass * wheel.radius * throttle * vehicle.reverse * wheel.drive) / driveTotal;
      } else if (wheel.brake > 0) {
        const braking = (vehicle.braking * vehicle.mass * wheel.radius * -throttle * wheel.brake) / brakeTotal;
        spinTorque += state.spin > 0 ? -braking : braking;
      }
    }
    spinTorque -= surface.drag * load * wheel.radius * (state.spin > 0 ? 1 : state.spin < 0 ? -1 : 0);
    torque += wheelsSpinWheel(state, spinTorque, wheelInertia, feel.maxSpin, h);

    if (raw > wheel.travel) bottomed.push({ index, wheel });
  }

  // The rider. On the ground this transfers weight through the springs —
  // which is how a wheelie happens without anything in the code called
  // "wheelie"; in the air it is the only control there is.
  torque += lean * (grounded ? vehicle.leanRate : vehicle.airRate) * inertia;

  const speed = hypot(rider.vx, rider.vy);
  if (speed > 0) {
    const drag = feel.airDrag * speed * vehicle.mass;
    fx -= rider.vx * drag;
    fy -= rider.vy * drag;
  }
  torque -= feel.angularDrag * rider.w * inertia;

  rider.vx += fx * invMass * h;
  rider.vy += fy * invMass * h;
  rider.w += torque * invInertia * h;

  const after = hypot(rider.vx, rider.vy);
  if (after > feel.maxSpeed) {
    const scale = feel.maxSpeed / after;
    rider.vx *= scale;
    rider.vy *= scale;
  }
  rider.w = wheelsClamp(rider.w, -feel.maxTurn, feel.maxTurn);

  rider.x += rider.vx * h;
  rider.y += rider.vy * h;
  rider.angle = normalizeAngle(rider.angle + rider.w * h);

  // Bottomed-out springs become rigid contacts. Skipping this is what
  // makes a hard landing feel weightless, and at trials speeds it is also
  // what lets a wheel arrive under the ground.
  if (bottomed.length > 0) {
    const nowCos = cos(rider.angle);
    const nowSin = sin(rider.angle);
    for (const { wheel } of bottomed) {
      const anchorX = rider.x + wheel.x * nowCos - wheel.y * nowSin;
      const anchorY = rider.y + wheel.x * nowSin + wheel.y * nowCos;
      const seatedX = anchorX + -nowSin * (wheel.rest - wheel.travel);
      const seatedY = anchorY + nowCos * (wheel.rest - wheel.travel);
      const hard = terrainContact(terrain, seatedX, seatedY, wheel.radius);
      if (hard !== null) {
        wheelsResolveContact(rider, invMass, invInertia, hard.x, hard.y, hard.nx, hard.ny, hard.depth, 0.8);
      }
    }
  }

  // The body itself. Any crash point under the ground is a wreck, and it
  // is resolved as well as reported so that a wreck animation has a
  // vehicle lying on the ground rather than inside it.
  let bodyHit = false;
  const finalCos = cos(rider.angle);
  const finalSin = sin(rider.angle);
  for (const point of wheelsCrashPoints(vehicle, rider.x, rider.y, finalCos, finalSin)) {
    const ground = terrainHeightAt(terrain, point.x);
    if (point.y > ground) {
      bodyHit = true;
      const contact = terrainContact(terrain, point.x, point.y, 0.5);
      if (contact !== null) {
        wheelsResolveContact(rider, invMass, invInertia, contact.x, contact.y, contact.nx, contact.ny, contact.depth, 0.9);
      }
    }
  }

  const landed = grounded && rider.airborne;
  rider.airborne = !grounded;
  rider.airTicks = grounded ? 0 : rider.airTicks + 1;

  return { grounded, fatal, bodyHit, landed, impact };
}

/**
 * Put a rider on the ground at `x`, upright and still.
 *
 * The height is not the suspension's rest length but its **static
 * equilibrium** — rest minus however far each spring compresses under its
 * share of the vehicle's weight. Seating at rest length instead drops the
 * vehicle by that difference on the first frame, and a drop is a jolt: the
 * springs ring, the body pitches, and the first thing a player sees is a
 * bike wobbling for half a second. It cost an hour to find that the
 * "unstable solver" was really an unsettled starting position.
 *
 * @param {number} [gravity] The course's gravity, since the equilibrium
 *        depends on it. Omitted, the vehicle simply sits at rest length.
 */
export function seatWheelsRider(rider, vehicle, terrain, x, gravity = 0) {
  const share = (vehicle.mass * gravity) / Math.max(1, vehicle.wheels.length);
  const deepest = vehicle.wheels.reduce((low, wheel) => {
    const settled = Math.min(wheel.travel, share / wheel.stiffness);
    return Math.max(low, wheel.y + wheel.rest - settled + wheel.radius);
  }, 0);
  rider.x = x;
  rider.y = terrainHeightAt(terrain, x) - deepest;
  rider.angle = 0;
  rider.vx = 0;
  rider.vy = 0;
  rider.w = 0;
  rider.airborne = true;
  rider.airTicks = 0;
  for (const state of rider.wheels) {
    state.spin = 0;
    state.compression = 0;
    state.grounded = false;
    state.load = 0;
    state.surface = WHEELS_TARMAC;
  }
  return rider;
}

/**
 * Where a wheel actually is, for a renderer.
 *
 * Derived from the chassis and the last step's compression rather than
 * stored, because a wheel's position is not state: two machines that agree
 * about the chassis agree about this, and a snapshot that carried it could
 * disagree with the body it is bolted to.
 */
export function wheelsWheelPoint(rider, vehicle, index) {
  const wheel = vehicle.wheels[index];
  const state = rider.wheels[index];
  const cosA = cos(rider.angle);
  const sinA = sin(rider.angle);
  const anchorX = rider.x + wheel.x * cosA - wheel.y * sinA;
  const anchorY = rider.y + wheel.x * sinA + wheel.y * cosA;
  const extend = wheel.rest - (state?.compression ?? 0);
  return {
    x: anchorX + -sinA * extend,
    y: anchorY + cosA * extend,
    radius: wheel.radius,
    spin: state?.spin ?? 0,
    compression: state?.compression ?? 0,
    grounded: state?.grounded ?? false,
  };
}
