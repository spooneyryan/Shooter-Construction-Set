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

**Checked in production afterwards**, which is the only check that covers the
pipeline itself. The Static Web App swapped `StarlineGame-CgR5Kr98.js` for
`StarlineGame-eHZuQrXB.js`, and on the live site `+ IMAGE` opened the editor,
a 140x90 PNG imported through it (centre pixel `#42f5ec`, exactly what was
drawn), and the saved asset came back into the level list as `IMAGE /
140x90`. `+ EXPLOSION` and `+ SOUND` are there too, so the per-enemy
explosions work shipped in the same deploy.

## 2026-09-03 — The ship is its sprite, and the editor turns

Four commits, three of them Ryan's running commentary on the player ship and
one on the editor's orientation.

**"The X Y and size controls don't make sense to me."** They didn't. The ship
carried `size`, `scaleX` and `scaleY` — three knobs for one question — and the
hitbox was a constant radius that had nothing to do with the sprite you could
see. Replaced with a single `scale`, and `playerExtent` in the shmup contract
now derives the hitbox from the sprite's own dimensions when the sprite is an
imported asset. The three old keys migrate on load and are stripped on write,
which needed a destructuring spread: `player: { ...player }` was faithfully
carrying the legacy keys straight back out again.

**The editor drew a vertical sector sideways.** C-23 has the design; the part
worth recording here is the verification, because the obvious way to check it
was wrong. Synthetic `PointerEvent`s reach the handler but have no *real*
active pointer, so `setPointerCapture` throws and takes the whole placement
path down with it — which reads exactly like "the click did nothing" and had
me briefly believing the horizontal case had regressed. It hadn't. Driving
genuine clicks through the browser instead placed items in both modes and the
coordinates came out where the transform predicts.

That throw is a test artifact rather than a bug — a real pointerdown always
has an active pointer — but an unguarded `setPointerCapture` aborting the
click handler is a sharp edge worth knowing about.

## 2026-09-03 (later) — Why the selected sprite was the sharp one

A bug report worth keeping because the *shape* of it gave the answer away:
coarse normally, sharp when selected. Selection is the one case that skips the
sprite cache, so the cache was the suspect before any code was read. C-24 has
the fix.

**The measurement nearly fooled me.** A first comparison, on a built-in vector
sprite at the editor's default zoom, moved the sharpness metric from 68 to 74
-- real, but so slight it would have been fair to call it noise and wrong to
call it a fix. The reason was that the editor was showing the sector at 0.63x
while the item was at 2x, so the bake was only being magnified 1.25 times. The
bug needs magnification to show, and the test had almost none.

Redone with an imported 256-square checkerboard at 4x, which is both the
user's actual case and the probe that makes under-resolution obvious, the
difference was not subtle: **the sprite did not render at all** before the
fix. That is how the second bug surfaced -- an image asset that has not
decoded draws nothing, and baking nothing caches it forever.

The lesson is about picking the probe rather than about canvas: a metric that
barely moves may be measuring a case the bug does not apply to, and the honest
response is to find the case where it does rather than to report the 9%.

**A loose end, deliberately not chased.** The localStorage draft does not carry
`assets` -- the level in memory has them (the COMPONENTS tab lists an imported
sprite quite happily) but the persisted draft does not, so a reload would lose
an import that was never saved to the library. The data URLs are large and the
library's own notes talk about quota, so this may well be deliberate. Recorded
rather than changed, because it is nothing to do with the bug in hand.

## 2026-09-03 (later still) — Twenty-two console errors that were one bug

A screenshot of the production console, and the useful part was that the
errors were not cosmetic. "Unable to preventDefault inside passive event
listener invocation" reads like lint, but it means a cancel that did not
happen: React attaches `wheel` passively, the editor's `onWheel` prop called
`preventDefault` anyway, and the page scrolled behind the sector on every
notch. C-25 has the fix.

The reflex with a console full of warnings is to rank them by count and start
at the top. The better question was what each one *does*, and here the answer
turned one repeated warning into a real input bug and sent the other one
away: the `slider-vertical` deprecation is inside the vendored
ElectricBlazor stylesheet and fires on parse whether or not anything uses the
component it styles.

## 2026-09-04 — Eleven requests, and three lies the browser told me

Ryan approved the plan for F-07 to F-13 and asked for all of it. Six of the
seven shipped; F-07's own half waits on a package reaching the feed.

**The harness misled me three times, in the same shape each time**, and the
shape is worth keeping because it will happen again:

- **Keys.** The automation sends `keydown` with an empty `code`, and the
  keymap matches on `code`. So no shortcut fired under it, in any mode — and
  I wrote that up as "presentation mode is a trap with no way out", which was
  entirely false. The control test that should have caught it (press P, see
  if anything pauses) failed for the same reason and I read its silence as
  more evidence rather than as the same fault.
- **Backgrounded tabs.** `requestAnimationFrame` is throttled in a tab that
  is not fronted, so the game did not animate and I nearly filed that too.
- **ResizeObserver.** It does not fire in this pane at all — a fresh observer
  reported zero callbacks on attach, which is not something a browser does.
  I had already started reasoning about a resize bug that does not exist.

The common thread is that **a negative result from a tool is not a negative
result from the product**, and the tell each time was available: an empty
`code` field, a ship that never moved between frames, an observer that never
fired even once. The discipline that would have saved all three is to prove
the instrument works before trusting what it says about the subject.

What survived the correction was the part I had actually seen with my own
eyes: a vertical level presented in a strip with black either side. That one
was real, had nothing to do with keys, and is C-29.

**The release taught the other lesson.** `npm run release` refused to include
work that was on `dev-claude` but not on `dev`, and said so in its preflight
rather than tagging a commit that did not have it. Reading that notice was the
difference between publishing the change and publishing nothing.

## 2026-09-04 (later) — Which way is down

Ryan asked for sprites to lean into their path — a rocket on a sine wave
nosing into the wave. C-33.

The decision worth recording is where the heading comes from. The obvious
place is each movement pattern's derivative, and it is wrong twice: the arena's
homing has no closed form, and every future pattern would need a second
formula kept in step with the first. A finite difference across the step
answers for all of them with one subtraction, costs nothing the simulation was
not already doing, and — because it is arithmetic on state rather than
trigonometry — keeps `atan2` out of the engine entirely. The renderer turns
the picture; the engine only says which way it went.

The one trap was the spawn frame. The phase is folded into an enemy's first
position, so the difference between "at the origin" and "one step in" includes
the whole phase offset at once — a one-frame spike that would flick a rocket
sideways as it appears. Read `settled` before the age advances and the spawn
frame reports nothing, which is also the truth.

## 2026-09-05 — One path function, and a decision made out loud

Ryan asked for movement paths that point in any direction and for a curve —
"a bezier would be AMAZING, a resizable arc would be acceptable." C-34 shipped
the turn and the arc; F-07 holds the bezier with its design written down.

**Taking the fallback was a decision, not a shortcut, and saying so mattered.**
The bezier's math is a page; what makes it amazing is dragging control points
on the canvas, and that is a real editor feature with its own hit-testing,
drag kind and group interplay. Shipping the arc with the bezier scoped and
waiting is honest about that. Shipping a numbers-only bezier and calling it
amazing would not have been.

**The design move worth keeping is the single function.** The editor's path
preview was a second copy of the movement formulas, and it had already drifted
— `Math.sin` where the simulation uses core's deterministic `sin`, which F-05
had noticed and filed as a nit. Turning and curving paths would have doubled
the surface for that drift. Exporting `movementPosition` from the engine and
drawing the preview with it removed the copy instead of maintaining it, and
C-33's lean preview fell into the same function for free.

**The regression guard is `deepEqual`, not a tolerance.** An untouched level
must be placed on the same numbers it always was — a replay depends on it —
and "close" is not the same claim. Angle zero takes the old arithmetic branch
so the assertion can be exact.

## 2026-09-05 (later) — The amazing version

Ryan came back for the bezier. C-35.

**Distance, not parameter, was the decision that made it feel right.** The
first thing anyone does with a bezier is fly it by `t`, and the first thing
they notice is the rocket lurching — fast through the straight middle, slow
into the tight bend, because `t` is not length. Measuring the curve into a
table once and walking distance along it is a page of arithmetic, and it is
the difference between a path and an effect. The test asserts the speed is
constant to within the polyline's coarseness, which is the claim that matters.

**The handles taught the order of hit-tests.** The control points live inside
the selection box, exactly where the rotate grip at the top and the scale grip
at the corner already wait for a click. Testing the handles first is a one-line
decision that would have been a confusing bug if made the other way — a drag
that rotated the sprite when you meant to bend its path.

**One function for where a handle IS.** Drawing and hit-testing each computed
the control points' world positions, and had they been two formulas the angle
rotation would have drifted between them sooner or later. `bezierControlWorld`
is used by both, so a handle is grabbed where it is drawn by construction — the
same shape of decision as `movementPosition` for the path itself, one level up.

## 2026-09-05 (evening) — Blocked, or full

Ryan could not save: "this browser blocked local saves." The sentence came from
Starline, and it was written for a browser that refuses storage — but the
library returns the same null for a shelf too big to write, and with image
sprites travelling inside their levels, a full five-megabyte origin is the far
likelier way to get there. C-36 tells the two apart with a one-byte probe and
says how full the store is; F-07 is the real fix, IndexedDB behind a sync
facade, and why it is an entry rather than a commit.

**The lesson is about error messages that name a cause.** "Blocked" is a
diagnosis, and the code that wrote it had not diagnosed anything — it had a
null. A message that names the one cause its author imagined sends the reader
looking in the wrong place with confidence; one that says what was observed
("the save did not write") at least sends them looking. Better still is the
probe: one more byte of work turned a guess into a finding.

Zoom and the off-stage room shipped in the same pass, and they belong together
— the room is half a screen above and below the band, and zooming out is how
you see it. The editor had always clamped placement to the band; the world had
never cared. The only engine change was the one that had to come with the
room: an enemy still off the band holds its fire, exactly as one off the right
edge always has.

## 2026-09-05 (night) — The gate that was one line

Ryan asked for IndexedDB, in GameBase if GameBase lacked it, consumed here.
C-37.

**Read the seam before designing around it.** F-07 had sketched a loading
shell and a session moved out of module scope, because I assumed the session
read its draft when constructed. It does not; the host asks in a mount
effect. One `await ready` in that effect was the whole gate, and the design
that would have taken an afternoon was a paragraph that turned out to be
wrong. The lesson is not that the sketch was careless -- it was a reasonable
guess written down as a guess -- but that the first act of building it should
be to check the guess, and that checking took one grep.

**Synchronous facade, asynchronous truth.** Every consumer of the store is
synchronous and stays so; only the persistence moved. The Map is what the
library reads and writes; the queue carries the same writes to IndexedDB in
order; `ready` is the moment the Map matches the disk. The one subtlety is a
write made before the load finishes -- it must win over the older value the
load brings back -- and the test for it is the one most worth keeping.

**Let go of the originals, and say so.** Copying the shelf into IndexedDB and
leaving it in localStorage would have fixed the message and kept the problem:
the store would still be full for everything else. So the originals are
removed once their copies have committed, a downgrade would then find them
gone, and both halves of that are written in the entry rather than discovered.

## 2026-09-06 — A last pass, and a hardpoint

Two of Ryan's in one message: GameBase's scanlines, chosen in settings, and
guns that sit where you put them. C-38 and C-39.

**Wire a last pass as a last pass.** The presenter wants a frame and gives
back a treated picture. The temptation was to route Starline's drawing through
it — a source canvas at sector resolution, the vertical turn re-derived, the
clip and the pointer mapping taught a new coordinate space. None of that was
asked for, and all of it was risk. Handing the frame Starline already draws to
a second canvas layered over the first is a dozen lines, and nothing else in
the renderer knows the presenter exists. The one honest cost is that
`source-scanlines` means nothing at 1:1, so it is not offered; the menu says
what it can do rather than listing what the module can.

**Keep the old expressions, then measure the difference.** The unmounted shot
had to land where it always had, bit for bit, or every saved level's fire
would shift by a hair. Rewriting the origin as "mount with a default of the
nose" would have re-derived that position through new arithmetic and invited
exactly that hair. So the absent case keeps the verbatim expressions, the
mounted case is new code, and the test runs both in the same world and asserts
only the difference between them — which is the one thing the change is
allowed to be.

## 2026-09-06 (later) — Two passes, and a spin that had to reach the gun

Ryan asked for a rotation-as-it-moves and reported that a nebula was taking
the click meant for the ship under it. C-40 and C-41.

**Find where a presentation field stops being presentation.** Spin looked like
a renderer-only number until the mounts from an hour earlier made it not one:
a gun mounted on a rotating sprite fires from where the sprite is *now*, so
the simulation has to know the angle. One field on the runtime enemy, closed
form in age, and both the picture and the muzzle read it. The habit worth
keeping is to ask what already depends on the thing being changed before
deciding which side of the engine line it lives on.

**Selection was correct and wrong.** Last-placed-wins is the right rule among
peers, and a nebula is not a peer of a ship — it is scenery, with a hit radius
the size of the scenery. Two passes keep the old rule inside each kind and add
the one judgement the editor was missing: what the player can touch comes
before what dresses the scene.

## 2026-09-06 (evening) — The engine learns what the renderer draws

Six of Ryan's in one message. C-42 to C-44.

**A rule that lived only in the renderer had to move down.** The heading lean
was presentation — the picture turned, the simulation did not care. Then guns
got mounts, and mounts turned with the picture, and now shots had to leave
along the front the picture showed. At that point "which way is the ship
facing" stopped being a drawing question, and the answer had to be computed
where the shots are: in the world, with the deterministic trig, from the same
three numbers. The renderer's formula was copied down rather than the other
way round, and the two agree by construction because they add the same things.

**Bit-for-bit is a boolean check away.** `(-1, 0)` and `(cos 180°, sin 180°)`
are not the same number, and every saved level's fire would have shifted by
the difference. Checking the offset for zero before touching trigonometry
keeps the old literal for the old case; the test asserts `vx` is exactly
`-300`, not close to it.

**Say the consequence.** A rotated turret used to fire left regardless. It
now fires where it points, which is what the rule says and what a level
built on the old accident will notice. Written into the entry rather than
left to be discovered.

**The first test failure was the spawn frame, not the aim.** The climber
fired on the frame it appeared, before any velocity had been recorded, so
its lean was zero and its shot flew left. The velocity had been left at zero
on that frame because the jump from the origin to the phase-folded first
position is not motion -- true, but the scroll paths are closed form, so
the path's own first step is knowable. Reading it from there fixed the stray
shot and the one-frame level-then-snap the renderer had always shown.

**Measure before blaming the grid.** The overlapping POSITION boxes looked
like the classic grid-track-will-not-shrink problem, and the first fix was
that. Measuring the boxes showed each was 220px wide inside a 111px cell:
ElectricBlazor's numeric input carries its own minimum. The grid rule was
kept because it is true; the component override is what fixed it.

## 2026-09-06 (night) — A pointer you can see through

Three of Ryan's: two fields that did not fit, a sprite for a pointer, and the
GameBase site redeployed. C-45, and a note on C-44.

**Measure before re-fixing.** The two fields in the screenshot had already
been fixed by the previous slice's override; the picture was of the old
bundle. Placing a powerup and measuring its four boxes settled it in a
minute, where a second CSS rule for the same cause would have been noise.

**Draw the pointer rather than declaring it.** The obvious reading of "make
the pointer the sprite" is a CSS cursor, and it is the wrong tool: capped in
size, static, untinted, and blind to a formation. The stage already knew
where the pointer was for clicks and already drew every sprite each frame;
one ref and one draw call made the ghost, and `cursor: none` made it the
pointer. The rule kept from this: when the canvas already has a frame loop,
prefer drawing into it over asking the browser to decorate it.

**Check what already works before adding to it.** Escape-to-select existed.
Testing it from the palette button that had focus, rather than assuming the
keymap swallowed it, is what made the entry a note rather than a change.
