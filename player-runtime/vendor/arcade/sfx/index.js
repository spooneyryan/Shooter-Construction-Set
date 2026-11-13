// @ccllc/arcade/sfx — designed sound effects, Atari-2600-to-NES era.
//
// A sibling of `shmup` for the same reason `shmup` is a sibling of `core`:
// a document format plus the arithmetic that runs it. `synth` is the whole
// instrument — a SfxDefinition in, a Float32Array out, pure enough to test
// in node with no audio device — and `player` is the thin WebAudio shim
// that actually makes air move.
//
// This is not `platform/audio`. That module plays *declared* sounds — named
// stacks of oscillator layers with cooldowns, built for "the bumper went
// bing". This one renders *designed* sounds to a buffer a person shaped in
// an editor. A game can use both; neither imports the other.

export * from "./synth.js";
export * from "./player.js";
export * from "./document.js";
export * from "./renderer.js";
// `worker.js` is absent on purpose: it is a worker entry point, and importing
// it here would attach a message handler to whatever thread did the importing.
// `createSfxRenderer` above is how it gets started.
