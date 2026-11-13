// The run: what playing a top-down world actually does.
//
// One step function serves all three flavours Ryan chose, because they
// differ in data rather than in kind — a quest is rooms with locked doors,
// a crawl is an open field with a seeded floor, a horde is one room with a
// spawn table. The rules that vary live in `world.rules`; the rules that
// do not live here.
//
// **The step's phase order is part of the simulation** and must never be
// reshuffled:
//
//   1 input        sticks snapped, edges read
//   2 heroes       move, swing, cast
//   3 shots        projectiles advance, patterns emit
//   4 enemies      behaviours choose, bodies move
//   5 combat       strikes and shots resolve, touch damage, deaths
//   6 pickups      what is stood on is taken
//   7 rooms        gates seal and open, doors admit
//   8 waves        the horde's spawner
//   9 camera       which follows from where the heroes ended up
//  10 outcome      win, lose, or carry on
//
// Two machines disagreeing about whether a heart was taken before or after
// the blow that would have needed it is a desync, not a nuance.
//
// The contract every world here keeps: **data in, state out** — nothing
// draws, nothing reads a clock, everything noteworthy is a queued event a
// renderer drains. **Deterministic** — arithmetic and comparisons, angles
// through `core/trig`, and the dice a plain seeded state that snapshots.
// **It snapshots** — plain data all the way down, because rollback co-op
// is version one and cannot be retrofitted.

import { PI, atan2, cos, sin } from "../core/trig.js";
import { snapStick } from "../core/stick.js";
import {
  advanceBulletPattern,
  advancePatternProjectiles,
  createBulletPatternRuntime,
  normalizeBulletPattern,
} from "../patterns/patterns.js";
import {
  TOPDOWN_HAZARD,
  TOPDOWN_WATER,
  normalizeTopdownWorld,
} from "./contract.js";
import {
  bodyCenterX,
  bodyCenterY,
  boxesOverlap,
  stepBody,
  stepBodyX,
  stepBodyY,
  tileCodeAt,
  tileCodeAtPoint,
} from "./move.js";
import { angleOf, createStrike, strikeCovers, woundBody } from "./combat.js";
import { runTopdownBehavior } from "./behaviors.js";
import { createRandomState, randomNext, randomWeighted } from "./random.js";

/** How far a hero's shot spawns from their centre, so it clears them. */
const MUZZLE = 8;

/**
 * @param {object} world A world document, normalized or raw.
 * @param {object} [options]
 * @param {number} [options.players] Seats, 1 to 4.
 * @param {number} [options.mapIndex] Which map to start on.
 */
export function createRun(world, { players = 1, mapIndex = 0 } = {}) {
  const spec = normalizeTopdownWorld(world);
  const seats = Math.max(1, Math.min(4, Math.round(players) || 1));
  const feel = spec.feel;

  /** Definitions by id, so a placement resolves in one lookup. */
  const actorDefs = new Map(spec.actors.map((actor) => [actor.id, actor]));
  // From the NORMALIZED world, not the raw one: a spell that only worked
  // before the document was saved is a spell the game loses on reload.
  const patterns = new Map(spec.patterns.map((pattern) => [pattern.id, pattern]));

  let nextId = 1;
  const makeId = () => nextId++;

  let map = spec.maps[Math.max(0, Math.min(spec.maps.length - 1, Math.round(mapIndex) || 0))];
  /** Mutable during the run: a broken pot is a floor tile afterwards. */
  let tiles = [...map.tiles];

  const field = {
    get cols() { return map.cols; },
    get rows() { return map.rows; },
    get tile() { return map.tile; },
    get tiles() { return tiles; },
    /** Filled per step: props block, and only living ones. */
    solids: [],
  };

  /** @type {any[]} */
  let heroes = [];
  /** @type {any[]} */
  let actors = [];
  /** @type {any[]} */
  let items = [];
  /** @type {any[]} */
  let shots = [];
  /** @type {any[]} */
  let strikes = [];
  /** @type {Record<string, any>} pattern runtimes by owner id — plain data. */
  let runtimes = {};
  /** @type {any[]} */
  let doors = [];
  /** @type {any[]} */
  let rooms = [];
  /** @type {Record<string, boolean>} */
  let switches = {};
  let random = createRandomState(spec.rules.seed);

  const state = {
    tick: 0,
    mapIndex: spec.maps.indexOf(map),
    outcome: "",
    score: 0,
    /** Which room the leading hero stands in; drives the camera and gates. */
    roomId: "",
    wave: { index: 0, ticksLeft: spec.rules.waves.everyTicks, spawned: 0 },
    camera: { x: 0, y: 0 },
    heroes,
    actors,
    items,
    get shots() { return shots; },
    get strikes() { return strikes; },
    get doors() { return doors; },
    get rooms() { return rooms; },
    get switches() { return switches; },
    get random() { return random; },
  };

  /** @type {any[]} */
  let queued = [];

  // -- building ---------------------------------------------------------

  function buildHero(seat) {
    const hero = spec.hero;
    return {
      id: makeId(),
      seat,
      x: Math.round(map.spawn.x),
      y: Math.round(map.spawn.y),
      rx: 0,
      ry: 0,
      w: hero.w,
      h: hero.h,
      alive: true,
      health: hero.hearts,
      maxHealth: hero.maxHearts,
      lives: hero.lives,
      invuln: 0,
      /** Where the body faces; aim follows it unless a stick says otherwise. */
      facing: 0,
      aim: 0,
      knockX: 0,
      knockY: 0,
      knockTicks: 0,
      hazardTicks: 0,
      swingCooldown: 0,
      castCooldown: 0,
      keys: 0,
      coins: 0,
      score: 0,
      /** In-run upgrades: the horde's whole progression, and stacking. */
      upgrades: { damage: 0, rate: 0, speed: 0 },
      /** Last tick's buttons, for the rising edges. */
      heldAttack: false,
      heldCast: false,
      heldUse: false,
    };
  }

  function buildActor(placement, definition) {
    return {
      id: makeId(),
      defId: definition.id,
      kind: definition.kind,
      x: Math.round(placement.x),
      y: Math.round(placement.y),
      rx: 0,
      ry: 0,
      w: definition.w,
      h: definition.h,
      alive: true,
      health: definition.health,
      speed: definition.speed,
      touchDamage: definition.touchDamage,
      behavior: definition.behavior,
      params: { ...definition.behaviorParams },
      patternId: definition.patternId,
      drop: definition.drop,
      dropChance: definition.dropChance,
      points: definition.points,
      solid: definition.solid,
      vx: 0,
      vy: 0,
      heading: 0,
      timer: 0,
      phase: "",
      blocked: false,
      invuln: 0,
      knockX: 0,
      knockY: 0,
      knockTicks: 0,
      wantsToShoot: false,
      shootCooldown: 0,
    };
  }

  function placeItem(pickup, x, y) {
    items.push({
      id: makeId(),
      pickup,
      x: Math.round(x),
      y: Math.round(y),
      w: 8,
      h: 8,
      taken: false,
    });
  }

  function loadMap(index) {
    map = spec.maps[Math.max(0, Math.min(spec.maps.length - 1, index))];
    tiles = [...map.tiles];
    state.mapIndex = spec.maps.indexOf(map);
    actors.length = 0;
    items.length = 0;
    shots = [];
    strikes = [];
    runtimes = {};
    switches = {};
    doors = map.doors.map((door) => ({ ...door }));
    rooms = map.rooms.map((room) => ({
      id: room.id,
      col: room.col,
      row: room.row,
      cols: room.cols,
      rows: room.rows,
      gate: room.gate,
      cleared: false,
      sealed: false,
    }));
    for (const placement of map.actors) {
      const definition = actorDefs.get(placement.defId);
      if (definition) actors.push(buildActor(placement, definition));
    }
    for (const placement of map.items) {
      if (placement.pickup) placeItem(placement.pickup, placement.x, placement.y);
    }
    for (const hero of heroes) {
      hero.x = Math.round(map.spawn.x);
      hero.y = Math.round(map.spawn.y);
      hero.rx = 0;
      hero.ry = 0;
    }
    state.roomId = roomAt(map.spawn.x, map.spawn.y)?.id ?? "";
    queued.push({ type: "map", index: state.mapIndex, name: map.name });
  }

  for (let seat = 0; seat < seats; seat += 1) heroes.push(buildHero(seat));
  loadMap(state.mapIndex);

  // -- rooms ------------------------------------------------------------

  /** The room containing a world point, or null. Rooms may not overlap;
   *  the first match wins, which makes authoring order the tiebreak. */
  function roomAt(px, py) {
    const col = Math.floor(px / map.tile);
    const row = Math.floor(py / map.tile);
    for (const room of rooms) {
      if (col >= room.col && col < room.col + room.cols && row >= room.row && row < room.row + room.rows) {
        return room;
      }
    }
    return null;
  }

  function enemiesLeftIn(room) {
    let count = 0;
    for (const actor of actors) {
      if (!actor.alive || actor.kind !== "enemy") continue;
      if (!room) { count += 1; continue; }
      const inside = roomAt(bodyCenterX(actor), bodyCenterY(actor));
      if (inside && inside.id === room.id) count += 1;
    }
    return count;
  }

  // -- shooting ---------------------------------------------------------

  /**
   * Fire a pattern, or — when the shooter has no pattern document — a
   * single bolt along its angle. The plain bolt exists so an enemy or a
   * starting weapon needs no authoring to be dangerous; the projectile it
   * makes has the same shape a pattern's does, so everything downstream
   * (drawing, collision, snapshotting) sees one kind of thing.
   */
  function fire(owner, angle, { hostile, damage, speed = 220, dt = 1 / 60 }) {
    const pattern = patterns.get(owner.patternId ?? "");
    const originX = bodyCenterX(owner) + cos(angle) * MUZZLE;
    const originY = bodyCenterY(owner) + sin(angle) * MUZZLE;
    if (!pattern) {
      shots.push({
        x: originX,
        y: originY,
        vx: cos(angle) * speed,
        vy: sin(angle) * speed,
        acceleration: 0,
        radius: 3,
        power: damage,
        color: hostile ? "#ff7a61" : "#65d6c3",
        sprite: "bolt",
        age: 0,
        lifetime: 2.5,
        angularVelocity: 0,
        hostile,
        seat: owner.seat ?? -1,
      });
      queued.push({ type: "shot", hostile, x: originX, y: originY });
      return;
    }
    const runtime = runtimes[owner.id] ?? (runtimes[owner.id] = createBulletPatternRuntime(pattern));
    const made = advanceBulletPattern(runtime, pattern, dt, {
      origin: { x: originX, y: originY },
      currentProjectiles: shots.length,
      // The pattern faces where the shooter aims. Its `rotation` is in
      // DEGREES while everything in this module is radians — the typecheck
      // caught that, which is the argument for the declarations existing.
      rotation: (angle * 180) / PI,
    });
    for (const projectile of made) {
      shots.push({ ...projectile, hostile, seat: owner.seat ?? -1, power: projectile.power || damage });
    }
    if (made.length > 0) queued.push({ type: "shot", hostile, x: originX, y: originY });
  }

  // -- the step ---------------------------------------------------------

  /**
   * @param {number} dt Fixed step, seconds. The same every call and on
   *        every machine — it is part of the simulation.
   * @param {Array<import("./contract.js").TopdownInput | undefined>} [inputs]
   */
  function step(dt, inputs = []) {
    if (!(dt > 0)) return;
    const playing = state.outcome === "";

    // Props are the only bodies that block others.
    field.solids = actors.filter((actor) => actor.solid && actor.alive);

    // -- 1 & 2: heroes ---------------------------------------------------
    for (let seat = 0; seat < seats; seat += 1) {
      const hero = heroes[seat];
      const input = inputs[seat];
      const move = snapStick(input?.move ?? { x: 0, y: 0 }, "free");
      const attack = input?.attack === true;
      const cast = input?.cast === true;
      const use = input?.use === true;
      const risingAttack = attack && !hero.heldAttack;
      const risingCast = cast && !hero.heldCast;
      const risingUse = use && !hero.heldUse;
      hero.heldAttack = attack;
      hero.heldCast = cast;
      hero.heldUse = use;

      if (hero.invuln > 0) hero.invuln -= 1;
      if (hero.swingCooldown > 0) hero.swingCooldown -= 1;
      if (hero.castCooldown > 0) hero.castCooldown -= 1;
      if (!playing || !hero.alive) continue;

      // Facing follows the body; aim overrides it when a stick is pushed,
      // which is the whole twin-stick case and costs one branch.
      if (move.x !== 0 || move.y !== 0) hero.facing = atan2(move.y, move.x);
      hero.aim = angleOf(input?.aim ?? { x: 0, y: 0 }, hero.facing);

      const onWater = tileCodeAtPoint(field, bodyCenterX(hero), bodyCenterY(hero)) === TOPDOWN_WATER;
      const speed = (onWater ? feel.waterSpeed : feel.speed) + hero.upgrades.speed * 12;
      if (hero.knockTicks > 0) {
        // Shoved: the push owns the body, and a shove into a wall simply
        // stops — it goes through the same movement core as a walk.
        stepBodyX(field, hero, hero.knockX * dt);
        stepBodyY(field, hero, hero.knockY * dt);
        hero.knockTicks -= 1;
      } else {
        stepBody(field, hero, move.x * speed * dt, move.y * speed * dt);
      }

      if (risingAttack && spec.hero.melee && hero.swingCooldown <= 0) {
        strikes.push(createStrike(hero, hero.aim, feel, feel.swingDamage + hero.upgrades.damage));
        hero.swingCooldown = Math.max(1, feel.swingCooldown - hero.upgrades.rate * 2);
        queued.push({ type: "swing", seat, angle: hero.aim });
      }
      // A pattern weapon is a CONTINUOUS emitter — its own fire rate is
      // its cooldown — so it advances every tick the button is held rather
      // than once per press. Pulsing it on the rising edge was the first
      // draft, and it fired nothing at all: one tick of a six-shots-a-
      // second wand accumulates a tenth of a bullet. The plain fallback
      // bolt has no rate of its own, so that one keeps the edge and the
      // cooldown.
      const armed = { ...hero, patternId: spec.hero.patternId, seat };
      if (patterns.has(spec.hero.patternId)) {
        if (cast) fire(armed, hero.aim, { hostile: false, damage: 1 + hero.upgrades.damage, dt });
      } else if (risingCast && hero.castCooldown <= 0) {
        fire(armed, hero.aim, { hostile: false, damage: 1 + hero.upgrades.damage });
        hero.castCooldown = Math.max(4, 24 - hero.upgrades.rate * 3);
      }
      if (risingUse) tryDoors(hero);
    }

    // -- 3: shots --------------------------------------------------------
    if (playing) {
      shots = advancePatternProjectiles(shots, dt, {
        width: map.cols * map.tile,
        height: map.rows * map.tile,
        margin: 24,
      });
      // A wall eats a shot; a pit does not, which is `tileStopsShot`.
      shots = shots.filter((shot) => {
        const code = tileCodeAt(field, Math.floor(shot.x / map.tile), Math.floor(shot.y / map.tile));
        if (code === 1) {
          queued.push({ type: "shotHit", x: shot.x, y: shot.y });
          return false;
        }
        return true;
      });
    }

    // -- 4: enemies ------------------------------------------------------
    if (playing) {
      const context = { field, run: state, feel, random, tick: state.tick, target: null };
      for (const actor of actors) {
        if (!actor.alive || actor.kind !== "enemy") continue;
        if (actor.invuln > 0) actor.invuln -= 1;
        if (actor.shootCooldown > 0) actor.shootCooldown -= 1;
        context.target = nearestHero(actor);
        runTopdownBehavior(actor, context, dt);
        if (actor.knockTicks > 0) {
          stepBodyX(field, actor, actor.knockX * dt);
          stepBodyY(field, actor, actor.knockY * dt);
          actor.knockTicks -= 1;
        } else {
          const moved = stepBody(field, actor, actor.vx * dt, actor.vy * dt);
          actor.blocked = moved.hitX || moved.hitY;
        }
        if (actor.wantsToShoot && actor.shootCooldown <= 0) {
          fire(actor, actor.heading, { hostile: true, damage: Math.max(1, actor.touchDamage) });
          actor.shootCooldown = 45;
        }
      }
    }

    // -- 5: combat -------------------------------------------------------
    if (playing) {
      resolveStrikes();
      resolveShots();
      resolveTouch(dt);
    }

    // -- 6: pickups ------------------------------------------------------
    if (playing) {
      for (const hero of heroes) {
        if (!hero.alive) continue;
        for (const item of items) {
          if (item.taken) continue;
          if (!boxesOverlap(hero.x, hero.y, hero.w, hero.h, item.x, item.y, item.w, item.h)) continue;
          item.taken = true;
          takePickup(hero, item.pickup);
        }
      }
      items = items.filter((item) => !item.taken);
      state.items = items;
    }

    // -- 7: rooms and gates ----------------------------------------------
    if (playing) {
      const leader = heroes.find((hero) => hero.alive) ?? heroes[0];
      const room = leader ? roomAt(bodyCenterX(leader), bodyCenterY(leader)) : null;
      if (room && room.id !== state.roomId) {
        state.roomId = room.id;
        queued.push({ type: "room", id: room.id });
      }
      for (const current of rooms) {
        if (current.gate !== "clear" || current.cleared) continue;
        const inside = enemiesLeftIn(current);
        const occupied = heroes.some((hero) => hero.alive && roomAt(bodyCenterX(hero), bodyCenterY(hero))?.id === current.id);
        if (!current.sealed && occupied && inside > 0) {
          current.sealed = true;
          queued.push({ type: "sealed", id: current.id });
        } else if (current.sealed && inside === 0) {
          current.sealed = false;
          current.cleared = true;
          for (const door of doors) if (door.to === current.id || door.lock === "boss") door.open = true;
          queued.push({ type: "cleared", id: current.id });
        }
      }
    }

    // -- 8: waves --------------------------------------------------------
    if (playing && spec.rules.victory === "waves") stepWaves();

    // -- 9: camera -------------------------------------------------------
    updateCamera();

    // -- 10: outcome -----------------------------------------------------
    if (playing) checkOutcome();

    state.tick += 1;
  }

  function nearestHero(actor) {
    let best = null;
    let bestDistance = Infinity;
    for (const hero of heroes) {
      if (!hero.alive) continue;
      const dx = bodyCenterX(hero) - bodyCenterX(actor);
      const dy = bodyCenterY(hero) - bodyCenterY(actor);
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = hero;
      }
    }
    return best;
  }

  function killActor(actor, seat) {
    actor.alive = false;
    const hero = heroes[seat];
    if (hero) {
      hero.score += actor.points;
      state.score += actor.points;
    }
    if (actor.drop && randomNext(random) < actor.dropChance) {
      placeItem(actor.drop, bodyCenterX(actor) - 4, bodyCenterY(actor) - 4);
    }
    queued.push({ type: "died", who: "enemy", defId: actor.defId, x: bodyCenterX(actor), y: bodyCenterY(actor) });
  }

  function resolveStrikes() {
    for (const strike of strikes) {
      const owner = heroes.find((hero) => hero.id === strike.ownerId);
      if (!owner) continue;
      for (const actor of actors) {
        if (!actor.alive || actor.kind !== "enemy" || strike.hit.includes(actor.id)) continue;
        if (!strikeCovers(field, strike, owner, actor)) continue;
        strike.hit.push(actor.id);
        const result = woundBody(actor, strike.damage, {
          fromX: bodyCenterX(owner),
          fromY: bodyCenterY(owner),
          knockback: strike.knockback,
          knockTicks: feel.knockbackTicks,
          invulnTicks: 0,
        });
        if (result.hit) queued.push({ type: "hit", target: "enemy", x: bodyCenterX(actor), y: bodyCenterY(actor) });
        if (result.died) killActor(actor, strike.seat);
      }
      strike.ticksLeft -= 1;
    }
    strikes = strikes.filter((strike) => strike.ticksLeft > 0);
  }

  function resolveShots() {
    const survivors = [];
    for (const shot of shots) {
      let spent = false;
      if (shot.hostile) {
        for (const hero of heroes) {
          if (!hero.alive || spent) continue;
          if (!boxesOverlap(shot.x - shot.radius, shot.y - shot.radius, shot.radius * 2, shot.radius * 2, hero.x, hero.y, hero.w, hero.h)) continue;
          const result = woundBody(hero, shot.power, {
            fromX: shot.x,
            fromY: shot.y,
            knockback: feel.knockbackSpeed,
            knockTicks: feel.knockbackTicks,
            invulnTicks: feel.invulnTicks,
          });
          if (result.hit) {
            spent = true;
            queued.push({ type: "hit", target: "hero", seat: hero.seat, x: bodyCenterX(hero), y: bodyCenterY(hero) });
            if (result.died) loseLife(hero);
          }
        }
      } else {
        for (const actor of actors) {
          if (!actor.alive || actor.kind !== "enemy" || spent) continue;
          if (!boxesOverlap(shot.x - shot.radius, shot.y - shot.radius, shot.radius * 2, shot.radius * 2, actor.x, actor.y, actor.w, actor.h)) continue;
          const result = woundBody(actor, shot.power, {
            fromX: shot.x,
            fromY: shot.y,
            knockback: feel.swingKnockback / 2,
            knockTicks: feel.knockbackTicks,
            invulnTicks: 0,
          });
          if (result.hit) {
            spent = true;
            queued.push({ type: "hit", target: "enemy", x: bodyCenterX(actor), y: bodyCenterY(actor) });
            if (result.died) killActor(actor, shot.seat);
          }
        }
      }
      if (!spent) survivors.push(shot);
    }
    shots = survivors;
  }

  function resolveTouch(dt) {
    for (const hero of heroes) {
      if (!hero.alive) continue;
      // Hazard tiles: a slow drip rather than a wall of damage, and on its
      // own timer so standing in lava is survivable for exactly as long as
      // the numbers say.
      const code = tileCodeAtPoint(field, bodyCenterX(hero), bodyCenterY(hero));
      if (code === TOPDOWN_HAZARD) {
        hero.hazardTicks += 1;
        if (hero.hazardTicks >= feel.hazardTicks) {
          hero.hazardTicks = 0;
          const result = woundBody(hero, feel.hazardDamage, { invulnTicks: feel.invulnTicks });
          if (result.hit) {
            queued.push({ type: "hit", target: "hero", seat: hero.seat, cause: "hazard", x: bodyCenterX(hero), y: bodyCenterY(hero) });
            if (result.died) loseLife(hero);
          }
        }
      } else {
        hero.hazardTicks = 0;
      }

      for (const actor of actors) {
        if (!actor.alive || actor.touchDamage <= 0) continue;
        if (!boxesOverlap(hero.x, hero.y, hero.w, hero.h, actor.x, actor.y, actor.w, actor.h)) continue;
        const result = woundBody(hero, actor.touchDamage, {
          fromX: bodyCenterX(actor),
          fromY: bodyCenterY(actor),
          knockback: feel.knockbackSpeed,
          knockTicks: feel.knockbackTicks,
          invulnTicks: feel.invulnTicks,
        });
        if (result.hit) {
          queued.push({ type: "hit", target: "hero", seat: hero.seat, x: bodyCenterX(hero), y: bodyCenterY(hero) });
          if (result.died) loseLife(hero);
        }
      }
    }
  }

  function loseLife(hero) {
    hero.lives -= 1;
    queued.push({ type: "died", who: "hero", seat: hero.seat, lives: hero.lives });
    if (hero.lives > 0) {
      hero.alive = true;
      hero.health = hero.maxHealth;
      hero.invuln = feel.invulnTicks;
      hero.knockTicks = 0;
      hero.x = Math.round(map.spawn.x);
      hero.y = Math.round(map.spawn.y);
      hero.rx = 0;
      hero.ry = 0;
    }
  }

  function takePickup(hero, pickup) {
    if (pickup === "heart") hero.health = Math.min(hero.maxHealth, hero.health + 1);
    else if (pickup === "maxHeart") { hero.maxHealth += 1; hero.health = hero.maxHealth; }
    else if (pickup === "key") hero.keys += 1;
    else if (pickup === "coin") { hero.coins += 1; hero.score += 5; state.score += 5; }
    else if (pickup === "damage") hero.upgrades.damage += 1;
    else if (pickup === "rate") hero.upgrades.rate += 1;
    else if (pickup === "speed") hero.upgrades.speed += 1;
    queued.push({ type: "pickedUp", seat: hero.seat, pickup });
  }

  /**
   * The `use` button at a door. A key is spent, a boss door wants its room
   * cleared, a switch door wants its switch — and a door with no lock is
   * simply open, so most doors need no button at all.
   */
  function tryDoors(hero) {
    const col = Math.floor(bodyCenterX(hero) / map.tile);
    const row = Math.floor(bodyCenterY(hero) / map.tile);
    for (const door of doors) {
      if (door.open) continue;
      if (Math.abs(door.col - col) > 1 || Math.abs(door.row - row) > 1) continue;
      if (door.lock === "key") {
        if (hero.keys <= 0) {
          queued.push({ type: "locked", id: door.id, needs: "key" });
          continue;
        }
        hero.keys -= 1;
      } else if (door.lock === "switch") {
        if (!switches[door.switchId]) {
          queued.push({ type: "locked", id: door.id, needs: "switch" });
          continue;
        }
      } else if (door.lock === "boss") {
        queued.push({ type: "locked", id: door.id, needs: "boss" });
        continue;
      }
      door.open = true;
      queued.push({ type: "opened", id: door.id });
    }
  }

  function stepWaves() {
    const rules = spec.rules.waves;
    const alive = actors.filter((actor) => actor.alive && actor.kind === "enemy").length;
    state.wave.ticksLeft -= 1;
    if (state.wave.ticksLeft > 0) return;
    state.wave.ticksLeft = rules.everyTicks;
    state.wave.index += 1;
    const want = Math.round(rules.count + rules.growth * (state.wave.index - 1));
    const room = rooms[0];
    let spawned = 0;
    for (let index = 0; index < want; index += 1) {
      if (alive + spawned >= rules.alive) break;
      const defId = randomWeighted(random, rules.table.map((row) => ({ weight: row.weight, value: row.defId })));
      const definition = defId ? actorDefs.get(defId) : null;
      if (!definition) continue;
      const spot = findSpawnSpot(definition, room);
      if (!spot) continue;
      actors.push(buildActor({ x: spot.x, y: spot.y }, definition));
      spawned += 1;
    }
    state.wave.spawned += spawned;
    queued.push({ type: "wave", index: state.wave.index, spawned });
  }

  /**
   * Somewhere in the room a body fits and no hero is standing. Bounded
   * tries rather than a search, because a crowded arena should spawn
   * fewer things rather than spend the frame looking.
   */
  function findSpawnSpot(definition, room) {
    const probe = { x: 0, y: 0, w: definition.w, h: definition.h, rx: 0, ry: 0 };
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const col = room.col + Math.floor(randomNext(random) * room.cols);
      const row = room.row + Math.floor(randomNext(random) * room.rows);
      probe.x = col * map.tile + 2;
      probe.y = row * map.tile + 2;
      if (tileCodeAt(field, col, row) !== 0) continue;
      let clear = true;
      for (const hero of heroes) {
        if (!hero.alive) continue;
        const dx = bodyCenterX(hero) - (probe.x + probe.w / 2);
        const dy = bodyCenterY(hero) - (probe.y + probe.h / 2);
        if (dx * dx + dy * dy < 64 * 64) { clear = false; break; }
      }
      if (clear) return { x: probe.x, y: probe.y };
    }
    return null;
  }

  /**
   * Both world models, from one room list. `roomFlip` snaps to the room
   * the leader stands in — which is the Zelda screen — and `followXY`
   * runs a dead zone across the whole map, which is the open field.
   */
  function updateCamera() {
    const viewW = map.camera.viewCols * map.tile;
    const viewH = map.camera.viewRows * map.tile;
    const maxX = Math.max(0, map.cols * map.tile - viewW);
    const maxY = Math.max(0, map.rows * map.tile - viewH);
    const clamp = (value, high) => (value < 0 ? 0 : value > high ? high : value);
    const leader = heroes.find((hero) => hero.alive) ?? heroes[0];
    if (!leader || map.camera.mode === "fixed") {
      state.camera.x = 0;
      state.camera.y = 0;
      return;
    }
    if (map.camera.mode === "roomFlip") {
      const room = roomAt(bodyCenterX(leader), bodyCenterY(leader));
      if (room) {
        state.camera.x = clamp(room.col * map.tile, maxX);
        state.camera.y = clamp(room.row * map.tile, maxY);
      }
      return;
    }
    const targetX = bodyCenterX(leader);
    const targetY = bodyCenterY(leader);
    const left = state.camera.x + (viewW - map.camera.deadZoneW) / 2;
    const right = state.camera.x + (viewW + map.camera.deadZoneW) / 2;
    if (targetX < left) state.camera.x = targetX - (viewW - map.camera.deadZoneW) / 2;
    else if (targetX > right) state.camera.x = targetX - (viewW + map.camera.deadZoneW) / 2;
    const top = state.camera.y + (viewH - map.camera.deadZoneH) / 2;
    const bottom = state.camera.y + (viewH + map.camera.deadZoneH) / 2;
    if (targetY < top) state.camera.y = targetY - (viewH - map.camera.deadZoneH) / 2;
    else if (targetY > bottom) state.camera.y = targetY - (viewH + map.camera.deadZoneH) / 2;
    state.camera.x = clamp(state.camera.x, maxX);
    state.camera.y = clamp(state.camera.y, maxY);
  }

  function checkOutcome() {
    const anyAlive = heroes.some((hero) => hero.alive && hero.lives > 0);
    if (!anyAlive) {
      state.outcome = "lost";
      queued.push({ type: "lost", score: state.score });
      return;
    }
    if (spec.rules.victory === "clearAll") {
      const enemies = actors.filter((actor) => actor.alive && actor.kind === "enemy").length;
      const started = map.actors.some((placement) => actorDefs.get(placement.defId)?.kind === "enemy");
      if (started && enemies === 0) advanceOrWin();
    } else if (spec.rules.victory === "reachExit") {
      const exit = doors.find((door) => door.to === "" && door.open);
      if (exit) advanceOrWin();
    } else if (spec.rules.victory === "waves") {
      const target = spec.rules.waves.waves;
      if (target > 0 && state.wave.index >= target) {
        state.outcome = "won";
        queued.push({ type: "won", score: state.score });
      }
    }
  }

  /** A finished map hands over to the next, or wins the world. */
  function advanceOrWin() {
    if (state.mapIndex + 1 < spec.maps.length) {
      loadMap(state.mapIndex + 1);
      return;
    }
    state.outcome = "won";
    queued.push({ type: "won", score: state.score });
  }

  return {
    /** Live and mutable — read it, do not write it. */
    get state() { return state; },
    /** The world as the run plays it: normalized. */
    get world() { return spec; },
    /** The map currently loaded, as authored. The live grid is `tiles()`. */
    get map() { return map; },
    /** The collision view, for a game that wants to query it. */
    get field() { return field; },

    step,

    /** The live tile grid — the renderer's source. */
    tiles() { return tiles; },
    tileAt(col, row) { return tileCodeAt(field, col, row); },
    /** Which room a world point is in, or null. */
    roomAt,

    /**
     * Everything noteworthy since the last drain, oldest first: `map`,
     * `swing`, `shot`, `shotHit`, `hit`, `died`, `pickedUp`, `locked`,
     * `opened`, `sealed`, `cleared`, `room`, `wave`, `won`, `lost`.
     * Drive sounds and effects from these — never from inside the step.
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
        mapIndex: state.mapIndex,
        outcome: state.outcome,
        score: state.score,
        roomId: state.roomId,
        wave: { ...state.wave },
        camera: { ...state.camera },
        nextId,
        random: { ...random },
        tiles: [...tiles],
        heroes: heroes.map((hero) => ({ ...hero, upgrades: { ...hero.upgrades } })),
        actors: actors.map((actor) => ({ ...actor, params: { ...actor.params } })),
        items: items.map((item) => ({ ...item })),
        shots: shots.map((shot) => ({ ...shot })),
        strikes: strikes.map((strike) => ({ ...strike, hit: [...strike.hit] })),
        doors: doors.map((door) => ({ ...door })),
        rooms: rooms.map((room) => ({ ...room })),
        switches: { ...switches },
        runtimes: JSON.parse(JSON.stringify(runtimes)),
      };
    },

    restore(snap) {
      state.tick = snap.tick;
      if (snap.mapIndex !== state.mapIndex) {
        map = spec.maps[Math.max(0, Math.min(spec.maps.length - 1, snap.mapIndex))];
        state.mapIndex = snap.mapIndex;
      }
      state.outcome = snap.outcome;
      state.score = snap.score;
      state.roomId = snap.roomId;
      state.wave = { ...snap.wave };
      state.camera = { ...snap.camera };
      nextId = snap.nextId;
      random = { ...snap.random };
      tiles = [...snap.tiles];
      heroes.length = 0;
      for (const hero of snap.heroes) heroes.push({ ...hero, upgrades: { ...hero.upgrades } });
      actors.length = 0;
      for (const actor of snap.actors) actors.push({ ...actor, params: { ...actor.params } });
      items = snap.items.map((item) => ({ ...item }));
      state.items = items;
      state.heroes = heroes;
      state.actors = actors;
      shots = snap.shots.map((shot) => ({ ...shot }));
      strikes = snap.strikes.map((strike) => ({ ...strike, hit: [...strike.hit] }));
      doors = snap.doors.map((door) => ({ ...door }));
      rooms = snap.rooms.map((room) => ({ ...room }));
      switches = { ...snap.switches };
      runtimes = JSON.parse(JSON.stringify(snap.runtimes));
      queued = [];
    },
  };
}
