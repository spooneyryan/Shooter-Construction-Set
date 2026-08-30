# Future Features

This file is the planning backlog for ideas that are not yet approved for implementation. Active ideas use sequential `F-` identifiers, beginning at `F-00`. Adding an idea here records and develops the concept; it does not authorize implementation.

When a future item is completed, move it to the **Completed Features** archive at the end of this file and renumber the archive sequentially as `C-00`, `C-01`, and so on. Reuse the vacated `F-` number for the remaining active backlog so that both sections stay compact.

## F-00 — Equip a saved Pattern Component on the player

A saved **Pattern Component** can be applied to an enemy or a group — select one, click the card — but there is no path to the player's guns. Clicking a Pattern card with nothing selected opens the designer on the definition itself, and a player weapon slot offers only ADD/EDIT BULLET PATTERN, which authors the pattern belonging to that slot's weapon rather than choosing one already saved. The satellite has the same gap: it picks a Weapon Component, and that weapon's pattern is reachable only through the designer.

Add a way to assign an existing Pattern Component to a player weapon slot and to the satellite — a pattern picker beside the weapon select is the obvious form, and the Enhancements/Components card could equip the current slot the way a Weapon Component does. Decide whether assigning stores a copy on the weapon, which is the shape the data already has since `Weapon` carries its `pattern` inline, or a reference that later edits to the Component would track; what happens to a slot's pattern when its weapon changes; and how the Inspector shows which Component a slot's pattern came from and clears it back to standard fire.

## F-01 — Adjustable sidebar widths

Both tool panels are fixed columns: `.workspace` is a three-column grid of 214px, the stage, and 264px, with a narrower pair below 1050px. Give the palette and the Inspector a drag handle on their inner edge so either can be widened — worth more now that the palette carries three tabs whose labels only just fit, and the Inspector holds the weapon, armor and satellite sections.

Store the widths as a user preference beside Toolbar Behavior in `starline-editor-settings-v1` rather than in the level. Define minimums and a maximum that keeps the stage above its `minmax(460px, 1fr)` floor, make the handles keyboard-operable, and decide how a stored width interacts with the responsive breakpoints and with the stacked layout below 760px, where the columns become rows and a width means nothing.

## F-02 — Bullet colour for ordinary weapon fire

The bullet-pattern designer already picks colours, per array, but ordinary fire cannot be recoloured. A player Weapon Component carries a `color` — the built-ins are lime, cyan and amber — and nothing in the Inspector edits it; an enemy's `Weapon` has no colour field at all, so its shots take their colour from the projectile type the renderer is given. Expose a colour control for both.

The two halves are not the same size of change: surfacing the existing `ComponentWeapon.color` is work in this repository, while giving an enemy `Weapon` a colour adds a field to the level contract in `@ccllc/arcade`. Decide the default for levels saved before it, whether the projectile sprite choice keeps any say once a colour is set, and whether the muzzle flash, impact burst and shield-absorb effects follow the bullet colour or stay as they are.

## F-03 — Presentation mode

A hotkey that strips everything that is not the game — topbar, level bar, both tool panels, the stage toolbar, minimap and shortcut bar — leaving the playfield alone on screen for showing a level off. This is not fullscreen, which `F` already does while keeping all the chrome; the two should compose, so presentation mode inside fullscreen gives a bare game on a bare screen.

**`P` is not free.** It is pause/resume during play, and the pause overlay tells the user so. Pick one: bind presentation mode to `P` only in build mode, give it another key, or move pause. Also decide whether it is a mode the editor enters and leaves, what returns from it (Escape is already crowded), whether it forces playtest or can present a paused editor view, and how it interacts with the responsive layouts.

## F-04 — Import raster image files as sprite assets

Let the user bring a PNG, GIF or JPEG in as a sprite asset instead of drawing every sprite by hand in the raster editor. The importer has to resolve the image onto the editor's pixel grid: choose or infer a canvas resolution, resample to it, decide how transparency and near-transparent edges are treated, and optionally quantise the palette so the result stays editable as pixel art rather than becoming an unpaintable photo.

The raster editor lives in `@ccllc/studio`, so the import UI belongs there, while the size limits belong to whatever this repository is willing to carry: assets travel inside the level through `localStorage`, export files and share links, and a photograph pasted at full resolution would blow all three. Define the ceiling, what happens when an import exceeds it, and how imported assets are attributed in the asset list.

## F-05 — Import SVG files as vector sprite assets

Bring SVG artwork in as a **vector** sprite asset: parse the file into the vector editor's own shape model so it arrives editable — nodes, fills, strokes, ordering and transforms — rather than being flattened to a preview or rasterised onto a pixel grid. Half of that is already solved, since the vector editor stores editable source data rather than a flattened image; the import is the mapping from arbitrary SVG onto that model.

Imported SVG is untrusted input and must be validated before it is trusted, in the same spirit as `normalizeLevel`: no scripts, no external references, no remote fetches. Define what becomes of the constructs the vector document has no shape for — gradients, filters, clip paths, masks, text, and transforms it cannot express — whether they are approximated, dropped with a warning, or refuse the import outright, and how a file that is mostly unsupported reports what was lost. The vector editor lives in `@ccllc/studio`, so the parser and its UI belong there.

## F-06 — Editable backdrops

The backdrop is hardcoded in the renderer: one purple nebula gradient and 155 procedurally scattered stars, generated at mount. A level carries no background of its own — `Level` holds version, name, length, player, items, assets and components — so every sector looks the same behind the action. Let the level author its backdrop: a base colour or gradient, star density and colour or none at all, and one or more parallax layers that can use a sprite asset.

This adds a field to the level contract in `@ccllc/arcade` and rendering here. Define the layer model and how it relates to the existing background decorations, which already scroll at their own parallax and largely cover this ground for discrete objects; the useful distinction is probably that a backdrop tiles or stretches while a decoration is placed. Keep the starfield's presentation-side freedom — it is not simulation state and is allowed its `Math.random` — and give old levels the current look by default.

## F-07 — Foreground terrain

Terrain today is a single colliding layer drawn with everything else: only `enemy` and `terrain` items take player bullets, while decorations, which do have a `foreground` draw layer with opacity and parallax, are scenery that nothing can hit. Neither gives a ceiling or a rock face that passes in front of the ship and still stops a shot.

Add terrain that draws in front of the player while keeping its collision, and decide the pieces that follow: whether "foreground" is a flag on the existing terrain type or a new type, whether foreground terrain is opaque or takes the decoration layer's opacity, how it reads in the editor when it covers the objects being placed, and how the player is meant to survive a screen where the danger is drawn over the ship. Collision belongs to the simulation in `@ccllc/arcade`; the draw order belongs here.

## F-08 — GameBase co-op compatibility

Make a run playable as lockstep co-op on the GameBase system. Most of the foundation is already there and needs nothing: the simulation in `@ccllc/arcade/shmup` runs a fixed 120 Hz step, never reads a clock, never calls `Math.random`, and already does its trigonometry through the deterministic `sin`/`cos`/`atan2` helpers in `@ccllc/arcade/core` — the only `Math` trig left in that package sits inside comments explaining the rule. Starline's own `Math.random` is confined to particles and the starfield, which are render-side and are allowed to differ between players. `@ccllc/arcade/net` ships the rest of the machinery: WebSocket and loopback transports, a seeded xorshift128 generator, and an input log recording `[step, bitstring]` against a named action list.

Starline does not import `@ccllc/arcade/net` at all, so wiring it is the first work — but two things block a straight wiring job, and both are decisions before they are code:

- **The world is single-player.** `WorldInput` carries one `dx`/`dy`/`fire`, and a `World` owns one `state.player`. A second ship is a change to the simulation model in `@ccllc/arcade`: lives, score, weapon slots, satellites, respawn and the victory condition all assume one player today.
- **Not all of Starline's input fits the log.** The recorder captures booleans per named action, and its `axis()` derives an axis from two of them, but `WorldInput.satellitePointer` is a continuous `{x, y}` read straight off the canvas pointer, and `satelliteAxis` comes from analog pad axes. The mouse-aimed satellite control that is half of `C-09` has no representation in a bitstring. Either the log format grows analog channels, or aiming is quantised for co-op and the pointer scheme stays host-local.

The remainder is session work: a lobby or invite path, agreeing the level and its custom sprite assets before the first step so both peers normalize to identical data, a step-scheduling policy for latency, and a desync check — the input log and `replayRun` together already give a way to prove two peers agree. `ACTIONS` in this repository is already the named action list `createInputRecorder` wants, and `createLoopbackPair` makes a two-player test possible without a server.

One nit found while reading for this: the editor's motion-path preview predicts a selected object's sine and zigzag path with `Math.sin`/`Math.asin` while the simulation flies it with the shared helpers, so the drawn path can differ slightly from the real one. It is presentation and cannot desync anything, but it is the one place in this repository where the two trigonometries disagree about the same curve.

## F-09 — Adopt more of the ElectricBlazor suite

Starline uses four of the roughly sixty components `@electricblazor/react` ships: the accordion behind both tool panels, the tabbed card behind the palette switch, the numeric input in the Inspector, and the dialog behind the confirms and the settings. Everything else is hand-written — 41 buttons, 34 range sliders, 17 selects and two checkbox toggles in `StarlineGame.tsx` alone, each with its own rules in `globals.css`. Replace what the suite already does better, and take the capability where the suite has one and Starline has none.

The clearest candidates, roughly in order of what they would pay back:

| Hand-rolled today | Suite equivalent |
| --- | --- |
| Every `<button>` and its CSS | `EbButton` (variants, disabled, focus ring) |
| 34 `.range-field` sliders | `EbNumericInput` with its slider enabled — already imported, currently passed `sliderEnabled={false}` and hidden in CSS |
| The NEW / SAVE / LOAD / IMPORT / EXPORT row | `EbSaveMenu` (`@electricblazor/react/save`) |
| `.palette-card` grids | `EbTile` / `EbTileGrid` (`/tile`) |
| Weapon slots and inventory order | `EbSortableList` with `moveItem` |
| Fixed side-panel widths (`F-01`) | `EbSplitter`, with `normalizeBounds`, `clampRatio` and `ratioFromPointer` |
| Bullet colour fields (`F-02`) | `EbColorPicker` / `EbColorSwatch` / `EbCssColorField` (`/color`) |

`F-01` and `F-02` should be built on those rather than hand-rolled, so the two entries are worth reading together with this one.

Two things bound the sweep. **The suite has no select and no toggle** — there is no `EbSelect` or `EbSwitch` anywhere in the package — so the 17 selects and the two checkbox toggles stay native whatever else moves. And **the colour pickers stay rejected for hue tint**: they pick colours, while tint is a hue *rotation*, and a swatch showing a colour the game never renders is worse than the slider. That rejection is recorded in AGENTS.md and is specific to tint; it does not extend to `F-02`, where a bullet colour really is a colour.

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
