// @ccllc/arcade/runnjump — 2DRunNJump, a platform-game generator.
//
// A sibling of `core` rather than part of it, the same stance as `shmup`:
// `core` is the general runtime every game imports, and a genre belongs
// beside it, not inside it. Depends on `core`, `sprite` and `patterns`, and
// on nothing else — no DOM, no clock, no randomness.
//
// The layers, in the order a game meets them:
//
//   tiles      what the grid is made of, and the run-length encoding
//   contract   what a game says: definitions, levels, the feel, the input
//   move       how anything moves: pixel stepping, slopes, solids
//   world      the step — createStage, snapshot, restore
//   document   a game as a save file and a share link
//
// Unlike `shmup`, this simulation is bit-deterministic ACROSS MACHINES: the
// hot path is `+ - * /` and comparisons on integers and floats, which the
// specification pins down exactly, and the guard test bans every function
// it does not. That is the property co-op stands on, and it is cheaper to
// keep than to win back — anything trigonometric goes through `core/trig`.
//
// Drawing is not here and will not be. A generator that owned a sprite
// would be one game rather than a package.

export * from "./tiles.js";
export * from "./contract.js";
export * from "./move.js";
export * from "./document.js";
export { createStage } from "./world.js";
export { createCampaign } from "./campaign.js";
export { createStageRecorder, replayStage, stagePadActions, stagePadSticks } from "./replay.js";
export { createPlayerState, hurtPlayer, killPlayer, satellitePosition, stepPlayer, wrapDegrees } from "./player.js";
export { behaviorExists, behaviorNames, behaviorParams, behaviorParamsCover, registerBehavior } from "./behaviors.js";
export { triggerReaction } from "./reactions.js";
export { updateCamera } from "./camera.js";

export { runNJumpWeaponFits, collectRunNJumpWeapon, equipRunNJumpWeapon } from "./equipment.js";

export { normalizeRunNJumpMotion, normalizeRunNJumpMount, runNJumpMotionPosition, runNJumpMotionLength, runNJumpFacing, runNJumpMuzzle, runNJumpActorAim } from "./motion.js";
