import { runNJumpActorAim, runNJumpMuzzle, runNJumpCanFire } from "./motion.js";
// The behaviour library: what an enemy does, as data.
//
// A behaviour is a named pure-ish function of (world, actor, params, dt)
// that steers by writing velocities and flags; the world applies gravity
// and movement afterwards, through the same collision core as the player.
// A level references behaviours by string, a game may register its own
// through `registerBehavior`, and nothing in a document is ever code.
//
// Determinism holds here the same way it does everywhere else: the only
// transcendentals are `core/trig`'s, and there is no randomness — where a
// classic design reaches for chance (a barrel "sometimes" takes the
// ladder), the parameter is a deterministic policy (`alternate`) instead.

import { sin, cos, hypot, TAU as TRIG_TAU } from "../core/trig.js";
import { surfaceAtPoint, tileDefAt } from "./move.js";

const REGISTRY = new Map();

/**
 * @param {string} type
 * @param {(world: any, actor: any, params: any, dt: number) => void} fn
 */
export function registerBehavior(type, fn) {
  REGISTRY.set(type, fn);
}

/** @param {string} type */
export function behaviorExists(type) {
  return REGISTRY.has(type);
}

/** Every registered behaviour name, for editor palettes. */
export function behaviorNames() {
  return [...REGISTRY.keys()];
}

/**
 * What each behaviour's parameters are, for whatever edits them — label,
 * range, step, kind. This lives HERE, beside the registry, for the reason
 * `SFX_FIELDS` lives beside the synth: two editors over one engine each
 * keeping their own copy of this table is how the copies drift, and the sfx
 * designer's table had drifted in three places before it moved home. A test
 * holds the table complete against the registry.
 *
 * The spec shape is `core/fields`' FieldSpec, so an editor can hand a
 * behaviour's entry straight to `defineFields`.
 */
const BEHAVIOR_PARAM_SPECS = {
  still: [],
  patrol: [
    { key: "speed", label: "speed", min: 5, max: 300, step: 2, fallback: 40, unit: " px/s" },
  ],
  patrolLedge: [
    { key: "speed", label: "speed", min: 5, max: 300, step: 2, fallback: 36, unit: " px/s" },
  ],
  pace: [
    { key: "speed", label: "speed", min: 5, max: 300, step: 2, fallback: 40, unit: " px/s" },
    { key: "distance", label: "distance", min: 8, max: 600, step: 8, fallback: 48, unit: " px" },
  ],
  chase: [
    { key: "speed", label: "speed", min: 5, max: 300, step: 2, fallback: 50, unit: " px/s" },
  ],
  flee: [
    { key: "speed", label: "speed", min: 5, max: 300, step: 2, fallback: 50, unit: " px/s" },
  ],
  hop: [
    { key: "speed", label: "forward speed", min: 0, max: 300, step: 2, fallback: 40, unit: " px/s" },
    { key: "power", label: "hop power", min: 40, max: 700, step: 10, fallback: 220, unit: " px/s" },
    { key: "pause", label: "pause between", min: 0, max: 4, step: 0.1, fallback: 0.5, unit: " s", decimals: 1 },
  ],
  leap: [
    { key: "speed", label: "forward speed", min: 0, max: 300, step: 2, fallback: 60, unit: " px/s" },
    { key: "power", label: "leap power", min: 40, max: 700, step: 10, fallback: 300, unit: " px/s" },
    { key: "pause", label: "pause between", min: 0, max: 4, step: 0.1, fallback: 0.9, unit: " s", decimals: 1 },
  ],
  charge: [
    { key: "speed", label: "charge speed", min: 20, max: 500, step: 5, fallback: 140, unit: " px/s" },
    { key: "range", label: "trigger range", min: 16, max: 600, step: 8, fallback: 140, unit: " px" },
    { key: "pause", label: "stun after wall", min: 0, max: 4, step: 0.1, fallback: 0.6, unit: " s", decimals: 1 },
  ],
  fly: [
    { key: "mode", label: "path", type: "enum", options: ["sine", "zigzag", "circle", "figure8"], fallback: "sine" },
    { key: "speed", label: "speed", min: 0, max: 300, step: 2, fallback: 40, unit: " px/s" },
    { key: "amplitude", label: "amplitude", min: 0, max: 200, step: 2, fallback: 24, unit: " px" },
    { key: "frequency", label: "frequency", min: 0.05, max: 4, step: 0.05, fallback: 0.5, unit: " /s", decimals: 2 },
    { key: "rangeX", label: "range (0 = walls)", min: 0, max: 1000, step: 8, fallback: 0, unit: " px" },
  ],
  hover: [
    { key: "speed", label: "speed", min: 5, max: 300, step: 2, fallback: 60, unit: " px/s" },
    { key: "height", label: "height above player", min: 0, max: 300, step: 4, fallback: 48, unit: " px" },
  ],
  swoop: [
    { key: "range", label: "trigger range", min: 16, max: 600, step: 8, fallback: 120, unit: " px" },
    { key: "speed", label: "dive speed", min: 40, max: 500, step: 5, fallback: 180, unit: " px/s" },
    { key: "rest", label: "rest after", min: 0, max: 5, step: 0.1, fallback: 1.2, unit: " s", decimals: 1 },
  ],
  path: [
    { key: "speed", label: "speed", min: 5, max: 300, step: 2, fallback: 40, unit: " px/s" },
    { key: "mode", label: "at the end", type: "enum", options: ["loop", "pingpong"], fallback: "loop" },
  ],
  drop: [
    { key: "range", label: "trigger width", min: 4, max: 300, step: 4, fallback: 24, unit: " px" },
  ],
  riseAndSink: [
    { key: "amplitude", label: "travel", min: 4, max: 300, step: 4, fallback: 32, unit: " px" },
    { key: "frequency", label: "frequency", min: 0.05, max: 2, step: 0.05, fallback: 0.25, unit: " /s", decimals: 2 },
  ],
  bounce: [
    { key: "speed", label: "forward speed", min: 0, max: 300, step: 2, fallback: 60, unit: " px/s" },
    { key: "power", label: "bounce power", min: 40, max: 700, step: 10, fallback: 260, unit: " px/s" },
  ],
  roll: [
    { key: "speed", label: "speed", min: 10, max: 300, step: 2, fallback: 70, unit: " px/s" },
    { key: "accel", label: "acceleration", min: 20, max: 800, step: 10, fallback: 160, unit: " px/s²" },
    { key: "takeLadders", label: "ladders", type: "enum", options: ["never", "always", "alternate"], fallback: "never" },
  ],
  burrow: [
    { key: "period", label: "cycle", min: 0.5, max: 10, step: 0.1, fallback: 2.4, unit: " s", decimals: 1 },
    { key: "duty", label: "time up", min: 0.1, max: 0.9, step: 0.05, fallback: 0.5, decimals: 2 },
  ],
  spawner: [
    { key: "defId", label: "spawns", type: "reference", refKind: "actor", fallback: "walker" },
    { key: "interval", label: "every", min: 0.3, max: 20, step: 0.1, fallback: 2.5, unit: " s", decimals: 1 },
    { key: "limit", label: "alive at once", type: "integer", min: 1, max: 20, fallback: 3 },
    { key: "vx", label: "launch vx", min: -400, max: 400, step: 5, fallback: 0, unit: " px/s" },
    { key: "vy", label: "launch vy", min: -400, max: 400, step: 5, fallback: 0, unit: " px/s" },
  ],
  turret: [
    { key: "defId", label: "fires", type: "reference", refKind: "actor", fallback: "enemy-shot" },
    { key: "interval", label: "every", min: 0.2, max: 10, step: 0.1, fallback: 1.6, unit: " s", decimals: 1 },
    { key: "speed", label: "shot speed", min: 40, max: 500, step: 5, fallback: 160, unit: " px/s" },
    { key: "aim", label: "aim at player", type: "boolean", fallback: true },
  ],
  thrower: [
    { key: "defId", label: "throws", type: "reference", refKind: "actor", fallback: "enemy-lob" },
    { key: "interval", label: "every", min: 0.3, max: 10, step: 0.1, fallback: 2.2, unit: " s", decimals: 1 },
    { key: "power", label: "arc power", min: 40, max: 600, step: 10, fallback: 250, unit: " px/s" },
    { key: "speed", label: "forward speed", min: 0, max: 300, step: 5, fallback: 90, unit: " px/s" },
  ],
  carrier: [
    { key: "defId", label: "drops", type: "reference", refKind: "actor", fallback: "enemy-lob" },
    { key: "speed", label: "speed", min: 5, max: 300, step: 2, fallback: 50, unit: " px/s" },
    { key: "rangeX", label: "patrol range", min: 16, max: 1000, step: 8, fallback: 96, unit: " px" },
    { key: "interval", label: "drop cooldown", min: 0.3, max: 10, step: 0.1, fallback: 1.8, unit: " s", decimals: 1 },
  ],
  slide: [
    { key: "speed", label: "slide speed", min: 40, max: 500, step: 5, fallback: 180, unit: " px/s" },
  ],
  shot: [
    { key: "ttl", label: "lifetime", min: 0.2, max: 10, step: 0.1, fallback: 3, unit: " s", decimals: 1 },
    { key: "bounces", label: "survives landing", type: "boolean", fallback: false },
  ],
  falling: [
    { key: "delay", label: "delay when ridden", min: 0, max: 3, step: 0.05, fallback: 0.4, unit: " s", decimals: 2 },
  ],
  crumble: [
    { key: "delay", label: "delay when ridden", min: 0, max: 3, step: 0.05, fallback: 0.5, unit: " s", decimals: 2 },
    { key: "respawn", label: "back after", min: 0.5, max: 20, step: 0.5, fallback: 2.5, unit: " s", decimals: 1 },
  ],
};

/**
 * The parameter specs for one behaviour, or an empty list for one this
 * module has never heard of (a game-registered behaviour supplies its own
 * editing surface, or none).
 *
 * @param {string} type
 * @returns {readonly any[]}
 */
export function behaviorParams(type) {
  return BEHAVIOR_PARAM_SPECS[type] ?? [];
}

/** For the completeness test: does the spec table cover the registry? */
export function behaviorParamsCover() {
  return [...REGISTRY.keys()].filter((type) => !(type in BEHAVIOR_PARAM_SPECS));
}

/**
 * Run an actor's behaviours in order. `setBehavior` reactions store an
 * override on the actor; when present, only the override runs.
 *
 * @param {any} world
 * @param {any} actor
 * @param {any} def
 * @param {number} dt
 */
export function stepBehaviors(world, actor, def, dt) {
  if (actor.bOverride) {
    const fn = REGISTRY.get(actor.bOverride);
    if (fn) {
      const declared = def.behaviors.find((entry) => entry.type === actor.bOverride);
      fn(world, actor, declared ?? { type: actor.bOverride }, dt);
    }
    return;
  }
  for (const entry of def.behaviors) {
    const fn = REGISTRY.get(entry.type);
    if (fn) fn(world, actor, entry, dt);
  }
}

// -- helpers the behaviours share --

function nearestPlayer(world, actor) {
  let best = null;
  let bestDistance = Infinity;
  for (const player of world.state.players) {
    if (!player.alive) continue;
    const dx = (player.x + player.w / 2) - (actor.x + actor.w / 2);
    const dy = (player.y + player.h / 2) - (actor.y + actor.h / 2);
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) { bestDistance = distance; best = player; }
  }
  return best;
}

function towardPlayerX(world, actor) {
  const player = nearestPlayer(world, actor);
  if (!player) return actor.dir;
  const dx = (player.x + player.w / 2) - (actor.x + actor.w / 2);
  return dx === 0 ? actor.dir : (dx > 0 ? 1 : -1);
}

/** Is there ground ahead of the leading foot? The patrolLedge probe. */
function groundAhead(world, actor) {
  const field = world.field;
  const foot = actor.y + actor.h;
  const probeX = actor.dir > 0 ? actor.x + actor.w + 1 : actor.x - 2;
  const surface = surfaceAtPoint(field, probeX, foot - field.tileSize / 2, foot + field.tileSize / 2);
  if (surface !== null) return true;
  for (const solid of field.solids) {
    if (!solid.alive) continue;
    if ((solid.solid || solid.platform) && solid.y >= foot - 2 && solid.y <= foot + 8
      && probeX >= solid.x && probeX < solid.x + solid.w) return true;
  }
  return false;
}

/** Fraction part, for waves. Deterministic: one divide, one floor. */
function frac(value) {
  return value - Math.floor(value);
}

/** Triangle wave in [-1, 1] from a phase in [0, 1). No trigonometry needed. */
function triangleWave(phase) {
  return phase < 0.5 ? phase * 4 - 1 : 3 - phase * 4;
}

/** Steer one axis toward a target position through the collision core. */
/**
 * Move an actor toward `target` on one axis, at most `maxStep` pixels.
 *
 * Both the target and the current position are read to the sub-pixel, and
 * that is the whole point. Seeking from `actor.y` — a whole pixel — toward a
 * rounded target makes every delta a whole number, which leaves the mover no
 * fraction to carry: an actor driven this way is structurally incapable of
 * sub-pixel movement. A sine flyer covering 1.25px a step therefore advances
 * 1, 1, 2 and holds still for eight steps at each end of its arc, while its
 * horizontal glide stays perfectly smooth — which reads as a shiver.
 *
 * The raw `x + rx` is used rather than `exactX`: the guard in that one is
 * about not DRAWING a remainder pushing into a wall, and this is movement
 * arithmetic, where the mover's own accumulated position is what counts.
 */
function seekAxis(world, actor, axis, target, maxStep) {
  const current = axis === "x" ? actor.x + (actor.rx || 0) : actor.y + (actor.ry || 0);
  const delta = Math.max(-maxStep, Math.min(maxStep, target - current));
  if (axis === "x") world.moveX(actor, delta, { glue: false });
  else world.moveY(actor, delta);
}

// -- the library --

registerBehavior("still", (world, actor) => {
  actor.vx = 0;
});

registerBehavior("patrol", (world, actor, params) => {
  const speed = params.speed ?? 40;
  if (actor.hitWall) actor.dir = -actor.dir;
  actor.vx = actor.dir * speed;
  actor.facing = actor.dir;
});

registerBehavior("patrolLedge", (world, actor, params) => {
  const speed = params.speed ?? 36;
  if (actor.hitWall || (actor.grounded && !groundAhead(world, actor))) actor.dir = -actor.dir;
  actor.vx = actor.dir * speed;
  actor.facing = actor.dir;
});

registerBehavior("pace", (world, actor, params) => {
  const speed = params.speed ?? 40;
  const distance = params.distance ?? 48;
  if (actor.hitWall) actor.dir = -actor.dir;
  else if (actor.dir > 0 && actor.x - actor.homeX >= distance) actor.dir = -1;
  else if (actor.dir < 0 && actor.homeX - actor.x >= distance) actor.dir = 1;
  actor.vx = actor.dir * speed;
  actor.facing = actor.dir;
});

registerBehavior("chase", (world, actor, params) => {
  const speed = params.speed ?? 50;
  actor.dir = towardPlayerX(world, actor);
  actor.vx = actor.dir * speed;
  actor.facing = actor.dir;
});

registerBehavior("flee", (world, actor, params) => {
  const speed = params.speed ?? 50;
  actor.dir = -towardPlayerX(world, actor);
  actor.vx = actor.dir * speed;
  actor.facing = actor.dir;
});

registerBehavior("hop", (world, actor, params, dt) => {
  const speed = params.speed ?? 40;
  const power = params.power ?? 220;
  const pause = params.pause ?? 0.5;
  if (actor.grounded) {
    actor.vx = 0;
    actor.bTimer -= dt;
    if (actor.bTimer <= 0) {
      if (actor.hitWall) actor.dir = -actor.dir;
      actor.vy = -power;
      actor.vx = actor.dir * speed;
      actor.grounded = false;
      actor.bTimer = pause;
    }
  } else {
    actor.vx = actor.dir * speed;
  }
  actor.facing = actor.dir;
});

registerBehavior("leap", (world, actor, params, dt) => {
  const speed = params.speed ?? 60;
  const power = params.power ?? 300;
  const pause = params.pause ?? 0.9;
  if (actor.grounded) {
    actor.vx = 0;
    actor.bTimer -= dt;
    if (actor.bTimer <= 0) {
      actor.dir = towardPlayerX(world, actor);
      actor.vy = -power;
      actor.vx = actor.dir * speed;
      actor.grounded = false;
      actor.bTimer = pause;
    }
  } else {
    actor.vx = actor.dir * speed;
  }
  actor.facing = actor.dir;
});

registerBehavior("charge", (world, actor, params, dt) => {
  const speed = params.speed ?? 140;
  const range = params.range ?? 140;
  const pause = params.pause ?? 0.6;
  const player = nearestPlayer(world, actor);
  if (actor.bState === 0) {
    actor.vx = 0;
    if (player
      && Math.abs((player.x + player.w / 2) - (actor.x + actor.w / 2)) <= range
      && Math.abs((player.y + player.h) - (actor.y + actor.h)) <= 24) {
      actor.bState = 1;
      actor.dir = towardPlayerX(world, actor);
      world.emit("charge", { actorId: actor.id });
    }
  } else if (actor.bState === 1) {
    actor.vx = actor.dir * speed;
    if (actor.hitWall) { actor.bState = 2; actor.bTimer = pause; actor.vx = 0; }
  } else {
    actor.vx = 0;
    actor.bTimer -= dt;
    if (actor.bTimer <= 0) actor.bState = 0;
  }
  actor.facing = actor.dir;
});

registerBehavior("fly", (world, actor, params, dt) => {
  const mode = params.mode ?? "sine";
  const speed = params.speed ?? 40;
  const amplitude = params.amplitude ?? 24;
  const frequency = params.frequency ?? 0.5;
  const rangeX = params.rangeX ?? 0;
  if (mode === "circle" || mode === "figure8") {
    const angle = TRIG_TAU * frequency * actor.age;
    const targetX = mode === "circle"
      ? actor.homeX + amplitude * cos(angle)
      : actor.homeX + amplitude * sin(angle);
    const targetY = mode === "circle"
      ? actor.homeY + amplitude * sin(angle)
      : actor.homeY + (amplitude / 2) * sin(angle * 2);
    seekAxis(world, actor, "x", targetX, Math.ceil((speed + amplitude * 8) * dt));
    seekAxis(world, actor, "y", targetY, Math.ceil((speed + amplitude * 8) * dt));
    actor.vx = 0;
    return;
  }
  if (actor.hitWall) actor.dir = -actor.dir;
  if (rangeX > 0) {
    if (actor.dir > 0 && actor.x - actor.homeX >= rangeX) actor.dir = -1;
    else if (actor.dir < 0 && actor.homeX - actor.x <= -rangeX) actor.dir = 1;
    else if (actor.dir < 0 && actor.homeX - actor.x >= rangeX) actor.dir = 1;
  }
  actor.vx = actor.dir * speed;
  actor.facing = actor.dir;
  const wave = mode === "zigzag"
    ? triangleWave(frac(actor.age * frequency))
    : sin(TRIG_TAU * frequency * actor.age);
  const targetY = actor.homeY + amplitude * wave;
  seekAxis(world, actor, "y", targetY, Math.ceil((amplitude * 8 + 60) * dt));
});

registerBehavior("hover", (world, actor, params, dt) => {
  const speed = params.speed ?? 60;
  const height = params.height ?? 48;
  const player = nearestPlayer(world, actor);
  if (!player) { actor.vx = 0; return; }
  const targetX = player.x + player.w / 2 - actor.w / 2;
  const targetY = player.y - height;
  seekAxis(world, actor, "x", targetX, Math.ceil(speed * dt));
  seekAxis(world, actor, "y", targetY, Math.ceil(speed * dt));
  actor.vx = 0;
  actor.facing = towardPlayerX(world, actor);
});

registerBehavior("swoop", (world, actor, params, dt) => {
  const range = params.range ?? 120;
  const speed = params.speed ?? 180;
  const rest = params.rest ?? 1.2;
  if (actor.bState === 0) {
    const player = nearestPlayer(world, actor);
    if (player && Math.abs((player.x + player.w / 2) - (actor.x + actor.w / 2)) <= range
      && player.y > actor.y) {
      actor.bTargetX = Math.round(player.x + player.w / 2 - actor.w / 2);
      actor.bTargetY = Math.round(player.y);
      actor.bState = 1;
      world.emit("swoop", { actorId: actor.id });
    }
  } else if (actor.bState === 1) {
    const arrived = seekPoint(world, actor, actor.bTargetX, actor.bTargetY, speed, dt);
    if (arrived || actor.hitWall || actor.grounded) actor.bState = 2;
  } else if (actor.bState === 2) {
    const arrived = seekPoint(world, actor, actor.homeX, actor.homeY, speed * 0.6, dt);
    if (arrived) { actor.bState = 3; actor.bTimer = rest; }
  } else {
    actor.bTimer -= dt;
    if (actor.bTimer <= 0) actor.bState = 0;
  }
});

/** Move straight toward a point; true when within 2px. `core/trig` hypot. */
function seekPoint(world, actor, targetX, targetY, speed, dt) {
  const dx = targetX - actor.x;
  const dy = targetY - actor.y;
  const distance = hypot(dx, dy);
  if (distance <= 2) return true;
  const step = Math.min(speed * dt, distance);
  world.moveX(actor, (dx / distance) * step, { glue: false });
  world.moveY(actor, (dy / distance) * step);
  return false;
}

registerBehavior("path", (world, actor, params, dt) => {
  const speed = params.speed ?? 40;
  const mode = params.mode === "pingpong" ? "pingpong" : "loop";
  const waypoints = Array.isArray(params.waypoints) && params.waypoints.length > 0
    ? params.waypoints
    : [{ x: 0, y: 0 }];
  const target = waypoints[actor.waypoint % waypoints.length];
  const arrived = seekPoint(world, actor, actor.homeX + target.x, actor.homeY + target.y, speed, dt);
  if (arrived) {
    if (mode === "loop") {
      actor.waypoint = (actor.waypoint + 1) % waypoints.length;
    } else if (actor.bState === 0) {
      if (actor.waypoint + 1 >= waypoints.length) { actor.bState = 1; actor.waypoint -= 1; }
      else actor.waypoint += 1;
    } else if (actor.waypoint - 1 < 0) { actor.bState = 0; actor.waypoint += 1; }
    else actor.waypoint -= 1;
    actor.waypoint = Math.max(0, Math.min(actor.waypoint, waypoints.length - 1));
  }
});

registerBehavior("drop", (world, actor, params) => {
  const range = params.range ?? 24;
  if (actor.gravityOn) return;
  const player = nearestPlayer(world, actor);
  if (player && player.y > actor.y
    && Math.abs((player.x + player.w / 2) - (actor.x + actor.w / 2)) <= range) {
    actor.gravityOn = true;
    world.emit("drop", { actorId: actor.id });
  }
});

registerBehavior("riseAndSink", (world, actor, params, dt) => {
  const amplitude = params.amplitude ?? 32;
  const frequency = params.frequency ?? 0.25;
  const targetY = actor.homeY + amplitude * triangleWave(frac(actor.age * frequency));
  seekAxis(world, actor, "y", targetY, Math.ceil((amplitude * 8 + 40) * dt));
});

registerBehavior("bounce", (world, actor, params) => {
  const speed = params.speed ?? 60;
  const power = params.power ?? 260;
  if (actor.hitWall) actor.dir = -actor.dir;
  if (actor.grounded) {
    actor.vy = -power;
    actor.grounded = false;
  }
  actor.vx = actor.dir * speed;
  actor.facing = actor.dir;
});

registerBehavior("roll", (world, actor, params, dt) => {
  const speed = params.speed ?? 70;
  const accel = params.accel ?? 160;
  const takeLadders = params.takeLadders === "always" || params.takeLadders === "alternate"
    ? params.takeLadders
    : "never";
  const field = world.field;
  const ts = field.tileSize;

  // Descending a ladder: hold the column, renew the drop, and resume rolling
  // once the floor below arrives. Without a held state, a rolling barrel
  // crosses a one-tile ladder in a fifth of a second -- faster than gravity
  // can pull it half a pixel -- and no barrel would ever descend anything.
  if (actor.bState === 1) {
    actor.vx = 0;
    actor.dropThrough = Math.max(actor.dropThrough, 0.05);
    const centerTarget = actor.bTargetX;
    if (actor.x !== centerTarget) {
      const step = Math.max(-2, Math.min(2, centerTarget - actor.x));
      world.moveX(actor, step, { glue: false });
    }
    if (actor.grounded && actor.y + actor.h > actor.bTargetY) {
      actor.bState = 0;
      actor.dropThrough = 0;
    }
    return;
  }

  if (actor.hitWall) actor.dir = -actor.dir;
  // Downhill wins: a roller on a slope follows it.
  const footDef = tileDefAt(field, Math.floor((actor.x + actor.w / 2) / ts), Math.floor((actor.y + actor.h) / ts));
  if (actor.grounded && footDef.shape === "slope") {
    actor.dir = footDef.slope.left > footDef.slope.right ? -1 : 1;
  }
  const target = actor.dir * speed;
  actor.vx = actor.vx < target ? Math.min(actor.vx + accel * dt, target) : Math.max(actor.vx - accel * dt, target);
  actor.facing = actor.dir;
  // Ladders: a deterministic policy, never a coin flip.
  actor.bTimer = Math.max(0, actor.bTimer - dt);
  if (takeLadders !== "never" && actor.grounded && actor.bTimer <= 0) {
    const col = Math.floor((actor.x + actor.w / 2) / ts);
    const row = Math.floor((actor.y + actor.h) / ts);
    if (tileDefAt(field, col, row).shape === "ladder" && tileDefAt(field, col, row - 1).shape !== "ladder") {
      actor.bTimer = 0.6;
      const take = takeLadders === "always" || (actor.waypoint = 1 - actor.waypoint) === 1;
      if (take) {
        actor.bState = 1;
        actor.bTargetX = col * ts + ((ts - actor.w) >> 1);
        actor.bTargetY = actor.y + actor.h + 2;
        actor.dropThrough = 0.2;
        actor.grounded = false;
        actor.vx = 0;
      }
    }
  }
});

registerBehavior("burrow", (world, actor, params) => {
  const period = params.period ?? 2.4;
  const duty = params.duty ?? 0.5;
  const hidden = frac(actor.age / period) >= duty;
  if (hidden !== actor.hidden) {
    actor.hidden = hidden;
    world.emit(hidden ? "burrow-down" : "burrow-up", { actorId: actor.id });
  }
  actor.vx = 0;
});

registerBehavior("spawner", (world, actor, params, dt) => {
  if (!runNJumpCanFire(world, actor, world.defOf(actor.defId))) return;
  const interval = params.interval ?? 2.5;
  const limit = params.limit ?? 3;
  const defId = typeof params.defId === "string" && params.defId ? params.defId : "walker";
  actor.vx = 0;
  actor.bTimer -= dt;
  if (actor.bTimer > 0) return;
  actor.bTimer = interval;
  let children = 0;
  for (const other of world.state.actors) {
    if (other.alive && other.spawnedBy === actor.id) children += 1;
  }
  if (children >= limit) return;
  const child = world.spawnActor(defId, actor.x + (params.dx ?? 0), actor.y + (params.dy ?? 0), params.dir === 1 ? 1 : -1);
  if (child) {
    child.spawnedBy = actor.id;
    child.vx = params.vx ?? 0;
    child.vy = params.vy ?? 0;
    world.emit("spawned", { actorId: actor.id, childId: child.id });
  }
});

registerBehavior("turret", (world, actor, params, dt) => {
  if (!runNJumpCanFire(world, actor, world.defOf(actor.defId))) return;
  const interval = params.interval ?? 1.6;
  const speed = params.speed ?? 160;
  const defId = typeof params.defId === "string" && params.defId ? params.defId : "enemy-shot";
  actor.vx = 0;
  actor.bTimer -= dt;
  if (actor.bTimer > 0) return;
  actor.bTimer = interval;
  const player = nearestPlayer(world, actor);
  if (!player) return;
  const weapon = world.defOf(actor.defId)?.weapon;
  const facing = runNJumpActorAim(actor);
  const muzzle = runNJumpMuzzle({x:actor.x+actor.w/2,y:actor.y+actor.h/2}, facing, weapon?.mount);
  const shot = world.spawnActor(defId, muzzle.x - 3, muzzle.y - 3, actor.facing);
  if (!shot) return;
  shot.spawnedBy = actor.id;
  if (weapon?.direction === "facing") {
    shot.vx = facing.x * speed; shot.vy = facing.y * speed;
  } else if (params.aim === false) {
    shot.vx = actor.facing * speed;
    shot.vy = 0;
  } else {
    const dx = (player.x + player.w / 2) - (actor.x + actor.w / 2);
    const dy = (player.y + player.h / 2) - (actor.y + actor.h / 2);
    const distance = hypot(dx, dy) || 1;
    shot.vx = (dx / distance) * speed;
    shot.vy = (dy / distance) * speed;
  }
  world.emit("shot", { actorId: actor.id });
});

registerBehavior("thrower", (world, actor, params, dt) => {
  if (!runNJumpCanFire(world, actor, world.defOf(actor.defId))) return;
  const interval = params.interval ?? 2.2;
  const power = params.power ?? 260;
  const speed = params.speed ?? 90;
  const defId = typeof params.defId === "string" && params.defId ? params.defId : "enemy-lob";
  actor.vx = 0;
  actor.bTimer -= dt;
  if (actor.bTimer > 0) return;
  actor.bTimer = interval;
  const weapon = world.defOf(actor.defId)?.weapon;
  if (weapon?.direction !== "facing") { actor.dir = towardPlayerX(world, actor); actor.facing = actor.dir; }
  const facing = runNJumpActorAim(actor);
  const muzzle = weapon?.mount ? runNJumpMuzzle({x:actor.x+actor.w/2,y:actor.y+actor.h/2}, facing, weapon.mount) : null;
  const lob = world.spawnActor(defId, muzzle ? muzzle.x-4 : actor.x + actor.w / 2 - 4, muzzle ? muzzle.y-4 : actor.y - 6, actor.dir);
  if (lob) {
    lob.spawnedBy = actor.id;
    lob.vx = weapon?.direction === "facing" ? facing.x*speed : actor.dir * speed;
    lob.vy = weapon?.direction === "facing" ? facing.y*speed : -power;
    world.emit("shot", { actorId: actor.id });
  }
});

registerBehavior("carrier", (world, actor, params, dt) => {
  const speed = params.speed ?? 50;
  const rangeX = params.rangeX ?? 96;
  const interval = params.interval ?? 1.8;
  const defId = typeof params.defId === "string" && params.defId ? params.defId : "enemy-lob";
  if (actor.hitWall) actor.dir = -actor.dir;
  if (actor.dir > 0 && actor.x - actor.homeX >= rangeX) actor.dir = -1;
  else if (actor.dir < 0 && actor.homeX - actor.x >= rangeX) actor.dir = 1;
  actor.vx = actor.dir * speed;
  actor.facing = actor.dir;
  actor.bTimer -= dt;
  if (actor.bTimer > 0) return;
  const player = nearestPlayer(world, actor);
  if (player && Math.abs((player.x + player.w / 2) - (actor.x + actor.w / 2)) <= 12) {
    actor.bTimer = interval;
    const bomb = world.spawnActor(defId, actor.x + actor.w / 2 - 4, actor.y + actor.h + 2, actor.dir);
    if (bomb) {
      bomb.spawnedBy = actor.id;
      bomb.vy = 40;
      world.emit("dropped", { actorId: actor.id });
    }
  }
});

/** Is any player standing on this actor right now? */
function riddenByPlayer(world, actor) {
  for (const player of world.state.players) {
    if (!player.alive) continue;
    if (player.y + player.h === actor.y
      && player.x < actor.x + actor.w && actor.x < player.x + player.w) return true;
  }
  return false;
}

registerBehavior("falling", (world, actor, params, dt) => {
  const delay = params.delay ?? 0.4;
  if (actor.bState === 0) {
    if (riddenByPlayer(world, actor)) { actor.bState = 1; actor.bTimer = delay; }
  } else if (actor.bState === 1) {
    actor.bTimer -= dt;
    if (actor.bTimer <= 0) {
      actor.bState = 2;
      actor.gravityOn = true;
      world.emit("platform-fall", { actorId: actor.id });
    }
  }
});

registerBehavior("crumble", (world, actor, params, dt) => {
  const delay = params.delay ?? 0.5;
  const respawn = params.respawn ?? 2.5;
  if (actor.bState === 0) {
    if (riddenByPlayer(world, actor)) { actor.bState = 1; actor.bTimer = delay; }
  } else if (actor.bState === 1) {
    actor.bTimer -= dt;
    if (actor.bTimer <= 0) {
      actor.bState = 2;
      actor.bTimer = respawn;
      actor.hidden = true;
      world.emit("crumble", { actorId: actor.id });
    }
  } else {
    actor.bTimer -= dt;
    if (actor.bTimer <= 0) {
      actor.bState = 0;
      actor.hidden = false;
      world.emit("crumble-back", { actorId: actor.id });
    }
  }
});

registerBehavior("slide", (world, actor, params) => {
  const speed = params.speed ?? 180;
  if (actor.vx !== 0) {
    if (actor.hitWall) actor.dir = -actor.dir;
    actor.vx = actor.dir * speed;
    actor.facing = actor.dir;
  }
});

registerBehavior("shot", (world, actor, params, dt) => {
  // Straight-line projectile: velocity was set at spawn; dies on any contact
  // or when its time is up. `ttl` param in seconds.
  const ttl = params.ttl ?? 3;
  if (actor.age >= ttl || actor.hitWall || (actor.grounded && actor.vy === 0 && params.bounces !== true)) {
    actor.alive = false;
    world.emit("shot-break", { actorId: actor.id, x: actor.x, y: actor.y });
  }
});
