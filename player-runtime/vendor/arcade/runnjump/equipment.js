import { normalizeRunNJumpMount, runNJumpMuzzle } from "./motion.js";
// Portable equipment and its deterministic runtime. Absent loadouts are inert.
import { normalizeRunNJumpEffects } from "./effects.js";
import { atan2 } from "../core/trig.js";
import { advanceBulletPattern, createBulletPatternRuntime } from "../patterns/patterns.js";

const rjEquipmentNumber = (value, fallback, min, max) => Number.isFinite(Number(value ?? fallback)) ? Math.max(min, Math.min(max, Number(value ?? fallback))) : fallback;
const rjEquipmentId = (value, fallback = "") => typeof value === "string" ? value.slice(0, 80) : fallback;

export function normalizeRunNJumpWeapon(input = {}) {
  input = input && typeof input === "object" ? input : {};
  return {
    id: rjEquipmentId(input.id, "weapon"), name: rjEquipmentId(input.name, "Weapon"), tag: rjEquipmentId(input.tag, "standard"),
    patternId: rjEquipmentId(input.patternId),
    ...(normalizeRunNJumpMount(input.mount) ? { mount: normalizeRunNJumpMount(input.mount) } : {}),
    projectileSpeed: rjEquipmentNumber(input.projectileSpeed, 280, 40, 900), projectileGravity: rjEquipmentNumber(input.projectileGravity, 0, 0, 3000),
    fireRate: rjEquipmentNumber(input.fireRate, 3, 0.2, 20), ttl: rjEquipmentNumber(input.ttl, 1.1, 0.1, 6),
    size: Math.round(rjEquipmentNumber(input.size, 6, 2, 24)), damage: Math.round(rjEquipmentNumber(input.damage, 1, 1, 99)),
    effects: normalizeRunNJumpEffects(input.effects), customEdited: input.customEdited === true,
  };
}

export function normalizeRunNJumpLoadout(input = {}) {
  input = input && typeof input === "object" ? input : {};
  const capacity = Math.round(rjEquipmentNumber(input.capacity, 8, 1, 16));
  const inventory = [...new Set((Array.isArray(input.inventory) ? input.inventory : []).filter((id) => typeof id === "string" && id).map((id) => rjEquipmentId(id)))].slice(0, capacity);
  const ids = new Set();
  const slots = (Array.isArray(input.slots) && input.slots.length ? input.slots : [{}]).slice(0, 4).map((slot, index) => {
    slot = slot && typeof slot === "object" ? slot : {};
    let id = rjEquipmentId(slot.id, `slot-${index + 1}`); if (!id || ids.has(id)) id = `slot-${index + 1}`; while (ids.has(id)) id += "-"; ids.add(id);
    return { ...(normalizeRunNJumpMount(slot.mount) ? { mount: normalizeRunNJumpMount(slot.mount) } : {}), id, name: rjEquipmentId(slot.name, `Slot ${index + 1}`), accepts: rjEquipmentId(slot.accepts, "any"), weaponId: rjEquipmentId(slot.weaponId) };
  });
  return { capacity, inventory, slots, rateScale: rjEquipmentNumber(input.rateScale, 1, 0.1, 4), damageScale: rjEquipmentNumber(input.damageScale, 1, 0.1, 4), speedScale: rjEquipmentNumber(input.speedScale, 1, 0.1, 4) };
}

export function normalizeRunNJumpDefense(input = {}) {
  input = input && typeof input === "object" ? input : {};
  return { id: rjEquipmentId(input.id, "defense"), name: rjEquipmentId(input.name, "Defense"), type: input.type === "forcefield" ? "forcefield" : "armor",
    damageMultiplier: rjEquipmentNumber(input.damageMultiplier, 1, 0.1, 4), capacity: rjEquipmentNumber(input.capacity, 3, 0, 999),
    rechargeDelay: rjEquipmentNumber(input.rechargeDelay, 2, 0, 30), rechargeRate: rjEquipmentNumber(input.rechargeRate, 1, 0, 99) };
}

export function runNJumpWeaponFits(weapon, slot) { return Boolean(weapon && slot && (slot.accepts === "any" || slot.accepts === weapon.tag)); }

/** Resolve authored IDs once; invalid initial entries remain visible in the document. */
export function createRunNJumpEquipment(game, loadout) {
  if (!loadout) return null;
  const inventory = loadout.inventory.filter((id) => game.weapons?.some((weapon) => weapon.id === id));
  const used = new Set();
  const slots = loadout.slots.map((slot) => {
    const weapon = game.weapons?.find((entry) => entry.id === slot.weaponId);
    if (!inventory.includes(slot.weaponId) || used.has(slot.weaponId) || !runNJumpWeaponFits(weapon, slot)) return "";
    used.add(slot.weaponId); return slot.weaponId;
  });
  return { inventory, slots, selected: 0, cooldowns: {}, patterns: {}, held: {} };
}

/** Returns false for a full inventory so the pickup stays available to the partner. */
export function collectRunNJumpWeapon(world, player, weaponId, satellite = false) {
  const equipment = satellite ? player.satEquipment : player.equipment;
  const loadout = satellite ? world.game.player.satellite.loadout : world.game.player.loadout;
  const weapon = world.game.weapons?.find((entry) => entry.id === weaponId);
  if (!equipment || !loadout || !weapon) return false;
  if (equipment.inventory.includes(weaponId)) return true;
  if (equipment.inventory.length >= loadout.capacity) return false;
  equipment.inventory.push(weaponId);
  const index = loadout.slots.findIndex((slot, index) => !equipment.slots[index] && runNJumpWeaponFits(weapon, slot));
  if (index >= 0) equipment.slots[index] = weaponId;
  world.emit("weapon-collected", { player: player.index, weaponId, satellite });
  return true;
}

export function equipRunNJumpWeapon(world, player, inventoryIndex, satellite = false) {
  const equipment = satellite ? player.satEquipment : player.equipment;
  const loadout = satellite ? world.game.player.satellite.loadout : world.game.player.loadout;
  if (!equipment || !loadout) return false;
  const slot = loadout.slots[equipment.selected], id = equipment.inventory[inventoryIndex];
  const weapon = world.game.weapons?.find((entry) => entry.id === id);
  if (!runNJumpWeaponFits(weapon, slot) || equipment.slots.some((entry, index) => entry === id && index !== equipment.selected)) return false;
  equipment.slots[equipment.selected] = id;
  world.emit("weapon-equipped", { player: player.index, weaponId: id, slotId: slot.id, satellite });
  return true;
}

function cycleRunNJumpWeapon(world, player, delta, satellite) {
  const equipment = satellite ? player.satEquipment : player.equipment;
  if (!equipment?.inventory.length) return;
  const current = equipment.inventory.indexOf(equipment.slots[equipment.selected]);
  for (let step = 1; step <= equipment.inventory.length; step++) {
    const index = ((current + step * delta) % equipment.inventory.length + equipment.inventory.length) % equipment.inventory.length;
    if (equipRunNJumpWeapon(world, player, index, satellite)) return;
  }
}

export function stepRunNJumpEquipment(world, player, input, dt) {
  for (const satellite of [false, true]) {
    const equipment = satellite ? player.satEquipment : player.equipment;
    if (!equipment) continue;
    for (const id of Object.keys(equipment.cooldowns)) equipment.cooldowns[id] = Math.max(0, equipment.cooldowns[id] - dt);
    const actions = satellite ? ["satEquip"] : ["equipNext", "equipPrev", "slotNext", ...Array.from({ length: 8 }, (_, i) => `equip${i + 1}`)];
    for (const action of actions) {
      if (input[action] && !equipment.held[action]) {
        if (action === "slotNext") equipment.selected = (equipment.selected + 1) % equipment.slots.length;
        else if (action === "satEquip" || action === "equipNext" || action === "equipPrev") cycleRunNJumpWeapon(world, player, action === "equipPrev" ? -1 : 1, satellite);
        else equipRunNJumpWeapon(world, player, Number(action.slice(5)) - 1, satellite);
      }
      equipment.held[action] = Boolean(input[action]);
    }
  }
}

export function resetRunNJumpDefense(target, defense) {
  if (!defense) { delete target.shield; delete target.shieldWait; return; }
  target.shield = defense.type === "forcefield" ? defense.capacity : 0; target.shieldWait = 0;
}

export function rechargeRunNJumpDefense(target, defense, dt) {
  if (!defense || target.shield === undefined) return;
  const remaining = Math.max(0, dt - target.shieldWait);
  target.shieldWait = Math.max(0, target.shieldWait - dt);
  if (defense.type === "forcefield") target.shield = Math.min(defense.capacity, target.shield + defense.rechargeRate * remaining);
}

/** Shield first; armor modifies overflow in the platformer's whole health units. */
export function absorbRunNJumpDamage(world, target, defense, damage, source) {
  if (!defense) return damage;
  let remaining = damage;
  if (defense.type === "forcefield") {
    const absorbed = Math.min(target.shield ?? 0, damage); target.shield = Math.max(0, (target.shield ?? 0) - absorbed);
    target.shieldWait = defense.rechargeDelay; remaining -= absorbed;
    if (absorbed > 0) world.emit("shield-hit", { ...source, absorbed, shield: target.shield, x: target.x, y: target.y });
  }
  return remaining > 0 ? Math.max(1, Math.ceil(remaining * defense.damageMultiplier)) : 0;
}

/** Shared emitter owns modulation, orbit and projectile aging; the stage owns contacts. */
export function fireRunNJumpWeapon(world, player, weapon, state, dt, at, aim, satellite, modifiers = { rateScale: 1, speedScale: 1, damageScale: 1 }, slotId = "") {
  const pattern = world.game.patterns.find((entry) => entry.id === weapon.patternId);
  if (!pattern) return false;
  if (!state.runtime) state.runtime = createBulletPatternRuntime(pattern);
  const fired = advanceBulletPattern(state.runtime, pattern, dt * modifiers.rateScale, {
    origin: at, target: { x: at.x + aim.x * 100, y: at.y + aim.y * 100 }, rotation: atan2(aim.y, aim.x) * 180 / Math.PI,
    maxProjectiles: 240, currentProjectiles: world.state.patternShots.filter((shot) => shot.team === "player").length,
  });
  for (const shot of fired) world.state.patternShots.push({ ...shot, vx: shot.vx * modifiers.speedScale, vy: shot.vy * modifiers.speedScale,
    team: "player", owner: player.index, ownerId: player.id, damage: Math.max(1, Math.ceil(weapon.damage * modifiers.damageScale * (shot.power ?? 1))) });
  if (fired.length) world.emit(satellite ? "satellite-fire" : "fire", { player: player.index, weaponId: weapon.id ?? "", slotId, count: fired.length, x: at.x, y: at.y });
  return true;
}

export function fireRunNJumpLoadout(world, player, dt, satellite, at, aim) {
  const equipment = satellite ? player.satEquipment : player.equipment;
  const loadout = satellite ? world.game.player.satellite.loadout : world.game.player.loadout;
  if (!equipment || !loadout) return false;
  equipment.slots.forEach((id, index) => {
    const weapon = world.game.weapons?.find((entry) => entry.id === id); if (!weapon) return;
    const slotId = loadout.slots[index].id;
    const muzzle = runNJumpMuzzle(at, aim, loadout.slots[index].mount ?? weapon.mount);
    // IDs are authored strings, including names inherited by ordinary objects.
    // Define own data properties so restoring JSON cannot turn __proto__ into a setter.
    if (!Object.hasOwn(equipment.patterns, id)) Object.defineProperty(equipment.patterns, id, { value: {}, enumerable: true, writable: true, configurable: true });
    const runtime = equipment.patterns[id];
    if (fireRunNJumpWeapon(world, player, weapon, runtime, dt, muzzle, aim, satellite, loadout, slotId)) return;
    if (Object.hasOwn(equipment.cooldowns, id) && equipment.cooldowns[id] > 0) return;
    Object.defineProperty(equipment.cooldowns, id, { value: 1 / (weapon.fireRate * loadout.rateScale), enumerable: true, writable: true, configurable: true });
    world.spawnEquipmentShot(player, { ...weapon, mount: loadout.slots[index].mount ?? weapon.mount, projectileSpeed: weapon.projectileSpeed * loadout.speedScale, damage: Math.max(1, Math.ceil(weapon.damage * loadout.damageScale)) }, muzzle, aim, satellite, slotId);
  });
  return true;
}
