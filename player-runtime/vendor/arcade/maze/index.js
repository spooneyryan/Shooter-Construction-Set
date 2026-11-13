// @ccllc/arcade/maze — the grid genre: corridors, bombs, and the last one
// standing.
//
// A sibling of `shmup`, `runnjump` and `cannon`: `core` is the general
// runtime, and a genre belongs beside it. Depends on `core` and `net`, and
// on nothing else — no DOM, no clock, and **no randomness anywhere in the
// genre**: drops are authored, enemies are fixed rules, and the inputs are
// four directions and a button. That makes this the most deterministic
// genre in the package, which is why it exists to be the co-op flagship.
//
// The layers, in the order a game meets them:
//
//   contract   what a level says: tiles, spawns, drops, rules, input
//   world      the step — createMaze, snapshot, restore, events
//   document   a level as a save file and a share link
//   replay     a round as the inputs that produced it
//
// It is also the first game consumer of `core/stick`'s four-way gate —
// shipped 2026-08-25 with the roll-the-gate rule and, until this module,
// consumed by nothing.
//
// Drawing is not here and will not be. Read `maze.tiles()` and
// `maze.state` after a step and draw them however the game likes; drive
// sounds and effects from `drainEvents()`, never from inside the step.

export * from "./contract.js";
export * from "./document.js";
export { createMaze } from "./world.js";
export { createMazeRecorder, mazePadActions, mazePadSticks, replayMaze } from "./replay.js";
