# Future Features

This file is the planning backlog for ideas that are not yet approved for implementation. Active ideas use sequential `F-` identifiers, beginning at `F-00`. Adding an idea here records and develops the concept; it does not authorize implementation.

When a future item is completed, move it to the **Completed Features** archive at the end of this file and renumber the archive sequentially as `C-00`, `C-01`, and so on. Reuse the vacated `F-` number for the remaining active backlog so that both sections stay compact.

There are currently no active `F-` items.

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
