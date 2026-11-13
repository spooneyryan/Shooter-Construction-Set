// @ccllc/arcade/cannon — the cannon genre: artillery versus arrangement.
//
// The genre layer over `../physics`, a sibling of `shmup` and `runnjump`:
// `physics` owns motion, and this owns the game — materials, damage,
// targets, ammunition, turns, score, outcome, the level document, and the
// recorder. Depends on `core`, `net` and `physics`, and on nothing else —
// no DOM, no clock, no randomness.
//
// The layers, in the order a game meets them:
//
//   contract   what a level says: materials, blocks, cannons, rules, input
//   world      the step — createSiege, snapshot, restore, events
//   document   a level as a save file and a share link
//   replay     a round as the inputs that produced it
//
// Bit-deterministic ACROSS MACHINES, like `runnjump` and unlike `shmup`:
// the engine underneath is `+ - * /` and Math.sqrt with rotation through
// `core/trig`, and this layer adds comparisons. The guard test bans the
// rest. That is the property co-op stands on.
//
// Drawing is not here and will not be. Read `siege.physics.bodies` after a
// step and draw them however the game likes; drive sounds and effects from
// `drainEvents()`, never from inside the step.

export * from "./contract.js";
export * from "./document.js";
export { createSiege } from "./world.js";
export { cannonPadActions, cannonPadSticks, createCannonRecorder, replaySiege } from "./replay.js";
