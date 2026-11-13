// @ccllc/arcade/patterns — bullet patterns: modulated emitters for designed fire.
//
// Promoted out of `shmup` on 2026-08-22, the day a second genre wanted them.
// An emitter that fans, rings, spins and oscillates projectiles is not a
// scrolling-shooter concept — a platformer turret fires the same three-way
// spread — and `runnjump` importing it from `arcade/shmup` would be an edge
// nobody could explain a year from now. `shmup` re-exports everything here,
// so the day the module moved, no consumer did.
//
// Depends on `core` and on nothing else — no DOM, no clock; trigonometry
// comes from `core/trig` for the engines-differ reason, and `Math.random`
// appears only inside authoring-time id factories. The React designer over
// these documents is `@ccllc/studio`'s BulletPatternStudio; this module is
// the whole simulation of them.

export * from "./patterns.js";
export * from "./document.js";
