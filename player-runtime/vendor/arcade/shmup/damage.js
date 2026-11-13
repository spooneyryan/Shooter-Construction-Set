// The damage pipeline.
//
// Four call sites in the world resolve damage against a force field and then
// against what is behind it, and in the game this came from each carried its own
// copy of the same three lines. They are not identical — an enemy holds raw hit
// points and a ship holds whole hull pips — so this is two small functions
// rather than one function with a mode flag, which is the shape that made the
// original repeat itself in the first place.

/**
 * Take what a force field can absorb and return what is left over.
 *
 * Mutates `target.shield` and starts the recharge delay, because every caller
 * did exactly that; a version returning a new object would have all four of
 * them writing the fields back by hand, which is the same mutation with more
 * chances to forget one.
 *
 * @param {{shield: number, shieldWait: number}} target
 * @param {{type: string, rechargeDelay: number}|undefined} armor
 * @param {number} damage
 * @returns {{remaining: number, absorbed: number}}
 */
export function absorbWithShield(target, armor, damage) {
  if (!armor || armor.type !== "forcefield" || target.shield <= 0) return { remaining: damage, absorbed: 0 };
  const absorbed = Math.min(target.shield, damage);
  target.shield -= absorbed;
  target.shieldWait = armor.rechargeDelay;
  return { remaining: damage - absorbed, absorbed };
}

/**
 * Convert leftover damage units into whole hull pips.
 *
 * Anything that gets past the shield costs at least one pip. Rounding it to
 * zero would make a heavily-armoured ship immortal rather than tough, which is
 * a different game.
 *
 * @param {number} units
 * @param {{damageMultiplier: number}} armor
 */
export function hullDamage(units, armor) {
  if (units <= 0) return 0;
  return Math.max(1, Math.ceil(units / 100 * armor.damageMultiplier));
}

/**
 * Recharge a force field, respecting its delay. Returns the new shield value.
 *
 * The delay counts down whatever the armour type is, so switching armour
 * mid-run cannot leave a timer that never expires.
 *
 * @param {{shield: number, shieldWait: number}} target
 * @param {{type: string, capacity: number, rechargeRate: number}|undefined} armor
 * @param {number} dt
 */
export function rechargeShield(target, armor, dt) {
  target.shieldWait = Math.max(0, target.shieldWait - dt);
  if (!armor || armor.type !== "forcefield" || target.shieldWait > 0) return target.shield;
  target.shield = Math.min(armor.capacity, target.shield + armor.rechargeRate * dt);
  return target.shield;
}

/** A fresh entity's shield: full if it has a field, zero otherwise. */
export function initialShield(armor) {
  return armor?.type === "forcefield" ? armor.capacity : 0;
}

/**
 * A fresh ship's hull, in pips.
 *
 * A force field carries its capacity in damage units, not pips, so it does not
 * double as a hull count — hence the constant rather than `capacity`.
 *
 * @param {{type: string, capacity: number}} armor
 */
export function initialHull(armor) {
  return armor.type === "forcefield" ? 3 : Math.max(1, Math.round(armor.capacity));
}
