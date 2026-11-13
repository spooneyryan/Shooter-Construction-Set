// The collision core: how anything moves through a 2DRunNJump level.
//
// The model is the one Celeste made standard, because it is the one that
// does not fall apart. An actor is a box with an integer position and float
// sub-pixel remainders; it moves one pixel at a time, checking as it goes.
// That is O(distance), which at platformer speeds is nothing — and it makes
// tunnelling structurally impossible rather than a bug fixed twice a year.
// A solid is a box that moves, carries what rides it and pushes what is in
// its way; actors never push solids. The tilemap is a static solid queried
// by lookup.
//
// Axes resolve separately, X then Y, always in that order, and every check
// is on integer boxes — no epsilons anywhere. Both are determinism
// requirements, not style.
//
// The one non-obvious stance: **slope tiles have a floor and nothing else.**
// No side or ceiling collision, which is what turns walking into a slope
// from its low side into a climb instead of a wall. The cost is that a
// slope's tall side is open — an author who exposes one puts a solid behind
// it, which is the oldest tile-game authoring rule there is.
//
// Everything here takes a `field` — the world's collision view:
//   { tileSize, cols, rows, tiles, tileset, walls, solids }
// where `tiles` is the unpacked grid and `solids` the moving solid and
// platform actors. Nothing here reads a clock, an input or a definition.

import { normalizeTile, tileBlocks, tileSurfaceAt } from "./tiles.js";

/** Out-of-bounds stand-ins, built once. */
const AIR_TILE = normalizeTile({ shape: "empty" });
const EDGE_TILE = normalizeTile({ shape: "solid", name: "edge" });

/**
 * Where a body actually is, to the sub-pixel. **Collide with `x`; draw with
 * this.**
 *
 * `x` is a whole pixel, always: `moveActorX` steps one pixel at a time and
 * parks the fraction it could not spend in `rx`. So `x` on its own is a
 * rounded position, and anything moving slower than a pixel a step holds the
 * same `x` for several steps running — a walker at 40px/s advances 0.667px a
 * step, and its `x` reads 253, 252, 251, 251, 250, 249, 249. That stall is
 * visible at any frame rate, and render interpolation cannot smooth it away,
 * because the number being interpolated has already been rounded. Feed a
 * renderer `x` and it will draw a stutter that is not in the simulation.
 *
 * `x + rx` is the unrounded truth — **as long as the remainder is movement
 * that is going to happen.** When a body is pressed against something it is
 * not: a grounded body has gravity added and cancelled every single step, so
 * its `ry` cycles 0.389, 0, 0.389, 0 forever while it stands perfectly still,
 * and a body walking into a wall does the same on `rx`. Draw that and every
 * character in the game vibrates on the spot. So a remainder pushing into a
 * solid is discarded here rather than drawn — which is the rule the mover
 * already follows when it zeroes a remainder on a blocked step, applied one
 * step earlier, where the block has not been attempted yet.
 *
 * The offset is under half a pixel, so the drawn body and its collision box
 * never visibly disagree — and nothing here is fed back into the simulation,
 * which keeps working in whole pixels for the determinism reasons above.
 *
 * @param {any} field The world's collision view, as everything here takes.
 * @param {any} body Any actor, player or solid moved by this module.
 * @returns {number}
 */
export function exactX(field, body) {
  const rx = body.rx || 0;
  if (rx === 0) return body.x;
  return collidesAt(field, body, body.x + (rx > 0 ? 1 : -1), body.y) ? body.x : body.x + rx;
}

/**
 * The vertical half of {@link exactX}.
 *
 * Downward, `grounded` is the authority rather than a box test: it is what
 * knows about one-way platforms and slopes, neither of which reads as solid
 * to `collidesAt`, and both of which a character stands on constantly.
 *
 * @param {any} field
 * @param {any} body
 * @returns {number}
 */
export function exactY(field, body) {
  const ry = body.ry || 0;
  if (ry === 0) return body.y;
  if (ry > 0 && body.grounded) return body.y;
  return collidesAt(field, body, body.x, body.y + (ry > 0 ? 1 : -1)) ? body.y : body.y + ry;
}

/**
 * @param {any} field
 * @param {number} col
 * @param {number} row
 */
export function tileDefAt(field, col, row) {
  if (col < 0 || col >= field.cols) return field.walls === "open" ? AIR_TILE : EDGE_TILE;
  if (row < 0 || row >= field.rows) return AIR_TILE;
  const index = field.tiles[row * field.cols + col];
  return field.tileset.tiles[index] ?? AIR_TILE;
}

/** Integer AABB overlap, exclusive on the far edges. */
export function rectsOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;
}

/**
 * Does the box collide with blocking tiles or moving solids at (x, y)?
 *
 * A solid the actor ALREADY overlaps is ignored — the unstick rule. Without
 * it, an actor a crusher has caught is wedged inside a box that blocks its
 * every move, forever; with it, the overlap resolves as the two separate.
 *
 * @param {any} field
 * @param {any} actor
 * @param {number} x
 * @param {number} y
 */
export function collidesAt(field, actor, x, y) {
  const ts = field.tileSize;
  const colMin = Math.floor(x / ts);
  const colMax = Math.floor((x + actor.w - 1) / ts);
  const rowMin = Math.floor(y / ts);
  const rowMax = Math.floor((y + actor.h - 1) / ts);
  for (let row = rowMin; row <= rowMax; row += 1) {
    for (let col = colMin; col <= colMax; col += 1) {
      if (tileBlocks(tileDefAt(field, col, row))) return true;
    }
  }
  for (const solid of field.solids) {
    if (solid === actor || !solid.alive || !solid.solid || solid.open) continue;
    if (!rectsOverlap(x, y, actor.w, actor.h, solid.x, solid.y, solid.w, solid.h)) continue;
    if (rectsOverlap(actor.x, actor.y, actor.w, actor.h, solid.x, solid.y, solid.w, solid.h)) continue;
    return true;
  }
  return false;
}

/**
 * The world-y of the highest walkable surface at horizontal pixel `px`,
 * looking only at surfaces in the window [yMin, yMax]. Slope surfaces
 * interpolate and are rounded to the pixel; everything else stands on a
 * tile's top edge. Returns null when nothing is in the window.
 *
 * @param {any} field
 * @param {number} px
 * @param {number} yMin
 * @param {number} yMax
 * @param {{oneWay?: boolean}} [options] Whether one-way tops (and ladder
 *        tops, which behave as one) count as surface. They do for a grounded
 *        actor being glued; they do not for one falling with drop-through held.
 */
export function surfaceAtPoint(field, px, yMin, yMax, { oneWay = true } = {}) {
  const ts = field.tileSize;
  const col = Math.floor(px / ts);
  for (let row = Math.floor(yMin / ts); row <= Math.floor(yMax / ts); row += 1) {
    const def = tileDefAt(field, col, row);
    let surface = null;
    if (def.shape === "slope") {
      surface = Math.round(row * ts + tileSurfaceAt(def, px - col * ts, ts));
    } else if (tileBlocks(def)) {
      surface = row * ts;
    } else if (oneWay && def.shape === "oneWay") {
      surface = row * ts;
    } else if (oneWay && def.shape === "ladder" && tileDefAt(field, col, row - 1).shape !== "ladder") {
      // A ladder's top rung is a floor -- Donkey Kong is unplayable otherwise.
      surface = row * ts;
    }
    if (surface !== null && surface >= yMin && surface <= yMax) return surface;
  }
  return null;
}

/** The three foot sensors: just inside each edge, and the middle. */
function footSensors(actor, x) {
  return [x + 1, x + (actor.w >> 1), x + actor.w - 2];
}

/** The highest surface under any foot sensor, within the window. Null if none. */
function surfaceUnderFeet(field, actor, x, yMin, yMax, options) {
  let best = null;
  for (const px of footSensors(actor, x)) {
    const surface = surfaceAtPoint(field, px, yMin, yMax, options);
    if (surface !== null && (best === null || surface < best)) best = surface;
  }
  return best;
}

/**
 * Move an actor horizontally by `amount` pixels (fractional; remainders
 * accumulate on `actor.rx`). Resolves one pixel at a time. A grounded actor
 * is glued to slopes — a step of no more than `climb` pixels up is free, a
 * drop of no more than `snap` follows the ground down — so walking a girder
 * neither launches at every ridge nor jitters.
 *
 * @param {any} field
 * @param {any} actor Mutated: x, rx, and y (slope glue).
 * @param {number} amount
 * @param {{glue?: boolean}} [options] Glue defaults to `actor.grounded`.
 * @returns {{hitWall: boolean, wallDir: number}}
 */
export function moveActorX(field, actor, amount, options = {}) {
  actor.rx += amount;
  let move = Math.round(actor.rx);
  actor.rx -= move;
  const result = { hitWall: false, wallDir: 0 };
  if (move === 0) return result;
  const glue = options.glue ?? actor.grounded === true;
  const sign = move > 0 ? 1 : -1;
  while (move !== 0) {
    const nx = actor.x + sign;
    if (!collidesAt(field, actor, nx, actor.y)) {
      actor.x = nx;
      if (glue) glueToGround(field, actor);
    } else if (glue && tryStepUp(field, actor, nx)) {
      // stepped up onto a low ledge or a slope pixel; x and y already set
    } else {
      result.hitWall = true;
      result.wallDir = sign;
      actor.rx = 0;
      break;
    }
    move -= sign;
  }
  return result;
}

/**
 * One-pixel step-up: lets a grounded actor walk up surfaces that rise by a
 * pixel — which is exactly what a 45° slope is, one pixel at a time.
 */
function tryStepUp(field, actor, nx) {
  const ny = actor.y - 1;
  if (collidesAt(field, actor, nx, ny)) return false;
  const foot = ny + actor.h;
  const surface = surfaceUnderFeet(field, actor, nx, foot - 1, foot);
  if (surface === null) return false;
  actor.x = nx;
  actor.y = surface - actor.h;
  return true;
}

/** Pull a grounded actor down to the surface just beneath it, if any is near. */
function glueToGround(field, actor) {
  const foot = actor.y + actor.h;
  const surface = surfaceUnderFeet(field, actor, actor.x, foot - 2, foot + 2, {
    oneWay: !(actor.dropThrough > 0),
  });
  if (surface === null) return;
  const ny = surface - actor.h;
  if (ny === actor.y) return;
  if (ny < actor.y) {
    if (!collidesAt(field, actor, actor.x, ny)) actor.y = ny;
  } else if (!collidesAt(field, actor, actor.x, ny)) {
    actor.y = ny;
  }
}

/**
 * Move an actor vertically. Descending, it lands on: blocking tiles and
 * solids, slope surfaces, one-way tops (and ladder tops) being *entered*
 * this pixel, and platform actors — unless `dropThrough` is held, which
 * lets one-ways and platforms pass. Ascending, a blocked head first tries
 * the corner-correction nudge, then reports the cells it hit so the world
 * can break breakables.
 *
 * @param {any} field
 * @param {any} actor Mutated: y, ry, x (nudge).
 * @param {number} amount
 * @param {{nudge?: number}} [options] Max corner-correction pixels while rising.
 * @returns {{hitFloor: boolean, hitCeiling: boolean, ceilingCells: {col: number, row: number}[]}}
 */
export function moveActorY(field, actor, amount, options = {}) {
  actor.ry += amount;
  let move = Math.round(actor.ry);
  actor.ry -= move;
  const result = { hitFloor: false, hitCeiling: false, ceilingCells: [] };
  if (move === 0) return result;
  const sign = move > 0 ? 1 : -1;
  const nudge = options.nudge ?? 0;
  const dropping = actor.dropThrough > 0;
  while (move !== 0) {
    const ny = actor.y + sign;
    if (sign > 0) {
      if (collidesAt(field, actor, actor.x, ny)) {
        result.hitFloor = true;
        actor.ry = 0;
        break;
      }
      const landing = descentLanding(field, actor, ny, dropping);
      if (landing !== null) {
        actor.y = landing - actor.h;
        result.hitFloor = true;
        actor.ry = 0;
        break;
      }
      actor.y = ny;
    } else {
      if (!collidesAt(field, actor, actor.x, ny)) {
        actor.y = ny;
      } else if (!tryNudge(field, actor, ny, nudge)) {
        result.hitCeiling = true;
        collectCeilingCells(field, actor, ny, result.ceilingCells);
        actor.ry = 0;
        break;
      }
    }
    move -= sign;
  }
  return result;
}

/**
 * Would this one-pixel descent land? Returns the surface y to rest the feet
 * on, or null. Solid tiles are already handled by `collidesAt`; this is the
 * conditional set — surfaces that block only when *entered from above*.
 */
function descentLanding(field, actor, ny, dropping) {
  const oldFoot = actor.y + actor.h;
  const newFoot = ny + actor.h;
  // Slope surfaces: land the moment the foot would pass one.
  const surface = surfaceUnderFeet(field, actor, actor.x, oldFoot, newFoot, { oneWay: !dropping });
  if (surface !== null && surface >= oldFoot && surface < newFoot + 1) {
    // One-way and ladder tops block only when crossed exactly; slopes catch
    // anywhere in the window (a falling box can meet a slope mid-tile).
    return surface;
  }
  if (!dropping) {
    for (const platform of field.solids) {
      if (!platform.alive || !platform.platform || platform === actor) continue;
      if (platform.y >= oldFoot && platform.y < newFoot + 1
        && rectsOverlap(actor.x, ny, actor.w, actor.h, platform.x, platform.y, platform.w, platform.h)) {
        return platform.y;
      }
    }
  }
  return null;
}

/** Corner correction: shift sideways up to `nudge` px to clear a head bump. */
function tryNudge(field, actor, ny, nudge) {
  for (let offset = 1; offset <= nudge; offset += 1) {
    for (const dir of [1, -1]) {
      const nx = actor.x + dir * offset;
      if (!collidesAt(field, actor, nx, ny) && !collidesAt(field, actor, nx, actor.y)) {
        actor.x = nx;
        actor.y = ny;
        return true;
      }
    }
  }
  return false;
}

function collectCeilingCells(field, actor, ny, cells) {
  const ts = field.tileSize;
  const row = Math.floor(ny / ts);
  const colMin = Math.floor(actor.x / ts);
  const colMax = Math.floor((actor.x + actor.w - 1) / ts);
  for (let col = colMin; col <= colMax; col += 1) {
    if (tileBlocks(tileDefAt(field, col, row))) cells.push({ col, row });
  }
}

/**
 * Is the actor resting on ground RIGHT NOW — a blocking tile or solid one
 * pixel below, a walkable surface exactly at the foot line, or a platform
 * actor under it?
 *
 * This exists because "did the last move hit a floor" is the wrong question
 * on the frames where gravity's sub-pixel accumulation rounds to zero
 * movement: nothing was hit because nothing moved, and a grounded flag
 * cleared on those frames flickers — which halves conveyor pushes, restarts
 * coyote time every other frame, and made the first duck test fail.
 *
 * @param {any} field
 * @param {any} actor
 */
export function restingOnGround(field, actor) {
  if (collidesAt(field, actor, actor.x, actor.y + 1)) return true;
  const foot = actor.y + actor.h;
  const surface = surfaceUnderFeet(field, actor, actor.x, foot, foot, {
    oneWay: !(actor.dropThrough > 0),
  });
  if (surface === foot) return true;
  for (const solid of field.solids) {
    if (!solid.alive || solid === actor || !solid.platform) continue;
    if (solid.y === foot && actor.x < solid.x + solid.w && solid.x < actor.x + actor.w) return true;
  }
  return false;
}

/**
 * What is the ground under a grounded actor made of? Reads the tile at each
 * foot sensor's resting line and answers the questions the movement code
 * asks: friction surface, conveyor push, bounce.
 *
 * @param {any} field
 * @param {any} actor
 */
export function floorProps(field, actor) {
  const ts = field.tileSize;
  const foot = actor.y + actor.h;
  const props = { surface: "normal", conveyor: 0, bounce: 0, onTiles: false };
  for (const px of footSensors(actor, actor.x)) {
    const def = tileDefAt(field, Math.floor(px / ts), Math.floor(foot / ts));
    if (def.shape === "empty" || def.shape === "liquid" || def.shape === "hazard") continue;
    props.onTiles = true;
    if (def.surface !== "normal" && props.surface === "normal") props.surface = def.surface;
    if (def.conveyor !== 0 && props.conveyor === 0) props.conveyor = def.conveyor;
    if (def.bouncePower > props.bounce) props.bounce = def.bouncePower;
  }
  return props;
}

/**
 * Do any tiles of this shape overlap the box? For ladder, liquid and hazard
 * checks — the shapes that affect an actor by presence rather than by edge.
 *
 * @param {any} field
 * @param {{x: number, y: number, w: number, h: number}} box
 * @param {string} shape
 */
export function boxTouchesShape(field, box, shape) {
  const ts = field.tileSize;
  const colMin = Math.floor(box.x / ts);
  const colMax = Math.floor((box.x + box.w - 1) / ts);
  const rowMin = Math.floor(box.y / ts);
  const rowMax = Math.floor((box.y + box.h - 1) / ts);
  for (let row = rowMin; row <= rowMax; row += 1) {
    for (let col = colMin; col <= colMax; col += 1) {
      if (tileDefAt(field, col, row).shape === shape) return true;
    }
  }
  return false;
}

/** The worst hazard damage among tiles the box overlaps; 0 when none. */
export function hazardDamageIn(field, box) {
  const ts = field.tileSize;
  const colMin = Math.floor(box.x / ts);
  const colMax = Math.floor((box.x + box.w - 1) / ts);
  const rowMin = Math.floor(box.y / ts);
  const rowMax = Math.floor((box.y + box.h - 1) / ts);
  let worst = 0;
  for (let row = rowMin; row <= rowMax; row += 1) {
    for (let col = colMin; col <= colMax; col += 1) {
      const def = tileDefAt(field, col, row);
      if (def.shape === "hazard" && def.damage > worst) worst = def.damage;
    }
  }
  return worst;
}

/**
 * Move a solid (or platform) actor, carrying riders and — for true solids —
 * pushing what is in the way. A push that cannot complete marks the pushed
 * actor `crushed` and leaves the overlap for the unstick rule to resolve;
 * what being crushed *means* is the world's decision, not this module's.
 *
 * Riders are computed once per call, the standard simplification: an actor
 * standing on the solid when the move begins rides the whole move.
 *
 * @param {any} field
 * @param {any} solid Mutated: x, y, rx, ry.
 * @param {number} dx
 * @param {number} dy
 * @param {any[]} actors Every movable actor that could ride or be pushed
 *        (players included). Iterated in array order — determinism.
 */
export function moveSolidBy(field, solid, dx, dy, actors) {
  const riders = actors.filter((actor) =>
    actor !== solid && actor.alive
    && actor.y + actor.h === solid.y
    && actor.x < solid.x + solid.w && solid.x < actor.x + actor.w);

  solid.rx += dx;
  solid.ry += dy;
  let moveX = Math.round(solid.rx);
  let moveY = Math.round(solid.ry);
  solid.rx -= moveX;
  solid.ry -= moveY;

  const pushes = solid.solid === true;
  const signX = moveX > 0 ? 1 : -1;
  while (moveX !== 0) {
    solid.x += signX;
    for (const actor of actors) {
      if (actor === solid || !actor.alive) continue;
      if (pushes && rectsOverlap(actor.x, actor.y, actor.w, actor.h, solid.x, solid.y, solid.w, solid.h)) {
        const pushed = moveActorX(field, actor, signX, { glue: false });
        if (pushed.hitWall) actor.crushed = true;
      } else if (riders.includes(actor)) {
        moveActorX(field, actor, signX);
      }
    }
    moveX -= signX;
  }

  const signY = moveY > 0 ? 1 : -1;
  while (moveY !== 0) {
    solid.y += signY;
    for (const actor of actors) {
      if (actor === solid || !actor.alive) continue;
      if (pushes && rectsOverlap(actor.x, actor.y, actor.w, actor.h, solid.x, solid.y, solid.w, solid.h)) {
        const before = actor.y;
        moveActorY(field, actor, signY, { nudge: 0 });
        if (actor.y === before) actor.crushed = true;
      } else if (riders.includes(actor)) {
        // Carried down and sideways; a solid moving up pushes instead.
        if (signY > 0) moveActorY(field, actor, 1);
        else if (actor.y + actor.h === solid.y + 1) actor.y = solid.y - actor.h;
      }
    }
    moveY -= signY;
  }
}
