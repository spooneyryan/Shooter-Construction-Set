// The computer's driver: the field in a race, and an autopilot for anyone.
//
// It is one function from a race's state to a `RacingInput` — the same
// shape a keyboard produces — and the world steps the car it returns
// exactly as it steps a player's. That is the whole design, and it buys
// three things at once:
//
//   - **The field is simulation.** The world asks this function for every
//     computer car at the top of each step, from state alone, so two
//     machines racing the same field see it drive identically, and a
//     rollback re-drives it through the corrected past. No randomness: a
//     driver's character is its `skill`, `line` and `aggression`, which are
//     numbers in the track document.
//   - **It is an autopilot.** A game can hand a seat to it — an attract
//     mode, a player who dropped out of a co-op race, a finished player's
//     cool-down lap — because a seat's input is just this shape.
//   - **It is the reference driver.** The test suite drives the sample
//     tracks with it and asserts they can be finished, which is the claim
//     that they are playable at all.
//
// How it drives, which is two separate problems:
//
//   - **Where**: a point on the racing line some way ahead — farther the
//     faster the car is going — and the wheel turned towards it. The line
//     is the route's own (the inside of every bend), shifted by the
//     driver's `line` so a field does not queue in single file.
//   - **How fast**: a speed profile along the lap, built once per car: the
//     most each bend allows (`v = sqrt(grip / curvature)`), then walked
//     backwards so every braking zone starts early enough to arrive at the
//     next bend's speed. `skill` scales both budgets. The driver compares
//     its speed with the profile a moment ahead and presses the pedal that
//     closes the gap.
//
// Determinism: `+ - * /`, comparisons, `Math.sqrt` and `core/trig`; the
// pedals and the wheel are snapped through `core/stick` on the way out, so
// the autopilot's input is exactly what a recorder would write down.

import { dequantizeStickAxis, quantizeStickAxis } from "../core/stick.js";
import { cos, hypot, sin } from "../core/trig.js";
import { neutralRacingInput, racingSurface } from "./contract.js";
import { racingPointAt } from "./track.js";

/** Ticks without progress before a computer car gives up and resets. */
export const RACING_STUCK_TICKS = 70;

function racingSnap(value) {
  return dequantizeStickAxis(quantizeStickAxis(value));
}

/**
 * The speed a car should be doing at every sample of the route, px/s.
 *
 * @param {any} route From `buildRacingTrack`.
 * @param {any} tune From `racingTune`.
 * @param {number} [skill] 0..1. One is the car's real limits with a small
 *        margin; lower drives every bend and every braking zone gentler.
 * @returns {Float64Array}
 */
export function racingPace(route, tune, skill = 1) {
  const { count, ds, bend, surface } = route;
  const judgement = skill < 0 ? 0 : skill > 1 ? 1 : skill;
  const lateral = tune.grip * 0.9 * (0.72 + 0.28 * judgement);
  const braking = tune.braking * 0.5 * (0.7 + 0.3 * judgement);
  const top = tune.topSpeed;
  const pace = new Float64Array(count);
  for (let index = 0; index < count; index += 1) {
    const grip = racingSurface(surface[index]).grip;
    const tightness = Math.abs(bend[index]);
    const limit = tightness > 1e-6 ? Math.sqrt((lateral * grip) / tightness) : top;
    pace[index] = limit < top ? limit : top;
  }
  // Backwards, twice round: the lap is a loop, so the braking zone for the
  // first bend may begin on the last straight.
  for (let pass = 0; pass < 2; pass += 1) {
    for (let index = count - 1; index >= 0; index -= 1) {
      const next = pace[(index + 1) % count];
      const reachable = Math.sqrt(next * next + 2 * braking * ds);
      if (reachable < pace[index]) pace[index] = reachable;
    }
  }
  return pace;
}

/**
 * What the computer would do with car `index` right now.
 *
 * @param {any} race From `createRace`.
 * @param {number} index Which car, in `race.state.cars` order.
 * @returns {import("./contract.js").RacingInput}
 */
export function racingDriverInput(race, index) {
  const input = neutralRacingInput();
  const state = race.state;
  const car = state.cars[index];
  if (!car || car.out || car.falling > 0) return input;
  const route = race.route;
  const entrant = race.entrants[index] ?? {};
  const skill = entrant.skill ?? 1;
  const speed = hypot(car.vx, car.vy);

  // A car that has stopped making progress is wedged against something —
  // a wall at the wrong angle, a glass on a breakfast table, another car.
  // Backing out is a skill; resetting is a rule, and costs what a fall does.
  if (car.stuck > RACING_STUCK_TICKS) {
    input.reset = true;
    return input;
  }

  // -- where ----------------------------------------------------------
  const look = 34 + speed * 0.28;
  const ahead = racingPointAt(route, car.along + look, 0);
  const room = ahead.half - 10 > 0 ? ahead.half - 10 : 0;
  let offset = route.line[ahead.index] * (0.4 + 0.6 * skill) + (entrant.line ?? 0);
  if (offset > room) offset = room;
  else if (offset < -room) offset = -room;
  const target = racingPointAt(route, car.along + look, offset);
  const dx = target.x - car.x;
  const dy = target.y - car.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  const hx = cos(car.heading);
  const hy = sin(car.heading);
  const cross = hx * dy - hy * dx;
  const dot = hx * dx + hy * dy;
  let steer;
  if (distance < 1e-6) steer = 0;
  else if (dot < 0) steer = cross >= 0 ? 1 : -1;
  else steer = (cross / distance) * 3.2 - car.w * 0.06;
  input.steer.x = racingSnap(steer < -1 ? -1 : steer > 1 ? 1 : steer);

  // -- how fast -------------------------------------------------------
  const pace = race.paceOf(index);
  const soon = racingPointAt(route, car.along + 12 + speed * 0.14, 0);
  const wanted = pace[soon.index] * (race.catchupOf ? race.catchupOf(index) : 1);
  let pedal;
  if (speed < wanted) pedal = 1;
  else if (speed > wanted * 1.05 + 10) pedal = -Math.min(1, 0.35 + (speed - wanted) / 90);
  else pedal = 0.3;
  input.drive.x = racingSnap(pedal);

  // -- what it is carrying --------------------------------------------
  // A cadence rather than a dice roll: a trigger that can only be pulled on
  // some ticks, fewer the calmer the driver, and a fresh press each time so
  // the world sees a rising edge.
  const aggression = entrant.aggression ?? 0;
  if (race.rules.weapons && aggression > 0) {
    const every = Math.max(6, Math.round(44 - 34 * aggression));
    if ((state.tick + index * 7) % every === 0) {
      for (const other of state.cars) {
        if (other === car || other.out || other.falling > 0 || other.grace > 0) continue;
        const ox = other.x - car.x;
        const oy = other.y - car.y;
        const gap = Math.sqrt(ox * ox + oy * oy);
        if (gap < 1e-6) continue;
        const facing = (hx * ox + hy * oy) / gap;
        if (car.ammo.missile > 0 && gap < 320 && facing > 0.95) input.fire = true;
        if (car.ammo.bomb > 0 && gap < 110 && facing < -0.85) input.drop = true;
      }
    }
  }
  return input;
}
