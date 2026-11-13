// What an enemy does, as data rather than code.
//
// An ordered registry of named rules, resolved from a document by string,
// each a pure function of `(actor, context, dt)` that sets the actor's
// intended velocity and nothing else — the world does the moving, so every
// enemy collides, slides and gets shoved through exactly one code path.
// A game may register its own; nothing in a document is ever executable.
//
// The same stance `runnjump/behaviors.js` takes, with one difference this
// genre earns: **a behaviour may roll dice**, because the run carries a
// plain-data seeded state (`topdown/random.js`) that snapshots. A wanderer
// is therefore identical on two machines and across a rollback, which is
// what makes it usable in co-op at all.
//
// Everything here reads `context`:
//   { field, run, feel, target, random, tick }
// where `target` is the nearest living hero, or null when none is.

import { atan2, cos, sin } from "../core/trig.js";
import { bodyCenterX, bodyCenterY, lineOfSight } from "./move.js";
import { randomRange } from "./random.js";

/** Aim an actor's velocity along an angle at its own speed. */
function driveAt(actor, angle, speed) {
  actor.vx = cos(angle) * speed;
  actor.vy = sin(angle) * speed;
}

function angleToTarget(actor, target) {
  return atan2(bodyCenterY(target) - bodyCenterY(actor), bodyCenterX(target) - bodyCenterX(actor));
}

function distanceTo(actor, target) {
  const dx = bodyCenterX(target) - bodyCenterX(actor);
  const dy = bodyCenterY(target) - bodyCenterY(actor);
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * The built-ins. Each takes the actor's own `speed` from its definition,
 * so a fast chaser and a slow one are one behaviour with two numbers.
 */
const BEHAVIORS = new Map();

/** Scenery, and the fallback for a name nothing registered. */
BEHAVIORS.set("still", (actor) => {
  actor.vx = 0;
  actor.vy = 0;
});

/**
 * Straight until blocked, then turn — the corridor pacer. Clockwise by
 * default; `params.turn: "left"` mirrors it, so two of them from mirrored
 * spawns diverge at the first junction without a die roll.
 */
BEHAVIORS.set("patrol", (actor, context) => {
  const params = actor.params ?? {};
  if (actor.blocked || actor.heading === undefined) {
    const quarter = params.turn === "left" ? -Math.PI / 2 : Math.PI / 2;
    actor.heading = (actor.heading ?? 0) + (actor.blocked ? quarter : 0);
  }
  driveAt(actor, actor.heading ?? 0, actor.speed);
});

/** Straight at the nearest hero, whenever it can see one. */
BEHAVIORS.set("chase", (actor, context) => {
  const { target, field } = context;
  if (!target) {
    actor.vx = 0;
    actor.vy = 0;
    return;
  }
  const params = actor.params ?? {};
  const sight = Number(params.sight) || 0;
  const distance = distanceTo(actor, target);
  const blind = sight > 0 && distance > sight;
  const seen = !blind && lineOfSight(field, bodyCenterX(actor), bodyCenterY(actor), bodyCenterX(target), bodyCenterY(target));
  if (!seen) {
    actor.vx = 0;
    actor.vy = 0;
    return;
  }
  actor.heading = angleToTarget(actor, target);
  driveAt(actor, actor.heading, actor.speed);
});

/** The opposite, for a thing that runs when hurt. */
BEHAVIORS.set("flee", (actor, context) => {
  const { target } = context;
  if (!target) {
    actor.vx = 0;
    actor.vy = 0;
    return;
  }
  actor.heading = angleToTarget(actor, target) + Math.PI;
  driveAt(actor, actor.heading, actor.speed);
});

/**
 * A drunkard's walk, re-rolled every `params.holdTicks`. The one built-in
 * that spends the run's dice — and it spends them from the shared state,
 * so a snapshot captures exactly where the drunkard is in its stagger.
 */
BEHAVIORS.set("wander", (actor, context) => {
  const params = actor.params ?? {};
  const hold = Math.max(1, Math.round(Number(params.holdTicks) || 45));
  if (actor.timer === undefined || actor.timer <= 0 || actor.blocked) {
    actor.heading = randomRange(context.random, -Math.PI, Math.PI);
    actor.timer = hold;
  }
  actor.timer -= 1;
  driveAt(actor, actor.heading ?? 0, actor.speed);
});

/**
 * Wind up, dash, recover — the charger, and the reason `blocked` is
 * reported back to behaviours at all: hitting a wall mid-dash should end
 * the dash rather than grind along it.
 */
BEHAVIORS.set("charge", (actor, context) => {
  const params = actor.params ?? {};
  const windup = Math.max(1, Math.round(Number(params.windup) || 30));
  const dash = Math.max(1, Math.round(Number(params.dash) || 24));
  const rest = Math.max(0, Math.round(Number(params.rest) || 30));
  const speed = actor.speed * (Number(params.boost) || 3);
  const { target } = context;

  actor.phase = actor.phase ?? "wind";
  actor.timer = actor.timer ?? windup;
  actor.timer -= 1;

  if (actor.phase === "wind") {
    actor.vx = 0;
    actor.vy = 0;
    if (target) actor.heading = angleToTarget(actor, target);
    if (actor.timer <= 0) {
      actor.phase = "dash";
      actor.timer = dash;
    }
    return;
  }
  if (actor.phase === "dash") {
    driveAt(actor, actor.heading ?? 0, speed);
    if (actor.timer <= 0 || actor.blocked) {
      actor.phase = "rest";
      actor.timer = rest;
    }
    return;
  }
  actor.vx = 0;
  actor.vy = 0;
  if (actor.timer <= 0) {
    actor.phase = "wind";
    actor.timer = windup;
  }
});

/** Circles the hero at a distance — the archer's dance. */
BEHAVIORS.set("orbit", (actor, context) => {
  const { target } = context;
  if (!target) {
    actor.vx = 0;
    actor.vy = 0;
    return;
  }
  const params = actor.params ?? {};
  const want = Number(params.range) || 80;
  const spin = params.turn === "left" ? -1 : 1;
  const toward = angleToTarget(actor, target);
  const distance = distanceTo(actor, target);
  // Close in, back off, or ring around — one blend, no state.
  const drift = distance > want * 1.15 ? 0 : distance < want * 0.85 ? Math.PI : Math.PI / 2 * spin;
  actor.heading = toward + drift;
  driveAt(actor, actor.heading, actor.speed);
});

/** Holds station and shoots; the world reads `wantsToShoot`. */
BEHAVIORS.set("turret", (actor, context) => {
  const { target, field } = context;
  actor.vx = 0;
  actor.vy = 0;
  actor.wantsToShoot = false;
  if (!target) return;
  const params = actor.params ?? {};
  const sight = Number(params.sight) || 240;
  if (distanceTo(actor, target) > sight) return;
  if (!lineOfSight(field, bodyCenterX(actor), bodyCenterY(actor), bodyCenterX(target), bodyCenterY(target))) return;
  actor.heading = angleToTarget(actor, target);
  actor.wantsToShoot = true;
});

/**
 * The horde's cheap one: straight at the hero, ignoring walls it cannot
 * see through — no sight test, no state, one atan2. This is what a
 * thousand of something costs when the answer is "toward the player".
 */
BEHAVIORS.set("swarm", (actor, context) => {
  const { target } = context;
  if (!target) {
    actor.vx = 0;
    actor.vy = 0;
    return;
  }
  actor.heading = angleToTarget(actor, target);
  driveAt(actor, actor.heading, actor.speed);
});

/**
 * Register a behaviour, or replace a built-in. The function is
 * `(actor, context, dt)` and must be a PURE function of its arguments:
 * no clock, no `Math.random` — the run's dice are in `context.random`,
 * and they are the only randomness a replay can reproduce.
 *
 * @param {string} name
 * @param {(actor: any, context: any, dt: number) => void} run
 */
export function registerTopdownBehavior(name, run) {
  if (typeof name !== "string" || !name || typeof run !== "function") return false;
  BEHAVIORS.set(name, run);
  return true;
}

/** Every registered name, sorted — for an editor's dropdown. */
export function topdownBehaviorNames() {
  return [...BEHAVIORS.keys()].sort();
}

/** Whether a name resolves. An author may write one before it exists. */
export function topdownBehaviorExists(name) {
  return BEHAVIORS.has(name);
}

/**
 * Run one actor's behaviour. An unknown name falls back to `still` rather
 * than throwing: a document may name a behaviour the game registers later,
 * and a missing rule should make a statue, not a crash.
 */
export function runTopdownBehavior(actor, context, dt) {
  const rule = BEHAVIORS.get(actor.behavior) ?? BEHAVIORS.get("still");
  rule(actor, context, dt);
}
