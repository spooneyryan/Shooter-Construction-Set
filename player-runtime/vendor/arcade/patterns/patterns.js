// Bullet patterns: the modulated-emitter engine behind the bullet-hell
// designer. Arrays of bullets in fans and rings, spun, oscillated and
// automated over time — the description of WHAT to fire, and the arithmetic
// that turns one elapsed step into the projectiles it spawns.
//
// Ported from Starline's app/bullet-pattern-engine.ts, which was written to
// leave: no React, no DOM, no canvas, no storage, and a host contract of one
// small context object (origin, optional aim target, facing, projectile
// budget). That is what lets the same module drive enemies, player weapons,
// satellites, an authoring preview and a docs-site demo without forking the
// simulation rules.
//
// Trigonometry comes from core/trig, not Math -- the engines-differ argument
// that moved the rest of this package off Math.sin applies with interest to
// a module whose whole job is trigonometry at scale. Math.random appears
// only inside id factories, which run at authoring time; nothing on the
// advance path draws on randomness or the clock.
//
// Drawing is not here, in the package whose header says drawing will never
// be: a PatternProjectile carries colour, radius and a sprite NAME, and what
// those look like is the renderer's business.

import { atan2, cos, hypot, sin } from "../core/trig.js";
import { uniqueId } from "../core/validate.js";

/** @typedef {"sine" | "triangle" | "saw" | "square"} PatternWaveform */
/** @typedef {"fixed" | "aimed" | "radial"} PatternAimMode */
/** @typedef {"none" | "horizontal" | "vertical"} PatternScrollMode */
/** @typedef {"none" | "square" | "heart" | "triangle"} PatternMarkerStyle */
/** @typedef {"none" | "circle" | "star" | "heart"} SecondaryShape */
/** @typedef {"overlay" | "replace"} SecondaryMode */
/** @typedef {"angle" | "fireRate" | "individualSpread" | "totalSpread" | "bulletSpeed" | "bulletSize" | "arrayDistance" | "x" | "y"} PatternTarget */
/** @typedef {Exclude<PatternTarget, "angle"> | "bulletsPerArray" | "totalArrays"} AutomatablePatternTarget */

/**
 * @typedef {object} PatternAutomation
 * @property {boolean} enabled
 * @property {number} min
 * @property {number} max
 * @property {number} speed Cycles per second.
 * @property {number} phase Degrees.
 * @property {PatternWaveform} waveform
 */

/**
 * @typedef {object} PatternOscillator
 * @property {string} id
 * @property {string} name
 * @property {boolean} enabled
 * @property {PatternTarget} target
 * @property {PatternWaveform} waveform
 * @property {number} amplitude
 * @property {number} period Seconds per cycle.
 * @property {number} phase Degrees.
 * @property {1 | -1} direction
 */

/**
 * @typedef {object} PatternMarker
 * @property {PatternMarkerStyle} style
 * @property {string} color
 * @property {number} size
 * @property {number} alpha
 * @property {boolean} showIdentifier
 */

/**
 * @typedef {object} SecondaryPattern
 * @property {boolean} enabled
 * @property {SecondaryMode} mode
 * @property {SecondaryShape} shape
 * @property {number} fireRate
 * @property {number} density
 * @property {number} baseAngle
 * @property {number} spin
 * @property {boolean} twirl
 * @property {number} speed
 * @property {number} size
 * @property {string} color
 * @property {number} power
 * @property {number} acceleration
 * @property {number} lifetime
 */

/**
 * @typedef {object} BulletPatternSpawn
 * @property {string} id
 * @property {string} name
 * @property {boolean} enabled
 * @property {number} x
 * @property {number} y
 * @property {PatternAimMode} aimMode
 * @property {number} baseAngle
 * @property {number} bulletsPerArray
 * @property {number} totalArrays
 * @property {number} individualSpread
 * @property {number} totalArraySpread
 * @property {number} arrayDistance
 * @property {number} fireRate
 * @property {number} bulletSpeed
 * @property {number} bulletSize
 * @property {number} bulletPower
 * @property {number} bulletAcceleration
 * @property {number} bulletLifetime
 * @property {"bolt" | "plasma"} bulletSprite
 * @property {number} spinSpeed
 * @property {number} spinAccelerationForward
 * @property {number} spinAccelerationReverse
 * @property {number} maxSpinSpeed
 * @property {boolean} reverseAtLimit
 * @property {PatternOscillator[]} oscillators
 * @property {Partial<Record<AutomatablePatternTarget, PatternAutomation>>} automations
 * @property {string[]} arrayColors
 * @property {boolean} perArraySizesEnabled
 * @property {number[]} arraySizes
 * @property {boolean} perArraySpeedsEnabled
 * @property {number[]} arraySpeeds
 * @property {PatternMarker} marker
 * @property {SecondaryPattern} secondary
 */

/**
 * @typedef {object} BulletPatternDefinition
 * @property {1} version
 * @property {string} id
 * @property {string} name
 * @property {number} seed
 * @property {number} projectileCap
 * @property {{width: number, height: number, background: string, margin: string, scroll: PatternScrollMode, stars: boolean}} playfield
 * @property {BulletPatternSpawn[]} spawns
 */

/**
 * @typedef {object} PatternProjectile
 * @property {number} x
 * @property {number} y
 * @property {number} vx
 * @property {number} vy
 * @property {number} acceleration
 * @property {number} radius
 * @property {number} power
 * @property {string} color
 * @property {"bolt" | "plasma"} sprite
 * @property {number} age
 * @property {number} lifetime
 * @property {number} angularVelocity
 * @property {string} emitterId
 */

/**
 * @typedef {object} SpawnRuntime
 * @property {number} primaryAccumulator
 * @property {number} secondaryAccumulator
 * @property {number} spinAngle
 * @property {number} spinVelocity
 * @property {1 | -1} spinDirection
 * @property {number} sequence
 */

/**
 * @typedef {object} BulletPatternRuntime
 * @property {number} time
 * @property {number} dropped
 * @property {Record<string, SpawnRuntime>} spawns
 */

/**
 * @typedef {object} PatternEmitterContext
 * @property {{x: number, y: number}} origin
 * @property {{x: number, y: number}} [target]
 * @property {number} [rotation] Degrees the whole pattern is facing.
 * @property {number} [scale]
 * @property {number} [maxProjectiles]
 * @property {number} [currentProjectiles]
 */

/**
 * @typedef {object} PatternEstimate
 * @property {number} bulletsPerSecond
 * @property {number} maximumConcurrent
 * @property {string | null} warning
 */

const TAU = Math.PI * 2;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const deg = (value) => value * Math.PI / 180;

/**
 * One cycle of a waveform, -1..1.
 * @param {PatternWaveform} waveform
 * @param {number} phase Radians.
 */
export function waveformValue(waveform, phase) {
  const cycle = ((phase / TAU) % 1 + 1) % 1;
  if (waveform === "triangle") return 1 - 4 * Math.abs(cycle - .5);
  if (waveform === "saw") return cycle * 2 - 1;
  if (waveform === "square") return cycle < .5 ? 1 : -1;
  return sin(phase);
}

/**
 * @param {number} min
 * @param {number} max
 * @returns {PatternAutomation}
 */
export function createAutomation(min, max) {
  return { enabled: false, min, max, speed: 1, phase: 0, waveform: "sine" };
}

/**
 * @param {number} [index]
 * @param {() => string} [makeId]
 * @returns {PatternOscillator}
 */
export function createOscillator(index = 0, makeId = () => uniqueId("osc")) {
  return {
    id: makeId(),
    name: `Oscillator ${index + 1}`,
    enabled: true,
    target: "angle",
    waveform: "sine",
    amplitude: index === 0 ? 55 : 18,
    period: index === 0 ? 2.4 : 1.1,
    phase: index * 90,
    direction: 1,
  };
}

/**
 * @param {number} [index]
 * @param {number} [width]
 * @param {number} [height]
 * @param {() => string} [makeId]
 * @returns {BulletPatternSpawn}
 */
export function createDefaultSpawn(index = 0, width = 960, height = 540, makeId = () => uniqueId("spawn")) {
  return {
    id: makeId(),
    name: `Emitter ${index + 1}`,
    enabled: index === 0,
    x: width / 2,
    y: height / 2,
    aimMode: "fixed",
    baseAngle: 0,
    bulletsPerArray: 3,
    totalArrays: 1,
    individualSpread: 22,
    totalArraySpread: 0,
    arrayDistance: 0,
    fireRate: 5,
    bulletSpeed: 210,
    bulletSize: 5,
    bulletPower: 1,
    bulletAcceleration: 0,
    bulletLifetime: 8,
    bulletSprite: "bolt",
    spinSpeed: 0,
    spinAccelerationForward: 0,
    spinAccelerationReverse: 0,
    maxSpinSpeed: 45,
    reverseAtLimit: false,
    oscillators: [createOscillator(0, makeId)],
    automations: {
      x: createAutomation(0, width),
      y: createAutomation(0, height),
      bulletsPerArray: createAutomation(1, 20),
      totalArrays: createAutomation(1, 10),
      individualSpread: createAutomation(0, 360),
      totalSpread: createAutomation(-360, 360),
      arrayDistance: createAutomation(0, 200),
      fireRate: createAutomation(.1, 30),
      bulletSpeed: createAutomation(40, 700),
      bulletSize: createAutomation(1, 24),
    },
    arrayColors: ["#ff5f77"],
    perArraySizesEnabled: false,
    arraySizes: [5],
    perArraySpeedsEnabled: false,
    arraySpeeds: [210],
    marker: { style: "heart", color: "#ff365e", size: 24, alpha: .9, showIdentifier: true },
    secondary: {
      enabled: false,
      mode: "overlay",
      shape: "circle",
      fireRate: 1,
      density: 48,
      baseAngle: 0,
      spin: 24,
      twirl: false,
      speed: 150,
      size: 4,
      color: "#8a62ff",
      power: 1,
      acceleration: 0,
      lifetime: 8,
    },
  };
}

/**
 * @param {string} [name]
 * @param {() => string} [makeId]
 * @returns {BulletPatternDefinition}
 */
export function createDefaultBulletPattern(name = "Pendulum Sweep", makeId = undefined) {
  const playfield = { width: 960, height: 540, background: "#030914", margin: "#111b2b", scroll: /** @type {const} */ ("horizontal"), stars: true };
  return {
    version: 1,
    id: makeId ? makeId() : uniqueId("pattern"),
    name,
    seed: 1337,
    projectileCap: 1800,
    playfield,
    spawns: [createDefaultSpawn(0, playfield.width, playfield.height, makeId)],
  };
}

export const PATTERN_PRESETS = /** @type {const} */ ([
  "Pendulum Sweep",
  "Layered Flower",
  "Spiral",
  "Reverse Spiral",
  "Rotating Ring",
  "Flower Burst",
  "Streaming Waves",
  "Aimed Fan",
  "Alternating Wave",
]);

/** @typedef {typeof PATTERN_PRESETS[number]} PatternPresetName */

/**
 * A named starter pattern. Unknown names return the default.
 * @param {PatternPresetName} name
 * @param {() => string} [makeId]
 * @returns {BulletPatternDefinition}
 */
export function createPatternPreset(name, makeId = undefined) {
  const pattern = createDefaultBulletPattern(name, makeId);
  const spawn = pattern.spawns[0];
  if (name === "Layered Flower") {
    spawn.baseAngle = 0; spawn.aimMode = "radial"; spawn.bulletsPerArray = 5; spawn.totalArrays = 6; spawn.individualSpread = 18; spawn.totalArraySpread = 300; spawn.fireRate = 2.2; spawn.spinSpeed = 9;
    spawn.oscillators = [{ ...createOscillator(0, makeId), amplitude: 28, period: 2.8 }, { ...createOscillator(1, makeId), amplitude: 11, period: .92, direction: -1 }];
    spawn.arrayColors = ["#ff5f77", "#ffb34f", "#f3ff6a", "#58e7ff", "#8b71ff", "#f16bff"];
  } else if (name === "Spiral" || name === "Reverse Spiral") {
    spawn.baseAngle = 0; spawn.bulletsPerArray = 1; spawn.totalArrays = 3; spawn.totalArraySpread = 240; spawn.fireRate = 12; spawn.spinSpeed = name === "Spiral" ? 13 : -13; spawn.maxSpinSpeed = 60; spawn.oscillators = [];
  } else if (name === "Rotating Ring") {
    spawn.baseAngle = 0; spawn.bulletsPerArray = 1; spawn.totalArrays = 14; spawn.totalArraySpread = 334; spawn.fireRate = 2; spawn.spinSpeed = 7; spawn.arrayDistance = 20; spawn.oscillators = [];
  } else if (name === "Flower Burst") {
    spawn.bulletsPerArray = 1; spawn.totalArrays = 1; spawn.fireRate = 1; spawn.oscillators = [];
    spawn.secondary = { ...spawn.secondary, enabled: true, mode: "replace", shape: "star", density: 90, fireRate: 1.1, spin: 19, twirl: true, color: "#ff6bd6" };
  } else if (name === "Streaming Waves") {
    // baseAngle 0, not 180. Preset angles are facing-relative — the emitter's
    // `rotation` supplies the facing, so 0 means "forward" for whoever fires
    // it. The 180 this carried from the pre-rotation engine (where angles
    // were screen-absolute and 180 meant "at the player") survived the port
    // and fired the whole pattern backward: off the tail of a player ship,
    // and away from the player from an enemy. Found by Ryan, 2026-08-18.
    spawn.baseAngle = 0; spawn.bulletsPerArray = 8; spawn.individualSpread = 44; spawn.fireRate = 7; spawn.oscillators = [{ ...createOscillator(0, makeId), amplitude: 38, period: 3.2 }, { ...createOscillator(1, makeId), target: "bulletSpeed", amplitude: 65, period: 1.6 }];
  } else if (name === "Aimed Fan") {
    spawn.aimMode = "aimed"; spawn.baseAngle = 0; spawn.bulletsPerArray = 7; spawn.individualSpread = 52; spawn.fireRate = 2.6; spawn.oscillators = [];
  } else if (name === "Alternating Wave") {
    spawn.bulletsPerArray = 2; spawn.individualSpread = 18; spawn.fireRate = 8; spawn.oscillators = [{ ...createOscillator(0, makeId), waveform: "square", amplitude: 42, period: .8 }, { ...createOscillator(1, makeId), amplitude: 16, period: 3.6, direction: -1 }];
  }
  return pattern;
}

/**
 * Fresh transient state for a run of this pattern. Definitions are documents;
 * everything that accumulates lives here.
 * @param {BulletPatternDefinition} pattern
 * @returns {BulletPatternRuntime}
 */
export function createBulletPatternRuntime(pattern) {
  return {
    time: 0,
    dropped: 0,
    spawns: Object.fromEntries(pattern.spawns.map((spawn) => [spawn.id, {
      primaryAccumulator: 0,
      secondaryAccumulator: 0,
      spinAngle: 0,
      spinVelocity: spawn.spinSpeed,
      spinDirection: spawn.spinSpeed < 0 ? -1 : 1,
      sequence: 0,
    }])),
  };
}

/**
 * @param {BulletPatternRuntime} runtime
 * @param {BulletPatternSpawn} spawn
 * @returns {SpawnRuntime}
 */
function ensureSpawnRuntime(runtime, spawn) {
  return runtime.spawns[spawn.id] ?? (runtime.spawns[spawn.id] = {
    primaryAccumulator: 0,
    secondaryAccumulator: 0,
    spinAngle: 0,
    spinVelocity: spawn.spinSpeed,
    spinDirection: spawn.spinSpeed < 0 ? -1 : 1,
    sequence: 0,
  });
}

/**
 * @param {number} base
 * @param {PatternAutomation | undefined} automation
 * @param {number} time
 */
function automationValue(base, automation, time) {
  if (!automation?.enabled) return base;
  const middle = (automation.min + automation.max) / 2;
  const amplitude = (automation.max - automation.min) / 2;
  return middle + amplitude * waveformValue(automation.waveform, TAU * automation.speed * time + deg(automation.phase));
}

/**
 * A parameter's value at `time`: base, through its automation, plus every
 * enabled oscillator aimed at it. This one function is the designer's whole
 * theory of motion.
 * @param {BulletPatternSpawn} spawn
 * @param {PatternTarget} target
 * @param {number} base
 * @param {number} time
 */
function modulatedValue(spawn, target, base, time) {
  const automation = spawn.automations[/** @type {AutomatablePatternTarget} */ (target)];
  const automated = automationValue(base, automation, time);
  return spawn.oscillators.reduce((value, oscillator) => {
    if (!oscillator.enabled || oscillator.target !== target) return value;
    const period = Math.max(.01, oscillator.period);
    const phase = TAU * time / period * oscillator.direction + deg(oscillator.phase);
    return value + oscillator.amplitude * waveformValue(oscillator.waveform, phase);
  }, automated);
}

/**
 * @param {BulletPatternDefinition} pattern
 * @param {BulletPatternSpawn} spawn
 * @param {PatternEmitterContext} context
 * @param {number} time
 */
function spawnPoint(pattern, spawn, context, time) {
  const scale = context.scale ?? 1;
  const x = modulatedValue(spawn, "x", spawn.x, time) - pattern.playfield.width / 2;
  const y = modulatedValue(spawn, "y", spawn.y, time) - pattern.playfield.height / 2;
  const rotation = deg(context.rotation ?? 0);
  return {
    x: context.origin.x + (x * cos(rotation) - y * sin(rotation)) * scale,
    y: context.origin.y + (x * sin(rotation) + y * cos(rotation)) * scale,
  };
}

/**
 * @param {BulletPatternSpawn} spawn
 * @param {{x: number, y: number}} point
 * @param {PatternEmitterContext} context
 */
function baseAimAngle(spawn, point, context) {
  if (spawn.aimMode === "aimed" && context.target) return atan2(context.target.y - point.y, context.target.x - point.x) * 180 / Math.PI + spawn.baseAngle;
  return spawn.baseAngle + (context.rotation ?? 0);
}

/**
 * @param {PatternProjectile[]} output
 * @param {BulletPatternRuntime} runtime
 * @param {BulletPatternDefinition} pattern
 * @param {PatternEmitterContext} context
 * @param {PatternProjectile} projectile
 */
function appendProjectile(output, runtime, pattern, context, projectile) {
  const limit = Math.min(pattern.projectileCap, context.maxProjectiles ?? pattern.projectileCap);
  const occupied = (context.currentProjectiles ?? 0) + output.length;
  if (occupied >= limit) { runtime.dropped += 1; return; }
  output.push(projectile);
}

/**
 * @param {PatternProjectile[]} output
 * @param {BulletPatternRuntime} runtime
 * @param {BulletPatternDefinition} pattern
 * @param {BulletPatternSpawn} spawn
 * @param {SpawnRuntime} state
 * @param {PatternEmitterContext} context
 */
function emitPrimary(output, runtime, pattern, spawn, state, context) {
  const time = runtime.time;
  const point = spawnPoint(pattern, spawn, context, time);
  const angleMod = modulatedValue(spawn, "angle", 0, time);
  const arrays = clamp(Math.round(automationValue(spawn.totalArrays, spawn.automations.totalArrays, time)), 1, 32);
  const bullets = clamp(Math.round(automationValue(spawn.bulletsPerArray, spawn.automations.bulletsPerArray, time)), 1, 64);
  const totalSpread = modulatedValue(spawn, "totalSpread", spawn.aimMode === "radial" ? 360 - 360 / arrays : spawn.totalArraySpread, time);
  const individualSpread = modulatedValue(spawn, "individualSpread", spawn.individualSpread, time);
  const base = baseAimAngle(spawn, point, context) + angleMod + state.spinAngle;
  const distance = Math.max(0, modulatedValue(spawn, "arrayDistance", spawn.arrayDistance, time));
  const baseSpeed = Math.max(1, modulatedValue(spawn, "bulletSpeed", spawn.bulletSpeed, time));
  const baseSize = Math.max(.5, modulatedValue(spawn, "bulletSize", spawn.bulletSize, time));

  for (let arrayIndex = 0; arrayIndex < arrays; arrayIndex += 1) {
    const arrayOffset = arrays === 1 ? 0 : (arrayIndex - (arrays - 1) / 2) * totalSpread / Math.max(1, arrays - (spawn.aimMode === "radial" ? 0 : 1));
    const arrayAngle = base + arrayOffset;
    const color = spawn.arrayColors[arrayIndex % Math.max(1, spawn.arrayColors.length)] ?? "#ffffff";
    const speed = spawn.perArraySpeedsEnabled ? spawn.arraySpeeds[arrayIndex % Math.max(1, spawn.arraySpeeds.length)] ?? baseSpeed : baseSpeed;
    const size = spawn.perArraySizesEnabled ? spawn.arraySizes[arrayIndex % Math.max(1, spawn.arraySizes.length)] ?? baseSize : baseSize;
    const startX = point.x + cos(deg(arrayAngle)) * distance;
    const startY = point.y + sin(deg(arrayAngle)) * distance;
    for (let bulletIndex = 0; bulletIndex < bullets; bulletIndex += 1) {
      const offset = bullets === 1 ? 0 : (bulletIndex - (bullets - 1) / 2) * individualSpread / Math.max(1, bullets - 1);
      const angle = deg(arrayAngle + offset);
      appendProjectile(output, runtime, pattern, context, {
        x: startX, y: startY,
        vx: cos(angle) * speed,
        vy: sin(angle) * speed,
        acceleration: spawn.bulletAcceleration,
        radius: size,
        power: spawn.bulletPower,
        color,
        sprite: spawn.bulletSprite,
        age: 0,
        lifetime: spawn.bulletLifetime,
        angularVelocity: 0,
        emitterId: spawn.id,
      });
    }
  }

  state.sequence += 1;
  state.spinAngle += state.spinVelocity;
  if (spawn.reverseAtLimit && spawn.maxSpinSpeed > 0) {
    if (state.spinVelocity >= spawn.maxSpinSpeed) state.spinDirection = -1;
    if (state.spinVelocity <= -spawn.maxSpinSpeed) state.spinDirection = 1;
  }
  const acceleration = state.spinDirection > 0 ? spawn.spinAccelerationForward : spawn.spinAccelerationReverse;
  state.spinVelocity = clamp(state.spinVelocity + acceleration, -Math.abs(spawn.maxSpinSpeed), Math.abs(spawn.maxSpinSpeed));
}

/**
 * A point on the unit outline of a secondary burst shape.
 * @param {SecondaryShape} shape
 * @param {number} index
 * @param {number} count
 */
function shapeVector(shape, index, count) {
  const angle = index / count * TAU;
  if (shape === "heart") {
    const x = 16 * sin(angle) ** 3 / 17;
    const y = -(13 * cos(angle) - 5 * cos(2 * angle) - 2 * cos(3 * angle) - cos(4 * angle)) / 17;
    return { x, y };
  }
  if (shape === "star") {
    const radius = .42 + .58 * (.5 + .5 * cos(angle * 5));
    return { x: cos(angle) * radius, y: sin(angle) * radius };
  }
  return { x: cos(angle), y: sin(angle) };
}

/**
 * @param {PatternProjectile[]} output
 * @param {BulletPatternRuntime} runtime
 * @param {BulletPatternDefinition} pattern
 * @param {BulletPatternSpawn} spawn
 * @param {PatternEmitterContext} context
 */
function emitSecondary(output, runtime, pattern, spawn, context) {
  const secondary = spawn.secondary;
  if (!secondary.enabled || secondary.shape === "none") return;
  const point = spawnPoint(pattern, spawn, context, runtime.time);
  const count = clamp(Math.round(secondary.density), 8, 512);
  const orientation = secondary.baseAngle + secondary.spin * runtime.time + (context.rotation ?? 0);
  const rotation = deg(orientation);
  for (let index = 0; index < count; index += 1) {
    const vector = shapeVector(secondary.shape, index, count);
    const vx = (vector.x * cos(rotation) - vector.y * sin(rotation)) * secondary.speed;
    const vy = (vector.x * sin(rotation) + vector.y * cos(rotation)) * secondary.speed;
    appendProjectile(output, runtime, pattern, context, {
      x: point.x, y: point.y, vx, vy,
      acceleration: secondary.acceleration,
      radius: secondary.size,
      power: secondary.power,
      color: secondary.color,
      sprite: spawn.bulletSprite,
      age: 0,
      lifetime: secondary.lifetime,
      angularVelocity: secondary.twirl ? secondary.spin : 0,
      emitterId: spawn.id,
    });
  }
}

/**
 * Advance the emitters by `dt` seconds and return what they fired. The
 * caller owns the projectile list; this only ever appends to a fresh array,
 * so one pattern can feed many independent hosts.
 * @param {BulletPatternRuntime} runtime
 * @param {BulletPatternDefinition} pattern
 * @param {number} dt
 * @param {PatternEmitterContext} context
 * @returns {PatternProjectile[]}
 */
export function advanceBulletPattern(runtime, pattern, dt, context) {
  /** @type {PatternProjectile[]} */
  const output = [];
  const safeDt = clamp(dt, 0, .1);
  runtime.time += safeDt;
  for (const spawn of pattern.spawns) {
    if (!spawn.enabled) continue;
    const state = ensureSpawnRuntime(runtime, spawn);
    const fireRate = Math.max(0, modulatedValue(spawn, "fireRate", spawn.fireRate, runtime.time));
    state.primaryAccumulator += safeDt * fireRate;
    state.secondaryAccumulator += safeDt * Math.max(.01, spawn.secondary.fireRate);
    const primaryEnabled = !spawn.secondary.enabled || spawn.secondary.mode !== "replace";
    let guard = 0;
    while (primaryEnabled && state.primaryAccumulator >= 1 && guard < 12) {
      state.primaryAccumulator -= 1;
      emitPrimary(output, runtime, pattern, spawn, state, context);
      guard += 1;
    }
    guard = 0;
    while (spawn.secondary.enabled && state.secondaryAccumulator >= 1 && guard < 4) {
      state.secondaryAccumulator -= 1;
      emitSecondary(output, runtime, pattern, spawn, context);
      guard += 1;
    }
  }
  return output;
}

/**
 * Advance projectile motion: twirl, acceleration along the velocity, ageing,
 * and removal by lifetime or bounds. Returns the surviving list.
 * @template {PatternProjectile} T
 * @param {T[]} projectiles
 * @param {number} dt
 * @param {{width: number, height: number, margin?: number}} [bounds]
 * @returns {T[]}
 */
export function advancePatternProjectiles(projectiles, dt, bounds) {
  const safeDt = clamp(dt, 0, .1);
  const margin = bounds?.margin ?? 180;
  for (const projectile of projectiles) {
    if (projectile.angularVelocity) {
      const rotation = deg(projectile.angularVelocity * safeDt);
      const vx = projectile.vx * cos(rotation) - projectile.vy * sin(rotation);
      projectile.vy = projectile.vx * sin(rotation) + projectile.vy * cos(rotation);
      projectile.vx = vx;
    }
    const speed = hypot(projectile.vx, projectile.vy);
    if (speed > .001 && projectile.acceleration) {
      projectile.vx += projectile.vx / speed * projectile.acceleration * safeDt;
      projectile.vy += projectile.vy / speed * projectile.acceleration * safeDt;
    }
    projectile.x += projectile.vx * safeDt;
    projectile.y += projectile.vy * safeDt;
    projectile.age += safeDt;
  }
  return projectiles.filter((projectile) => projectile.age <= projectile.lifetime && (!bounds || (
    projectile.x >= -margin && projectile.x <= bounds.width + margin && projectile.y >= -margin && projectile.y <= bounds.height + margin
  )));
}

/**
 * Expected density, for authoring warnings before a pattern reaches a game.
 * @param {BulletPatternDefinition} pattern
 * @returns {PatternEstimate}
 */
export function estimateBulletPattern(pattern) {
  let bulletsPerSecond = 0;
  let maximumConcurrent = 0;
  for (const spawn of pattern.spawns) {
    if (!spawn.enabled) continue;
    const primary = spawn.secondary.enabled && spawn.secondary.mode === "replace" ? 0 : spawn.fireRate * spawn.bulletsPerArray * spawn.totalArrays;
    const secondary = spawn.secondary.enabled ? spawn.secondary.fireRate * spawn.secondary.density : 0;
    bulletsPerSecond += primary + secondary;
    maximumConcurrent += primary * spawn.bulletLifetime + secondary * spawn.secondary.lifetime;
  }
  maximumConcurrent = Math.min(pattern.projectileCap, Math.ceil(maximumConcurrent));
  const warning = bulletsPerSecond > 2500 ? "Extreme density may obscure the player and stress slower devices."
    : bulletsPerSecond > 900 ? "High density: play-test readability and performance."
      : null;
  return { bulletsPerSecond, maximumConcurrent, warning };
}

/**
 * Validate imported or older pattern data into the current shape. The same
 * stance as normalizeLevel: clamp, never throw, and an unrecognizable input
 * comes back as the default pattern.
 * @param {Partial<BulletPatternDefinition> | undefined} input
 * @returns {BulletPatternDefinition}
 */
export function normalizeBulletPattern(input) {
  const fallback = createDefaultBulletPattern();
  if (!input || input.version !== 1) return fallback;
  const width = clamp(Number(input.playfield?.width) || fallback.playfield.width, 320, 1920);
  const height = clamp(Number(input.playfield?.height) || fallback.playfield.height, 240, 1080);
  const spawns = (Array.isArray(input.spawns) ? input.spawns : []).slice(0, 6).map((incoming, index) => {
    const base = createDefaultSpawn(index, width, height);
    const spawn = /** @type {BulletPatternSpawn} */ ({ ...base, ...incoming });
    spawn.id = String(incoming.id || base.id);
    spawn.name = String(incoming.name || base.name).slice(0, 80);
    spawn.oscillators = (Array.isArray(incoming.oscillators) ? incoming.oscillators : base.oscillators).slice(0, 12).map((oscillator, oscillatorIndex) => ({ ...createOscillator(oscillatorIndex), ...oscillator, id: String(oscillator.id || uniqueId("osc")), period: Math.max(.01, Number(oscillator.period) || 1) }));
    spawn.automations = { ...base.automations, ...(incoming.automations ?? {}) };
    spawn.marker = { ...base.marker, ...(incoming.marker ?? {}) };
    spawn.secondary = { ...base.secondary, ...(incoming.secondary ?? {}) };
    spawn.arrayColors = Array.isArray(incoming.arrayColors) && incoming.arrayColors.length ? incoming.arrayColors.slice(0, 32) : base.arrayColors;
    spawn.arraySizes = Array.isArray(incoming.arraySizes) && incoming.arraySizes.length ? incoming.arraySizes.slice(0, 32).map(Number) : base.arraySizes;
    spawn.arraySpeeds = Array.isArray(incoming.arraySpeeds) && incoming.arraySpeeds.length ? incoming.arraySpeeds.slice(0, 32).map(Number) : base.arraySpeeds;
    return spawn;
  });
  return {
    ...fallback,
    ...input,
    version: 1,
    id: String(input.id || fallback.id),
    name: String(input.name || fallback.name).slice(0, 100),
    seed: Number(input.seed) || fallback.seed,
    projectileCap: clamp(Math.round(Number(input.projectileCap) || fallback.projectileCap), 100, 10000),
    playfield: { ...fallback.playfield, ...(input.playfield ?? {}), width, height },
    spawns: spawns.length ? spawns : [createDefaultSpawn(0, width, height)],
  };
}

/**
 * A deep copy under new ids, for "duplicate" in an authoring surface.
 * @param {BulletPatternDefinition} pattern
 * @param {() => string} [makeId]
 * @returns {BulletPatternDefinition}
 */
export function duplicatePattern(pattern, makeId = undefined) {
  const next = structuredClone(pattern);
  next.id = makeId ? makeId() : uniqueId("pattern");
  next.name = `${pattern.name} Copy`;
  next.spawns = next.spawns.map((spawn) => ({
    ...spawn,
    id: makeId ? makeId() : uniqueId("spawn"),
    oscillators: spawn.oscillators.map((oscillator) => ({ ...oscillator, id: makeId ? makeId() : uniqueId("osc") })),
  }));
  return next;
}
