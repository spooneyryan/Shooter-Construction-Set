// How anything moves through a top-down map.
//
// The same model `runnjump` uses and for the same reason — a box with an
// integer position and sub-pixel remainders, moved ONE PIXEL AT A TIME
// with a check at each step, so tunnelling is structurally impossible
// rather than a bug fixed twice a year — with everything gravity implies
// taken out. No ground, no slopes, no one-ways, no glue, no step-up: in
// this genre both axes are equal and neither is down.
//
// It is a separate file rather than an import of `runnjump/move.js`
// because that module is almost entirely the parts that do not apply.
// What is shared is the model, which is the part worth sharing.
//
// Two rules are determinism requirements rather than style: axes resolve
// separately, X then Y, always; and every check is on integer boxes, with
// no epsilons anywhere.
//
// Sliding falls out for free and is worth naming, because it is most of
// how a top-down game feels: a body pushed diagonally into a wall spends
// its blocked axis and keeps the other, so it slides along the wall
// instead of stopping dead in a doorway.
//
// Everything here takes a `field` — the run's collision view:
//   { cols, rows, tile, tiles, solids }
// where `tiles` is the grid and `solids` is the list of blocking bodies
// (props). Nothing here reads a clock, an input or a definition.

import { TOPDOWN_WALL, tileStopsBody, tileStopsShot } from "./contract.js";

/**
 * Where a body actually is, to the sub-pixel. **Collide with `x`; draw
 * with this.** `x` is a whole pixel always, because stepping parks the
 * fraction it could not spend in `rx` — so a body moving slower than a
 * pixel per step holds the same `x` for several steps, and a camera or a
 * sprite that reads `x` alone inherits that stutter.
 */
export function bodyExactX(body) {
  return body.x + (body.rx ?? 0);
}

export function bodyExactY(body) {
  return body.y + (body.ry ?? 0);
}

/** The tile code at a cell; out of bounds reads as wall. */
export function tileCodeAt(field, col, row) {
  if (col < 0 || row < 0 || col >= field.cols || row >= field.rows) return TOPDOWN_WALL;
  return field.tiles[row * field.cols + col];
}

/** The tile code under a point, in world pixels. */
export function tileCodeAtPoint(field, px, py) {
  return tileCodeAt(field, Math.floor(px / field.tile), Math.floor(py / field.tile));
}

/** Integer box overlap, half-open on the high edges. */
export function boxesOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;
}

/**
 * Whether `body`'s box would collide with the map or a solid at (x, y).
 * `ignore` skips one body, which is how a solid does not block itself.
 */
export function bodyBlockedAt(field, body, x, y, ignore) {
  const left = Math.floor(x / field.tile);
  const right = Math.floor((x + body.w - 1) / field.tile);
  const top = Math.floor(y / field.tile);
  const bottom = Math.floor((y + body.h - 1) / field.tile);
  for (let row = top; row <= bottom; row += 1) {
    for (let col = left; col <= right; col += 1) {
      if (tileStopsBody(tileCodeAt(field, col, row))) return true;
    }
  }
  for (const solid of field.solids ?? []) {
    if (solid === body || solid === ignore || !solid.alive) continue;
    if (boxesOverlap(x, y, body.w, body.h, solid.x, solid.y, solid.w, solid.h)) return true;
  }
  return false;
}

/**
 * Move a body horizontally by `amount` pixels, one pixel at a time.
 * Returns true if something stopped it — which is what a charging enemy
 * reads to know it hit a wall, and what knockback reads to stop shoving.
 */
export function stepBodyX(field, body, amount) {
  body.rx = (body.rx ?? 0) + amount;
  let steps = Math.round(body.rx);
  if (steps === 0) return false;
  body.rx -= steps;
  const sign = steps > 0 ? 1 : -1;
  while (steps !== 0) {
    if (bodyBlockedAt(field, body, body.x + sign, body.y)) {
      // Spend the remainder too: a body held against a wall must not bank
      // travel it never made and lurch when the wall goes away.
      body.rx = 0;
      return true;
    }
    body.x += sign;
    steps -= sign;
  }
  return false;
}

/** The same, vertically. */
export function stepBodyY(field, body, amount) {
  body.ry = (body.ry ?? 0) + amount;
  let steps = Math.round(body.ry);
  if (steps === 0) return false;
  body.ry -= steps;
  const sign = steps > 0 ? 1 : -1;
  while (steps !== 0) {
    if (bodyBlockedAt(field, body, body.x, body.y + sign)) {
      body.ry = 0;
      return true;
    }
    body.y += sign;
    steps -= sign;
  }
  return false;
}

/**
 * Move on both axes, X then Y. The order is part of the simulation.
 * Returns which axes were blocked, because a slide is exactly "one of
 * these is true and the other is not".
 */
export function stepBody(field, body, dx, dy) {
  const hitX = stepBodyX(field, body, dx);
  const hitY = stepBodyY(field, body, dy);
  return { hitX, hitY };
}

/**
 * Whether a straight line from (x1, y1) to (x2, y2) reaches without
 * crossing a wall — the sight test a chaser and a swing both want. Walks
 * the line a half-tile at a time, which is fine at these distances and
 * exact: the step count comes from integer arithmetic on the distance,
 * not from a tolerance.
 *
 * A pit does not block sight, matching `tileStopsShot`: you can see and
 * shoot across a hole you cannot walk over.
 */
export function lineOfSight(field, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const distance = Math.sqrt(dx * dx + dy * dy);
  const steps = Math.ceil((distance * 2) / field.tile);
  if (steps <= 0) return !tileStopsShot(tileCodeAtPoint(field, x1, y1));
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    if (tileStopsShot(tileCodeAtPoint(field, x1 + dx * t, y1 + dy * t))) return false;
  }
  return true;
}

/** The centre of a body, which is what aiming and arcs measure from. */
export function bodyCenterX(body) {
  return bodyExactX(body) + body.w / 2;
}

export function bodyCenterY(body) {
  return bodyExactY(body) + body.h / 2;
}
