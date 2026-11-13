// @ccllc/arcade/wheels — the genre that rolls.
//
// Moon Patrol's rover and a Trials/ExciteBike stunt bike: one module and
// two flavours, because they differ in data rather than in kind. A sibling
// of `shmup`, `runnjump`, `cannon`, `maze` and `topdown`. Depends on `core`
// and `net`, and on nothing else — no DOM, no clock, no randomness at all.
//
// The layers, in the order a game meets them:
//
//   contract   what a course says: ground, surfaces, vehicle, feel, input
//   terrain    the ground as a line: built once, then queried
//   vehicle    the rig — a rigid chassis on spring-damper wheels
//   world      the ride — createRide, snapshot, restore, events
//   document   a course as a save file and a share link
//   replay     a ride as the inputs that produced it
//   samples    the two proof games, as data
//
// **The format's centre**, and the thing worth reading first: the ground
// is a line, not a grid. `runnjump` is the 2D scroller this sits beside,
// and its floor is a tile whose slope is two edge heights — right for a
// platformer, and unable to express the continuous surface a wheel rolls
// along. Here the ground is a heightfield polyline, the wheels are held to
// the chassis by springs, and everything both games are famous for falls
// out of that: the rover's wheels bouncing independently of its body, the
// bike's backflip, the landing that has to be angled, and the speed
// control that decides whether a gap is cleared. See docs/WHEELS.md.
//
// Bit-deterministic across machines: the solver is `+ - * /`, comparisons
// and `Math.sqrt`, all of which the specification pins down exactly, the
// two angles go through `core/trig`, and the substep count is fixed rather
// than adaptive — so a slower machine runs the same simulation, not a
// coarser one. There is no randomness anywhere in the module.
//
// Drawing is not here and will not be. Read `ride.terrain` once and
// `ride.state` after a step; drive sounds and effects from `drainEvents()`,
// never from inside the step.

export * from "./contract.js";
export * from "./document.js";
export {
  buildWheelsTerrain,
  terrainContact,
  terrainCovers,
  terrainGripAt,
  terrainHeightAt,
  terrainNormalAt,
  terrainSpanAt,
  terrainSurfaceAt,
} from "./terrain.js";
export {
  createWheelsRider,
  seatWheelsRider,
  stepWheelsRider,
  wheelsCrashPoints,
  wheelsInertia,
  wheelsWheelPoint,
} from "./vehicle.js";
export { createRide } from "./world.js";
export {
  createWheelsRecorder,
  replayWheelsRide,
  wheelsPadActions,
  wheelsPadSticks,
} from "./replay.js";
export { sampleLunarPatrol, sampleRidgeRun, wheelsSamples } from "./samples.js";
