// Bullet patterns moved to `../patterns` on 2026-08-22, when they were
// promoted out of this genre module: 738 lines of modulated emitters know
// nothing about a scrolling shooter, and the platformer's turrets want them
// too. This shim is why the move cost no consumer a change. New code should
// import from `@ccllc/arcade/patterns`.

export * from "../patterns/patterns.js";
