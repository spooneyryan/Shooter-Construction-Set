// Formations, and turning an authored level into the entities a run consists of.
//
// This is the generator proper. Everything else in this package is bookkeeping
// around it: one placed group becomes N entities, arranged, rotated and scaled,
// each carrying its own firing phase.

import { cos, sin } from "../core/trig.js";

/**
 * The offsets of a formation's members, relative to where it was placed.
 *
 * Returns a single zero offset for an item with no group, so a caller can treat
 * every item as a formation of at least one and never branch.
 *
 * @param {{count: number, pattern: "line"|"vee"|"ring", spacing: number}} [group]
 * @param {number} [rotation] Degrees.
 * @param {number} [scale]
 * @returns {{x: number, y: number}[]}
 */
/**
 * The row pitch that makes a wedge pack hexagonally: the height of a unit
 * equilateral triangle, so a member and both its neighbours in the row behind
 * sit exactly `spacing` apart. Computed rather than typed, because Math.sqrt
 * is required to be correctly rounded and 0.866 is not it.
 */
const WEDGE_PITCH = Math.sqrt(3) / 2;

/**
 * The golden angle. Turning by it each member is what stops three of them ever
 * lining up into a spoke, which is what makes a cluster read as a swarm rather
 * than a flower.
 */
const CLUSTER_TURN = Math.PI * (3 - Math.sqrt(5));

/** How wide a crescent opens, and the most one member may turn from the next. */
const CRESCENT_SWEEP = Math.PI * 2 / 3;
const CRESCENT_STEP = 0.4;

export function groupOffsets(group, rotation = 0, scale = 1) {
  if (!group) return [{ x: 0, y: 0 }];
  const { count, pattern, spacing } = group;
  let offsets;
  if (pattern === "line") {
    offsets = Array.from({ length: count }, (_, i) => ({ x: 0, y: (i - (count - 1) / 2) * spacing }));
  } else if (pattern === "ring") {
    offsets = Array.from({ length: count }, (_, i) => {
      const angle = (i / count) * Math.PI * 2;
      return { x: cos(angle) * spacing, y: sin(angle) * spacing };
    });
  } else if (pattern === "column") {
    // Single file along the scroll axis: a line turned a quarter, but with the
    // sprites left upright. It is its own pattern rather than `line` at
    // rotation 90 because rotation is also the facing the world aims a mounted
    // gun by -- a file turned that way would fire up the screen.
    offsets = Array.from({ length: count }, (_, i) => ({ x: (i - (count - 1) / 2) * spacing, y: 0 }));
  } else if (pattern === "block") {
    // The phalanx: the only shape whose cross-extent grows as the square root
    // of the count rather than the count. Sixteen members are four ranks of
    // four; a line of sixteen is fifteen spacings and hangs off the screen.
    // Ranks run across in y, and the block is as deep in x as it needs to be.
    const across = Math.max(1, Math.round(Math.sqrt(count)));
    const deep = Math.ceil(count / across);
    offsets = Array.from({ length: count }, (_, i) => ({
      x: (Math.floor(i / across) - (deep - 1) / 2) * spacing,
      y: ((i % across) - (across - 1) / 2) * spacing,
    }));
  } else if (pattern === "wedge") {
    // A filled delta where the vee is a hollow one: rows of 1, 2, 3, ... so
    // the leader flies alone and every rank behind is one wider. The pitch
    // makes the packing hexagonal, which is what stops it reading as a grid
    // with a bite out of it.
    offsets = Array.from({ length: count }, (_, i) => {
      let row = 0;
      let placed = 0;
      while (placed + row + 1 <= i) { placed += row + 1; row += 1; }
      const inRow = i - placed;
      return { x: row * spacing * WEDGE_PITCH, y: (inRow - row / 2) * spacing };
    });
  } else if (pattern === "ladder") {
    // Two rails with an open lane between them, marching along the flight
    // axis: the corridor an author leaves for the player to thread. The lane
    // is empty at every count -- an odd member joins a rail rather than
    // standing in the middle -- so the lane is always two spacings wide
    // however deep the gauntlet runs.
    offsets = Array.from({ length: count }, (_, i) => {
      const rung = Math.floor(i / 2);
      const rungs = Math.ceil(count / 2);
      return { x: (rung - (rungs - 1) / 2) * spacing, y: (i % 2 === 0 ? -1 : 1) * spacing };
    });
  } else if (pattern === "crescent") {
    // A rank bent into a bow with its wings thrown forward: the concave
    // complement of the vee. The sweep stops it curling into the ring, and the
    // step stops a small count reading as a wide-angled pair.
    const sweep = Math.min(CRESCENT_SWEEP, CRESCENT_STEP * Math.max(1, count - 1));
    offsets = Array.from({ length: count }, (_, i) => {
      const t = count === 1 ? 0 : (i / (count - 1) - 0.5) * sweep;
      const radius = spacing * Math.max(1, count - 1) / Math.max(sweep, 1e-6);
      return { x: radius * (1 - cos(t)), y: radius * sin(t) };
    });
  } else if (pattern === "cluster") {
    // A filled disc rather than an outline: phyllotaxis, the placement a
    // sunflower uses. The square root is what makes it a disc instead of a
    // spiral -- member i sits at a radius proportional to sqrt(i), so the
    // count inside any radius grows with that radius's area.
    offsets = Array.from({ length: count }, (_, i) => {
      const radius = spacing * Math.sqrt(i) / 2;
      const angle = i * CLUSTER_TURN;
      return { x: cos(angle) * radius, y: sin(angle) * radius };
    });
  } else {
    offsets = Array.from({ length: count }, (_, i) => {
      const offset = i - (count - 1) / 2;
      // The x term is the vee: members further from the centre sit further
      // forward. 0.72 is what makes the angle read as a V rather than a line
      // with a kink, and is the one number here chosen by eye.
      return { x: Math.abs(offset) * spacing * 0.72, y: offset * spacing };
    });
  }
  const radians = rotation * Math.PI / 180;
  const cosine = cos(radians);
  const sine = sin(radians);
  return offsets.map((offset) => ({
    x: (offset.x * cosine - offset.y * sine) * scale,
    y: (offset.x * sine + offset.y * cosine) * scale,
  }));
}

/**
 * Expand a level's items into runtime entities.
 *
 * A group becomes `count` entities of type `enemy`, each remembering the
 * `sourceId` it came from so an editor can map a runtime entity back to the
 * thing the author placed.
 *
 * @param {{items: any[]}} level
 */
/**
 * The order a formation's members leave in: from the front of the flight
 * outward, so the leader goes first and the tips of a vee go last.
 *
 * Sorted on the offsets the author actually authored rather than on the index,
 * because the index is placement order and says nothing about who is in front.
 * The comparison ends in the index so the result never depends on the sort
 * being stable, and it is rounded before comparing because a rotated formation
 * carries float dust -- a line at rotation 180 has x values of 1e-15 that
 * would otherwise decide the whole queue.
 */
function peelRanks(offsets) {
  const round = (value) => Math.round(value * 1000) / 1000;
  return offsets
    .map((offset, index) => ({ index, front: round(offset.x), out: round(Math.abs(offset.y)) }))
    .sort((a, b) => a.front - b.front || a.out - b.out || a.index - b.index)
    .reduce((ranks, entry, rank) => { ranks[entry.index] = rank; return ranks; }, []);
}

export function expandLevel(level) {
  return level.items.flatMap((item) => {
    const offsets = groupOffsets(item.group, item.rotation, item.scale);
    // Only computed when it is asked for: every level before this leaves as one.
    const ranks = item.group?.peel ? peelRanks(offsets) : undefined;
    return offsets.map((offset, index) => ({
    ...item,
    id: `${item.id}-${index}`,
    type: item.type === "group" ? "enemy" : item.type,
    sourceId: item.id,
    originX: item.x + offset.x,
    originY: item.y + offset.y,
    x: item.x + offset.x,
    y: item.y + offset.y,
    age: 0,
    phase: 0,
    vx: 0,
    vy: 0,
    turned: 0,
    hp: item.hitPoints,
    shield: item.armor?.type === "forcefield" ? item.armor.capacity : 0,
    shieldWait: 0,
    // Staggered by index so a formation does not fire as one gun. Deterministic
    // on purpose: a random stagger would be the nicer effect and the wrong
    // mechanism, since it would have to be seeded and carried through a replay
    // to buy something a multiplication already gives for free.
    fireTimer: item.weapon.cooldown + index * 0.16,
    // Where in the queue this member leaves, and the point the author placed
    // the formation at. The anchor is what the lock is resolved from, so a
    // formation latches ONE heading for all of its members -- resolved per
    // member, five ships sight the player on five different frames and the
    // wave arrives bent by however far the ship moved in between.
    ...(ranks ? { peelRank: ranks[index] } : {}),
    anchorX: item.x,
    anchorY: item.y,
    /** Set by the world at the instant this thing is released. Absent until then. */
    releaseAge: undefined,
    flightMovement: undefined,
    alive: true,
    active: false,
  }));
  });
}
