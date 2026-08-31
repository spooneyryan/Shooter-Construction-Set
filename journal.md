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
was the one layer kind whose pixel path did not snap.** It is drawn inside a
rotation, and a rotated rectangle cannot sit on a pixel grid — so the kind
meant to look like flung debris was the one landing on fractional pixels, in
the mode whose whole job is whole ones. Fixed upstream the same session
(`@ccllc/arcade` 2.0.8 walks the shard's length and lays a grid cell per step,
the trick its ring path already used), and the assertion here now covers every
rect rather than carrying an exception.

**Verification note.** The preview pane froze `requestAnimationFrame`
entirely — a counter of my own ticked zero over three seconds — so the design
canvases read as blank and a live in-game kill was unreachable at a few frames
per screenshot. Screenshots pump frames, which was enough to confirm the panel
draws (798 distinct colours vector against 132 pixelled, from one document),
but the claim about *enemies* was settled headless instead. When a claim is
about behaviour, drive the code; a screenshot can only ever agree with you.

**About the dependency.** The work was built against `^2.0.8-dev.240` because
the burst module existed only in a prerelease; GameBase then cut 2.0.8 —
carrying the shard fix above — and both `@ccllc` packages moved onto `^2.0.8`
before this shipped, so `master` depends on a release rather than a dev build.
Separately, the upgrade tightened `defineLevelFormat`'s document type to
include the envelope it stamps, so export and share now `parse` before handing
a level over — no runtime change, since `serialize` parsed it anyway, but the
call sites now say so.

Gate: 9/9 tests, lint clean, `tsc` clean for `app/` (the `db/`, `worker/` and
`drizzle.config.ts` errors are the inherited scaffolding's and predate this).


## Sprites gain a third kind: full-resolution images

GameBase 2.0.9 adds an `image` sprite asset beside `raster` and `vector` — a
full-resolution picture carried as a data URL, with png/jpg/gif/webp import
and a paint editor of its own. Starline gets it for one button.

That it *is* one button is the point. `SpriteStudio` dispatches on
`asset.kind`, `drawSpriteAsset` draws all three, `normalizeAssets` validates
all three, and this app's asset list, preview and picker were already written
against `SpriteAsset` rather than against the two kinds that existed at the
time. Nothing here switched on `kind`, so nothing here had to change.

The one thing a host must supply is a blank to start from, and an image asset
is defined by carrying real bytes: an empty `data` string is dropped by
`normalizeAssets` on the way into a level. `blankImageAsset` is upstream's
answer, and `+ IMAGE` calls it.

Floor raised to `^2.0.9` for both `@ccllc/arcade` and `@ccllc/studio`,
because the button does not exist below it.

Gate: 9/9 tests, `npm run build` clean, and driven in a browser — `+ IMAGE`
opened the editor, a 160x100 PNG imported through it, and the saved asset
came back into the level list as `IMAGE / 160x100`.
