// Reactions: the trigger→effect table that gives an actor its character.
//
// A shell-on-stomp enemy, a block that breaks into fragments, a boss
// changing phase and a pickup that upgrades the player are all the same
// mechanism — `becomeKind` — which is what earns the table its place. It is
// deliberately narrow and must stay so: a schema that expresses everything
// is not a schema, and anything past this is a game registering its own
// behaviour, not a new effect type.

import { hurtPlayer } from "./player.js";

/**
 * Fire an actor's reactions for a trigger. The default stomp — die, score,
 * bounce the player — applies when a stompable actor declares nothing for
 * `stomped`, so a user-made enemy is stompable without ceremony.
 *
 * @param {any} world
 * @param {any} actor
 * @param {string} when A `REACTION_WHEN` name.
 * @param {{player?: any}} [ctx]
 */
export function triggerReaction(world, actor, when, ctx = {}) {
  const def = world.defOf(actor.defId);
  if (!def) return;
  if (def.indestructible && ["stomped", "hurt", "died", "healthBelow", "crushed"].includes(when)) {
    if (when === "stomped" && ctx.player) runEffect(world, actor, {type:"bouncePlayer"}, ctx);
    world.emit("armor-hit", {actorId:actor.id,x:actor.x+actor.w/2,y:actor.y+actor.h/2});
    return;
  }
  let matched = false;
  for (const reaction of def.reactions) {
    if (reaction.when !== when) continue;
    if (when === "healthBelow" && !(actor.hp <= (reaction.threshold ?? 1))) continue;
    matched = true;
    for (const effect of reaction.do) runEffect(world, actor, effect, ctx);
  }
  if (!matched && when === "stomped" && def.stompable) {
    runEffect(world, actor, { type: "die" }, ctx);
    runEffect(world, actor, { type: "score", amount: def.score || 100 }, ctx);
    runEffect(world, actor, { type: "bouncePlayer" }, ctx);
    runEffect(world, actor, { type: "sfx", name: "stomp" }, ctx);
  }
  if (!matched && when === "crushed") {
    runEffect(world, actor, { type: "die" }, ctx);
  }
}

function runEffect(world, actor, effect, ctx) {
  switch (effect.type) {
    case "damage": {
      if (ctx.player) hurtPlayer(world, ctx.player, effect.amount ?? 1, actor.x + actor.w / 2);
      break;
    }
    case "die": {
      if (!actor.alive) break;
      actor.alive = false;
      world.emit("death", { actorId: actor.id, defId: actor.defId, x: actor.x, y: actor.y });
      break;
    }
    case "becomeKind": {
      if (typeof effect.defId === "string") world.morphActor(actor, effect.defId);
      break;
    }
    case "setBehavior": {
      actor.bOverride = typeof effect.behavior === "string" ? effect.behavior : "";
      actor.bState = 0;
      actor.bTimer = 0;
      break;
    }
    case "spawn": {
      const spawned = world.spawnActor(
        typeof effect.defId === "string" ? effect.defId : "walker",
        actor.x + (effect.dx ?? 0),
        actor.y + (effect.dy ?? 0),
        effect.dir === 1 ? 1 : -1,
      );
      if (spawned) {
        spawned.spawnedBy = actor.id;
        spawned.vx = effect.vx ?? 0;
        spawned.vy = effect.vy ?? 0;
      }
      break;
    }
    case "dropPickup": {
      const dropped = world.spawnActor(
        typeof effect.defId === "string" ? effect.defId : "coin",
        actor.x + (actor.w >> 1) - 5,
        actor.y - 12,
        1,
      );
      if (dropped) dropped.vy = -120;
      break;
    }
    case "score": {
      world.state.score += Math.max(0, Math.round(effect.amount ?? 0));
      world.emit("score", { amount: effect.amount ?? 0, x: actor.x, y: actor.y });
      break;
    }
    case "sfx": {
      world.emit("sfx", { name: typeof effect.name === "string" ? effect.name : "hit" });
      break;
    }
    case "burst": {
      world.emit("burst", {
        x: actor.x + actor.w / 2,
        y: actor.y + actor.h / 2,
        color: typeof effect.color === "string" ? effect.color : "",
        count: effect.count ?? 8,
      });
      break;
    }
    case "shakeCamera": {
      world.emit("shake", { power: effect.power ?? 1 });
      break;
    }
    case "setVelocity": {
      // `fromPlayer` aims the kick away from whoever touched it — the shell.
      const sign = effect.fromPlayer && ctx.player
        ? (actor.x + actor.w / 2 >= ctx.player.x + ctx.player.w / 2 ? 1 : -1)
        : (actor.facing || 1);
      actor.vx = (effect.vx ?? 0) * sign;
      if (effect.vy !== undefined) actor.vy = effect.vy;
      actor.dir = actor.vx === 0 ? actor.dir : (actor.vx > 0 ? 1 : -1);
      break;
    }
    case "makeInvulnerable": {
      actor.invuln = Math.max(actor.invuln, effect.time ?? 1);
      break;
    }
    case "toggleSwitchGroup": {
      const tag = typeof effect.tag === "string" ? effect.tag : actor.switchGroup;
      if (tag) world.toggleSwitches(tag);
      break;
    }
    case "endLevel": {
      world.endStage(effect.result === "failed" ? "failed" : "cleared", "level");
      break;
    }
    case "bouncePlayer": {
      if (ctx.player) {
        const feel = world.game.player.feel;
        // An explicit power (a spring) is absolute; the stomp default gets
        // the held-jump boost every platformer's stomp has.
        ctx.player.vy = effect.power
          ? -effect.power
          : -feel.stompBounce * (ctx.player.jumpHeldPrev ? 1.3 : 1);
        ctx.player.grounded = false;
        ctx.player.jumpsUsed = 0;
      }
      break;
    }
    case "setCheckpoint": {
      world.state.checkpoint = { x: actor.x, y: actor.y - 8 };
      world.emit("checkpoint", { x: actor.x, y: actor.y });
      break;
    }
    case "unlock": {
      if (world.state.keys > 0) {
        world.state.keys -= 1;
        actor.alive = false;
        world.emit("unlock", { actorId: actor.id });
      }
      break;
    }
    default:
      break;
  }
}
