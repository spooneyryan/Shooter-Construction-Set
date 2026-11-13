// Swings, wounds, knockback and the mercy window.
//
// The genre's one genuinely new primitive is the **strike arc**: a swing
// is an origin, a facing, a radius and a half-angle, live for a few ticks
// and hitting each target at most once. It is here rather than in
// `patterns` because a sword is not an emitter — nothing travels, nothing
// has a lifetime of its own, and the thing that decides a hit is an angle
// test rather than an overlap with a moving body. Everything that DOES
// travel — wands, bows, boss sprays, turrets — stays a `patterns`
// document, unchanged and already deterministic.
//
// The three numbers that make top-down combat feel like anything are all
// here and all data: the arc's shape, the knockback, and the
// invulnerability window. Getting them wrong is what makes a home-made
// action game feel like pushing sprites through treacle, and no amount of
// art fixes it — which is why they are in `feel` with presets rather than
// buried as constants.

import { atan2, cos, normalizeAngle, sin } from "../core/trig.js";
import { bodyCenterX, bodyCenterY, lineOfSight } from "./move.js";

/**
 * Begin a swing. `hit` is the list of body ids already struck, so one
 * swing cannot hit the same target twice however long it lives.
 *
 * @param {object} owner The swinger; the arc follows it as it moves.
 * @param {number} angle Radians, +y down.
 * @param {object} feel The run's feel block.
 * @param {number} [damage] Overrides the feel's swing damage.
 */
export function createStrike(owner, angle, feel, damage) {
  return {
    ownerId: owner.id,
    /** Seat that owns it, or -1 for an enemy's swing. */
    seat: owner.seat ?? -1,
    angle,
    radius: feel.swingRadius,
    halfAngle: feel.swingHalfAngle,
    damage: damage === undefined ? feel.swingDamage : damage,
    knockback: feel.swingKnockback,
    ticksLeft: feel.swingTicks,
    hit: [],
  };
}

/**
 * Whether a strike from `origin` covers `target` — inside the radius,
 * inside the arc, and not through a wall.
 *
 * The radius is measured centre to centre and forgiven by half the
 * target's size, so a wide enemy is hit when the blade reaches its edge
 * rather than only its middle. The angle test uses `normalizeAngle`, so
 * an arc that straddles ±π behaves like any other.
 */
export function strikeCovers(field, strike, origin, target) {
  const ox = bodyCenterX(origin);
  const oy = bodyCenterY(origin);
  const tx = bodyCenterX(target);
  const ty = bodyCenterY(target);
  const dx = tx - ox;
  const dy = ty - oy;
  const distance = Math.sqrt(dx * dx + dy * dy);
  const reach = strike.radius + Math.max(target.w, target.h) / 2;
  if (distance > reach) return false;
  // Standing inside the swinger is always a hit; there is no meaningful
  // angle between two points at the same place.
  if (distance > 0) {
    const delta = normalizeAngle(atan2(dy, dx) - strike.angle);
    if (Math.abs(delta) > strike.halfAngle) return false;
  }
  return lineOfSight(field, ox, oy, tx, ty);
}

/**
 * Wound a body: spend its health, start its mercy window, and shove it.
 * Returns what happened, so the caller queues the events — nothing here
 * emits, because a step decides what a hit MEANS and this decides only
 * what it does.
 *
 * A body inside its invulnerability window takes nothing at all: not
 * reduced damage, none. That is the classic rule, and the alternative —
 * chip damage through i-frames — is how a player dies to a corridor they
 * thought they had escaped.
 *
 * @param {object} body
 * @param {number} damage
 * @param {object} [options]
 * @param {number} [options.fromX] @param {number} [options.fromY] The push
 *        comes from here; omit both for a hit that does not shove.
 * @param {number} [options.knockback] Speed, px/s.
 * @param {number} [options.knockTicks]
 * @param {number} [options.invulnTicks] Mercy window granted by this hit.
 * @returns {{hit: boolean, died: boolean, damage: number}}
 */
export function woundBody(body, damage, options = {}) {
  if (!body.alive || (body.invuln ?? 0) > 0) return { hit: false, died: false, damage: 0 };
  const dealt = Math.max(0, Math.round(damage) || 0);
  body.health -= dealt;
  body.invuln = Math.max(0, Math.round(options.invulnTicks ?? 0) || 0);

  const knockback = Number(options.knockback) || 0;
  if (knockback > 0 && options.fromX !== undefined && options.fromY !== undefined) {
    const dx = bodyCenterX(body) - options.fromX;
    const dy = bodyCenterY(body) - options.fromY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance > 0) {
      body.knockX = (dx / distance) * knockback;
      body.knockY = (dy / distance) * knockback;
    } else {
      // Struck from exactly its own centre: shove it the way the attack
      // faced, and the same way on every machine.
      body.knockX = 0;
      body.knockY = -knockback;
    }
    body.knockTicks = Math.max(0, Math.round(options.knockTicks ?? 0) || 0);
  }

  const died = body.health <= 0;
  if (died) {
    body.health = 0;
    body.alive = false;
  }
  return { hit: true, died, damage: dealt };
}

/**
 * The vector a stick or a facing becomes. Centred means "no new
 * instruction", so the last angle stands — a hero keeps facing where they
 * were left rather than snapping to a default the moment the stick
 * returns to rest.
 *
 * @param {{x: number, y: number}} vector
 * @param {number} fallback The angle to keep when the vector is centred.
 */
export function angleOf(vector, fallback) {
  const x = Number(vector?.x) || 0;
  const y = Number(vector?.y) || 0;
  if (x === 0 && y === 0) return fallback;
  return atan2(y, x);
}

/** The unit vector of an angle, for spawning a shot at the arc's edge. */
export function aheadX(angle, distance) {
  return cos(angle) * distance;
}

export function aheadY(angle, distance) {
  return sin(angle) * distance;
}
