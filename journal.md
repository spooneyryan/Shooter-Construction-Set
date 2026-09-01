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
AGENTS.md says to *say* rather than to fork locally. So it is said, in the
per-enemy explosions entry (named rather than numbered, because the backlog
reuses numbers as items ship), with the shape it should take — an explosion as
a saved Component beside
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

## 2026-09-01 — Resizable tool panels

Ryan asked for the palette and the Inspector to be resizable, which is F-01 in
the backlog and therefore authorised by the asking. It ships as C-18, and the
vacated number went back to the top of the queue as the process requires.

**The grid keeps its shape; only two numbers become variable.** The workspace
was `214px minmax(460px, 1fr) 264px`, and the two side columns are now custom
properties set inline on `.workspace`. Inline matters: the narrow-window
breakpoint still lowers the *defaults* at 1050px, and a width somebody chose
still beats it, without either rule having to know about the other. Nothing
else in the layout moved, which is why playtest still collapses both panels to
zero and the sub-760px layout still turns the columns into rows.

**Three limits, and only two of them are the panel's.** Each side has its own
min and max, and above both sits the stage's floor of 460px. The handles
measure the workspace at the moment of the drag rather than trusting a stored
number, because the window can be resized between drags. That third limit is
the one worth having: the grid enforces its floor anyway, by overflowing and
clipping the canvas, so a handle that stops short of it is the difference
between a limit you feel and a bug you file.

**`EbSplitter` was evaluated and rejected, and the entry that expected it has
been corrected rather than left to mislead.** F-08's table said the panel
widths should be built on the suite's splitter rather than hand-rolled, and
AGENTS.md says to prefer a suite component where one fits. It does not fit
here: `EbSplitter` is a two-pane component that owns both panes and divides
them by a **ratio**, while this is a three-column grid whose stage floor,
playtest collapse and stacked layout are all expressed in the grid — and a
0..1 ratio cannot hold a 460px floor as the window changes. Taking it would
have meant nesting two splitters and rewriting the responsive behaviour inside
them. The row is struck through with the reason attached, so nobody reopens it
expecting a quick swap; a genuine two-pane split here should still use it.

**Verified by driving it rather than by reading it.** Against the running dev
server: dragging the palette handle took it 214 → 337 and wrote
`paletteWidth: 337` to `starline-editor-settings-v1`; dragging the Inspector
handle *left* widened it 264 → 396, which is the mirrored delta working; a
deliberately huge drag stopped at the palette's 460 ceiling with the stage
still holding 725. Keyboard: arrows moved by 12, Shift by 48, Home went to the
minimum and End to the ceiling. Double-click restored the default and
persisted it.

One incidental note from that session, since it corroborates yesterday's
diagnosis: the editor was sitting on **Skyfall Run**, in VERTICAL mode. Loading
a sample really does carry its mode into the draft, which is exactly how a
level ends up in a mode nobody remembers choosing.

## 2026-09-01 — The resize handles broke the layout, and why the test missed it

Ryan sent a screenshot of the editor in pieces: the palette on the right, the
stage squeezed to 214px on the left, the Inspector filling the middle, and
thirteen `ResizeObserver loop completed with undelivered notifications` errors
stacked in the dev overlay.

**The DOM order named the cause before anything was measured.** The two
handles are children of `.workspace`, which is a grid. Taken out of flow they
are invisible to it; left in flow they are grid *items*, and three columns with
five children means the first three take row one — handle, handle, palette —
and the last two wrap onto row two, where the stage lands in the 214px column
and the Inspector in the stage's. That is exactly the arrangement in the
screenshot, and `getComputedStyle` confirmed it: `position: static`, and
`grid-template-rows: 235.25px 235.25px`. Two rows.

The ResizeObserver errors were the symptom, not the cause: a canvas that
observes its container, in a container that had just changed shape twice.

**So why did the verification pass?** It genuinely did — handles measured at
`x=209 w=9`, sitting on the seams, dragging and clamping correctly. The
stylesheet was live then and stopped being live afterwards: the dev server had
been running since before this work started, and at some point it stopped
re-reading `globals.css` while continuing to hot-update the JSX. So the
resizers kept arriving in the DOM and the rule that takes them out of flow
did not. A hard reload did not fix it, which is what ruled out browser cache
and pointed at the server. The production build had the rule correctly all
along, which is what ruled out the CSS itself.

That is worth stating plainly: the check was real and the code was right, and
the thing that broke was neither. What the episode actually exposes is a
**design that could not survive its stylesheet being late.**

**The fix is not the dev server.** `position`, `top` and `bottom` are now set
inline on the handle, and `position: relative` inline on the workspace that
anchors it. Being out of flow is not a matter of appearance — it is what stops
this element from participating in a layout it is not part of, and a grid item
that should not be one does not degrade, it destroys. Everything that is
genuinely appearance — the width, the cursor, the seam highlight — stays in
the stylesheet, where it can safely arrive late.

Verified after the change with the stylesheet current: one row,
`grid-template-rows: 470.5px`, palette at 0, stage at 214, Inspector at 1185,
handles on both seams, a drag taking the palette 214 → 307 and persisting. The
built rule no longer contains `position` at all, which is the proof that the
inline declaration is the one doing the work.

**The lesson, since it generalises past this one element:** when a component
is positioned out of a layout it is nested inside, the declaration that
removes it from flow is structural, not cosmetic, and it should not be
separable from the element. Ask of any style whether the page is *wrong* or
merely *ugly* without it. Ugly can live in a stylesheet.

## 2026-09-01 — Six requests, two already answered

Ryan asked for six things. Two of them already existed, which is worth
recording because building them again would have been the expensive mistake:

- **The full sprite editor suite** is there. `+ RASTER SPRITE`, `+ VECTOR
  SPRITE` and `+ IMAGE` all sit in the palette's COMPONENTS tab; the third
  arrived with GameBase 2.0.9 the day before.
- **Replacing an item's sprite** is there too. A selected object has a SPRITE
  dropdown listing the built-ins and every custom asset, and the player has
  SHIP SPRITE. Verified by clicking an enemy and reading the pane rather than
  by reading the source, because the question was whether it is *reachable*.

That leaves the reason he could not find them worth thinking about, and the
third request answers it.

### Bullet patterns (C-20)

Equipping one was a gesture — select an object, then click a Pattern card in
the palette — and the Inspector never said which pattern an object carried, so
the only way to find out was to open the designer and recognise it. It is a
property of the weapon, so it is now a named dropdown in the weapon's own
section, on enemies, on each player weapon slot and on the satellite. That
last two also close F-00.

It can name the Component a pattern came from because applying one clones it
and normalization keeps the `id`. Edited afterwards, it says CUSTOM rather
than claiming to still be the original — and a pattern seeded from a preset by
the designer reads as custom too, correctly, since a fresh copy is not the
shared Component.

Two selects in that same pane were both labelled **PATTERN**, and neither was
a bullet pattern: one is the group formation, the other the movement rule.
They are FORMATION and MOVEMENT now. That relabelling is probably most of the
"unintuitive".

### Presentation mode (C-19)

Shift+T starts a playtest with the editor taken away; Escape leaves. It is an
argument to `enterPlay` rather than a mode beside it, because "as a player
would see it" means the game *running* — chrome stripped from a paused editor
is still an editor — and because two independent flags could disagree about
what is showing.

`P` stayed pause, which F-02 flagged as the open decision. Shift+T pairs with
T, so the two are learnable from each other and nothing had to move.

One piece of chrome deliberately survives: a dim ESC hint, `pointer-events:
none` so it never eats a click, because a mode that hides its own exit is a
trap.

**The same change produced two bugs of one kind.** `enterPlay` gained a
`presented` parameter while two call sites still passed it as `onClick={enterPlay}`
— and a MouseEvent is truthy, so TEST RUN and RETRY would both have silently
presented. I caught the first by reading; TypeScript caught the second. The
lesson is the cheap one: when a function grows a leading boolean, every
`onClick={fn}` referencing it becomes a call with an event in that slot, and
the compiler will only save you if the parameter is typed narrowly enough to
conflict. `presented = false` was.

### Still open from that list

**Explosions are already in the game** — every death, hit and shield break
draws a designed one, chosen by the size the engine asks for. What does not
exist is assigning a *specific* explosion to a *specific* enemy, and that
cannot be built here: the renderer is never told which enemy died. It is
F-07, and it is a change to `@ccllc/arcade`.

**The sound designer is not started.** `SfxStudio` is exported from
`@ccllc/studio` and `@ccllc/arcade/sfx` renders the audio, so the shape will
mirror the explosions: a sound set owned by this repository, mapped onto world
events, edited in a panel. Per-*item* sounds hit exactly the same wall as
per-item explosions.

## 2026-09-01 — Per-enemy explosions and sounds, which needed the engine first

Ryan asked for the engine work, the sound designer, and explosions per enemy
type. The last two are one mechanism, and both were waiting on the first.

**The blocker was a missing sentence, not a missing feature.** A `Burst` is
`{x, y, color, count}`: where to draw and how big. It could never say *what*
exploded, so this app had no way to ask for this raider's explosion. The local
workaround — correlating a burst's position against `world.state.enemies` —
would have guessed, and guessed wrong on the frame two things died together.
So the engine grew `World.drainEvents()` carrying `sourceId`, `LevelItem.fx`
holding ids into `Level.components`, and `explosion`/`sound` component kinds
normalized by `burst` and `sfx`.

**Ids rather than inline documents**, because "per enemy TYPE" is a statement
about sharing: six raiders point at one explosion and editing it reaches all
six. Inlining would make each copy drift the moment one was edited.

**An authored explosion replaces the generic one.** The world queues both a
burst and an event for the same death, so drawing both would double every
explosion an author designed. Events are drained first and the generic blast
dropped where an event at the same point brought its own. That ordering is a
real constraint, not an implementation detail — the burst arrives with no way
to know an event answered it.

**Two things that surfaced on the way.**

The palette filed the first explosion and sound Components under **SATELLITES**,
because `componentCategory` ends in a catch-all rather than an exhaustive
match, so any new kind lands there silently. Fixed, with the fallback now
labelled as one.

And a latent type error in `@ccllc/arcade`'s `sfx/synth.js` — `flatMap` over
frozen arrays returns `readonly U[]` where `flatMap` takes `U | U[]` — had sat
there indefinitely because nothing in a checked graph imported that file until
shmup did. Fixed upstream in the same change. Worth remembering as a category:
a module can carry a type error for as long as nobody imports it.

**Verified by driving all of it**: created a sound and an explosion through
their designers, assigned all three slots on an enemy, and read the level draft
back to confirm the Components and the `fx` ids are what was stored. Then a
headless test drives the full chain — level carries the documents, engine
reports `sourceId` on the kill, lookup resolves, and the resolved burst really
draws to a recording context. A second test pins that a deleted Component
leaves the reference intact and resolves to nothing rather than throwing.

The three-role explosion set from C-17 is unchanged and still the default:
per-item explosions are an override, not a replacement, so a level that
assigns nothing looks exactly as it did.


## Onto the released 2.0.10, off the build number

The dependency read `^2.0.10-dev.257` — a caret range whose floor is a
*prerelease*, pinned to a build number from the day the explosions work was
written against unreleased GameBase. 2.0.10 has since shipped, so this moves
onto it, which is the same cleanup `Move onto the released arcade 2.0.8` did
one release earlier.

Worth writing down why it is 2.0.10 and not 2.0.9, since 2.0.9 is what the
image-sprite commit named: **going back would break this app.** GameBase's
2.0.10 exists *because of* the explosions work here — its commit says so
outright ("Per-enemy explosions and sounds could not be built in a game over
this package, and the reason was one missing sentence here") — and this app
now uses `explosionId`, `deathSoundId` and the `explosion`/`sound` component
kinds that release added. So the floor moves forward to the release, not back
to the previous one.

Gate: 11/11 tests, build clean, and the installed 2.0.10 checked for the
surface this app actually calls — `blankImageAsset`, `SpriteStudio`, and
`normalizeAssets` accepting an `image` asset.


## dev-claude lands on the trunk, and the game deploys

Six commits moved `dev` and `master` from `ecdf81e` to `2cad592`, all
fast-forward with no divergence on either side: the tool panels remembering
their size, flow-state appearance, bullet patterns as a field rather than a
gesture, presentation mode, per-enemy explosions and sounds, and the two
GameBase moves — image sprites, then onto the released arcade 2.0.10.

**Pushing `master` is the deploy**, which is worth saying in the same
sentence as the merge: the pipeline's Deploy stage runs on `master` only and
uploads `dist/client` to the `shmup` Static Web App at
https://shmup.max12charact.com/. `dev*` builds and does not deploy.

Gated the way the pipeline gates before landing anything: lint clean, 11/11
tests, and a clean build.
