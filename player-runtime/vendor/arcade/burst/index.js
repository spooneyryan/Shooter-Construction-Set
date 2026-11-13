// @ccllc/arcade/burst — designed explosions.
//
// The `sfx` module's architecture, one medium over: a small JSON document
// plus pure arithmetic, params in and frames out, with presets because
// nobody has ever got an explosion right by reading numbers. Depends on
// `core` and on nothing else — no DOM, no clock, and no canvas is ever
// assumed: `bakeBurstSheet` takes a factory, which is what keeps this
// loadable and testable in node.
//
// The layers, in the order a game meets them:
//
//   contract   what a burst says: layers, colours, palette, presets
//   frames     the arithmetic — a document and a moment in, shapes out
//   draw       the emitters: smooth, pixel-snapped, baked, or SVG
//   document   a burst as a save file and a share link
//
// **Both looks come from one document**, which is the 2026-08-24 sprite
// decision applied here: bake, not branch. Drawn straight it is smooth
// vector shapes; drawn with a `pixelGrid` and a `palette` it is era art;
// baked once into a sheet it is a texture that costs a blit thereafter.
// Three ways out, one frame, so an explosion cannot look like two
// different explosions depending on how a game chose to draw it.
//
// **This is presentation and may be sloppy** — the house rule says
// particles live outside the simulation and may differ between two
// players, so a game may fire a burst inside a rollback without
// corrupting anything. The randomness is seeded regardless, because a
// designer must be able to preview what a player will see and a baked
// sheet needs a stable cache key. Particle properties come from a hash of
// `(seed, layer, index)` rather than a stream, so raising a layer's count
// leaves the existing particles exactly where they were.
//
// `burst` is not a new word here: `runnjump`'s reaction table has listed a
// `burst` effect since it was written, with nothing behind it. This is
// what was missing — and `cannon`, `maze` and `topdown` all queue
// explosion events today that a game must currently answer with a circle.

export * from "./contract.js";
export * from "./document.js";
export {
  advanceBurst,
  burstFrame,
  burstFrameAt,
  burstFrameCount,
  burstParticles,
  createBurstRuntime,
  mixBurstColor,
} from "./frames.js";
export { bakeBurstSheet, burstToSvg, drawBurst, snapBurstColor } from "./draw.js";
