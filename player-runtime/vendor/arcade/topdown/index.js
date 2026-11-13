// @ccllc/arcade/topdown — the genre that plays from above.
//
// Sword-and-key dungeons, spell-and-loot crawls, and horde arenas: one
// module and three flavours, because they differ in data rather than in
// kind. A sibling of `shmup`, `runnjump`, `cannon` and `maze`. Depends on
// `core`, `patterns` and `net`, and on nothing else — no DOM, no clock.
//
// The layers, in the order a game meets them:
//
//   random     the dice: plain seeded state that a snapshot can hold
//   contract   what a world says: tiles, rooms, doors, actors, feel, input
//   move       how anything moves: pixel stepping on both axes
//   combat     the strike arc, wounds, knockback, the mercy window
//   behaviors  what an enemy does, as data
//   world      the run — createRun, snapshot, restore, events
//   generate   a floor from a seed, connected by construction
//   document   a world as a save file and a share link
//   replay     a run as the inputs that produced it
//   samples    the three proof games, as data
//
// **The format's centre**, and the thing worth reading first: a room is a
// rectangle over the tile grid, not a different structure. A Zelda
// dungeon is many rooms under a `roomFlip` camera; a free-roaming field
// is the degenerate one-room case under `followXY`. Both models, one
// document, no fork — see docs/TOPDOWN.md.
//
// Bit-deterministic across machines, dice included: the arithmetic is
// pinned, angles go through `core/trig`, `patterns` was already moved off
// `Math.sin` for exactly this reason, and the randomness is a plain
// `{seed}` advanced by integer arithmetic and carried in the snapshot. A
// procedural floor is therefore a shareable seed rather than a payload.
//
// Drawing is not here and will not be. Read `run.tiles()` and `run.state`
// after a step; drive sounds and effects from `drainEvents()`, never from
// inside the step.
//
// `topdown` and `createRun` were written as working names and kept as
// real ones (Ryan, 2026-08-30), which is why every export wears a
// `TOPDOWN_`/`Topdown` prefix: those were provisional too, and are not.

export * from "./contract.js";
export * from "./document.js";
export * from "./random.js";
export { generateTopdownFloor } from "./generate.js";
export {
  sampleKeepOfKeys,
  sampleLastStand,
  sampleTheDeep,
  topdownSamples,
} from "./samples.js";
export {
  bodyCenterX,
  bodyCenterY,
  bodyExactX,
  bodyExactY,
  boxesOverlap,
  lineOfSight,
  tileCodeAt,
  tileCodeAtPoint,
} from "./move.js";
export { angleOf, createStrike, strikeCovers, woundBody } from "./combat.js";
export {
  registerTopdownBehavior,
  runTopdownBehavior,
  topdownBehaviorExists,
  topdownBehaviorNames,
} from "./behaviors.js";
export { createRun } from "./world.js";
export {
  createTopdownRecorder,
  replayTopdownRun,
  topdownPadActions,
  topdownPadSticks,
} from "./replay.js";
