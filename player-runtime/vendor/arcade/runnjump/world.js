import { runNJumpMotionPosition, runNJumpFacing, runNJumpMuzzle, runNJumpActorAim, runNJumpCanFire } from "./motion.js";
import { createRunNJumpEquipment, collectRunNJumpWeapon, resetRunNJumpDefense, rechargeRunNJumpDefense, absorbRunNJumpDamage } from "./equipment.js";
// The stage: one level of one game, running.
//
// Data in, state out, the same contract as `shmup`'s world — created from a
// normalized game, stepped with a delta and an ARRAY of per-player inputs,
// owning everything a run consists of. It never calls back, never touches a
// canvas, never reads a clock. Explosions, sounds and shakes are *requests*
// on a queue the renderer drains (`drainEvents`), which is also what
// rollback requires: a corrected frame re-runs `step`, and anything that
// played a sound inside it would play it again.
//
// Unlike `shmup`, this one has `snapshot` and `restore`, designed in from
// the first slice because they cannot be added cheaply later. A snapshot is
// plain copyable data — every actor is a bag of primitives referencing
// other actors by id, never by object — and the copy is spreads and array
// maps, not `structuredClone`, so the moment somebody adds state that
// cannot be copied that way, it fails loudly in review rather than quietly
// at rollback.
//
// Determinism rules, all load-bearing: update order is array order, ids are
// a counter, `Math.random` and the clock never appear, and the only
// transcendentals are `core/trig`'s. The guard test bans the rest.

import { unpackGrid } from "./tiles.js";
import { neutralInput } from "./contract.js";
import {
  collidesAt,
  hazardDamageIn,
  moveActorX,
  moveActorY,
  moveSolidBy,
  rectsOverlap,
  restingOnGround,
} from "./move.js";
import { atan2, cos, sin } from "../core/trig.js";
import { advanceBulletPattern, advancePatternProjectiles, createBulletPatternRuntime } from "../patterns/patterns.js";
import { createPlayerState, hurtPlayer, killPlayer, satellitePosition, stepPlayer } from "./player.js";
import { stepBehaviors } from "./behaviors.js";
import { triggerReaction } from "./reactions.js";
import { updateCamera } from "./camera.js";

const ACTOR_CAP = 512;

/**
 * @param {object} game A game, already normalized. See `normalizeGame`.
 * @param {object} [options]
 * @param {number} [options.levelIndex]
 * @param {number} [options.players] 1..4.
 * @param {number} [options.lives] Seeded by a campaign; defaults to the rules.
 * @param {number} [options.score] Carried in by a campaign.
 * @param {{x: number, y: number} | null} [options.checkpoint] Respawn point
 *        carried across a retry of the same level.
 */
export function createStage(game, options = {}) {
  const levelIndex = Math.max(0, Math.min(options.levelIndex ?? 0, game.levels.length - 1));
  const level = game.levels[levelIndex];
  const tileset = game.tilesets.find((entry) => entry.id === level.tilesetId) ?? game.tilesets[0];
  const playerCount = Math.max(1, Math.min(options.players ?? 1, 4));

  const field = {
    tileSize: game.tileSize,
    cols: level.cols,
    rows: level.rows,
    tiles: unpackGrid(level.tiles.rle, level.cols * level.rows),
    tileset,
    walls: level.walls,
    /** Refreshed every step: the alive solid and platform actors. */
    solids: /** @type {any[]} */ ([]),
  };

  const state = {
    tick: 0,
    elapsed: 0,
    levelIndex,
    timeLeft: level.timeLimit > 0 ? level.timeLimit : null,
    score: options.score ?? 0,
    coins: 0,
    keys: 0,
    lives: options.lives ?? game.rules.lives,
    players: /** @type {any[]} */ ([]),
    actors: /** @type {any[]} */ ([]),
    nextId: 1,
    camera: { x: 0, y: 0 },
    checkpoint: options.checkpoint ?? null,
    switches: /** @type {Record<string, boolean>} */ ({}),
    /** Bullet-pattern projectiles, advanced by the pattern engine itself. */
    patternShots: /** @type {any[]} */ ([]),
    /** null while live, then {result: "cleared"|"failed", reason} */
    outcome: /** @type {null | {result: string, reason: string}} */ (null),
  };

  /** Presentation requests. Never part of the snapshot. */
  let events = /** @type {any[]} */ ([]);

  const defs = new Map(game.actors.map((def) => [def.id, def]));
  const patternDefs = new Map((game.patterns ?? []).map((pattern) => [pattern.id, pattern]));

  const world = {
    game,
    level,
    field,
    state,

    /** Capture source identity before death removal or a reaction's morph. @param {string} type @param {any} data */
    emit(type, data = {}) {
      const actor = data.actorId !== undefined ? state.actors.find((entry) => entry.id === data.actorId) : null;
      const player = typeof data.player === "number" ? state.players[data.player] : null;
      const body = actor ?? player;
      const source = body ? { kind: actor ? "actor" : type.startsWith("satellite-") ? "satellite" : "player",
        id: body.id, defId: actor?.defId ?? "", placedId: actor?.placedId ?? "",
        x: body.x, y: body.y, w: body.w, h: body.h } : undefined;
      events.push({ type, tick: state.tick, ...(source ? { source } : {}), ...data });
    },
    drainEvents() {
      const drained = events;
      events = [];
      return drained;
    },

    defOf(defId) {
      return defs.get(defId);
    },

    collides(actor) {
      return collidesAt(field, actor, actor.x, actor.y);
    },
    moveX(actor, amount, moveOptions) {
      // A solid or platform steered by a behaviour must carry and push like
      // any other solid movement -- an elevator that leaves its rider
      // hanging is the bug this branch exists to prevent.
      if (actor.solid || actor.platform) {
        moveSolidBy(field, actor, amount, 0, movableActors(state, actor));
        return { hitWall: false, wallDir: 0 };
      }
      const result = moveActorX(field, actor, amount, moveOptions);
      if (result.hitWall) actor.hitWall = true;
      return result;
    },
    moveY(actor, amount, moveOptions) {
      if (actor.solid || actor.platform) {
        moveSolidBy(field, actor, 0, amount, movableActors(state, actor));
        return { hitFloor: false, hitCeiling: false, ceilingCells: [] };
      }
      return moveActorY(field, actor, amount, moveOptions);
    },

    /**
     * @param {string} defId
     * @param {number} x
     * @param {number} y
     * @param {1|-1} [dir]
     * @returns {any | null} Null when the definition is unknown or the cap is hit.
     */
    spawnActor(defId, x, y, dir = -1) {
      const def = defs.get(defId);
      if (!def || state.actors.length >= ACTOR_CAP) return null;
      const actor = {
        id: state.nextId,
        placedId: "",
        defId,
        kind: def.kind,
        team: "enemy",
        x: Math.round(x), y: Math.round(y),
        rx: 0, ry: 0,
        w: def.hitbox.w, h: def.hitbox.h,
        vx: 0, vy: 0,
        dir, facing: dir,
        alive: true, removed: false, active: false, started: false,
        grounded: false, hitWall: false, crushed: false, hidden: false,
        dropThrough: 0, gravityOn: false,
        solid: def.solid, platform: def.platform, open: false,
        hp: def.hp, touchDamage: def.touchDamage, invuln: 0,
        age: 0, ttl: 0,
        homeX: Math.round(x), homeY: Math.round(y),
        waypoint: 0, bState: 0, bTimer: 0, bOverride: "",
        reactionTimer: 0, seesPlayer: false,
        bTargetX: 0, bTargetY: 0,
        carriedBy: 0, spawnedBy: 0, thrownTimer: 0,
        switchGroup: def.switchGroup,
        anim: "idle", animAge: 0,
      };
      if (def.motion) Object.assign(actor, { motionAge: 0, motionRotation: 0 });
      state.nextId += 1;
      if (actor.switchGroup && state.switches[actor.switchGroup]) actor.open = true;
      resetRunNJumpDefense(actor, game.defenses?.find((entry) => entry.id === def.defenseId));
      state.actors.push(actor);
      return actor;
    },

    /** `becomeKind`: the same actor, re-seated on another definition. */
    morphActor(actor, defId) {
      const def = defs.get(defId);
      if (!def) return;
      // Keep the bottom-centre anchor so a shell appears where the walker stood.
      const anchorX = actor.x + actor.w / 2;
      const anchorY = actor.y + actor.h;
      actor.defId = defId;
      actor.kind = def.kind;
      actor.w = def.hitbox.w;
      actor.h = def.hitbox.h;
      actor.x = Math.round(anchorX - def.hitbox.w / 2);
      actor.y = Math.round(anchorY - def.hitbox.h);
      actor.hp = def.hp;
      resetRunNJumpDefense(actor, game.defenses?.find((entry) => entry.id === def.defenseId));
      actor.touchDamage = def.touchDamage;
      actor.solid = def.solid;
      actor.platform = def.platform;
      actor.vx = 0;
      if (def.motion || actor.motionAge !== undefined) {
        actor.homeX = actor.x; actor.homeY = actor.y; actor.rx = 0; actor.ry = 0;
        actor.vy = 0; delete actor.motionAge; delete actor.motionRotation;
        if (def.motion) Object.assign(actor, {motionAge:0, motionRotation:actor.authoredRotation ?? 0});
      }
      actor.bState = 0;
      actor.bTimer = 0;
      actor.bOverride = "";
      actor.switchGroup = def.switchGroup;
      world.emit("morph", { actorId: actor.id, defId });
    },

    /** The hero's projectile, from the definition's weapon block. */
    spawnProjectile(player, authoredWeapon = null, origin = null, direction = null, satellite = false, slotId = "") {
      const weapon = authoredWeapon ?? game.player.weapon;
      const aim = direction ?? { x: player.aimX, y: player.aimY };
      if (!origin && weapon.mount) origin = runNJumpMuzzle({x:player.x+player.w/2,y:player.y+player.h/2}, aim, weapon.mount);
      const shot = {
        id: state.nextId,
        placedId: "",
        defId: "",
        kind: "projectile",
        team: "player",
        owner: player.index,
        // The muzzle, along the aim rather than along the body. With
        // `aimSource: "facing"` the aim IS the facing and these two lines
        // reduce to exactly what they computed before -- the leading edge of
        // the shot box, level with the middle of the player -- which is what
        // keeps every game written before aiming existed pixel-identical.
        x: Math.round((origin?.x ?? player.x + player.w / 2) + (weapon.mount ? 0 : aim.x * (player.w + weapon.size) / 2) - weapon.size / 2),
        y: Math.round((origin?.y ?? player.y + player.h / 2) + (weapon.mount ? 0 : aim.y * (player.h + weapon.size) / 2) - weapon.size / 2),
        rx: 0, ry: 0,
        w: weapon.size, h: weapon.size,
        vx: aim.x * weapon.projectileSpeed,
        // A lobbed weapon launches on an arc worth seeing; a straight one flies flat.
        vy: aim.y * weapon.projectileSpeed
          + (weapon.projectileGravity > 0 ? -Math.min(220, weapon.projectileSpeed * 0.55) : 0),
        dir: player.facing, facing: player.facing,
        alive: true, removed: false, active: true, started: true,
        grounded: false, hitWall: false, crushed: false, hidden: false,
        dropThrough: 0, gravityOn: weapon.projectileGravity > 0,
        weaponGravity: weapon.projectileGravity,
        solid: false, platform: false, open: false,
        hp: 1, touchDamage: 0, invuln: 0,
        ...(authoredWeapon ? { damage: weapon.damage } : {}),
        age: 0, ttl: weapon.ttl,
        homeX: 0, homeY: 0,
        waypoint: 0, bState: 0, bTimer: 0, bOverride: "",
        bTargetX: 0, bTargetY: 0,
        carriedBy: 0, spawnedBy: player.id, thrownTimer: 0,
        switchGroup: "",
        anim: "shot", animAge: 0,
      };
      if (state.actors.length >= ACTOR_CAP) return;
      state.nextId += 1;
      state.actors.push(shot);
      world.emit(satellite ? "satellite-fire" : "fire", { player: player.index, ...(authoredWeapon ? { weaponId: authoredWeapon.id, slotId } : {}) });
    },

    spawnEquipmentShot(player, weapon, at, aim, satellite, slotId) { world.spawnProjectile(player, weapon, at, aim, satellite, slotId); },

    /**
     * The satellite's shot, fired along its AIM rather than from the player
     * and rather than along the orbit -- the whole point of the two angles
     * being separate.
     */
    spawnSatelliteShot(player) {
      const settings = game.player.satellite;
      if (state.actors.length >= ACTOR_CAP) return;
      const at = satellitePosition(game.player, player);
      const radians = player.satAim * (Math.PI / 180);
      // Leave from the MUZZLE, not the body's centre. A satellite hovering
      // near the floor is a normal thing to have, and a bullet born at its
      // centre is born with its own box clipping the ground -- it then dies
      // on the first pixel of movement, so the gun fired and nothing came
      // out. Stepping out along the aim by the body's radius puts the shot
      // where it visibly comes from and clears the graze.
      const muzzle = Math.max(4, Math.round(settings.distance / 5)) + settings.size;
      const originX = at.x + cos(radians) * muzzle;
      const originY = at.y + sin(radians) * muzzle;
      const shot = {
        id: state.nextId,
        placedId: "",
        defId: "",
        kind: "projectile",
        team: "player",
        owner: player.index,
        x: Math.round(originX - settings.size / 2),
        y: Math.round(originY - settings.size / 2),
        rx: 0, ry: 0,
        w: settings.size, h: settings.size,
        vx: cos(radians) * settings.projectileSpeed,
        vy: sin(radians) * settings.projectileSpeed,
        dir: cos(radians) >= 0 ? 1 : -1,
        facing: cos(radians) >= 0 ? 1 : -1,
        alive: true, removed: false, active: true, started: true,
        grounded: false, hitWall: false, crushed: false, hidden: false,
        dropThrough: 0, gravityOn: settings.projectileGravity > 0,
        weaponGravity: settings.projectileGravity,
        solid: false, platform: false, open: false,
        hp: 1, touchDamage: 0, invuln: 0,
        age: 0, ttl: settings.ttl,
        homeX: 0, homeY: 0,
        waypoint: 0, bState: 0, bTimer: 0, bOverride: "",
        reactionTimer: 0, seesPlayer: false,
        bTargetX: 0, bTargetY: 0,
        carriedBy: 0, spawnedBy: player.id, thrownTimer: 0,
        switchGroup: "",
        damage: settings.damage,
        anim: "shot", animAge: 0,
      };
      state.nextId += 1;
      state.actors.push(shot);
      world.emit("satellite-fire", { player: player.index, x: at.x, y: at.y, aim: player.satAim });
    },

    toggleSwitches(tag) {
      state.switches[tag] = !state.switches[tag];
      for (const actor of state.actors) {
        if (actor.switchGroup === tag && actor.solid) actor.open = state.switches[tag] === true;
      }
      world.emit("switch", { tag, open: state.switches[tag] === true });
    },

    endStage(result, reason) {
      if (!state.outcome) state.outcome = { result, reason };
    },

    /** A head bump from below: break breakables, and tell item blocks. */
    breakCell(col, row, player) {
      if (col < 0 || col >= field.cols || row < 0 || row >= field.rows) return;
      const index = row * field.cols + col;
      const def = field.tileset.tiles[field.tiles[index]];
      if (def && def.shape === "breakable") {
        field.tiles[index] = 0;
        world.emit("tile-break", { col, row, x: col * game.tileSize, y: row * game.tileSize });
        state.score += 10;
      }
      void player;
    },

    /** Actors whose underside the player just headbutted. */
    bumpFromBelow(player) {
      const head = player.y - 1;
      for (const actor of state.actors) {
        if (!actor.alive || !(actor.solid || actor.platform)) continue;
        if (actor.y + actor.h === head + 1
          && player.x < actor.x + actor.w && actor.x < player.x + player.w) {
          triggerReaction(world, actor, "hitFromBelow", { player });
        }
      }
    },

    step(dt, inputs = []) {
      if (state.outcome) return;
      state.tick += 1;
      state.elapsed += dt;

      if (state.timeLeft !== null) {
        state.timeLeft = Math.max(0, state.timeLeft - dt);
        if (state.timeLeft === 0) {
          for (const player of state.players) killPlayer(world, player);
          world.endStage("failed", "time");
          return;
        }
      }

      field.solids = state.actors.filter((actor) => actor.alive && !actor.hidden && (actor.solid || actor.platform));

      // -- players --
      for (let index = 0; index < state.players.length; index += 1) {
        const player = state.players[index];
        stepPlayer(world, player, inputs[index] ?? neutralInput(), dt);
        if (!player.alive && player.respawnTimer === 0 && !player.removed) {
          if (state.lives > 0) {
            state.lives -= 1;
            respawnPlayer(world, player);
          } else {
            player.removed = true;
            world.emit("player-out", { player: player.index });
          }
        }
      }

      // -- actors --
      const viewW = level.camera.viewCols * field.tileSize;
      for (const actor of state.actors) {
        if (!actor.alive) continue;
        actor.age += dt;
        actor.invuln = Math.max(0, actor.invuln - dt);
        rechargeRunNJumpDefense(actor, game.defenses?.find((entry) => entry.id === defs.get(actor.defId)?.defenseId), dt);
        actor.dropThrough = Math.max(0, actor.dropThrough - dt);
        actor.thrownTimer = Math.max(0, actor.thrownTimer - dt);

        // Activation: an enemy off beyond the window has not started, and
        // one that drifts far outside it freezes. Projectiles and spawned
        // children die instead of freezing -- a frozen bullet is a trap.
        const def = defs.get(actor.defId);
        const range = def ? def.activation.range : 96;
        const withinStart = (def?.motion && def.motion.pattern !== "behavior") || actor.x + actor.w >= state.camera.x - range
          && actor.x <= state.camera.x + viewW + range;
        if (!actor.started) {
          if (!withinStart) continue;
          actor.started = true;
          actor.active = true;
        } else if (!withinStart) {
          const withinHold = actor.x + actor.w >= state.camera.x - range * 2 - viewW / 2
            && actor.x <= state.camera.x + viewW * 1.5 + range * 2;
          if (actor.kind === "projectile" || actor.spawnedBy !== 0) {
            if (!withinHold) {
              actor.alive = false;
              continue;
            }
          } else if (!withinHold) {
            if (actor.active) triggerReaction(world, actor, "leftScreen", {});
            actor.active = false;
            continue;
          }
        } else {
          actor.active = true;
        }
        if (!actor.active) continue;

        if (actor.carriedBy !== 0) {
          const carrier = state.players.find((player) => player.id === actor.carriedBy);
          if (carrier && carrier.alive) {
            actor.x = Math.round(carrier.x + carrier.w / 2 - actor.w / 2);
            actor.y = carrier.y - actor.h;
            actor.vx = 0;
            actor.vy = 0;
            continue;
          }
          actor.carriedBy = 0;
        }

        const wasGrounded = actor.grounded;
        // A thrown thing is a missile for a while, not itself: its own
        // behaviour (a crate's `still`) must not cancel the throw mid-arc.
        const pathDriven = def?.motion && def.motion.pattern !== "behavior" && actor.thrownTimer <= 0;
        if (def?.motion) {
          actor.motionAge = (actor.motionAge ?? 0) + dt;
          if (pathDriven) {
            const next = runNJumpMotionPosition(def.motion, actor.homeX, actor.homeY, actor.motionAge);
            const previous = runNJumpMotionPosition(def.motion, actor.homeX, actor.homeY, actor.motionAge-dt);
            actor.motionRotation = runNJumpFacing(def.motion, actor.motionAge, next.x-previous.x, next.y-previous.y, actor.facing, actor.authoredRotation ?? 0);
            // Pixel stepping uses the exact desired coordinate minus its residual.
            // Obstructed bodies remain clipped by tiles; solids still carry riders.
            if (actor.kind === "decoration") { actor.x=next.x; actor.y=next.y; }
            else if (actor.solid || actor.platform) {
              world.moveX(actor, next.x-actor.x-actor.rx, {glue:false}); world.moveY(actor, next.y-actor.y-actor.ry);
            } else {
              // Let authored entrants cross the virtual border from outside,
              // while still colliding with real tiles and solids inside it.
              const pathField = actor.x < 0 || actor.x+actor.w > field.cols*field.tileSize ? {...field,walls:"open"} : field;
              actor.hitWall = moveActorX(pathField, actor, next.x-actor.x-actor.rx, {glue:false}).hitWall;
              moveActorY(pathField, actor, next.y-actor.y-actor.ry);
            }
            actor.vx=0; actor.vy=0;
          }
        }
        if (def && actor.thrownTimer <= 0) {
          if (!pathDriven) stepBehaviors(world, actor, def, dt);
          else if (!actor.bOverride || ["turret","thrower","spawner","shot"].includes(actor.bOverride)) {
            stepBehaviors(world, actor, {...def, behaviors:def.behaviors.filter(b=>["turret","thrower","spawner","shot"].includes(b.type))}, dt);
          }
        }
        if (def?.motion && !pathDriven) actor.motionRotation = runNJumpFacing(def.motion, actor.motionAge, actor.vx, actor.vy, actor.facing, actor.authoredRotation ?? 0);
        if (!actor.alive) continue;

        // The reaction triggers that watch time and the player, for actors
        // whose definitions declared them. Guarded on the declaration so an
        // ordinary walker pays nothing for machinery it does not use.
        if (def && def.reactions.length > 0) {
          const timed = def.reactions.find((reaction) => reaction.when === "timer");
          if (timed) {
            actor.reactionTimer += dt;
            const every = typeof timed.every === "number" && timed.every > 0 ? timed.every : 2;
            if (actor.reactionTimer >= every) {
              actor.reactionTimer -= every;
              triggerReaction(world, actor, "timer", {});
              if (!actor.alive) continue;
            }
          }
          const sighted = def.reactions.find((reaction) => reaction.when === "spottedPlayer");
          if (sighted || def.reactions.some((reaction) => reaction.when === "lostSight")) {
            const range = sighted && typeof sighted.range === "number" ? sighted.range : 120;
            const player = nearestAlivePlayer(state, actor);
            const dx = player ? (player.x + player.w / 2) - (actor.x + actor.w / 2) : Infinity;
            const dy = player ? (player.y + player.h / 2) - (actor.y + actor.h / 2) : Infinity;
            const sees = player !== null && dx * dx + dy * dy <= range * range;
            if (sees && !actor.seesPlayer) triggerReaction(world, actor, "spottedPlayer", { player });
            else if (!sees && actor.seesPlayer) triggerReaction(world, actor, "lostSight", {});
            actor.seesPlayer = sees;
            if (!actor.alive) continue;
          }
        }

        if (actor.kind !== "decoration" && !pathDriven) {
          // A defless actor (the hero's projectile) falls only if its weapon
          // said so; a defined one follows its definition plus any behaviour
          // that switched gravity on (`drop`).
          const hasGravity = def ? (def.gravity || actor.gravityOn) : actor.gravityOn;
          if (hasGravity) {
            const pull = !def && actor.weaponGravity > 0 ? actor.weaponGravity : game.player.feel.gravity;
            actor.vy = Math.min(actor.vy + pull * dt, game.player.feel.maxFall);
          }
          actor.hitWall = false;
          const movedX = world.moveX(actor, actor.vx * dt);
          if (movedX.hitWall) {
            actor.vx = 0;
            triggerReaction(world, actor, "hitWall", {});
          }
          if (hasGravity || actor.vy !== 0) {
            const movedY = moveActorY(field, actor, actor.vy * dt);
            if (movedY.hitFloor) {
              actor.grounded = true;
              actor.vy = 0;
              if (!wasGrounded) triggerReaction(world, actor, "landed", {});
            } else if (movedY.hitCeiling) {
              actor.vy = 0;
            } else if (actor.vy > 0) {
              actor.grounded = restingOnGround(field, actor);
              if (actor.grounded) actor.vy = 0;
            } else if (actor.vy < 0) {
              actor.grounded = false;
            }
            if (actor.kind === "projectile" && (movedY.hitFloor || movedY.hitCeiling)) {
              actor.alive = false;
              world.emit("shot-break", { actorId: actor.id, x: actor.x, y: actor.y });
              continue;
            }
          }
          if (actor.kind === "projectile" && movedX.hitWall) {
            actor.alive = false;
            world.emit("shot-break", { actorId: actor.id, x: actor.x, y: actor.y });
            continue;
          }
        }

        if (actor.ttl > 0 && actor.age >= actor.ttl) {
          actor.alive = false;
          world.emit("shot-break", { actorId: actor.id, x: actor.x, y: actor.y });
          continue;
        }
        if (actor.crushed) {
          actor.crushed = false;
          triggerReaction(world, actor, "crushed", {});
          if (!actor.alive) continue;
        }
        if (actor.y > field.rows * field.tileSize + 96) {
          actor.alive = false;
          continue;
        }
      }

      // -- pattern weapons: designed fire, from @ccllc/arcade/patterns --
      for (const actor of state.actors) {
        if (!actor.alive || !actor.active || actor.hidden) continue;
        const def = defs.get(actor.defId);
        const pattern = def && def.weapon && def.weapon.patternId ? patternDefs.get(def.weapon.patternId) : null;
        if (!pattern || !runNJumpCanFire(world, actor, def)) continue;
        if (!actor.patternRuntime) actor.patternRuntime = createBulletPatternRuntime(pattern);
        const target = nearestAlivePlayer(state, actor);
        // The whole pattern rotates toward the target: pattern angles run
        // from +x, so a design's zero axis points at whoever it is aimed at.
        // `core/trig` atan2: this must agree across machines like the rest.
        const aim = def.weapon.direction === "facing" ? atan2(runNJumpActorAim(actor).y, runNJumpActorAim(actor).x)*180/Math.PI : target
          ? atan2(
            (target.y + target.h / 2) - (actor.y + actor.h / 2),
            (target.x + target.w / 2) - (actor.x + actor.w / 2),
) * (180 / Math.PI)
          : 0;
        const frame = runNJumpActorAim(actor);
        const muzzle = runNJumpMuzzle({x:actor.x+actor.w/2,y:actor.y+actor.h/2}, frame, def.weapon.mount);
        const fired = advanceBulletPattern(actor.patternRuntime, pattern, dt, {
          origin: muzzle,
          target: def.weapon.direction === "facing" ? {x:muzzle.x+frame.x*100,y:muzzle.y+frame.y*100} : target ? { x: target.x + target.w / 2, y: target.y + target.h / 2 } : undefined,
          rotation: aim,
          maxProjectiles: 120,
          currentProjectiles: state.patternShots.filter((shot) => shot.team !== "player").length,
        });
        for (const shot of fired) {
          state.patternShots.push({ ...shot, ownerId: actor.id });
        }
        if (fired.length > 0) world.emit("pattern-fire", { actorId: actor.id, count: fired.length });
      }
      if (state.patternShots.length > 0) {
        state.patternShots = advancePatternProjectiles(state.patternShots, dt, {
          width: field.cols * field.tileSize,
          height: field.rows * field.tileSize,
          margin: 64,
        });
        // The pattern engine knows nothing about tiles; in a platformer a
        // designed bullet still dies on a wall.
        state.patternShots = state.patternShots.filter((shot) => {
          const col = Math.floor(shot.x / field.tileSize);
          const row = Math.floor(shot.y / field.tileSize);
          const tile = field.tileset.tiles[field.tiles[row * field.cols + col]];
          if (row < 0 || row >= field.rows || col < 0 || col >= field.cols) return true;
          return !tile || (tile.shape !== "solid" && tile.shape !== "breakable" && tile.shape !== "conveyor" && tile.shape !== "bounce");
        });
      }

      // -- solid movement is behaviour-driven; here the solids push and carry --
      // (Behaviours steered via world.moveX/moveY already; solids that used
      // seekAxis moved themselves. Solids with velocity move here so riders
      // and pushes resolve through moveSolidBy.)
      for (const actor of state.actors) {
        if (!actor.alive || !actor.active || !(actor.solid || actor.platform)) continue;
        if (actor.vx === 0 && actor.vy === 0) continue;
        const movable = [...state.players, ...state.actors.filter((other) => other !== actor && !other.solid && !other.platform)];
        moveSolidBy(field, actor, actor.vx * dt, actor.vy * dt, movable);
      }

      // -- overlaps --
      for (const player of state.players) {
        if (!player.alive) continue;
        const box = { x: player.x, y: player.y, w: player.w, h: player.h };

        const hazard = hazardDamageIn(field, box);
        if (hazard > 0) hurtPlayer(world, player, hazard, player.x - 1);

        for (let index = state.patternShots.length - 1; index >= 0; index -= 1) {
          const shot = state.patternShots[index];
          if (shot.team === "player") continue;
          const r = shot.radius ?? 3;
          if (rectsOverlap(box.x, box.y, box.w, box.h, shot.x - r, shot.y - r, r * 2, r * 2)) {
            hurtPlayer(world, player, 1, shot.x);
            state.patternShots.splice(index, 1);
          }
        }
        if (player.crushed) {
          player.crushed = false;
          if (player.defenseId) killPlayer(world, player);
          else hurtPlayer(world, player, 99, player.x);
        }

        for (const actor of state.actors) {
          if (!actor.alive || !actor.active || actor.hidden || actor.carriedBy !== 0) continue;
          if (!rectsOverlap(box.x, box.y, box.w, box.h, actor.x, actor.y, actor.w, actor.h)) continue;

          if (actor.kind === "pickup") {
            collectPickup(world, player, actor);
            continue;
          }
          if (actor.kind === "projectile") {
            if (actor.team === "enemy") {
              hurtPlayer(world, player, 1, actor.x + actor.w / 2);
              actor.alive = false;
            }
            continue;
          }
          if (actor.kind === "enemy") {
            const def = defs.get(actor.defId);
            const stomp = game.player.abilities.stomp
              && def && def.stompable
              && player.vy > 0
              && (player.y + player.h) - actor.y <= Math.max(6, player.vy * dt + 2);
            if (stomp) {
              if (def.indestructible || def.defenseId && game.defenses?.some((entry) => entry.id === def.defenseId)) { damageActor(world, actor, 1, { player }); player.vy = -game.player.feel.stompBounce; }
              else triggerReaction(world, actor, "stomped", { player });
            } else if (player.invincible > 0 && actor.touchDamage > 0) {
              if (def?.indestructible) { damageActor(world, actor, 1, {player}); continue; }
              triggerReaction(world, actor, "died", { player });
              actor.alive = false;
              state.score += def ? def.score : 0;
              world.emit("death", { actorId: actor.id, defId: actor.defId, x: actor.x, y: actor.y });
            } else if (player.meleeTime > 0 && meleeReaches(world, player, actor)) {
              damageActor(world, actor, game.player.weapon.damage, { player });
            } else {
              if (actor.touchDamage > 0 && actor.thrownTimer <= 0) {
                hurtPlayer(world, player, actor.touchDamage, actor.x + actor.w / 2);
              }
              triggerReaction(world, actor, "touchedPlayer", { player });
              // The carry pickup: grab a carryable with action while able.
              if (game.player.abilities.carry && def && def.carryable
                && player.carrying === 0 && actor.touchDamage === 0
                && inputsOf(inputs, player).action) {
                actor.carriedBy = player.id;
                player.carrying = actor.id;
                world.emit("carry", { player: player.index, actorId: actor.id });
              }
            }
            continue;
          }
          // objects, solids, decorations: reactions only, plus warps.
          triggerReaction(world, actor, "touchedPlayer", { player });
          {
            const def = defs.get(actor.defId);
            if (def && def.warp && player.warpCooldown <= 0) {
              const wants = def.warp.entry === "touch"
                || (def.warp.entry === "down" && inputsOf(inputs, player).down)
                || (def.warp.entry === "action" && player.actionPressed);
              if (wants) warpPlayer(world, player, actor, def.warp.tag);
            }
          }
        }
      }

      // The satellite as a body: it eats designed bullets and, if the author
      // asked, hurts what it touches. Both read the same position the
      // renderer draws, so what looks like a shield is one.
      if (game.player.satellite.enabled) {
        const settings = game.player.satellite;
        const half = Math.max(4, Math.round(settings.distance / 4));
        for (const player of state.players) {
          if (!player.alive) continue;
          if (player.satBody && !player.satBody.alive) continue;
          const at = satellitePosition(game.player, player);
          const box = { x: at.x - half, y: at.y - half, w: half * 2, h: half * 2 };
          if (settings.blocks) {
            for (let index = state.patternShots.length - 1; index >= 0; index -= 1) {
              const bullet = state.patternShots[index];
              if (bullet.team === "player") continue;
              const radius = bullet.radius ?? 3;
              if (rectsOverlap(box.x, box.y, box.w, box.h, bullet.x - radius, bullet.y - radius, radius * 2, radius * 2)) {
                state.patternShots.splice(index, 1);
                world.emit("satellite-block", { player: player.index, x: bullet.x, y: bullet.y });
                damageRunNJumpSatellite(world, player, 1);
                if (player.satBody && !player.satBody.alive) break;
              }
            }
          }
          if (player.satBody?.alive && settings.blocks) {
            for (const projectile of state.actors) if (projectile.alive && projectile.kind === "projectile" && projectile.team === "enemy" && rectsOverlap(box.x, box.y, box.w, box.h, projectile.x, projectile.y, projectile.w, projectile.h)) {
              projectile.alive = false; damageRunNJumpSatellite(world, player, 1);
            }
          }
          if (player.satBody?.alive) {
            for (const enemy of state.actors) {
              if (enemy.alive && enemy.active && !enemy.hidden && enemy.kind === "enemy" && rectsOverlap(box.x, box.y, box.w, box.h, enemy.x, enemy.y, enemy.w, enemy.h)) damageRunNJumpSatellite(world, player, 1);
            }
          }
          if (settings.touchDamage > 0 && (!player.satBody || player.satBody.alive)) {
            for (const enemy of state.actors) {
              if (!enemy.alive || !enemy.active || enemy.hidden || enemy.kind !== "enemy") continue;
              if (enemy.invuln > 0 && !defs.get(enemy.defId)?.indestructible) continue;
              if (!rectsOverlap(box.x, box.y, box.w, box.h, enemy.x, enemy.y, enemy.w, enemy.h)) continue;
              damageActor(world, enemy, settings.touchDamage, { player });
            }
          }
        }
      }

      // Friendly authored patterns use the shared emitter but platformer contacts.
      for (let index = state.patternShots.length - 1; index >= 0; index--) {
        const shot = state.patternShots[index]; if (shot.team !== "player") continue;
        const radius = shot.radius ?? 3;
        for (const enemy of state.actors) {
          if (!enemy.alive || !enemy.active || enemy.hidden || enemy.kind !== "enemy") continue;
          if (!rectsOverlap(shot.x - radius, shot.y - radius, radius * 2, radius * 2, enemy.x, enemy.y, enemy.w, enemy.h)) continue;
          damageActor(world, enemy, shot.damage ?? 1, { player: state.players[shot.owner] });
          state.patternShots.splice(index, 1); break;
        }
      }

      // Solid actors are leaned on, never overlapped -- a blocked walk stops
      // at their face -- so their touch reactions run off a one-pixel
      // inflation of the player instead.
      for (const player of state.players) {
        if (!player.alive) continue;
        for (const actor of state.actors) {
          if (!actor.alive || !actor.active || actor.hidden || !actor.solid || actor.open) continue;
          if (!rectsOverlap(player.x - 1, player.y - 1, player.w + 2, player.h + 2, actor.x, actor.y, actor.w, actor.h)) continue;
          if (rectsOverlap(player.x, player.y, player.w, player.h, actor.x, actor.y, actor.w, actor.h)) continue;
          triggerReaction(world, actor, "touchedPlayer", { player });
        }
      }

      // Thrown carryables and moving shells hurt enemies.
      for (const missile of state.actors) {
        if (!missile.alive || missile.hidden) continue;
        const def = defs.get(missile.defId);
        const dangerous = (missile.kind === "projectile" && missile.team === "player")
          || (def && def.projectileWhenMoving && Math.abs(missile.vx) >= 60);
        if (!dangerous) continue;
        for (const enemy of state.actors) {
          if (enemy === missile || !enemy.alive || !enemy.active || enemy.hidden || enemy.kind !== "enemy") continue;
          if (enemy.invuln > 0 && !defs.get(enemy.defId)?.indestructible) continue;
          if (!rectsOverlap(missile.x, missile.y, missile.w, missile.h, enemy.x, enemy.y, enemy.w, enemy.h)) continue;
          damageActor(
            world,
            enemy,
            missile.kind === "projectile" ? (missile.damage ?? game.player.weapon.damage) : 99,
            {},
          );
          if (missile.kind === "projectile") {
            missile.alive = false;
            break;
          }
        }
      }

      // Drop the throw: a carried actor is released with action.
      for (const player of state.players) {
        if (!player.alive || player.carrying === 0) continue;
        const held = state.actors.find((actor) => actor.id === player.carrying);
        if (!held || !held.alive) {
          player.carrying = 0;
          continue;
        }
        const input = inputsOf(inputs, player);
        if (player.actionReleased) {
          held.carriedBy = 0;
          player.carrying = 0;
          held.thrownTimer = 0.8;
          const feel = game.player.feel;
          held.vx = input.down ? 0 : player.facing * feel.throwX;
          held.vy = input.down ? 0 : -feel.throwY;
          held.dir = player.facing;
          world.emit("throw", { player: player.index, actorId: held.id });
        }
      }

      // -- sweep the dead --
      if (state.actors.some((actor) => !actor.alive)) {
        state.actors = state.actors.filter((actor) => actor.alive);
      }

      updateCamera(world, dt);

      // -- the end conditions --
      const standing = state.players.filter((player) => player.alive || !player.removed);
      if (standing.length === 0 && !state.outcome) {
        world.endStage("failed", "lives");
      }
    },

    /**
     * A plain, copyable image of the run. Events are not in it — they are
     * presentation — and the game document is not in it either: a snapshot
     * is meaningful only against the game it came from, the same stance as
     * `shmup`'s recordings.
     */
    snapshot() {
      return {
        tick: state.tick,
        elapsed: state.elapsed,
        levelIndex: state.levelIndex,
        timeLeft: state.timeLeft,
        score: state.score,
        coins: state.coins,
        keys: state.keys,
        lives: state.lives,
        nextId: state.nextId,
        camera: { x: state.camera.x, y: state.camera.y },
        checkpoint: state.checkpoint ? { ...state.checkpoint } : null,
        switches: { ...state.switches },
        outcome: state.outcome ? { ...state.outcome } : null,
        players: state.players.map(copyRunNJumpPlayer),
        // The pattern runtime is the one nested structure an actor carries;
        // it is plain JSON data by construction, so a JSON round trip is an
        // honest deep copy of it.
        actors: state.actors.map((actor) => (actor.patternRuntime
          ? { ...actor, patternRuntime: JSON.parse(JSON.stringify(actor.patternRuntime)) }
          : { ...actor })),
        patternShots: state.patternShots.map((shot) => ({ ...shot })),
        tiles: field.tiles.slice(),
      };
    },

    /** @param {any} snap A value `snapshot` returned. */
    restore(snap) {
      state.tick = snap.tick;
      state.elapsed = snap.elapsed;
      state.levelIndex = snap.levelIndex;
      state.timeLeft = snap.timeLeft;
      state.score = snap.score;
      state.coins = snap.coins;
      state.keys = snap.keys;
      state.lives = snap.lives;
      state.nextId = snap.nextId;
      state.camera = { x: snap.camera.x, y: snap.camera.y };
      state.checkpoint = snap.checkpoint ? { ...snap.checkpoint } : null;
      state.switches = { ...snap.switches };
      state.outcome = snap.outcome ? { ...snap.outcome } : null;
      state.players = snap.players.map(copyRunNJumpPlayer);
      state.actors = snap.actors.map((actor) => (actor.patternRuntime
        ? { ...actor, patternRuntime: JSON.parse(JSON.stringify(actor.patternRuntime)) }
        : { ...actor }));
      state.patternShots = (snap.patternShots ?? []).map((shot) => ({ ...shot }));
      field.tiles = snap.tiles.slice();
      field.solids = state.actors.filter((actor) => actor.alive && (actor.solid || actor.platform));
      events = [];
    },
  };

  // -- populate --
  for (let index = 0; index < playerCount; index += 1) {
    const spawn = level.spawns[Math.min(index, level.spawns.length - 1)];
    const offset = level.spawns.length > index ? 0 : index * (game.player.hitbox.w + 6);
    const player = createPlayerState(index, game.player, { x: spawn.x + offset, y: spawn.y });
    if (state.checkpoint) {
      player.x = Math.round(state.checkpoint.x + index * (game.player.hitbox.w + 6));
      player.y = Math.round(state.checkpoint.y);
    }
    if (game.player.loadout) player.equipment = createRunNJumpEquipment(game, game.player.loadout);
    if (game.player.satellite.loadout) player.satEquipment = createRunNJumpEquipment(game, game.player.satellite.loadout);
    if (game.player.defenseId) player.defenseId = game.player.defenseId;
    resetRunNJumpDefense(player, game.defenses?.find((entry) => entry.id === player.defenseId));
    const durability = game.player.satellite.durability;
    if (durability) {
      player.satBody = { hp: durability.hp, alive: true, respawn: 0, invuln: 0 };
      resetRunNJumpDefense(player.satBody, game.defenses?.find((entry) => entry.id === durability.defenseId));
    }
    state.players.push(player);
  }
  for (const placed of level.actors) {
    const actor = world.spawnActor(placed.defId, placed.x, placed.y, placed.dir);
    if (actor) { actor.placedId = placed.id; if (placed.appearance?.rotation) actor.authoredRotation = placed.appearance.rotation; }
  }
  updateCamera(world, 0);

  return world;
}

/** Everything a moving solid can push or carry, in deterministic order. */
function movableActors(state, solid) {
  const movable = [...state.players];
  for (const actor of state.actors) {
    if (actor === solid || actor.solid || actor.platform || !actor.alive) continue;
    movable.push(actor);
  }
  return movable;
}

function nearestAlivePlayer(state, actor) {
  let best = null;
  let bestDistance = Infinity;
  for (const player of state.players) {
    if (!player.alive) continue;
    const dx = (player.x + player.w / 2) - (actor.x + actor.w / 2);
    const dy = (player.y + player.h / 2) - (actor.y + actor.h / 2);
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) { bestDistance = distance; best = player; }
  }
  return best;
}

function inputsOf(inputs, player) {
  return inputs[player.index] ?? neutralInput();
}

function respawnPlayer(world, player) {
  const hero = world.game.player;
  const level = world.level;
  const spawn = world.state.checkpoint
    ?? level.spawns[Math.min(player.index, level.spawns.length - 1)];
  player.alive = true;
  player.x = Math.round(spawn.x);
  player.y = Math.round(spawn.y);
  player.rx = 0; player.ry = 0;
  player.vx = 0; player.vy = 0;
  player.w = hero.hitbox.w;
  player.h = hero.health.model === "power" ? hero.duckHitbox.h : hero.hitbox.h;
  player.power = 0;
  player.hp = hero.health.model === "hits" ? hero.health.max : 1;
  player.invuln = 2;
  player.grounded = false;
  player.climbing = false;
  player.ducking = false;
  player.carrying = 0;
  resetRunNJumpDefense(player, world.game.defenses?.find((entry) => entry.id === player.defenseId));
  world.emit("respawn", { player: player.index });
}

function collectPickup(world, player, actor) {
  const def = world.defOf(actor.defId);
  if (!def || !def.pickup) {
    actor.alive = false;
    return;
  }
  const pickup = def.pickup;
  const state = world.state;
  switch (pickup.effect) {
    case "weapon":
    case "satelliteWeapon":
      if (!collectRunNJumpWeapon(world, player, pickup.weaponId, pickup.effect === "satelliteWeapon")) return;
      break;
    case "defense": {
      const defense = world.game.defenses?.find((entry) => entry.id === pickup.defenseId); if (!defense) return;
      player.defenseId = defense.id; resetRunNJumpDefense(player, defense); break;
    }
    case "coin":
      state.coins += pickup.value;
      break;
    case "health": {
      const health = world.game.player.health;
      if (health.model === "hits") player.hp = Math.min(player.hp + pickup.value, health.max);
      break;
    }
    case "power": {
      const health = world.game.player.health;
      if (health.model === "power" && player.power < health.max - 1) {
        player.power += 1;
        const hero = world.game.player;
        if (player.power >= 1 && player.h !== hero.hitbox.h && !player.ducking) {
          player.y += player.h - hero.hitbox.h;
          player.h = hero.hitbox.h;
        }
      }
      break;
    }
    case "invincible":
      player.invincible = pickup.duration || 8;
      break;
    case "life":
      state.lives += pickup.value;
      break;
    case "key":
      state.keys += pickup.value;
      break;
    case "score":
      break;
    case "clearEnemies":
      for (const enemy of world.state.actors) {
        if (enemy.alive && enemy.active && enemy.kind === "enemy" && !world.defOf(enemy.defId)?.indestructible) {
          enemy.alive = false;
          world.emit("death", { actorId: enemy.id, defId: enemy.defId, x: enemy.x, y: enemy.y });
        }
      }
      break;
    default:
      break;
  }
  state.score += def.score;
  actor.alive = false;
  world.emit("pickup", { player: player.index, effect: pickup.effect, x: actor.x, y: actor.y });
}

function damageActor(world, actor, damage, ctx) {
  if (!actor.alive) return;
  if (world.defOf(actor.defId)?.indestructible) { world.emit("armor-hit", {actorId:actor.id,x:actor.x+actor.w/2,y:actor.y+actor.h/2}); return; }
  if (actor.invuln > 0) return;
  const defense = world.game.defenses?.find((entry) => entry.id === world.defOf(actor.defId)?.defenseId);
  damage = absorbRunNJumpDamage(world, actor, defense, damage, { actorId: actor.id });
  if (damage <= 0) { actor.invuln = 0.35; return; }
  actor.hp -= damage;
  if (actor.hp <= 0) {
    const def = world.defOf(actor.defId);
    triggerReaction(world, actor, "died", ctx);
    if (actor.alive) {
      actor.alive = false;
      world.state.score += def ? def.score : 0;
      world.emit("death", { actorId: actor.id, defId: actor.defId, x: actor.x, y: actor.y });
    }
  } else {
    actor.invuln = 0.35;
    triggerReaction(world, actor, "hurt", ctx);
    triggerReaction(world, actor, "healthBelow", ctx);
    world.emit("actor-hurt", { actorId: actor.id, hp: actor.hp });
  }
}

function meleeReaches(world, player, actor) {
  const range = world.game.player.weapon.meleeRange;
  const front = player.facing > 0
    ? actor.x + actor.w >= player.x + player.w && actor.x <= player.x + player.w + range
    : actor.x <= player.x && actor.x + actor.w >= player.x - range;
  return front;
}

function warpPlayer(world, player, actor, tag) {
  if (!tag) return;
  const partners = world.state.actors.filter((other) => {
    if (other.id === actor.id || !other.alive) return false;
    const def = world.defOf(other.defId);
    return def && def.warp && def.warp.tag === tag;
  });
  if (partners.length === 0) return;
  const target = partners[0];
  player.x = Math.round(target.x + target.w / 2 - player.w / 2);
  player.y = Math.round(target.y - player.h);
  player.rx = 0; player.ry = 0;
  player.vx = 0; player.vy = 0;
  player.warpCooldown = 0.8;
  world.emit("warp", { player: player.index, x: player.x, y: player.y });
}


function copyRunNJumpPlayer(player) {
  const copy = { ...player };
  for (const key of ["equipment", "satEquipment", "weaponPattern", "satPattern", "satBody"]) if (player[key]) copy[key] = JSON.parse(JSON.stringify(player[key]));
  return copy;
}

function damageRunNJumpSatellite(world, player, damage) {
  const body = player.satBody, settings = world.game.player.satellite;
  if (!body?.alive || body.invuln > 0) return;
  const defense = world.game.defenses?.find((entry) => entry.id === settings.durability.defenseId);
  const remaining = absorbRunNJumpDamage(world, body, defense, damage, { player: player.index, satellite: true });
  body.invuln = 0.2; body.hp -= remaining;
  if (body.hp <= 0) {
    body.alive = false; body.respawn = settings.durability.respawn;
    const at = satellitePosition(world.game.player, player);
    world.emit("satellite-death", { player: player.index, x: at.x, y: at.y });
  }
}
