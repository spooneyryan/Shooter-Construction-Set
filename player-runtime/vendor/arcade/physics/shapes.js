// The geometry half of the physics module: oriented boxes, circles, and the
// contact manifolds between them. Pure functions of their arguments — no body
// state, no world, nothing drawn — so every case is testable by itself.
//
// The box-box case is the classic clipping SAT (Box2D-Lite's Collide): find
// the axis of least penetration among the four face normals, take the most
// anti-parallel face of the other box as the incident edge, clip it against
// the sides of the reference face, and keep what lies behind the face. Up to
// two contact points, which is what makes a box RESting on another box stable
// — a single point lets it seesaw forever.
//
// Determinism: everything is + - * / and Math.sqrt (pinned by the spec), with
// the body's rotation entering as a cosine/sine pair the caller computed via
// core/trig. Comparisons break ties the same way on every machine because the
// operand order is fixed, not because of any epsilon.

/**
 * @typedef {object} Contact
 * @property {number} x  World-space contact point.
 * @property {number} y
 * @property {number} nx World-space normal, unit length, pointing from A to B.
 * @property {number} ny
 * @property {number} penetration Overlap depth along the normal, >= 0.
 */

/** The four corners of an oriented box, counter-clockwise in screen space. */
export function boxCorners(cx, cy, halfW, halfH, cos, sin) {
  const ex = halfW * cos;
  const ey = halfW * sin;
  const fx = -halfH * sin;
  const fy = halfH * cos;
  return [
    { x: cx - ex - fx, y: cy - ey - fy },
    { x: cx + ex - fx, y: cy + ey - fy },
    { x: cx + ex + fx, y: cy + ey + fy },
    { x: cx - ex + fx, y: cy - ey + fy },
  ];
}

/** Axis-aligned bounds of an oriented box — the broadphase rectangle. */
export function boxAabb(cx, cy, halfW, halfH, cos, sin) {
  const extentX = halfW * (cos < 0 ? -cos : cos) + halfH * (sin < 0 ? -sin : sin);
  const extentY = halfW * (sin < 0 ? -sin : sin) + halfH * (cos < 0 ? -cos : cos);
  return { minX: cx - extentX, minY: cy - extentY, maxX: cx + extentX, maxY: cy + extentY };
}

/** World point -> a box's local frame. */
export function toBoxLocal(px, py, cx, cy, cos, sin) {
  const dx = px - cx;
  const dy = py - cy;
  return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
}

/** Point-in-oriented-box, inclusive of the edge. */
export function pointInBox(px, py, cx, cy, halfW, halfH, cos, sin) {
  const local = toBoxLocal(px, py, cx, cy, cos, sin);
  return local.x >= -halfW && local.x <= halfW && local.y >= -halfH && local.y <= halfH;
}

/**
 * The point on an oriented box nearest to a world point — the box's own
 * surface when the point is outside, the point itself when inside. Explosions
 * use it to apply their impulse where the blast actually reaches the body.
 */
export function closestOnBox(px, py, cx, cy, halfW, halfH, cos, sin) {
  const local = toBoxLocal(px, py, cx, cy, cos, sin);
  const clampedX = local.x < -halfW ? -halfW : local.x > halfW ? halfW : local.x;
  const clampedY = local.y < -halfH ? -halfH : local.y > halfH ? halfH : local.y;
  return {
    x: cx + clampedX * cos - clampedY * sin,
    y: cy + clampedX * sin + clampedY * cos,
  };
}

/**
 * Circle-circle manifold: one point on the line of centers.
 * @returns {Contact[]} empty when separated.
 */
export function collideCircles(ax, ay, ar, bx, by, br) {
  const dx = bx - ax;
  const dy = by - ay;
  const distanceSq = dx * dx + dy * dy;
  const reach = ar + br;
  if (distanceSq >= reach * reach) return [];
  const distance = Math.sqrt(distanceSq);
  // Coincident centers have no direction; push along +x so the pair separates
  // the same way on every machine instead of dividing by zero.
  const nx = distance > 0 ? dx / distance : 1;
  const ny = distance > 0 ? dy / distance : 0;
  return [{
    x: ax + nx * ar,
    y: ay + ny * ar,
    nx,
    ny,
    penetration: reach - distance,
  }];
}

/**
 * Box-circle manifold: clamp the circle's centre into the box's local frame.
 * The normal points from the box (A) to the circle (B).
 * @returns {Contact[]}
 */
export function collideBoxCircle(cx, cy, halfW, halfH, cos, sin, px, py, radius) {
  const local = toBoxLocal(px, py, cx, cy, cos, sin);
  let nearestX = local.x < -halfW ? -halfW : local.x > halfW ? halfW : local.x;
  let nearestY = local.y < -halfH ? -halfH : local.y > halfH ? halfH : local.y;
  let inside = false;

  if (nearestX === local.x && nearestY === local.y) {
    // Centre inside the box: push out through the nearest face.
    inside = true;
    const gapX = halfW - (local.x < 0 ? -local.x : local.x);
    const gapY = halfH - (local.y < 0 ? -local.y : local.y);
    if (gapX < gapY) nearestX = local.x < 0 ? -halfW : halfW;
    else nearestY = local.y < 0 ? -halfH : halfH;
  }

  const dx = local.x - nearestX;
  const dy = local.y - nearestY;
  const distanceSq = dx * dx + dy * dy;
  if (!inside && distanceSq >= radius * radius) return [];

  const distance = Math.sqrt(distanceSq);
  let localNx;
  let localNy;
  if (inside) {
    localNx = distance > 0 ? -dx / distance : (nearestX === -halfW ? -1 : nearestX === halfW ? 1 : 0);
    localNy = distance > 0 ? -dy / distance : (nearestY === -halfH ? -1 : nearestY === halfH ? 1 : 0);
    if (localNx === 0 && localNy === 0) localNy = -1;
  } else {
    localNx = distance > 0 ? dx / distance : 0;
    localNy = distance > 0 ? dy / distance : -1;
  }

  const nx = localNx * cos - localNy * sin;
  const ny = localNx * sin + localNy * cos;
  return [{
    x: cx + nearestX * cos - nearestY * sin,
    y: cy + nearestX * sin + nearestY * cos,
    nx,
    ny,
    penetration: inside ? radius + distance : radius - distance,
  }];
}

/** Clip a two-point segment against `dot(point, normal) <= offset`, in place-ish. */
function clipSegment(points, nx, ny, offset) {
  const kept = [];
  const d0 = nx * points[0].x + ny * points[0].y - offset;
  const d1 = nx * points[1].x + ny * points[1].y - offset;
  if (d0 <= 0) kept.push(points[0]);
  if (d1 <= 0) kept.push(points[1]);
  if (d0 * d1 < 0) {
    const t = d0 / (d0 - d1);
    kept.push({
      x: points[0].x + t * (points[1].x - points[0].x),
      y: points[0].y + t * (points[1].y - points[0].y),
    });
  }
  return kept;
}

/**
 * Box-box manifold by reference-face clipping. Normals point from A to B.
 *
 * Each box contributes its two face normals as separating-axis candidates;
 * the axis of least penetration wins, with a mild preference for staying on
 * A's axes when the depths are near-equal — the constant relative bias every
 * SAT implementation carries so a resting contact does not flip its reference
 * face every step and jitter. The comparison is deterministic: same operands,
 * same order, same result.
 *
 * @returns {Contact[]} zero, one, or two points.
 */
export function collideBoxes(
  ax, ay, aHalfW, aHalfH, aCos, aSin,
  bx, by, bHalfW, bHalfH, bCos, bSin,
) {
  // B's rotation expressed in A's frame, and vice versa: C = RotA^T * RotB.
  const c00 = aCos * bCos + aSin * bSin;
  const c01 = -aCos * bSin + aSin * bCos;
  const abs00 = c00 < 0 ? -c00 : c00;
  const abs01 = c01 < 0 ? -c01 : c01;

  const dx = bx - ax;
  const dy = by - ay;
  // Centre offset in each frame.
  const dAx = dx * aCos + dy * aSin;
  const dAy = -dx * aSin + dy * aCos;
  const dBx = dx * bCos + dy * bSin;
  const dBy = -dx * bSin + dy * bCos;

  // Face separations; any positive one is a separating axis.
  const faceA0 = (dAx < 0 ? -dAx : dAx) - aHalfW - (abs00 * bHalfW + abs01 * bHalfH);
  const faceA1 = (dAy < 0 ? -dAy : dAy) - aHalfH - (abs01 * bHalfW + abs00 * bHalfH);
  const faceB0 = (dBx < 0 ? -dBx : dBx) - bHalfW - (abs00 * aHalfW + abs01 * aHalfH);
  const faceB1 = (dBy < 0 ? -dBy : dBy) - bHalfH - (abs01 * aHalfW + abs00 * aHalfH);
  if (faceA0 > 0 || faceA1 > 0 || faceB0 > 0 || faceB1 > 0) return [];

  // Pick the reference face: least penetration, biased to keep A.
  const RELATIVE = 0.95;
  const ABSOLUTE = 0.01;
  let referenceIsA = true;
  let axis = 0;
  let separation = faceA0;
  if (faceA1 > RELATIVE * separation + ABSOLUTE * aHalfH) { axis = 1; separation = faceA1; }
  if (faceB0 > RELATIVE * separation + ABSOLUTE * bHalfW) { referenceIsA = false; axis = 0; separation = faceB0; }
  if (faceB1 > RELATIVE * separation + ABSOLUTE * bHalfH) { referenceIsA = false; axis = 1; separation = faceB1; }

  // Everything below works in world space against the reference box.
  const refCos = referenceIsA ? aCos : bCos;
  const refSin = referenceIsA ? aSin : bSin;
  const refX = referenceIsA ? ax : bx;
  const refY = referenceIsA ? ay : by;
  const refHalf = referenceIsA ? (axis === 0 ? aHalfW : aHalfH) : (axis === 0 ? bHalfW : bHalfH);
  const incCos = referenceIsA ? bCos : aCos;
  const incSin = referenceIsA ? bSin : aSin;
  const incX = referenceIsA ? bx : ax;
  const incY = referenceIsA ? by : ay;
  const incHalfW = referenceIsA ? bHalfW : aHalfW;
  const incHalfH = referenceIsA ? bHalfH : aHalfH;

  // Reference face normal in world space, pointing at the incident box.
  let normalX = axis === 0 ? refCos : -refSin;
  let normalY = axis === 0 ? refSin : refCos;
  const towardX = incX - refX;
  const towardY = incY - refY;
  if (normalX * towardX + normalY * towardY < 0) {
    normalX = -normalX;
    normalY = -normalY;
  }

  // The incident face: the incident box's face most anti-parallel to the
  // reference normal. Its two corners, world space.
  const alongX = normalX * incCos + normalY * incSin;
  const alongY = -normalX * incSin + normalY * incCos;
  let corner0;
  let corner1;
  if ((alongX < 0 ? -alongX : alongX) > (alongY < 0 ? -alongY : alongY)) {
    const sign = alongX > 0 ? -1 : 1;
    corner0 = { x: sign * incHalfW, y: -incHalfH };
    corner1 = { x: sign * incHalfW, y: incHalfH };
  } else {
    const sign = alongY > 0 ? -1 : 1;
    corner0 = { x: -incHalfW, y: sign * incHalfH };
    corner1 = { x: incHalfW, y: sign * incHalfH };
  }
  let face = [
    { x: incX + corner0.x * incCos - corner0.y * incSin, y: incY + corner0.x * incSin + corner0.y * incCos },
    { x: incX + corner1.x * incCos - corner1.y * incSin, y: incY + corner1.x * incSin + corner1.y * incCos },
  ];

  // Clip the incident face to the reference face's two side planes.
  const sideX = -normalY;
  const sideY = normalX;
  const sideHalf = referenceIsA ? (axis === 0 ? aHalfH : aHalfW) : (axis === 0 ? bHalfH : bHalfW);
  const sideCentre = sideX * refX + sideY * refY;
  face = clipSegment(face, sideX, sideY, sideCentre + sideHalf);
  if (face.length < 2) return [];
  face = clipSegment(face, -sideX, -sideY, -(sideCentre - sideHalf));
  if (face.length < 2) return [];

  // Keep the clipped points behind the reference face.
  const faceOffset = normalX * refX + normalY * refY + refHalf;
  const contacts = [];
  for (const point of face) {
    const depth = faceOffset - (normalX * point.x + normalY * point.y);
    if (depth < 0) continue;
    contacts.push({
      x: point.x,
      y: point.y,
      // The caller wants A -> B regardless of which box was the reference.
      nx: referenceIsA ? normalX : -normalX,
      ny: referenceIsA ? normalY : -normalY,
      penetration: depth,
    });
  }
  return contacts;
}
