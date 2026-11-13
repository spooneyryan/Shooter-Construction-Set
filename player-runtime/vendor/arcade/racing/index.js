// @ccllc/arcade/racing — the genre that laps.
//
// RC Pro-Am's radio-controlled trucks and Micro Machines' toy cars on a
// breakfast table: one module and two flavours, because they differ in data
// rather than in kind. A sibling of `shmup`, `runnjump`, `cannon`, `maze`,
// `topdown` and `wheels`. Depends on `core` and `net`, and on `sprite` and
// `sfx` only for the normalizers that read a track's art and sounds — no
// DOM, no clock, no randomness at all.
//
// The layers, in the order a game meets them:
//
//   contract   what a track says: route, surfaces, cars, field, rules, input,
//              and how it looks and sounds, which the race never reads
//   track      the route, built: a sampled loop and its queries
//   car        the rig — a rigid body on two friction-limited axles
//   driver     the computer's driver: the field, and an autopilot for anyone
//   world      the race — createRace, snapshot, restore, events
//   document   a track as a save file and a share link
//   fields     a track's property panels, as data
//   authoring  the editor's half: edits that keep placements, numbers, checks
//   replay     a race as the inputs that produced it
//   samples    the two proof games, as data
//
// **The format's centre**, and the thing worth reading first: a track is a
// route, not a picture. One closed centreline with a width at each node is
// the only geometry an author draws, and it answers everything a racing game
// asks — what a wheel is standing on, whether a car is touching a wall, how
// far round the lap it is, where it goes back to after a fall, and where the
// computer's cars drive and how fast. The simulation is flat, with a height
// channel for jumps, so an overhead view and RC Pro-Am's three-quarter one are
// the same state drawn twice. See docs/RACING.md.
//
// Bit-deterministic across machines: the solver is `+ - * /`, comparisons and
// `Math.sqrt`, all of which the specification pins down exactly, the angles
// go through `core/trig`, the substep count is fixed, and the computer's
// drivers are functions of state. There is no randomness anywhere in the
// module.
//
// Drawing is not here and will not be. Read `race.route` once and
// `race.state` after a step; drive sounds and effects from `drainEvents()`,
// never from inside the step.

export * from "./contract.js";
export * from "./document.js";
export * from "./fields.js";
export {
  RACING_EDGE_DROP,
  RACING_EDGE_OPEN,
  RACING_EDGE_WALL,
  buildRacingTrack,
  racingGroundAt,
  racingNearest,
  racingPointAt,
  racingProgress,
  racingSurfaceAt,
  racingWallContact,
} from "./track.js";
export {
  RACING_LAUNCH_FLOOR,
  createRacingCar,
  racingCarCorners,
  racingCarDiscs,
  racingTune,
  seatRacingCar,
  stepRacingCar,
} from "./car.js";
export { RACING_STUCK_TICKS, racingDriverInput, racingPace } from "./driver.js";
export { createRace } from "./world.js";
export {
  RACING_MIN_NODES,
  addRacingNode,
  anchorRacingTrack,
  checkRacingTrack,
  insertRacingNode,
  moveRacingNode,
  racingAnchorAt,
  racingJumpDistance,
  racingJumpSpeed,
  racingJumps,
  racingPlacementPoint,
  racingSpeedProfile,
  racingTrackChecks,
  racingTrackNumbers,
  removeRacingNode,
  reverseRacingRoute,
  setRacingStart,
} from "./authoring.js";
export {
  createRacingRecorder,
  racingPadActions,
  racingPadSticks,
  replayRacingRace,
} from "./replay.js";
export { racingSamples, sampleBreakfastTable, sampleStadiumCircuit } from "./samples.js";
