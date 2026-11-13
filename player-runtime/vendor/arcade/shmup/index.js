// @ccllc/arcade/shmup — a scrolling-shooter generator.
//
// A sibling of `core` rather than part of it: `core` is the general runtime
// every game imports, and a genre belongs beside it, not inside it. Depends on
// `core` and on nothing else — no DOM, no clock, no randomness.
//
// The layers, in the order a game meets them:
//
//   contract   what a level is made of, and what a valid one looks like
//   hitbox     the shape a thing is struck within, and how to read one off a picture
//   game       a Game, and the Levels that belong to it
//   formation  one placed group becomes N entities
//   damage     shield, then multiplier, then hull
//   world      the step
//   document   a level as a save file and a share link
//   replay     a run as the inputs that produced it
//   patterns   bullet patterns: modulated emitters for bullet-hell fire
//
// Drawing is not here and will not be. A generator that owned a sprite would be
// one game rather than a package.

export * from "./contract.js";
export * from "./hitbox.js";
export * from "./game.js";
export * from "./formation.js";
export * from "./movement.js";
export * from "./damage.js";
export * from "./world.js";
export * from "./document.js";
export * from "./replay.js";
export * from "./patterns.js";
export * from "./pattern-document.js";
export * from "./sprite-document.js";
