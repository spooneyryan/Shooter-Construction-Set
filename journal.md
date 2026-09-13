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

## 2026-09-07 — Four edges, and a gate that was not one

Ryan asked for limits on all four edges of the ship's flight. C-46, in
arcade 2.0.26.

**A chain of semicolons is not a gate.** The engine change passed the shmup
suite I ran by hand, so I chained build, the full test run, commit, push and
release with semicolons and let it go. The full run had one failure in a
suite I had not run -- the vertical-mode test pinning the old 45-unit
margin -- and the chain sailed past it into the release. The release script
ran the tests itself and stopped, which is the only reason nothing shipped
red. The rule, relearned: sum the failure counts and test them before the
first side effect, every time, not only when the change feels risky.

**Read the raw input when a default would mask a legacy field.** The
normalizer spreads defaults over the saved player before it normalizes
fields, so the default box always existed and the old `forwardLimit` never
got its say. The migration reads the raw input's box instead, and falls
back to the legacy field only when that is absent.

**Another session is releasing from the same branch.** Between my push and
my release someone else's session had already tagged 2.0.25 and started
2.0.26. Checking whether the tag contained my commit, rather than trusting
the version number, is what showed the change was still unreleased.

## 2026-09-07 (later) — A debug view has to be true or it is worse than nothing

Ryan asked for hit boxes on screen. C-47, on arcade 2.0.27.

**The feature answered a question the codebase disagreed with itself about.**
"The hit box" implies one shape per sprite. There were four numbers, in four
collision loops, none of them named: 0.78, 0.7, 0.65, and a bare
`size * scale`. Drawing any one of them and calling it *the* hit box would
have been a plausible-looking lie, and the person trusting it would tune a
level against a circle the simulation does not use. Drawing the band is
slightly more ink and completely true.

**Pull the constants down before drawing them.** The alternative was four
literals copied into the editor, which works exactly until someone tunes
0.78 in the engine. Exporting `itemHitRadius` made the world's own loops
read better as a side effect -- four arithmetic expressions became four named
calls -- which is the tell that the extraction was the right shape rather
than a favour to the caller.

**A silent toggle is a bug you only notice when you add the third one.**
FULLSCREEN and FPS both had `aria-pressed` and no pressed styling; FPS gets
away with it because its readout appears, and FULLSCREEN because the whole
window changes. DEBUG has neither tell when the stage happens to be empty, so
the missing state finally had to be drawn -- and the other two got it too.

**Caught by reading, not by running.** The group case would have shipped: the
overlay drew nothing around a group, silently, and every test passed because
the world never asks about a group item. What surfaced it was re-reading the
type check against what `expandLevel` does, before the package was even
consumed. Worth the paragraph because the failure mode of a debug tool is
silence, and silence is what it is supposed to be reporting on.

## 2026-09-07 (night) — Shapes, and a picture the engine never sees

Ryan asked for real hitboxes — polygons or many small circles hugging the
art — derived automatically where possible, with a maker to draw them, in
GameBase. C-48, across arcade 2.0.29 and studio.

**Put the frame before the shapes.** The first decision was not polygon
versus circle but what 1 means. Sprite units, where 1 is the item's size,
made SIZE and SCALE free, made rotation the world's business through the
facing it already computes for shots, and made "as drawn at rotation 0" the
whole story a renderer has to tell — mirroring included, which the mask
inherits by being painted with the same routine. Everything after was
geometry.

**Keep the engine blind and give it the pixels.** The engine cannot touch a
canvas and the sprites only exist as canvas drawing, so the derivation takes
an alpha mask — numbers — and the DOM half lives in studio. That split is
what let the tracing and the disc cover be tested in Node with masks typed
out by predicate, and what let three of those tests fail usefully: a
concave corner sprouting a seventh point, a rim tiled with one-pixel discs,
a "speck" that was three percent of the picture. Two were the algorithm's
faults and one the test's, and the numbers said which.

**A tight cover leaves corners.** Discs that stay inside a rectangle cannot
reach its corners; that is the trade the user asked for when he said "not a
lot of empty space around it", and the test now says so rather than
demanding a coverage the geometry forbids.

**Draw the circle you are replacing.** The dialog shows the old circle
dashed under the new shapes. It costs one arc and it is the entire argument
for the feature, made every time the dialog opens.

## 2026-09-08 — Fifty-one sliders, one component

Ryan asked for floating-point rotation and typeable number boxes. C-49.

**A survey before an edit.** Fifty-one call sites is too many to rewrite by
hand and too many to rewrite blindly. Matching them all with one regex first
-- and printing what it matched, with its label, its display expression and
whether the readout was a percentage -- turned a risky sweep into a reviewable
list. The one site that did not match (a flight limit, carrying `key={edge}`
and a computed `max`) showed up as a hole rather than as silent damage.

**Convert the display, do not re-author it.** Each readout was JSX children
like `{level.player.xSpeed}u/s`. A brace-matching scan that respects nested
quotes and template literals turned every one into a template string
mechanically, so not one of the fifty-one formats had to be retyped or
reasoned about. The two that already contained nested backticks came through
because a template inside `${}` is legal.

**The harness cannot press Enter.** Its key events carry an empty `key` and an
empty `code`, which is why the Enter path could not be tested here and the
blur path could. Driving the box through the native value setter and a real
`input` event -- the way React reads it -- tested the commit logic directly
and showed all four behaviours: a percentage mapping back through `scale`, a
clamp, an unparseable word left alone, and a negative decimal accepted. Noted
so the next session does not read an empty keydown as a bug in the code.

**Select-all on focus is undone by the click that focused it.** The caret the
browser places on mouse-up collapses the selection a moment after `onFocus`
selects. Swallowing the first mouse-up after a focus fixes it without a timer,
and leaves later clicks placing the caret normally.

## 2026-09-08 (later) — Two ways at the same problem

Ryan asked for box selection and for per-category visibility, and asked
whether GameBase could do background music. C-50, and an answer.

**They are the same complaint.** A stage with a nebula over a ship is hard to
select on, and the two requests are the two halves of the fix: take a region
rather than a point, and take a category out of the way. That is why the box
does not inherit C-41's decoration-last rule — the rule exists because a
click must choose one thing, and a box has been told exactly what to take.
Building both at once is what made that argument available; either alone
would have tempted a cleverer box.

**Hidden has to mean unselectable.** Drawing is the obvious half. The half
that matters is the hit test and the box, because an invisible thing you can
still grab is worse than a visible one in the way.

**The harness's screenshots and canvas readbacks lag its DOM reads.** Three
times this session a screenshot showed a selection box that the DOM said was
already gone, and once a pixel count said a category was still hidden after
the eye had been turned back on. The DOM read is the one to trust; a canvas
question needs a fresh frame and a second look. Already in memory from an
earlier session, and earned again.

## 2026-09-09 — Music, and the shape of the thing it belongs to

Ryan asked three things: build the music option he picked, introduce a Game
that owns Levels and assets, and export a playable game. C-51 is the first,
whole; F-09 and F-10 are the other two, designed and not built.

**Build the piece whose answer is already settled.** Music had a decided
storage question and a module in GameBase waiting to be used; the Game
concept has a storage migration over the user's own saved work and a field
(the player ship) whose move changes what an existing level means. Shipping
the settled one and writing the other one down beats starting both.

**A fixed database version is a real constraint, not a detail.** The obvious
reading of "keep it in the same IndexedDB store as the levels" is a second
object store in the same database. The facade opens at version 1 always, so
that store would never be created and every transaction would throw
NotFoundError. A separate database is the same idea and actually works.

**Two absolutely-positioned buttons in a row built for one.** LISTEN and
DELETE both pin to `right: 4px`, because every other card row carries one or
the other. They landed exactly on top of each other, and the bug surfaced as
"my click on play deleted the track" — which it did, in the test, before it
could do it to Ryan. Measuring both rectangles is what named it; the
screenshot showed one button and looked fine.

**The sibling genre had already answered the hard question.** Whether the ship
belongs to the Game or the Level was the one field I had flagged as a judgement
call. `runnjump`'s `GameDef` owns the hero, the assets, the components and the
levels — the exact list — so the shmup's Game is that shape rather than a
second opinion. Reading the neighbour before designing cost ten minutes and
removed the only real uncertainty.

**Two genres, one word, one scope.** `normalizeGame`, `emptyGame` and
`defineGameFormat` already existed in `runnjump`. The flat-scope test — which
exists because Pinball concatenates runtime modules into a single IIFE — caught
all three. Its own note says adding to the known-clash list should feel
expensive and removing is free; renaming was free here because nothing depended
on the names yet, so the shmup's carry the genre.

## 2026-09-09 (later) — The game is the shelf's shape, not the editor's

C-52. Ryan left the level-switcher placement to me.

**Find the seam that makes a big change small.** A Game owning the ship, the
sprites and the components could have meant touching the whole editor: every
`level.assets` read, every Inspector field, the render path. It did not,
because two functions in the engine — one splicing the shared parts in, one
stripping them back out — let the editor go on holding a plain Level. The
game is the shape the shelf holds; the level is the shape the work happens in.
Everything below the write-back effect is unchanged.

**Lifting is what makes sharing work.** `gameWithLevel` strips the ship, the
sprites and the components, so writing a level back would have quietly thrown
away an edit to any of them. The write-back lifts those three onto the game
first and then stores the rest. That one line is the difference between
"assets belong to a game" and "assets vanish when you edit them".

**A migration that copies is a migration you can be wrong about.** The levels
saved before Games are copied to the game shelf and left where they were. If
the conversion is bad, nothing is lost and the marker can be cleared.

**The stale Vite dep cache bit twice in one session.** Bumping `@ccllc/arcade`
while the dev server is running leaves the pre-bundled copy without the new
exports, and the page dies with "does not provide an export named X". Clearing
`node_modules/.vite` only works with the server stopped — doing it underneath a
running server just gets it rewritten from the old copy.

## 2026-09-09 (night) — A game you can hand to someone

C-53, and the renderer extraction that made it possible.

**The enabling fact was in a README.** An exported game needs an engine, and
bundling one at export time from inside a browser is not a thing. `arcade`
ships as plain ES modules with no build step — written down in its README for
a different reason entirely — so the export just carries the source and an
import map. Reading the neighbour's documentation beat inventing a build.

**Extract before duplicating.** The alternative to moving Starline's sprite
drawing into its own module was writing a second renderer for the player, and
a player whose sprites are nearly the editor's is worse than no player. The
move was mechanical because the drawing was already module-scope; what it cost
was an afternoon of care, and what it bought is that the two cannot drift.

**The harness cannot animate.** `requestAnimationFrame` returns zero ticks
while the Browser pane is hidden, even with `visibilityState` reporting
"visible", so the player froze after one frame and looked broken. Screenshots
force a paint, so the sim advanced three frames per screenshot; driving the
world directly through a temporary global proved the rest. Half an hour went
into suspecting the player before measuring the harness. Already in memory as
"rAF freezes when the pane is hidden"; the tell to remember is a canvas that
renders once and then never changes.

**Filters read the path you give them.** `cp` with a filter rejecting anything
containing `node_modules` copied nothing at all, because the source is *inside*
node_modules. The filter has to look at the path below the root, not the whole
of it.

## 2026-09-11 — Thirteen patterns, and the twenty that did not survive

C-54. Ryan asked for more formations, more flight patterns, and components on
formations.

**The adversary earned its keep.** Four designers proposed 34 patterns and a
verifier told to refute each one dropped 20. Almost every drop was redundancy
rather than error: a loop is a bezier with points, a boomerang is an arc, a
wheel is a ring with its own spacing, a lob is a sine. Left to the designers
this would have shipped twice the enum values for the same set of motions.
The lesson is that "is this new?" is a different question from "is this
correct?", and only the second one is obvious from the math.

**A survey before an edit, again.** The pattern enum lives in six hand-kept
copies and two were already stale — the JSDoc typedef never learned arc or
bezier. The gate is silent: a pattern implemented but missing from
MOVE_PATTERNS is rewritten to "straight" on every save. Finding that first is
what made the change boring instead of a debugging session.

**The second copy is where the rot is.** The arena had its own two lines of
wobble naming sine and zigzag, so every pattern added since had been silently
flat there. Nobody would have noticed until someone built an arena level with
a lane-holding enemy that flew dead straight. Extracting the shared function
fixed a bug that had not been reported yet.

**Validate at the boundary, once.** `normalizeItem` normalized eleven fields
and passed `group` through untouched, which meant a count of -3 reached the
formation code and placed nothing at all. Clamping it to one rather than
defaulting to five was the deliberate choice: the file described fewer than one
enemy, so it gets one, and inventing four the level never mentioned would be
the worse lie.

## 2026-09-12 — Nine of twelve were already there

C-55. Ryan sent the archetype list that had not come through with C-54.

**Answer the list before building against it.** Three quarters of it was
already in the editor, and two of those were not obvious — the bullet patterns
aim at the player in the scrolling modes, not only in the arena, which took
reading how the world hands a pattern its target. Checking first turned a
twelve-item request into a three-item one, and one of the three then turned out
to deserve its own slice.

**The adversary found the bug that would have shipped.** A lock resolved per
member latches the player a frame apart for each of them, and a five-ship vee
arrives visibly bent — 60 units of shear, measured by the verifier before I had
written a line. Resolving from the formation's anchor is a one-word change and
is invisible in every test that does not look for it.

**Then my own assertions were wrong twice.** A formation's members activate at
different times, so `releaseAge` — each member's own age at release — is not
comparable between them; two of my three new tests were measuring the wrong
quantity and failing for it. The fix was to measure world time: the frame a
departure was detected on, and the time flown since release. Worth writing down
because the test failing looked exactly like the feature being broken.

**A float-dust tiebreak is a real bug in geometry code.** The peel order is
sorted on offsets, and a rotated formation's offsets carry 1e-15 of trig dust;
a line at rotation 180 and the same line at rotation 0 are the same picture and
sorted to opposite orders. Rounding before comparing is what makes the queue a
property of the shape rather than of the rotation slider.

## 2026-09-12 — The scroll waits

C-56. F-11, the last of Ryan's archetypes: the mid-boss that dictates the pace
of the scroll until it dies.

**The feature was two lines of camera arithmetic and five ways to break the
run.** The advance itself is `Math.min(cameraEnd, cameraCeiling())`, and every
interesting decision was about what the ceiling must refuse. Only a body that
can die may hold, because nothing in the world ever clears a decoration's
`alive`. An `indestructible` body may not, because shots spark off it and never
reach its hit points. A body the parked camera could never bring on screen may
not, because bullets are culled past the far edge and it could never be shot.
Victory had to stop meaning "the camera arrived", or a blocker at the end of the
sector would be skipped entirely. Each of those is one line and each is the
difference between a feature and a level you cannot finish.

**I shipped the engine with the flag missing from its own type declarations.**
`pinAlong` went into the JS, the tests passed, 2.0.35 released — and the first
thing the editor did with it was fail to compile, because `index.d.ts` still
described the old options object. The engine half of a feature is not done when
the tests are green; it is done when the consumer can reach it. Worth writing
down because the gate cannot catch this: the declarations are hand-kept, the
engine's own tests are JS, and nothing in that repository type-checks against
them.

**The guard I was most confident about was the one I had not written.** I had
justified hiding the blocker toggle for an indestructible item as a UI nicety.
It was not: the engine happily normalized both onto one item, and nothing ever
cleared that body's `alive`, so the camera waited on a kill that could not
happen. The test failed on the first assertion before it ever reached the
end-to-end one. Hiding a control in the editor is not a guard — the data can
still say it, and something else will load that data.

**Then the reason it was *only* almost unwinnable turned out to be another
bug.** Ramming does clear an indestructible body's `alive`, because both contact
loops set it without checking the flag while the bullet loop checks it properly.
So the run was escapable, by the one route that makes the whole feature
pointless: a boss you can only kill by ramming is not a boss. That is filed
separately rather than fixed here, and the normalizer's guard is now the thing
standing between the two bugs.

**The minimap had been measuring the wrong view for as long as vertical levels
have existed.** Its brackets mapped the camera against `length - VIEW_W`, 1280
units, where a vertical level's scroll window is its 640-unit height. I only
found it because the blocker's stop line had to be drawn on the same strip and
the two disagreed; a tick that lands somewhere the camera never goes is obvious
in a way that a bracket nobody was comparing against anything was not. Adding a
second thing that reads a number is how you discover the first one was wrong.

**Two releases went out a commit behind and I did not notice for an hour.**
`npm run release` tags `origin/dev`, not the branch the work is sitting on, and
merges `dev-claude` into `dev` only afterwards -- so a fix committed and then
released in the same breath goes out in the *next* release, with the announced
version looking entirely correct. The script prints a NOTE saying exactly this;
I piped its output through `tail` and cut the warning off. What caught it in the
end was not reading the log but checking the behaviour: the end-to-end script
asked the installed package whether it dropped the bad pair, and it said no.
**Verify a release by what the published artifact does, not by the number it
was given.**

**The warning is computed against the real hit functions, because the honest
answer was surprising.** Contact destroys outright — both the nose and the
satellite set `alive = false` whatever the hit points say — so a blocker inside
the ship's reach turns a 400-point fight into a nudge. With the default forward
limit and satellite range, the default station of 72% is within about four units
of the satellite's maximum reach. Guessing at that arithmetic would have got it
wrong in both directions; reading `itemHitRadius`, `hitboxReach`, the flight
limits and the satellite's own clamp is what makes the warning worth trusting.

## 2026-09-12 — A Component is an object that is not anywhere

C-57. Ryan asked for saved Components to be editable from the palette rather
than by placing one, editing it, saving over the Component and deleting the
copy.

**The whole feature was a question about how much to duplicate, and the answer
was none.** A Component's `object` is a `LevelItem`; the only thing it lacks is
a position. So rather than write a Component form, the existing Inspector body
was pointed at a `subject` that resolves to either, with two writers standing in
for the two update functions. That is 46 `updateItem` calls, 12
`updateSelectedItems`, and 199 `selected.` references rewritten mechanically —
and the payoff is that the next field added to an object is added once. Had this
been built as a second form a week ago, C-56's blocker toggle would already be
missing from it.

**Exclusivity belongs at the one gate everything passes through.** The Inspector
now has three possible subjects, and the temptation is to have each entry point
clear the other two. `setSelection` already cleared the player, so the Component
is cleared there too and every route in sets itself afterwards. Placing a
Component then hands the Inspector back to the placed object for free, because
placement already calls `setSelection`.

**Resolve by id, not by holding the thing.** `editingComponent` is looked up
from the level on every render. That is what makes a rename show up in the
palette, an edit show up in the form, and a Component deleted from under the
Inspector fall back to the empty state instead of editing an object nothing
points at any more.

**A number that is only true once something is placed.** The screen-blocker note
quotes the sector position the scroll will stop at, computed from the object's
`x`. A template's `x` is wherever the object it was saved from happened to
stand, so the note was confidently wrong. It now reports the distance the camera
keeps from the body instead — the part of the answer that travels with the
Component — and only a placed object is judged out of reach. **Reusing a form
means auditing what each field means for the new subject, not just whether it
renders.**

## 2026-09-13 — The rest of the shelf, and a comment worth disbelieving

Ryan left the second half of C-57 to me: whether weapon, armor and satellite
Components should be editable too, and by what gesture.

**The codebase had already answered it.** `applyEquipmentComponent` treated a
pattern as "apply it to the selection, or open it for editing if there is
nothing to apply it to" — the exact question I was weighing for the other three.
Extending that rule cost nothing in surprise and meant no second affordance to
explain. Looking for the convention beat inventing one.

**The thing that rule displaces was worth displacing.** Clicking a weapon card
with nothing selected used to add it to the player's inventory and equip it —
a loadout change as the silent side effect of clicking a card in a palette.
It is now a button inside that Component's own Inspector. Same capability, and
the intent is said out loud instead of inferred from what happened to be
selected.

**I nearly built on a comment that was false.** `saveAsComponent` said
normalizeLevel "reinstates the built-in library on every load, replacing same-id
entries, so a copy is the only form of one the user can edit and keep." If true,
offering the built-in Pulse Cannon for editing would have been a data-loss bug
I had already shipped for object Components. The code does the opposite: it
seeds the built-ins and then lets the level's own entries replace them. Ten
lines of node against the real `normalizeLevel` settled it in a minute.
**A comment is evidence about intent, not about behaviour** — and this one has
been corrected.

**The same lint trap twice in two days.** Arrow functions defined inside an IIFE
in JSX are not recognisable as event handlers, so everything they close over
reads as a ref touched during render. The fix both times was to hoist the
closures beside the value they edit and let the markup stay markup.