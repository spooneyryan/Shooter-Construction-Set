// The rig: a rigid body on two axles, seen from above.
//
// This is the "bicycle model" — each axle collapsed to one tyre on the car's
// centreline — which is what nearly every driving game runs underneath,
// arcade ones included. It is small and it is real: a body with a mass and a
// yaw inertia, a front tyre that steers, and two tyres whose sideways force
// grows with how much they are slipping until it meets a friction limit and
// the tyre slides. Nothing in it is called "drift". Everything the two games
// are remembered for falls out of those few lines:
//
//   - **Understeer and oversteer** are which axle reaches its limit first.
//     A car whose front runs out ploughs on; one whose rear runs out swings
//     round. `rearGrip` below one is a car that prefers the second.
//   - **Power oversteer** is the friction circle: a rear tyre asked to drive
//     hard has less left to hold sideways, so flooring a rear-drive truck
//     out of a bend steps the tail out. Nothing tells it to.
//   - **The handbrake turn** is the rear's grip multiplied down while the
//     button is held — the rear lets go, the front does not, and the car
//     rotates about its nose.
//   - **Weight transfer** moves load forward under braking, so a car that
//     brakes into a bend turns in harder than one that coasts in: trail
//     braking, arrived at rather than written.
//
// Surfaces are read under all four wheels, so two wheels in the grass drag
// that side back and pull the car towards it — the whole of what "dropping
// a wheel off" means, as a torque.
//
// Determinism, since two machines must agree forever: the hot path is
// `+ - * /`, comparisons and `Math.sqrt`, and the two angles — heading and
// steering lock — go through `core/trig`. No `Math.sin`, no `Math.random`, no
// clock, and a fixed substep count.

import { PI, cos, hypot, normalizeAngle, sin } from "../core/trig.js";
import { RACING_RAMP, RACING_SURFACES, RACING_TARMAC } from "./contract.js";
import { racingGroundInto, racingWallInto } from "./track.js";

/** Below this the tyre's slip is measured against this speed instead. */
const RACING_SLIP_FLOOR = 40;
/** Degrees to radians, once. */
const RACING_RADIANS = PI / 180;
/** Slowest a car can meet a ramp and still be launched by it. */
export const RACING_LAUNCH_FLOOR = 90;
/** How hard a spin-out spins, rad/s, and how much grip it leaves. */
const RACING_SPIN_RATE = 11;
const RACING_SPIN_GRIP = 0.35;

function racingClamp(value, low, high) {
  return value < low ? low : value > high ? high : value;
}

/**
 * A car's numbers in the solver's units, derived once per car per race.
 *
 * Degrees become radians, the balance becomes two axle positions, and the
 * capsule the car collides as gets its two discs. Derived rather than
 * stored in the car's state, because none of it can change during a race —
 * an upgrade scales power, top speed and grip on the way in instead.
 *
 * @param {any} car A normalized car (`normalizeRacingCar`).
 */
export function racingTune(car) {
  const inertia = (car.mass * (car.length * car.length + car.width * car.width)) / 12 * car.inertia;
  return {
    name: car.name,
    mass: car.mass,
    inertia,
    /** Centre of mass to the front axle. The front carries `balance` of the weight. */
    front: car.wheelbase * (1 - car.balance),
    /** Centre of mass to the rear axle. */
    rear: car.wheelbase * car.balance,
    balance: car.balance,
    halfTrack: car.width * 0.4,
    length: car.length,
    width: car.width,
    radius: car.width / 2,
    /** The capsule's two discs sit this far ahead of and behind the centre. */
    reach: Math.max(0, (car.length - car.width) / 2),
    power: car.power,
    topSpeed: car.topSpeed,
    braking: car.braking,
    reverse: car.reverse,
    driveFront: car.drive,
    steer: car.steer * RACING_RADIANS,
    steerRate: car.steerRate * RACING_RADIANS,
    steerFade: car.steerFade,
    grip: car.grip,
    rearGrip: car.rearGrip,
    stiffness: car.cornering * car.grip,
    handbrake: car.handbrake,
    transfer: car.transfer,
    drag: car.drag,
    bounce: car.bounce,
  };
}

/**
 * A car's simulation state: plain data, JSON-safe, and the whole of what a
 * snapshot has to carry for one car's physics.
 */
export function createRacingCar(x = 0, y = 0, heading = 0) {
  return {
    x,
    y,
    /** Radians, clockwise from east because +y is down. */
    heading,
    vx: 0,
    vy: 0,
    /** Yaw rate, rad/s. Positive turns right. */
    w: 0,
    /** Height above the ground, and how fast it is changing. */
    z: 0,
    vz: 0,
    /** The front wheels' current lock, radians, positive to the right. */
    steer: 0,
    spinTicks: 0,
    spinDir: 1,
    /** Fractions added to power, top speed and grip by upgrade pickups. */
    upgrade: { power: 0, topSpeed: 0, grip: 0 },
    /** Surface codes under the four wheels at the last substep: FL, FR, RL, RR. */
    ground: [RACING_TARMAC, RACING_TARMAC, RACING_TARMAC, RACING_TARMAC],
  };
}

/** Put a car down at a spot, still and straight. */
export function seatRacingCar(car, x, y, heading) {
  car.x = x;
  car.y = y;
  car.heading = normalizeAngle(heading);
  car.vx = 0;
  car.vy = 0;
  car.w = 0;
  car.z = 0;
  car.vz = 0;
  car.steer = 0;
  car.spinTicks = 0;
  return car;
}

/**
 * The two discs a car collides as, in world space. Front first.
 *
 * @returns {Array<{x: number, y: number, radius: number}>}
 */
export function racingCarDiscs(car, tune) {
  const cosA = cos(car.heading);
  const sinA = sin(car.heading);
  return [
    { x: car.x + cosA * tune.reach, y: car.y + sinA * tune.reach, radius: tune.radius },
    { x: car.x - cosA * tune.reach, y: car.y - sinA * tune.reach, radius: tune.radius },
  ];
}

/**
 * The body's four corners in world space — front left, front right, rear
 * right, rear left — for drawing, and for a HUD that wants a silhouette.
 */
export function racingCarCorners(car, tune) {
  const cosA = cos(car.heading);
  const sinA = sin(car.heading);
  const halfL = tune.length / 2;
  const halfW = tune.width / 2;
  return [[halfL, -halfW], [halfL, halfW], [-halfL, halfW], [-halfL, -halfW]].map(([lx, ly]) => ({
    x: car.x + lx * cosA - ly * sinA,
    y: car.y + lx * sinA + ly * cosA,
  }));
}

/** Scratch for the solver, so a substep allocates nothing. */
const RACING_WHEEL_GROUND = { surface: 0, dirX: 1, dirY: 0 };
const RACING_WALL = { nx: 0, ny: 0, depth: 0 };
const RACING_WHEEL_X = [1, 1, -1, -1];
const RACING_WHEEL_Y = [-1, 1, -1, 1];

/**
 * Resolve one contact against something that does not move — a wall, a
 * tyre stack — as a normal impulse with `bounce`, a Coulomb friction impulse
 * along it, and a positional correction. The impulse acts at the contact
 * point rather than the centre, so a car that clips a barrier with its rear
 * quarter is turned by it, which is most of what a racing collision is.
 *
 * @param {number} px Contact point, world space.
 * @param {number} py
 * @param {number} nx Unit normal, pointing from the obstacle into the car.
 * @param {number} ny
 * @param {number} depth How far to push the car out along the normal.
 * @returns {number} The closing speed the contact stopped, 0 when separating.
 */
export function racingResolveFixed(car, tune, px, py, nx, ny, depth, bounce, friction) {
  const invMass = 1 / tune.mass;
  const invInertia = 1 / tune.inertia;
  const rx = px - car.x;
  const ry = py - car.y;
  const vpx = car.vx - car.w * ry;
  const vpy = car.vy + car.w * rx;
  const vn = vpx * nx + vpy * ny;
  let closing = 0;
  if (vn < 0) {
    closing = -vn;
    const rn = rx * ny - ry * nx;
    const normalImpulse = (-(1 + bounce) * vn) / (invMass + rn * rn * invInertia);
    car.vx += normalImpulse * nx * invMass;
    car.vy += normalImpulse * ny * invMass;
    car.w += rn * normalImpulse * invInertia;
    const tx = -ny;
    const ty = nx;
    const vt = (car.vx - car.w * ry) * tx + (car.vy + car.w * rx) * ty;
    const rt = rx * ty - ry * tx;
    const limit = friction * normalImpulse;
    const tangentImpulse = racingClamp(-vt / (invMass + rt * rt * invInertia), -limit, limit);
    car.vx += tangentImpulse * tx * invMass;
    car.vy += tangentImpulse * ty * invMass;
    car.w += rt * tangentImpulse * invInertia;
  }
  car.x += nx * depth;
  car.y += ny * depth;
  return closing;
}

/**
 * Advance one car by one substep.
 *
 * Called `feel.substeps` times per simulation step. It reads the track and
 * the car's control and writes only to `car`; the world owns everything a
 * substep must not see twice — laps, pickups, events, the fall timer — and
 * the collisions between cars, which need all of them at once.
 *
 * @param {any} car State from `createRacingCar`.
 * @param {any} tune From `racingTune`.
 * @param {any} track From `buildRacingTrack`.
 * @param {any} feel A normalized feel.
 * @param {{throttle: number, brake: number, steer: number, handbrake: boolean, pace: number}} control
 *        Pedals 0..1, steering -1..1, and `pace`, a multiplier on the engine
 *        that the world uses for turbo and for the field's catch-up.
 * @param {number} h Substep seconds.
 * @returns {{wall: number, launched: number, landed: number}} The hardest
 *          wall hit's closing speed, the vertical speed of a ramp launch,
 *          and the impact speed of a landing — each 0 when it did not happen.
 */
export function stepRacingCar(car, tune, track, feel, control, h) {
  const report = { wall: 0, launched: 0, landed: 0 };
  const mass = tune.mass;
  const inertia = tune.inertia;
  const upgrade = car.upgrade;
  const pace = control.pace > 0 ? control.pace : 1;
  const power = tune.power * (1 + upgrade.power) * pace;
  const topSpeed = tune.topSpeed * (1 + upgrade.topSpeed) * pace;
  const gripScale = 1 + upgrade.grip;
  const spinning = car.spinTicks > 0;

  // The wheel turns at a finite rate, and has less lock the faster the car
  // goes. The rate is what keeps a keyboard's full lock from arriving in a
  // single step; the fade is what keeps full lock at top speed from being
  // an instant spin.
  const speed = hypot(car.vx, car.vy);
  const lock = tune.steer / (1 + speed / tune.steerFade);
  const wanted = spinning ? 0 : racingClamp(control.steer, -1, 1) * lock;
  const turn = tune.steerRate * h;
  car.steer += racingClamp(wanted - car.steer, -turn, turn);

  let cosA = cos(car.heading);
  let sinA = sin(car.heading);

  if (car.z > 0 || car.vz > 0) {
    // Airborne. No tyre touches anything, so there is nothing to steer or
    // drive with: the car flies where it was going, turning at the rate it
    // left the ramp with, until gravity puts it back.
    car.vz -= feel.gravity * h;
    car.z += car.vz * h;
    const drag = tune.drag * speed;
    car.vx -= car.vx * drag * h;
    car.vy -= car.vy * drag * h;
    car.x += car.vx * h;
    car.y += car.vy * h;
    car.heading = normalizeAngle(car.heading + car.w * h);
    if (car.z <= 0) {
      report.landed = -car.vz;
      car.z = 0;
      car.vz = 0;
    }
  } else {
    // -- what each wheel is standing on --------------------------------
    const a = tune.front;
    const b = tune.rear;
    let frontGrip = 0;
    let rearGrip = 0;
    let launch = 0;
    let fx = 0;
    let fy = 0;
    let torque = 0;
    for (let wheel = 0; wheel < 4; wheel += 1) {
      const lx = RACING_WHEEL_X[wheel] > 0 ? a : -b;
      const ly = RACING_WHEEL_Y[wheel] * tune.halfTrack;
      const rx = lx * cosA - ly * sinA;
      const ry = lx * sinA + ly * cosA;
      racingGroundInto(track, car.x + rx, car.y + ry, RACING_WHEEL_GROUND);
      const code = RACING_WHEEL_GROUND.surface;
      car.ground[wheel] = code;
      const surface = RACING_SURFACES[code] ?? RACING_SURFACES[RACING_TARMAC];
      if (wheel < 2) frontGrip += surface.grip / 2;
      else rearGrip += surface.grip / 2;
      // Drag and zippers act at the wheel, a quarter of the car each, so a
      // lopsided surface is a torque as well as a force.
      const wvx = car.vx - car.w * ry;
      const wvy = car.vy + car.w * rx;
      let wfx = -surface.drag * (mass / 4) * wvx;
      let wfy = -surface.drag * (mass / 4) * wvy;
      if (surface.boost > 0) {
        wfx += surface.boost * (mass / 4) * RACING_WHEEL_GROUND.dirX;
        wfy += surface.boost * (mass / 4) * RACING_WHEEL_GROUND.dirY;
      }
      fx += wfx;
      fy += wfy;
      torque += rx * wfy - ry * wfx;
      if (code === RACING_RAMP) {
        const along = car.vx * RACING_WHEEL_GROUND.dirX + car.vy * RACING_WHEEL_GROUND.dirY;
        if (along > RACING_LAUNCH_FLOOR && along * surface.launch > launch) launch = along * surface.launch;
      }
    }
    frontGrip *= tune.grip * gripScale;
    rearGrip *= tune.grip * tune.rearGrip * gripScale;
    if (control.handbrake && !spinning) rearGrip *= tune.handbrake;
    if (spinning) {
      frontGrip *= RACING_SPIN_GRIP;
      rearGrip *= RACING_SPIN_GRIP;
    }

    // -- the car's own frame -------------------------------------------
    const u = car.vx * cosA + car.vy * sinA;
    const v = -car.vx * sinA + car.vy * cosA;
    const w = car.w;

    // The pedals, as accelerations along the car. The motor pulls hardest
    // from a standstill and not at all at top speed; "back" on the stick is
    // a brake until the car has stopped, and reverse after that.
    const throttle = spinning ? 0 : racingClamp(control.throttle, 0, 1);
    const brake = spinning ? 0 : racingClamp(control.brake, 0, 1);
    let drive = 0;
    let braking = 0;
    if (throttle > 0) {
      if (u >= -5) drive = throttle * power * Math.max(0, 1 - u / topSpeed);
      else braking = throttle * tune.braking;
    }
    if (brake > 0) {
      if (u > 5) braking = Math.max(braking, brake * tune.braking);
      else {
        const reverseTop = topSpeed * tune.reverse;
        drive -= brake * power * tune.reverse * Math.max(0, 1 - -u / (reverseTop > 1 ? reverseTop : 1));
      }
    }
    // A brake stops the car; it does not reverse it. Cap it at whatever
    // would bring the forward speed to zero within this substep.
    const stopping = Math.abs(u) / h;
    if (braking > stopping) braking = stopping;
    const brakeSign = u > 0 ? -1 : u < 0 ? 1 : 0;
    let frontLong = mass * (drive * tune.driveFront + brakeSign * braking * 0.6);
    let rearLong = mass * (drive * (1 - tune.driveFront) + brakeSign * braking * 0.4);
    if (control.handbrake && !spinning) {
      const lockUp = Math.min(tune.braking * 0.5, stopping);
      rearLong += mass * brakeSign * lockUp;
    }

    // Load moves forward under braking and back under power.
    const demand = (frontLong + rearLong) / mass;
    const loadFront = racingClamp(tune.balance - (tune.transfer * demand) / tune.grip, 0.15, 0.85);
    const loadRear = 1 - loadFront;

    // -- the front tyre, in its own steered frame ----------------------
    const cosD = cos(car.steer);
    const sinD = sin(car.steer);
    const frontSide = v + a * w;
    const frontAlong = u * cosD + frontSide * sinD;
    const frontAcross = -u * sinD + frontSide * cosD;
    const frontRef = Math.abs(frontAlong) > RACING_SLIP_FLOOR ? Math.abs(frontAlong) : RACING_SLIP_FLOOR;
    // The sideways force grows with slip until the friction limit. It is
    // also capped at whatever would cancel the axle's sideways speed in one
    // substep — the implicit bound that keeps a stiff tyre stable at any
    // step size, since an explicit solver would otherwise overshoot and
    // ring at low speed.
    const frontCap = Math.abs(frontAcross) / (h * (1 / mass + (a * a) / inertia));
    let frontLat = racingClamp((-tune.stiffness * frontAcross * mass * loadFront) / frontRef, -frontCap, frontCap);
    // The friction circle: what the tyre spends driving or braking it no
    // longer has for holding the car sideways.
    const frontLimit = frontGrip * mass * loadFront;
    const frontTotal = Math.sqrt(frontLong * frontLong + frontLat * frontLat);
    if (frontTotal > frontLimit) {
      const scale = frontTotal > 0 ? frontLimit / frontTotal : 0;
      frontLong *= scale;
      frontLat *= scale;
    }

    // -- the rear tyre --------------------------------------------------
    const rearSide = v - b * w;
    const rearRef = Math.abs(u) > RACING_SLIP_FLOOR ? Math.abs(u) : RACING_SLIP_FLOOR;
    const rearCap = Math.abs(rearSide) / (h * (1 / mass + (b * b) / inertia));
    let rearLat = racingClamp((-tune.stiffness * rearSide * mass * loadRear) / rearRef, -rearCap, rearCap);
    const rearLimit = rearGrip * mass * loadRear;
    const rearTotal = Math.sqrt(rearLong * rearLong + rearLat * rearLat);
    if (rearTotal > rearLimit) {
      const scale = rearTotal > 0 ? rearLimit / rearTotal : 0;
      rearLong *= scale;
      rearLat *= scale;
    }

    // -- sum, in the car's frame, then the world's ---------------------
    const frontX = frontLong * cosD - frontLat * sinD;
    const frontY = frontLong * sinD + frontLat * cosD;
    const carX = frontX + rearLong;
    const carY = frontY + rearLat;
    torque += a * frontY - b * rearLat;
    fx += carX * cosA - carY * sinA;
    fy += carX * sinA + carY * cosA;

    const air = tune.drag * speed * mass;
    fx -= car.vx * air;
    fy -= car.vy * air;

    // A spin-out is a yaw the driver no longer controls, pulled towards a
    // fixed rate so it reads as a spin and not a wobble.
    if (spinning) torque += (car.spinDir * RACING_SPIN_RATE - car.w) * 6 * inertia;

    car.vx += (fx / mass) * h;
    car.vy += (fy / mass) * h;
    car.w += (torque / inertia) * h;
    car.x += car.vx * h;
    car.y += car.vy * h;
    car.heading = normalizeAngle(car.heading + car.w * h);

    if (launch > 0) {
      car.vz = launch;
      car.z = launch * h;
      report.launched = launch;
    }
  }

  // Limits, whatever the car is doing.
  const after = hypot(car.vx, car.vy);
  if (after > feel.maxSpeed) {
    const scale = feel.maxSpeed / after;
    car.vx *= scale;
    car.vy *= scale;
  }
  car.w = racingClamp(car.w, -feel.maxYaw, feel.maxYaw);

  // -- walls: both discs, in the air as on the ground ------------------
  // A wall is as tall as it needs to be. A ramp that could clear a barrier
  // would put a car outside a walled circuit with no way back in.
  for (let disc = 0; disc < 2; disc += 1) {
    cosA = cos(car.heading);
    sinA = sin(car.heading);
    const along = disc === 0 ? tune.reach : -tune.reach;
    const cx = car.x + cosA * along;
    const cy = car.y + sinA * along;
    if (racingWallInto(track, cx, cy, tune.radius, RACING_WALL)) {
      const hit = racingResolveFixed(
        car, tune,
        cx - RACING_WALL.nx * tune.radius, cy - RACING_WALL.ny * tune.radius,
        RACING_WALL.nx, RACING_WALL.ny, RACING_WALL.depth,
        feel.wallBounce, feel.wallFriction,
      );
      if (hit > report.wall) report.wall = hit;
    }
  }
  return report;
}
