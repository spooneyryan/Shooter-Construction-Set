// The simulation.
//
// Data in, state out. A world is created from a level, stepped with a delta and
// an input snapshot, and owns everything a run consists of. It never calls back
// into its caller, never touches a canvas, and never reads a clock: everything
// the caller might want to know is a field on `state` that it reads when it
// suits, at whatever rate suits.
//
// **Determinism.** Nothing here calls `Math.random` or `Date.now`. The
// explosions a run produces are emitted as *requests* and left to whatever is
// drawing, which is where they belong — nothing in the simulation reads a
// particle — and that is what removed the last randomness from this file.
//
// What is left is trigonometry, and it is not bit-identical across engines. A
// replay recorded and played back on one machine is unaffected, because the
// error is deterministic per engine; two *different* machines agreeing is what
// it blocks, which means co-op. See docs/future.md — it has the call sites and
// the shape of the fix.

import { asin, atan2, cos, hypot, sin } from "../core/trig.js";
import { neutralStick, resolveStick } from "../core/stick.js";
import { advanceBulletPattern, advancePatternProjectiles, createBulletPatternRuntime } from "./patterns.js";
import { absorbWithShield, hullDamage, initialHull, initialShield, rechargeShield } from "./damage.js";
import { expandLevel } from "./formation.js";
import { movementPosition } from "./movement.js";
import { crossWobble } from "../core/curve-motion.js";
import { clamp, itemHitRadius, playerRadius, SATELLITE_HIT_RADIUS, VIEW_H, VIEW_W, viewSpans, weaponFitsSlot } from "./contract.js";
import { hitboxHitsCircle } from "./hitbox.js";

/**
 * One frame of intent. Everything is already resolved: the caller has unioned
 * its keyboard and pad, applied its own deadzone, and decided what "fire" means.
 *
 * This world was twin-stick before there was a word for it here — a stick for
 * the ship and a second one for the satellite, with a pointer as the third
 * way to steer it. What it did not have was a shared, *quantized* vector, so
 * the two axes were raw floats straight off the hardware and every consumer
 * re-invented its own deadzone. `normalizeWorldInput` is where that ends.
 *
 * @typedef {object} WorldInput
 * @property {number} dx -1..1
 * @property {number} dy -1..1
 * @property {boolean} fire
 * @property {{x: number, y: number}} aim Where the guns point, arena mode
 *           only; the scroll modes fire along the scroll axis and ignore it.
 * @property {{x: number, y: number}} satelliteAxis Right stick; zero when idle.
 * @property {{x: number, y: number, active: boolean}} satellitePointer
 *           Pointer position in design space, used when the stick is idle.
 */

/** A neutral input. Useful as a starting value and in tests. */
export function idleInput() {
  return {
    dx: 0, dy: 0, fire: false,
    aim: neutralStick(),
    satelliteAxis: neutralStick(),
    satellitePointer: { x: VIEW_W * 0.7, y: VIEW_H / 2, active: false },
  };
}

/**
 * One frame of intent, put through `core/stick`: clamped to the unit disc and
 * quantized, both axes and both sticks.
 *
 * `step` calls this itself, so nothing has to change to benefit. A caller that
 * records or transmits its input should call it at the edge instead and pass
 * the result in — quantize where the reading is taken, never downstream, or
 * the tape and the run disagree about a number the player would call the same.
 *
 * The response curves are deliberately untouched. No deadzone is applied here
 * (the caller's own is already in the reading, and this world's satellite has
 * its own threshold below), so a half-deflected stick still moves at half
 * speed and the only difference from before is that the number is now one both
 * machines can agree on.
 *
 * @param {WorldInput} input
 * @returns {WorldInput}
 */
export function normalizeWorldInput(input, spans = viewSpans("horizontal")) {
  const move = resolveStick(input?.dx ?? 0, input?.dy ?? 0);
  const aim = input?.aim;
  const axis = input?.satelliteAxis;
  const pointer = input?.satellitePointer;
  return {
    dx: move.x,
    dy: move.y,
    fire: input?.fire === true,
    aim: resolveStick(aim?.x ?? 0, aim?.y ?? 0),
    satelliteAxis: resolveStick(axis?.x ?? 0, axis?.y ?? 0),
    // The pointer is a POSITION, not a direction, so it does not go through
    // `resolveStick` -- clamping a corner of the view to the unit disc would
    // move it. It is rounded to the whole pixel and clamped to the view
    // instead, which is the same "quantize at the edge" rule in the units this
    // value is actually in, and which makes it survive a recording exactly:
    // a whole-pixel position round-trips through a twelve-bit channel with
    // zero error across the entire 1280x640 view. Measured, not assumed.
    // The spans, not the screen: the pointer arrives already transformed into
    // world axes (along, across), and in vertical mode those spans are the
    // screen's swapped. Every span in use is <= 1280, so the whole-pixel
    // twelve-bit round-trip above still holds in every mode.
    satellitePointer: {
      x: clamp(Math.round(Number(pointer?.x) || 0), 0, spans.along),
      y: clamp(Math.round(Number(pointer?.y) || 0), 0, spans.cross),
      active: pointer?.active === true,
    },
  };
}

const WEAPON_FOR_GUN = { spread: "weapon-spread", rapid: "weapon-rapid", pulse: "weapon-pulse" };

/**
 * @param {object} level A level, already normalised. See `normalizeLevel`.
 * @param {object} [options]
 * @param {{event?: Function} | ((name: string, data?: unknown) => unknown)} [options.report]
 *        Reserved for future signals. Accepted now so adding one later is not a
 *        signature change for every caller.
 */
/**
 * How fast the sector scrolls, in world units per second. Named because two
 * things now read it: the camera advance, and the frame conversion a
 * player-fired bullet pattern needs below.
 */
export const SCROLL_SPEED = 165;

/**
 * Where a player slot's weapon fires from. Absent mount: the nose, with the
 * slots fanned nine units apart across -- the expressions every level before
 * this fired from, kept verbatim so an old level is placed bit for bit. With a
 * mount: an offset in the ship's own frame, turned into the aim frame.
 */
function slotMuzzle(x, y, slot, slotIndex, slotCount, aimX, aimY) {
  const mount = slot.mount;
  if (mount) return { x: x + mount.x * aimX - mount.y * aimY, y: y + mount.x * aimY + mount.y * aimX };
  return { x: x + 29 * aimX, y: y + (slotIndex - (slotCount - 1) / 2) * 9 + 29 * aimY };
}

/**
 * Degrees the sprite is turned from its resting picture, as the renderer draws
 * it: the authored rotation, the spin so far, and the lean toward its heading
 * -- the same three numbers, added the same way. Zero for a level that
 * authored none of them, and zero is checked before any trigonometry runs, so
 * that level fires the vectors it always did, bit for bit.
 *
 * The lean is the renderer's own formula with core's atan2 in place of Math's:
 * the angle off straight-ahead, put back on the side the picture tilts toward,
 * scaled by how far the author asked it to follow.
 */
function facingOffset(enemy) {
  const follow = enemy.heading?.follow ?? 0;
  let lean = 0;
  if (follow && (enemy.vx || enemy.vy)) {
    const side = enemy.vx > 0 ? 1 : -1;
    lean = atan2(enemy.vy, Math.abs(enemy.vx)) * side * follow * 180 / Math.PI;
  }
  return (enemy.rotation ?? 0) + (enemy.turned ?? 0) + lean;
}

/**
 * Whether a disc strikes an enemy. With a hitbox, the disc is tested against
 * its shapes, turned by the same facing the renderer draws -- rotation, spin
 * and lean -- so the box stays on the art however the art is turned. Without
 * one, the circle that striker has always been tested against, with the
 * strict inequality it always used, so a level without hitboxes collides bit
 * for bit as before.
 */
function enemyStruck(enemy, against, x, y, radius) {
  if (enemy.hitbox) return hitboxHitsCircle(enemy.hitbox, enemy.x, enemy.y, enemy.size * enemy.scale, facingOffset(enemy), x, y, radius);
  const reach = radius + itemHitRadius(enemy, against);
  const dx = x - enemy.x;
  const dy = y - enemy.y;
  return dx * dx + dy * dy < reach * reach;
}

/**
 * The unit vector an enemy's shots fly along in the scroll modes: straight out
 * of the front, wherever that is pointing. Enemy art rests facing left, so the
 * front is 180 degrees plus whatever the sprite has turned. With nothing turned
 * this is the literal (-1, 0) every level before this fired.
 */
function enemyAim(enemy) {
  const offset = facingOffset(enemy);
  if (offset === 0) return { x: -1, y: 0 };
  const angle = (180 + offset) * Math.PI / 180;
  return { x: cos(angle), y: sin(angle) };
}

/**
 * Where an enemy's basic fire comes from. Absent mount: the sprite's leading
 * edge, in the expression it always was. With one: an offset in the ship's own
 * frame -- x forward, the way it faces (leftward in the scroll modes, toward
 * the player in the arena) and y across -- turned by the sprite's rotation in
 * the scroll modes, where a ship can be authored at an angle.
 */
function enemyMuzzle(enemy, forwardX, forwardY, arena) {
  const mount = enemy.weapon.mount;
  if (!mount) return { x: enemy.x - forwardX * enemy.size * enemy.scale, y: enemy.y - forwardY * enemy.size * enemy.scale };
  if (arena) return { x: enemy.x + mount.x * forwardX + mount.y * forwardY, y: enemy.y + mount.x * forwardY - mount.y * forwardX };
  const turn = facingOffset(enemy) * Math.PI / 180;
  const ox = -mount.x;
  const oy = mount.y;
  return { x: enemy.x + ox * cos(turn) - oy * sin(turn), y: enemy.y + ox * sin(turn) + oy * cos(turn) };
}

export function createWorld(level, options = {}) {
  void options;
  const mode = level.mode ?? "horizontal";
  // The ship's own radius, from its sprite and scale rather than a constant.
  // Computed once: neither can change mid-run, and asking inside three
  // collision loops would be work per bullet per frame for a fixed answer.
  const shipRadius = playerRadius(level.player, level.assets);
  const spans = viewSpans(mode);
  const alongView = spans.along;
  const crossView = spans.cross;
  // Where positions live relative to the camera. In the scroll modes the
  // camera shifts everything; in the arena it is purely the wave clock and
  // shifts nothing -- the whole difference between "the world moves past you"
  // and "you are somewhere and things come for you" is this one number.
  const shiftX = () => (mode === "arena" ? 0 : state.camera);

  /**
   * A pattern document describes motion in its emitter own frame, which is
   * exactly what the designer previews. An enemy is stationary in world space,
   * so its frame IS world space and nothing is needed. The player and its
   * satellite ride the camera, and in the scroll modes the camera is moving --
   * so converting their pattern shots into world space means adding the
   * camera velocity.
   *
   * Without it the designer lies about the player: a pattern left at the
   * authoring default of 210 nets 45 against a scroll of 165 and crawls, while
   * the very same document on an enemy reads fine because the scroll carries
   * it the other way. Ordinary fire never needed this, because its speeds were
   * tuned in the game rather than authored against a preview that does not
   * scroll.
   *
   * Zero in the arena, where the camera is a wave clock that shifts nothing,
   * and zero once it parks at the end of the sector.
   */
  // The far end of the sector: where the camera parks and the run is won.
  const cameraEnd = Math.max(0, level.length - alongView);

  /**
   * How far the camera may come. Normally the end of the sector; a
   * screen-blocker standing between here and there brings it nearer.
   *
   * Nothing here reads `active`: a blocker asleep four thousand units ahead has
   * its line four thousand units ahead too, so the scroll runs at full speed
   * toward it and wakes it on the way in. The line is authored data alone,
   * which is what lets an editor draw exactly where play will park.
   *
   * Infinity when nothing blocks, so the advance below reduces to exactly the
   * expression every earlier level scrolled by.
   */
  function cameraCeiling() {
    if (mode === "arena") return Infinity;
    let nearest = Infinity;
    for (const enemy of state.enemies) {
      if (!enemy.blocker || !enemy.alive) continue;
      const line = enemy.originX - alongView * enemy.blocker.station / 100;
      // A body the parked camera could never bring on screen must not hold:
      // bullets are culled past the right edge, so it could never be shot and
      // the run would have no end at all. This only fires where the sector's
      // own end clamped the line -- a boss AT the end is fine, one dragged
      // past it, or left behind when END LEVEL was dragged back, is ignored.
      if (enemy.originX >= Math.max(0, Math.min(cameraEnd, line)) + alongView) continue;
      if (line < nearest) nearest = line;
    }
    return nearest;
  }

  const cameraCarry = () => (mode === "arena" ? 0 : state.cameraSpeed);
  const hullMax = initialHull(level.player.armor);
  const satelliteArmor = level.player.satellite.armor;

  const state = {
    camera: 0,
    /**
     * How fast the camera is actually travelling, in world units a second.
     * Zero where it has parked: the end of the sector, or a blocker still
     * standing. A renderer scales its backdrop by this rather than switching
     * a boolean, which would pop the whole starfield.
     */
    cameraSpeed: 0,
    elapsed: 0,
    /** 0..100. Recomputed every step; read it as often or as rarely as suits. */
    progress: 0,
    enemies: expandLevel(level),
    bullets: [],
    enemyBullets: [],
    activePickups: [],
    permanentBoost: { xSpeedBoost: 0, ySpeedBoost: 0, shotSpeedBoost: 0, shotPowerBoost: 0 },
    gun: level.player.gun,
    /** Keyed by slot id, in elapsed seconds — never wall-clock. */
    slotFireAt: {},
    /**
     * Pattern state per slot, for weapons that carry a bullet pattern. The
     * clock inside is elapsed seconds too, and it only advances while the
     * trigger is held — releasing fire pauses a pattern rather than letting
     * it bank a burst.
     */
    slotPatterns: {},
    satellitePattern: null,
    slotWeapons: Object.fromEntries(level.player.weaponSlots.map((slot) => [slot.id, slot.weaponId])),
    inventory: level.player.inventory.slice(),
    /** Arena only: the last non-idle aim, so releasing the stick keeps firing
     *  the way the player was pointing rather than snapping back. */
    aimDir: { x: 1, y: 0 },
    player: {
      x: 180,
      y: crossView / 2,
      invulnerable: 0,
      shield: initialShield(level.player.armor),
      shieldWait: 0,
      satellite: {
        x: 280,
        y: crossView / 2,
        hp: initialHull(satelliteArmor),
        shield: initialShield(satelliteArmor),
        shieldWait: 0,
        /** Seconds until a ram may cost it again. See `damageSatellite`. */
        ramWait: 0,
        fireAt: 0,
        alive: true,
      },
    },
    score: 0,
    hull: hullMax,
    hullMax,
    /** null while the run is live, then "gameover" or "victory". */
    outcome: null,
  };

  let bursts = [];
  let events = [];
  const burst = (x, y, color, count) => { bursts.push({ x, y, color, count }); };

  /**
   * Things that HAPPENED, as opposed to explosions that were asked for.
   *
   * A Burst says where to draw and how big, which is all a generic spray ever
   * needed. What it cannot say is WHAT exploded, so a renderer wanting this
   * raider's explosion and this raider's death sound had nothing to ask with.
   * These carry the authored item's id, which is what a level attaches
   * per-type effects to.
   *
   * A separate queue rather than fields on Burst, because the two answer
   * different questions: a shield soaking a shot is worth a spark and no
   * sound, a weapon firing is worth a sound and no spark. Draining one must
   * not consume the other, and neither should grow fields the other ignores.
   */
  const signal = (event) => { events.push(event); };

  /** The gun a pickup is currently forcing, if any. */
  const temporaryGun = () => [...state.activePickups].reverse().find((pickup) => pickup.gun !== "none")?.gun;

  function effectivePlayer() {
    const base = level.player;
    const boosts = state.activePickups.reduce((total, pickup) => ({
      xSpeedBoost: total.xSpeedBoost + pickup.xSpeedBoost,
      ySpeedBoost: total.ySpeedBoost + pickup.ySpeedBoost,
      shotSpeedBoost: total.shotSpeedBoost + pickup.shotSpeedBoost,
      shotPowerBoost: total.shotPowerBoost + pickup.shotPowerBoost,
    }), { ...state.permanentBoost });
    const forced = temporaryGun();
    return {
      ...base,
      xSpeed: base.xSpeed + boosts.xSpeedBoost,
      ySpeed: base.ySpeed + boosts.ySpeedBoost,
      shotSpeed: base.shotSpeed + boosts.shotSpeedBoost,
      shotPower: base.shotPower + boosts.shotPowerBoost,
      gun: forced && forced !== "none" ? forced : state.gun,
    };
  }

  /** The firing direction: +along in the scroll modes, the held aim in arena. */
  const aimX = () => (mode === "arena" ? state.aimDir.x : 1);
  const aimY = () => (mode === "arena" ? state.aimDir.y : 0);
  const aimRotation = () => (mode === "arena" ? atan2(state.aimDir.y, state.aimDir.x) * 180 / Math.PI : 0);

  function fire() {
    const player = state.player;
    const now = state.elapsed;
    const settings = effectivePlayer();

    settings.weaponSlots.forEach((slot, slotIndex) => {
      const forcedId = WEAPON_FOR_GUN[temporaryGun()];
      // A pickup only ever overrides the primary slot. Anything else and a
      // deliberate two-weapon loadout is silently collapsed by a power-up.
      const override = slotIndex === 0 && Boolean(forcedId);
      const weaponId = override ? forcedId : state.slotWeapons[slot.id] ?? slot.weaponId;
      if ((!state.inventory.includes(weaponId) && !override) || now < (state.slotFireAt[slot.id] ?? 0)) return;
      const component = level.components.find((entry) => entry.id === weaponId);
      const weapon = component?.weapon;
      if (!weapon || !weaponFitsSlot(component, slot.accepts)) return;

      if (weapon.pattern) {
        // A pattern weapon ignores slotFireAt: the pattern's own fire rate is
        // the cadence, and its runtime advances on the gap since it last
        // fired — in elapsed seconds, so a replay reproduces every bullet.
        const pattern = weapon.pattern;
        let slotState = state.slotPatterns[slot.id];
        if (!slotState || slotState.patternId !== pattern.id) {
          slotState = state.slotPatterns[slot.id] = { runtime: createBulletPatternRuntime(pattern), lastAt: now, patternId: pattern.id };
        }
        const patternDt = clamp(now - slotState.lastAt, 0, 0.05);
        slotState.lastAt = now;
        const emitted = advanceBulletPattern(slotState.runtime, pattern, patternDt, {
          origin: slotMuzzle(shiftX() + player.x, player.y, slot, slotIndex, settings.weaponSlots.length, aimX(), aimY()),
          rotation: aimRotation(),
          maxProjectiles: pattern.projectileCap,
          currentProjectiles: state.bullets.length,
        });
        // The shot scales with SHOT SPEED exactly as ordinary fire does, which is
        // what makes an Overdrive or a Reactor Upgrade reach a pattern weapon at
        // all: the boost reached every other weapon and silently skipped this
        // one. The carry is a frame conversion, so it is not scaled.
        const shotScale = settings.shotSpeed / 800;
        const carry = cameraCarry();
        if (emitted.length) signal({ type: "fired", by: "player", sourceId: weaponId, x: shiftX() + player.x, y: player.y });
        for (const projectile of emitted) {
          state.bullets.push({
            ...projectile,
            vx: projectile.vx * shotScale + carry,
            vy: projectile.vy * shotScale,
            power: projectile.power * weapon.power * settings.shotPower / 100,
            source: "player",
          });
        }
        return;
      }

      state.slotFireAt[slot.id] = now + 1 / Math.max(0.1, weapon.shotsPerSecond);
      signal({ type: "fired", by: "player", sourceId: weaponId, x: shiftX() + player.x, y: player.y });
      const count = Math.max(1, weapon.spread);
      const speed = weapon.projectileSpeed * settings.shotSpeed / 800;
      const power = weapon.power * settings.shotPower / 100;
      for (let index = 0; index < count; index += 1) {
        // Spread fans perpendicular to the firing direction. In the scroll
        // modes the direction is +along, so this is exactly the old
        // vx = speed, vy = lateral -- bit for bit.
        const lateral = count === 1 ? 0 : (index - (count - 1) / 2) * 105;
        state.bullets.push({
          ...slotMuzzle(shiftX() + player.x, player.y, slot, slotIndex, settings.weaponSlots.length, aimX(), aimY()),
          vx: speed * aimX() - lateral * aimY(), vy: speed * aimY() + lateral * aimX(),
          acceleration: 0, age: 0, lifetime: 12, angularVelocity: 0, emitterId: slot.id,
          radius: power >= 300 ? 6 : 4,
          power, color: weapon.color, sprite: "bolt", source: "player",
        });
      }
    });

    const satelliteSettings = level.player.satellite;
    const satellite = player.satellite;
    if (satelliteSettings.enabled && satellite.alive) {
      const component = level.components.find((entry) => entry.id === satelliteSettings.weaponId);
      const weapon = component?.weapon;
      if (weapon?.pattern) {
        const pattern = weapon.pattern;
        let patternState = state.satellitePattern;
        if (!patternState || patternState.patternId !== pattern.id) {
          patternState = state.satellitePattern = { runtime: createBulletPatternRuntime(pattern), lastAt: now, patternId: pattern.id };
        }
        const patternDt = clamp(now - patternState.lastAt, 0, 0.05);
        patternState.lastAt = now;
        const emitted = advanceBulletPattern(patternState.runtime, pattern, patternDt, {
          origin: { x: shiftX() + satellite.x + 18 * aimX(), y: satellite.y + 18 * aimY() },
          rotation: aimRotation(),
          maxProjectiles: pattern.projectileCap,
          currentProjectiles: state.bullets.length,
        });
        const carry = cameraCarry();
        if (emitted.length) signal({ type: "fired", by: "satellite", sourceId: satelliteSettings.weaponId, x: shiftX() + satellite.x, y: satellite.y });
        for (const projectile of emitted) {
          state.bullets.push({ ...projectile, vx: projectile.vx + carry, power: projectile.power * weapon.power / 100, source: "satellite" });
        }
      } else if (weapon && now >= satellite.fireAt) {
        satellite.fireAt = now + 1 / Math.max(0.1, weapon.shotsPerSecond);
        signal({ type: "fired", by: "satellite", sourceId: satelliteSettings.weaponId, x: shiftX() + satellite.x, y: satellite.y });
        const count = Math.max(1, weapon.spread);
        for (let index = 0; index < count; index += 1) {
          const lateral = count === 1 ? 0 : (index - (count - 1) / 2) * 80;
          state.bullets.push({
            x: shiftX() + satellite.x + 18 * aimX(), y: satellite.y + 18 * aimY(),
            vx: weapon.projectileSpeed * aimX() - lateral * aimY(),
            vy: weapon.projectileSpeed * aimY() + lateral * aimX(),
            acceleration: 0, age: 0, lifetime: 12, angularVelocity: 0, emitterId: "satellite",
            radius: 4, power: weapon.power, color: weapon.color, sprite: "bolt", source: "satellite",
          });
        }
      }
    }
  }

  function moveSatellite(dt, input) {
    const settings = level.player.satellite;
    const player = state.player;
    const satellite = player.satellite;
    if (!settings.enabled || !satellite.alive) return;

    const controlX = input.satelliteAxis.x;
    const controlY = input.satelliteAxis.y;
    const controlMagnitude = hypot(controlX, controlY);
    const pointer = input.satellitePointer;
    let targetX = satellite.x;
    let targetY = satellite.y;

    if (controlMagnitude > 0.12) {
      if (settings.mode === "tether") {
        targetX = satellite.x + controlX * settings.speed * dt * 3;
        targetY = satellite.y + controlY * settings.speed * dt * 3;
        const tx = targetX - player.x;
        const ty = targetY - player.y;
        const td = Math.max(1, hypot(tx, ty));
        if (td > settings.range) {
          targetX = player.x + tx / td * settings.range;
          targetY = player.y + ty / td * settings.range;
        }
      } else {
        targetX = player.x + controlX / controlMagnitude * settings.range;
        targetY = player.y + controlY / controlMagnitude * settings.range;
      }
    } else if (pointer.active) {
      const px = pointer.x - player.x;
      const py = pointer.y - player.y;
      const distance = Math.max(1, hypot(px, py));
      const limit = settings.mode === "tether" ? Math.min(distance, settings.range) : settings.range;
      targetX = player.x + px / distance * limit;
      targetY = player.y + py / distance * limit;
    } else {
      // Nothing steering it: drift around the ship so it never sits still.
      const angle = state.elapsed * 1.6;
      targetX = player.x + cos(angle) * settings.range;
      targetY = player.y + sin(angle) * settings.range;
    }

    const distance = Math.max(1, hypot(targetX - satellite.x, targetY - satellite.y));
    const follow = Math.min(1, settings.speed * dt / distance);
    satellite.x += (targetX - satellite.x) * follow;
    satellite.y += (targetY - satellite.y) * follow;
    satellite.x = clamp(satellite.x, 26, alongView - 26);
    satellite.y = clamp(satellite.y, 28, crossView - 28);
    rechargeShield(satellite, settings.armor, dt);
    satellite.ramWait = Math.max(0, satellite.ramWait - dt);
  }

  function moveEnemies(dt) {
    for (const enemy of state.enemies) {
      if (!enemy.alive) continue;
      // Decorations activate against their own parallax camera, or a distant
      // backdrop pops into view long after the things in front of it.
      const activationCamera = enemy.type === "decoration" ? state.camera * (enemy.decoration?.parallax ?? 1) : state.camera;
      if (!enemy.active && enemy.originX < activationCamera + alongView + 260) {
        enemy.active = true;
        if (mode === "arena") {
          // The arena reads an item's y as a bearing: where around the edge it
          // comes from, spread over the full cross span. Spawn just outside an
          // ellipse around the bounds and walk in from there.
          const bearing = (enemy.originY / crossView) * Math.PI * 2;
          // Pickups land INSIDE the bounds -- a powerup on the perimeter would
          // sit outside the player's movement clamp and be uncollectable.
          const inward = enemy.type === "powerup" || enemy.type === "upgrade" ? 0.3 : 0;
          enemy.baseX = alongView / 2 + cos(bearing) * (inward ? alongView * inward : alongView / 2 + 90);
          enemy.baseY = crossView / 2 + sin(bearing) * (inward ? crossView * inward : crossView / 2 + 70);
          enemy.x = enemy.baseX;
          enemy.y = enemy.baseY;
        }
      }
      if (!enemy.active) continue;

      // Where it was, for the heading recorded below. `settled` is read before
      // the age advances, so it is false on the very frame the enemy spawned.
      const fromX = enemy.x;
      const fromY = enemy.y;
      const settled = enemy.age > 0;

      enemy.age += dt;
      // How far the sprite has turned on itself: closed form in age, like the
      // position, so a rewind is a subtraction. The renderer adds it to the
      // authored rotation, and so does the muzzle -- a spinning turret's gun
      // goes round with it.
      enemy.turned = (enemy.movement.spin ?? 0) * enemy.age;
      rechargeShield(enemy, enemy.armor, dt);
      const cycle = enemy.age * enemy.movement.frequency * Math.PI * 2 + enemy.phase;
      if (mode === "arena") {
        // Homing has no closed form -- the target moves -- so the arena is the
        // one mode that integrates instead of deriving position from age, and
        // the rewind-by-subtraction property the scroll modes keep does not
        // hold here. The wobble is a position offset perpendicular to the
        // heading, applied to an integrated base so it cannot accumulate.
        const holds = enemy.type === "terrain" || enemy.type === "decoration" || enemy.movement.pattern === "stationary";
        if (!holds && enemy.type !== "powerup" && enemy.type !== "upgrade") {
          const px = state.player.x - enemy.baseX;
          const py = state.player.y - enemy.baseY;
          const reach = Math.max(1, hypot(px, py));
          enemy.baseX += px / reach * enemy.movement.speed * dt;
          enemy.baseY += py / reach * enemy.movement.speed * dt;
          // The same wobble the scroll modes use. This was a second copy that
          // named sine and zigzag literally, which left every pattern added
          // since silently flat in the arena.
          const wobble = crossWobble(enemy.movement.pattern, cycle, enemy.movement.amplitude);
          enemy.x = enemy.baseX - py / reach * wobble;
          enemy.y = enemy.baseY + px / reach * wobble;
        } else {
          enemy.x = enemy.baseX;
          enemy.y = enemy.baseY;
        }
      } else {
        // A thing that was asked to wait waits where it was placed, and the
        // wait is timed from the moment it can be SEEN: activation fires 260
        // units past the right edge, so a wait counted from spawn is spent
        // off screen where nobody watches it happen. Its queue place, if it is
        // one of a peeling formation, is added on top.
        const wait = (enemy.movement.stall ?? 0) + (enemy.peelRank ?? 0) * (enemy.group?.peel ?? 0);
        if (wait > 0 && enemy.releaseAge === undefined) {
          // Sighted as a BODY, on the anchor the author placed, not on each
          // member's own spread-out origin: members sighted a frame apart
          // release a frame apart, latch the player a frame apart, and the
          // wave arrives bent. One clock for the formation, and the peel
          // stagger below is then the only thing that separates them.
          if (enemy.sightedAge === undefined && (enemy.anchorX ?? enemy.originX) < state.camera + alongView) enemy.sightedAge = enemy.age;
          if (enemy.sightedAge !== undefined && enemy.age >= enemy.sightedAge + wait) {
            enemy.releaseAge = enemy.age;
            // The lock, resolved once and never again: from the anchor the
            // author placed, so every member of a formation dives on the same
            // heading rather than each sighting the player a frame apart and
            // arriving bent. A constant from here, so the path below is still
            // a closed form in the age it is handed.
            const lock = enemy.movement.lock ?? 0;
            if (lock > 0) {
              const toward = atan2(enemy.anchorY - state.player.y, (enemy.anchorX ?? enemy.originX) - (shiftX() + state.player.x));
              const authored = (enemy.movement.angle ?? 0) * Math.PI / 180;
              const turned = authored + (toward - authored) * lock;
              enemy.flightMovement = { ...enemy.movement, angle: turned * 180 / Math.PI };
            }
          }
        }
        // Position is derived from age rather than integrated, so a rewind is
        // a subtraction rather than a replay. The path itself -- turned,
        // curved, wobbling -- belongs to movement.js, shared with the editor's
        // preview so the two cannot disagree.
        const flown = wait > 0 ? Math.max(0, enemy.age - (enemy.releaseAge ?? enemy.age)) : enemy.age;
        // What "pinned" means for this body. Terrain always was. A blocker is
        // too: the scroll is what carries it into frame, and one that flew
        // would leave the window it is holding -- past the firing gate and out
        // of bullet range. `pinAlong` on top, because `holds` alone keeps the
        // part of the wobble that runs ALONG the axis, and the camera is parked
        // at a line measured from the origin. Both are constants of the
        // authored item, so the position stays a closed form in age.
        const held = enemy.type === "terrain" || Boolean(enemy.blocker);
        const spot = movementPosition(enemy.flightMovement ?? enemy.movement, enemy.originX, enemy.originY, flown, { holds: held, phase: enemy.phase, pinAlong: Boolean(enemy.blocker) });
        enemy.x = spot.x;
        enemy.y = spot.y;
      }

      // Which way it is going, for a renderer that turns a sprite toward its
      // heading. A finite difference rather than each pattern's derivative, so
      // sine, zigzag and the arena's homing -- which has no closed form -- all
      // answer the same way, and a new pattern needs no second formula here.
      // Plain arithmetic on state, so a replay reproduces it exactly.
      if (dt > 0) {
        if (settled) {
          enemy.vx = (enemy.x - fromX) / dt;
          enemy.vy = (enemy.y - fromY) / dt;
        } else if (mode !== "arena") {
          // The spawn frame. The phase is folded into the first position, so
          // the jump from the origin is not a velocity -- but the scroll paths
          // are closed form in age, so the path's own first step is. Read from
          // there, a ship that fires the instant it appears fires where its
          // nose points rather than dead level for one frame. The arena spawns
          // by a jump and has no closed form, so it reports nothing until it
          // has moved.
          const start = movementPosition(enemy.movement, enemy.originX, enemy.originY, 0, { holds: enemy.type === "terrain", phase: enemy.phase });
          enemy.vx = (enemy.x - start.x) / dt;
          enemy.vy = (enemy.y - start.y) / dt;
        }
      }

      // Only fire while on screen and past the player's nose. An enemy shooting
      // from off the right edge is an unavoidable hit.
      // ...and, now that an editor may place an enemy above or below the band
      // so it enters from the top or bottom, not from off those edges either:
      // a shot from a ship the player cannot see is the same unavoidable hit
      // whichever edge it is behind.
      const onScreen = mode === "arena"
        ? enemy.x > -20 && enemy.x < alongView + 20 && enemy.y > -20 && enemy.y < crossView + 20
        : enemy.x > state.camera + 100 && enemy.x < state.camera + alongView + 20 && enemy.y > -20 && enemy.y < crossView + 20;
      if (enemy.weapon.enabled && enemy.type === "enemy" && onScreen) {
        if (enemy.weapon.pattern) {
          // Enemies are the one emitter that aims: the pattern gets the
          // player as a target and faces left. The runtime accumulates
          // forward, which a replay reproduces from the start; a rollback
          // rewind would need it snapshotted, and that is noted in the d.ts
          // rather than half-solved here.
          enemy.patternRuntime ??= createBulletPatternRuntime(enemy.weapon.pattern);
          // A pattern fires from the mount too; without one it fires from where
          // it always has -- the centre in the arena, the leading edge elsewhere.
          const patternMuzzle = enemy.weapon.mount
            ? (() => {
              const px = shiftX() + state.player.x - enemy.x;
              const py = state.player.y - enemy.y;
              const reach = Math.max(1, hypot(px, py));
              return enemyMuzzle(enemy, mode === "arena" ? px / reach : 1, mode === "arena" ? py / reach : 0, mode === "arena");
            })()
            : (mode === "arena" ? { x: enemy.x, y: enemy.y } : { x: enemy.x - enemy.size * enemy.scale, y: enemy.y });
          const emitted = advanceBulletPattern(enemy.patternRuntime, enemy.weapon.pattern, dt, {
            origin: patternMuzzle,
            target: { x: shiftX() + state.player.x, y: state.player.y },
            rotation: mode === "arena" ? atan2(state.player.y - enemy.y, shiftX() + state.player.x - enemy.x) * 180 / Math.PI : 180 + facingOffset(enemy),
            maxProjectiles: enemy.weapon.pattern.projectileCap,
            currentProjectiles: state.enemyBullets.length,
          });
          if (emitted.length) signal({ type: "fired", by: "enemy", sourceId: enemy.sourceId, x: enemy.x, y: enemy.y });
          for (const projectile of emitted) state.enemyBullets.push(projectile);
        } else {
          enemy.fireTimer -= dt;
          if (enemy.fireTimer <= 0) {
            signal({ type: "fired", by: "enemy", sourceId: enemy.sourceId, x: enemy.x, y: enemy.y });
            const towardX = shiftX() + state.player.x - enemy.x;
            const towardY = state.player.y - enemy.y;
            const towardLength = Math.max(1, hypot(towardX, towardY));
            const muzzle = enemyMuzzle(enemy, mode === "arena" ? towardX / towardLength : 1, mode === "arena" ? towardY / towardLength : 0, mode === "arena");
            // Along the ship's front. A ship that leans into its path, spins, or
            // was authored at an angle fires where its nose points; one that does
            // none of those fires the exact vector it always did.
            const aim = mode === "arena" ? { x: towardX / towardLength, y: towardY / towardLength } : enemyAim(enemy);
            state.enemyBullets.push({
              x: muzzle.x,
              y: muzzle.y,
              // A sine projectile wobbles about the line it was fired along, so
              // a mounted gun's shots wobble about the mount, not the hull.
              originY: enemy.weapon.mount ? muzzle.y : enemy.y,
              vx: aim.x * enemy.weapon.projectileSpeed,
              vy: aim.y * enemy.weapon.projectileSpeed,
              acceleration: 0, lifetime: 30, angularVelocity: 0, emitterId: enemy.sourceId,
              radius: enemy.weapon.projectile === "plasma" ? 7 : 4,
              power: enemy.weapon.power, age: 0,
              // The colours these two sprites have always rendered as, now on
              // the bullet itself so every projectile colours the same way.
              color: enemy.weapon.projectile === "plasma" ? "#ff8d73" : "#df8cff",
              movement: enemy.weapon.projectileMovement, sprite: enemy.weapon.projectile,
            });
            enemy.fireTimer = Math.max(0.1, 1 / Math.max(0.1, enemy.weapon.shotsPerSecond)) + enemy.weapon.cooldown;
          }
        }
      }
    }
  }

  function collidePlayerBullets() {
    const dead = new Set();
    for (const bullet of state.bullets) {
      for (const enemy of state.enemies) {
        if (!enemy.alive || !enemy.active || (enemy.type !== "enemy" && enemy.type !== "terrain")) continue;
        if (!enemyStruck(enemy, "bullet", bullet.x, bullet.y, bullet.radius)) continue;
        dead.add(bullet);
        // Indestructible: the shot is spent and sparks, and that is all that
        // happens. No shield, no hull, no score, and never destroyed.
        if (enemy.indestructible) { burst(bullet.x, bullet.y, "#9fb3bb", 6); break; }
        const { remaining, absorbed } = absorbWithShield(enemy, enemy.armor, bullet.power);
        if (absorbed > 0) burst(bullet.x, bullet.y, "#64e3ff", 7);
        if (remaining > 0) enemy.hp -= remaining * (enemy.armor?.damageMultiplier ?? 1);
        burst(bullet.x, bullet.y, bullet.color, 5);
        if (enemy.hp <= 0) {
          enemy.alive = false;
          burst(enemy.x, enemy.y, enemy.type === "terrain" ? "#91a2a9" : "#ff6a4d", 18);
          // sourceId, not id: a group's members share the authored item they
          // came from, and that item is the thing effects were attached to.
          signal({ type: "destroyed", kind: enemy.type, sourceId: enemy.sourceId, x: enemy.x, y: enemy.y });
          // Smaller is worth more: it is harder to hit.
          state.score += Math.max(25, Math.round(175 - enemy.size));
        }
        break;
      }
    }
    return dead;
  }

  function collectPickups(playerWorldX) {
    const player = state.player;
    for (const pickup of state.enemies) {
      if (!pickup.alive || !pickup.active || (pickup.type !== "powerup" && pickup.type !== "upgrade")) continue;
      if (!enemyStruck(pickup, "ship", playerWorldX, player.y, shipRadius)) continue;
      pickup.alive = false;
      burst(pickup.x, pickup.y, pickup.type === "powerup" ? "#eaff62" : "#64e3ff", 22);
      signal({ type: "pickup", kind: pickup.type, sourceId: pickup.sourceId, x: pickup.x, y: pickup.y });
      const effect = pickup.pickup;
      if (!effect) continue;

      if (pickup.type === "powerup") {
        state.activePickups.push({ ...effect, name: pickup.name, expires: state.elapsed + Math.max(0.5, effect.duration) });
        continue;
      }
      state.permanentBoost.xSpeedBoost += effect.xSpeedBoost;
      state.permanentBoost.ySpeedBoost += effect.ySpeedBoost;
      state.permanentBoost.shotSpeedBoost += effect.shotSpeedBoost;
      state.permanentBoost.shotPowerBoost += effect.shotPowerBoost;
      if (effect.gun === "none") continue;
      state.gun = effect.gun;
      const weaponId = WEAPON_FOR_GUN[effect.gun] ?? "weapon-pulse";
      if (!state.inventory.includes(weaponId)) {
        if (state.inventory.length >= level.player.inventoryLimit) state.inventory.pop();
        state.inventory.push(weaponId);
      }
      const slot = level.player.weaponSlots.find((entry) => entry.accepts === "standard" || entry.accepts === "any");
      if (slot) state.slotWeapons[slot.id] = weaponId;
    }
  }

  function damageSatellite() {
    const settings = level.player.satellite;
    const satellite = state.player.satellite;
    if (!settings.enabled || !satellite.alive) return;

    const kill = () => {
      satellite.alive = false;
      burst(shiftX() + satellite.x, satellite.y, "#ff6a4d", 24);
      signal({ type: "destroyed", kind: "satellite", x: shiftX() + satellite.x, y: satellite.y });
    };

    for (const enemy of state.enemies) {
      if (!enemy.alive || !enemy.active || (enemy.type !== "enemy" && enemy.type !== "terrain")) continue;
      if (!enemyStruck(enemy, "satellite", shiftX() + satellite.x, satellite.y, SATELLITE_HIT_RADIUS)) continue;
      // Indestructible: the ram is spent on it exactly as a shot is. It sparks,
      // the striker still pays, and the thing is still standing afterwards.
      //
      // A body that survives is still being touched on the next frame, so the
      // ram costs its 100 once and then holds off for the window a hull hit
      // buys the ship. Charging it every frame is not "the satellite takes its
      // 100": it is 600 inside a twentieth of a second, and a satellite that
      // brushed a wall would be gone before the player saw it touch.
      if (enemy.indestructible) {
        burst(shiftX() + satellite.x, satellite.y, "#9fb3bb", 8);
        if (satellite.ramWait > 0) continue;
        satellite.ramWait = 1.5;
      } else {
        enemy.alive = false;
        burst(enemy.x, enemy.y, "#64e3ff", 20);
        signal({ type: "destroyed", kind: enemy.type, sourceId: enemy.sourceId, x: enemy.x, y: enemy.y });
      }
      const { remaining } = absorbWithShield(satellite, settings.armor, 100);
      satellite.hp -= hullDamage(remaining, settings.armor);
    }
    if (satellite.hp <= 0) { kill(); return; }

    state.enemyBullets = state.enemyBullets.filter((bullet) => {
      if (!satellite.alive) return true;
      const x = shiftX() + satellite.x - bullet.x;
      const y = satellite.y - bullet.y;
      if (x * x + y * y >= (15 + bullet.radius) ** 2) return true;
      const { remaining } = absorbWithShield(satellite, settings.armor, bullet.power * 100);
      satellite.hp -= hullDamage(remaining, settings.armor);
      burst(bullet.x, bullet.y, "#64e3ff", 12);
      if (satellite.hp <= 0) kill();
      return false;
    });
  }

  function damagePlayer(playerWorldX) {
    const player = state.player;
    if (player.invulnerable > 0) return;

    let damage = 0;
    for (const enemy of state.enemies) {
      if (!enemy.alive || !enemy.active || (enemy.type !== "enemy" && enemy.type !== "terrain")) continue;
      if (!enemyStruck(enemy, "ship", playerWorldX, player.y, shipRadius)) continue;
      damage = Math.max(damage, 1);
      // Indestructible: the ram costs the ship exactly what a ram costs it and
      // leaves the thing standing. The grace window opened below is what keeps
      // leaning on a wall from draining the hull a frame at a time.
      if (enemy.indestructible) { burst(playerWorldX, player.y, "#9fb3bb", 8); continue; }
      enemy.alive = false;
      burst(enemy.x, enemy.y, "#64e3ff", 20);
    }
    state.enemyBullets = state.enemyBullets.filter((bullet) => {
      const x = playerWorldX - bullet.x;
      const y = player.y - bullet.y;
      if (x * x + y * y >= (shipRadius + bullet.radius) ** 2) return true;
      damage = Math.max(damage, bullet.power);
      burst(bullet.x, bullet.y, "#64e3ff", 10);
      return false;
    });
    if (damage <= 0) return;

    const armor = level.player.armor;
    const { remaining, absorbed } = absorbWithShield(player, armor, damage * 100);
    if (absorbed > 0) burst(playerWorldX, player.y, "#64e3ff", 14);
    const pips = hullDamage(remaining, armor);
    // A shield-only hit still buys a moment of grace, or a dense wall drains a
    // full field in three frames.
    player.invulnerable = pips > 0 ? 1.5 : 0.25;
    // A shield-only hit is still a hit worth hearing, so this is signalled
    // before the early return rather than after it.
    signal({ type: "playerHit", shielded: pips <= 0, x: playerWorldX, y: player.y });
    if (pips <= 0) return;
    state.hull = Math.max(0, state.hull - pips);
    if (state.hull === 0) {
      state.outcome = "gameover";
      signal({ type: "playerDied", x: playerWorldX, y: player.y });
    }
  }

  /**
   * @param {number} dt Seconds. A fixed step if you intend to replay this.
   * @param {WorldInput} rawInput
   */
  function step(dt, rawInput) {
    // Quantized here as a floor, not as the intended place: a caller that
    // records or networks its input should have done it at the edge. Doing it
    // again is exact and free, and doing it never is a desync.
    const input = normalizeWorldInput(rawInput, spans);
    if (state.outcome) return;
    const player = state.player;

    // Holding the stick steers the guns; releasing it keeps them where they
    // were. Scroll modes never read this.
    if (mode === "arena" && hypot(input.aim.x, input.aim.y) > 0.25) {
      const length = hypot(input.aim.x, input.aim.y);
      state.aimDir = { x: input.aim.x / length, y: input.aim.y / length };
    }

    state.elapsed += dt;
    state.activePickups = state.activePickups.filter((pickup) => pickup.expires > state.elapsed);
    // Read before the advance, so aliveness is as the previous step left it: a
    // blocker killed on one step releases the scroll on the next, identically
    // in every replay.
    const ceiling = Math.min(cameraEnd, cameraCeiling());
    state.camera = Math.max(0, Math.min(ceiling, state.camera + SCROLL_SPEED * dt));
    // After the advance, by the same test the carry used to make inline, so a
    // sector with no blocker reports what it always did on every frame.
    state.cameraSpeed = state.camera >= ceiling ? 0 : SCROLL_SPEED;
    state.progress = Math.min(100, state.camera / Math.max(1, level.length - alongView) * 100);

    // Already clamped to the unit disc by `normalizeWorldInput`, which is
    // where the "normalise only past unit length, so a half-deflected stick
    // stays half" rule now lives -- shared with the other genre rather than
    // written twice.
    const dx = input.dx;
    const dy = input.dy;
    const settings = effectivePlayer();
    // Where the ship may fly: in from each edge by the level's share of the
    // view. The right limit is a scroll concept -- it holds the ship back from
    // the nose of a scrolling view -- and the arena has no nose, so it ignores
    // RIGHT and mirrors LEFT. A box authored shut leaves the ship pinned to
    // its near edge rather than clamped between crossed bounds.
    const { limits } = settings;
    const minX = alongView * limits.left / 100;
    const maxX = mode === "arena" ? alongView - minX : alongView * (100 - limits.right) / 100;
    const minY = crossView * limits.top / 100;
    const maxY = crossView * (100 - limits.bottom) / 100;
    player.x = clamp(player.x + dx * settings.xSpeed * dt, minX, Math.max(minX, maxX));
    player.y = clamp(player.y + dy * settings.ySpeed * dt, minY, Math.max(minY, maxY));
    player.invulnerable = Math.max(0, player.invulnerable - dt);
    rechargeShield(player, level.player.armor, dt);

    moveSatellite(dt, input);
    if (input.fire) fire();
    moveEnemies(dt);

    // One motion model for every projectile, pattern-fired or not — the same
    // advance the designer's preview runs, so an authored pattern plays
    // exactly as it previewed. The legacy sine wobble stays as a post-pass
    // because it is a position override, not a velocity.
    const bulletBounds = { width: mode === "arena" ? alongView : level.length + alongView, height: crossView, margin: 180 };
    state.bullets = advancePatternProjectiles(state.bullets, dt, bulletBounds);
    state.enemyBullets = advancePatternProjectiles(state.enemyBullets, dt, bulletBounds);
    for (const bullet of state.enemyBullets) {
      if (bullet.movement === "sine" && bullet.originY !== undefined) bullet.y = bullet.originY + sin(bullet.age * 8) * 24;
    }

    const playerWorldX = shiftX() + player.x;
    const deadBullets = collidePlayerBullets();
    collectPickups(playerWorldX);
    damageSatellite();
    damagePlayer(playerWorldX);

    const insideCross = (bullet) => mode !== "arena" || (bullet.y > -80 && bullet.y < crossView + 80);
    state.bullets = state.bullets.filter((bullet) => !deadBullets.has(bullet) && bullet.x > shiftX() - 80 && bullet.x < shiftX() + alongView + 80 && insideCross(bullet));
    state.enemyBullets = state.enemyBullets.filter((bullet) => bullet.x > shiftX() - 60 && bullet.x < shiftX() + alongView + 80 && insideCross(bullet));

    // Checked last, and only if nothing else ended the run: dying on the step
    // that reaches the end of the level is dying.
    // Arrival alone is no longer enough: victory was purely "the camera
    // parked", so a blocker whose line falls at or past the end of the sector
    // would be skipped -- camera parked, run won, boss still standing. The same
    // ceiling answers it, and its reachability floor is what keeps a boss the
    // camera can never reach from making a run unendable.
    if (!state.outcome && state.camera >= cameraEnd && cameraCeiling() === Infinity) {
      state.outcome = "victory";
      state.progress = 100;
    }
  }

  return {
    get state() { return state; },
    get level() { return level; },
    step,

    /** Take the explosions requested since the last call. */
    drainBursts() {
      const taken = bursts;
      bursts = [];
      return taken;
    },

    /**
     * Take what happened since the last call: what was destroyed, what fired,
     * what was collected — each naming the authored item it came from, so the
     * presentation layer can look up the effects the level attached to it.
     */
    drainEvents() {
      const taken = events;
      events = [];
      return taken;
    },

    /**
     * Cycle, or select, the primary slot's weapon from what is carried.
     *
     * @param {number} [requestedIndex] Omit to advance to the next compatible
     *        weapon; pass an index to pick one directly.
     * @returns {string|null} The equipped weapon's name, or null if nothing
     *          compatible is carried — which is what a caller shows a message
     *          for, and the reason this returns a name rather than a boolean.
     */
    equipWeapon(requestedIndex) {
      const slot = level.player.weaponSlots[0];
      if (!slot) return null;
      const compatible = state.inventory.filter((id) =>
        weaponFitsSlot(level.components.find((entry) => entry.id === id), slot.accepts));
      if (!compatible.length) return null;
      const active = state.slotWeapons[slot.id] ?? slot.weaponId;
      const nextIndex = requestedIndex === undefined
        ? (compatible.indexOf(active) + 1) % compatible.length
        : clamp(requestedIndex, 0, compatible.length - 1);
      const weaponId = compatible[nextIndex];
      state.slotWeapons[slot.id] = weaponId;
      return level.components.find((component) => component.id === weaponId)?.name ?? "WEAPON";
    },

    /** The player's stats as they currently are, boosts and pickups included. */
    effectivePlayer,
  };
}
