import { runNJumpMuzzle } from "./motion.js";
import { stepRunNJumpEquipment, fireRunNJumpLoadout, fireRunNJumpWeapon, rechargeRunNJumpDefense, resetRunNJumpDefense, absorbRunNJumpDamage } from "./equipment.js";
// The player: every ability, driven entirely by the definition.
//
// Nothing in here is a special case for a particular game. Walk, run, jump
// with a count, wall slide and wall jump, duck, ladders, swim, dash, stomp,
// carry — each is a flag on `abilities` and a set of numbers on `feel`, and
// an ability that is off must be provably inert, which the tests hold it to.
//
// The four that make it feel right — coyote time, the jump buffer, variable
// height, the head-bump nudge — are here because their absence is exactly
// what makes a home-made platformer feel wrong, and no author would think
// to ask for them by name. They ship on, tuned, in every preset.

import { cos, sin } from "../core/trig.js";
import { snapStick, stickAngle, stickIsCentred, stickMagnitude } from "../core/stick.js";
import { boxTouchesShape, floorProps, moveActorX, moveActorY, restingOnGround, tileDefAt } from "./move.js";

/**
 * How far a stick must be pushed before it counts as a *held direction*.
 *
 * Speed is analogue and intent is not: leaning the stick 30% right walks at
 * 30%, but ducking, climbing and dropping through a platform are decisions,
 * and a decision taken at 30% would fire while a player was only leaning.
 * At exactly 1 — which is what four keys produce — every comparison below
 * lands the same side of this as the boolean did, so a keyboard run is
 * unchanged step for step.
 */
const INTENT_THRESHOLD = 0.5;

/** Radians to degrees. The satellite thinks in degrees; `core/trig` does not. */
const DEGREES_PER_RADIAN = 180 / Math.PI;

/**
 * The movement the player asked for, whatever they asked with.
 *
 * A centred `move` hands the decision back to the four buttons, so a game
 * that never sets it — every game written before it existed — takes the
 * second path below and gets exactly the vector its booleans always meant.
 *
 * @param {import("./contract.js").PadInput} input
 */
function padMove(input) {
  const move = input.move;
  if (move && !stickIsCentred(move)) return move;
  // NOT `stickFromKeys`, deliberately. That normalizes a diagonal to length
  // one, which is correct when x and y are two components of one direction —
  // a top-down game — and wrong here, where y is duck, look up and climb
  // rather than movement. Scaling it would make a keyboard player holding
  // down-and-right walk at 71% of their speed: a behaviour change dressed up
  // as a refactor, in the oldest code path there is.
  return {
    x: (input.right ? 1 : 0) - (input.left ? 1 : 0),
    y: (input.down ? 1 : 0) - (input.up ? 1 : 0),
  };
}

/**
 * Where the gun points, this step.
 *
 * The three sources differ in what they do when nothing is being asked for,
 * and that difference is the games themselves:
 *
 * - `facing` — the gun is the body. There is no aim to remember.
 * - `move` — Contra. Let go of the d-pad and the barrel returns to level,
 *   because the d-pad *is* the aim and it has been released.
 * - `stick` — Abuse, Time Soldiers. Let go and the crosshair stays where it
 *   was put; an aim you positioned deliberately must not fall back to the
 *   feet the instant you stop pushing. This is the same lesson `satAim`
 *   learned on 2026-08-23, met a second time.
 *
 * @param {any} hero
 * @param {any} player
 * @param {import("./contract.js").PadInput} input
 * @param {{x: number, y: number}} move
 */
function resolveAim(hero, player, input, move) {
  const { aimSource, aimResolution } = hero.weapon;
  if (aimSource === "facing") {
    player.aimX = player.facing;
    player.aimY = 0;
    return;
  }
  const source = aimSource === "stick" ? input.aim : move;
  if (!source || stickIsCentred(source)) {
    if (aimSource === "move") {
      player.aimX = player.facing;
      player.aimY = 0;
    }
    return;
  }
  const snapped = snapStick(source, aimResolution, {
    previous: { x: player.aimX, y: player.aimY },
  });
  // Normalized, because an aim is a DIRECTION and the two things that read it
  // both multiply by it. Without this a diagonal is `hypot(1, 1)` long and the
  // shot leaves 41% faster than a straight one -- the oldest bug in the genre,
  // which `core/stick` avoids inside a vector and which reappears here the
  // moment two unscaled key axes are handed to `snapStick`, since snapping
  // preserves magnitude on purpose. A half-pushed aim stick would likewise
  // have fired at half speed, which nobody would have reported as a bug and
  // everybody would have felt.
  const magnitude = stickMagnitude(snapped);
  if (magnitude === 0) return;
  player.aimX = snapped.x / magnitude;
  player.aimY = snapped.y / magnitude;
}

/**
 * A player's runtime state. Every field is a primitive and every field is
 * born here — the fixed shape is what makes `snapshot` a spread and keeps
 * the engine on one hidden class.
 *
 * @param {number} index
 * @param {object} hero The normalized player definition.
 * @param {{x: number, y: number}} spawn
 */
export function createPlayerState(index, hero, spawn) {
  return {
    id: -(index + 1), // negative ids: never collides with actor ids
    index,
    x: Math.round(spawn.x), y: Math.round(spawn.y),
    rx: 0, ry: 0,
    w: hero.hitbox.w, h: hero.hitbox.h,
    vx: 0, vy: 0,
    facing: 1,
    alive: true, removed: false, crushed: false,
    grounded: false, wasGrounded: false,
    coyote: 0, jumpBuffer: 0, jumpsUsed: 0, jumpCut: false, jumpHeldPrev: false,
    actionHeldPrev: false, actionPressed: false, actionReleased: false,
    ducking: false, climbing: false, swimming: false,
    wallSliding: false, wallDir: 0, wallLockout: 0,
    dashTime: 0, dashCooldown: 0, dashDir: 1,
    dropThrough: 0, warpCooldown: 0,
    invuln: 0, invincible: 0, powered: 0,
    power: hero.health.model === "power" ? 1 : 0,
    hp: hero.health.model === "hits" ? hero.health.max : 1,
    respawnTimer: 0,
    carrying: 0, fireCooldown: 0, meleeTime: 0, meleeCooldown: 0,
    // Where the gun points, as two numbers rather than one vector: `snapshot`
    // copies a player with a spread, so a nested object would be SHARED
    // between the snapshot and the live state and every rollback would
    // quietly restore an aim that had gone on changing. Born pointing the way
    // the body faces, which is what `aimSource: "facing"` will keep it at.
    aimX: 1, aimY: 0,
    // The satellite: where it sits, where it points, when it may fire next.
    // Degrees, so a snapshot is three more plain numbers.
    satAngle: hero.satellite.restAngle,
    satAim: hero.satellite.restAngle,
    satFireAt: 0,
    solid: false, platform: false, open: false,
    anim: "idle", animAge: 0,
  };
}

/**
 * Hurt a player by the definition's health model. Damage while invulnerable
 * or invincible is ignored; what remains steps the model — power states lose
 * a step, hit points lose `damage`, one-hit dies — and death is a timer, not
 * a removal, so a co-op partner plays on while the respawn counts down.
 *
 * @param {any} world
 * @param {any} player
 * @param {number} damage
 * @param {number} [sourceX] Where it came from, for knockback direction.
 */
export function hurtPlayer(world, player, damage, sourceX = player.x) {
  if (!player.alive || player.invuln > 0 || player.invincible > 0 || damage <= 0) return;
  const health = world.game.player.health;
  damage = absorbRunNJumpDamage(world, player, world.game.defenses?.find((entry) => entry.id === player.defenseId), damage, { player: player.index });
  if (damage <= 0) { player.invuln = health.invulnTime; return; }
  if (health.model === "power" && player.power > 0) {
    player.power -= 1;
    applyPowerSize(world, player);
    player.invuln = health.invulnTime;
    knockback(player, health, sourceX);
    world.emit("power-down", { player: player.index });
    return;
  }
  if (health.model === "hits" && player.hp > damage) {
    player.hp -= damage;
    player.invuln = health.invulnTime;
    knockback(player, health, sourceX);
    world.emit("player-hurt", { player: player.index, hp: player.hp });
    return;
  }
  killPlayer(world, player);
}

/** Death, unconditionally: falling out and crushing come here directly. */
export function killPlayer(world, player) {
  if (!player.alive) return;
  player.alive = false;
  player.respawnTimer = 1.5;
  player.vx = 0;
  player.vy = 0;
  player.climbing = false;
  player.carrying = 0;
  world.emit("player-death", { player: player.index, x: player.x, y: player.y });
}

function knockback(player, health, sourceX) {
  const away = player.x + player.w / 2 >= sourceX ? 1 : -1;
  player.vx = away * health.knockbackX;
  player.vy = -health.knockbackY;
  player.grounded = false;
}

/** Power-state size: small below power 1, full hitbox at and above it. */
function applyPowerSize(world, player) {
  const hero = world.game.player;
  const wantH = player.power >= 1 ? hero.hitbox.h : hero.duckHitbox.h;
  if (player.h !== wantH) {
    player.y += player.h - wantH;
    player.h = wantH;
  }
}

/**
 * One step of one player. Reads the input, applies the definition, moves
 * through the field. Returns nothing; everything it decides is on the
 * player and the world's event queue.
 *
 * @param {any} world
 * @param {any} player
 * @param {import("./contract.js").PadInput} input
 * @param {number} dt
 */
export function stepPlayer(world, player, input, dt) {
  const hero = world.game.player;
  const feel = hero.feel;
  const abilities = hero.abilities;
  const field = world.field;

  // Timers, before anything reads them.
  player.invuln = Math.max(0, player.invuln - dt);
  player.invincible = Math.max(0, player.invincible - dt);
  player.powered = Math.max(0, player.powered - dt);
  player.dropThrough = Math.max(0, player.dropThrough - dt);
  player.warpCooldown = Math.max(0, player.warpCooldown - dt);
  player.wallLockout = Math.max(0, player.wallLockout - dt);
  player.dashCooldown = Math.max(0, player.dashCooldown - dt);
  player.fireCooldown = Math.max(0, player.fireCooldown - dt);
  player.meleeCooldown = Math.max(0, player.meleeCooldown - dt);
  player.meleeTime = Math.max(0, player.meleeTime - dt);
  player.animAge += dt;

  if (!player.alive) {
    player.respawnTimer = Math.max(0, player.respawnTimer - dt);
    return;
  }

  stepRunNJumpEquipment(world, player, input, dt);
  rechargeRunNJumpDefense(player, world.game.defenses?.find((entry) => entry.id === player.defenseId), dt);
  if (player.satBody) {
    const body = player.satBody, durability = hero.satellite.durability;
    const defense = world.game.defenses?.find((entry) => entry.id === durability.defenseId);
    body.invuln = Math.max(0, body.invuln - dt);
    if (!body.alive) {
      body.respawn = Math.max(0, body.respawn - dt);
      if (body.respawn === 0) { body.alive = true; body.hp = durability.hp; resetRunNJumpDefense(body, defense); world.emit("satellite-respawn", { player: player.index }); }
    } else rechargeRunNJumpDefense(body, defense, dt);
  }

  // One vector, then the discrete intents read off it, so every path below
  // behaves the same whether it was driven by four keys or by a stick.
  const move = padMove(input);
  const wantsUp = move.y <= -INTENT_THRESHOLD;
  const wantsDown = move.y >= INTENT_THRESHOLD;

  const jumpPressed = input.jump && !player.jumpHeldPrev;
  const actionPressed = input.action && !player.actionHeldPrev;
  // The world's carry-and-throw phase runs after this and needs the same
  // edges, so they are stored rather than recomputed against the already-
  // updated held state -- recomputing there would compare input to itself.
  player.actionPressed = actionPressed;
  player.actionReleased = !input.action && player.actionHeldPrev;
  player.jumpHeldPrev = input.jump;
  player.actionHeldPrev = input.action;

  // -- environment senses --
  const box = { x: player.x, y: player.y, w: player.w, h: player.h };
  const inLiquid = boxTouchesShape(field, box, "liquid");
  player.swimming = abilities.swim && inLiquid;
  const onLadderTiles = boxTouchesShape(field, box, "ladder");
  const props = player.grounded ? floorProps(field, player) : { surface: "normal", conveyor: 0, bounce: 0, onTiles: false };

  // -- climbing --
  if (player.climbing) {
    if (!onLadderTiles || jumpPressed || !abilities.climb) {
      player.climbing = false;
      if (jumpPressed && !wantsDown) {
        player.vy = -feel.jumpSpeed * 0.7;
        player.jumpBuffer = 0;
      }
    }
  } else if (abilities.climb && onLadderTiles && (wantsUp || (wantsDown && !player.grounded))) {
    player.climbing = true;
    player.vx = 0;
    player.vy = 0;
    player.jumpsUsed = 0;
  } else if (abilities.climb && onLadderTiles && wantsDown && player.grounded && standingOnLadderTop(field, player)) {
    // Standing on a ladder's top: down means climb down through it.
    player.climbing = true;
    player.dropThrough = 0.15;
    player.grounded = false;
    player.vx = 0;
    player.vy = 0;
  }

  // -- ducking --
  if (abilities.duck && !player.climbing) {
    const duckH = hero.duckHitbox.h;
    const standH = powerStandHeight(world, player);
    if (wantsDown && player.grounded && !player.ducking && player.h > duckH) {
      player.y += player.h - duckH;
      player.h = duckH;
      player.ducking = true;
    } else if (player.ducking && !wantsDown) {
      const ny = player.y - (standH - player.h);
      if (!worldCollides(world, player, player.x, ny, standH)) {
        player.y = ny;
        player.h = standH;
        player.ducking = false;
      }
    }
  }

  // -- horizontal intent --
  // Analogue: the magnitude is how fast, so a stick leaned a third of the way
  // walks a third as fast. Four keys produce exactly 1 or -1 and land on the
  // same numbers this line always produced.
  const dir = move.x;
  if (dir !== 0 && player.wallLockout <= 0 && player.dashTime <= 0) {
    player.facing = dir > 0 ? 1 : -1;
  }

  // -- where the gun points --
  // After facing, because `facing` is what two of the three sources fall back
  // to, and before firing, which reads the answer.
  resolveAim(hero, player, input, move);

  let accel = player.grounded ? feel.accelGround : feel.accelAir;
  let friction = player.grounded ? feel.frictionGround : feel.frictionAir;
  let targetSpeed = (input.run && abilities.run ? feel.runSpeed : feel.walkSpeed) * dir;
  if (player.ducking && player.grounded) {
    // Ducking roots you unless the crawl ability is on; crawling is slow.
    targetSpeed = abilities.crawl ? targetSpeed * 0.4 : 0;
  }
  if (player.swimming) { accel *= 0.7; targetSpeed *= 0.75; }
  if (props.surface === "ice") { accel *= 0.4; friction *= 0.15; }
  if (props.surface === "mud") { targetSpeed *= 0.5; friction *= 1.5; }

  if (player.climbing) {
    player.vx = 0;
  } else if (player.dashTime > 0) {
    player.vx = feel.dashSpeed * player.dashDir;
  } else if (player.wallLockout > 0) {
    // A wall jump owns the arc for its lockout; input steers after.
  } else if (dir !== 0) {
    const reversing = player.vx !== 0 && Math.sign(player.vx) !== dir;
    const rate = accel * (reversing ? feel.turnBoost : 1) * dt;
    player.vx = approach(player.vx, targetSpeed, rate);
  } else {
    player.vx = approach(player.vx, 0, friction * dt);
  }

  // -- dash --
  if (abilities.dash && actionPressed && player.dashCooldown <= 0 && player.dashTime <= 0 && !player.climbing) {
    player.dashTime = feel.dashTime;
    player.dashDir = dir !== 0 ? dir : player.facing;
    player.dashCooldown = feel.dashCooldown;
    player.vy = 0;
    // The burst starts on the press frame, not the one after.
    player.vx = feel.dashSpeed * player.dashDir;
    world.emit("dash", { player: player.index });
  }
  player.dashTime = Math.max(0, player.dashTime - dt);

  // -- wall slide --
  player.wallSliding = false;
  if (abilities.wallSlide && !player.grounded && !player.climbing && player.vy > 0 && dir !== 0) {
    if (worldCollides(world, player, player.x + dir, player.y, player.h)) {
      player.wallSliding = true;
      player.wallDir = dir;
    }
  }

  // -- jumping --
  if (player.grounded) {
    player.coyote = feel.coyoteTime;
    player.jumpsUsed = 0;
    player.jumpCut = false;
  } else {
    player.coyote = Math.max(0, player.coyote - dt);
    // Walking off a ledge forfeits the ground jump once the coyote window
    // closes -- otherwise "jump count 1" quietly includes a free air jump,
    // which is exactly the disguise a missing coyote time hides in.
    if (player.coyote === 0 && player.jumpsUsed === 0) player.jumpsUsed = 1;
  }
  if (jumpPressed) player.jumpBuffer = feel.jumpBuffer;
  else player.jumpBuffer = Math.max(0, player.jumpBuffer - dt);

  const wantsDrop = wantsDown && jumpPressed && player.grounded
    && standsOnDroppable(world, player);
  if (wantsDrop) {
    player.dropThrough = 0.18;
    player.grounded = false;
    player.jumpBuffer = 0;
  } else if (player.jumpBuffer > 0 && !player.climbing && abilities.jumpCount > 0 && player.dashTime <= 0) {
    const wallTouch = abilities.wallJump && !player.grounded
      && (player.wallSliding
        || (dir !== 0 && worldCollides(world, player, player.x + dir, player.y, player.h)));
    if (player.swimming) {
      player.vy = -feel.swimStroke;
      player.jumpBuffer = 0;
      world.emit("swim", { player: player.index });
    } else if (player.grounded || player.coyote > 0) {
      player.vy = -feel.jumpSpeed;
      player.grounded = false;
      player.coyote = 0;
      player.jumpBuffer = 0;
      player.jumpsUsed = 1;
      player.jumpCut = false;
      world.emit("jump", { player: player.index });
    } else if (wallTouch) {
      const away = player.wallSliding ? -player.wallDir : -dir;
      player.vy = -feel.wallJumpY;
      player.vx = away * feel.wallJumpX;
      player.facing = away;
      player.wallLockout = feel.wallJumpLockout;
      player.jumpBuffer = 0;
      player.jumpsUsed = 1;
      player.jumpCut = false;
      world.emit("wall-jump", { player: player.index });
    } else if (player.jumpsUsed < abilities.jumpCount) {
      player.vy = -feel.jumpSpeed * 0.88;
      player.jumpBuffer = 0;
      player.jumpsUsed += 1;
      player.jumpCut = false;
      world.emit("air-jump", { player: player.index });
    }
  }

  // Variable height: releasing jump while rising trims the arc, once.
  if (!input.jump && player.vy < 0 && !player.jumpCut && !player.climbing && player.dashTime <= 0) {
    player.vy *= feel.jumpCutScale;
    player.jumpCut = true;
  }

  // -- gravity --
  if (player.climbing) {
    // Booleans, not `move.y * climbSpeed`: a stick pushed down-and-right
    // reads 0.71 on each axis, and a ladder climbed at 71% because the player
    // is also leaning is not a feature anybody asked for.
    player.vy = (wantsDown ? 1 : 0) * feel.climbSpeed - (wantsUp ? 1 : 0) * feel.climbSpeed;
  } else if (player.dashTime > 0) {
    player.vy = 0;
  } else {
    const rising = player.vy < 0;
    let gravity = rising && input.jump ? feel.gravityWhileHolding : feel.gravity;
    let cap = feel.maxFall;
    if (player.swimming) { gravity = feel.swimGravity; cap = feel.swimMaxFall; }
    else if (player.wallSliding) cap = feel.wallSlideSpeed;
    else if (wantsDown && !player.grounded && !player.ducking) cap = feel.maxFall * feel.fastFallScale;
    player.vy = Math.min(player.vy + gravity * dt, cap);
  }

  // Wind, on whoever is airborne. Horizontal wind is positional drift, the
  // way a conveyor is -- as an acceleration it loses the fight with air
  // friction and does nothing observable. Vertical wind stays a force, so
  // an updraft genuinely argues with gravity.
  const airborne = !player.grounded && !player.climbing;
  if (airborne) player.vy += world.level.wind.y * dt;

  // -- move --
  player.wasGrounded = player.grounded;
  const conveyorPx = player.grounded ? props.conveyor * dt : 0;
  const windPx = airborne ? world.level.wind.x * dt : 0;
  const movedX = moveActorX(field, player, player.vx * dt + conveyorPx + windPx);
  if (movedX.hitWall) player.vx = 0;

  const movedY = moveActorY(field, player, player.vy * dt, { nudge: feel.headBumpNudge });
  if (movedY.hitFloor) {
    player.grounded = true;
    const landing = floorProps(field, player);
    if (landing.bounce > 0) {
      player.vy = -landing.bounce;
      player.grounded = false;
      world.emit("bounce", { player: player.index });
    } else {
      if (player.vy > feel.maxFall * 0.9) world.emit("land", { player: player.index });
      player.vy = 0;
    }
  } else if (movedY.hitCeiling) {
    player.vy = 0;
    for (const cell of movedY.ceilingCells) world.breakCell(cell.col, cell.row, player);
    world.bumpFromBelow(player);
  } else if (player.vy > 0) {
    player.grounded = restingOnGround(field, player);
    if (player.grounded) player.vy = 0;
  } else if (player.vy < 0) {
    player.grounded = false;
  }
  if (player.climbing && !boxTouchesShape(field, { x: player.x, y: player.y, w: player.w, h: player.h }, "ladder")) {
    player.climbing = false;
  }

  // -- fell out of the level --
  if (player.y > world.field.rows * world.field.tileSize + 64) {
    killPlayer(world, player);
    return;
  }

  // -- the satellite --
  if (hero.satellite.enabled) stepSatellite(world, player, input, dt);

  // -- weapons --
  if (abilities.shoot && input.fire && !player.ducking && !player.climbing) {
    const at = { x: player.x + player.w / 2, y: player.y + player.h / 2 }, aim = { x: player.aimX, y: player.aimY };
    if (!fireRunNJumpLoadout(world, player, dt, false, at, aim)) {
      const pattern = hero.weapon.patternId ? (player.weaponPattern ??= {}) : {};
      if (!fireRunNJumpWeapon(world, player, hero.weapon, pattern, dt, runNJumpMuzzle(at, aim, hero.weapon.mount), aim, false) && player.fireCooldown <= 0) {
        player.fireCooldown = 1 / hero.weapon.fireRate; world.spawnProjectile(player);
      }
    }
  }
  if (abilities.melee && actionPressed && !abilities.dash && player.meleeCooldown <= 0) {
    player.meleeTime = hero.weapon.meleeTime;
    player.meleeCooldown = hero.weapon.meleeCooldown;
    world.emit("melee", { player: player.index });
  }

  // -- the animation hint, for whatever draws --
  const previous = player.anim;
  player.anim =
    !player.alive ? "dead"
      : player.climbing ? "climb"
        : player.swimming ? "swim"
          : player.dashTime > 0 ? "dash"
            : player.wallSliding ? "wall"
              : !player.grounded ? (player.vy < 0 ? "jump" : "fall")
                : player.ducking ? "duck"
                  : Math.abs(player.vx) > 4 ? "walk"
                    : "idle";
  if (player.anim !== previous) player.animAge = 0;
}

/**
 * Swing the satellite, turn its aim, and let it shoot.
 *
 * The two are deliberately separate: `satAngle` is where the thing IS and
 * `satAim` is where it SHOOTS. Unlocked, the pair move together and it
 * fires outward -- one gesture, the obvious behaviour. Held `satLock`, the
 * orbit freezes and the same two keys turn the aim alone, which is what
 * makes it a shield you can park while still firing somewhere else.
 *
 * Degrees throughout, wrapped by arithmetic, with `core/trig` for the one
 * place a position is needed. Nothing here reads a clock or a random.
 *
 * **With a stick, it points instead of turning.** Forgotten Worlds is the
 * game in the request list this exists for, and its satellite is placed, not
 * cranked: push the stick and the thing goes there. So a pushed `aim` sets
 * the angle outright and the two keys are the fallback for anyone without a
 * second stick -- the same "a stick wins, the keys catch it" rule the rest of
 * this input path follows. `satLock` keeps its meaning either way.
 *
 * The gun and the satellite read the SAME `aim` channel, which is right for
 * the game this is for -- there, the satellite is the weapon -- and is the
 * thing to revisit if a game ever wants a stick-aimed gun AND an independently
 * placed satellite. That would be a third channel appended to `PAD_STICKS`,
 * which the format allows and no recording would notice.
 */
function stepSatellite(world, player, input, dt) {
  const settings = world.game.player.satellite;
  const locked = input.satLock === true;
  const turn = (input.satCW ? 1 : 0) - (input.satCCW ? 1 : 0);
  if (player.satBody && !player.satBody.alive) return;
  const aim = settings.control?.aimSource === "independent" ? input.satAim : input.aim;

  if (aim && !stickIsCentred(aim)) {
    const degrees = wrapDegrees(stickAngle(aim) * DEGREES_PER_RADIAN);
    if (locked) {
      player.satAim = degrees;
    } else {
      // Normalized into [-180, 180] before it is applied: 350 degrees to 10
      // is a twenty-degree nudge clockwise, and the raw subtraction calls it
      // 340 the other way, which would fling the aim right round the dial.
      let delta = degrees - player.satAngle;
      if (delta > 180) delta -= 360;
      else if (delta < -180) delta += 360;
      player.satAngle = degrees;
      if (settings.aimFollowsOrbit) player.satAim = wrapDegrees(player.satAim + delta);
    }
  } else if (locked) {
    player.satAim = wrapDegrees(player.satAim + turn * settings.aimSpeed * dt);
  } else {
    const delta = turn * settings.orbitSpeed * dt + settings.autoSpin * dt;
    player.satAngle = wrapDegrees(player.satAngle + delta);
    // The aim turns BY the same amount, rather than being set TO the orbit.
    // The difference is the whole value of the lock: assignment snapped a
    // carefully-placed aim back to the satellite's position the instant the
    // lock key came up, so nobody could aim and then shoot. Tracking the
    // delta instead means the rig rotates rigidly and whatever offset the
    // player dialled in survives -- park it left, aim it up, and swinging it
    // around keeps it pointing up-and-left of wherever it now sits.
    if (settings.aimFollowsOrbit) player.satAim = wrapDegrees(player.satAim + delta);
  }

  if (settings.control?.mode === "tether") {
    const angle = player.satAngle * Math.PI / 180;
    if (!locked && aim && !stickIsCentred(aim)) player.satReach = Math.min(1, stickMagnitude(aim)) * settings.distance;
    else if (turn) player.satReach = settings.distance;
    const reach = player.satReach ?? settings.distance;
    const targetX = cos(angle) * reach, targetY = sin(angle) * reach;
    player.satOffsetX = approach(player.satOffsetX ?? targetX, targetX, settings.control.speed * dt);
    player.satOffsetY = approach(player.satOffsetY ?? targetY, targetY, settings.control.speed * dt);
    const centerX = player.x + player.w / 2, centerY = player.y + player.h / 2;
    player.satOffsetX = Math.max(4 - centerX, Math.min(world.field.cols * world.field.tileSize - 4 - centerX, player.satOffsetX));
    player.satOffsetY = Math.max(4 - centerY, Math.min(world.field.rows * world.field.tileSize - 4 - centerY, player.satOffsetY));
  }
  player.satFireAt = Math.max(0, player.satFireAt - dt);
  const wantsToFire = settings.autoFireRate > 0 || input.fire;
  const rate = settings.autoFireRate > 0 ? settings.autoFireRate : settings.fireRate;
  if (wantsToFire && player.alive) {
    const at = satellitePosition(world.game.player, player), angle = player.satAim * Math.PI / 180;
    const direction = { x: cos(angle), y: sin(angle) };
    if (!fireRunNJumpLoadout(world, player, dt, true, at, direction)) {
      const pattern = settings.patternId ? (player.satPattern ??= {}) : {};
      if (!fireRunNJumpWeapon(world, player, settings, pattern, dt, at, direction, true) && player.satFireAt <= 0) {
        player.satFireAt = 1 / rate; world.spawnSatelliteShot(player);
      }
    }
  }
}

/** Degrees, folded into [0, 360). Addition and one modulo -- exact. */
export function wrapDegrees(value) {
  const wrapped = value % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/**
 * Where the satellite is, in world pixels. Presentation asks this too, so
 * it lives here rather than being recomputed slightly differently there.
 */
export function satellitePosition(hero, player) {
  const radians = player.satAngle * (Math.PI / 180);
  if (hero.satellite.control?.mode === "tether" && player.satOffsetX !== undefined) return { x: player.x + player.w / 2 + player.satOffsetX, y: player.y + player.h / 2 + player.satOffsetY };
  return {
    x: player.x + player.w / 2 + cos(radians) * hero.satellite.distance,
    y: player.y + player.h / 2 + sin(radians) * hero.satellite.distance,
  };
}

function approach(value, target, amount) {
  if (value < target) return Math.min(value + amount, target);
  if (value > target) return Math.max(value - amount, target);
  return value;
}

function powerStandHeight(world, player) {
  const hero = world.game.player;
  if (hero.health.model !== "power") return hero.hitbox.h;
  return player.power >= 1 ? hero.hitbox.h : hero.duckHitbox.h;
}

/** Collision probe at an arbitrary height, for stand-up and wall checks. */
function worldCollides(world, player, x, y, h) {
  const probe = { x: player.x, y: player.y, w: player.w, h, rx: 0, ry: 0, alive: true, dropThrough: 0 };
  probe.x = x;
  probe.y = y;
  return world.collides(probe);
}

function standingOnLadderTop(field, player) {
  const ts = field.tileSize;
  const row = Math.floor((player.y + player.h) / ts);
  for (const px of [player.x + 1, player.x + (player.w >> 1), player.x + player.w - 2]) {
    const col = Math.floor(px / ts);
    if (tileDefAt(field, col, row).shape === "ladder" && tileDefAt(field, col, row - 1).shape !== "ladder") return true;
  }
  return false;
}

/** True when everything underfoot can be dropped through: one-ways, ladder tops, platform actors. */
function standsOnDroppable(world, player) {
  const field = world.field;
  const ts = field.tileSize;
  const foot = player.y + player.h;
  const row = Math.floor(foot / ts);
  let sawSupport = false;
  for (const px of [player.x + 1, player.x + (player.w >> 1), player.x + player.w - 2]) {
    const def = tileDefAt(field, Math.floor(px / ts), row);
    if (def.shape === "oneWay") { sawSupport = true; continue; }
    if (def.shape === "ladder" && tileDefAt(field, Math.floor(px / ts), row - 1).shape !== "ladder") { sawSupport = true; continue; }
    if (def.shape !== "empty" && def.shape !== "liquid" && def.shape !== "hazard") return false;
  }
  for (const solid of field.solids) {
    if (!solid.alive || !solid.platform) continue;
    if (solid.y === foot && player.x < solid.x + solid.w && solid.x < player.x + player.w) sawSupport = true;
    if (solid.solid && solid.y === foot) return false;
  }
  return sawSupport;
}
