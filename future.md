# Future Features

This file is the planning backlog for ideas that are not yet approved for implementation. Active ideas use sequential `F-` identifiers, beginning at `F-00`. Adding an idea here records and develops the concept; it does not authorize implementation.

When a future item is completed, move it to the **Completed Features** archive at the end of this file and renumber the archive sequentially as `C-00`, `C-01`, and so on. Reuse the vacated `F-` number for the remaining active backlog so that both sections stay compact.

## F-00 — Bullet colour for ordinary weapon fire

The bullet-pattern designer already picks colours, per array, but ordinary fire cannot be recoloured. A player Weapon Component carries a `color` — the built-ins are lime, cyan and amber — and nothing in the Inspector edits it; an enemy's `Weapon` has no colour field at all, so its shots take their colour from the projectile type the renderer is given. Expose a colour control for both.

The two halves are not the same size of change: surfacing the existing `ComponentWeapon.color` is work in this repository, while giving an enemy `Weapon` a colour adds a field to the level contract in `@ccllc/arcade`. Decide the default for levels saved before it, whether the projectile sprite choice keeps any say once a colour is set, and whether the muzzle flash, impact burst and shield-absorb effects follow the bullet colour or stay as they are.

## F-01 — Import raster image files as sprite assets

Let the user bring a PNG, GIF or JPEG in as a sprite asset instead of drawing every sprite by hand in the raster editor. The importer has to resolve the image onto the editor's pixel grid: choose or infer a canvas resolution, resample to it, decide how transparency and near-transparent edges are treated, and optionally quantise the palette so the result stays editable as pixel art rather than becoming an unpaintable photo.

The raster editor lives in `@ccllc/studio`, so the import UI belongs there, while the size limits belong to whatever this repository is willing to carry: assets travel inside the level through `localStorage`, export files and share links, and a photograph pasted at full resolution would blow all three. Define the ceiling, what happens when an import exceeds it, and how imported assets are attributed in the asset list.

## F-02 — Import SVG files as vector sprite assets

Bring SVG artwork in as a **vector** sprite asset: parse the file into the vector editor's own shape model so it arrives editable — nodes, fills, strokes, ordering and transforms — rather than being flattened to a preview or rasterised onto a pixel grid. Half of that is already solved, since the vector editor stores editable source data rather than a flattened image; the import is the mapping from arbitrary SVG onto that model.

Imported SVG is untrusted input and must be validated before it is trusted, in the same spirit as `normalizeLevel`: no scripts, no external references, no remote fetches. Define what becomes of the constructs the vector document has no shape for — gradients, filters, clip paths, masks, text, and transforms it cannot express — whether they are approximated, dropped with a warning, or refuse the import outright, and how a file that is mostly unsupported reports what was lost. The vector editor lives in `@ccllc/studio`, so the parser and its UI belong there.

## F-03 — Editable backdrops

The backdrop is hardcoded in the renderer: one purple nebula gradient and 155 procedurally scattered stars, generated at mount. A level carries no background of its own — `Level` holds version, name, length, player, items, assets and components — so every sector looks the same behind the action. Let the level author its backdrop: a base colour or gradient, star density and colour or none at all, and one or more parallax layers that can use a sprite asset.

This adds a field to the level contract in `@ccllc/arcade` and rendering here. Define the layer model and how it relates to the existing background decorations, which already scroll at their own parallax and largely cover this ground for discrete objects; the useful distinction is probably that a backdrop tiles or stretches while a decoration is placed. Keep the starfield's presentation-side freedom — it is not simulation state and is allowed its `Math.random` — and give old levels the current look by default.

## F-04 — Foreground terrain

Terrain today is a single colliding layer drawn with everything else: only `enemy` and `terrain` items take player bullets, while decorations, which do have a `foreground` draw layer with opacity and parallax, are scenery that nothing can hit. Neither gives a ceiling or a rock face that passes in front of the ship and still stops a shot.

Add terrain that draws in front of the player while keeping its collision, and decide the pieces that follow: whether "foreground" is a flag on the existing terrain type or a new type, whether foreground terrain is opaque or takes the decoration layer's opacity, how it reads in the editor when it covers the objects being placed, and how the player is meant to survive a screen where the danger is drawn over the ship. Collision belongs to the simulation in `@ccllc/arcade`; the draw order belongs here.

## F-05 — GameBase co-op compatibility

Make a run playable as lockstep co-op on the GameBase system. Most of the foundation is already there and needs nothing: the simulation in `@ccllc/arcade/shmup` runs a fixed 120 Hz step, never reads a clock, never calls `Math.random`, and already does its trigonometry through the deterministic `sin`/`cos`/`atan2` helpers in `@ccllc/arcade/core` — the only `Math` trig left in that package sits inside comments explaining the rule. Starline's own `Math.random` is confined to particles and the starfield, which are render-side and are allowed to differ between players. `@ccllc/arcade/net` ships the rest of the machinery: WebSocket and loopback transports, a seeded xorshift128 generator, and an input log recording `[step, bitstring]` against a named action list.

Starline does not import `@ccllc/arcade/net` at all, so wiring it is the first work — but two things block a straight wiring job, and both are decisions before they are code:

- **The world is single-player.** `WorldInput` carries one `dx`/`dy`/`fire`, and a `World` owns one `state.player`. A second ship is a change to the simulation model in `@ccllc/arcade`: lives, score, weapon slots, satellites, respawn and the victory condition all assume one player today.
- **Not all of Starline's input fits the log.** The recorder captures booleans per named action, and its `axis()` derives an axis from two of them, but `WorldInput.satellitePointer` is a continuous `{x, y}` read straight off the canvas pointer, and `satelliteAxis` comes from analog pad axes. The mouse-aimed satellite control that is half of `C-09` has no representation in a bitstring. Either the log format grows analog channels, or aiming is quantised for co-op and the pointer scheme stays host-local.

The remainder is session work: a lobby or invite path, agreeing the level and its custom sprite assets before the first step so both peers normalize to identical data, a step-scheduling policy for latency, and a desync check — the input log and `replayRun` together already give a way to prove two peers agree. `ACTIONS` in this repository is already the named action list `createInputRecorder` wants, and `createLoopbackPair` makes a two-player test possible without a server.

One nit found while reading for this: the editor's motion-path preview predicts a selected object's sine and zigzag path with `Math.sin`/`Math.asin` while the simulation flies it with the shared helpers, so the drawn path can differ slightly from the real one. It is presentation and cannot desync anything, but it is the one place in this repository where the two trigonometries disagree about the same curve.

## F-06 — Adopt more of the ElectricBlazor suite

Starline uses four of the roughly sixty components `@electricblazor/react` ships: the accordion behind both tool panels, the tabbed card behind the palette switch, the numeric input in the Inspector, and the dialog behind the confirms and the settings. Everything else is hand-written — 41 buttons, 34 range sliders, 17 selects and two checkbox toggles in `StarlineGame.tsx` alone, each with its own rules in `globals.css`. Replace what the suite already does better, and take the capability where the suite has one and Starline has none.

The clearest candidates, roughly in order of what they would pay back:

| Hand-rolled today | Suite equivalent |
| --- | --- |
| Every `<button>` and its CSS | `EbButton` (variants, disabled, focus ring) |
| 34 `.range-field` sliders | `EbNumericInput` with its slider enabled — already imported, currently passed `sliderEnabled={false}` and hidden in CSS |
| The NEW / SAVE / LOAD / IMPORT / EXPORT row | `EbSaveMenu` (`@electricblazor/react/save`) |
| `.palette-card` grids | `EbTile` / `EbTileGrid` (`/tile`) |
| Weapon slots and inventory order | `EbSortableList` with `moveItem` |
| ~~Fixed side-panel widths~~ | `EbSplitter` — **evaluated and not adopted**, see C-18 |
| Bullet colour fields (`F-00`) | `EbColorPicker` / `EbColorSwatch` / `EbCssColorField` (`/color`) |

`F-00` should be built on those rather than hand-rolled, so it is worth reading together with this one. The side-panel row is struck through because the splitter *was* tried and rejected for a stated reason — C-18 records it, and that rejection is specific to this layout rather than to the component.

Two things bound the sweep. **The suite has no select and no toggle** — there is no `EbSelect` or `EbSwitch` anywhere in the package — so the 17 selects and the two checkbox toggles stay native whatever else moves. And **the colour pickers stay rejected for hue tint**: they pick colours, while tint is a hue *rotation*, and a swatch showing a colour the game never renders is worse than the slider. That rejection is recorded in AGENTS.md and is specific to tint; it does not extend to `F-00`, where a bullet colour really is a colour.

Adopt per component rather than in one pass, with the test being whether the result survives the cockpit's density: Starline runs 8–10px mono type and roughly 31px controls, tighter than the suite's defaults, and the palette's tab strip already needed overrides to fit two tabs and more to fit three. Keep the swaps that hold up and revert the ones that fight it. The mechanics are settled and should not change: `styles.css` is imported once in `layout.tsx` and already carries every component's stylesheet, including the subpath ones, so a new component needs no new stylesheet; `theme.css` is never loaded, because the `--eb-*` bridge in `globals.css` maps the suite's tokens onto Starline's palette; and appearance overrides go through the suite's stable public class names scoped under `.workspace`. The package is a committed tarball, so a component that needs a newer release means re-packing `vendor/` first.

# Completed Implementation Plan

The ten features should be delivered as a series of compatible foundations rather than ten isolated additions. The key is to establish stable data models and generic editor operations first, then let the editor, asset, and combat workstreams progress in parallel.

## Phase 0 — Architecture, schemas, and migration safety

1. Design the next version of the level format with explicit reusable structures for transforms, sprite appearance, asset references, Components, weapons, armor, player slots, inventory, and satellites.
2. Add migration from existing levels so current `size`, `scale`, `rotation`, sprites, weapons, and player settings load without data loss. Preserve forward compatibility by ignoring unknown optional fields safely.
3. Replace single-purpose history edits with a command/transaction layer that can record a whole drag, multi-object transform, keyboard rotation, Component update, or sprite-edit action as one undoable operation.
4. Define stable IDs and ownership rules for built-in assets, user assets, Component definitions, Component instances, equipped weapons, and inventory entries.
5. Decide how custom raster/vector assets travel with saved levels and Components, including validation, storage limits, missing-asset fallbacks, and import conflict handling.

This phase unblocks every later phase and should be completed before parallel feature work begins.

## Phase 1 — Unified selection and transform tools

Deliver `C-01`, `C-02`, and `C-00` together because they all depend on the same selection model and transform math.

1. Change editor selection state from one Object ID to a set of IDs, then add `Ctrl`/`Cmd` toggle-selection and `Shift` additive-selection.
2. Build generic group bounds, pivot, translation, rotation, and proportional scaling operations that work for one or many Objects.
3. Add `Q`/`E` rotation using the shared transform command, with coarse and fine increments and input-field safety.
4. Add on-canvas resize and rotation handles on top of the same transform operations, including cursor feedback, pointer capture, snapping rules, and one-step undo.
5. Update duplication, deletion, Inspector mixed values, selection rendering, keyboard help, and hit testing for multiple selected Objects.

Completing the keyboard path before the handles gives the transform engine a smaller test surface before pointer interactions are added.

## Phase 2 — Components and modular equipment foundation

Build the reusable portion of `C-03` and the data-model portion of `C-04` together.

1. Create a generic Component definition and instance model with snapshot-based instances initially. Clearly label when an Object is derived from a Component, while allowing local overrides.
2. Add the Object Palette / Components Palette tabs, collapsible root categories, save-as-Component, rename, duplicate, update, and delete flows.
3. Extract current enemy and player gun data into a reusable Weapon definition that can be saved as a Weapon Component.
4. Add compatibility tags for weapon slots and Weapon Components without changing gameplay to multiple weapons yet.
5. Extend save/load/import/export and undo/redo to include Component libraries and references.

The Component system becomes the shared packaging mechanism for later custom sprites, armor packages, weapon loadouts, and satellites.

## Phase 3 — Shared sprite asset pipeline

Start `C-05`, `C-06`, and `C-07` from one common asset architecture. Once the asset registry and editor shell are stable, raster and vector tool development can proceed in parallel.

### Shared work

1. Add a Sprite Asset library with thumbnails, stable IDs, naming, duplication, deletion safety, usage tracking, and missing-asset handling.
2. Create a reusable sprite-editor window with canvas navigation, zoom, undo/redo, save/cancel, live in-game preview, and asset assignment.
3. Define one renderer interface for built-in, raster, and vector sprites so the playfield, gameplay, palette thumbnails, and Inspector do not need separate feature-specific branches.
4. Add non-destructive hue tint at the renderer boundary and expose the `C-07` Inspector control immediately; this lets tinting be tested against every sprite source as the editors mature.

### Parallel workstream A: Raster editor (`C-05`)

Implement resolution selection, pixel storage, nearest-neighbor rendering, paint tools, transparency, palette tools, grid/zoom behavior, flips, and asset serialization.

### Parallel workstream B: Vector editor (`C-06`)

Implement vector document storage, shape/path tools, node editing, styles, ordering, transforms, preview rasterization, safe parsing, and asset serialization.

Finish with cross-format tests covering tinting, scaling, Components, export/import, thumbnails, and runtime performance.

## Phase 4 — Damage, armor, and multi-weapon gameplay

Develop `C-08` and the runtime portion of `C-04` side by side because both require a formal combat pipeline.

1. Introduce a single damage event and resolution system used by player shots, enemy shots, collisions, armor, shields, and destruction.
2. Implement Armor definitions, starting with standard armor and force fields, then add recharge timing, overflow damage, HUD state, and effects.
3. Implement player weapon slot compatibility, inventory capacity, equipping, pickup behavior, and simultaneous firing through the Weapon Components created in Phase 2.
4. Add editor controls for slot count, accepted weapon tags, inventory size, starting inventory, starting loadout, armor, and shield settings.
5. Test combinations of shot power, multiple projectiles, cooldowns, shields, armor modifiers, pickups, death, restart, and level serialization.

The damage pipeline should land before the full HUD and effects so gameplay rules can be validated independently of presentation.

## Phase 5 — Satellite control and loadouts

Implement `C-09` after Weapon Components, input abstraction, and the damage pipeline are stable.

1. Create action-based input mappings for ship movement, satellite movement/aiming, firing, equipping, and pause across keyboard, mouse, and controller.
2. Prototype orbit, tethered movement, and aim-only modes against both twin-stick and mouse-and-keyboard control schemes; choose sensible defaults while keeping modes configurable.
3. Add the satellite entity, screen/tether constraints, collision and damage rules, destruction/return behavior, and Weapon Component slots.
4. Add player-setting controls for satellite availability, mode, range, speed, durability, weapon compatibility, and initial loadout.
5. Add clear aiming, tether, shield, damage, and respawn feedback without obscuring the main ship or enemy projectiles.

## Phase 6 — Integration and release hardening

1. Exercise every new feature through undo/redo, duplicate, multi-select, save/load, Components, level export/import, fullscreen, keyboard, mouse, and controller use.
2. Test and migrate representative older saved levels, including levels with no custom assets or new combat fields.
3. Add safeguards for deleting in-use assets or Components, conflicting imports, malformed vector data, oversized raster assets, and inventory/loadout incompatibilities.
4. Profile large levels containing many tinted custom sprites, multi-weapon fire, shields, and satellites; cache rendered assets and thumbnails where needed.
5. Update contextual help, hotkeys, empty states, Component documentation, and example content, then release behind a versioned level-format migration.

## Parallel delivery map

| Workstream | Primary features | Can begin | Depends on |
| --- | --- | --- | --- |
| Editor interaction | `C-00`, `C-01`, `C-02` | After Phase 0 selection/history design | Command transactions and multi-selection state |
| Reusable content | `C-03` and Weapon Components | After Phase 0 schema design | Stable IDs, asset/reference ownership |
| Sprite authoring | `C-05`, `C-06`, `C-07` | After shared Sprite Asset registry | Asset serialization and renderer interface |
| Combat equipment | `C-04`, `C-08` | After Weapon Components are defined | Damage pipeline, compatibility tags, inventory schema |
| Satellite systems | `C-09` | Input prototypes may start during Phase 4 | Weapon slots, damage pipeline, action-based controls |
| Persistence and QA | All features | Continuous from Phase 0 | Versioned fixtures and migration coverage |

The best concurrency point is after Phase 0: one stream can build selection/transforms, a second can build Components, and a third can establish sprite assets. Raster and vector editors can then split into parallel efforts, while combat work starts as soon as Weapon Components are stable. Satellite input experiments can run alongside multi-weapon and armor development, but the production satellite system should wait for those shared foundations.

# Completed Features

Completed future items are archived here in completion order. The original ten-item Foundry plan was completed on 2026-08-13 and is retained below as the design record.

## F-07 — The player ship's own hitbox

C-48 gave every item a hitbox and left the player a circle. The ship strikes
enemies as a disc of `playerRadius`, and every collision the world makes is
disc-against-item; a shaped ship means shape-against-shape, which is a
different and heavier test. When the ship's silhouette matters enough — a
long thin fighter, a wide bomber — give the player a `hitbox` in the same
frame and test polygon-against-polygon by separating axes, with the disc test
kept for bullets. Until then the ship is round.

## F-08 — Selection by hitbox in the editor

Clicking an item on the stage still tests the old circle, so an item with a
tight hitbox is selectable in the empty space its art no longer collides in.
Harmless, since selection is not collision, and the wider target is easier to
click; noted because someone will expect the two to match once the debug
rings show them differing.

## F-10 — Export a playable game

Ryan: "the idea will be that the user can export a playable version of their
game."

A single file the author can host, mail or open: the engine, the editor's
renderer minus the editor, the Game's levels, its assets inline, and its music.
Depends on F-09 for what "the game" is. Two decisions to make first — whether
the export is one HTML file with everything inlined (simple to hand around,
megabytes large, and the music makes it tens of megabytes) or a folder with
the audio beside it; and whether the player is a build of Starline's own play
mode or a smaller purpose-built shell.


## C-00 — On-canvas rotation and resize handles

When a playfield object is selected, add direct-manipulation handles around its selection circle. A rotation handle should let the designer rotate the object by dragging, while one or more resize handles should scale it proportionally. The handles should remain usable across object sizes and canvas zoom levels, provide live visual feedback, and update the same rotation and scale properties exposed in the Inspector. A drag should be recorded as one undoable operation.

## C-01 — Multi-object selection

Support selecting multiple playfield objects with modifier-assisted clicks. `Ctrl`/`Cmd`-click should toggle an object in or out of the current selection, while `Shift`-click should add objects without clearing those already selected. Selected objects should be visually distinguishable as a group and support common operations such as moving, duplicating, deleting, rotating, and scaling together. The Inspector should show shared values where possible and clearly represent mixed values.

## C-02 — Keyboard rotation shortcuts

Add fast rotation controls for the current selection: `Q` rotates counterclockwise and `E` rotates clockwise. Use a predictable angular increment, with the option for a modifier key to provide finer adjustment later. The shortcut should work for both single- and multi-object selections, respect the objects' existing rotation values, and create clean undo/redo history entries without firing while the user is typing in an input field.

## C-03 — Reusable Components Palette

Allow any selectable playfield Object—enemy, terrain, group, powerup, upgrade, decoration, or another supported root type—to be saved with its current settings as a reusable **Component**. Convert the existing Object Palette into a tabbed panel with **Object Palette** and **Components Palette** tabs. Components should appear in the same collapsible categories as their root Objects, retain all configured child data and behavior, and be placeable like built-in palette entries.

Components need basic management tools, including a name, save/update flow, duplication, and deletion with confirmation. Define whether edits to a placed Component instance remain local or can be applied back to its saved definition. Add **Weapon Components** as a supported component type so configured weapons—including projectile and firing behavior—can be saved independently and attached to compatible enemies or player weapon slots.

## C-04 — Player weapon slots and inventory

Expand the player ship from a single active gun to multiple simultaneous weapon slots. Each slot should define which weapon Components or weapon classes are compatible with it, allowing ship designs to restrict what can be equipped in each position. Player ship settings should define the number of active slots, the total inventory capacity (`N` weapons), and the initial slot loadout.

During play, the player should be able to acquire weapons into inventory, equip compatible weapons into available slots, and fire all active slots according to their individual cooldowns and projectile behavior. The design should specify how full inventory, duplicate weapons, upgrades, slot replacement, and saved level data are handled before implementation.

## C-05 — Raster Sprite Editor

Add a built-in raster sprite editor that works like a compact pixel-paint program. The user should be able to choose the sprite canvas resolution, ranging from deliberately chunky grids such as 8×8 or 16×16, through a 32×32 style, up to a higher-resolution canvas with small individual pixels. The chosen resolution should determine the real artwork grid rather than merely applying a visual pixelation effect.

Provide essential tools such as pencil, eraser, fill, eyedropper, color selection, transparency, grid visibility, zoom, undo/redo, clear, and horizontal/vertical flip. Sprites should be saved into the project’s asset library with a name and stable identifier, appear as choices anywhere a sprite can be assigned, and remain crisp under nearest-neighbor scaling when the pixel-art mode is used. Level export/import must include or safely reference custom raster assets.

## C-06 — Vector Sprite Editor

Add a companion vector sprite editor for creating artwork that remains sharp at any size. It should support a focused set of shape and path tools: selection, line, polygon, ellipse, rectangle, pen/path editing, fill, stroke, stroke width, node movement, layering, alignment, grouping, and object transforms. A live preview should show the sprite at typical in-game sizes so intricate artwork does not become unreadable during play.

Vector sprites should use the same asset library, naming, preview, assignment, duplication, and deletion flows as raster sprites. Store editable vector source data rather than only a flattened preview, while rendering it efficiently in the editor and game. Level export/import must preserve custom vector assets and validate unsupported or malformed data before loading it.

## C-07 — Sprite hue tint

Give every Object that displays a sprite a non-destructive tint attribute, initially expressed as a hue rotation. The original sprite asset should remain unchanged; each placed Object or Component instance can apply its own hue value and preview the result immediately in the playfield, Inspector, minimap where practical, and gameplay. The tint must work consistently with built-in, raster, and vector sprites, as well as duplicated Objects and saved Components.

Expose a hue slider plus a reset action in the Inspector, and store the setting in level and Component data. Define predictable behavior for grayscale or low-saturation art, where hue rotation may have little visible effect, and ensure tinting does not unintentionally alter opacity, selection highlights, glow colors, or collision behavior.

## C-08 — Armor types and force fields

Introduce configurable defensive systems for player ships and eligible enemies. An Armor definition should describe its type, capacity or durability, damage modifiers, and any special rules. Initial types could include standard hull plating, heavy armor, ablative armor, and a force field. Force fields should have shield capacity, depletion, recharge delay, recharge rate, break feedback, and a clear rule for damage that exceeds the remaining shield.

Route all projectile and collision damage through a shared damage-resolution pipeline so weapons, armor, shields, shot power, and future damage types interact predictably. Show player shield/armor state in the HUD and provide readable effects when a force field absorbs damage or collapses. Armor should be eligible for the Component system so a configured defensive package can be reused, assigned, saved, imported, and upgraded without duplicating its rules.

## C-09 — Independently controlled satellite ship/weapon

Add a satellite craft or weapon platform that accompanies the player but can be aimed or moved independently. Support a twin-stick controller scheme in which one stick flies the main ship and the other controls or aims the satellite, plus a mouse-and-keyboard scheme in which the keyboard flies the ship and the pointer directs the satellite. The intended feel is similar to the independent aiming and positioning in *Forgotten Worlds*.

Define satellite operating modes such as orbiting the player, moving within a tethered range, or aiming around the player while maintaining a fixed radius. A satellite should be able to hold compatible Weapon Components, obey its own firing rules, and have explicit behavior for collisions, damage, destruction, respawning, and screen boundaries. Controls must degrade gracefully when only a keyboard or single-stick input is available, and the editor should expose satellite availability, movement limits, loadout, and input behavior in player settings.

## C-10 — Bullet hell pattern designer

Add a visual bullet-pattern authoring system built around a configurable gun/emitter and a stack of oscillators. A basic emitter should define its origin, base firing angle, aiming mode, firing rate, burst timing, projectiles per shot, bullet sprite, bullet speed, power, acceleration, lifetime, and optional spread. It should be usable by enemy, player, satellite, and standalone Weapon Components without duplicating the simulation rules.

Each oscillator should modulate a chosen emitter property—initially firing angle, with firing rate, spread, bullet speed, and emitter position available as later targets. An angular oscillator needs a waveform, amplitude, period or frequency, phase, and direction. Start with sine, triangle, sawtooth, and square waves. Multiple oscillators can be layered additively, reordered, muted, duplicated, and edited independently. The core angular model can be expressed as:

```text
angle(t) = baseAngle + Σ amplitude[i] × waveform(2πt / period[i] + phase[i])
```

Combining oscillators with different periods should produce interference-like, Lissajous-style, and slowly evolving patterns. Also support rotating radial emitters, mirrored emitters, fixed-angle fans, aimed shots, alternating directions, and child emitters so designers can build familiar danmaku structures from the same small set of primitives.

The editor should provide a safe real-time preview with play/pause, restart, time scrub, single-step, simulation speed, and optional projectile trails. Show the emitter direction and oscillator curves, and allow a designer to isolate one oscillator to understand its contribution. Preview and gameplay must use the same deterministic simulation, including a saved random seed where randomness is enabled.

Patterns should be saveable as **Bullet Pattern Components**, assignable to compatible weapons, and portable through normal level save/load and import/export. All edits must participate in undo/redo. Include starter presets such as pendulum sweep, layered flower, spiral, aimed fan, alternating wave, and rotating ring.

Add performance and readability safeguards: a configurable projectile cap, warnings for extreme spawn rates, preview-only collision disabling, automatic cleanup by lifetime or bounds, and a live estimate of bullets per second and maximum concurrent bullets. These limits should warn the designer without silently changing the authored pattern.

> Completed 2026-08-14. Implemented as a portable deterministic engine, a Basic/Advanced visual studio, reusable Pattern Components, and shared enemy/player/satellite runtime integration. The requested Shape Editor was intentionally omitted.

> Extraction note, 2026-08-17: the pattern engine now lives in
> `@ccllc/arcade/shmup` (`patterns`), fired by the shared world step, and the
> designer is `BulletPatternStudio` in `@ccllc/studio` — the same split the
> sprite editors (C-04/C-05 territory) received. Starline carries only the
> wiring: open the designer, store patterns in the level, and render what the
> world fires. This file's C-10 spec remains the design record.
## C-11 — Scrollable palette pane and per-section scrolling

The Object/Component pane scrolls as one column. The panel heading, player card, tool strip and OBJECTS/COMPONENTS/ENHANCEMENTS strip travel with the list rather than staying pinned above it, and `.palette-panel` is the pane's only scrollport — the accordion inside the tab panel, which used to own the scrolling, now takes its natural height. Each expanded palette section additionally scrolls inside its own card once it outgrows 46vh, so one crowded category cannot push every sibling section past the bottom of the pane.

The stacked layout below 760px keeps neither scrollport, because the page itself scrolls there and a nested one would fight it. The Inspector was left on its existing whole-panel scroll; capping its sections would have trapped the sliders inside short scrollports for no gain.

> Completed 2026-08-19. The pane taking a scrollbar of its own costs the 214px column about 15px of width, which is why both side panels now ask for a thin one, and why the tab strip sizes its tabs to their labels instead of splitting the width three ways.

## C-12 — Toolbar Behavior setting

An **EDITOR SETTINGS** dialog, opened from the topbar and sharing the confirm dialog's chrome, carries a single **TOOLBAR BEHAVIOR** choice: *several sections open* — the original behavior, and still the default — or *one section at a time*. It governs the collapsible sections in the palette and in the Inspector alike, each panel keeping its own one open section so that opening a palette category never shuts an Inspector section.

The choice is a property of the user rather than of the level, so it is stored in `starline-editor-settings-v1` in localStorage, stays out of level save/load, export/import and undo history, and is restored after mount for the same reason the level draft is: the exported HTML was built without it. It is written where the choice is made rather than from an effect on the value, so the restore cannot be raced by a write of the default.

> Completed 2026-08-19. Switching to *one section at a time* leaves whichever section each panel opened last still open; a panel that has not opened one yet — a fresh load, for instance — starts fully collapsed, which is the honest reading of the setting rather than an oversight.

## C-13 — Saved Components separated from built-in Enhancements

The palette's COMPONENTS tab held two different things: the definitions the user had saved, and the fixed equipment library that arrives with every level. **Components** now means only the former — a saved Object with its settings, or a saved weapon, armor, satellite or pattern — alongside the custom sprite assets, which are authored content by the same argument. The built-in library moved to a third **ENHANCEMENTS** tab, where each card carries a **+** action that saves an editable copy of it into Components under a fresh id.

No change to the level format and no migration were needed: the id prefix already told the two apart, since `normalizeLevel` reinstates the built-ins on every load with fixed ids (`weapon-pulse`, `armor-forcefield`, …) while anything the user saves is minted as `component-…` — the same test that has always gated the delete button. A saved copy is the only form of a built-in that can be edited and kept, because the library replaces same-id entries as a level loads.

> Completed 2026-08-19. Both tabs render the same card through one helper; only the corner action differs, because only one of the two is the user's to delete.

## C-14 — Sprites are baked once and blitted, not re-rasterised every frame

Every sprite this game draws is a vector recipe — paths, gradients, a stroke, and a `shadowBlur` on all of them — and `drawSprite` was running the whole recipe again for every enemy, every frame. Measured against this game's own peak of 690 simultaneous entities (a dense sector played to the player's death: 560 enemies, 126 enemy bullets), that costs **7.7 ms a frame, 47% of a 60fps budget**. Baked into `createSpriteCache` from `@ccllc/arcade/render` and blitted, the same 690 sprites cost **1.3 ms**. Six bakes covered every tint in that run.

The recipes are untouched. `drawSprite` split into `paintSprite`, which is the recipe drawn at the origin and is the only place a sprite's appearance is decided, and `drawSprite`, which resolves a baked region and blits it. **The split is the specification**: everything that changes the *pixels* belongs in the cache key, and everything that only *moves* them stays per-instance. Position, rotation, `scale` and the horizontal flip are transform state and alpha is compositor state, so all five cost nothing at blit time — `scale` especially, which is authored anywhere in 0.25 to 4 and would otherwise be a fresh bake per value. Sprite id, size and tint change the pixels, so they are the key.

Custom assets key on identity rather than content: they are documents the Sprite Studio edits, and `updateLevel` replaces the asset array immutably, so a save produces a new object. A `WeakMap` turns that into a key without hashing the asset on every frame. Two cases deliberately do not bake — a sprite above size 72, which is a backdrop with a handful on screen rather than hundreds, and the selected one, of which there is exactly one and whose dashed ring would double the key space for nothing.

**A baked sprite is visually equivalent but not bit-identical**, and that is worth knowing before anyone diffs a screenshot. Blitting a rasterised sprite resamples it, where drawing the vector rasterised once at the final position; about 1.3% of canvas bytes differ, at sprite edges, against a 0.18% floor from the randomised starfield. It is not clipping: quadrupling the bake region moved that figure by 0.01%, and pixels gained (452) and lost (383) are balanced, which is the signature of a sub-pixel edge shift rather than missing content. `bakeHalf` still carries real margin — the widest any recipe reaches is the comet's tail at 1.7× size.

Needed `@ccllc/arcade` to move from `^1.3.5` to a build carrying the `render` module. The 2.x major was the coop wire protocol and does not apply here, which the arcade's own journal had already established for Pinball; the bump was a version and a lockfile, with no source change.

> Completed 2026-08-24. Landed first against `2.0.2-dev.178` off the dev channel, because `render` was newer than any release; GameBase cut **2.0.2** the same day and both `@ccllc/arcade` and `@ccllc/studio` now sit on `^2.0.2`. Studio moved with it deliberately rather than being left behind on `^1.3.5`: the two release in lockstep from one repository and studio's types are built against the arcade's, so a 1.3.5 studio beside a 2.0.2 arcade is drift waiting to be found later.
## C-15 — Vertical overhead shooter mode

Was F-02. A level now declares `mode: "vertical"` and plays as the classic
climb: the 640 square letterboxed on the wide screen, later content entering
from the top, the ship low. The scroll axis went to the simulation exactly as
this entry predicted — `viewSpans(mode)` in `@ccllc/arcade/shmup` swaps the
window and the playfield, items keep meaning "distance along, position across",
and the editor authors the same strip it always did, so old levels load
untouched as horizontal. The renderer turns the scene a quarter turn at the
game's edge and the input turns it back. Ships with the **Skyfall Run** sample.

## C-16 — Overhead twin-stick shooter mode

Was F-03. `mode: "arena"`: the camera keeps advancing but shifts nothing —
it is the wave clock, so the editor strip becomes a timeline and `length` the
run's duration in units it already scrubbed. An item's y becomes a bearing
around the perimeter; enemies spawn just outside it and home on the player,
sine and zigzag wobbling perpendicular to their heading. The right stick — or
the mouse, when the stick is idle — aims the guns through the `aim` vector
`WorldInput` grew for it, and the satellite rides the aim side, which is the
recorded trade for not burning a third control. Ships with the **Null Point
Arena** sample. Terrain holds its spawn point and is not yet useful there;
that, a scroll-axis starfield for vertical, and a rotated vertical editor view
are the follow-ups this left open.

## C-17 — Designed explosions, and the explosion designer

The renderer used to answer every `drainBursts()` request with the same
hand-rolled spray — a loop of `Math.random` particles drawn as identical
squares, in the colour the world asked for. Explosions are documents now.
`@ccllc/arcade/burst` owns what one is; `app/explosions.ts` owns which three
Starline ships with, and `app/BurstDesigner.tsx` is the panel that edits them
(topbar: **✳ EXPLOSIONS**).

**Three roles, chosen by the engine's own numbers.** A `Burst` is
`{ x, y, color, count }`, and `count` is the only size signal it carries —
but the engine's call sites cluster, so the mapping is two thresholds rather
than a field the level format would have to grow: chip hits at 5–7, shots and
shields giving out at 10–14, and everything that dies outright at 18–24.
`tests/explosions.test.mjs` drives the real world headless, kills real
enemies, and asserts those clusters still hold, because the design rests on
an assumption about somebody else's code.

**The world's colour still means something.** Each role carries a `tint`: how
far the engine's colour for the event pulls the design's own colours toward
it. A chip hit follows the bullet almost completely, a death mostly keeps its
own fire. Without it the whole sector explodes in one hue and the engine's
only piece of art direction is thrown away.

**Both looks, from one document.** A sector-wide PIXEL GRID switches every
explosion between smooth vector shapes and palette-snapped era art — the same
frame handed to the same emitter twice, never a second design. The test above
found a real defect in the module while this was being built: a `shard` was
drawn inside a rotation, so the one layer kind meant to look like flung debris
was the one landing on fractional pixels. Fixed upstream in
`@ccllc/arcade` 2.0.8, which is the floor this package now requires.

Explosions live in `starline-explosions-v1` in `localStorage`, beside the
editor preferences rather than inside the level, because the level format is
the library's and a field it does not declare would be dropped by
`normalizeLevel` on the next save. That is also why the next item exists.

## C-18 — Resizable tool panels

Was F-01. The palette and the Inspector each gained a drag handle on their
inner edge. The workspace grid's two side columns are now the custom
properties `--palette-w` and `--inspector-w`, which the handles drive from an
inline style on `.workspace` — inline, so a chosen width wins over both the
default and the narrow-window override without either being deleted.

**Three limits, and they are not the same limit.** Each panel has its own
minimum and maximum (palette 170–460, Inspector 200–520), and above both sits
the stage's own floor of 460px, matching the `minmax(460px, 1fr)` the grid
gives it. The handles clamp against whichever binds first, measuring the
workspace at the moment of the drag rather than trusting a stored number,
because the window can be resized between drags. Without that third limit the
grid still enforces its floor — by overflowing, which clips the canvas — so
the difference is between a limit somebody feels and a bug they report.

Widths live in `starline-editor-settings-v1` beside Toolbar Behavior, as two
`integer` fields with their bounds declared. That is the schema paying off as
its comment predicted: two lines, no parsing, and a hand-edited value cannot
reopen the editor with no stage. They are restored on the same two-phase load
as Toolbar Behavior, for the same reason — the static export was built with
the defaults, so the first client render has to match them.

The handle reports itself as `role="separator"` with `aria-valuenow`/`min`/
`max`, which is the WAI-ARIA window-splitter pattern: arrows nudge by 12px,
Shift by 48, Home and End go to the bounds, and double-click restores the
default. Both jsx-a11y rules that fire on it treat `separator` as
non-interactive, which is true of a plain one and false of a focusable one;
the suppression is scoped to the component and says so.

Below 760px the columns become rows, `grid-template-columns` goes inert, and
the handles hide — a width means nothing in a stacked layout. They hide during
playtest too, where `.is-playing` collapses both panels to zero.

**`EbSplitter` was evaluated and rejected**, against F-06's expectation that
this be built on it. It is a *two-pane* component that owns both panes and
splits them by a **ratio**; this is a three-column grid whose stage floor,
playtest collapse and sub-760px restack are all expressed in that grid, and a
0..1 ratio cannot hold a 460px floor as the window changes. Adopting it meant
nesting two splitters and rewriting all of that responsive behaviour to live
inside them. The rejection is about this layout, not the component — a genuine
two-pane split here should still reach for it.

## C-19 — Presentation mode

Was F-02. **Shift+T** starts a playtest with the editor taken away; Escape
leaves, exactly as it leaves an ordinary playtest. There is also a PRESENT
button beside TEST RUN, and the shortcut bar teaches the key.

**It is a way of entering play, not a mode beside it.** "The game as a player
would see it" means the game running; chrome stripped from a paused editor
would still be an editor. Making it an argument to `enterPlay` rather than an
independent flag means the two can never disagree about what is showing.

**`P` stayed pause**, which F-02 flagged as the decision to make. Shift+T is
the answer because T already starts a playtest and this starts the same
playtest presented, so the pair is learnable from one another. Nothing had to
move, and the pause overlay keeps the key it documents.

Hidden: the topbar, the level bar, both tool panels and their resize handles,
the stage toolbar, the minimap and the shortcut bar. `display: none` rather
than the `visibility: hidden` an ordinary playtest uses on the panels — that
keeps their space so the stage does not jump when you tab in and out, whereas
here reclaiming the space is the entire point. What remains is the playfield
and the HUD the game itself draws.

One piece of chrome deliberately stays: a low-contrast ESC hint in the corner,
because a mode that hides every control including its own exit is a trap. It
brightens on hover and is `pointer-events: none`, so it never intercepts a
click meant for the game.

Two bugs came out of the same change and both were caught before shipping.
`enterPlay` gained a `presented` parameter while two call sites still passed
it straight to `onClick` — and a MouseEvent is truthy, so TEST RUN and RETRY
would both have silently presented. TypeScript found the second one after the
first was fixed by hand, which is the argument for the parameter being typed
rather than an options bag nobody checks.

## C-20 — Bullet patterns as a field on the weapon

Was F-00, and the answer to a complaint that names the real problem better
than the entry did: equipping a pattern was a *gesture*, and the Inspector
never said which pattern an object was carrying.

**A pattern is a property of the weapon, so it lives in the weapon's section.**
A BULLET PATTERN dropdown now appears wherever a weapon does — on enemies and
groups, on each of the player's weapon slots, and on the satellite — listing
every saved Pattern Component with NONE for standard fire. It shows the
current value, which the palette-card gesture never could.

**It can name where a pattern came from** because applying one
`structuredClone`s it and normalization preserves `id`, so the field matches
an equipped pattern back to its Component. Edit it afterwards and it reports
**CUSTOM — EDITED HERE** rather than continuing to claim it is the original.
Opening the designer from an object seeds a fresh copy of a preset, so
applying that reads as custom too — correctly, since a copy with its own id is
not the shared Component.

NONE covers removal, so the separate "remove pattern" button went with it.
The palette gesture still works for people who know it; it is no longer the
only way to find out what is equipped.

Two selects in the same pane were both labelled **PATTERN** and neither was a
bullet pattern — one is the group's formation, the other the movement rule.
They are FORMATION and MOVEMENT now, which is most of why the old arrangement
read as unintuitive.

On the player and satellite the pattern belongs to the **Weapon Component**,
not the mount, so every slot carrying that weapon changes together. That is
the data model rather than a shortcut: a weapon is one saved thing, and two
mounts firing the same gun differently would be two guns.

## C-21 — Per-enemy explosions and sounds

Was F-07, and it needed the engine change the entry predicted rather than the
local workaround it warned against.

**What was missing was one sentence in `@ccllc/arcade`.** A `Burst` is
`{x, y, color, count}` — where to draw and how big, which is all a generic
spray needs and nothing an authored one does. The renderer was never told
*what* exploded, so correlating a burst against `world.state.enemies` was the
only local option, and it would have guessed wrong the frame two things died
together.

The engine now has:

- `Level.components` holding `kind: "explosion"` and `kind: "sound"`,
  carrying a `BurstDefinition` and an `SfxDefinition`. shmup does not know
  what either document is; it hands each to the module that owns the format,
  exactly as it already hands sprite assets to `sprite`.
- `LevelItem.fx` — `explosionId`, `deathSoundId`, `fireSoundId`, as **ids**
  rather than inline copies, because sharing is the point of "per type": six
  raiders share one explosion and editing it reaches all six. An id whose
  Component was deleted is kept, so re-adding restores the link.
- `World.drainEvents()`, matching the channel the other genre packs have,
  carrying `sourceId` — the *authored* item, so a group's members all report
  the item they came from.

Events are a **separate queue from bursts**, which is the load-bearing part: a
shield soaking a shot wants a spark and no sound, a weapon firing wants a
sound and no spark, and draining one must not consume the other.

**On this side**, the Inspector grew an EXPLOSION & SOUND section for anything
destructible, the palette grew **+ EXPLOSION** and **+ SOUND**, and the
renderer resolves an event's `sourceId` to whatever the level attached. An
authored explosion **replaces** the generic one the same death also queued —
the world queues both, and drawing both would double every explosion an author
went to the trouble of designing.

The explosion designer gained a single-document mode rather than a fork: one
saved explosion is edited as a one-entry set under the `blast` slot, so every
control below still addresses `set[role]` and knows nothing about the mode.

## C-22 — The sound designer

`SfxStudio` from `@ccllc/studio` over `@ccllc/arcade/sfx`, reached from
**+ SOUND** in the palette, saving a `kind: "sound"` Component. Sounds are
assigned in the same EXPLOSION & SOUND section as explosions — a death sound
on anything destructible, a fire sound on anything with a weapon.

One `createSfxPlayer` for the session, which renders each definition once and
caches the samples: pointing forty enemies at one death sound costs one render
rather than forty.

**Firing signals a volley, not a bullet.** A spread cannon is one trigger pull
and should be one sound, and a pattern emitting forty projectiles a second
would otherwise ask for forty. The engine's test asserts the count stays in
volley territory rather than merely being non-zero, because "more than none"
would pass for the bug too.

Per-*item* sounds fall out of the same `fx` field as explosions, so the two
features are one mechanism wearing two labels — which is why they shipped
together rather than one waiting on the other.

## C-23 — The editor faces the way the sector does

A direct request rather than a backlog item: a vertical level played upright
and was *edited* sideways, so every placement was a mental rotation the author
had to perform for themselves.

**A level is authored and simulated in (along, across) whatever the mode** —
`x` is distance into the sector, `y` is position across it — and C-15 settled
that vertical is a way of *looking* at that, not a second coordinate system.
The fix follows from taking that seriously: the editor draws through the same
quarter turn the game already drew through, and the pointer comes back through
its inverse. `applyVerticalView` / `unapplyVerticalView` are the only two
places that know the rotation, so the editor and the game cannot drift apart
on which way a sector faces.

**The backdrop stays outside the transform**, exactly as it does in play. It
is the window, not the sector seen through it, and rotating it would tilt the
starfield with the level.

**Labels counter-rotate about their own anchor.** Rotating the stage rotates
its text, and a sideways ruler is unreadable, so a `label()` helper stands in
for `fillText` at the six places the editor writes on the canvas. It saves and
restores around the turn, which keeps whatever `textAlign` the caller had set
— the empty-level prompt centres itself and still does.

**The pointer is un-rotated before it is clamped**, not after. Clamping in
screen space would pin a click to the wrong edge of the sector; clamping after
the inverse pins it to the 640-wide band the author can actually see.

Verified by clicking one point in both modes: 62% across and 75% down the
stage lands at `(795, 487)` in horizontal — straight through — and at
`(154, 474)` in vertical, which is that same point taken through the inverse.

## C-24 — A bake is made at the size it is drawn

Ryan noticed an imported sprite looking coarse in the editor and sharp the
moment it was selected, which is the symptom that names the cause: **the
selected copy is the one that skips the cache.**

`spriteRegion` rasterised at the sprite's authored `size` and `drawSprite`
then blitted that bitmap under the transform in force — the display's pixel
ratio, the editor's zoom and the item's own scale, all multiplying. A sprite
scaled to 4x was a `size`-pixel bake magnified four times. Selection returns
null from the cache, so it went straight to the recipe and stayed sharp; C-14
had made the fast path the blurry one and nobody had a reason to compare the
two until an image asset, which carries real detail to lose, was scaled up.

**The resolution is now read off the context rather than passed in.** A call
site cannot forget what it never supplies, and `getTransform` already knows
about the pixel ratio, the zoom and the quarter turn C-23 added. Bakes are
quantised to 8-pixel steps so dragging a scale slider reuses a dozen bakes
instead of minting one per frame, and past `BAKE_MAX_PIXELS` the bake is
declined entirely — a sprite magnified that far is one of a few on screen, its
region would crowd the atlas, and drawing from the recipe is sharper anyway.

**A second bug fell out of the first.** `drawSpriteAsset` draws *nothing* for
an image whose data URL has not decoded yet, and decoding is asynchronous with
no way around it. On the direct path that costs one blank frame. Baked, that
nothing was stored under a key that never changes again, so an asset unlucky
enough to be baked on its first frame stayed **invisible for the rest of the
session**. `spriteRegion` now declines to bake an image that is not `complete`
— `imageAssetElement` is exported by `@ccllc/studio/render` for exactly this,
and its own doc comment says so.

Verified by pointing an item at a 256-square checkerboard: at 4x it is drawn
from the recipe and the checkers stay separate, and at 1x it goes through the
cache and is both present and sharp. Before the fix the same sprite at 4x did
not appear at all, which is the second bug caught in the act.

## C-25 — Scrolling the sector is a native listener

Ryan sent a production console with twenty-two copies of "Unable to
preventDefault inside passive event listener invocation".

**React registers `wheel` at the root passively**, along with `touchstart` and
`touchmove`, so `preventDefault` from inside an `onWheel` prop is refused. The
editor had been calling it on every notch: the console filled up, and because
the cancel never took, the *page* scrolled as well as the sector. The error was
the visible half of a real misbehaviour rather than noise on its own.

A listener that intends to cancel a scroll has to say `passive: false` when it
is attached, and only `addEventListener` can say it — so this is an effect on
the canvas rather than a prop. The handler sits in a ref because
`setCameraSafe` is a plain function of the render; the alternative is
re-attaching a listener every render, and this way it is attached once and
always calls the current one.

Verified by dispatching a cancelable wheel on the canvas: `defaultPrevented`
comes back true, the sector moves 00000 to 00240, and `window.scrollY` stays
at zero.

**The `slider-vertical` deprecation in the same console is not ours.** It comes
from `-webkit-appearance:slider-vertical` in the vendored
`@electricblazor/react` stylesheet, on the audio player's equaliser slider —
a parse-time notice that fires because the sheet is loaded, whether or not the
component is used. Fixing it means rebuilding the vendored tarball, and it has
no effect on anything Starline draws.

## C-26 — The raster editor is called Pixel Art

Was F-08. `RasterEditor` says **PIXEL ART EDITOR**, an unnamed sprite saves as
"Untitled Pixel Art", and Starline's palette button is **+ PIXEL ART**. The
asset `kind` stays `"raster"`: renaming that would break every sprite anyone
has saved, and the label is the only part a person reads.

## C-27 — Components for what goes in the level, Assets for what it is made of

Was F-09. COMPONENTS holds the six object kinds a user has saved plus the
weapons, armor and satellites that bolt onto one; ASSETS is new and holds
sprites, explosions, sounds and bullet patterns together with the buttons that
open their editors. ENHANCEMENTS is gone — moving all four of its categories
left nothing in it.

**The open question answered itself.** F-09 flagged that "only what the user
saved" and "receive the built-in weapons" pull against each other. They stop
pulling once the shelf is one list: saved entries first, built-ins after,
inside each category. The card already distinguished them — a saved one offers
a delete, a built-in offers a copy — so the tab never had to, and splitting by
authorship put the answer to "what weapons do I have" in two places depending
on who made them.

The split lives in two arrays, `componentCategories` and `assetCategories`,
which are the only thing that decides which heading goes where.

## C-28 — The player ship is an object like any other

Was F-10. Click the ship, get it in the Inspector, with the same dashed ring
every other selection draws. The PLAYER SHIP card is gone.

Two things made it smaller than F-10 feared. The hit test is against the
**screen** point rather than a world one, because the ship holds a fixed place
while the sector scrolls past it and therefore has no world position to test.
And it reuses `playerRadius` — the engine's own collision radius, from C-22 —
so the ship you can click is exactly the ship that gets shot, with no second
idea of how big it is.

`inspectPlayer` stayed. It is still not a `LevelItem` and still has no id, so
the Inspector is switched over directly rather than through the selection;
what changed is what sets it. `setSelection` already cleared it, so picking an
object still puts the ship down.

## C-29 — The stage frames the sector, not the canvas

Was F-11, and the entry was half wrong.

**The real fault:** a vertical level occupies a `VIEW_H`-wide band down the
middle of a `VIEW_W`-wide canvas — C-23's quarter turn puts it there — and the
fit scaled the whole canvas anyway, spending half the screen on the empty
margins. In presentation, where the screen is all there is, that is a game in
a strip with black either side, which is what "presentation mode doesn't work"
looked like. The fit now measures the sector: horizontal frames the full width
and the arithmetic is unchanged, vertical frames 640 and comes out at twice
the scale. The editor gains the same room, since both draw through one
viewport. Changing mode reframes without resizing the canvas element, so the
`ResizeObserver` never hears about it — hence the mode effect calling the
loop's own resize.

**What was wrong:** F-11 recorded that Escape does not leave presentation mode
and that the only way out is a reload. It does leave. The browser automation
sends `keydown` with an empty `code`, the keymap matches on `code`, and so no
shortcut fired under it in any mode — including the control test that was
supposed to prove keys worked. Diagnosed from a tool's behaviour and written
up as the product's.

## C-30 — Escape returns to the select tool after placing

Was F-12, and it needed no code. The binding was already there and already
correct: Escape in build mode switches to select, and clears the selection if
select is already active. It failed only under the automation described in
C-29. Verified with a well-formed event — arm a palette card, press Escape,
the card disarms.

Kept as an entry rather than deleted, because "we checked, it works, here is
the proof" is worth more to the next reader than a gap in the numbering.

## C-31 — Image editor: grouped buttons, an Apply that says so, a resizable frame

Was F-13, all three in `@ccllc/studio`.

The footer reads as groups: undo with redo, the two rotations, the two
mirrors, and Clear on its own because it throws the picture away. Eleven
evenly spaced buttons made the reader find the pairs every time. The grouping
is scoped to the image editor, since the other editors have no groups and
widening their gap would only spread them out.

SCALE reads **APPLY** while either size field holds a number the picture has
not taken yet — the same trick the crop tool already played, and the reason
that button was worth copying rather than inventing something new.

The studio frame takes `resize: both`, with the viewport as its ceiling and a
floor low enough to stay usable. F-13 asked what the extra room should do; the
grid already answers it — the canvas row is the `minmax(0, 1fr)` one, so the
artboard takes the space and the toolbars keep their height.

## C-32 — Sprites that sit in the backdrop rather than on it

Was F-07, and the last of the eleven. **SIT BACK IN SCENE** in the Inspector,
with DARKEN and SOFTEN under it.

**The point is that it is not alpha.** Fading was the only way to say "distant"
before, and it lets the starfield through — stars appear *inside* the hull
rather than behind it, which is the opposite of distance. Darkening keeps the
sprite fully opaque and walks it toward the near-black the backdrop already is;
softening blurs the outline the way air does. Measured on the real filter
string, `brightness(0.150) blur(9px)` takes mean brightness from 103 to 29 and
distinct levels across an edge from 5 to 57, while fully-opaque pixels stay at
14400 — dimmer and softer, and not one pixel see-through.

Both are one `context.filter` string alongside the existing hue rotation, so
the three compose instead of fighting.

**The bake had to learn about it**, per C-24: `depth` is in the cache key, or
the first bake would be reused at every later setting. The region also grows by
three times the blur radius, because a Gaussian reaches about that far and the
blur is in device pixels rather than in the transform's units — the same space
`bakeHalf`'s existing slack lives in.

`LevelItem.depth` is `{ darken, blur }` in `@ccllc/arcade` 2.0.16, absent by
default so every level saved before it draws as it did. The player ship does
not get it: `PlayerSettings` has no `depth`, and a ship the player is meant to
watch is not something to push into the background.

## C-33 — A sprite may turn to face the way it flies

Ryan's example was exact: a rocket riding a sine wave should nose into the
wave, not stay level and bob. **FACE DIRECTION OF TRAVEL** in the Inspector,
from LEVEL to 100%, is how far it follows its heading.

**The engine records the heading and never reads it back.** Each runtime enemy
carries `vx`/`vy`, measured as a finite difference across the step rather than
as each pattern's derivative — so sine, zigzag and the arena's homing, which
has no closed form, all answer the same way, and a new pattern needs no second
formula. Zero on the spawn frame, because the phase is folded into the first
position and the jump from the origin is not a velocity. It is plain
arithmetic on state, so a replay reproduces it exactly and no trigonometry
enters the simulation; `atan2` stays in the renderer, where presentation is
allowed it.

**The lean is measured from the sprite's own forward axis**, not from
screen-right. `atan2(vy, |vx|)` is the angle off straight-ahead, and the sign
of `vx` puts it back on the side the picture actually tilts toward — which is
what makes a left-flying enemy leaning down read as leaning down rather than
up. With no along-speed at all, the sprite is taken to face left, the way every
enemy flies.

**The editor shows it without a playtest.** A placed item has no velocity, so
the preview uses each pattern's derivative at age zero — a sine starts crossing
at its fastest, `amplitude x 2 pi x frequency`; a zigzag at its constant slope,
`4 x amplitude x frequency` — through the same `travelTilt` helper play uses,
so the two cannot disagree about which way is down.

Zero is stored as absent, so a level that never touched the slider saves
exactly as it did. In `@ccllc/arcade` 2.0.17.

## C-34 — Paths turn, and an arc

Ryan wanted two things: every movement path pointable in any direction, and a
curved one — a bezier if it could be had, a resizable arc if not — so that
missiles could come in from the top of the screen and dive at the player.

**Every pattern now flies in its own frame.** Distance along the path, wobble
across it, and `movement.angle` turns that frame: 0 is the leftward flight
every level already had, positive is toward the top. A sine wave climbs at
forty-five degrees by setting one slider.

**The arc is a true circle.** `pattern: "arc"` turns the heading as it flies,
at `movement.curve` degrees a second. Constant speed at a constant turn is a
circle of radius speed over turn, and `movementPosition` is that circle from
the origin in closed form — so a rewind is still a subtraction, which is the
property the scroll modes have always kept. Angle −90° with a curve is the
missile from the top, and because C-33 reads velocity by finite difference, it
noses along the curve without another line of code.

**One function places and previews.** `movementPosition` in
`@ccllc/arcade/shmup/movement.js` is what the world uses to put an enemy where
it is, and what the editor now draws the dashed path with. The preview used to
be its own copy of the formulas — already drifted to `Math.sin` where the world
uses core's deterministic `sin`, the very nit F-05 recorded — and a turned or
curved path would have needed that copy kept in step by hand. Now it cannot
drift. The lean preview came along: one step of the same function, differenced
the way the world differences it, in place of a per-pattern derivative.

**Untouched levels are placed bit for bit as before.** Angle zero with no curve
takes an arithmetic-only branch, and the test asserts `deepEqual` against the
old formula at several ages — not closeness. The two new fields are clamped
only when present; writing `angle: 0` into every saved level would change how
each serialises for no change in how it flies, so absent stays absent.

The bezier is F-07, with its design worked out. The arc covers the stated use;
the bezier's real cost is on-canvas handles, not the curve.

## C-35 — Bezier paths, with handles

Was F-07, and Ryan's word for it was *amazing*. A cubic from the object through
two control points to an end point, shaped by dragging three cyan handles on
the playfield, or typed as numbers in the Inspector for exactness.

**Flown by distance, not by the curve's parameter.** A bezier's `t` is not arc
length, and flying it by `t` speeds up and slows down along the way. The engine
measures the curve once into a cumulative-length table — sixty-four pieces,
cached in a `WeakMap` per movement object, which is stable for a runtime enemy
and replaced on every edit so the cache can never go stale — and walks
`speed × age` along it. The test drives that home: every twentieth of a second
covers five units, within the polyline's own coarseness, the whole way round.

**Past either end it flies straight along the tangent.** That is what a rocket
would do, and it keeps `movementPosition` a closed form in `age`: everything
past the end is a line from a known point, so a rewind is still a subtraction.
Backward past the start, the same, which is what lets the editor draw a little
of where the thing came from.

**The points are offsets in the path's own frame**, before `PATH ANGLE` turns
them — so a curve shaped at angle 0 turns as one piece when the angle changes,
and a handle dragged at any angle stores the point brought back into that
frame. A bezier always has three good points: a missing or nonsense one takes
its slot's default, and a shape authored under another pattern is kept so
switching away and back does not lose the curve.

**The handles were the real work, as F-07 said.** They sit inside the selection
box, where the rotate and scale grips would otherwise claim the click, so they
are hit-tested first. One function gives their world positions for both drawing
and hit-testing — a handle is grabbed exactly where it is drawn — and it turns
them by the angle the same way the engine turns the path. A `bezier` drag kind
joins `items`, `transform`, `scroll` and `end`, and rides the same snapshot
rule: one undo step per drag, and none if nothing moved. Drawn in world space
inside the vertical view, so they turn with the sector.

The preview draws a bezier whole plus a little of the straight flight after
it, via `movementPathLength`, rather than the fixed stretch the other paths
show — and because it is the engine's own function, the dashed curve is the
flight, and C-33's lean noses along it for free.

## C-36 — A stage you can zoom, room off-stage, and a save toast that tells the truth

Three of Ryan's in one message, and the first was a bug he was hitting.

**"This browser blocked local saves" was the wrong sentence.** `library.save`
returns null for any failed write, and Starline's toast attributed every one to
a blocked browser. But every saved level sits in one `localStorage` key, image
sprites travel inside their levels as data URLs, and an origin gets about five
megabytes — so the far likelier cause was a full store, which the same toast
called blocked. The toast now probes: a browser that refuses storage throws for
a single byte as well, while a full store takes the byte and fails only on the
shelf. Full reads **LOCAL STORAGE IS FULL (n MB IN USE) — DELETE A SAVED LEVEL,
OR SHRINK ITS IMAGE SPRITES**, and the LOAD LEVEL list shows each saved level's
size past 0.2 MB, so the shelf can be emptied on purpose rather than by guess.
The ceiling itself is F-07.

**Zoom.** The `1:1 VIEW` readout is now a control — minus, percentage, plus,
FIT — and Ctrl + wheel zooms about the stage centre; Shift + wheel pans across
the sector once zoomed in; a plain wheel still scrolls along it. Play is
untouched: the fit reads the zoom only while editing, so a zoom left over from
authoring never changes what a player sees. `canvasPoint` needed nothing —
zoom and pan live in the same viewport scale and offsets it already inverts.

**Room off-stage.** Half a screen above and below the play band, tinted and
ruled, where an enemy that should enter from the top or bottom is placed. The
editor had clamped every placement to the band; the world never cared where an
enemy starts. Zooming out is how the room comes into view, which is why the two
requests belong together. In a vertical sector the room lies to either side —
that is where its across axis is — and the pan follows that axis too.

**One engine change beside it**, in arcade 2.0.20: an enemy still above or
below the band holds its fire, for the reason one off the right edge always
has — a shot from a ship the player cannot see is an unavoidable hit whichever
edge it is behind. Tested with two armed scouts, one on the band and one
above it, over two seconds: the first fires, the second does not.

## C-37 — Saved levels in IndexedDB

Was F-07. The shelf that "this browser blocked local saves" turned out to be
overflowing now lives in IndexedDB, where an origin has hundreds of megabytes
rather than five.

**Built in GameBase, consumed here — which is where the seam already was.**
`resolveStorage(preferred)` had always accepted a store; nothing had ever
handed it one that was not Web Storage. `createIndexedDbStorage` in
`@ccllc/arcade/core` is that store: a Map is the truth, every read and write is
synchronous against it, every write is also queued to the backend in order, and
`ready` is the promise that the Map has been loaded. The library exposes
`ready` and `flush` so a host can wait and can commit. Pinball and the others
have the same shelf and the same ceiling, so the facade is theirs to adopt too.

**The startup gate F-07 feared was one line.** The entry expected the session
to read its draft at construction, forcing the session out of module scope
behind a loading shell. It does not: the host asks for the draft in a mount
effect, through `hasDraft()` and `restoreDraft()`. So the whole gate is that
effect waiting on `levelLibrary.ready` first — a promise localStorage resolves
at once and IndexedDB resolves a few milliseconds after mount. The exported
page already rendered the starter level and re-rendered from storage after
mount; it still does.

**The first run carries the old shelf across and then frees it.** `migrateFrom`
names the localStorage keys; any the backend does not already hold are copied,
committed, and only then removed — because a full localStorage is the reason
anyone arrives here, and leaving the shelf in it would keep it full. A key the
backend already holds is never overwritten by an older copy. A downgrade after
that would find an empty localStorage shelf; that is the trade, and it is
written down.

**Failure is spoken, not swallowed.** A write that does not commit or a load
that fails flips `persistent` and reports; the editor turns those into toasts,
because a save that will not survive a reload must not look like one that
will. The backend is injectable, which is how five tests run it under Node
without a browser: synchronous reads and writes, ordered commits, an early
write surviving the load, migration with the originals let go, a store with
no backend saying so, and a library seeing its shelf only once ready.

## C-38 — The played picture through GameBase's presenter

Ryan asked for the new scanlines from GameBase, with the pattern and its
parameters chosen in SETTINGS.

**The presenter is a last pass, and that is how it is wired.** Starline draws
at display resolution, so the frame it has always drawn is handed to
`createPixelPresenter` each play tick and put on a second canvas layered over
the stage with pointer events off. Nothing about drawing, framing, clipping or
pointer mapping had to learn about it. The presenter is created when play first
asks for a filter, remade when the stage changes size — its width and height
are fixed at creation — reconfigured when a setting moves, hidden when the
editor comes back, and destroyed with the loop.

**Play and presentation only.** The editor stays as drawn: an author placing a
sprite wants to see the sprite, not the tube. The old CSS `.scanlines` overlay,
which tinted both, is gone.

**One filter is deliberately left off the menu.** `source-scanlines` follows
rows of the original framebuffer, and here the framebuffer *is* the display,
so it is `display-scanlines` under another name; two entries that look the
same is a bug in the menu. What is offered is NONE, SCANLINES, LCD GRID and CRT
TUBE, with LINE BRIGHTNESS and BAND ROWS, GRID THICKNESS, and TUBE / GLOW /
NOISE shown for the filter that reads them. Defaults are the presenter's own,
so a filter switched on for the first time looks the way its author tuned it.
Kept in this browser beside Toolbar Behavior and the panel widths, because
how a person likes the picture is theirs and not the level's.

## C-39 — Weapons sit where you put them

Ryan asked to move the placement of weapons on a ship.

**A mount is an offset in the ship's own frame**: `x` forward, the way it
faces and fires; `y` across, positive toward the bottom of the screen for an
unrotated ship. On an enemy it is `weapon.mount`, so it travels with a saved
weapon Component. On the player it is `slot.mount`, because the slot is the
hardpoint and the weapon merely the thing in it. The sprite's rotation turns an
enemy's mount with the ship; the arena's homing turns it toward the player.

**Absent is exactly where everything fired from before.** An enemy's leading
edge; the player's nose, with the slots fanned nine units apart across. Those
are kept as the same expressions rather than re-derived, and the tests hold
the mounted case against the unmounted one in the same world — so the only
difference measured is the mount, and an old level is placed bit for bit. A
sine projectile from a mounted gun wobbles about the mount, not the hull.

**The sight is the muzzle.** While a ship is selected the playfield shows a
small sight at each gun — one on an enemy, one per slot on the player —
computed by the same rule the engine fires by, so the marker is where the shot
will come from. MOUNT FORWARD and MOUNT ACROSS in the Inspector read NOSE and
CENTRE until touched, and start from there. In `@ccllc/arcade` 2.0.22.

## C-40 — Rotation under Movement

Ryan asked for a Rotation in the movement parameters that turns an object as
it moves — a tumbling asteroid, a spinning mine.

**It is `movement.spin`, degrees per second, and it lives in the engine.** It
could have been render-only, but a spinning turret's gun has to go round with
it: C-39's mounts turn with the sprite's rotation, so the spin has to reach the
muzzle too. The world keeps `turned = spin × age` on each runtime enemy — a
closed form in age, like the position, so a rewind stays a subtraction — and
both the renderer and `enemyMuzzle` add it to the authored rotation. Absent is
0, the still sprite every level before this had; the test holds a spinning and
a still enemy in the same world and reads 90° of turn against exactly none.

**Two ROTATIONs, on purpose.** TRANSFORM's is where the sprite starts; this
one, under MOVEMENT with its unit in °/s, is how fast it keeps turning. Zero is
stored as absent. The editor spins the sprite on the wall clock so the slider
can be seen working without a playtest — the point being that it turns and how
fast, not where it will be at a given instant. In `@ccllc/arcade` 2.0.23.

## C-41 — The ship under the nebula takes the click

Ryan could not select a ship because a nebula lay over it.

The hit-test walked every item from the last placed to the first, whatever its
kind, and a decoration's hit radius is as wide as the decoration — a nebula at
170 units swallows anything inside it. Selection is now two passes: everything
the player interacts with first, then decorations. Within a pass the
later-placed item still wins, as it always did, so nothing else about picking
changed. Draw order is untouched: a decoration on the foreground layer still
draws in front by design; it just no longer steals the click.

## C-42 — Shots come out of the front, wherever it points

Ryan: a ship that follows its path should shoot straight out of its front,
wherever that is pointing.

**The engine now knows the facing the renderer draws.** The sprite's picture is
turned by three numbers — the authored rotation, the spin so far, and the lean
toward its heading — and `facingOffset` adds them the same way the renderer
does, with core's deterministic `atan2` in place of `Math`'s for the lean.
Basic fire flies along that front; a bullet pattern is handed it as its
rotation; and the muzzle mount turns with it, so the sight and the shot agree.
Enemy art rests facing left, so the front is 180° plus the offset.

**Zero is checked before any trigonometry runs.** A level that authored none of
the three fires the literal `(-1, 0)` it always did, bit for bit; the test
holds a leaning climber against a level-flying twin and reads the climber's
shots going up the screen while the twin's `vx` is exactly `-300`.

**One consequence, stated:** a sprite rotated under TRANSFORM now fires where
it points too. It used to fire left regardless, which was the rule's absence
rather than a rule; "straight out of the front" is the rule now, and a level
that leaned on the old behaviour for a rotated turret will see its shots turn
with it. In `@ccllc/arcade` 2.0.24.

## C-43 — Indestructible

A checkbox under DURABILITY. A shot still hits and sparks and is spent — the
wall is solid — but no shield is touched, no hull, no score, and the object is
never destroyed. HIT POINTS hides while it is on, since there is nothing for
them to mean. Only ever `true` or absent, so a level that never set it saves as
it did; the test fires at a wall and a rock side by side and reads the wall's
hit points unchanged while the rock's fall.

## C-44 — Inspector and palette polish

Four small ones from the same message.

- **Component cards show the object's real sprite.** An icon looked up by name
  had nothing to show for an imported image, which is exactly when a picture
  matters most. The card now draws the object — built-in or asset, with its
  tint, glow and rotation — through the same `drawSprite` the stage uses.
- **POSITION X and Y fit their columns.** ElectricBlazor's numeric input pins
  itself to a 220px minimum, wider than half an Inspector, so the Y box ran off
  the edge and under its neighbour. Inside a field the column decides the
  width now: `min-width: 0` and `width: 100%` on the component, and
  `min-width: 0` on the grid cell so it may shrink to its track.
- **Movement's ROTATION steps by 5°/s**, not 15.
- **No glow by default.** The renderer used to give every sprite a halo of its
  own choosing; now a sprite has none unless CUSTOM GLOW adds one, and the
  Inspector's note says so. Selection keeps its ring.

Also in C-42, found by its test: a ship now knows its velocity on the frame it
spawns in the scroll modes, read from the closed-form path's own first step,
so one that fires the instant it appears fires where its nose points rather
than dead level for one frame.

## C-45 — The sprite is the pointer while you place it

Ryan: in sprite placing mode, make the pointer the actual sprite image at 60%
opacity; Escape ends the mode and returns to the select pointer.

**The ghost is drawn by the frame loop, not set as a cursor image.** A CSS
cursor is a static bitmap capped at 128px with no tint, rotation or group
formation, and it cannot spin. Instead the stage remembers where the pointer
last was in stage units — the same `canvasPoint` the click uses, so vertical
mode and zoom come for free — and, while a palette or component tool is
active, draws that tool's item there at 60% through the same `drawSprite` as
everything placed, formation offsets and spin included. The native arrow is
hidden over the stage meanwhile (`.stage-canvas-wrap.placing`), so the ghost
is the pointer rather than a thing beside it. A palette item is built once per
tool; a saved component's object is looked up each frame, so editing the
component changes what you are about to place.

**Escape already did the second half.** The build-mode binding switches any
non-select tool to SELECT and flashes so; verified from a focused palette
button, which the keymap does not treat as text entry. Nothing to add but the
ghost leaving with it, which it does because the frame loop reads the tool.

**SHOT SPEED and SHOT POWER** under TIMED POWERUP were the same 220px numeric
input as POSITION X and Y; C-44's override already covers them, and all four
boxes measure inside their columns. Ryan's screenshot predates that deploy.

## C-46 — A flight box with four edges

Ryan: limits for all four edges — Left 10%, Right 20%, Top 10%, Bottom 10%,
each the distance in from its own edge.

**FORWARD LIMIT named one edge and measured it from the other.** It was the
far edge as a share of the width counted from the left, which is why 58%
meant "stop 42% short of the right". `player.limits` replaces it in
`@ccllc/arcade` 2.0.26: `left`, `right`, `top` and `bottom`, each a
percentage of the screen's width or height measured in from that edge, which
is how Ryan phrased it and how the sliders read. The engine clamps the ship's
centre to the box; LEFT, TOP and BOTTOM run to 45 and RIGHT to 80, because a
FORWARD LIMIT of 20 could already put the far wall that close.

**Old levels migrate, a unit or so off.** A saved `forwardLimit` becomes
`right` as 100 minus it, so the far wall stays where it was. The other three
edges used to be fixed margins of 52 and 45 units; they are now 4% and 7%,
which is 51.2 and 44.8. Stated rather than hidden, and the vertical-mode test
that pinned 595 now reads 595.2.

**Vertical levels label by the screen, not the sector.** The engine keeps
the box in the sector's frame and a vertical level is turned a quarter turn,
so the Inspector maps each slider to the screen edge it guards: TOP is the
sector's far edge there, LEFT its top. The arena has no nose and keeps its
rule: it ignores the far edge and mirrors the near one.

## C-47 — Debug mode: what the simulation actually collides against

Ryan asked for a debug button that outlines every sprite's hit box in a
visible, translucent, not-too-distracting colour. The rings are violet,
because every other ink on the stage is spoken for: navy backdrop, salmon
enemies, lime selection, cyan player and HUD. Orange was the first try and it
vanished into the enemy art it was drawn over, which is the sprite whose hit
box anyone actually wants to see.

**There is no hit box, and there is no single hit radius.** Collision is by
circle, and the circle's size depends on what is striking: an enemy is a wider
target to a bullet (0.78 of its size) than to the ship's nose (0.7), and wider
to the nose than to the satellite (0.65). A pickup is collected within its full
size and shrugs off shots. A decoration collides with nothing at all. So DEBUG
draws the *band* those radii span — widest ring stroked, narrowest stroked
fainter, a wash between — and where a thing has one radius, the band collapses
to one ring. A decoration draws nothing, which is itself the answer to "why
does my shot pass through the nebula".

**The numbers come from the engine.** They were four literals in four
collision loops; `itemHitRadius(item, against)` in `@ccllc/arcade` 2.0.28 is
now the only place they live, the world calls it at all four sites, and the
overlay calls the same function. An overlay holding its own copy of a
collision radius is one that eventually lies, and a debug tool that lies is
worse than none. The satellite's own radius came along as
`SATELLITE_HIT_RADIUS`.

**A group had to be taught.** The first cut answered 0 for an authored group,
because the world never holds one — `expandLevel` turns a group into one enemy
per offset before the simulation sees it — so the overlay would have drawn
nothing around the most common formation there is. A group now answers as one
of its members, pinned by a test that expands one and compares.

**On in the editor and in a playtest.** The editor rings every placed sprite —
each member of a group separately, because the world expands a group into one
body per offset — plus the ship in its dock. A playtest rings every live body,
both bullet streams, the ship and the satellite, drawn after everything else so
no sprite covers a ring. Both inherit the vertical quarter-turn and the sector
clip for free by drawing inside them.

**And a toggle that shows it is on.** FULLSCREEN and FPS had carried
`aria-pressed` since they were written with no styling behind it, so nothing
on screen said a toggle was engaged. Pressed now reads like an active tool:
cyan border and label over a tinted ground, the tint being what separates it
from a hover.

## C-48 — Hitboxes: the shape a sprite is struck within

Ryan: arbitrary hitbox shapes, or many small circles covering the actual art
rather than the space around it; automatic if possible, and a maker to draw
polygons or circles on a sprite either way; done in GameBase.

**The engine owns the shape and the test.** An item may carry `hitbox`:
circles and polygons in the sprite's own frame — as drawn at rotation 0, x
right, y down, 1 unit the item's size — so SIZE and SCALE keep it on the art
and the world turns it by the very facing the renderer draws, spin and lean
included. Every collision the world makes is a disc against the item, so the
disc is carried into the sprite's frame and tested there: concave polygons by
even-odd plus edge distance, squared distances and core's trig throughout, a
`reach` for the broad phase. An item without a hitbox is struck exactly as
before, strict inequality and all. In `@ccllc/arcade` 2.0.29.

**Automatic, from the picture, without the engine seeing a picture.**
`hitboxFromMask` takes width, height and alpha values — a Node test can type
one out, a canvas can read one off — and traces each solid patch by Moore
neighbours, fills holes, drops specks, and simplifies to within a tolerance
that is never finer than a pixel and a half, because a concave corner traced
through pixel centres carries a one-pixel diagonal that is the raster's, not
the picture's. Or it covers the art with discs: an exact distance transform,
the deepest uncovered pixel each time, each disc as large as fits inside the
art, stopping at coverage or when the next disc would be a speck. Tight by
construction: the corners of a boxy sprite go a little uncovered rather than
the space around it going covered. Both deterministic in the mask.

**Studio draws it** (`@ccllc/studio` 2.0.30). `HitboxEditor` is polygon and circle tools over the
sprite, select, move, reshape by handle, delete, AUTO OUTLINE and AUTO CIRCLES
with an alpha threshold and a circle budget, and the circle being replaced
drawn dashed so the improvement is visible. What it hands back goes through
the engine's normalizer. `rasterizeHitMask` and `drawHitbox` are exported for
a host's own canvas, which is how Starline's Inspector reads a hitbox off the
art in one click and how DEBUG draws the real shape, turned with the sprite,
in the editor and in a playtest.

**Starline wires it.** HITBOX under the Inspector, for enemies, terrain,
groups and pickups: AUTO OUTLINE, AUTO CIRCLES, DRAW/EDIT…, USE CIRCLE. The
sprite is painted into the mask by the same `drawSprite` the stage uses, at
rotation 0 with no halo and with an enemy's mirroring, so the mask, the
dialog and the world agree on the frame. A group's members share its hitbox,
one body per offset, as the world expands them.

**Left open, on purpose:** the player ship stays a circle (F-07); clicking an
item on the stage still tests the old circle (F-08).

## C-49 — Type into any slider, and turn by tenths

Ryan: more resolution on Movement > Rotation, floating point; and let numbers
be typed into the number boxes as well as dragged.

**The readouts were never boxes.** All fifty-one of them were a read-only
`<em>` beside a slider, so a value could only be dragged, could only land on a
step, and a number you already knew had to be hunted for. Each is now one
`RangeField` whose readout is a real text box. Idle it shows exactly the string
it always showed -- `330u/s`, `OFF`, `NONE`, `LEVEL`, `NOSE` -- and the number
is parsed out of whatever you leave in it, so units and words come along
harmlessly. Nothing parseable leaves the value alone rather than guessing at
zero, and a value out of range clamps rather than being refused.

**Typing is not snapped to the step.** The step is a comfortable stride for
dragging, not the set of legal values: someone typing 355 into a speed that
steps by 10 means 355. The slider's thumb still sits on the nearest step,
because that is what a range input does with an off-step value, and the box
shows the true number the moment you click into it.

**It commits on Enter or on leaving the box, never per keystroke**, because
each commit is an undo step -- typing `350` should not be three of them.
Escape abandons the edit. The first mouse-up after focusing is swallowed so
the select-all survives the caret the same click would otherwise place, and
later clicks put the caret where you aim it.

**`scale` is for the seven readouts that show a percentage of a 0-to-1
number** -- DARKEN, DAMAGE TAKEN, FACE DIRECTION OF TRAVEL, OPACITY, LINE
BRIGHTNESS, TUBE, GLOW, NOISE. You type what you see and the box divides it
back; type 85 into DAMAGE TAKEN and 0.85 is stored.

**Movement > ROTATION steps by 0.1°/s**, not 5, and shows the tenth it is set
to. The engine has always stored it as a plain clamped number, so this is the
editor catching up with what the level format already allowed. C-44 had taken
it from 15 to 5; this is the same complaint answered properly.

**One thing left as it was:** a dozen readouts round for legibility --
`Math.round(rotation)°`, `toFixed(2)`. Type 7.25 into one and it stores 7.25
and shows 7. Clicking the box always reveals the exact number, which is the
part that has to be true.

## C-50 — A box to select with, and an eye per category

Two of Ryan's, which turned out to be one idea from two directions: getting at
the thing you mean on a crowded stage.

**Dragging on empty space draws a box.** Everything it encloses is selected,
live as it is dragged rather than on release, because selection is not level
state and records no history — the box can afford to say what it has while you
are still drawing it. Any part of a sprite inside counts, and a formation
counts if any one of its members does. Holding Ctrl or Shift adds to what was
already picked instead of replacing it. Empty space still clears the selection
when you click without dragging, as it always did.

**Unlike a click, a box takes everything.** C-41 taught the hit test to prefer
what the player interacts with over the scenery behind it, because a click
picks one thing and a nebula's radius was swallowing the ship under it. A box
means "what is in here", so it takes the nebula and the ship both — and the
answer to a category that is in the way is the eye beside it, not a rule the
box applies on your behalf.

**An eye beside each palette category** — ENEMIES, TERRAIN, GROUPS, POWERUPS,
UPGRADES, DECORATIONS — hides that category while editing. Hidden means
unselectable as well as invisible, by click and by box alike: being able to
drag a nebula you cannot see is how you move one you thought was not there.
It is an editing aid and nothing more. It never reaches the level, a playtest
shows everything, and it is not persisted, because it describes what you are
doing this minute rather than what the level is.

The eye rides in the accordion's `headerContent`, which is also the collapse
control, so the click is stopped from propagating; the section stays open when
you shut a category off. Lit when the category is hidden rather than when it
is shown, so a shut-off section reads from across the panel.

## C-51 — Background music

Ryan asked whether GameBase could do background music. It could:
`createMusic` in `@ccllc/arcade/platform` has been there, unused by this game
— named tracks, crossfade, loop-seam trimming, an intro that hands off to its
loop, and a `define` that lets an editor add a track at runtime.

**The file lives beside the level, not inside it**, which was Ryan's call from
three options. A track is megabytes where a whole level is kilobytes, so the
level names a piece by id (`level.music`, in `@ccllc/arcade` 2.0.31) and the
audio sits on its own shelf in this browser. The stated cost: a level you
export or share arrives silent for anyone without the file. Ryan: "We can
basically forget about the share link when we're dealing with levels with
images and music."

**Its own IndexedDB database, not another store beside the levels.** The
storage facade opens with a fixed version number, so a second object store
added to a database that already exists would never see `onupgradeneeded` and
every transaction against it would throw. Separate databases also keep the
level shelf light, because each store loads all of itself into memory when it
is ready — and audio is the one thing here big enough for that to matter.

**MUSIC in the ASSETS tab:** import an MP3, OGG, WAV, M4A or FLAC, listen to
it, point the level at it, or silence the level. A playtest starts the piece
on the gesture that started the playtest — which is what lets the audio
context run at all — and leaving one fades it out.

**Deleting a track asks first**, where deleting a component does not: a
component can be rebuilt in a few clicks and an imported file cannot be got
back without the file.

**Not delivered here, and recorded as F-09 and F-10:** the Game concept that
would own this shelf rather than the browser owning it, and the playable
export. The music shelf is already shaped for the first — it is keyed by id
and independent of any level — so it moves under a Game without rework.

## C-52 — Games, and the Levels that belong to them

Ryan: "I think we need the concept of a Game and then Levels that belong to a
game. Assets will belong to a game, and can be used on any level."

**The shelf holds Games now.** GAME names the open one in the top bar; NEW,
LOAD, SAVE, DUPLICATE, DELETE, IMPORT and EXPORT all deal in games. LEVELS
sits above the palette tabs — Ryan left the placement to me and it goes there
because which level you are editing is a different axis from what you are
placing into it, and it has to be reachable from every tab. It lists the
game's levels with their item counts, names the one being edited, and adds,
copies and deletes.

**The editor still edits a Level and nothing below that line knows
otherwise.** `gameLevel` splices the game's ship, sprites and components into a
level on the way in; the effect that carries edits back lifts those three out
again and `gameWithLevel` stores what remains. So the render path, the
Inspector, the world and every level file are untouched — a change to the ship
or a sprite on one level is a change on all of them, which is the whole point,
and a change to items or length stays where it was made.

**Old work opens without ceremony.** `normalizeShmupGame` takes a bare Level as
readily as a Game, so samples, shared links, exported level files and the draft
from before all open as one-level games. Every saved level is copied onto the
game shelf once, keeping its name, behind a marker so it happens exactly once —
a copy, not a move, so the old shelf is still there if the migration was wrong.

**Undo is the level's, and is reset when you switch.** Undoing across a level
switch would be undoing into a level you are no longer looking at.

**Left as it is, deliberately:** the music shelf stays the browser's rather
than the game's. Tracks are keyed by id and any level of any game can name one,
which is a superset of what was asked for; moving the list into the game
document would only narrow it. Recorded here so the next person knows it was a
decision.
