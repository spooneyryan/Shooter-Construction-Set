// Hitboxes: the shape a thing is struck within, when a circle is not enough.
//
// A sprite is not round. The circle the world has always tested against covers
// the art and a good deal of empty space around it, so a shot that visibly
// misses a wing still connects. A hitbox is one or more shapes -- circles and
// polygons -- in the sprite's own frame, and the world tests against those
// instead when an item carries one. An item without one is struck exactly as
// it always was.
//
// The frame: the sprite as drawn at rotation 0, spin 0 and lean 0, x to the
// right and y down, with 1 unit equal to the item's `size` (its half-extent).
// Changing SIZE or SCALE in an editor therefore keeps the hitbox on the art,
// and rotation is applied on top by the world from the same facing the
// renderer draws. Any mirroring a renderer does to the art at rotation 0 is
// part of the frame: a hitbox derived from the drawn picture already has it.
//
// Every test here is a disc against the hitbox, because that is every test the
// world makes: a bullet, the ship's nose and the satellite are all discs. The
// disc is carried into the sprite's frame rather than the shapes carried out,
// which is one rotation instead of one per vertex.
//
// `hitboxFromMask` derives a hitbox from an alpha mask the caller supplies.
// This module never touches a canvas: a mask is width, height and alpha
// values, which a renderer can produce and a Node test can type out. Both
// derivations are deterministic in the mask -- scan order breaks every tie --
// so the same picture always yields the same hitbox.
//
// No DOM, no clock, no randomness, and core's trig for the rotation, so a
// replay collides the same way everywhere. Top-level names here all start with
// `hitbox` or `HITBOX`: see tests/flat-scope.test.mjs for why two modules may
// not share one.

import { cos, sin } from "../core/trig.js";

/** More shapes than this is a mesh, not a hitbox. */
export const HITBOX_MAX_SHAPES = 48;
/** More points than this on one polygon is a curve pretending. */
export const HITBOX_MAX_POINTS = 64;
/** Coordinates and radii live within this many sizes of the centre. */
const HITBOX_LIMIT = 4;

const hitboxFinite = (value, fallback) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const hitboxClamp = (value, low, high) => Math.min(high, Math.max(low, value));

/**
 * A valid hitbox from whatever was saved, or undefined when there is nothing
 * usable -- which the world reads as "the circle, as always". Shapes that do
 * not parse are dropped rather than failing the whole box; a polygon needs
 * three distinct points to be a polygon at all. `reach`, the farthest any
 * shape extends from the centre in sprite units, is recomputed every time
 * because a stale one would let the broad phase reject a real hit.
 *
 * @param {unknown} input
 * @returns {{ shapes: Array<{kind: "circle", x: number, y: number, r: number} | {kind: "polygon", points: Array<{x: number, y: number}>}>, reach: number } | undefined}
 */
export function normalizeHitbox(input) {
  if (!input || typeof input !== "object" || !("shapes" in input) || !Array.isArray(input.shapes)) return undefined;
  /** @type {NonNullable<ReturnType<typeof normalizeHitbox>>["shapes"]} */
  const shapes = [];
  for (const raw of input.shapes) {
    if (shapes.length >= HITBOX_MAX_SHAPES) break;
    if (!raw || typeof raw !== "object") continue;
    if (raw.kind === "circle") {
      const r = hitboxFinite(raw.r, 0);
      if (!(r > 0)) continue;
      shapes.push({
        kind: "circle",
        x: hitboxClamp(hitboxFinite(raw.x, 0), -HITBOX_LIMIT, HITBOX_LIMIT),
        y: hitboxClamp(hitboxFinite(raw.y, 0), -HITBOX_LIMIT, HITBOX_LIMIT),
        r: hitboxClamp(r, 0, HITBOX_LIMIT),
      });
    } else if (raw.kind === "polygon" && Array.isArray(raw.points)) {
      const points = [];
      for (const point of raw.points) {
        if (points.length >= HITBOX_MAX_POINTS) break;
        if (!point || typeof point !== "object") continue;
        const x = hitboxFinite(point.x, NaN);
        const y = hitboxFinite(point.y, NaN);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const next = { x: hitboxClamp(x, -HITBOX_LIMIT, HITBOX_LIMIT), y: hitboxClamp(y, -HITBOX_LIMIT, HITBOX_LIMIT) };
        const last = points[points.length - 1];
        if (last && last.x === next.x && last.y === next.y) continue;
        points.push(next);
      }
      // A closing point that repeats the first is the same polygon once.
      if (points.length > 1 && points[0].x === points[points.length - 1].x && points[0].y === points[points.length - 1].y) points.pop();
      if (points.length >= 3) shapes.push({ kind: "polygon", points });
    }
  }
  if (!shapes.length) return undefined;
  return { shapes, reach: hitboxReach({ shapes }) };
}

/**
 * How far the hitbox extends from the sprite's centre, in sprite units. The
 * broad phase: a disc farther than this times the item's extent, plus its own
 * radius, cannot be touching anything.
 */
export function hitboxReach(hitbox) {
  let reach = 0;
  for (const shape of hitbox.shapes) {
    if (shape.kind === "circle") reach = Math.max(reach, Math.sqrt(shape.x * shape.x + shape.y * shape.y) + shape.r);
    else for (const point of shape.points) reach = Math.max(reach, Math.sqrt(point.x * point.x + point.y * point.y));
  }
  return reach;
}

/**
 * Whether a disc in world units strikes a hitbox.
 *
 * @param {{shapes: Array<object>, reach?: number}} hitbox
 * @param {number} centerX World position of the sprite's centre.
 * @param {number} centerY
 * @param {number} extent World units per sprite unit: the item's size times its scale.
 * @param {number} facingDegrees The sprite's drawn rotation -- authored rotation, spin and lean together, as the renderer adds them. Clockwise on screen, y down.
 * @param {number} x The disc's centre, in world units.
 * @param {number} y
 * @param {number} radius The disc's radius, in world units.
 */
export function hitboxHitsCircle(hitbox, centerX, centerY, extent, facingDegrees, x, y, radius) {
  if (!hitbox || !(extent > 0)) return false;
  const dx = x - centerX;
  const dy = y - centerY;
  const reach = (hitbox.reach ?? hitboxReach(hitbox)) * extent + radius;
  if (dx * dx + dy * dy > reach * reach) return false;
  // Into the sprite's frame: turn back by the facing, then to sprite units.
  // Zero is checked before any trigonometry, so an unturned sprite is tested
  // in plain arithmetic.
  let localX = dx;
  let localY = dy;
  if (facingDegrees !== 0) {
    const angle = facingDegrees * Math.PI / 180;
    const c = cos(angle);
    const s = sin(angle);
    localX = dx * c + dy * s;
    localY = dy * c - dx * s;
  }
  localX /= extent;
  localY /= extent;
  const localRadius = radius / extent;
  for (const shape of hitbox.shapes) {
    if (shape.kind === "circle") {
      const ex = localX - shape.x;
      const ey = localY - shape.y;
      const rr = localRadius + shape.r;
      if (ex * ex + ey * ey <= rr * rr) return true;
    } else if (hitboxPolygonHitsDisc(shape.points, localX, localY, localRadius)) return true;
  }
  return false;
}

/**
 * A disc against one polygon, concave allowed: inside by the even-odd rule,
 * or within the radius of an edge. Squared distances throughout, so there is
 * no root to round.
 */
function hitboxPolygonHitsDisc(points, x, y, radius) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i];
    const b = points[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  if (inside) return true;
  const rr = radius * radius;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    if (hitboxSegmentDistanceSq(points[j], points[i], x, y) <= rr) return true;
  }
  return false;
}

/** Squared distance from a point to a segment. */
function hitboxSegmentDistanceSq(a, b, x, y) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = x - a.x;
  const apy = y - a.y;
  const lengthSq = abx * abx + aby * aby;
  const t = lengthSq === 0 ? 0 : hitboxClamp((apx * abx + apy * aby) / lengthSq, 0, 1);
  const ex = apx - abx * t;
  const ey = apy - aby * t;
  return ex * ex + ey * ey;
}

// --- deriving a hitbox from a picture ---------------------------------------------

/**
 * A hitbox read off an alpha mask: the outline of the solid pixels as
 * polygons, or a cover of circles that stay inside them.
 *
 * The mask is `width` by `height` alpha values, 0 to 255, row-major, with the
 * sprite's centre at (`centerX`, `centerY`) in pixels and `extent` pixels to
 * one sprite unit -- a renderer that draws the sprite with half-extent E into
 * a 2E square leaves both at their defaults. Pixels at or above `threshold`
 * are solid.
 *
 * "outline": each connected patch of solid pixels (8-connected, patches
 * smaller than `minShare` of the whole dropped as specks) is traced round its
 * outside -- holes are filled, a hitbox with a hole is a hitbox that lets a
 * shot through the middle of a ship -- and simplified to within `tolerance`
 * sprite units, raising the tolerance until the polygon fits in
 * `maxPoints`.
 *
 * "circles": up to `circles` discs, placed greedily at the solid pixel
 * farthest from any edge that no disc has covered yet, each as large as fits
 * inside the art, until `coverage` of the solid pixels lie within a pixel of
 * one, or the largest disc that would still fit is under `minRadius` sprite
 * units. Tight by construction: no circle reaches past the picture, which
 * means the corners of a boxy sprite go a little uncovered rather than the
 * space around it going covered.
 *
 * Both are deterministic in the mask: scan order breaks every tie.
 *
 * @param {{width: number, height: number, alpha: ArrayLike<number>, threshold?: number, extent?: number, centerX?: number, centerY?: number}} mask
 * @param {{mode?: "outline" | "circles", tolerance?: number, maxPoints?: number, minShare?: number, circles?: number, coverage?: number, minRadius?: number}} [options]
 * @returns {ReturnType<typeof normalizeHitbox>}
 */
export function hitboxFromMask(mask, options = {}) {
  const width = Math.max(0, Math.floor(hitboxFinite(mask?.width, 0)));
  const height = Math.max(0, Math.floor(hitboxFinite(mask?.height, 0)));
  if (!width || !height || !mask.alpha || mask.alpha.length < width * height) return undefined;
  const threshold = hitboxClamp(hitboxFinite(mask.threshold, 128), 1, 255);
  const extent = hitboxFinite(mask.extent, width / 2);
  const centerX = hitboxFinite(mask.centerX, width / 2);
  const centerY = hitboxFinite(mask.centerY, height / 2);
  if (!(extent > 0)) return undefined;
  const solid = new Uint8Array(width * height);
  let count = 0;
  for (let i = 0; i < width * height; i += 1) {
    if (mask.alpha[i] >= threshold) { solid[i] = 1; count += 1; }
  }
  if (!count) return undefined;
  const toUnits = (px, py) => ({ x: (px - centerX) / extent, y: (py - centerY) / extent });
  const shapes = options.mode === "circles"
    ? hitboxCircleCover(solid, width, height, count, options, toUnits, extent)
    : hitboxOutlines(solid, width, height, count, options, toUnits, extent);
  return normalizeHitbox({ shapes });
}

/** The solid pixels grouped into 8-connected patches, each a list of indices in scan order of discovery. */
function hitboxPatches(solid, width, height) {
  const seen = new Uint8Array(solid.length);
  const patches = [];
  const stack = [];
  for (let start = 0; start < solid.length; start += 1) {
    if (!solid[start] || seen[start]) continue;
    const patch = [];
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const index = stack.pop();
      patch.push(index);
      const x = index % width;
      const y = (index - x) / width;
      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          if (!ox && !oy) continue;
          const nx = x + ox;
          const ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = ny * width + nx;
          if (solid[next] && !seen[next]) { seen[next] = 1; stack.push(next); }
        }
      }
    }
    patches.push(patch);
  }
  return patches;
}

function hitboxOutlines(solid, width, height, count, options, toUnits, extent) {
  const minShare = hitboxClamp(hitboxFinite(options.minShare, 0.004), 0, 1);
  const maxPoints = hitboxClamp(Math.floor(hitboxFinite(options.maxPoints, 32)), 3, HITBOX_MAX_POINTS);
  // Never finer than a pixel and a half: the trace runs through pixel centres,
  // so a concave corner carries a one-pixel diagonal that is the raster's, not
  // the picture's, and a finer tolerance would keep it as a corner.
  const baseTolerance = Math.max(1.5, Math.max(0, hitboxFinite(options.tolerance, 0.03)) * extent);
  const patches = hitboxPatches(solid, width, height);
  const largest = patches.reduce((best, patch) => Math.max(best, patch.length), 0);
  const shapes = [];
  for (const patch of patches) {
    // Specks go, but never the biggest patch: a hitbox with nothing in it is
    // not a hitbox.
    if (patch.length < minShare * count && patch.length !== largest) continue;
    const member = new Uint8Array(solid.length);
    for (const index of patch) member[index] = 1;
    const ring = hitboxTraceOutline(member, width, height, patch[0]);
    if (ring.length < 3) continue;
    let tolerance = baseTolerance;
    let simplified = hitboxSimplifyRing(ring, tolerance);
    // A curve wants more points than fit; loosen until it does.
    while (simplified.length > maxPoints) {
      tolerance = tolerance ? tolerance * 1.5 : 0.5;
      simplified = hitboxSimplifyRing(ring, tolerance);
    }
    if (simplified.length >= 3) shapes.push({ kind: "polygon", points: simplified.map((point) => toUnits(point.x, point.y)) });
  }
  return shapes;
}

/**
 * The outer boundary of one 8-connected patch, as pixel centres, by
 * Moore-neighbour tracing from its first pixel in scan order with Jacob's
 * stopping criterion. Pixel centres sit half a pixel inside the true edge;
 * at any useful extent that is nothing, and tight beats loose for a hitbox.
 */
function hitboxTraceOutline(member, width, height, start) {
  const at = (x, y) => x >= 0 && y >= 0 && x < width && y < height && member[y * width + x] === 1;
  // Clockwise on screen (y down), starting from the west neighbour.
  const around = [[-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1]];
  const startX = start % width;
  const startY = (start - startX) / width;
  const ring = [{ x: startX + 0.5, y: startY + 0.5 }];
  let x = startX;
  let y = startY;
  // The first pixel in scan order has nothing solid to its west or in the row
  // above, so "we came from the west" is a true backtrack to start from.
  let from = 0;
  let steps = 0;
  const limit = width * height * 4 + 8;
  let firstMove = -1;
  while (steps < limit) {
    steps += 1;
    let found = -1;
    for (let k = 1; k <= 8; k += 1) {
      const direction = (from + k) % 8;
      const [ox, oy] = around[direction];
      if (at(x + ox, y + oy)) { found = direction; break; }
    }
    if (found < 0) break; // a lone pixel
    if (x === startX && y === startY) {
      // Jacob's stopping criterion: back at the start and about to leave it
      // the way we first did, so everything from here would be a retrace. A
      // start pixel the outline passes through twice is left the second time
      // by a different neighbour, and the trace rightly goes on.
      if (firstMove < 0) firstMove = found;
      else if (found === firstMove) break;
    }
    x += around[found][0];
    y += around[found][1];
    ring.push({ x: x + 0.5, y: y + 0.5 });
    // The next scan starts at the neighbour examined just before the one we
    // moved to -- empty, by construction -- seen from where we now stand. For
    // a straight step that is five places on from the move; for a diagonal
    // step, four.
    from = (found + (found % 2 === 1 ? 4 : 5)) % 8;
  }
  // The final arrival back at the start is the start itself; drop it.
  if (ring.length > 1 && ring[ring.length - 1].x === ring[0].x && ring[ring.length - 1].y === ring[0].y) ring.pop();
  return ring;
}

/**
 * Ramer-Douglas-Peucker on a closed ring: split at the two points farthest
 * apart, simplify each half as an open chain, join. Within `tolerance` pixels.
 */
function hitboxSimplifyRing(ring, tolerance) {
  if (ring.length <= 3) return ring.slice();
  let a = 0;
  let b = 0;
  let best = -1;
  for (let i = 0; i < ring.length; i += 1) {
    for (let j = i + 1; j < ring.length; j += 1) {
      const dx = ring[i].x - ring[j].x;
      const dy = ring[i].y - ring[j].y;
      const d = dx * dx + dy * dy;
      if (d > best) { best = d; a = i; b = j; }
    }
  }
  const first = ring.slice(a, b + 1);
  const second = ring.slice(b).concat(ring.slice(0, a + 1));
  const left = hitboxSimplifyChain(first, tolerance);
  const right = hitboxSimplifyChain(second, tolerance);
  // Each chain carries both split points; the join must not repeat them.
  return left.slice(0, -1).concat(right.slice(0, -1));
}

function hitboxSimplifyChain(chain, tolerance) {
  if (chain.length < 3) return chain.slice();
  const keep = new Uint8Array(chain.length);
  keep[0] = 1;
  keep[chain.length - 1] = 1;
  const stack = [[0, chain.length - 1]];
  const limitSq = tolerance * tolerance;
  while (stack.length) {
    const [start, end] = stack.pop();
    let farthest = -1;
    let farthestSq = limitSq;
    for (let i = start + 1; i < end; i += 1) {
      const d = hitboxSegmentDistanceSq(chain[start], chain[end], chain[i].x, chain[i].y);
      if (d > farthestSq) { farthestSq = d; farthest = i; }
    }
    if (farthest >= 0) {
      keep[farthest] = 1;
      stack.push([start, farthest], [farthest, end]);
    }
  }
  const out = [];
  for (let i = 0; i < chain.length; i += 1) if (keep[i]) out.push(chain[i]);
  return out;
}

/**
 * Exact squared Euclidean distance from every pixel to the nearest non-solid
 * pixel, the image border counting as non-solid. Felzenszwalb and
 * Huttenlocher's lower-envelope pass, once along rows and once down columns,
 * in integer arithmetic until the very end.
 */
function hitboxDistanceSq(solid, width, height) {
  const INF = (width + height + 2) * (width + height + 2);
  const f = new Float64Array(width * height);
  for (let i = 0; i < f.length; i += 1) f[i] = solid[i] ? INF : 0;
  const pass = (line, out, n) => {
    const v = new Int32Array(n);
    const z = new Float64Array(n + 1);
    let k = 0;
    v[0] = 0;
    z[0] = -Infinity;
    z[1] = Infinity;
    for (let q = 1; q < n; q += 1) {
      let s = ((line[q] + q * q) - (line[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k -= 1;
        s = ((line[q] + q * q) - (line[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k += 1;
      v[k] = q;
      z[k] = s;
      z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < n; q += 1) {
      while (z[k + 1] < q) k += 1;
      out[q] = (q - v[k]) * (q - v[k]) + line[v[k]];
    }
  };
  // Rows, with a virtual border pixel at distance 0 on each side: handled by
  // padding each line by one on both ends.
  const rowIn = new Float64Array(width + 2);
  const rowOut = new Float64Array(width + 2);
  for (let y = 0; y < height; y += 1) {
    rowIn[0] = 0;
    rowIn[width + 1] = 0;
    for (let x = 0; x < width; x += 1) rowIn[x + 1] = f[y * width + x];
    pass(rowIn, rowOut, width + 2);
    for (let x = 0; x < width; x += 1) f[y * width + x] = rowOut[x + 1];
  }
  const colIn = new Float64Array(height + 2);
  const colOut = new Float64Array(height + 2);
  for (let x = 0; x < width; x += 1) {
    colIn[0] = 0;
    colIn[height + 1] = 0;
    for (let y = 0; y < height; y += 1) colIn[y + 1] = f[y * width + x];
    pass(colIn, colOut, height + 2);
    for (let y = 0; y < height; y += 1) f[y * width + x] = colOut[y + 1];
  }
  return f;
}

function hitboxCircleCover(solid, width, height, count, options, toUnits, extent) {
  const maxCircles = hitboxClamp(Math.floor(hitboxFinite(options.circles, 12)), 1, HITBOX_MAX_SHAPES);
  const coverage = hitboxClamp(hitboxFinite(options.coverage, 0.96), 0.1, 1);
  // A disc smaller than this is not covering anything a shot could tell apart
  // from the edge of a bigger one; the rim of a round sprite would otherwise
  // be tiled with them.
  const minRadius = Math.max(0.5, hitboxFinite(options.minRadius, 0.04) * extent);
  const distanceSq = hitboxDistanceSq(solid, width, height);
  const covered = new Uint8Array(solid.length);
  let coveredCount = 0;
  const shapes = [];
  while (shapes.length < maxCircles && coveredCount < coverage * count) {
    // The uncovered solid pixel deepest inside the art; scan order breaks ties.
    let best = -1;
    let bestSq = 0;
    for (let i = 0; i < solid.length; i += 1) {
      if (solid[i] && !covered[i] && distanceSq[i] > bestSq) { bestSq = distanceSq[i]; best = i; }
    }
    if (best < 0 || Math.sqrt(bestSq) - 0.5 < minRadius) break;
    const px = best % width;
    const py = (best - px) / width;
    // The distance runs to the nearest empty pixel's centre; half a pixel back
    // keeps the disc inside the art rather than kissing the space beyond it.
    const radius = Math.max(0.5, Math.sqrt(bestSq) - 0.5);
    const cx = px + 0.5;
    const cy = py + 0.5;
    // Covered, for the purpose of deciding whether to keep placing discs, is
    // within a pixel of the disc's edge: the raster is that coarse, and a
    // pixel it would take a one-pixel disc to claim is not worth one.
    const reachSq = (radius + 1) * (radius + 1);
    const x0 = Math.max(0, Math.floor(cx - radius - 1));
    const x1 = Math.min(width - 1, Math.ceil(cx + radius + 1));
    const y0 = Math.max(0, Math.floor(cy - radius - 1));
    const y1 = Math.min(height - 1, Math.ceil(cy + radius + 1));
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const i = y * width + x;
        if (!solid[i] || covered[i]) continue;
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= reachSq) { covered[i] = 1; coveredCount += 1; }
      }
    }
    const centre = toUnits(cx, cy);
    shapes.push({ kind: "circle", x: centre.x, y: centre.y, r: radius / extent });
  }
  return shapes;
}
