# Journal

What happened in each work session, and why. `future.md` records what to
build; this records what was learned building it. Newest last.

---

## 2026-08-30 — Designed explosions

Ryan asked for the explosion designer from GameBase to come to Starline, and
for the enemies to use a designed explosion.

**What shipped.** `@ccllc/arcade/burst` arrives with the package upgrade;
`app/explosions.ts` holds Starline's three designs and the mapping from a
world request to one of them; `app/BurstDesigner.tsx` is the editing panel,
reached from **✳ EXPLOSIONS** in the topbar. The renderer's hand-rolled
particle spray is gone — `spawnBursts` now creates burst runtimes and
`drawBurst` draws them. C-17 in future.md is the specification.

**The design question was where an explosion is chosen, and the answer was
forced by an ownership boundary.** Per-enemy explosions would be the obvious
feature, and they cannot be built here: the renderer is never told which enemy
died, because a `Burst` is `{ x, y, color, count }` and nothing more. Adding
that is a level-format change and therefore a change to `@ccllc/arcade`, which
AGENTS.md says to *say* rather than to fork locally. So it is said, in F-10,
with the shape it should take — an explosion as a saved Component beside
`pattern`, since the editor already knows how to save, list and reuse those.

What could be done here is better than it sounds. The engine's `count` is a
real signal: its own call sites cluster at 5–7, 10–14 and 18–24, so two
thresholds separate a chip hit from a shot being stopped from something dying.
Every enemy death genuinely draws a designed explosion; what it cannot do yet
is draw a *different* one per enemy.

**A test that drives the engine rather than the page.** The clustering above
is an assumption about somebody else's code, and the kind that rots silently
on a library upgrade. `tests/explosions.test.mjs` therefore runs the real
world headless, kills real enemies, and asserts the counts still separate —
then pushes the real requests through the real resolver into the real emitter
and checks something was drawn both ways. It imports `app/explosions.ts` as
TypeScript directly; Node strips the types, and the test script carries
`--experimental-strip-types` to cover the 22.13 floor this package declares.
This is the first test here that is not a post-build assertion on `dist/`, so
`npm test` now names both files.

That test is also what caught the one thing the browser could not: **`shard`
is the one layer kind whose pixel path does not snap.** It is drawn inside a
rotation, and the module snaps its x extent but not its y, so shards miss the
grid in era-art mode. Reported upstream; the test documents the exception
rather than hiding it, and the filter comes out when the module is fixed.

**Verification note.** The preview pane froze `requestAnimationFrame`
entirely — a counter of my own ticked zero over three seconds — so the design
canvases read as blank and a live in-game kill was unreachable at a few frames
per screenshot. Screenshots pump frames, which was enough to confirm the panel
draws (798 distinct colours vector against 132 pixelled, from one document),
but the claim about *enemies* was settled headless instead. When a claim is
about behaviour, drive the code; a screenshot can only ever agree with you.

**Two things to know about the dependency.** The burst module is only in a
prerelease: `@ccllc/arcade` and `@ccllc/studio` are pinned to
`^2.0.8-dev.240`, because 2.0.8 has not been released. The caret picks up
2.0.8 final when it lands, so this resolves itself, but until then `master`
depends on a dev build. Separately, the upgrade tightened
`defineLevelFormat`'s document type to include the envelope it stamps, so
export and share now `parse` before handing a level over — no runtime change,
since `serialize` parsed it anyway, but the call sites now say so.

Gate: 9/9 tests, lint clean, `tsc` clean for `app/` (the `db/`, `worker/` and
`drizzle.config.ts` errors are the inherited scaffolding's and predate this).
