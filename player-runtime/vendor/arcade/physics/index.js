// @ccllc/arcade/physics — a small deterministic rigid-body world.
//
// Boxes and circles under gravity, sequential-impulse contacts with friction
// and restitution, stacking, sleeping, radial explosions, begin-contact
// events, and plain-data snapshots. The cannon-and-crates genre in one
// module, on the same contract as `shmup` and `runnjump`: data in, state
// out, nothing drawn, no clock, no Math.random — so a run replays and two
// machines agree bit for bit.
//
// A sibling of the genre modules rather than part of `core`, for the same
// reason they are: not every game needs rigid bodies, and the thing every
// game imports should not carry a contact solver.

export * from "./shapes.js";
export * from "./world.js";
