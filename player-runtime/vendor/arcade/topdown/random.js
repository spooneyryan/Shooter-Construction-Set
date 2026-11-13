// Dice that a snapshot can hold.
//
// This is the first genre in the package that cannot go without
// randomness — loot, waves and procedural floors are the point — and the
// decision recorded in docs/TOPDOWN.md is that the randomness lives
// INSIDE the simulation state. That rules out the package's existing
// `createSeededRandom` (net/input-log), which is a closure: its state is
// captured in a function nothing can serialize, so a rollback would rewind
// the world and leave the dice where they were, and two machines would
// diverge on the first roll after a correction.
//
// So: a plain `{seed}` object, advanced by pure integer arithmetic. It
// snapshots because it is data, it restores exactly, and `Math.imul` is
// specified to the bit — unlike the transcendentals `core/trig` exists to
// replace, this needs no approximation, only exactness.
//
// The algorithm and the shape are `@ccllc/coop`'s `RandomState`
// deliberately, rather than accidentally: a game that pairs should meet
// one mental model for randomness, not two. It is copied rather than
// imported because `coop` is a sibling package and the arcade depends on
// no other — and it is here rather than in `core` because one consumer is
// not two. When a second genre wants dice, that is the promotion.

/**
 * @typedef {object} RandomSeed
 * @property {number} seed A signed 32-bit integer: the whole state.
 */

/**
 * @param {number} [seed] Truncated to a signed 32-bit integer.
 * @returns {RandomSeed}
 */
export function createRandomState(seed = 1) {
  return { seed: seed | 0 };
}

/**
 * The next value in [0, 1), advancing `state.seed` in place.
 *
 * mulberry32. Integer arithmetic throughout — `Math.imul` is the 32-bit
 * multiply exactly, not an approximation — so every engine produces the
 * same stream from the same seed.
 *
 * @param {RandomSeed} state
 */
export function randomNext(state) {
  state.seed = (state.seed + 0x6d2b79f5) | 0;
  let t = state.seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * An integer in [0, bound). A bound of zero or less answers 0 rather than
 * NaN: a spawn table that is briefly empty should produce a boring answer,
 * not poison the state and desync at the next fingerprint.
 *
 * @param {RandomSeed} state @param {number} bound
 */
export function randomInt(state, bound) {
  const n = Math.floor(bound);
  if (!(n > 0)) return 0;
  return Math.floor(randomNext(state) * n);
}

/**
 * A value in [min, max). Order-tolerant: a reversed pair is swapped rather
 * than answering NaN.
 *
 * @param {RandomSeed} state @param {number} min @param {number} max
 */
export function randomRange(state, min, max) {
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  return low + randomNext(state) * (high - low);
}

/**
 * One element of `items`, or null when there are none. Null rather than
 * undefined so a snapshot of whatever holds it survives JSON.
 *
 * @template T @param {RandomSeed} state @param {readonly T[]} items
 * @returns {T | null}
 */
export function randomPick(state, items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return items[randomInt(state, items.length)] ?? null;
}

/**
 * A weighted pick: `items` paired with `weight` numbers. Non-positive
 * weights are skipped, and an all-zero table answers null rather than
 * favouring its first row by accident.
 *
 * @template T
 * @param {RandomSeed} state
 * @param {ReadonlyArray<{weight?: number, value: T}>} table
 * @returns {T | null}
 */
export function randomWeighted(state, table) {
  if (!Array.isArray(table) || table.length === 0) return null;
  let total = 0;
  for (const row of table) {
    const weight = Number(row?.weight);
    if (Number.isFinite(weight) && weight > 0) total += weight;
  }
  if (total <= 0) return null;
  let roll = randomNext(state) * total;
  for (const row of table) {
    const weight = Number(row?.weight);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    roll -= weight;
    if (roll < 0) return row.value;
  }
  // Float arithmetic can land exactly on the total; the last eligible row
  // is the honest answer rather than a retry.
  for (let index = table.length - 1; index >= 0; index -= 1) {
    const weight = Number(table[index]?.weight);
    if (Number.isFinite(weight) && weight > 0) return table[index].value;
  }
  return null;
}
