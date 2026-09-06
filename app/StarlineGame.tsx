"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createDocumentSession, createHistory, createIndexedDbStorage, createLoop, createPerformanceMonitor, defineLibrary, defineSettings, DocumentError, type DocumentFormat, type PerfStats } from "@ccllc/arcade/core";
import { useSyncExternalStore } from "react";
import { createInput } from "@ccllc/arcade/platform";
import { createSelection, createEditorCommands, createKeymap } from "@ccllc/arcade/editor";
import { uniqueId } from "@ccllc/arcade/core";
import { createTelemetry } from "@ccllc/arcade/telemetry";
import { createPixelPresenter, createSpriteCache, type PixelFilter, type PixelPresenter } from "@ccllc/arcade/render";
import { BulletPatternStudio, SfxStudio, SpriteStudio, blankImageAsset } from "@ccllc/studio";
import { advanceBurst, burstFrame, createBurstPreset, createBurstRuntime, drawBurst, normalizeBurst, type BurstDefinition, type BurstRuntime } from "@ccllc/arcade/burst";
import { createSfxPlayer, createSfxPreset, normalizeSfx, type SfxDefinition } from "@ccllc/arcade/sfx";
import { EbAccordion, EbAccordionItem, EbDialog, EbNumericInput, EbTabbedCard } from "@electricblazor/react";
import { drawSpriteAsset, imageAssetElement } from "@ccllc/studio/render";
import {
  clamp,
  createPatternPreset,
  createWorld,
  weaponFitsSlot,
  defaultArmor,
  defineLevelFormat,
  groupOffsets,
  idleInput,
  makeItem,
  normalizeBulletPattern,
  PLAYER_R,
  defaultBezierPoints,
  movementPathLength,
  movementPosition,
  normalizeLevel,
  playerRadius,
  palette,
  VIEW_H,
  VIEW_W,
  type ArmorSettings,
  type ArmorType,
  type BulletPatternDefinition,
  type Burst,
  type ComponentDefinition,
  type ItemEffects,
  type ShmupEvent,
  type SpriteDepth,
  type WeaponSlot,
  type SpriteGlow,
  type DecorationLayer,
  type GroupPattern,
  type GunType,
  type Level,
  type LevelItem,
  type LevelMode,
  type MovePattern,
  type PaletteKey,
  type Point,
  type RuntimeEnemy,
  type SatelliteMode,
  type SatelliteSettings,
  type SpriteAsset,
  type Weapon,
  type World,
  type WorldInput,
} from "@ccllc/arcade/shmup";
import { defaultLevel, starterLevels } from "./starter-level";
import BurstDesigner from "./BurstDesigner";
import { defaultExplosions, loadExplosions, roleForCount, saveExplosions, tintedBurst, type ExplosionSet } from "./explosions";

type EditorMode = "build" | "playing" | "paused" | "gameover" | "victory";

// What this game knows how to draw. The library types a sprite as a plain
// string id, which is right for it -- a generator that enumerated Starline's
// artwork would be Starline. These unions are the renderer's business.
type BuiltinSprite = "orb" | "blade" | "diamond" | "turret" | "asteroid" | "raider" | "wraith" | "carrier" | "energy" | "upgrade" | "planet" | "nebula" | "wreck" | "comet";
type Sprite = BuiltinSprite | `asset:${string}`;
type PlayerSprite = "dart" | "raven" | "nova" | "striker";
type PlayerSpriteChoice = PlayerSprite | `asset:${string}`;
type ProjectileSprite = "bolt" | "plasma";

// The two draw entry points below take a plain `string` rather than these
// unions, because that is what a level actually carries: the union is what
// this renderer has artwork for, and an id it does not recognise falls
// through to the default rather than being a type error at the call site.

/**
 * A DocumentError already says what was wrong and in what way -- a file from
 * another application, one from a newer build, truncated JSON -- so it is worth
 * showing instead of the single generic line the hand-rolled import showed for
 * all of them alike. Anything else is a bug or a blocked clipboard, and gets
 * the caller's fallback.
 */
function documentMessage(error: unknown, fallback: string) {
  return error instanceof DocumentError ? error.message.toUpperCase() : fallback;
}

/**
 * Set one effect slot, dropping `fx` entirely once nothing is left in it.
 *
 * The engine normalizes an all-empty `fx` away, so leaving `{}` behind would
 * mean the level as saved differs from the level in hand — the kind of
 * difference that shows up later as a spurious unsaved-changes flag.
 */
function withEffect(fx: ItemEffects | undefined, key: keyof ItemEffects, value: string | undefined): ItemEffects | undefined {
  const next = { ...(fx ?? {}), [key]: value };
  return next.explosionId || next.deathSoundId || next.fireSoundId ? next : undefined;
}

/** Short ids, the shape this game's saved levels already carry. */
const uid = () => uniqueId("item");
type Tool = "select" | "scroll" | "erase" | PaletteKey | `component:${string}`;
type PaletteTab = "objects" | "components" | "assets";
/** Toolbar Behavior: whether a tool panel keeps one section open, or several. */
type SectionMode = "single" | "multiple";
type PatternEditorTarget = { kind: "item"; id: string } | { kind: "weapon"; id: string } | { kind: "pattern"; id: string };

// Render-side only. Stars are not simulation state — nothing in the world reads
// one — so they live here, where Math.random is free to be Math.random.
type Star = Point & { size: number; speed: number; alpha: number };

/** Enough for a screen of simultaneous deaths; past that the oldest are already
 *  fading and dropping them costs nothing anyone can see. */
const MAX_LIVE_BURSTS = 28;

/**
 * What each tool panel may be dragged to, in px, and what it opens at. The
 * maxima are generous because the reason to widen one is a long component name
 * or a full Inspector; the real limit is the constant below rather than these.
 */
const PANEL_LIMITS = {
  palette: { min: 170, max: 460, fallback: 214 },
  inspector: { min: 200, max: 520, fallback: 264 },
} as const;

/**
 * The stage floor, matching the minmax(460px, 1fr) the grid gives it.
 * Duplicating the number is deliberate: the grid enforces it by overflowing,
 * which clips the canvas, and a handle that stops before it is reached is the
 * difference between a limit somebody feels and a bug they report.
 */
const STAGE_MIN_WIDTH = 460;

type PanelSide = keyof typeof PANEL_LIMITS;

/**
 * The drag handle between a tool panel and the stage.
 *
 * It reports itself as a separator rather than a slider, because what it moves
 * is a pane boundary; that also brings the arrow/Home/End keys the WAI-ARIA
 * pattern expects, so the handle works without a pointer. Double-click restores
 * the default, which is the cheapest way back from a width dragged to something
 * unusable.
 */
/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex --
   Both rules treat `separator` as non-interactive, and a plain one is. A
   FOCUSABLE separator is the WAI-ARIA window-splitter pattern itself: the spec
   gives it aria-valuenow/min/max and expects it to move under the arrow keys,
   which is precisely what this is. The rules cannot tell the two apart, so this
   is a false positive rather than a hole -- and the alternative, a <button>,
   would announce "press" for something that does not press. Scoped to this
   component, which exists only for this element. */
function PanelResizer({ side, width, other, onResize, onCommit }: {
  side: PanelSide;
  width: number;
  /** The opposite panel, because the stage floor is what the two of them share. */
  other: number;
  onResize: (width: number) => void;
  onCommit: (width: number) => void;
}) {
  const limits = PANEL_LIMITS[side];
  const [dragging, setDragging] = useState(false);
  // Measured rather than stored: the window can be resized between drags, so
  // the honest ceiling is whatever is spare right now.
  const ceiling = () => {
    const room = (document.getElementById("workspace")?.clientWidth ?? 0) - STAGE_MIN_WIDTH - other;
    return Math.max(limits.min, Math.min(limits.max, room > 0 ? room : limits.max));
  };
  const settle = (next: number) => { onResize(next); onCommit(next); };
  // Dragging the Inspector handle LEFT widens it, so its delta is mirrored:
  // either panel grows toward the stage.
  const growth = (fromX: number, toX: number) => (side === "palette" ? toX - fromX : fromX - toX);
  return (
    <div
      className={"panel-resizer " + side + "-resizer" + (dragging ? " is-dragging" : "")}
      // `position` is inline rather than left to the stylesheet, and it is the
      // one declaration that has to be. This element is a CHILD of the grid, so
      // if the rule taking it out of flow is ever missing or late it becomes a
      // grid item: it claims a column, pushes the panels along and wraps them
      // onto a second row, which is not a cosmetic glitch but an unusable
      // editor. That is not hypothetical -- a dev server that had stopped
      // re-reading globals.css produced exactly it. Appearance can wait for a
      // stylesheet; being out of flow cannot.
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        ...(side === "palette" ? { left: "var(--palette-w)" } : { right: "var(--inspector-w)" }),
      }}
      role="separator"
      aria-orientation="vertical"
      aria-label={side === "palette" ? "Palette width" : "Inspector width"}
      aria-valuenow={width}
      aria-valuemin={limits.min}
      aria-valuemax={limits.max}
      tabIndex={0}
      onDoubleClick={() => settle(limits.fallback)}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 48 : 12;
        if (event.key === "ArrowLeft") settle(clamp(width + (side === "palette" ? -step : step), limits.min, ceiling()));
        else if (event.key === "ArrowRight") settle(clamp(width + (side === "palette" ? step : -step), limits.min, ceiling()));
        else if (event.key === "Home") settle(limits.min);
        else if (event.key === "End") settle(ceiling());
        else return;
        event.preventDefault();
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const handle = event.currentTarget;
        const startX = event.clientX;
        const startWidth = width;
        const top = ceiling();
        handle.setPointerCapture(event.pointerId);
        setDragging(true);
        const move = (moving: PointerEvent) => onResize(clamp(startWidth + growth(startX, moving.clientX), limits.min, top));
        const done = (ending: PointerEvent) => {
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", done);
          handle.removeEventListener("pointercancel", done);
          setDragging(false);
          onCommit(clamp(startWidth + growth(startX, ending.clientX), limits.min, top));
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", done);
        handle.addEventListener("pointercancel", done);
      }}
    />
  );
}
/* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */

/**
 * Which saved Pattern Component a weapon is carrying.
 *
 * Applying one `structuredClone`s it and normalization preserves `id`, so an
 * equipped pattern can still name where it came from — and one edited
 * afterwards reports itself as custom rather than silently claiming to still
 * be the original.
 */
function patternChoice(components: ComponentDefinition[], pattern?: BulletPatternDefinition) {
  if (!pattern) return "";
  return components.find((component) => component.pattern?.id === pattern.id)?.id ?? "custom";
}

/**
 * The weapon's bullet pattern, as a named field showing its current value.
 *
 * Equipping one used to be a gesture: select an object, then click a Pattern
 * card over in the palette. Nothing in the Inspector then said which pattern
 * the object was carrying, so the only way to find out was to open the
 * designer and recognise it. A pattern is a property of the weapon, so it
 * belongs in the weapon's own section.
 *
 * A real component rather than a function returning JSX, because the callback
 * it takes reaches the level through helpers that read refs; called during
 * render the linter cannot tell that the callback is deferred, and as a
 * component it does not have to.
 */
function BulletPatternField({ components, pattern, onApply }: {
  components: ComponentDefinition[];
  pattern?: BulletPatternDefinition;
  onApply: (next: BulletPatternDefinition | undefined) => void;
}) {
  const choice = patternChoice(components, pattern);
  return (
    <label className="field wide"><span>BULLET PATTERN</span>
      <select value={choice} onChange={(event) => {
        const next = event.target.value;
        // "custom" is a readout, not a destination: choosing it would mean
        // replacing the edited pattern with itself.
        if (next === "custom") return;
        if (!next) { onApply(undefined); return; }
        const component = components.find((entry) => entry.id === next);
        if (component?.pattern) onApply(structuredClone(component.pattern));
      }}>
        <option value="">NONE — STANDARD FIRE</option>
        {components.map((component) => <option value={component.id} key={component.id}>{component.name.toUpperCase()}</option>)}
        {choice === "custom" && <option value="custom">CUSTOM — EDITED HERE</option>}
      </select>
    </label>
  );
}

/**
 * One of an item's effect slots, as a picker over the Components of a kind.
 *
 * The value stored is a Component ID, never a copy of the document, because
 * "per enemy type" means sharing: point six raiders at one explosion and
 * editing it reaches all six. An id whose Component was deleted still shows —
 * as MISSING rather than silently reverting to NONE — since the level kept it
 * and re-adding the Component restores the link.
 */
function EffectField({ label, kind, components, value, onChange }: {
  label: string;
  kind: "explosion" | "sound";
  components: ComponentDefinition[];
  value: string | undefined;
  onChange: (next: string | undefined) => void;
}) {
  const choices = components.filter((component) => component.kind === kind);
  const missing = value !== undefined && !choices.some((component) => component.id === value);
  return (
    <label className="field wide"><span>{label}</span>
      <select value={value ?? ""} onChange={(event) => onChange(event.target.value || undefined)}>
        <option value="">NONE — DEFAULT</option>
        {choices.map((component) => <option value={component.id} key={component.id}>{component.name.toUpperCase()}</option>)}
        {missing && <option value={value}>MISSING — {value}</option>}
      </select>
    </label>
  );
}

/** The renderer's own defaults, so switching a halo ON starts somewhere honest. */
const DEFAULT_GLOW: SpriteGlow = { color: "#ff6a4d", blur: 11 };

/**
 * The halo a sprite is drawn with.
 *
 * Undefined and `{ blur: 0 }` are different states and this says so:
 * undefined is "whatever this renderer does for this sprite", zero is "no
 * halo, deliberately". Collapsing the two would make the default
 * unrecoverable once somebody had turned it off.
 */
function GlowField({ glow, onChange }: { glow?: SpriteGlow; onChange: (next: SpriteGlow | undefined) => void }) {
  const live = glow ?? DEFAULT_GLOW;
  return (
    <>
      <label className="toggle-row"><span>CUSTOM GLOW</span>
        <input type="checkbox" checked={glow !== undefined} onChange={(event) => onChange(event.target.checked ? { ...DEFAULT_GLOW } : undefined)} /><i />
      </label>
      {glow !== undefined && <>
        <label className="field wide"><span>GLOW COLOUR</span>
          <input type="color" value={live.color} onChange={(event) => onChange({ ...live, color: event.target.value })} /></label>
        <label className="range-field"><span><b>GLOW STRENGTH</b><em>{live.blur === 0 ? "OFF" : live.blur + "px"}</em></span>
          <input type="range" min="0" max="60" step="1" value={live.blur} onChange={(event) => onChange({ ...live, blur: Number(event.target.value) })} /></label>
      </>}
      <p className="inspector-note">{glow === undefined ? "No halo unless you add one." : "Zero strength draws no halo at all."}</p>
    </>
  );
}

const DEFAULT_DEPTH: SpriteDepth = { darken: 0.35, blur: 2 };

/**
 * Pushing a sprite back into the scene, which is not the same as fading it.
 *
 * Alpha is the obvious control and the wrong one: the starfield is drawn
 * behind everything, so a faded sprite shows stars through its own hull. These
 * two keep it opaque -- darkening walks it toward the near-black the backdrop
 * already is, and softening blurs the outline the way distance does.
 */
function DepthField({ depth, onChange }: { depth?: SpriteDepth; onChange: (next: SpriteDepth | undefined) => void }) {
  const live = depth ?? DEFAULT_DEPTH;
  return (
    <>
      <label className="toggle-row"><span>SIT BACK IN SCENE</span>
        <input type="checkbox" checked={depth !== undefined} onChange={(event) => onChange(event.target.checked ? { ...DEFAULT_DEPTH } : undefined)} /><i />
      </label>
      {depth !== undefined && <>
        <label className="range-field"><span><b>DARKEN</b><em>{live.darken === 0 ? "OFF" : Math.round(live.darken * 100) + "%"}</em></span>
          <input type="range" min="0" max="1" step="0.05" value={live.darken} onChange={(event) => onChange({ ...live, darken: Number(event.target.value) })} /></label>
        <label className="range-field"><span><b>SOFTEN</b><em>{live.blur === 0 ? "OFF" : live.blur + "px"}</em></span>
          <input type="range" min="0" max="40" step="1" value={live.blur} onChange={(event) => onChange({ ...live, blur: Number(event.target.value) })} /></label>
      </>}
      <p className="inspector-note">{depth === undefined ? "Drawn at full strength, in front of the backdrop." : "Darkened and softened rather than faded, so the starfield stays behind it."}</p>
    </>
  );
}

/**
 * Where a bezier's control points sit in the world: offsets from the object,
 * turned by PATH ANGLE the same way the engine turns the path. One function
 * for drawing the handles and for hit-testing them, so a handle is grabbed
 * exactly where it is drawn. Math.cos is fine here -- this is the editor's
 * picture of the points, not the simulation's flight along them.
 */
function bezierControlWorld(item: LevelItem): Point[] {
  const points = item.movement.points ?? defaultBezierPoints();
  const a = (item.movement.angle ?? 0) * Math.PI / 180;
  return points.map((point) => ({ x: item.x + Math.cos(a) * point.x - Math.sin(a) * point.y, y: item.y + Math.sin(a) * point.x + Math.cos(a) * point.y }));
}

/** The reverse, for a handle being dragged: a world point back to an offset. */
function bezierControlLocal(item: LevelItem, world: Point): Point {
  const a = (item.movement.angle ?? 0) * Math.PI / 180;
  const dx = world.x - item.x;
  const dy = world.y - item.y;
  return { x: Math.round(Math.cos(a) * dx + Math.sin(a) * dy), y: Math.round(-Math.sin(a) * dx + Math.cos(a) * dy) };
}

/**
 * Room above and below the play band, in world units, where an enemy that
 * should enter from the top or the bottom of the screen is placed. Half a
 * screen each way. The world has never cared where an enemy starts -- only the
 * editor clamped placement to the band -- so this is an editor allowance, and
 * the one engine change beside it is that an enemy still off the band does not
 * fire, for the same reason one off the right edge never did.
 */
const PLACE_MARGIN = VIEW_H / 2;
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 3;

/** Every byte localStorage holds for this origin, as the browser counts it: UTF-16, two per character. */
function localStorageBytes() {
  try {
    let total = 0;
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i) ?? "";
      total += (key.length + (localStorage.getItem(key)?.length ?? 0)) * 2;
    }
    return total;
  } catch { return 0; }
}

/**
 * The toast for a save that did not write, worded by cause.
 *
 * The library reports every failed write the same way, but a browser that
 * refuses storage and a store that is simply full are different problems with
 * different fixes -- and with image sprites travelling inside levels, full is
 * the likelier one by far: every saved level sits in one key, and the browser
 * allows about five megabytes for the whole origin. A one-byte probe tells the
 * two apart: refused storage throws for a byte as well; a full store takes the
 * byte and fails only on the shelf.
 */
function describeSaveFailure() {
  try {
    localStorage.setItem("starline-probe", "1");
    localStorage.removeItem("starline-probe");
  } catch (error) {
    const quota = error instanceof DOMException && (error.name === "QuotaExceededError" || error.code === 22);
    if (!quota) return "SAVE FAILED — THIS BROWSER BLOCKED LOCAL SAVES";
  }
  return `SAVE FAILED — LOCAL STORAGE IS FULL (${(localStorageBytes() / 1048576).toFixed(1)} MB IN USE). DELETE A SAVED LEVEL, OR SHRINK ITS IMAGE SPRITES`;
}

/**
 * Where an enemy's gun sits in the world: the engine's own rule, so the marker
 * the editor draws is exactly where the shot will come from. No mount is the
 * sprite's leading edge; a mount is forward-and-across in the ship's frame,
 * turned by its rotation. Math.cos is fine here -- this is the editor's picture.
 */
function enemyMuzzleWorld(item: LevelItem): Point {
  const mount = item.weapon.mount;
  if (!mount) return { x: item.x - item.size * item.scale, y: item.y };
  const turn = item.rotation * Math.PI / 180;
  const ox = -mount.x;
  const oy = mount.y;
  return { x: item.x + ox * Math.cos(turn) - oy * Math.sin(turn), y: item.y + ox * Math.sin(turn) + oy * Math.cos(turn) };
}

/** Where a player slot's gun sits, relative to the ship: the nose, fanned nine units apart, unless mounted. */
function slotMuzzleOffset(slot: WeaponSlot, index: number, count: number): Point {
  return slot.mount ?? { x: 29, y: (index - (count - 1) / 2) * 9 };
}

/** The reading beside PATH ANGLE and CURVE: the compass points by name, the rest signed. */
function describeAngle(degrees: number, unit = "") {
  if (degrees === 0) return unit ? "STRAIGHT" : "LEFT";
  if (!unit && degrees === 90) return "UP";
  if (!unit && degrees === -90) return "DOWN";
  if (!unit && Math.abs(degrees) === 180) return "RIGHT";
  return `${degrees > 0 ? "+" : ""}${degrees}°${unit} ${degrees > 0 ? "UP" : "DOWN"}`;
}

/**
 * Degrees a sprite turns to face the way it is flying, scaled by how far the
 * author wants it to follow (0 level, 1 fully along the velocity).
 *
 * Measured from the sprite's own forward axis rather than from screen-right,
 * so a left-flying enemy leaning down reads as leaning down: atan2 against the
 * SIZE of the along-speed gives the lean off straight-ahead, and the sign of
 * the along-speed puts it back on the side the picture actually tilts toward.
 * With no along-speed at all the sprite is assumed to face left, which is the
 * way every enemy flies. Presentation only -- Math.atan2 is fine here, and
 * nothing in the simulation reads the result.
 */
function travelTilt(vx: number, vy: number, follow: number) {
  if (!follow || (!vx && !vy)) return 0;
  return Math.atan2(vy, Math.abs(vx)) * (Math.sign(vx) || -1) * follow * 180 / Math.PI;
}

/**
 * The quarter turn a vertical sector is seen through.
 *
 * A level is always authored and simulated in (along, across): x is distance
 * into the sector and y is position across it, whatever the mode. Vertical is
 * purely a way of LOOKING at that, and this is the only place that says so —
 * the same transform the game already used, now used by the editor too, so
 * the two cannot disagree about which way a sector faces.
 *
 * Along runs bottom-to-top, which is why later content enters from the top,
 * and the 640-wide band is centred on the wide canvas.
 */
function applyVerticalView(context: CanvasRenderingContext2D) {
  context.translate((VIEW_W - VIEW_H) / 2, VIEW_H);
  context.rotate(-Math.PI / 2);
}

/** The same mapping backwards, for turning a pointer into (along, across). */
function unapplyVerticalView(x: number, y: number) {
  return { x: VIEW_H - y, y: x - (VIEW_W - VIEW_H) / 2 };
}

type TransformOrigin = { id: string; x: number; y: number; rotation: number; scale: number };
type CanvasDrag =
  | { kind: "items"; ids: string[]; startWorld: Point; origins: TransformOrigin[]; startSnapshot: string }
  | { kind: "transform"; mode: "rotate" | "scale"; ids: string[]; center: Point; startAngle: number; startDistance: number; origins: TransformOrigin[]; startSnapshot: string }
  | { kind: "scroll"; startX: number; startCamera: number }
  | { kind: "bezier"; id: string; index: number; startSnapshot: string }
  | { kind: "end"; startSnapshot: string };

// Storage keys, above the two definitions that take them: both are read at
// module evaluation, and a const referenced before its own line is a TDZ
// ReferenceError rather than undefined.
const STORAGE_KEY = "starline-level-library-v1";
const DRAFT_KEY = "starline-level-draft-v1";
const SETTINGS_KEY = "starline-editor-settings-v1";

/** Where the store's complaints go once the editor is mounted; the console until then. */
let storageNotice: (message: string) => void = (message) => console.warn(message);

/**
 * The shelf lives in IndexedDB. localStorage gives an origin about five
 * megabytes for everything, and a level carrying image sprites as data URLs
 * spent that in a few saves -- which is what "this browser blocked local saves"
 * turned out to mean (C-36). The first run over an old shelf carries it across
 * and then frees the localStorage it was filling. Reads and writes stay
 * synchronous against the facade's Map; the one thing the editor owes it is to
 * wait on `ready` before asking for a draft, which the mount effect does.
 *
 * A store that could not open, or a write that did not commit, is said out
 * loud: a save that will not survive a reload must not look like one that will.
 */
const levelStore = createIndexedDbStorage({
  database: "starline",
  migrateFrom: [STORAGE_KEY, DRAFT_KEY],
  report: (name) => {
    if (name === "storage.migrated") storageNotice("SAVED LEVELS MOVED INTO INDEXEDDB");
    if (name === "storage.write-failed") storageNotice("SAVE DID NOT PERSIST — THE BROWSER REFUSED THE WRITE");
    if (name === "storage.load-failed") storageNotice("SAVED LEVELS COULD NOT BE READ — THIS SESSION WILL NOT SURVIVE A RELOAD");
  },
});

// Editor preferences, which belong to the person rather than the level and so
// live beside the library rather than inside it. One field today; the point of
// the schema is that the second one costs a line instead of another
// parse/clamp/write triple written out by hand.
//
// The store derives its own key from the namespace, so it does NOT read the key
// above -- that one is read once, below, to carry a choice already made across.
/**
 * How the played picture is presented. Starline draws at display resolution,
 * so the presenter takes that frame each play tick and puts it on a canvas
 * layered over the stage. `source-scanlines` is deliberately not offered:
 * at 1:1 it is `display-scanlines` under another name, and a menu with two
 * entries that look the same is a bug in the menu.
 */
type DisplayFilter = Extract<PixelFilter, "none" | "display-scanlines" | "lcd-grid" | "crt">;
type DisplayPrefs = { pixelFilter: DisplayFilter; lineBrightness: number; bandRows: number; gridThickness: number; crtAmount: number; crtGlow: number; crtNoise: number };

const editorSettings = defineSettings<{ sectionMode: SectionMode; paletteWidth: number; inspectorWidth: number } & DisplayPrefs>({
  namespace: "starline-editor",
  version: 1,
  fields: {
    sectionMode: { type: "enum", values: ["single", "multiple"], default: "multiple" },
    // The panel widths belong to the person rather than the level, so they sit
    // here beside Toolbar Behavior. Adding them cost two lines and no parsing,
    // which is exactly what this schema was for; the store clamps on the way
    // in, so a hand-edited value cannot reopen the editor with no stage left.
    paletteWidth: { type: "integer", default: PANEL_LIMITS.palette.fallback, min: PANEL_LIMITS.palette.min, max: PANEL_LIMITS.palette.max },
    inspectorWidth: { type: "integer", default: PANEL_LIMITS.inspector.fallback, min: PANEL_LIMITS.inspector.min, max: PANEL_LIMITS.inspector.max },
    // The played picture's treatment, with the presenter's own defaults, so a
    // filter switched on for the first time looks the way its author tuned it.
    pixelFilter: { type: "enum", values: ["none", "display-scanlines", "lcd-grid", "crt"], default: "none" },
    lineBrightness: { type: "number", default: 0.72, min: 0, max: 1 },
    bandRows: { type: "integer", default: 1, min: 1, max: 6 },
    gridThickness: { type: "number", default: 1, min: 0, max: 4 },
    crtAmount: { type: "number", default: 1, min: 0, max: 1 },
    crtGlow: { type: "number", default: 1, min: 0, max: 1 },
    crtNoise: { type: "number", default: 0.25, min: 0, max: 1 },
  },
});

/** The display preferences as one object, read from the store. */
function readDisplayPrefs(): DisplayPrefs {
  return {
    pixelFilter: editorSettings.get("pixelFilter"),
    lineBrightness: editorSettings.get("lineBrightness"),
    bandRows: editorSettings.get("bandRows"),
    gridThickness: editorSettings.get("gridThickness"),
    crtAmount: editorSettings.get("crtAmount"),
    crtGlow: editorSettings.get("crtGlow"),
    crtNoise: editorSettings.get("crtNoise"),
  };
}

/**
 * The one-time carry-over from the hand-rolled key. Toolbar Behavior is a
 * cosmetic preference and losing it would cost a click, but the rule that a
 * library must not orphan what a game already stored does not have a size
 * threshold -- and honouring it here is five lines.
 */
function adoptLegacyEditorSettings() {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    const stored = JSON.parse(raw) as { sectionMode?: unknown };
    if (stored.sectionMode === "single" || stored.sectionMode === "multiple") {
      editorSettings.set("sectionMode", stored.sectionMode);
    }
    window.localStorage.removeItem(SETTINGS_KEY);
  } catch { /* a preference is not worth failing a load over */ }
}

// The level as a document. The library owns the envelope, the version
// negotiation and the transport; `normalizeLevel` -- which defineLevelFormat
// wires in as the sanitizer -- stays the authority on Starline's own fields,
// the only half that is genuinely this game's. It is a stateless definition
// rather than component state, so it lives out here; the report sink is
// deliberately not wired, because the only telemetry instance is built inside
// the component and reading it from render is what react-hooks/refs forbids.
//
// The format tag is effectively permanent: change it and every level saved
// under the old one is refused as foreign. Levels saved before this carry no
// tag at all, and those still parse.
const levelDocument = defineLevelFormat({ format: "starline-level" });

// The saved-level shelf. Keys stay exactly what they were, because a library
// that derived its own from a namespace would orphan every sector anyone has
// saved -- which is why the module takes them rather than inventing them.
//
// `migrate` is what carries the old shape across: this game stored a plain
// object of name to level, and the first write after this rewrites it as the
// module's own list. It runs once and then never again.
//
// What arrives with the swap, none of which this game had: a cap, so a runaway
// save loop cannot fill the origin's quota; entry-level validation, so one
// corrupt sector is dropped instead of taking the whole shelf down with it;
// and a storage probe that degrades to memory rather than throwing, which is
// the difference between a private-mode browser losing saves and crashing.
const levelLibrary = defineLibrary<Level>({
  format: levelDocument,
  key: STORAGE_KEY,
  draftKey: DRAFT_KEY,
  storage: levelStore,
  limit: 60,
  migrate: (raw) => (raw && typeof raw === "object" && !Array.isArray(raw)
    ? Object.entries(raw as Record<string, Level>).map(([name, document]) => ({ name, document }))
    : []),
});

/**
 * The rule every GameBase editor follows for saving (docs/EDITOR-UX.md in
 * the GameBase repository): the name field renames the open level and never
 * forks one; SAVE writes by id and is disabled while nothing is unsaved;
 * DUPLICATE is the only way a second level comes into being; NEW, LOAD and
 * IMPORT ask before discarding unsaved work; DELETE can be undone. Before
 * this, SAVE matched by name, so renaming a sector and saving quietly grew a
 * second one and left the old name on the shelf.
 *
 * The editor holds a plain Level and the format's document type is that plus
 * its envelope; the session only ever parses on the way in, so the cast says
 * the conversion that already happens one layer down.
 */
const levelSession = createDocumentSession<Level>({
  format: levelDocument as unknown as DocumentFormat<Level>,
  library: levelLibrary,
  blank: () => normalizeLevel({ ...defaultLevel(), name: "Untitled Sector", items: [] }),
  nameOf: (candidate) => candidate.name,
  withName: (candidate, name) => ({ ...candidate, name }),
});

// A fixed step, at last. The loop used to run on a variable delta with a 34 ms
// clamp and a comment saying this was what replays and any input-synchronised
// multiplayer would need. Both are now in reach, so it is the default: 120 Hz
// of simulation, decoupled from whatever the display is doing.
const SIM_STEP = 1 / 120;

// One action map for keyboard and pad, replacing a Set of key codes, a
// hand-written gamepad poll with its own deadzone, and a `previous[]` array for
// edge detection.
//
// The satellite pair is bound to axes 2 and 3 with no keys, because it wants
// the analogue value rather than a held/not-held action — `axis(a, b)` returns
// the stick when there is one and the digital keys when there is not, so an
// unbound pair is simply the stick or zero. The three pad-only entries exist to
// get `pressed()` edges for free instead of keeping a previous-buttons array.
const ACTIONS = {
  left: { keys: ["KeyA", "ArrowLeft"], pad: { buttons: [14], axis: { index: 0, dir: -1 as const } } },
  right: { keys: ["KeyD", "ArrowRight"], pad: { buttons: [15], axis: { index: 0, dir: 1 as const } } },
  up: { keys: ["KeyW", "ArrowUp"], pad: { buttons: [12], axis: { index: 1, dir: -1 as const } } },
  down: { keys: ["KeyS", "ArrowDown"], pad: { buttons: [13], axis: { index: 1, dir: 1 as const } } },
  fire: { keys: ["Space"], pad: { buttons: [0, 2, 7] } },
  satLeft: { pad: { axis: { index: 2, dir: -1 as const } } },
  satRight: { pad: { axis: { index: 2, dir: 1 as const } } },
  satUp: { pad: { axis: { index: 3, dir: -1 as const } } },
  satDown: { pad: { axis: { index: 3, dir: 1 as const } } },
  padPause: { pad: { buttons: [9] } },
  padAlt: { pad: { buttons: [3] } },
  padBack: { pad: { buttons: [1, 8] } },
};

function selectionGeometry(items: LevelItem[]) {
  if (!items.length) return null;
  let left = Infinity; let right = -Infinity; let top = Infinity; let bottom = -Infinity;
  items.forEach((item) => groupOffsets(item.group, item.rotation, item.scale).forEach((offset) => {
    const radius = item.size * item.scale + 14; const x = item.x + offset.x; const y = item.y + offset.y;
    left = Math.min(left, x - radius); right = Math.max(right, x + radius); top = Math.min(top, y - radius); bottom = Math.max(bottom, y + radius);
  }));
  const center = { x: (left + right) / 2, y: (top + bottom) / 2 };
  return { left, right, top, bottom, center, radius: Math.max(34, Math.hypot(right - left, bottom - top) / 2) };
}

function createStars(count: number): Star[] {
  return Array.from({ length: count }, (_, index) => ({
    x: Math.random() * VIEW_W,
    y: Math.random() * VIEW_H,
    size: index % 14 === 0 ? 2.1 : Math.random() * 1.35 + 0.35,
    speed: index % 3 === 0 ? 1 : index % 3 === 1 ? 0.55 : 0.24,
    alpha: Math.random() * 0.55 + 0.22,
  }));
}

// Sprites are baked once and blitted after.
//
// Every sprite below is a vector recipe -- paths, gradients, a stroke, and a
// shadowBlur on all of them -- and the whole lot used to be re-rasterised for
// every enemy on screen, every frame. Measured at this game's own peak of 690
// live entities that is 7.7 ms a frame, 47% of a 60fps budget; baked and
// blitted it is 1.3 ms. The recipes are unchanged. They just stop running
// sixty times a second to redraw a picture that did not change.
//
// The split is what makes it work: everything that changes the PIXELS goes in
// the key, and everything that only moves them stays per-instance. Position,
// rotation, scale, the horizontal flip and alpha are all transform or
// compositor state, so they cost nothing at blit time and must not be baked --
// scale especially, which is authored anywhere in 0.25 to 4 and would other-
// wise be a fresh bake per value.
const spriteCache = createSpriteCache({ pageSize: 2048, maxPages: 4 });

// A custom asset is a document the Sprite Studio edits, so a baked copy of one
// has to expire when it is saved. `updateLevel` replaces the asset array
// immutably, so identity changes on every save -- a WeakMap turns that into a
// cache key without hashing the asset on every frame.
const assetIdentities = new WeakMap<SpriteAsset, number>();
let nextAssetIdentity = 0;
function assetIdentity(asset: SpriteAsset) {
  let id = assetIdentities.get(asset);
  if (id === undefined) { nextAssetIdentity += 1; id = nextAssetIdentity; assetIdentities.set(asset, id); }
  return id;
}

// Above this a sprite is a backdrop -- a nebula at 170, a planet at 110 -- and
// there are a handful on screen rather than hundreds. Baking those would spend
// most of the atlas on the sprites with the least to gain from it.
const BAKE_MAX_SIZE = 72;

// The same judgement in device pixels rather than authored units. A sprite
// magnified past this is one of a few on screen, and its region would be large
// enough that the atlas could hold only a handful -- so it is drawn straight
// from the recipe, which is sharper anyway.
const BAKE_MAX_PIXELS = 128;

// Bakes are made at multiples of this, so a scale slider sweeping through a
// hundred values reuses a dozen bakes rather than minting a hundred.
const BAKE_STEP = 8;

/** Half a baked region, in the pixels the region is rasterised at. The widest
 *  any recipe reaches is the comet's tail at 1.7x size; the constant covers the
 *  shadow blur, the stroke and slack, and stays constant because a shadow is
 *  blurred in device pixels rather than in the transform's units. */
const bakeHalf = (size: number) => Math.ceil(size * 1.75 + 22);

/** The recipe: one sprite, at the origin, with no transform of its own. */
function paintSprite(context: CanvasRenderingContext2D, sprite: string, size: number, selected: boolean, assets: SpriteAsset[], tint: number, glow?: SpriteGlow, depth?: SpriteDepth) {
  // One filter string for everything that recolours or softens the sprite.
  //
  // Darken is `brightness`, deliberately NOT alpha: the starfield is drawn
  // behind everything, so a transparent sprite shows stars *inside* its own
  // artwork, which is the whole reason `depth` exists. Brightness below 1
  // walks the sprite toward black, and black is what the backdrop nearly is.
  const filters: string[] = [];
  if (tint) filters.push(`hue-rotate(${tint}deg)`);
  if (depth?.darken) filters.push(`brightness(${(1 - depth.darken).toFixed(3)})`);
  if (depth?.blur) filters.push(`blur(${depth.blur}px)`);
  if (filters.length) context.filter = filters.join(" ");
  const isPickup = sprite === "energy" || sprite === "upgrade";
  // No halo unless one was authored. The renderer used to give every sprite a
  // default glow of its own choosing; Ryan asked for objects to have none at
  // all by default, so the colour below is only ever used by a selection ring
  // or by an authored halo. Selection still gets its blur, because a selected
  // object has to read as selected whatever it was authored with.
  context.shadowColor = glow ? glow.color : sprite === "asteroid" ? "#87939c" : isPickup ? "#eaff62" : "#ff6a4d";
  context.shadowBlur = selected ? 24 : glow ? glow.blur : 0;
  context.lineWidth = selected ? 3 : 2;
  context.strokeStyle = selected ? "#eaff62" : sprite === "asteroid" ? "#8ca0a8" : isPickup ? "#eaff62" : "#ff947f";
  context.fillStyle = sprite === "asteroid" ? "#29343a" : "rgba(71, 24, 51, .92)";

  const customAsset = sprite.startsWith("asset:") ? assets.find((asset) => `asset:${asset.id}` === sprite) : undefined;
  if (customAsset) {
    // The same routine the editor previews with, so authoring and play cannot
    // drift apart -- this file used to carry its own copy of the vector half.
    drawSpriteAsset(context, customAsset, size * 2);
  } else if (sprite === "energy" || sprite === "upgrade") {
    context.rotate(sprite === "upgrade" ? Math.PI / 4 : 0);
    context.fillStyle = sprite === "upgrade" ? "rgba(100,227,255,.18)" : "rgba(234,255,98,.14)";
    context.beginPath(); context.rect(-size * .62, -size * .62, size * 1.24, size * 1.24); context.fill(); context.stroke();
    context.rotate(sprite === "upgrade" ? -Math.PI / 4 : 0);
    context.fillStyle = sprite === "upgrade" ? "#64e3ff" : "#eaff62";
    context.font = `bold ${Math.max(10, size * .75)}px monospace`; context.textAlign = "center"; context.textBaseline = "middle";
    context.fillText(sprite === "upgrade" ? "U" : "+", 0, 1);
  } else if (sprite === "raider" || sprite === "wraith" || sprite === "carrier") {
    context.fillStyle = "rgba(65,22,48,.94)";
    context.beginPath();
    if (sprite === "raider") { context.moveTo(-size, 0); context.lineTo(size * .5, -size * .72); context.lineTo(size, 0); context.lineTo(size * .5, size * .72); }
    if (sprite === "wraith") { context.moveTo(-size, -size * .7); context.lineTo(size, 0); context.lineTo(-size, size * .7); context.lineTo(-size * .45, 0); }
    if (sprite === "carrier") { context.moveTo(-size, -size * .38); context.lineTo(size * .55, -size * .65); context.lineTo(size, 0); context.lineTo(size * .55, size * .65); context.lineTo(-size, size * .38); context.lineTo(-size * .72, 0); }
    context.closePath(); context.fill(); context.stroke();
    context.fillStyle = "#ff6a4d";
    if (sprite === "carrier") { context.fillRect(-size * .55, -size * .13, size * 1.15, size * .26); context.fillStyle = "#211a30"; context.fillRect(-size * .28, -size * .32, size * .4, size * .64); }
    else { context.beginPath(); context.arc(size * .2, 0, size * .2, 0, Math.PI * 2); context.fill(); }
  } else if (sprite === "planet" || sprite === "nebula" || sprite === "wreck" || sprite === "comet") {
    if (sprite === "planet") {
      const planet = context.createRadialGradient(-size * .25, -size * .25, size * .08, 0, 0, size);
      planet.addColorStop(0, "#547f98"); planet.addColorStop(.45, "#293c62"); planet.addColorStop(1, "#101525"); context.fillStyle = planet;
      context.beginPath(); context.arc(0, 0, size, 0, Math.PI * 2); context.fill();
      context.strokeStyle = "rgba(100,227,255,.35)"; context.beginPath(); context.ellipse(0, 0, size * 1.45, size * .28, -.18, 0, Math.PI * 2); context.stroke();
    } else if (sprite === "nebula") {
      const cloud = context.createRadialGradient(0, 0, 0, 0, 0, size); cloud.addColorStop(0, "rgba(148,82,208,.58)"); cloud.addColorStop(.42, "rgba(72,84,177,.3)"); cloud.addColorStop(1, "rgba(40,20,75,0)"); context.fillStyle = cloud; context.beginPath(); context.arc(0, 0, size, 0, Math.PI * 2); context.fill();
    } else if (sprite === "wreck") {
      context.rotate(-.22); context.fillStyle = "#26333b"; context.strokeStyle = "#748994"; context.beginPath(); context.moveTo(-size, -size * .2); context.lineTo(size * .65, -size * .5); context.lineTo(size, 0); context.lineTo(size * .3, size * .24); context.lineTo(-size, size * .4); context.closePath(); context.fill(); context.stroke();
      context.fillStyle = "#ff6a4d"; context.fillRect(-size * .25, -size * .08, size * .42, size * .12);
    } else {
      const tail = context.createLinearGradient(-size * 1.7, 0, size * .3, 0); tail.addColorStop(0, "rgba(100,227,255,0)"); tail.addColorStop(.65, "rgba(100,227,255,.35)"); tail.addColorStop(1, "#eaf7fb"); context.fillStyle = tail; context.beginPath(); context.moveTo(-size * 1.7, -size * .3); context.lineTo(size * .2, -size * .2); context.lineTo(size * .2, size * .2); context.lineTo(-size * 1.7, size * .3); context.closePath(); context.fill(); context.beginPath(); context.arc(size * .2, 0, size * .28, 0, Math.PI * 2); context.fill();
    }
  } else if (sprite === "diamond") {
    context.rotate(Math.PI / 4);
    context.beginPath(); context.rect(-size * 0.55, -size * 0.55, size * 1.1, size * 1.1); context.fill(); context.stroke();
    context.fillStyle = "#ff6a4d"; context.fillRect(-size * 0.18, -size * 0.18, size * 0.36, size * 0.36);
  } else if (sprite === "blade") {
    context.beginPath();
    for (let i = 0; i < 8; i += 1) {
      const angle = i * Math.PI / 4;
      const radius = i % 2 === 0 ? size : size * 0.48;
      const px = Math.cos(angle) * radius;
      const py = Math.sin(angle) * radius;
      if (i === 0) context.moveTo(px, py); else context.lineTo(px, py);
    }
    context.closePath(); context.fill(); context.stroke();
    context.fillStyle = "#ffbd71"; context.beginPath(); context.arc(0, 0, size * 0.22, 0, Math.PI * 2); context.fill();
  } else if (sprite === "turret") {
    context.beginPath(); context.arc(0, 0, size * 0.76, 0, Math.PI * 2); context.fill(); context.stroke();
    context.fillStyle = "#ff6a4d"; context.fillRect(-size * 0.12, -size * 0.16, -size * 0.95, size * 0.32);
    context.fillStyle = "#18212b"; context.beginPath(); context.arc(0, 0, size * 0.34, 0, Math.PI * 2); context.fill();
  } else if (sprite === "asteroid") {
    context.beginPath();
    const points = [1, .78, .92, .7, 1, .82, .9, .68];
    points.forEach((radius, index) => {
      const angle = index / points.length * Math.PI * 2;
      const px = Math.cos(angle) * size * radius;
      const py = Math.sin(angle) * size * radius;
      if (index === 0) context.moveTo(px, py); else context.lineTo(px, py);
    });
    context.closePath(); context.fill(); context.stroke();
    context.strokeStyle = "rgba(195, 214, 220, .32)";
    context.beginPath(); context.arc(-size * .22, -size * .1, size * .2, 0, Math.PI * 2); context.stroke();
  } else {
    const halo = context.createRadialGradient(0, 0, size * .12, 0, 0, size);
    halo.addColorStop(0, "#ffd2a2"); halo.addColorStop(.3, "#ff6a4d"); halo.addColorStop(1, "rgba(110, 24, 69, .2)");
    context.fillStyle = halo; context.beginPath(); context.arc(0, 0, size, 0, Math.PI * 2); context.fill();
    context.beginPath(); context.arc(0, 0, size * .7, 0, Math.PI * 2); context.stroke();
    context.fillStyle = "#351a37"; context.beginPath(); context.arc(size * .09, 0, size * .33, 0, Math.PI * 2); context.fill();
  }
  context.filter = "none";
  if (selected) {
    context.shadowBlur = 0;
    context.strokeStyle = "rgba(234,255,98,.8)";
    context.setLineDash([5, 5]);
    context.beginPath(); context.arc(0, 0, size + 13, 0, Math.PI * 2); context.stroke();
  }
}

/**
 * A baked copy of this sprite, or null when it is not worth baking.
 *
 * Null for the cases where a cache would lose: a sprite too big to be
 * numerous, the selected one, of which there is exactly one on screen and
 * whose dashed ring would otherwise double the key space for nothing, and one
 * magnified so far that its bake would cost more atlas than it saves.
 *
 * **A bake is made at the resolution it will be drawn at.** The transform in
 * force here decides that -- the display's pixel ratio, the editor's zoom and
 * the item's own scale all multiply together -- and it is read off the context
 * rather than passed in, so no call site can forget it and quietly lose
 * resolution. Baking at `size` and letting the transform magnify the result is
 * what made a scaled-up sprite blocky while the selected copy, which skips the
 * cache entirely, stayed sharp.
 */
function spriteRegion(context: CanvasRenderingContext2D, sprite: string, size: number, selected: boolean, assets: SpriteAsset[], tint: number, glow?: SpriteGlow, depth?: SpriteDepth) {
  if (selected || !(size > 0) || size > BAKE_MAX_SIZE) return null;
  const matrix = context.getTransform();
  // The larger of the two axes, so a non-uniform scale over-resolves the minor
  // one rather than under-resolving the major one.
  const detail = Math.max(Math.hypot(matrix.a, matrix.b), Math.hypot(matrix.c, matrix.d));
  // Quantised, because scale is a slider: without this, dragging it would mint
  // a fresh bake every frame. Rounding up never under-resolves.
  const pixels = Math.ceil(size * detail / BAKE_STEP) * BAKE_STEP;
  // Past the ceiling, drawing straight from the recipe is both sharper and
  // cheaper than an atlas region only a handful of sprites could share.
  if (!(pixels > 0) || pixels > BAKE_MAX_PIXELS) return null;
  const baked = pixels / size;
  // The halo is part of what was baked, so it is part of the key -- and so is
  // the resolution, or the first bake would be reused at every later size.
  let key = `${sprite}|${size}|${pixels}|${tint}|${glow ? glow.color + ":" + glow.blur : "-"}|${depth ? depth.darken + ":" + depth.blur : "-"}`;
  if (sprite.startsWith("asset:")) {
    const asset = assets.find((entry) => `asset:${entry.id}` === sprite);
    // An unresolved asset draws nothing and must not be cached under a key
    // that would still miss once the asset arrives.
    if (!asset) return null;
    // Nor may an image that has not finished decoding. `drawSpriteAsset` skips
    // one of those entirely, and baking that nothing would store an empty
    // region under a key that never changes again -- the sprite would stay
    // invisible for the rest of the session. Declining costs one blank frame
    // and fixes itself on the next.
    if (asset.kind === "image") {
      const element = imageAssetElement(asset);
      if (!element.complete || element.naturalWidth === 0) return null;
    }
    key += `|${assetIdentity(asset)}`;
  }
  // A Gaussian reaches about three times its radius, and the blur is in device
  // pixels rather than in the transform's units -- so the padding is added
  // after the scaling, in the same space `bakeHalf`'s own slack lives in.
  const half = bakeHalf(pixels) + Math.ceil((depth?.blur ?? 0) * 3);
  const region = spriteCache.sprite(key, half * 2, half * 2, (own) => {
    own.translate(half, half);
    own.scale(baked, baked);
    paintSprite(own, sprite, size, false, assets, tint, glow, depth);
  });
  return region ? { region, detail: baked } : null;
}

/** `extra` rather than two more positional parameters: this already takes
 *  eleven, and a call site with two bare numbers on the end says nothing. */
function drawSprite(context: CanvasRenderingContext2D, sprite: string, x: number, y: number, size: number, selected = false, alpha = 1, rotation = 0, scale = 1, faceLeft = false, assets: SpriteAsset[] = [], tint = 0, extra: { scaleY?: number; glow?: SpriteGlow; depth?: SpriteDepth } = {}) {
  context.save();
  context.translate(x, y);
  context.rotate(rotation * Math.PI / 180);
  // The vertical axis defaults to the horizontal one, so every existing call
  // site keeps the uniform scale it was written with.
  context.scale(scale * (faceLeft && (sprite === "raider" || sprite === "wraith" || sprite === "carrier") ? -1 : 1), extra.scaleY ?? scale);
  context.globalAlpha = alpha;
  // Asked for AFTER the transform is in force, because the transform is what
  // decides how much resolution the bake needs.
  const baked = spriteRegion(context, sprite, size, selected, assets, tint, extra.glow, extra.depth);
  if (baked) {
    // Divided back out so the blit lands 1:1 on device pixels: the region was
    // rasterised `detail` times larger than the units it is drawn in.
    const width = baked.region.width / baked.detail;
    const height = baked.region.height / baked.detail;
    context.drawImage(baked.region.canvas, baked.region.x, baked.region.y, baked.region.width, baked.region.height, -width / 2, -height / 2, width, height);
  }
  else paintSprite(context, sprite, size, selected, assets, tint, extra.glow, extra.depth);
  context.restore();
}

function drawShip(context: CanvasRenderingContext2D, x: number, y: number, now: number, sprite: string = "dart", blink = false, assets: SpriteAsset[] = [], tint = 0, ship: { scale?: number; glow?: SpriteGlow } = {}) {
  if (blink) return;
  // One number. The sprite's own dimensions are the ship's size, and this
  // scales them -- which is also why it needs no separate "resolution": a
  // sprite drawn at its own size is drawn 1:1, and scaling DOWN stays crisp.
  const scale = ship.scale ?? 1;
  const asset = sprite.startsWith("asset:") ? assets.find((entry) => `asset:${entry.id}` === sprite) : undefined;
  // `drawSpriteAsset` fits the picture inside a box of `extent`, so the extent
  // that draws it 1:1 is its longer edge. This is the same number
  // `playerExtent` collides against, which is what keeps the drawn ship and
  // the hit ship the same ship.
  const extent = (asset ? Math.max(asset.width, asset.height) : PLAYER_R * 2) * scale;
  if (asset) { drawSprite(context, sprite as Sprite, x, y, extent / 2, false, 1, 0, 1, false, assets, tint, { glow: ship.glow }); return; }
  // The built-in hulls are paths rather than a baked sprite, so the two axes
  // are a transform around the whole recipe rather than an argument to it.
  // A built-in hull is a path at a fixed geometry rather than a rasterised
  // sprite, so the scale is simply a transform around the recipe.
  context.save(); context.translate(x, y); context.scale(scale, scale);
  const flame = 13 + Math.sin(now / 45) * 5;
  const flameGradient = context.createLinearGradient(-43, 0, -12, 0);
  flameGradient.addColorStop(0, "rgba(98,226,255,0)"); flameGradient.addColorStop(.4, "#64e3ff"); flameGradient.addColorStop(1, "#eaffaa");
  context.fillStyle = flameGradient; context.beginPath(); context.moveTo(-17, -7); context.lineTo(-17 - flame, 0); context.lineTo(-17, 7); context.closePath(); context.fill();
  context.shadowColor = "#64e3ff"; context.shadowBlur = 17; context.fillStyle = "#eaf7fb"; context.beginPath();
  if (sprite === "raven") { context.moveTo(29, 0); context.lineTo(-20, -24); context.lineTo(-8, -4); context.lineTo(-22, 0); context.lineTo(-8, 4); context.lineTo(-20, 24); }
  else if (sprite === "nova") { context.moveTo(30, 0); context.lineTo(-5, -17); context.lineTo(-22, -12); context.lineTo(-13, 0); context.lineTo(-22, 12); context.lineTo(-5, 17); }
  else if (sprite === "striker") { context.moveTo(34, 0); context.lineTo(-10, -12); context.lineTo(-20, -25); context.lineTo(-14, 0); context.lineTo(-20, 25); context.lineTo(-10, 12); }
  else { context.moveTo(31, 0); context.lineTo(-14, -20); context.lineTo(-6, -5); context.lineTo(-22, 0); context.lineTo(-6, 5); context.lineTo(-14, 20); }
  context.closePath(); context.fill();
  context.shadowBlur = 0; context.fillStyle = "#163249"; context.beginPath(); context.moveTo(14, 0); context.lineTo(-8, -9); context.lineTo(-1, 0); context.lineTo(-8, 9); context.closePath(); context.fill();
  context.fillStyle = "#eaff62"; context.fillRect(3, -2, 11, 4); context.restore();
}

/**
 * A component card's picture: the object's actual sprite -- built-in or asset,
 * with its tint, glow and rotation -- drawn small through the same routine the
 * stage uses, rather than a stand-in icon looked up by name. An icon by name
 * had nothing to show for an imported image, which is when a picture matters
 * most.
 */
function ObjectThumb({ item, assets }: { item: LevelItem; assets: SpriteAsset[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current; const context = canvas?.getContext("2d"); if (!canvas || !context) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1); canvas.width = 34 * dpr; canvas.height = 34 * dpr;
    context.setTransform(dpr, 0, 0, dpr, 0, 0); context.clearRect(0, 0, 34, 34);
    drawSprite(context, item.sprite, 17, 17, 12, false, 1, item.rotation, 1, item.type === "enemy" || item.type === "group", assets, item.tint, { glow: item.glow, depth: item.depth });
  }, [item, assets]);
  return <canvas className="asset-preview" ref={ref} aria-hidden="true" />;
}

function SpriteAssetPreview({ asset }: { asset: SpriteAsset }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => { const canvas = ref.current; const context = canvas?.getContext("2d"); if (!canvas || !context) return; const dpr = Math.max(1, window.devicePixelRatio || 1); canvas.width = 34 * dpr; canvas.height = 34 * dpr; context.setTransform(dpr, 0, 0, dpr, 0, 0); context.clearRect(0, 0, 34, 34); drawSprite(context, `asset:${asset.id}`, 17, 17, 14, false, 1, 0, 1, false, [asset], 0); }, [asset]);
  return <canvas className="asset-preview" ref={ref} aria-hidden="true" />;
}

export function StarlineGame() {
  const mainCanvasRef = useRef<HTMLCanvasElement>(null);
  const miniCanvasRef = useRef<HTMLCanvasElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const modeRef = useRef<EditorMode>("build");
  const toolRef = useRef<Tool>("select");
  // Selection and commands, created together because the commands need the
  // selection and reading one ref to build another during render is exactly
  // what react-hooks/refs forbids. Built in the initialiser instead, which runs
  // once and reads nothing.
  //
  // `replace` is where this game keeps its say: the library decides WHICH items
  // a command touches and what happens to the selection afterwards, and this
  // decides what writing them back means -- normalising the level, recording a
  // snapshot, and giving the snapshot the coalesce key the library worked out.
  const editorCameraRef = useRef(0);
  const viewportRef = useRef({ scale: 1, offsetX: 0, offsetY: 0 });
  // Switching to vertical reframes the stage, and nothing about the canvas
  // ELEMENT changes when it does -- so the ResizeObserver never fires and the
  // fit would stay stale until the window was dragged. The loop publishes its
  // own resize here for the mode effect below to call.
  const resizeViewRef = useRef<() => void>(() => {});
  // The editor's own view of the stage: a zoom about the centre, and a pan
  // across the sector in stage pixels. Play always shows the sector at its
  // fit, so a zoom left over from editing never changes what a player sees.
  const zoomRef = useRef(1);
  const panRef = useRef(0);
  const [viewZoom, setViewZoom] = useState(1);
  // The played picture's treatment. Stored beside the panel widths -- the
  // person's, not the level's -- read after mount like them, and mirrored into
  // a ref because the render loop reads refs.
  const [displayPrefs, setDisplayPrefs] = useState<DisplayPrefs>(() => readDisplayPrefs());
  const displayPrefsRef = useRef<DisplayPrefs>(displayPrefs);
  useEffect(() => { displayPrefsRef.current = displayPrefs; }, [displayPrefs]);
  const presentCanvasRef = useRef<HTMLCanvasElement>(null);
  const satellitePointerRef = useRef({ x: VIEW_W * .7, y: VIEW_H / 2, active: false });
  const mouseFireRef = useRef(false);
  const dragRef = useRef<CanvasDrag | null>(null);
  /**
   * Where the pointer last was over the stage in build mode, in stage units,
   * or null once it has left. The frame loop reads it to draw the sprite a
   * placement tool would put down, riding under the pointer.
   */
  const hoverRef = useRef<{ x: number; y: number } | null>(null);
  /** That sprite, for a palette tool: built once per tool rather than once per frame. */
  const ghostRef = useRef<{ tool: Tool; item: LevelItem | null }>({ tool: "select", item: null });
  const miniDragRef = useRef<{ offset: number } | null>(null);
  const starsRef = useRef<Star[]>([]);
  // Explosions are the renderer's, not the world's. The world asks for one at a
  // point in a colour; which designed burst that means is decided here.
  //
  // These used to be a hand-rolled particle spray built with Math.random on the
  // spot. They are documents now, so the same explosion can be designed, saved
  // and previewed instead of only ever being read off this one line -- and it is
  // seeded rather than random, which is what makes the designer's preview show
  // the thing the game will actually draw.
  const burstsRef = useRef<BurstRuntime[]>([]);
  // One player for the whole session. It renders each definition once and
  // caches the samples, so pointing forty enemies at one death sound costs one
  // render rather than forty.
  const sfxRef = useRef(createSfxPlayer({ masterGain: 0.5 }));
  const explosionsRef = useRef<ExplosionSet>(defaultExplosions());
  // Frame statistics, and somewhere for them to go. Both are created once and
  // held in refs: the loop reads them every frame and must not be torn down and
  // rebuilt by a render. Telemetry is off — there is no collector — but it is
  // wired so loop.overrun and the quality changes have a real path.
  const perfRef = useRef(createPerformanceMonitor());
  const telemetryRef = useRef(createTelemetry({ app: "starline", version: "0.1.0", enabled: false }));
  // Snapshot undo, from the library that took this game's implementation in the
  // first place. Same 80-entry limit and 700 ms coalescing window as the hand-
  // rolled version it replaces.
  const historyRef = useRef(createHistory<Level>({ limit: 80, coalesceMs: 700 }));
  // Keyboard and pad behind one action map, and — new — everything released on
  // blur, which the hand-written poll never did.
  const inputRef = useRef<ReturnType<typeof createInput> | null>(null);
  // Mirrors the pad name already pushed to React state, so the poll can tell a
  // newly-arrived pad from the one it reported last frame without a setState.
  const controllerNameRef = useRef("");
  // Null until a playtest starts. The editor half of this component never looks
  // at it, which is the whole point of the split.
  const worldRef = useRef<World | null>(null);

  // Normalized, unlike every other path into this state, which went through
  // `installLevel`. The starter level is hand-authored and typed as a `Level`,
  // so TypeScript believes it is complete — but any field the contract gains
  // is simply absent from it until somebody loads or imports something else.
  // That is how the opening level ended up with no `scaleX` the moment the
  // player gained one, and it would have happened again for the next field.
  const [level, setLevel] = useState<Level>(() => normalizeLevel(defaultLevel()));
  // Seeded with the state's own first value — useRef reads its argument on the
  // first render only — so ref and state start as one object without calling
  // defaultLevel() twice. The mirror effect below keeps it current.
  const levelRef = useRef(level);

  // Built on first use, not during render. Both instances are made together
  // because the commands need the selection, and the closures below read refs
  // -- which the React Compiler forbids during render, counting a useState
  // initialiser as render just as it counts the component body. The one place
  // left that is neither is the first call out of a callback or an effect.
  const editorRef = useRef<{
    selection: ReturnType<typeof createSelection>;
    commands: ReturnType<typeof createEditorCommands<LevelItem>>;
  } | null>(null);
  const editorFor = useCallback(() => {
    if (editorRef.current) return editorRef.current;
    const selection = createSelection();
    // `replace` is where this game keeps its say. The library decides WHICH
    // items a command touches and what becomes of the selection afterwards;
    // this decides what writing them back means -- normalising the level,
    // recording a snapshot, and giving that snapshot the coalesce key the
    // library worked out from the reason and the selection.
    editorRef.current = {
      selection,
      commands: createEditorCommands<LevelItem>({
        selection,
        items: () => levelRef.current.items,
        replace: (items, { coalesceKey }) => {
          const next = normalizeLevel({ ...levelRef.current, items });
          levelRef.current = next; setLevel(next);
          historyRef.current.commit(next, coalesceKey);
        },
        identify: (item) => item.id,
        clone: (item) => {
          const copy = structuredClone(item);
          copy.id = uid(); copy.name = `${item.name} Copy`;
          return copy;
        },
      }),
    };
    return editorRef.current;
  }, []);
  const [mode, setMode] = useState<EditorMode>("build");
  const [tool, setTool] = useState<Tool>("select");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [inspectPlayer, setInspectPlayer] = useState(false);
  // The draw loop reads refs, not state, and the ship now has a selected look.
  const inspectPlayerRef = useRef(false);
  useEffect(() => { inspectPlayerRef.current = inspectPlayer; }, [inspectPlayer]);
  const [camera, setCamera] = useState(0);
  const [score, setScore] = useState(0);
  const [lives, setLives] = useState(3);
  const [hullMax, setHullMax] = useState(3);
  const [shield, setShield] = useState(0);
  const [progress, setProgress] = useState(0);
  const [savedEntries, setSavedEntries] = useState<{ id: string; name: string; bytes: number }[]>([]);
  const [loadName, setLoadName] = useState("");
  // The third argument is the server snapshot: this page is prerendered, and
  // without it React refuses to render the store on the server at all.
  const levelDoc = useSyncExternalStore(levelSession.subscribe, () => levelSession.state, () => levelSession.state);
  /** The level a load just installed -- the one change that is not an edit. */
  const loadedRef = useRef<Level | null>(null);
  const [notice, setNotice] = useState("READY");
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fpsStats, setFpsStats] = useState<PerfStats | null>(null);
  const [showFps, setShowFps] = useState(false);
  const [controllerName, setControllerName] = useState("");
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
  // Which section each tool panel opened last. Under "single" Toolbar Behavior
  // that is the whole answer to what is expanded; under "multiple" it is only a
  // record, kept current so switching to "single" leaves the section you last
  // opened up rather than shutting the panel entirely.
  const [openSections, setOpenSections] = useState<Record<string, string>>({});
  const [sectionMode, setSectionMode] = useState<SectionMode>("multiple");
  const [showSettings, setShowSettings] = useState(false);
  const [presenting, setPresenting] = useState(false);
  // Annotated, because PANEL_LIMITS is `as const` and the fallback would
  // otherwise infer as the literal 214 rather than as a width.
  const [paletteWidth, setPaletteWidth] = useState<number>(PANEL_LIMITS.palette.fallback);
  const [inspectorWidth, setInspectorWidth] = useState<number>(PANEL_LIMITS.inspector.fallback);
  const [paletteTab, setPaletteTab] = useState<PaletteTab>("objects");
  const [editingAsset, setEditingAsset] = useState<SpriteAsset | null>(null);
  const [editingPattern, setEditingPattern] = useState<{ pattern: BulletPatternDefinition; target: PatternEditorTarget } | null>(null);
  // Editing a saved Component rather than a loose document in both cases: the
  // id is what an item's fx points at, so it has to survive the round trip.
  const [editingSound, setEditingSound] = useState<{ id: string; sound: SfxDefinition } | null>(null);
  const [editingExplosion, setEditingExplosion] = useState<{ id: string; name: string; burst: BurstDefinition } | null>(null);
  const editingOverlayRef = useRef(false);
  useEffect(() => { editingOverlayRef.current = editingSound !== null || editingExplosion !== null; }, [editingSound, editingExplosion]);
  const editingPatternRef = useRef(false);
  useEffect(() => { editingPatternRef.current = editingPattern !== null; }, [editingPattern]);
  // The destructive confirms, replacing window.confirm: what to ask, and what
  // to do on yes. window.confirm blocked the whole tab and dodged the game's
  // keyboard handling by accident; the dialog has to declare itself, hence the
  // ref the keydown handler checks.
  const [pendingConfirm, setPendingConfirm] = useState<{ title: string; message: string; action: () => void; confirmLabel?: string; alternate?: { label: string; action: () => void } } | null>(null);
  const pendingConfirmRef = useRef(false);
  useEffect(() => { pendingConfirmRef.current = pendingConfirm !== null; }, [pendingConfirm]);
  const showSettingsRef = useRef(false);
  useEffect(() => { showSettingsRef.current = showSettings; }, [showSettings]);
  // The designed explosions belong to this browser rather than to the level:
  // the level format is the library's, and a field it does not declare would be
  // dropped by normalizeLevel on the next save. Same standing as the editor
  // preferences beside them. See F-14 for the per-enemy version, which is a
  // change to @ccllc/arcade rather than one that can be made here.
  const [explosions, setExplosions] = useState<ExplosionSet>(defaultExplosions);
  const [designingBursts, setDesigningBursts] = useState(false);
  const designingBurstsRef = useRef(false);
  useEffect(() => { designingBurstsRef.current = designingBursts; }, [designingBursts]);
  useEffect(() => { explosionsRef.current = explosions; }, [explosions]);

  useEffect(() => { levelRef.current = level; }, [level]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { toolRef.current = tool; }, [tool]);
  // One direction now: the model is the source, React mirrors it. The two
  // effects this replaces ran the other way -- state to ref -- so every read
  // through a ref was one render behind the model that had already changed.
  useEffect(() => editorFor().selection.subscribe(({ ids, primary }) => {
    setSelectedIds([...ids]);
    setSelectedId(primary);
  }), [editorFor]);
  useEffect(() => { editorCameraRef.current = camera; }, [camera]);

  const flash = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice("READY"), 1800);
  }, []);

  // Deduplicating and defaulting the primary to the last id are the model's
  // rules now, and it adds the one this did not have: a primary that is not a
  // member falls back instead of pointing at nothing.
  const setSelection = useCallback((ids: string[], primary?: string | null) => {
    editorFor().selection.set(ids, primary);
    setInspectPlayer(false);
  }, [editorFor]);

  // The undo stack reports its own state; the two button-enabled flags follow it
  // rather than being recomputed at every call site the way they used to be.
  useEffect(() => {
    const history = historyRef.current;
    history.reset(levelRef.current);
    return history.subscribe(({ canUndo: undoable, canRedo: redoable }) => {
      setCanUndo(undoable); setCanRedo(redoable);
    });
  }, []);

  const commitSnapshot = useCallback((next: Level, coalesceKey = "") => {
    historyRef.current.commit(next, coalesceKey);
  }, []);

  const installLevel = useCallback((next: Level, reset = false) => {
    const normalized = normalizeLevel(next);
    loadedRef.current = normalized;
    levelRef.current = normalized; setLevel(normalized);
    if (reset) historyRef.current.reset(normalized);
    setSelection([]); setInspectPlayer(false);
  }, [setSelection]);

  const applyHistory = useCallback((direction: -1 | 1) => {
    const restored = direction < 0 ? historyRef.current.undo() : historyRef.current.redo();
    if (!restored) return;
    const next = normalizeLevel(restored);
    levelRef.current = next; setLevel(next);
    // The whole of what the four hand-written lines here used to do, including
    // keeping the primary when it survived and falling back when it did not.
    editorFor().selection.retain((id) => next.items.some((item) => item.id === id));
    const safeCamera = clamp(editorCameraRef.current, 0, Math.max(0, next.length - VIEW_W)); editorCameraRef.current = safeCamera; setCamera(safeCamera);
    flash(direction < 0 ? "UNDO" : "REDO");
  }, [editorFor, flash]);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch { flash("FULLSCREEN UNAVAILABLE"); }
  }, [flash]);

  useEffect(() => {
    const sync = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  useEffect(() => {
    const perf = perfRef.current;
    const telemetry = telemetryRef.current;
    telemetry.attachPerformance(perf);
    // The readout only re-renders when the counter is visible: subscribing
    // unconditionally would setState once a second for a panel nobody is
    // looking at, on a component this size.
    const off = showFps ? perf.subscribe(setFpsStats) : undefined;
    const detach = perf.attach();
    if (showFps) perf.clear();
    return () => { off?.(); detach(); };
  }, [showFps]);

  // One input instance for the life of the component. It owns the key
  // listeners, the pad poll and the blur release; the connect/disconnect events
  // are still ours because they only drive the readout in the top bar.
  useEffect(() => {
    const input = createInput({ actions: ACTIONS });
    inputRef.current = input;
    const connected = (event: GamepadEvent) => {
      setControllerName(event.gamepad.id);
      flash("CONTROLLER CONNECTED");
    };
    const disconnected = (event: GamepadEvent) => {
      if (input.gamepadName === event.gamepad.id || !input.connected) setControllerName("");
    };
    window.addEventListener("gamepadconnected", connected);
    window.addEventListener("gamepaddisconnected", disconnected);
    return () => {
      window.removeEventListener("gamepadconnected", connected);
      window.removeEventListener("gamepaddisconnected", disconnected);
      input.destroy();
      inputRef.current = null;
    };
  }, [flash]);

  useEffect(() => {
    storageNotice = flash;
    return () => { storageNotice = (message) => console.warn(message); };
  }, [flash]);

  useEffect(() => {
    starsRef.current = createStars(155);
    // The shelf is in IndexedDB, and IndexedDB has to be read before it can be
    // asked for a draft: everything below waits on the library's `ready`, which
    // localStorage and memory resolve at once and IndexedDB resolves a few
    // milliseconds after mount. It was always a second render; it still is.
    let stale = false;
    void levelLibrary.ready.then(() => {
      if (stale) return;
      try {
        // A shared link wins over the local draft: the player followed it to see
        // somebody else's sector, not to resume their own. Reading it also clears
        // the fragment, so a reload does not reopen it over the later edits.
        const shared = levelDocument.readShareFromLocation();
        // A shared link opens as unsaved work; failing that, the draft from last
        // time; the session owns both, so what it holds is what is on screen.
        let opened = false;
        if (shared.document) opened = levelSession.openDocument(shared.document, { force: true });
        if (!opened && levelSession.hasDraft()) opened = levelSession.restoreDraft();
        // A deliberate second render: the exported HTML is built with the
        // starter level, so the first client render has to match it, and
        // localStorage only gets a say after mount. The rule is right that
        // this cascades; here the cascade is the feature.
        if (opened) installLevel(levelSession.state.doc, true);
        // Same two-phase load and the same reason: a link that will not decode
        // has to say so, and there is nowhere earlier to say it from.
        if (shared.error) flash("SHARED LINK UNREADABLE");
        setSavedEntries(levelLibrary.list().map(({ id, name }) => ({ id, name, bytes: (JSON.stringify(levelLibrary.read(id)) ?? "").length * 2 })));
      } catch { /* use the starter level */ }
    });
    return () => { stale = true; };
  }, [flash, installLevel]);

  // Toolbar Behavior belongs to the user, not to the level, so it is stored
  // beside the level library rather than inside it — and like the draft above,
  // it can only be read after mount, because the exported HTML was built
  // without it.
  useEffect(() => {
    adoptLegacyEditorSettings();
    // Clamped and defaulted by the schema, so there is nothing to validate here
    // and no try/catch: a blocked browser gives the store memory, not a throw.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSectionMode(editorSettings.get("sectionMode"));
    // The panel widths ride the same two-phase load, for the same reason: the
    // exported HTML was built with the defaults, so the first client render has
    // to match them and localStorage only gets a say after mount. They need no
    // suppression of their own -- the directive above covers the effect.
    setPaletteWidth(editorSettings.get("paletteWidth"));
    setInspectorWidth(editorSettings.get("inspectorWidth"));
    setDisplayPrefs(readDisplayPrefs());
  }, []);

  // The designed explosions, on the same two-phase load and for the same
  // reason: the export was built with the defaults, so the first client render
  // has to match them and localStorage only gets a say after mount.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setExplosions(loadExplosions());
  }, []);

  // Written where the choice is made rather than from an effect on the value:
  // one control changes it, and an effect would race the restore above and put
  // the default back over the stored choice on the way in.
  /** One display preference: into the store, and into the state the dialog and the loop read. */
  const applyDisplayPref = <K extends keyof DisplayPrefs>(key: K, value: DisplayPrefs[K]) => {
    editorSettings.set(key, value);
    setDisplayPrefs((current) => ({ ...current, [key]: value }));
  };
  const applySectionMode = useCallback((next: SectionMode) => {
    setSectionMode(next);
    editorSettings.set("sectionMode", next);
  }, []);

  // Every edit reaches the session, which autosaves the draft behind a
  // debounce and owns dirty; a load is the one change that is not an edit.
  useEffect(() => {
    if (level === loadedRef.current) return;
    if (level.name !== levelSession.state.name) levelSession.rename(level.name);
    levelSession.update(level);
  }, [level]);
  useEffect(() => levelSession.guardUnload(window), []);

  const updateLevel = useCallback((updater: (current: Level) => Level, record = true, coalesceKey = "") => {
    const next = normalizeLevel(updater(levelRef.current));
    levelRef.current = next; setLevel(next);
    if (record) commitSnapshot(next, coalesceKey);
  }, [commitSnapshot]);

  const updateItem = useCallback((id: string, updater: (item: LevelItem) => LevelItem, record = true) => {
    updateLevel((current) => ({ ...current, items: current.items.map((item) => item.id === id ? updater(item) : item) }), record, `item-${id}`);
  }, [updateLevel]);

  // The library's default coalesce key is the reason plus the selection, which
  // is what the key built here by hand already was.
  const updateSelectedItems = useCallback((updater: (item: LevelItem) => LevelItem, coalesceKey: string) => {
    editorFor().commands.update(updater, { reason: coalesceKey });
  }, [editorFor]);

  const duplicateSelected = useCallback(() => {
    if (modeRef.current !== "build") return;
    // Where a copy lands is geometry, so it stays here; that the copies are
    // what ends up selected is the library's, and is why the next drag moves
    // the new ones rather than the originals.
    const copies = editorFor().commands.duplicate({
      offset: (copy) => ({
        ...copy,
        x: Math.min(levelRef.current.length, copy.x + 80),
        y: clamp(copy.y + 45, -PLACE_MARGIN, VIEW_H + PLACE_MARGIN),
      }),
    });
    if (copies.length) flash(`${copies.length} OBJECT${copies.length === 1 ? "" : "S"} DUPLICATED`);
  }, [editorFor, flash]);

  const deleteSelected = useCallback(() => {
    // Clearing the selection is the library's doing and not optional there:
    // ids left pointing at deleted items are how an Inspector edits a ghost.
    const removed = editorFor().commands.remove();
    if (removed) flash(`${removed} OBJECT${removed === 1 ? "" : "S"} REMOVED`);
  }, [editorFor, flash]);

  const saveObjectComponent = useCallback((updateExisting = false) => {
    const source = levelRef.current.items.find((item) => item.id === editorFor().selection.primary); if (!source) return;
    const existing = source.componentId ? levelRef.current.components.find((component) => component.id === source.componentId) : undefined;
    const id = updateExisting && existing ? existing.id : `component-${uid()}`; const name = window.prompt(updateExisting && existing ? "Update Component name:" : "Component name:", existing?.name ?? source.name)?.trim(); if (!name) return;
    const object = structuredClone(source); object.id = "template"; object.name = name; object.componentId = id;
    updateLevel((current) => ({ ...current, items: current.items.map((item) => item.id === source.id ? { ...item, componentId: id } : item), components: [...current.components.filter((component) => component.id !== id), { id, name, kind: source.type, object }] }));
    flash(existing ? "COMPONENT UPDATED" : "COMPONENT SAVED");
  }, [editorFor, flash, updateLevel]);

  const saveWeaponComponent = useCallback((weapon: Weapon, suggested: string) => {
    const name = window.prompt("Weapon Component name:", suggested)?.trim(); if (!name) return;
    const tagInput = window.prompt("Compatibility tag (standard, light, heavy, or satellite):", "standard")?.trim().toLowerCase(); const tag = ["standard", "light", "heavy", "satellite"].includes(tagInput ?? "") ? tagInput! : "standard";
    const gun: GunType = weapon.shotsPerSecond >= 8 ? "rapid" : "pulse"; const spread = 1;
    updateLevel((current) => ({ ...current, components: [...current.components, { id: `component-${uid()}`, name, kind: "weapon", weapon: { ...structuredClone(weapon), power: weapon.power < 10 ? weapon.power * 100 : weapon.power, tag, gun, spread, color: weapon.projectile === "plasma" ? "#ff8d73" : "#eaff62" } }] })); flash("WEAPON COMPONENT SAVED");
  }, [flash, updateLevel]);

  const saveArmorComponent = useCallback((armor: ArmorSettings) => {
    const name = window.prompt("Armor Component name:", armor.type === "forcefield" ? "Custom Force Field" : "Custom Armor")?.trim(); if (!name) return;
    updateLevel((current) => ({ ...current, components: [...current.components, { id: `component-${uid()}`, name, kind: "armor", armor: structuredClone(armor) }] })); flash("ARMOR COMPONENT SAVED");
  }, [flash, updateLevel]);

  const saveSatelliteComponent = useCallback((satellite: SatelliteSettings) => {
    const name = window.prompt("Satellite Component name:", "Custom Satellite")?.trim(); if (!name) return;
    updateLevel((current) => ({ ...current, components: [...current.components, { id: `component-${uid()}`, name, kind: "satellite", satellite: structuredClone(satellite) }] })); flash("SATELLITE COMPONENT SAVED");
  }, [flash, updateLevel]);

  // Saving a built-in Enhancement copies it under a fresh `component-` id
  // rather than referencing it. normalizeLevel reinstates the built-in library
  // on every load, replacing same-id entries, so a copy is the only form of one
  // the user can edit and keep.
  const saveAsComponent = useCallback((source: ComponentDefinition) => {
    const name = window.prompt("Component name:", source.name)?.trim(); if (!name) return;
    updateLevel((current) => ({ ...current, components: [...current.components, { ...structuredClone(source), id: `component-${uid()}`, name }] })); flash("COMPONENT SAVED");
  }, [flash, updateLevel]);

  /**
   * Explosions and sounds are saved Components, like weapons and patterns
   * before them, because an item's `fx` points at a Component ID. Editing one
   * therefore reaches every enemy that references it, which is the entire
   * meaning of "per enemy TYPE" — a dozen raiders share one explosion.
   *
   * Upsert rather than append: the editors open on an existing Component when
   * there is one, and saving under the same id has to replace it rather than
   * grow a second copy nothing points at.
   */
  const upsertComponent = useCallback((component: ComponentDefinition) => {
    updateLevel((current) => ({
      ...current,
      components: current.components.some((entry) => entry.id === component.id)
        ? current.components.map((entry) => (entry.id === component.id ? component : entry))
        : [...current.components, component],
    }));
  }, [updateLevel]);

  const saveSoundComponent = useCallback((sound: SfxDefinition) => {
    const target = editingSound;
    if (!target) return;
    upsertComponent({ id: target.id, name: sound.name || "Sound", kind: "sound", sound: normalizeSfx(sound) });
    setEditingSound(null);
    flash("SOUND SAVED");
  }, [editingSound, flash, upsertComponent]);

  const saveExplosionComponent = useCallback((burst: BurstDefinition) => {
    const target = editingExplosion;
    if (!target) return;
    upsertComponent({ id: target.id, name: burst.name || "Explosion", kind: "explosion", explosion: normalizeBurst(burst) });
    setEditingExplosion(null);
    flash("EXPLOSION SAVED");
  }, [editingExplosion, flash, upsertComponent]);

  const savePatternComponent = useCallback((pattern: BulletPatternDefinition) => {
    const name = window.prompt("Pattern Component name:", pattern.name || "Custom Pattern")?.trim(); if (!name) return;
    const saved = normalizeBulletPattern(structuredClone({ ...pattern, name }));
    updateLevel((current) => ({ ...current, components: [...current.components, { id: `component-${uid()}`, name, kind: "pattern", pattern: saved }] })); flash("BULLET PATTERN COMPONENT SAVED");
  }, [flash, updateLevel]);

  const applyPatternEditor = useCallback((pattern: BulletPatternDefinition) => {
    if (!editingPattern) return;
    const saved = normalizeBulletPattern(structuredClone(pattern));
    const target = editingPattern.target;
    if (target.kind === "item") updateItem(target.id, (item) => ({ ...item, weapon: { ...item.weapon, enabled: true, pattern: saved } }));
    else updateLevel((current) => ({ ...current, components: current.components.map((component) => component.id === target.id ? (target.kind === "weapon" ? { ...component, weapon: component.weapon ? { ...component.weapon, pattern: saved } : component.weapon } : { ...component, name: saved.name, pattern: saved }) : component) }));
    setEditingPattern(null); flash("BULLET PATTERN APPLIED");
  }, [editingPattern, flash, updateItem, updateLevel]);

  const applyEquipmentComponent = useCallback((component: ComponentDefinition) => {
    const target = levelRef.current.items.find((item) => item.id === editorFor().selection.primary);
    if (component.kind === "weapon" && component.weapon) {
      if (target && (target.type === "enemy" || target.type === "group")) { updateItem(target.id, (item) => ({ ...item, weapon: { ...structuredClone(component.weapon!), power: Math.max(1, Math.round(component.weapon!.power / 100)) } })); flash("WEAPON APPLIED TO OBJECT"); return; }
      updateLevel((current) => { const inventory = current.player.inventory.includes(component.id) ? current.player.inventory : [...current.player.inventory.slice(0, Math.max(0, current.player.inventoryLimit - 1)), component.id]; const slots = current.player.weaponSlots.map((slot, index) => index === 0 && (slot.accepts === component.weapon?.tag || slot.accepts === "any") ? { ...slot, weaponId: component.id } : slot); return { ...current, player: { ...current.player, inventory, weaponSlots: slots } }; }); flash("WEAPON ADDED / EQUIPPED");
    } else if (component.kind === "armor" && component.armor) { if (target && (target.type === "enemy" || target.type === "terrain" || target.type === "group")) { updateItem(target.id, (item) => ({ ...item, armor: structuredClone(component.armor!) })); flash("ARMOR APPLIED TO OBJECT"); return; } updateLevel((current) => ({ ...current, player: { ...current.player, armor: structuredClone(component.armor!) } })); flash("ARMOR EQUIPPED"); }
    else if (component.kind === "satellite" && component.satellite) { updateLevel((current) => ({ ...current, player: { ...current.player, satellite: { ...structuredClone(component.satellite!), enabled: true } } })); flash("SATELLITE EQUIPPED"); }
    else if (component.kind === "pattern" && component.pattern) {
      if (target && (target.type === "enemy" || target.type === "group")) { updateItem(target.id, (item) => ({ ...item, weapon: { ...item.weapon, enabled: true, pattern: structuredClone(component.pattern!) } })); flash("PATTERN APPLIED TO OBJECT"); return; }
      setEditingPattern({ pattern: structuredClone(component.pattern), target: { kind: "pattern", id: component.id } }); flash("PATTERN DESIGNER OPEN"); return;
    }
    setSelection([]); setInspectPlayer(true);
  }, [editorFor, flash, setSelection, updateItem, updateLevel]);

  const deleteComponent = useCallback((id: string) => {
    if (!id.startsWith("component-")) return;
    setPendingConfirm({
      title: "DELETE COMPONENT",
      message: "Delete this saved Component? Placed instances will keep their current settings.",
      action: () => {
        updateLevel((current) => ({ ...current, components: current.components.filter((component) => component.id !== id), items: current.items.map((item) => item.componentId === id ? { ...item, componentId: undefined } : item), player: { ...current.player, inventory: current.player.inventory.filter((entry) => entry !== id), weaponSlots: current.player.weaponSlots.map((slot) => slot.weaponId === id ? { ...slot, weaponId: "weapon-pulse" } : slot), satellite: current.player.satellite.weaponId === id ? { ...current.player.satellite, weaponId: "weapon-pulse" } : current.player.satellite } })); flash("COMPONENT DELETED");
      },
    });
  }, [flash, updateLevel]);

  const saveSpriteAsset = useCallback((asset: SpriteAsset) => {
    updateLevel((current) => ({ ...current, assets: [...current.assets.filter((entry) => entry.id !== asset.id), asset] })); setEditingAsset(null); flash("SPRITE ASSET SAVED");
  }, [flash, updateLevel]);

  const deleteSpriteAsset = useCallback((id: string) => {
    const sprite = `asset:${id}` as Sprite; const uses = levelRef.current.items.filter((item) => item.sprite === sprite).length + levelRef.current.components.filter((component) => component.object?.sprite === sprite).length;
    setPendingConfirm({
      title: "DELETE SPRITE",
      message: uses ? `This sprite is used ${uses} time(s). Delete it and replace those uses with ORB?` : "Delete this sprite asset?",
      action: () => {
        updateLevel((current) => ({ ...current, assets: current.assets.filter((asset) => asset.id !== id), items: current.items.map((item) => item.sprite === sprite ? { ...item, sprite: "orb" } : item), components: current.components.map((component) => component.object?.sprite === sprite ? { ...component, object: { ...component.object, sprite: "orb" } } : component) })); flash("SPRITE ASSET DELETED");
      },
    });
  }, [flash, updateLevel]);

  const refreshSaved = useCallback(() => {
    setSavedEntries(levelLibrary.list().map(({ id, name }) => ({ id, name, bytes: (JSON.stringify(levelLibrary.read(id)) ?? "").length * 2 })));
  }, []);

  const commitSave = useCallback(() => {
    const entry = levelSession.save();
    if (!entry) { flash(describeSaveFailure()); return false; }
    refreshSaved();
    setLoadName(entry.id); flash("LEVEL SAVED TO THIS DEVICE");
    return true;
  }, [flash, refreshSaved]);

  const duplicateLevel = useCallback(() => {
    const entry = levelSession.duplicate();
    if (!entry) { flash(describeSaveFailure()); return; }
    installLevel(levelSession.state.doc, true);
    refreshSaved();
    setLoadName(entry.id); flash(`DUPLICATED AS ${entry.name.toUpperCase()} — EDITING THE COPY`);
  }, [flash, installLevel, refreshSaved]);

  const saveLevel = useCallback(() => {
    const { id, renamed, savedName, name } = levelSession.state;
    if (id !== null && renamed && savedName !== null) {
      // A saved level under a changed name: rename it, or keep the old one
      // and save this as a new level? The one question the contract asks.
      setPendingConfirm({
        title: "RENAME OR SAVE AS NEW?",
        message: `You changed the name from "${savedName}" to "${name}". Rename the saved level, or keep "${savedName}" as it was and save this as a new level?`,
        confirmLabel: "RENAME IT",
        action: () => { commitSave(); },
        alternate: { label: "SAVE AS NEW LEVEL", action: duplicateLevel },
      });
      return;
    }
    commitSave();
  }, [commitSave, duplicateLevel]);

  /** Unsaved work is never thrown away in silence: save it, discard it, or stay. */
  const withSettledDirty = useCallback((before: string, proceed: () => void) => {
    if (!levelSession.state.dirty) { proceed(); return; }
    setPendingConfirm({
      title: "UNSAVED CHANGES",
      message: `"${levelSession.state.name}" has unsaved changes. Save them before ${before}?`,
      confirmLabel: "SAVE AND CONTINUE",
      action: () => { if (commitSave()) proceed(); },
      alternate: { label: "DISCARD", action: proceed },
    });
  }, [commitSave]);

  const loadLevel = useCallback(() => {
    if (!loadName) return;
    if (loadName.startsWith("sample:")) {
      const sample = starterLevels.find((entry) => `sample:${entry.key}` === loadName);
      if (!sample) return;
      withSettledDirty(`loading ${sample.name}`, () => {
        // A sample opens as a clean starting point; saving it makes it yours.
        levelSession.openDocument(sample.build(), { force: true, dirty: false });
        installLevel(levelSession.state.doc, true); setCamera(0); editorCameraRef.current = 0;
        flash(`LOADED ${sample.name.toUpperCase()}`);
      });
      return;
    }
    const entry = savedEntries.find((saved) => saved.id === loadName);
    if (!entry) { flash("THAT SAVED LEVEL IS NO LONGER AVAILABLE"); return; }
    withSettledDirty(`loading ${entry.name}`, () => {
      if (!levelSession.open(entry.id, { force: true })) { flash("THAT SAVED LEVEL IS NO LONGER AVAILABLE"); refreshSaved(); return; }
      installLevel(levelSession.state.doc, true); setCamera(0); editorCameraRef.current = 0; flash(`LOADED ${entry.name.toUpperCase()}`);
    });
  }, [flash, installLevel, loadName, refreshSaved, savedEntries, withSettledDirty]);

  const deleteSavedLevel = useCallback(() => {
    const entry = savedEntries.find((saved) => saved.id === loadName);
    if (!entry) return;
    if (!levelSession.remove(entry.id)) return;
    refreshSaved(); setLoadName("");
    flash(`DELETED ${entry.name.toUpperCase()} — UNDO IS BESIDE LOAD FOR A FEW SECONDS`);
  }, [flash, loadName, refreshSaved, savedEntries]);

  const undoDelete = useCallback(() => {
    if (levelSession.undoRemove()) { refreshSaved(); flash("RESTORED"); }
  }, [flash, refreshSaved]);

  // `parse` before handing a level to the format, in both places below. The
  // editor holds a plain `Level`; the format's document type is that plus the
  // envelope it stamps (`format`, `savedAt`), and since 2.0.6 the declarations
  // say so. Nothing changes at runtime -- `serialize` parses whatever it is
  // given anyway -- so this makes the call sites state the conversion that was
  // always happening one layer down.
  const exportLevel = useCallback(() => {
    try { levelDocument.download(levelDocument.parse(levelRef.current)); flash("JSON EXPORTED"); }
    catch (error) { flash(documentMessage(error, "EXPORT FAILED")); }
  }, [flash]);

  const importLevel = useCallback(async (file: File) => {
    let parsed: Level;
    try { parsed = await levelDocument.readFile(file); }
    catch (error) { flash(documentMessage(error, "INVALID LEVEL FILE")); return; }
    withSettledDirty("importing a file", () => {
      // A file opens as unsaved work: it is not on the shelf until saved.
      levelSession.openDocument(parsed, { force: true });
      installLevel(levelSession.state.doc, true); setCamera(0); editorCameraRef.current = 0; flash("LEVEL IMPORTED — SAVE IT TO KEEP IT");
    });
  }, [flash, installLevel, withSettledDirty]);

  // A whole sector in the URL fragment: no server and no account, the same
  // trade Pinball already makes. The cap is the library's 256 KB default, and a
  // sector carrying several hand-drawn sprite assets can reach it -- which is
  // what the "too large to share" refusal is for.
  const shareLevel = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(levelDocument.shareLink(levelDocument.parse(levelRef.current)));
      flash("SHARE LINK COPIED");
    } catch (error) { flash(documentMessage(error, "SHARE FAILED")); }
  }, [flash]);

  // The renderer decides what an explosion looks like. The world only asks for
  // one, which is what lets the simulation stay free of Math.random.
  //
  // `count` is the world's only size signal, and its call sites cluster into
  // three groups; `roleForCount` is that mapping, and it lives beside the
  // designs rather than here so the designer can label each role with the
  // engine's own numbers.
  /**
   * What the level attached to the thing that just happened.
   *
   * The engine tells us WHICH authored item was destroyed or fired; everything
   * about what that should look and sound like lives in the level's own
   * Components, so this is the only place the two meet. An id naming a deleted
   * Component resolves to nothing and the default plays, which is why the
   * engine keeps such ids rather than clearing them.
   */
  const effectsFor = useCallback((sourceId: string | undefined) => {
    if (!sourceId) return undefined;
    const level = levelRef.current;
    const item = level.items.find((entry) => entry.id === sourceId);
    if (!item?.fx) return undefined;
    const find = (id: string | undefined) => (id ? level.components.find((entry) => entry.id === id) : undefined);
    return {
      explosion: find(item.fx.explosionId)?.explosion,
      death: find(item.fx.deathSoundId)?.sound,
      fire: find(item.fx.fireSoundId)?.sound,
    };
  }, []);

  /**
   * Play the designed effects for a step's events.
   *
   * Explosions from here REPLACE the generic one the same death also queued as
   * a burst — the world queues both, and drawing both would double every
   * authored explosion. The burst queue is drained first and the generic blast
   * dropped whenever an event at the same point brought its own.
   */
  const playEvents = useCallback((events: ShmupEvent[]) => {
    const player = sfxRef.current;
    const authored: { x: number; y: number }[] = [];
    for (const event of events) {
      // `sourceId` lives on the members that have one, so each branch narrows
      // before asking — which is the union earning its keep rather than a
      // catch-all shape with half its fields undefined.
      if (event.type === "destroyed") {
        const fx = effectsFor(event.sourceId);
        if (fx?.explosion) {
          burstsRef.current.push(createBurstRuntime(fx.explosion, event.x, event.y));
          authored.push({ x: event.x, y: event.y });
        }
        if (fx?.death) player.play(fx.death);
      } else if (event.type === "fired") {
        const fx = effectsFor(event.sourceId);
        if (fx?.fire) player.play(fx.fire);
      }
    }
    return authored;
  }, [effectsFor]);

  const spawnBursts = useCallback((bursts: Burst[], authored: { x: number; y: number }[] = []) => {
    const live = burstsRef.current;
    const set = explosionsRef.current;
    for (const request of bursts) {
      // A death queues both a burst and an event. If the event brought a
      // designed explosion, this generic one is the same explosion drawn twice.
      if (authored.some((point) => point.x === request.x && point.y === request.y)) continue;
      const explosion = set[roleForCount(request.count)];
      live.push(createBurstRuntime(tintedBurst(explosion, request.color), request.x, request.y));
    }
    // A wall of simultaneous deaths is the one case that can pile these up, and
    // the oldest are the ones already fading out.
    if (live.length > MAX_LIVE_BURSTS) live.splice(0, live.length - MAX_LIVE_BURSTS);
  }, []);

  /**
   * Presentation mode is playtest with the editor taken away, because that is
   * what "as a player would see it" means here — chrome hidden around a paused
   * editor would still be an editor. So it is a way of ENTERING play rather
   * than a mode of its own, which is also why nothing has to decide what
   * happens if the two disagree.
   *
   * `P` is not free — it is pause during play, and the pause overlay says so —
   * so this is Shift+T: T already starts a playtest, and Shift+T starts the
   * same playtest presented. Escape leaves, exactly as it leaves a playtest,
   * so there is no second way out to learn.
   */
  const enterPlay = useCallback((presented = false) => {
    const world = createWorld(levelRef.current);
    worldRef.current = world;
    burstsRef.current = [];
    inputRef.current?.releaseAll();
    satellitePointerRef.current = { x: VIEW_W * .7, y: VIEW_H / 2, active: false };
    mouseFireRef.current = false;
    setScore(0); setLives(world.state.hullMax); setHullMax(world.state.hullMax);
    setShield(Math.round(world.state.player.shield)); setProgress(0);
    setPresenting(presented);
    setMode("playing"); modeRef.current = "playing";
    flash(presented ? "PRESENTING — ESC TO RETURN" : "PLAYTEST ACTIVE");
  }, [flash]);

  const exitPlay = useCallback(() => {
    inputRef.current?.releaseAll();
    worldRef.current = null;
    setPresenting(false);
    setMode("build"); modeRef.current = "build"; setProgress(0); flash("BUILD MODE RESTORED");
  }, [flash]);

  const equipInventoryWeapon = useCallback((requestedIndex?: number) => {
    const name = worldRef.current?.equipWeapon(requestedIndex);
    if (name) flash(`EQUIPPED ${name.toUpperCase()}`);
  }, [flash]);

  useEffect(() => {
    // The shortcut table as data. What it replaces was a forty-line if-chain
    // that repeated `event.ctrlKey || event.metaKey` at every branch and
    // `!event.ctrlKey && !event.metaKey` at most of the bare letters -- three
    // rules restated per binding, which is three chances per binding to get one
    // wrong. They are the keymap's now: ctrl means Ctrl or Cmd, a bare letter
    // does not fire while either is held, and nothing fires while the user is
    // typing except the save shortcut, which opts in.
    const build = () => modeRef.current === "build";
    const hasSelection = () => build() && editorFor().selection.size > 0;
    // Not while a section header or the palette tab strip has focus: both walk
    // the arrow keys themselves (the WAI-ARIA accordion and tabs patterns), and
    // a nudge firing at the same time would drag the selection around as a side
    // effect of browsing the panels.
    const nudgeable = (event: KeyboardEvent) =>
      hasSelection() && !(event.target as HTMLElement | null)?.closest?.('.eb-card-collapse-toggle, [role="tablist"]');
    const rotateBy = (fine: boolean) => (event: KeyboardEvent) => {
      const delta = (event.code === "KeyQ" ? -1 : 1) * (fine ? 1 : 15);
      editorFor().commands.update((item) => ({ ...item, rotation: item.rotation + delta }), { reason: "rotate" });
    };
    const nudgeBy = (step: number) => (event: KeyboardEvent) => {
      const dx = event.code === "ArrowLeft" ? -step : event.code === "ArrowRight" ? step : 0;
      const dy = event.code === "ArrowUp" ? -step : event.code === "ArrowDown" ? step : 0;
      editorFor().commands.update((item) => ({
        ...item,
        x: clamp(item.x + dx, 0, levelRef.current.length),
        y: clamp(item.y + dy, -PLACE_MARGIN, VIEW_H + PLACE_MARGIN),
      }), { reason: "nudge" });
    };
    const keymap = createKeymap([
      // Shift distinguishes these two rather than being read inside one, which
      // is the whole reason the modifier match is exact.
      { code: "KeyZ", ctrl: true, shift: true, when: build, label: "Redo", run: () => applyHistory(1) },
      { code: "KeyZ", ctrl: true, when: build, label: "Undo", run: () => applyHistory(-1) },
      { code: "KeyY", ctrl: true, when: build, label: "Redo", run: () => applyHistory(1) },
      // The one shortcut that survives a focused text field: losing an edit
      // because focus was still in the name box is worse than the alternative.
      { code: "KeyS", ctrl: true, shift: true, allowInTextEntry: true, label: "Duplicate", run: () => duplicateLevel() },
      { code: "KeyS", ctrl: true, allowInTextEntry: true, label: "Save", run: () => saveLevel() },
      { code: "KeyT", shift: true, when: build, label: "Present", run: () => enterPlay(true) },
      { code: "KeyT", when: build, label: "Playtest", run: () => enterPlay() },
      { code: "Escape", when: () => !build(), label: "Leave playtest", run: () => exitPlay() },
      { code: ["Delete", "Backspace"], when: build, label: "Delete", run: () => deleteSelected() },
      {
        code: "Escape", when: build, label: "Select tool / clear selection",
        run: () => {
          if (toolRef.current !== "select") { setTool("select"); toolRef.current = "select"; flash("SELECT MODE"); }
          else { setSelection([]); setInspectPlayer(false); flash("SELECTION CLEARED"); }
        },
      },
      { code: "KeyD", when: build, label: "Duplicate", run: () => duplicateSelected() },
      { code: "KeyS", when: build, label: "Scroll tool", run: () => { setTool("scroll"); toolRef.current = "scroll"; flash("SCROLL TOOL"); } },
      { code: ["KeyQ", "KeyE"], shift: true, when: hasSelection, label: "Rotate 1°", run: rotateBy(true) },
      { code: ["KeyQ", "KeyE"], when: hasSelection, label: "Rotate 15°", run: rotateBy(false) },
      { code: "KeyF", label: "Full screen", run: () => void toggleFullscreen() },
      // F8 for the frame-rate readout, matching the other two games.
      { code: "F8", label: "FPS", run: () => setShowFps((value) => !value) },
      // allowRepeat, unlike every other binding here: holding an arrow should
      // keep nudging, where holding D should duplicate exactly once.
      { code: ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"], shift: true, allowRepeat: true, when: () => build(), label: "Nudge 25", run: nudgeBy(25) },
      { code: ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"], allowRepeat: true, when: () => build(), label: "Nudge 5", run: nudgeBy(5) },
      // passive: these three never preventDefaulted before, and Enter in
      // particular has to stay available to whatever else is listening.
      { code: "Enter", passive: true, when: () => modeRef.current === "gameover" || modeRef.current === "victory", run: () => enterPlay() },
      { code: "KeyP", passive: true, when: () => modeRef.current === "playing", label: "Pause", run: () => { setMode("paused"); modeRef.current = "paused"; } },
      { code: "KeyP", passive: true, when: () => modeRef.current === "paused", label: "Resume", run: () => { setMode("playing"); modeRef.current = "playing"; } },
      {
        code: ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8", "Digit9"],
        when: () => modeRef.current === "playing", label: "Equip",
        run: (event) => equipInventoryWeapon(Number(event.code.slice(-1)) - 1),
      },
      // Movement and fire are not here: createInput owns those codes,
      // preventDefaults them, and releases them on blur.
    ]);
    const keyDown = (event: KeyboardEvent) => {
      // The pattern designer, the confirm and the settings dialog each own the
      // keyboard outright while open, which is a gate over the whole table
      // rather than a condition on any one binding.
      if (editingPatternRef.current || pendingConfirmRef.current || showSettingsRef.current || designingBurstsRef.current || editingOverlayRef.current) return;
      // The nudge bindings need the event to decide, which `when` cannot see.
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.code) && !nudgeable(event)) return;
      keymap.handle(event);
    };
    window.addEventListener("keydown", keyDown, { passive: false });
    return () => { window.removeEventListener("keydown", keyDown); };
  }, [applyHistory, deleteSelected, duplicateSelected, editorFor, enterPlay, equipInventoryWeapon, exitPlay, flash, saveLevel, setSelection, toggleFullscreen, updateLevel]);

  useEffect(() => {
    const canvas = mainCanvasRef.current;
    const mini = miniCanvasRef.current;
    if (!canvas || !mini) return;
    const context = canvas.getContext("2d");
    const miniContext = mini.getContext("2d");
    if (!context || !miniContext) return;

    // The presenter is the last pass over a played frame: the 2d canvas above
    // is drawn exactly as before and then handed over as the frame, so nothing
    // about drawing, framing or pointer mapping had to learn about it. Its own
    // canvas sits over the stage with pointer events off. It is created when
    // play first asks for a filter, remade when the stage changes size (its
    // width and height are fixed at creation), reconfigured when the settings
    // move, and put away when the editor comes back.
    let presenter: PixelPresenter | null = null;
    let presenterSize = "";
    let presenterPrefs = "";
    let presenterFailedSize = "";
    const presentFrame = () => {
      const target = presentCanvasRef.current;
      const prefs = displayPrefsRef.current;
      if (!target) return;
      const wanted = modeRef.current !== "build" && prefs.pixelFilter !== "none";
      if (!wanted) {
        if (!target.hidden) target.hidden = true;
        return;
      }
      // A frame with no size -- a stage not yet laid out, or one collapsed --
      // has nothing to present, and the presenter refuses a zero dimension,
      // rightly. Wait for a real frame.
      if (canvas.width < 1 || canvas.height < 1) { if (!target.hidden) target.hidden = true; return; }
      const size = `${canvas.width}x${canvas.height}`;
      // A presenter that could not be made for this size is not retried every
      // frame: the picture shows plain until the stage changes size.
      if (presenterFailedSize === size) { if (!target.hidden) target.hidden = true; return; }
      if (!presenter || presenterSize !== size) {
        presenter?.destroy();
        presenter = null;
        target.width = canvas.width; target.height = canvas.height;
        try {
          presenter = createPixelPresenter(target, {
            width: canvas.width, height: canvas.height, mode: "stretch", scaleMode: "fit", autoResize: false,
            filter: prefs.pixelFilter, lineBrightness: prefs.lineBrightness, bandRows: prefs.bandRows, gridThickness: prefs.gridThickness,
            crtAmount: prefs.crtAmount, crtGlow: prefs.crtGlow, crtNoise: prefs.crtNoise,
            clearColor: [3 / 255, 7 / 255, 11 / 255, 1],
          });
        } catch (error) {
          console.warn("Display filter unavailable for this stage:", error);
          presenterFailedSize = size;
          if (!target.hidden) target.hidden = true;
          return;
        }
        presenterSize = size;
        presenterPrefs = JSON.stringify(prefs);
      } else {
        const key = JSON.stringify(prefs);
        if (key !== presenterPrefs) {
          presenter.configure({ filter: prefs.pixelFilter, lineBrightness: prefs.lineBrightness, bandRows: prefs.bandRows, gridThickness: prefs.gridThickness, crtAmount: prefs.crtAmount, crtGlow: prefs.crtGlow, crtNoise: prefs.crtNoise });
          presenterPrefs = key;
        }
      }
      if (target.hidden) target.hidden = false;
      presenter.present(canvas);
    };
    // The frame handle and the previous timestamp belong to createLoop now.
    let miniWidth = 800;
    let miniHeight = 86;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr);
      // Fit the SECTOR, not the canvas. A vertical level occupies a VIEW_H-wide
      // band down the middle of a VIEW_W-wide canvas -- C-23's quarter turn puts
      // it there -- so fitting the whole canvas scales a picture that is half
      // empty and throws away half the screen. Worst in presentation, where the
      // screen is all there is, but the editor gains the same room.
      const framed = levelRef.current.mode === "vertical" ? VIEW_H : VIEW_W;
      const editing = modeRef.current === "build";
      const zoom = editing ? zoomRef.current : 1;
      const scale = Math.min(rect.width / framed, rect.height / VIEW_H) * zoom;
      // Centre the framed band rather than the canvas: the band starts at
      // (VIEW_W - framed) / 2, and that is the point that has to land on the
      // left edge of the fitted area. Horizontal frames the full width, where
      // the second term is zero and this is the arithmetic it always was.
      // The pan moves the view across the sector -- down the screen for a
      // horizontal sector, across it for a vertical one, which is the axis the
      // off-stage room lies along in either case.
      const pan = editing ? panRef.current : 0;
      const vertical = levelRef.current.mode === "vertical";
      const offsetX = (rect.width - framed * scale) / 2 - ((VIEW_W - framed) / 2) * scale + (vertical ? pan : 0);
      const offsetY = (rect.height - VIEW_H * scale) / 2 + (vertical ? 0 : pan);
      viewportRef.current = { scale, offsetX, offsetY };
      context.setTransform(scale * dpr, 0, 0, scale * dpr, offsetX * dpr, offsetY * dpr);
      const miniRect = mini.getBoundingClientRect();
      miniWidth = miniRect.width; miniHeight = miniRect.height;
      mini.width = Math.round(miniWidth * dpr); mini.height = Math.round(miniHeight * dpr);
      miniContext.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    resizeViewRef.current = resize;
    const observer = new ResizeObserver(resize); observer.observe(canvas); observer.observe(mini);

    // Poll once a frame, then read edges. The deadzone, the union of keyboard
    // and pad, and the previous-frame snapshot all belong to createInput now;
    // what is left here is what those edges *mean* to this editor.
    const pollInput = (): WorldInput => {
      const input = inputRef.current;
      if (!input) return idleInput();
      input.poll();

      if (input.connected && input.gamepadName !== controllerNameRef.current) {
        controllerNameRef.current = input.gamepadName;
        setControllerName(input.gamepadName);
      }

      if (input.pressed("padPause")) {
        if (modeRef.current === "playing") { setMode("paused"); modeRef.current = "paused"; }
        else if (modeRef.current === "paused") { setMode("playing"); modeRef.current = "playing"; }
        else if (modeRef.current === "build") enterPlay();
      }
      if (input.pressed("padAlt")) {
        if (modeRef.current === "build") enterPlay();
        else if (modeRef.current === "playing") equipInventoryWeapon();
      }
      if (input.pressed("padBack") && modeRef.current !== "build") exitPlay();

      const playMode = worldRef.current?.level.mode ?? levelRef.current.mode;
      const screenDx = input.axis("left", "right");
      const screenDy = input.axis("up", "down");
      const firing = input.isDown("fire") || mouseFireRef.current;
      const satAxis = { x: input.axis("satLeft", "satRight"), y: input.axis("satUp", "satDown") };
      const pointer = satellitePointerRef.current;

      if (playMode === "vertical") {
        // The world thinks in (along, across) whatever the mode; the screen
        // does not. Up is forward here, so the stick and the pointer both turn
        // a quarter turn on the way in -- the render pass turns them back.
        return {
          dx: -screenDy, dy: screenDx,
          fire: firing,
          aim: { x: 0, y: 0 },
          satelliteAxis: { x: -satAxis.y, y: satAxis.x },
          satellitePointer: { x: VIEW_H - pointer.y, y: pointer.x - (VIEW_W - VIEW_H) / 2, active: pointer.active },
        };
      }
      if (playMode === "arena") {
        // The right stick aims the guns, and the mouse aims them when the
        // stick is idle. The satellite rides the same side -- the recorded
        // trade for not burning a third control on it.
        const world = worldRef.current;
        let aim = { x: satAxis.x, y: satAxis.y };
        if (Math.hypot(aim.x, aim.y) < 0.25 && pointer.active && world) {
          aim = { x: pointer.x - world.state.player.x, y: pointer.y - world.state.player.y };
        }
        return { dx: screenDx, dy: screenDy, fire: firing, aim, satelliteAxis: satAxis, satellitePointer: pointer };
      }
      return {
        dx: screenDx, dy: screenDy,
        fire: firing,
        aim: { x: 0, y: 0 },
        satelliteAxis: satAxis,
        satellitePointer: pointer,
      };
    };

    const drawBackground = (cameraX: number, moving: boolean, dt: number) => {
      const gradient = context.createLinearGradient(0, 0, VIEW_W, VIEW_H);
      gradient.addColorStop(0, "#071019"); gradient.addColorStop(.56, "#091422"); gradient.addColorStop(1, "#111124");
      context.fillStyle = gradient; context.fillRect(0, 0, VIEW_W, VIEW_H);
      const nebula = context.createRadialGradient(VIEW_W * .72, VIEW_H * .42, 20, VIEW_W * .72, VIEW_H * .42, 410);
      nebula.addColorStop(0, "rgba(91,49,138,.2)"); nebula.addColorStop(1, "rgba(6,12,22,0)"); context.fillStyle = nebula; context.fillRect(0, 0, VIEW_W, VIEW_H);
      for (const star of starsRef.current) {
        if (moving) star.x -= 35 * star.speed * dt;
        if (star.x < -8) star.x = VIEW_W + 8;
        const x = moving ? star.x : ((star.x - cameraX * star.speed * .12) % (VIEW_W + 20) + VIEW_W + 20) % (VIEW_W + 20) - 10;
        context.fillStyle = `rgba(198,231,255,${star.alpha})`; context.fillRect(x, star.y, star.speed > .8 ? star.size * 3.2 : star.size, star.size);
      }
    };

    const drawEditor = (now: number) => {
      const current = levelRef.current;
      const cameraX = editorCameraRef.current;
      // The backdrop stays put, exactly as it does in play: it is the window,
      // not the sector seen through it.
      drawBackground(cameraX, false, 0);
      const vertical = current.mode === "vertical";
      context.save();
      if (vertical) applyVerticalView(context);
      /**
       * A label that survives the quarter turn. Rotating the stage rotates its
       * text with it, and a sideways ruler is unreadable, so each label
       * counter-rotates about its own anchor. A drop-in for `context.fillText`:
       * the save keeps whatever alignment the caller had already set.
       */
      const label = (text: string, x: number, y: number) => {
        context.save();
        context.translate(x, y);
        if (vertical) context.rotate(Math.PI / 2);
        context.fillText(text, 0, 0);
        context.restore();
      };
      // The room above and below the play band, tinted so it reads as
      // off-stage, with the band's edges ruled. Only visible once the view is
      // zoomed out enough to show any of it. In world space, so a vertical
      // sector shows it to either side, which is where its across axis lies.
      context.save();
      context.fillStyle = "rgba(100,227,255,.035)";
      context.fillRect(-VIEW_W, -PLACE_MARGIN, VIEW_W * 3, PLACE_MARGIN);
      context.fillRect(-VIEW_W, VIEW_H, VIEW_W * 3, PLACE_MARGIN);
      context.strokeStyle = "rgba(100,227,255,.35)"; context.lineWidth = 1; context.setLineDash([6, 6]);
      context.beginPath(); context.moveTo(-VIEW_W, 0); context.lineTo(VIEW_W * 2, 0); context.moveTo(-VIEW_W, VIEW_H); context.lineTo(VIEW_W * 2, VIEW_H); context.stroke();
      context.fillStyle = "rgba(100,227,255,.55)"; context.font = "10px monospace";
      label("OFF-STAGE — PLACE HERE TO ENTER FROM OUTSIDE THE PLAY BAND", 12, -PLACE_MARGIN + 16);
      label("OFF-STAGE — PLACE HERE TO ENTER FROM OUTSIDE THE PLAY BAND", 12, VIEW_H + PLACE_MARGIN - 8);
      context.restore();
      // The lean the game will draw on the item's first frame, so FACE
      // DIRECTION OF TRAVEL shows its effect without a playtest. One step of
      // the world's own path, differenced the way the world differences it --
      // so a turned path or an arc leans in the editor exactly as it will in
      // play, and there is no per-pattern derivative here to keep in step.
      const previewTilt = (item: LevelItem) => {
        const follow = item.heading?.follow ?? 0;
        if (!follow || item.movement.pattern === "stationary") return 0;
        const holds = item.type === "terrain";
        const from = movementPosition(item.movement, item.x, item.y, 0, { holds });
        const to = movementPosition(item.movement, item.x, item.y, 1 / 120, { holds });
        return travelTilt((to.x - from.x) * 120, (to.y - from.y) * 120, follow);
      };
      // A spinning sprite spins in the editor too, on the wall clock rather
      // than on a level clock it does not have -- the point is to see that it
      // turns and how fast, not where it will be at a given instant.
      const previewSpin = (item: LevelItem) => {
        const spin = item.movement.spin ?? 0;
        return spin ? ((now / 1000) * spin) % 360 : 0;
      };
      const drawPlacedItem = (item: LevelItem) => {
        const selectedItem = editorFor().selection.ids.includes(item.id);
        const offsets = groupOffsets(item.group, item.rotation, item.scale);
        offsets.forEach((offset, index) => {
          const screenX = item.x + offset.x - cameraX;
          if (screenX < -240 || screenX > VIEW_W + 240) return;
          const alpha = item.type === "decoration" ? item.decoration?.opacity ?? .5 : item.type === "group" ? .82 : 1;
          drawSprite(context, item.sprite, screenX, item.y + offset.y, item.size, selectedItem && index === 0, alpha, item.rotation + previewSpin(item) + previewTilt(item), item.scale, item.type === "enemy" || item.type === "group", current.assets, item.tint, { glow: item.glow, depth: item.depth });
        });
        if (item.type === "group" && item.x - cameraX > -100 && item.x - cameraX < VIEW_W + 100) {
          context.fillStyle = "#eaff62"; context.font = "10px monospace"; label(`GROUP x${item.group?.count ?? 1}`, item.x - cameraX - 28, item.y - item.size * item.scale - 22);
        }
        if ((item.type === "powerup" || item.type === "upgrade") && item.x - cameraX > -100 && item.x - cameraX < VIEW_W + 100) {
          context.fillStyle = item.type === "powerup" ? "#eaff62" : "#64e3ff"; context.font = "9px monospace"; label(item.type.toUpperCase(), item.x - cameraX - 22, item.y - item.size * item.scale - 15);
        }
      };
      current.items.filter((item) => item.type === "decoration" && item.decoration?.layer === "background").forEach(drawPlacedItem);
      context.lineWidth = 1;
      context.strokeStyle = "rgba(126,174,194,.08)";
      for (let y = 80; y < VIEW_H; y += 80) { context.beginPath(); context.moveTo(0, y); context.lineTo(VIEW_W, y); context.stroke(); }
      const first = Math.floor(cameraX / 250) * 250;
      for (let worldX = first; worldX <= cameraX + VIEW_W; worldX += 250) {
        const x = worldX - cameraX;
        context.strokeStyle = worldX % 1000 === 0 ? "rgba(234,255,98,.18)" : "rgba(126,174,194,.09)";
        context.beginPath(); context.moveTo(x, 0); context.lineTo(x, VIEW_H); context.stroke();
        context.fillStyle = worldX % 1000 === 0 ? "rgba(234,255,98,.7)" : "rgba(126,174,194,.45)";
        context.font = "11px monospace"; label(worldX.toString().padStart(5, "0"), x + 7, 20);
      }
      const selected = current.items.find((item) => item.id === editorFor().selection.primary);
      if (selected && selected.movement.pattern !== "stationary") {
        // The path play will fly, from the world's own function -- turned path
        // and arc included -- rather than a second copy of the formulas kept in
        // step by hand (which F-05 noted had already drifted to Math.sin). Drawn
        // both ways from the origin: behind it is where the thing came from.
        context.save(); context.translate(-cameraX, 0); context.strokeStyle = "rgba(100,227,255,.45)"; context.lineWidth = 2; context.setLineDash([5, 7]); context.beginPath();
        const speed = Math.max(1, selected.movement.speed);
        const bezier = selected.movement.pattern === "bezier";
        // A bezier is drawn whole plus a little of the straight flight after
        // it; every other path shows a fixed stretch either side of the object.
        const ahead = (bezier ? movementPathLength(selected.movement) + 160 : 260) / speed;
        const behind = (bezier ? 60 : 260) / speed;
        for (let i = -40; i <= 40; i += 1) {
          const spot = movementPosition(selected.movement, selected.x, selected.y, (i / 40) * (i < 0 ? behind : ahead), { holds: selected.type === "terrain" });
          if (i === -40) context.moveTo(spot.x, spot.y); else context.lineTo(spot.x, spot.y);
        }
        context.stroke(); context.restore();
      }
      current.items.filter((item) => item.type !== "decoration").forEach(drawPlacedItem);
      current.items.filter((item) => item.type === "decoration" && item.decoration?.layer === "foreground").forEach(drawPlacedItem);
      // The sprite being placed rides under the pointer at 60%: what the click
      // will put down is the pointer, and the native arrow is hidden meanwhile.
      // A saved component's object is looked up each frame, so editing the
      // component changes the ghost; a palette item is built once per tool.
      const hover = hoverRef.current; const placingTool = toolRef.current;
      if (hover && placingTool !== "select" && placingTool !== "scroll" && placingTool !== "erase") {
        let ghost: LevelItem | null;
        if (placingTool.startsWith("component:")) ghost = current.components.find((entry) => entry.id === placingTool.slice("component:".length))?.object ?? null;
        else {
          if (ghostRef.current.tool !== placingTool) ghostRef.current = { tool: placingTool, item: makeItem(placingTool as PaletteKey, 0, 0, () => "ghost") };
          ghost = ghostRef.current.item;
        }
        if (ghost) {
          const shape = ghost;
          groupOffsets(shape.group, shape.rotation, shape.scale).forEach((offset) => {
            drawSprite(context, shape.sprite, hover.x + offset.x, hover.y + offset.y, shape.size, false, .6, shape.rotation + previewSpin(shape), shape.scale, shape.type === "enemy" || shape.type === "group", current.assets, shape.tint, { glow: shape.glow, depth: shape.depth });
          });
        }
      }
      const selectedItems = current.items.filter((item) => editorFor().selection.ids.includes(item.id)); const geometry = selectionGeometry(selectedItems);
      if (geometry) {
        const left = geometry.left - cameraX; const right = geometry.right - cameraX; const top = geometry.top; const bottom = geometry.bottom; const centerX = geometry.center.x - cameraX;
        context.save(); context.shadowBlur = 0; context.setLineDash([6, 5]); context.strokeStyle = "rgba(234,255,98,.78)"; context.lineWidth = 2; context.strokeRect(left, top, right - left, bottom - top); context.setLineDash([]);
        context.beginPath(); context.moveTo(centerX, top); context.lineTo(centerX, top - 30); context.stroke();
        context.fillStyle = "#09131b"; context.strokeStyle = "#eaff62"; context.lineWidth = 3; context.beginPath(); context.arc(centerX, top - 34, 9, 0, Math.PI * 2); context.fill(); context.stroke();
        context.fillStyle = "#eaff62"; context.strokeStyle = "#09131b"; context.lineWidth = 2; context.fillRect(right - 9, bottom - 9, 18, 18); context.strokeRect(right - 9, bottom - 9, 18, 18);
        context.fillStyle = "#eaff62"; context.font = "bold 10px monospace"; label(selectedItems.length > 1 ? `${selectedItems.length} SELECTED` : "ROTATE / SCALE", left, Math.max(14, top - 13)); context.restore();
      }
      // A bezier's control points ARE its shape, so a selected one shows them:
      // the polygon from the object through P1 and P2 to P3, and a handle on
      // each -- in the preview's cyan, so they read as the path's own and not
      // as the yellow rotate/scale pair. Drawn in world space inside the
      // vertical view, so they turn with the sector like everything else.
      if (selected && selected.movement.pattern === "bezier") {
        const handles = bezierControlWorld(selected).map((point) => ({ x: point.x - cameraX, y: point.y }));
        context.save(); context.shadowBlur = 0; context.lineWidth = 1.5; context.strokeStyle = "rgba(100,227,255,.55)"; context.setLineDash([3, 4]);
        context.beginPath(); context.moveTo(selected.x - cameraX, selected.y); handles.forEach((point) => context.lineTo(point.x, point.y)); context.stroke(); context.setLineDash([]);
        handles.forEach((point, index) => {
          context.fillStyle = index === 2 ? "#64e3ff" : "#09131b"; context.strokeStyle = "#64e3ff"; context.lineWidth = 2;
          context.beginPath(); context.arc(point.x, point.y, 7, 0, Math.PI * 2); context.fill(); context.stroke();
        });
        context.fillStyle = "#64e3ff"; context.font = "bold 9px monospace"; label("DRAG TO SHAPE", handles[2].x + 12, handles[2].y + 4);
        context.restore();
      }
      // Where the guns are: a small sight on each muzzle while its ship is
      // selected, computed by the same rule the engine fires by. An enemy shows
      // one; the player shows one per weapon slot.
      const drawMuzzle = (x: number, y: number) => {
        context.save(); context.shadowBlur = 0; context.strokeStyle = "#eaff62"; context.lineWidth = 1.5;
        context.beginPath(); context.arc(x, y, 6, 0, Math.PI * 2); context.stroke();
        context.beginPath(); context.moveTo(x - 10, y); context.lineTo(x + 10, y); context.moveTo(x, y - 10); context.lineTo(x, y + 10); context.stroke();
        context.restore();
      };
      if (selected && (selected.type === "enemy" || selected.type === "group") && selected.weapon.enabled) {
        const muzzle = enemyMuzzleWorld(selected);
        drawMuzzle(muzzle.x - cameraX, muzzle.y);
      }
      if (inspectPlayerRef.current) {
        current.player.weaponSlots.forEach((slot, index) => {
          const offset = slotMuzzleOffset(slot, index, current.player.weaponSlots.length);
          drawMuzzle(95 + offset.x, VIEW_H / 2 + offset.y);
        });
      }
      const endX = current.length - cameraX;
      if (endX >= -24 && endX <= VIEW_W + 24) {
        context.strokeStyle = "#ff6a4d"; context.lineWidth = 2; context.setLineDash([8, 6]);
        context.beginPath(); context.moveTo(endX, 0); context.lineTo(endX, VIEW_H); context.stroke(); context.setLineDash([]);
        context.fillStyle = "#ff8a74"; context.fillRect(endX - 7, 0, 14, 28); context.font = "bold 11px monospace"; label("DRAG END LEVEL", endX - 105, 47);
      }
      if (current.items.length === 0) {
        context.fillStyle = "rgba(201,222,230,.38)"; context.font = "14px monospace"; context.textAlign = "center";
        label("SELECT AN OBJECT FROM THE PALETTE, THEN PLACE IT HERE", VIEW_W / 2, VIEW_H / 2); context.textAlign = "start";
      }
      drawShip(context, 95, VIEW_H / 2, now, current.player.sprite, false, current.assets, current.player.tint, { scale: current.player.scale, glow: current.player.glow });
      // Selected the same way an object is, because it is now selected the same
      // way. The ring is drawn at the collision radius, so what reads as picked
      // is exactly what the click tested.
      if (inspectPlayerRef.current) {
        context.save();
        context.strokeStyle = "rgba(234,255,98,.85)"; context.lineWidth = 2; context.setLineDash([5, 5]);
        context.beginPath(); context.arc(95, VIEW_H / 2, playerRadius(current.player, current.assets) + 9, 0, Math.PI * 2); context.stroke();
        context.restore();
      }
      context.restore();
    };

    // Everything the simulation used to do inline is now one call. What is left
    // here is the part that was never simulation: pushing a handful of numbers
    // into React so the HUD can render them, throttled because the HUD does not
    // need 120 updates a second.
    let hudAt = -1;
    const syncHud = (force = false) => {
      const world = worldRef.current;
      if (!world) return;
      const state = world.state;
      const tick = Math.floor(state.elapsed * 6);
      if (!force && tick === hudAt) return;
      hudAt = tick;
      setScore(state.score);
      setLives(state.hull);
      setShield(Math.round(state.player.shield));
      setProgress(state.progress);
    };

    const updatePlay = (dt: number, input: WorldInput) => {
      const world = worldRef.current;
      if (!world || modeRef.current !== "playing") return;
      world.step(dt, input);
      // Events before bursts: an authored explosion replaces the generic one
      // the same death queued, and the only way to know is to have seen it.
      const authored = playEvents(world.drainEvents());
      spawnBursts(world.drainBursts(), authored);

      // `advanceBurst` reports false once a burst has finished showing, so the
      // module owns when one is over rather than this loop re-deriving it.
      const live = burstsRef.current;
      for (let index = live.length - 1; index >= 0; index -= 1) {
        if (!advanceBurst(live[index], dt)) live.splice(index, 1);
      }

      const outcome = world.state.outcome;
      if (outcome) {
        syncHud(true);
        setMode(outcome); modeRef.current = outcome;
        return;
      }
      syncHud();
    };

    const drawPlay = (now: number, dt: number) => {
      const world = worldRef.current;
      if (!world) return;
      const runtime = world.state;
      const playMode = world.level.mode;
      // The arena's camera is a clock and shifts nothing; drawing still
      // subtracts a camera everywhere, so the arena subtracts zero.
      const renderCam = playMode === "arena" ? 0 : runtime.camera;
      const verticalPlay = playMode === "vertical";
      // Nothing outside the sector is shown while playing. An enemy wakes 260
      // units off the right edge, and on a stage wider than the sector it was
      // drawn into the letterbox before it had crossed onto the backdrop -- the
      // player saw it coming. The clip is set once, under the base transform,
      // and holds through the vertical quarter turn below, so a vertical sector
      // shows only its band. The editor never clips: the off-stage room exists
      // to be seen there, and to be invisible here.
      context.save();
      context.beginPath();
      if (verticalPlay) context.rect((VIEW_W - VIEW_H) / 2, 0, VIEW_H, VIEW_H); else context.rect(0, 0, VIEW_W, VIEW_H);
      context.clip();
      drawBackground(renderCam, modeRef.current === "playing", dt);
      // Vertical is drawn through a quarter turn: the whole scene renders in
      // (along, across) exactly as the scroll modes do, and this transform is
      // the only place the screen finds out. Later content enters from the
      // top, the ship sits low, and every sprite's rightward art faces up.
      if (verticalPlay) { context.save(); context.translate((VIEW_W - VIEW_H) / 2, VIEW_H); context.rotate(-Math.PI / 2); }
      const drawRuntimeItem = (enemy: RuntimeEnemy) => {
        if (!enemy.alive || !enemy.active) return;
        const parallax = playMode !== "arena" && enemy.type === "decoration" ? enemy.decoration?.parallax ?? 1 : 1;
        const x = enemy.x - renderCam * parallax;
        if (x < -260 || x > VIEW_W + 260) return;
        drawSprite(context, enemy.sprite, x, enemy.y, enemy.size, false, enemy.type === "decoration" ? enemy.decoration?.opacity ?? .5 : 1, enemy.rotation + (enemy.turned ?? 0) + travelTilt(enemy.vx, enemy.vy, enemy.heading?.follow ?? 0), enemy.scale, enemy.type === "enemy", levelRef.current.assets, enemy.tint, { glow: enemy.glow, depth: enemy.depth });
        if (enemy.shield > 0 && enemy.armor?.type === "forcefield") { context.strokeStyle = "rgba(100,227,255,.7)"; context.lineWidth = 2; context.beginPath(); context.arc(x, enemy.y, enemy.size * enemy.scale + 8, 0, Math.PI * 2); context.stroke(); }
      };
      runtime.enemies.filter((item) => item.type === "decoration" && item.decoration?.layer === "background").forEach(drawRuntimeItem);
      for (const bullet of runtime.bullets) {
        const x = bullet.x - renderCam; context.shadowColor = bullet.color; context.shadowBlur = 15; context.fillStyle = bullet.color;
        // A streak drawn along +x only reads as motion when bullets fly +x;
        // aimed arena fire goes everywhere, so it gets round shots instead.
        if (playMode === "arena") { context.beginPath(); context.arc(x, bullet.y, bullet.radius + 1, 0, Math.PI * 2); context.fill(); }
        else context.fillRect(x - 15, bullet.y - 2, 20, 4);
      }
      context.shadowBlur = 0;
      for (const bullet of runtime.enemyBullets) {
        const x = bullet.x - renderCam; context.shadowColor = bullet.color; context.shadowBlur = 14; context.fillStyle = bullet.color;
        context.beginPath(); context.arc(x, bullet.y, bullet.radius, 0, Math.PI * 2); context.fill();
      }
      context.shadowBlur = 0;
      runtime.enemies.filter((item) => item.type !== "decoration").forEach(drawRuntimeItem);
      // A burst's frame carries absolute world coordinates, so the camera is a
      // translate here rather than a subtraction threaded through the module.
      if (burstsRef.current.length) {
        const grid = explosionsRef.current.pixelGrid;
        context.save(); context.translate(-renderCam, 0);
        for (const runtime of burstsRef.current) {
          drawBurst(context, burstFrame(runtime), grid > 0 ? { pixelGrid: grid, palette: runtime.burst.palette } : {});
        }
        context.restore();
      }
      context.globalAlpha = 1;
      runtime.enemies.filter((item) => item.type === "decoration" && item.decoration?.layer === "foreground").forEach(drawRuntimeItem);
      const player = runtime.player;
      const satelliteSettings = levelRef.current.player.satellite; const satellite = player.satellite;
      if (satelliteSettings.enabled && satellite.alive) {
        context.strokeStyle = "rgba(100,227,255,.22)"; context.lineWidth = 1; context.setLineDash([5, 7]); context.beginPath(); context.moveTo(player.x, player.y); context.lineTo(satellite.x, satellite.y); context.stroke(); context.setLineDash([]);
        context.save(); context.translate(satellite.x, satellite.y); context.rotate(Math.atan2(satellite.y - player.y, satellite.x - player.x)); context.shadowColor = "#64e3ff"; context.shadowBlur = 14; context.fillStyle = "#c8f5ff"; context.strokeStyle = "#64e3ff"; context.lineWidth = 2; context.beginPath(); context.moveTo(18, 0); context.lineTo(-9, -11); context.lineTo(-4, 0); context.lineTo(-9, 11); context.closePath(); context.fill(); context.stroke(); context.restore();
        if (satellite.shield > 0 && satelliteSettings.armor.type === "forcefield") { context.strokeStyle = "rgba(100,227,255,.65)"; context.beginPath(); context.arc(satellite.x, satellite.y, 21, 0, Math.PI * 2); context.stroke(); }
      }
      if (player.shield > 0 && levelRef.current.player.armor.type === "forcefield") { context.strokeStyle = "rgba(100,227,255,.55)"; context.lineWidth = 2; context.beginPath(); context.arc(player.x, player.y, 34, 0, Math.PI * 2); context.stroke(); }
      const blinking = player.invulnerable > 0 && Math.floor(player.invulnerable * 10) % 2 === 0;
      if (playMode === "arena") {
        context.save(); context.translate(player.x, player.y); context.rotate(Math.atan2(runtime.aimDir.y, runtime.aimDir.x));
        drawShip(context, 0, 0, now, levelRef.current.player.sprite, blinking, levelRef.current.assets, levelRef.current.player.tint, { scale: levelRef.current.player.scale, glow: levelRef.current.player.glow });
        context.restore();
      } else {
        drawShip(context, player.x, player.y, now, levelRef.current.player.sprite, blinking, levelRef.current.assets, levelRef.current.player.tint, { scale: levelRef.current.player.scale, glow: levelRef.current.player.glow });
      }
      if (verticalPlay) {
        context.restore();
        // The flanks are rails, and opaque ones: they also mask the sliver of
        // world that leaks past the square on the way in.
        const rail = (VIEW_W - VIEW_H) / 2;
        context.fillStyle = "rgba(6, 10, 14, .92)";
        context.fillRect(0, 0, rail, VIEW_H); context.fillRect(VIEW_W - rail, 0, rail, VIEW_H);
        context.strokeStyle = "rgba(100, 227, 255, .25)"; context.lineWidth = 1;
        context.beginPath(); context.moveTo(rail + .5, 0); context.lineTo(rail + .5, VIEW_H); context.stroke();
        context.beginPath(); context.moveTo(VIEW_W - rail - .5, 0); context.lineTo(VIEW_W - rail - .5, VIEW_H); context.stroke();
      }
      // The sector clip ends here: the readouts below are chrome, drawn in the
      // window's own frame, and a vertical sector keeps its weapon line in the
      // margin beside the band.
      context.restore();
      const settings = world.effectivePlayer();
      context.font = "10px monospace"; context.textAlign = "right"; context.fillStyle = "rgba(234,247,251,.62)";
      const activeWeapons = settings.weaponSlots.map((slot) => levelRef.current.components.find((component) => component.id === (runtime.slotWeapons[slot.id] ?? slot.weaponId))?.name ?? "EMPTY").join(" + ");
      context.fillText(`${activeWeapons.toUpperCase()} // POWER ${settings.shotPower}`, VIEW_W - 18, VIEW_H - 19);
      if (runtime.activePickups.length) {
        context.fillStyle = "#eaff62";
        context.fillText(runtime.activePickups.map((pickup) => `${pickup.name.toUpperCase()} ${Math.max(0, pickup.expires - runtime.elapsed).toFixed(1)}s`).join("  //  "), VIEW_W - 18, VIEW_H - 37);
      }
      context.textAlign = "start";
    };

    const drawMini = () => {
      const current = levelRef.current;
      const activeMode = modeRef.current;
      const cameraX = activeMode === "build" ? editorCameraRef.current : worldRef.current?.state.camera ?? 0;
      miniContext.clearRect(0, 0, miniWidth, miniHeight);
      const miniGradient = miniContext.createLinearGradient(0, 0, miniWidth, 0); miniGradient.addColorStop(0, "#09131c"); miniGradient.addColorStop(1, "#111020"); miniContext.fillStyle = miniGradient; miniContext.fillRect(0, 0, miniWidth, miniHeight);
      miniContext.strokeStyle = "rgba(126,174,194,.12)";
      for (let i = 1; i < 10; i += 1) { const x = miniWidth * i / 10; miniContext.beginPath(); miniContext.moveTo(x, 0); miniContext.lineTo(x, miniHeight); miniContext.stroke(); }
      for (const item of current.items) {
        const x = item.x / current.length * miniWidth; const y = clamp(item.y, 0, VIEW_H) / VIEW_H * miniHeight;
        miniContext.fillStyle = item.type === "terrain" ? "#72838b" : item.type === "group" ? "#eaff62" : item.type === "powerup" ? "#eaff62" : item.type === "upgrade" ? "#64e3ff" : item.type === "decoration" ? "#744f93" : "#ff6a4d";
        const size = item.type === "group" ? 4 : 3; miniContext.fillRect(x - size / 2, y - size / 2, size, size);
      }
      const bracketW = Math.max(14, Math.min(miniWidth, VIEW_W / current.length * miniWidth));
      const bracketTravel = Math.max(1, miniWidth - bracketW);
      const bracketX = clamp(cameraX / Math.max(1, current.length - VIEW_W) * bracketTravel, 0, bracketTravel);
      miniContext.fillStyle = "rgba(100,227,255,.07)"; miniContext.fillRect(bracketX, 0, bracketW, miniHeight);
      miniContext.strokeStyle = activeMode === "build" ? "#64e3ff" : "#eaff62"; miniContext.lineWidth = 2; miniContext.strokeRect(bracketX + 1, 1, Math.max(2, bracketW - 2), miniHeight - 2);
      const corner = Math.min(10, bracketW / 3); miniContext.lineWidth = 3;
      [[bracketX, 0, 1, 1], [bracketX + bracketW, 0, -1, 1], [bracketX, miniHeight, 1, -1], [bracketX + bracketW, miniHeight, -1, -1]].forEach(([x, y, sx, sy]) => {
        miniContext.beginPath(); miniContext.moveTo(x, y + sy * corner); miniContext.lineTo(x, y); miniContext.lineTo(x + sx * corner, y); miniContext.stroke();
      });
    };

    // A fixed step, which the previous comment here said was what replays and
    // any input-synchronised multiplayer would need. Both are now in reach, so
    // this stopped being a variable-delta loop with a 34 ms clamp.
    //
    // The input is polled once per *frame* rather than once per step: a pad has
    // one state per frame however many steps the accumulator owes, and polling
    // it inside the step would read the same values two or three times over and
    // report a fresh press on each of them.
    // A debug handle for development only: playtests in this session are
    // driven from the browser console, and asserting on real world state beats
    // guessing from pixels. Stripped from production builds by the env check.
    if (process.env.NODE_ENV !== "production") {
      (window as unknown as { __starlineWorld?: () => World | null }).__starlineWorld = () => worldRef.current;
      // And a manual pump: the pane this session verifies in does not
      // composite, so rAF never fires there. Pumping runs the real
      // pollInput -> updatePlay -> drawPlay chain one step at a time, which
      // is the whole integration short of the scheduler itself.
      (window as unknown as { __starlinePump?: (dt: number) => WorldInput }).__starlinePump = (dt: number) => {
        const pumped = pollInput();
        updatePlay(dt, pumped);
        drawPlay(performance.now(), dt);
        return pumped;
      };
    }
    let frameInput = idleInput();
    const loop = createLoop({
      fixedStep: SIM_STEP,
      report: telemetryRef.current,
      update: (dt) => {
        updatePlay(dt, frameInput);
      },
      render: (dt, _alpha, loopContext) => {
        const now = loopContext.timestamp;
        perfRef.current.frame(now);
        context.save();
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.fillStyle = "#03070b";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.restore();
        context.clearRect(0, 0, VIEW_W, VIEW_H);
        if (modeRef.current === "build") drawEditor(now); else drawPlay(now, dt);
        presentFrame();
        drawMini();
        // Last thing in the frame, so the steps the next frame runs all see the
        // input as it was when that frame began.
        frameInput = pollInput();
      },
    });
    loop.start();
    return () => { presenter?.destroy(); presenter = null; loop.stop(); observer.disconnect(); };
  }, [editorFor, enterPlay, equipInventoryWeapon, exitPlay, playEvents, spawnBursts]);

  const canvasPoint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const viewport = viewportRef.current;
    const x = (event.clientX - rect.left - viewport.offsetX) / viewport.scale;
    const y = (event.clientY - rect.top - viewport.offsetY) / viewport.scale;
    // Undo the view before clamping, so a vertical sector is clamped in the
    // space the level is actually authored in rather than in screen space.
    const point = levelRef.current.mode === "vertical" ? unapplyVerticalView(x, y) : { x, y };
    return { x: clamp(point.x, 0, VIEW_W), y: clamp(point.y, -PLACE_MARGIN, VIEW_H + PLACE_MARGIN) };
  };

  /**
   * Whether a click landed on the player ship.
   *
   * Against the SCREEN point, not the world one: the ship holds a fixed place
   * while the sector scrolls past it, so it has no world position to test. And
   * `playerRadius` is the engine's own collision radius, so the ship you can
   * click is exactly the ship that gets shot.
   */
  const hitsPlayer = (screen: Point) => {
    const radius = playerRadius(levelRef.current.player, levelRef.current.assets);
    const dx = screen.x - 95;
    const dy = screen.y - VIEW_H / 2;
    return dx * dx + dy * dy < radius * radius;
  };

  /**
   * What a click lands on. Two passes: everything the player interacts with
   * first, then decorations -- so a nebula placed over a ship, with a hit
   * radius as wide as it is, never takes the click meant for the ship. Within
   * a pass the later-placed item still wins, as it always did.
   */
  const findItem = (world: Point) => {
    const items = levelRef.current.items;
    for (const decorations of [false, true]) {
      for (let i = items.length - 1; i >= 0; i -= 1) {
        const item = items[i];
        if ((item.type === "decoration") !== decorations) continue;
        const radius = item.size * item.scale + 24;
        const hit = groupOffsets(item.group, item.rotation, item.scale).some((offset) => {
          const x = world.x - item.x - offset.x; const y = world.y - item.y - offset.y;
          return x * x + y * y < radius ** 2;
        });
        if (hit) return item;
      }
    }
    return null;
  };

  const onCanvasDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (modeRef.current !== "build") { event.currentTarget.setPointerCapture(event.pointerId); const point = canvasPoint(event); satellitePointerRef.current = { x: point.x, y: point.y, active: true }; mouseFireRef.current = true; return; }
    event.currentTarget.setPointerCapture(event.pointerId);
    const screen = canvasPoint(event); const world = { x: screen.x + editorCameraRef.current, y: screen.y };
    const currentTool = toolRef.current;
    if (Math.abs(world.x - levelRef.current.length) <= 18) { dragRef.current = { kind: "end", startSnapshot: JSON.stringify(levelRef.current) }; return; }
    if (currentTool === "scroll") { dragRef.current = { kind: "scroll", startX: screen.x, startCamera: editorCameraRef.current }; return; }
    if (currentTool === "select" && editorFor().selection.ids.length) {
      // A bezier's handles are tested first: they sit inside the selection
      // box, where the rotate and scale grips would otherwise claim the click.
      const primary = levelRef.current.items.find((item) => item.id === editorFor().selection.primary);
      if (primary && primary.movement.pattern === "bezier") {
        const index = bezierControlWorld(primary).findIndex((point) => Math.hypot(world.x - point.x, world.y - point.y) <= 12);
        if (index >= 0) { dragRef.current = { kind: "bezier", id: primary.id, index, startSnapshot: JSON.stringify(levelRef.current) }; return; }
      }
      const selectedItems = levelRef.current.items.filter((item) => editorFor().selection.ids.includes(item.id)); const geometry = selectionGeometry(selectedItems);
      if (geometry) {
        const origins = selectedItems.map((item) => ({ id: item.id, x: item.x, y: item.y, rotation: item.rotation, scale: item.scale }));
        const rotateDistance = Math.hypot(world.x - geometry.center.x, world.y - (geometry.top - 34)); const scaleDistance = Math.hypot(world.x - geometry.right, world.y - geometry.bottom);
        if (rotateDistance <= 18 || scaleDistance <= 22) {
          dragRef.current = { kind: "transform", mode: rotateDistance <= 18 ? "rotate" : "scale", ids: editorFor().selection.ids.slice(), center: geometry.center, startAngle: Math.atan2(world.y - geometry.center.y, world.x - geometry.center.x), startDistance: Math.max(1, Math.hypot(world.x - geometry.center.x, world.y - geometry.center.y)), origins, startSnapshot: JSON.stringify(levelRef.current) }; return;
        }
      }
    }
    // The ship is selected by clicking it, like everything else in the level.
    // It is not a LevelItem -- it has no id and never enters `items` -- so the
    // Inspector is switched over directly rather than through the selection.
    if (currentTool === "select" && hitsPlayer(screen)) {
      setSelection([]);
      setInspectPlayer(true);
      return;
    }
    const hit = findItem(world);
    if (currentTool === "erase") {
      if (hit) { updateLevel((current) => ({ ...current, items: current.items.filter((item) => item.id !== hit.id) })); if (editorFor().selection.ids.includes(hit.id)) setSelection(editorFor().selection.ids.filter((id) => id !== hit.id)); flash("OBJECT REMOVED"); }
      return;
    }
    if (currentTool === "select") {
      if (!hit) { if (!event.ctrlKey && !event.metaKey && !event.shiftKey) setSelection([]); return; }
      let ids = editorFor().selection.ids.slice();
      if (event.ctrlKey || event.metaKey) ids = ids.includes(hit.id) ? ids.filter((id) => id !== hit.id) : [...ids, hit.id];
      else if (event.shiftKey) { if (!ids.includes(hit.id)) ids.push(hit.id); }
      else if (!ids.includes(hit.id)) ids = [hit.id];
      if (!ids.includes(hit.id)) { setSelection(ids); return; }
      setSelection(ids, hit.id);
      const origins = levelRef.current.items.filter((item) => ids.includes(item.id)).map((item) => ({ id: item.id, x: item.x, y: item.y, rotation: item.rotation, scale: item.scale }));
      dragRef.current = { kind: "items", ids, startWorld: world, origins, startSnapshot: JSON.stringify(levelRef.current) };
      return;
    }
    let item: LevelItem;
    if (currentTool.startsWith("component:")) {
      const component = levelRef.current.components.find((entry) => entry.id === currentTool.slice("component:".length)); if (!component?.object) return;
      item = structuredClone(component.object); item.id = uid(); item.componentId = component.id; item.x = clamp(world.x, 0, levelRef.current.length); item.y = clamp(world.y, 35, VIEW_H - 35);
    } else item = makeItem(currentTool as PaletteKey, clamp(world.x, 0, levelRef.current.length), clamp(world.y, 35, VIEW_H - 35));
    updateLevel((current) => ({ ...current, items: [...current.items, item] })); setSelection([item.id], item.id); flash(`${item.name.toUpperCase()} PLACED`);
  };

  const onCanvasMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const screen = canvasPoint(event);
    if (modeRef.current !== "build") { satellitePointerRef.current = { x: screen.x, y: screen.y, active: true }; return; }
    hoverRef.current = screen;
    if (!event.currentTarget.hasPointerCapture(event.pointerId) || !dragRef.current) return;
    const drag = dragRef.current;
    if (drag.kind === "scroll") {
      setCameraSafe(drag.startCamera - (screen.x - drag.startX));
    } else if (drag.kind === "end") {
      const farthestItem = levelRef.current.items.reduce((max, item) => {
        const farthestOffset = groupOffsets(item.group, item.rotation, item.scale).reduce((right, offset) => Math.max(right, offset.x), 0);
        return Math.max(max, item.x + farthestOffset + item.size * item.scale + 80);
      }, 1600);
      const nextLength = Math.max(farthestItem, Math.round((screen.x + editorCameraRef.current) / 50) * 50);
      updateLevel((current) => ({ ...current, length: nextLength }), false);
      const safeCamera = Math.min(editorCameraRef.current, Math.max(0, nextLength - VIEW_W));
      if (safeCamera !== editorCameraRef.current) { editorCameraRef.current = safeCamera; setCamera(safeCamera); }
    } else if (drag.kind === "items") {
      const world = { x: screen.x + editorCameraRef.current, y: screen.y }; const dx = world.x - drag.startWorld.x; const dy = world.y - drag.startWorld.y;
      updateLevel((current) => ({ ...current, items: current.items.map((item) => { const origin = drag.origins.find((entry) => entry.id === item.id); return origin ? { ...item, x: Math.round(clamp(origin.x + dx, 0, current.length)), y: Math.round(clamp(origin.y + dy, -PLACE_MARGIN, VIEW_H + PLACE_MARGIN)) } : item; }) }), false);
    } else if (drag.kind === "bezier") {
      // The handle follows the pointer; the point stored is that position
      // brought back into the path's own frame, so it stays put when PATH
      // ANGLE is changed afterwards.
      const world = { x: screen.x + editorCameraRef.current, y: screen.y };
      updateLevel((current) => ({ ...current, items: current.items.map((item) => {
        if (item.id !== drag.id) return item;
        const local = bezierControlLocal(item, world);
        return { ...item, movement: { ...item.movement, points: (item.movement.points ?? defaultBezierPoints()).map((point, index) => (index === drag.index ? local : point)) as LevelItem["movement"]["points"] } };
      }) }), false);
    } else if (drag.kind === "transform") {
      const world = { x: screen.x + editorCameraRef.current, y: screen.y }; const angle = Math.atan2(world.y - drag.center.y, world.x - drag.center.x); let angleDelta = (angle - drag.startAngle) * 180 / Math.PI;
      if (event.shiftKey) angleDelta = Math.round(angleDelta / 15) * 15;
      const ratio = clamp(Math.hypot(world.x - drag.center.x, world.y - drag.center.y) / drag.startDistance, .2, 5);
      updateLevel((current) => ({ ...current, items: current.items.map((item) => {
        const origin = drag.origins.find((entry) => entry.id === item.id); if (!origin) return item;
        if (drag.mode === "rotate") { const radians = angleDelta * Math.PI / 180; const ox = origin.x - drag.center.x; const oy = origin.y - drag.center.y; return { ...item, x: drag.center.x + ox * Math.cos(radians) - oy * Math.sin(radians), y: drag.center.y + ox * Math.sin(radians) + oy * Math.cos(radians), rotation: origin.rotation + angleDelta }; }
        return { ...item, x: drag.center.x + (origin.x - drag.center.x) * ratio, y: drag.center.y + (origin.y - drag.center.y) * ratio, scale: clamp(origin.scale * ratio, .25, 4) };
      }) }), false);
    }
  };

  const finishCanvasDrag = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (modeRef.current !== "build") { mouseFireRef.current = false; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); return; }
    const drag = dragRef.current;
    if (drag && "startSnapshot" in drag && drag.startSnapshot !== JSON.stringify(levelRef.current)) commitSnapshot(levelRef.current);
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const onMiniDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (modeRef.current !== "build") return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = event.currentTarget.getBoundingClientRect();
    const pixel = event.clientX - rect.left;
    const bracketW = Math.max(14, Math.min(rect.width, VIEW_W / levelRef.current.length * rect.width));
    const bracketTravel = Math.max(1, rect.width - bracketW);
    const bracketX = editorCameraRef.current / Math.max(1, levelRef.current.length - VIEW_W) * bracketTravel;
    const inside = pixel >= bracketX - 8 && pixel <= bracketX + bracketW + 8;
    miniDragRef.current = { offset: inside ? pixel - bracketX : bracketW / 2 };
    const next = clamp((pixel - miniDragRef.current.offset) / bracketTravel * Math.max(0, levelRef.current.length - VIEW_W), 0, Math.max(0, levelRef.current.length - VIEW_W));
    setCamera(next); editorCameraRef.current = next;
  };

  const onMiniMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!miniDragRef.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const pixel = event.clientX - rect.left;
    const bracketW = Math.max(14, Math.min(rect.width, VIEW_W / levelRef.current.length * rect.width));
    const bracketTravel = Math.max(1, rect.width - bracketW);
    const next = clamp((pixel - miniDragRef.current.offset) / bracketTravel * Math.max(0, levelRef.current.length - VIEW_W), 0, Math.max(0, levelRef.current.length - VIEW_W));
    setCamera(next); editorCameraRef.current = next;
  };

  const selected = level.items.find((item) => item.id === selectedId) ?? null;
  // The split between the two tabs, and the only place that decides it.
  //
  // COMPONENTS is a thing you place or equip: the six object kinds, plus the
  // three that bolt onto one. ASSETS is material you author in an editor and
  // then point something at -- a pattern, an explosion, a sound, a sprite. The
  // question each answers is different: "what goes in the level" against "what
  // is it made of".
  const componentCategories = ["ENEMIES", "TERRAIN", "GROUPS", "POWERUPS", "UPGRADES", "DECORATIONS", "WEAPONS", "ARMOR", "SATELLITES"];
  const assetCategories = ["PATTERNS", "EXPLOSIONS", "SOUNDS"];
  // Components are what the user saved; Enhancements are the fixed library that
  // arrives with every level. The id prefix already told the two apart — it is
  // what gates the delete button — so the split needed nothing added to the
  // level format and no migration for levels saved before it.
  // One shelf, in both tabs, sorted so the user's own work comes before the
  // built-ins inside each category.
  //
  // The two used to be separate tabs, which put the answer to "what weapons do
  // I have" in two places depending on who made them. The card already knows
  // the difference -- a saved one offers a delete, a built-in offers a copy --
  // so the tab does not have to.
  const shelf = [
    ...level.components.filter((component) => component.id.startsWith("component-")),
    ...level.components.filter((component) => !component.id.startsWith("component-")),
  ];

  // -- bullet patterns, as a field rather than a gesture ---------------------
  //
  // Equipping one used to be: select an object, then click a Pattern card over
  // in the palette. Nothing in the Inspector then said which pattern the
  // object was carrying, so the only way to find out was to open the designer
  // and recognise it. A pattern is a property of the weapon, so it belongs in
  // the weapon's own section, named, with the current value showing.
  const patternComponents = level.components.filter((component) => component.kind === "pattern" && component.pattern);
  // The final branch is a FALLBACK, not a synonym for satellite: a kind with
  // no case here lands in it silently, which is how the first explosion and
  // sound Components turned up filed under SATELLITES.
  const componentCategory = (component: ComponentDefinition) => component.kind === "enemy" ? "ENEMIES" : component.kind === "terrain" ? "TERRAIN" : component.kind === "group" ? "GROUPS" : component.kind === "powerup" ? "POWERUPS" : component.kind === "upgrade" ? "UPGRADES" : component.kind === "decoration" ? "DECORATIONS" : component.kind === "weapon" ? "WEAPONS" : component.kind === "pattern" ? "PATTERNS" : component.kind === "armor" ? "ARMOR" : component.kind === "explosion" ? "EXPLOSIONS" : component.kind === "sound" ? "SOUNDS" : "SATELLITES";
  const setCameraSafe = (next: number) => {
    if (next + VIEW_W > levelRef.current.length) {
      const length = Math.ceil((next + VIEW_W) / 500) * 500;
      updateLevel((current) => ({ ...current, length }), true, "infinite-scroll");
    }
    const value = clamp(next, 0, Math.max(0, levelRef.current.length - VIEW_W)); setCamera(value); editorCameraRef.current = value;
  };

  // The stage is framed around the sector, so changing which way the sector
  // runs changes the fit. See resizeViewRef.
  useEffect(() => { resizeViewRef.current(); }, [level.mode, mode]);

  /** Zoom about the stage centre; at or below the fit there is nothing to pan to. */
  const setZoom = (next: number) => {
    const zoom = clamp(next, ZOOM_MIN, ZOOM_MAX);
    zoomRef.current = zoom;
    setViewZoom(zoom);
    if (zoom <= 1) panRef.current = 0;
    resizeViewRef.current();
  };
  /** Pan across the sector, in stage pixels, never past the off-stage room. */
  const panBy = (delta: number) => {
    const limit = (VIEW_H / 2 + PLACE_MARGIN) * viewportRef.current.scale;
    panRef.current = clamp(panRef.current + delta, -limit, limit);
    resizeViewRef.current();
  };

  /**
   * Scrolling the sector, as a native listener rather than an `onWheel` prop.
   *
   * React registers `wheel` at the root **passively**, so `preventDefault`
   * from inside a prop handler is refused: the browser logs "Unable to
   * preventDefault inside passive event listener invocation" once per notch
   * and scrolls the PAGE as well as the sector. A listener that means to
   * cancel the scroll has to say `passive: false` when it is attached, which
   * only a native `addEventListener` can do.
   *
   * The handler lives in a ref because `setCameraSafe` is a plain function of
   * the render: re-attaching a listener on every render would be the
   * alternative, and this way the listener is attached once and always calls
   * the current one.
   */
  const scrollSectorRef = useRef<(event: WheelEvent) => void>(() => {});
  useEffect(() => {
    scrollSectorRef.current = (event) => {
      if (modeRef.current !== "build") return;
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) { setZoom(zoomRef.current * (event.deltaY < 0 ? 1.15 : 1 / 1.15)); return; }
      if (event.shiftKey) { panBy(-event.deltaY); return; }
      setCameraSafe(editorCameraRef.current + event.deltaY + event.deltaX);
    };
  });
  useEffect(() => {
    const canvas = mainCanvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => scrollSectorRef.current(event);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  // Declared here, after setCameraSafe, which is a plain function of the
  // render; the level bar below is the only caller.
  const newLevel = () => {
    withSettledDirty("starting a new level", () => {
      levelSession.new({ force: true });
      installLevel(levelSession.state.doc, true); setCameraSafe(0); flash("NEW LEVEL CREATED");
    });
  };

  // Every collapsible section in both tool panels goes through here: state
  // recorded for palette categories and Inspector sections alike, keyed by a
  // stable slug so a section keeps its state across selection changes, and
  // expanded until the user says otherwise. The chrome is ElectricBlazor's
  // accordion — Starline owns only which sections exist and which are shut.
  // The group names the panel a section sits in. It only bites under "single"
  // Toolbar Behavior, where each panel keeps its own one open section: the
  // accordion collapses the siblings it can see, and the group is what stops
  // the palette and the Inspector from closing each other.
  /**
   * Open or close every section in one panel.
   *
   * Driven through the accordion's own toggles rather than by writing the
   * collapse state directly, because `collapsedSections` is keyed by section
   * and knows nothing about which panel a section belongs to — and the palette
   * generates its keys per category, so there is no static list to write.
   * Clicking the toggles is exactly what a person does, and it routes through
   * `onExpandedChange` so the stored state stays the source of truth.
   *
   * The suite's class names are treated as public here; AGENTS.md already
   * commits to that for the appearance overrides in globals.css.
   */
  const setAllSections = useCallback((panel: "palette" | "inspector", expand: boolean) => {
    const host = document.querySelector(panel === "palette" ? ".palette-panel" : ".inspector-panel");
    if (!host) return;
    for (const toggle of host.querySelectorAll<HTMLElement>(".eb-card-collapse-toggle")) {
      if ((toggle.getAttribute("aria-expanded") === "true") !== expand) toggle.click();
    }
  }, []);

  /** Both buttons, since both panels want the same pair. */
  const sectionControls = (panel: "palette" | "inspector") => (
    <span className="section-controls">
      <button type="button" onClick={() => setAllSections(panel, true)}
        disabled={sectionMode === "single"}
        title={sectionMode === "single" ? "Toolbar Behavior is set to one section at a time" : "Expand every section"}>EXPAND ALL</button>
      <button type="button" onClick={() => setAllSections(panel, false)} title="Collapse every section">COLLAPSE ALL</button>
    </span>
  );

  const section = (key: string, title: string, children: ReactNode, group = "inspector") => (
    <EbAccordionItem key={key} title={title} expanded={sectionMode === "single" ? openSections[group] === key : !collapsedSections[key]} onExpandedChange={(expanded) => {
      setOpenSections((current) => expanded ? { ...current, [group]: key } : current[group] === key ? { ...current, [group]: "" } : current);
      setCollapsedSections((current) => ({ ...current, [key]: !expanded }));
    }}>{children}</EbAccordionItem>
  );

  // A saved Component and a built-in Enhancement are the same card in two
  // tabs; only the corner action differs, because only one of the two is the
  // user's to delete.
  const componentSections = (entries: ComponentDefinition[], prefix: string, categories: string[]) => categories.map((category) => {
    const inCategory = entries.filter((component) => componentCategory(component) === category);
    if (!inCategory.length) return null;
    return section(`${prefix}-${category}`, category, <div className="palette-category-items">{inCategory.map((component) => <div className="component-card-row" key={component.id}><button className={`palette-card ${tool === `component:${component.id}` ? "active" : ""}`} type="button" onClick={() => { if (component.object) { const value = `component:${component.id}` as Tool; setTool(value); toolRef.current = value; setInspectPlayer(false); } else applyEquipmentComponent(component); }}>{component.object ? <ObjectThumb item={component.object} assets={level.assets} /> : <span className={`sprite-icon ${component.kind === "weapon" ? "turret" : component.kind === "armor" ? "energy" : component.kind === "pattern" ? "blade" : "upgrade"}`} />}<span><strong>{component.name}</strong><small>{component.object ? "PLACE COMPONENT" : component.kind === "weapon" ? `${component.weapon?.tag.toUpperCase()} WEAPON` : component.kind === "pattern" ? `${component.pattern?.spawns.length ?? 0} EMITTER PATTERN` : component.kind.toUpperCase()}</small></span><b>{component.object ? "+" : component.kind === "pattern" ? "EDIT / USE" : "USE"}</b></button>{component.id.startsWith("component-") ? <button className="component-delete" type="button" onClick={() => deleteComponent(component.id)} title="Delete Component">×</button> : <button className="component-save" type="button" onClick={() => saveAsComponent(component)} title="Save as Component">+</button>}</div>)}</div>, "palette");
  });

  return (
    <main className={"editor-app" + (presenting ? " is-presenting" : "")}>
      <header className="topbar">
        <a className="brand" href="#workspace" aria-label="Starline Foundry"><span className="brand-mark">S</span><span>STARLINE <i>FOUNDRY</i></span></a>
        <div className="mode-chip"><span className={mode === "build" ? "cyan-dot" : "lime-dot"} />{mode === "build" ? "BUILD MODE" : "PLAYTEST"}</div>
        <div className="top-actions">
          <span className="autosave-state">{notice}</span>
          <span className={`controller-status ${controllerName ? "connected" : ""}`} title={controllerName || "Connect a game controller"}><i />{controllerName ? "CONTROLLER" : "NO GAMEPAD"}</span>
          <div className="history-actions"><button type="button" onClick={() => applyHistory(-1)} disabled={!canUndo || mode !== "build"} title="Undo (Ctrl+Z)">↶</button><button type="button" onClick={() => applyHistory(1)} disabled={!canRedo || mode !== "build"} title="Redo (Ctrl+Y)">↷</button></div>
          <button className="fullscreen-button" type="button" onClick={() => void toggleFullscreen()} aria-pressed={isFullscreen}><kbd>F</kbd> {isFullscreen ? "EXIT FULL" : "FULLSCREEN"}</button>
          <button className="fullscreen-button" type="button" onClick={() => setShowFps((value) => !value)} aria-pressed={showFps}><kbd>F8</kbd> FPS</button>
          {showFps && (
            <span className="fps-readout" aria-live="off">
              {(["current", "min", "median"] as const).map((key) => (
                <span key={key}>
                  {key === "median" ? "med" : key === "current" ? "now" : key}{" "}
                  <b>{fpsStats?.[key] == null ? "—" : Math.round(fpsStats[key] as number)}</b>
                </span>
              ))}
            </span>
          )}
          <button className="fullscreen-button settings-button" type="button" onClick={() => setShowSettings(true)}><b>⚙</b> SETTINGS</button>
          {mode === "build" ? <>
            <button className="fullscreen-button present-button" type="button" onClick={() => enterPlay(true)}><b>▣</b> PRESENT</button>
            {/* `() => enterPlay()` rather than `onClick={enterPlay}`: the handler
                would otherwise hand the click event in as `presented`, and an
                event object is truthy, so TEST RUN would silently present. */}
            <button className="test-button" type="button" onClick={() => enterPlay()}><kbd>T</kbd> TEST RUN <b>▶</b></button>
          </> : <button className="exit-button" type="button" onClick={exitPlay}><kbd>ESC</kbd> RETURN TO BUILD</button>}
        </div>
      </header>

      <section className="levelbar" aria-label="Level controls">
        <label className="level-name"><span>LEVEL{levelDoc.dirty ? <i className="dirty-dot" title="Unsaved changes" aria-label="Unsaved changes" /> : null}</span><input value={level.name} onChange={(event) => updateLevel((current) => ({ ...current, name: event.target.value }), true, "level-name")} /></label>
        <label className="length-control"><span>END LEVEL</span><input type="number" min="1600" step="250" value={level.length} onChange={(event) => {
          const length = Math.max(1600, Number(event.target.value) || 1600);
          updateLevel((current) => ({ ...current, length }), true, "level-length"); setCameraSafe(Math.min(editorCameraRef.current, length - VIEW_W));
        }} /><em>u</em></label>
        <label className="length-control"><span>MODE</span><select value={level.mode} aria-label="Level mode" onChange={(event) => updateLevel((current) => ({ ...current, mode: event.target.value as LevelMode }), true, "level-mode")}>
          <option value="horizontal">HORIZONTAL</option>
          <option value="vertical">VERTICAL</option>
          <option value="arena">ARENA</option>
        </select></label>
        <div className="file-actions">
          <button type="button" onClick={newLevel}>NEW</button>
          <select value={loadName} onChange={(event) => setLoadName(event.target.value)} aria-label="Saved levels"><option value="">LOAD LEVEL...</option><optgroup label="SAMPLES">{starterLevels.map((sample) => <option value={`sample:${sample.key}`} key={sample.key}>{sample.name}</option>)}</optgroup>{savedEntries.map((entry) => <option value={entry.id} key={entry.id}>{entry.name}{entry.bytes > 200000 ? ` · ${(entry.bytes / 1048576).toFixed(1)} MB` : ""}</option>)}</select>
          <button type="button" onClick={loadLevel} disabled={!loadName}>LOAD</button>
          <button type="button" onClick={deleteSavedLevel} disabled={!loadName || loadName.startsWith("sample:")} title="Delete the selected saved level (undo for a few seconds)">DELETE</button>
          {levelDoc.canUndoRemove && <button type="button" onClick={undoDelete}>UNDO DELETE</button>}
          <button type="button" onClick={duplicateLevel} title="Copy this level to (copy) and edit the copy (Ctrl+Shift+S)">DUPLICATE</button>
          <button type="button" className="primary" onClick={saveLevel} disabled={!levelDoc.dirty} title="Save (Ctrl+S)">SAVE</button>
          <button type="button" onClick={() => importRef.current?.click()}>IMPORT…</button>
          <button type="button" onClick={exportLevel}>EXPORT</button>
          <button type="button" onClick={() => void shareLevel()}>SHARE LINK</button>
          <input ref={importRef} className="hidden-input" type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importLevel(file); event.target.value = ""; }} />
        </div>
      </section>

      <section className={`workspace ${mode !== "build" ? "is-playing" : ""}`} id="workspace" style={{ position: "relative", "--palette-w": `${paletteWidth}px`, "--inspector-w": `${inspectorWidth}px` } as CSSProperties}>
        <PanelResizer side="palette" width={paletteWidth} other={inspectorWidth} onResize={setPaletteWidth} onCommit={(next) => { setPaletteWidth(next); editorSettings.set("paletteWidth", next); }} />
        <PanelResizer side="inspector" width={inspectorWidth} other={paletteWidth} onResize={setInspectorWidth} onCommit={(next) => { setInspectorWidth(next); editorSettings.set("inspectorWidth", next); }} />
        <aside className="palette-panel">
          <div className="panel-heading"><span>FOUNDRY PALETTE</span><small>{level.items.length} PLACED</small>{sectionControls("palette")}</div>
          <div className="tool-strip">
            {(["select", "scroll", "erase"] as Tool[]).map((value) => <button type="button" className={tool === value ? "active" : ""} onClick={() => { setTool(value); toolRef.current = value; }} key={value}><b>{value === "select" ? "↖" : value === "scroll" ? "↔" : "⌫"}</b>{value.toUpperCase()}</button>)}
          </div>
          {/* The OBJECTS / COMPONENTS / ASSETS switch is ElectricBlazor's
              tabbed card in its bare form, moved below the player card and
              tools so the strip sits directly on the list it switches — which
              is also what lets the list live inside the tab panel it belongs
              to. The third tab arrived with the Components split; equal-width
              tabs went with it, since ENHANCEMENTS does not fit a third of a
              214px column. */}
          <EbTabbedCard<PaletteTab>
            items={[{ value: "objects", label: "OBJECTS" }, { value: "components", label: "COMPONENTS" }, { value: "assets", label: "ASSETS" }]}
            value={paletteTab}
            onValueChange={setPaletteTab}
            ariaLabel="Palette tabs"
            appearance="bare"
            tabStyle="segmented"
            className="palette-tabs"
            panelContent={(tab) => <EbAccordion allowMultiple={sectionMode === "multiple"} className="palette-list">
            {tab === "objects" ? ["ENEMIES", "TERRAIN", "GROUPS", "POWERUPS", "UPGRADES", "DECORATIONS"].map((category) => section(category, category,
              <div className="palette-category-items">
                {palette.filter((entry) => entry.category === category).map((entry) => <button type="button" className={`palette-card ${tool === entry.key ? "active" : ""}`} onClick={() => { setTool(entry.key); toolRef.current = entry.key; setInspectPlayer(false); }} key={entry.key}>
                  <span className={`sprite-icon ${entry.sprite}`} /><span><strong>{entry.label}</strong><small>{entry.meta}</small></span><b>+</b>
                </button>)}
              </div>, "palette")) : tab === "components" ? <>
              {componentSections(shelf, "COMP", componentCategories)}
              {!shelf.some((component) => componentCategories.includes(componentCategory(component))) && <p className="palette-empty">Nothing here yet. Select an Object and choose SAVE AS COMPONENT to keep it.</p>}
            </> : <>
              <div className="asset-actions">{/* The level's default explosions by role -- spark, impact, blast -- as
                  distinct from + EXPLOSION, which authors one saved explosion. Here rather than
                  in the top bar, with the other editors. */}<button type="button" onClick={() => setDesigningBursts(true)}>✳ DEFAULT EXPLOSIONS</button><button type="button" onClick={() => setEditingAsset({ id: uid(), name: "New Pixel Art", kind: "raster", width: 16, height: 16, pixels: Array(256).fill("") })}>+ PIXEL ART</button><button type="button" onClick={() => setEditingAsset({ id: uid(), name: "New Vector", kind: "vector", width: 256, height: 256, shapes: [] })}>+ VECTOR SPRITE</button>{/* An image asset is defined by carrying real bytes, so a blank one is a
                  real transparent PNG rather than an empty string -- which is what
                  blankImageAsset exists for, and what normalizeAssets would drop. */}<button type="button" onClick={() => setEditingAsset(blankImageAsset(uid(), "New Image", 256, 256))}>+ IMAGE</button><button type="button" onClick={() => setEditingExplosion({ id: `component-${uid()}`, name: "New Explosion", burst: { ...createBurstPreset("Blast"), name: "New Explosion" } })}>+ EXPLOSION</button><button type="button" onClick={() => setEditingSound({ id: `component-${uid()}`, sound: { ...createSfxPreset("Explosion"), name: "New Sound" } })}>+ SOUND</button></div>
              {level.assets.length > 0 && section("SPRITES", "SPRITES", <div className="palette-category-items">{level.assets.map((asset) => <div className="component-card-row" key={asset.id}><button className="palette-card" type="button" onClick={() => setEditingAsset(structuredClone(asset))}><SpriteAssetPreview asset={asset} /><span><strong>{asset.name}</strong><small>{asset.kind.toUpperCase()} / {asset.width}×{asset.height}</small></span><b>EDIT</b></button><button className="component-delete" type="button" onClick={() => deleteSpriteAsset(asset.id)} title="Delete sprite">×</button></div>)}</div>, "palette")}
              {componentSections(shelf, "ASSET", assetCategories)}
            </>}
          </EbAccordion>}
          />
          <p className="palette-hint">{paletteTab === "objects" ? "Choose an object, then click the playfield to place it." : paletteTab === "components" ? "Things that go in the level: place a saved Object, or apply a weapon, armor or satellite to the selection." : "What things are made of. Author a sprite, explosion, sound or pattern here, then point an object at it."}</p>
        </aside>

        <section className="stage-panel">
          <div className="stage-toolbar">
            <div><span>SECTOR POSITION</span><strong>{Math.round(camera).toString().padStart(5, "0")} — {Math.round(Math.min(level.length, camera + VIEW_W)).toString().padStart(5, "0")}</strong></div>
            <div className="camera-controls"><button type="button" onClick={() => setCameraSafe(camera - VIEW_W * .7)}>◀</button><input type="range" min="0" max={Math.max(0, level.length - VIEW_W)} value={camera} onChange={(event) => setCameraSafe(Number(event.target.value))} aria-label="Horizontal level position" /><button type="button" onClick={() => setCameraSafe(camera + VIEW_W * .7)}>▶</button></div>
            <div className="zoom-controls" aria-label="Stage zoom">
              <button type="button" onClick={() => setZoom(zoomRef.current / 1.25)} title="Zoom out (Ctrl + wheel)">−</button>
              <span>{Math.round(viewZoom * 100)}%</span>
              <button type="button" onClick={() => setZoom(zoomRef.current * 1.25)} title="Zoom in (Ctrl + wheel)">+</button>
              <button type="button" onClick={() => { panRef.current = 0; setZoom(1); }} title="Back to the fit">FIT</button>
            </div>
          </div>
          {/* While a placement tool is active the sprite under the pointer IS the
              pointer, so the native arrow is hidden (.placing). */}
          <div className={`stage-canvas-wrap${tool !== "select" && tool !== "scroll" && tool !== "erase" ? " placing" : ""}`}>
            <canvas
              ref={mainCanvasRef}
              onPointerDown={onCanvasDown}
              onPointerMove={onCanvasMove}
              onPointerUp={finishCanvasDrag}
              onPointerCancel={finishCanvasDrag}
              onPointerLeave={() => { hoverRef.current = null; }}
              onContextMenu={(event) => event.preventDefault()}
              aria-label={mode === "build" ? "Scrollable level editing playfield" : "Playable Starline level"}
            />
            {/* The presenter draws here, over the frame above, while a filter is on.
                Pointer events pass through to the canvas underneath. */}
            <canvas ref={presentCanvasRef} className="present-canvas" aria-hidden="true" hidden />
            {mode !== "build" && <div className="play-hud">
              <div><span>SCORE</span><strong>{score.toString().padStart(6, "0")}</strong></div>
              <div className="play-progress"><span>SECTOR CLEARANCE</span><i><b style={{ width: `${progress}%` }} /></i></div>
              <div><span>HULL {lives}/{hullMax}{level.player.armor.type === "forcefield" ? ` // SHIELD ${shield}` : ""}</span><strong className="hull-pips">{Array.from({ length: hullMax }, (_, life) => <i className={life < lives ? "live" : ""} key={life} />)}</strong></div>
            </div>}
            {(mode === "paused" || mode === "gameover" || mode === "victory") && <div className="play-overlay">
              <span>{mode === "paused" ? "FLIGHT SUSPENDED" : mode === "victory" ? "SECTOR SECURED" : "MISSION TERMINATED"}</span>
              <h1>{mode === "paused" ? "PAUSED" : mode === "victory" ? "LEVEL CLEAR" : "SIGNAL LOST"}</h1>
              <p>{mode === "paused" ? "Press P or Start to resume. Escape, B, or Back returns to edit." : "Press Enter to run again. Escape, B, or Back returns to the Foundry."}</p>
              <div><button type="button" onClick={mode === "paused" ? () => { setMode("playing"); modeRef.current = "playing"; } : () => enterPlay(presenting)}>{mode === "paused" ? "RESUME" : "RETRY"}</button><button type="button" onClick={exitPlay}>RETURN TO BUILD</button></div>
            </div>}
            {mode === "build" && <div className="build-badge"><span /> LIVE EDITOR <b>SCROLL TO TRAVEL</b></div>}
          </div>
          <div className="minimap-block">
            <div className="minimap-label"><span>LEVEL OVERVIEW</span><strong>DRAG BRACKETS TO NAVIGATE</strong></div>
            <canvas ref={miniCanvasRef} onPointerDown={onMiniDown} onPointerMove={onMiniMove} onPointerUp={(event) => { miniDragRef.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { miniDragRef.current = null; }} aria-label="Full level minimap. Drag the brackets to navigate." />
            <div className="minimap-scale"><span>00000</span><span>{Math.round(level.length / 2).toString().padStart(5, "0")}</span><span>{level.length.toString().padStart(5, "0")}</span></div>
          </div>
        </section>

        <aside className="inspector-panel">
          <div className="panel-heading"><span>INSPECTOR</span>{sectionControls("inspector")}{selected && <button type="button" onClick={deleteSelected}>DELETE {selectedIds.length > 1 ? selectedIds.length : ""}</button>}</div>
          {inspectPlayer ? <div className="inspector-form player-settings">
            <div className="type-tag"><span>EDITING</span><strong>PLAYER SHIP</strong><span className={`player-icon ${level.player.sprite.startsWith("asset:") ? "asset-custom" : level.player.sprite}`} /></div>
            <label className="field wide"><span>SHIP SPRITE</span><select value={level.player.sprite} onChange={(event) => updateLevel((current) => ({ ...current, player: { ...current.player, sprite: event.target.value as PlayerSpriteChoice } }), true, "player-sprite")}><optgroup label="PLAYER SHIPS">{["dart", "raven", "nova", "striker"].map((sprite) => <option value={sprite} key={sprite}>{sprite.toUpperCase()}</option>)}</optgroup>{level.assets.length > 0 && <optgroup label="CUSTOM SPRITES">{level.assets.map((asset) => <option value={`asset:${asset.id}`} key={asset.id}>{asset.name.toUpperCase()}</option>)}</optgroup>}</select></label>
            <label className="range-field"><span><b>SHIP HUE TINT</b><em>{level.player.tint}°</em></span><input type="range" min="0" max="359" value={level.player.tint} onChange={(event) => updateLevel((current) => ({ ...current, player: { ...current.player, tint: Number(event.target.value) } }), true, "player-tint")} /></label>
            <label className="range-field"><span><b>SHIP SCALE</b><em>{level.player.scale.toFixed(2)}×</em></span><input type="range" min="0.05" max="8" step="0.05" value={level.player.scale} onChange={(event) => updateLevel((current) => ({ ...current, player: { ...current.player, scale: Number(event.target.value) } }), true, "player-scale")} /></label>
            <p className="inspector-note">The ship is its sprite&apos;s own size; this scales it. A custom sprite drawn at 1× is drawn pixel for pixel, so scaling down stays sharp. The hitbox is the sprite, so a bigger ship really is a bigger target.</p>
            <GlowField glow={level.player.glow} onChange={(glow) => updateLevel((current) => ({ ...current, player: { ...current.player, glow } }), true, "player-glow")} />
            <EbAccordion allowMultiple={sectionMode === "multiple"} className="inspector-sections">
            {section("flight", "FLIGHT", <>
              <label className="range-field"><span><b>X SPEED</b><em>{level.player.xSpeed}u/s</em></span><input type="range" min="100" max="800" step="10" value={level.player.xSpeed} onChange={(event) => updateLevel((current) => ({ ...current, player: { ...current.player, xSpeed: Number(event.target.value) } }), true, "player-x-speed")} /></label>
              <label className="range-field"><span><b>Y SPEED</b><em>{level.player.ySpeed}u/s</em></span><input type="range" min="100" max="800" step="10" value={level.player.ySpeed} onChange={(event) => updateLevel((current) => ({ ...current, player: { ...current.player, ySpeed: Number(event.target.value) } }), true, "player-y-speed")} /></label>
              <label className="range-field"><span><b>FORWARD LIMIT</b><em>{level.player.forwardLimit}%</em></span><input type="range" min="20" max="92" step="1" value={level.player.forwardLimit} onChange={(event) => updateLevel((current) => ({ ...current, player: { ...current.player, forwardLimit: Number(event.target.value) } }), true, "player-forward-limit")} /></label>
              <p className="inspector-note">Sets the farthest point the ship can travel toward the right edge of the screen.</p>
            </>)}
            {section("fire-mods", "GLOBAL FIRE MODIFIERS", <>
              <label className="range-field"><span><b>SHOT SPEED</b><em>{level.player.shotSpeed}u/s</em></span><input type="range" min="200" max="1600" step="25" value={level.player.shotSpeed} onChange={(event) => updateLevel((current) => ({ ...current, player: { ...current.player, shotSpeed: Number(event.target.value) } }), true, "player-shot-speed")} /></label>
              <label className="range-field"><span><b>SHOT POWER</b><em>{level.player.shotPower}</em></span><input type="range" min="100" max="1000" step="100" value={level.player.shotPower} onChange={(event) => updateLevel((current) => ({ ...current, player: { ...current.player, shotPower: Number(event.target.value) } }), true, "player-shot-power")} /></label>
              <p className="inspector-note">Minimum player firepower is 100. Enemies at or below the current value are destroyed in one shot.</p>
            </>)}
            {section("slots", "WEAPON SLOTS & INVENTORY", <>
              <label className="range-field"><span><b>ACTIVE SLOTS</b><em>{level.player.weaponSlots.length}</em></span><input type="range" min="1" max="4" value={level.player.weaponSlots.length} onChange={(event) => updateLevel((current) => { const count = Number(event.target.value); const slots = current.player.weaponSlots.slice(0, count); while (slots.length < count) slots.push({ id: uid(), name: `SLOT ${slots.length + 1}`, accepts: "standard", weaponId: current.player.inventory[0] ?? "weapon-pulse" }); return { ...current, player: { ...current.player, weaponSlots: slots } }; }, true, "player-slot-count")} /></label>
              <label className="range-field"><span><b>INVENTORY LIMIT</b><em>{level.player.inventoryLimit}</em></span><input type="range" min="1" max="12" value={level.player.inventoryLimit} onChange={(event) => updateLevel((current) => ({ ...current, player: { ...current.player, inventoryLimit: Number(event.target.value), inventory: current.player.inventory.slice(0, Number(event.target.value)) } }), true, "player-inventory-limit")} /></label>
              {level.player.weaponSlots.map((slot, index) => <div className="equipment-slot" key={slot.id}><strong>{slot.name}</strong><label className="field"><span>ACCEPTS</span><select value={slot.accepts} onChange={(event) => updateLevel((current) => ({ ...current, player: { ...current.player, weaponSlots: current.player.weaponSlots.map((entry) => entry.id === slot.id ? { ...entry, accepts: event.target.value } : entry) } }))}><option value="any">ANY</option><option value="standard">STANDARD</option><option value="light">LIGHT</option><option value="heavy">HEAVY</option><option value="satellite">SATELLITE</option></select></label><label className="field"><span>WEAPON</span><select value={slot.weaponId} onChange={(event) => updateLevel((current) => ({ ...current, player: { ...current.player, weaponSlots: current.player.weaponSlots.map((entry) => entry.id === slot.id ? { ...entry, weaponId: event.target.value } : entry) } }))}>{level.components.filter((component) => component.kind === "weapon" && weaponFitsSlot(component, slot.accepts)).map((component) => <option value={component.id} key={component.id}>{component.name.toUpperCase()}</option>)}</select></label>{(() => { const weaponComponent = level.components.find((component) => component.id === slot.weaponId); if (!weaponComponent?.weapon) return null; return <>
              {/* Where each slot's gun sits on the ship, forward and across in world units.
                  The defaults are where the slots have always fired from -- the nose, fanned
                  nine units apart -- and the sights on the playfield show the spots while the
                  ship is selected. */}
              {level.player.weaponSlots.map((slot, index) => <div className="field-grid" key={`mount-${slot.id}`}>
                <label className="range-field"><span><b>{slot.name} MOUNT FWD</b><em>{slot.mount ? `${slot.mount.x}u` : "NOSE"}</em></span><input type="range" min="-60" max="120" step="1" value={slot.mount?.x ?? 29} onChange={(event) => updateLevel((current) => ({ ...current, player: { ...current.player, weaponSlots: current.player.weaponSlots.map((entry, i) => entry.id === slot.id ? { ...entry, mount: { x: Number(event.target.value), y: entry.mount?.y ?? Math.round((i - (current.player.weaponSlots.length - 1) / 2) * 9) } } : entry) } }), true, "slot-mount")} /></label>
                <label className="range-field"><span><b>{slot.name} MOUNT ACROSS</b><em>{slot.mount ? `${slot.mount.y}u` : "FANNED"}</em></span><input type="range" min="-80" max="80" step="1" value={slot.mount?.y ?? Math.round((index - (level.player.weaponSlots.length - 1) / 2) * 9)} onChange={(event) => updateLevel((current) => ({ ...current, player: { ...current.player, weaponSlots: current.player.weaponSlots.map((entry) => entry.id === slot.id ? { ...entry, mount: { x: entry.mount?.x ?? 29, y: Number(event.target.value) } } : entry) } }), true, "slot-mount")} /></label>
              </div>)}
                {/* The pattern belongs to the WEAPON Component, not to the slot,
                    so every slot carrying this weapon changes together. That is
                    the data model rather than a shortcut: a weapon is one saved
                    thing, and two mounts firing the same gun differently would
                    be two guns. */}
                <BulletPatternField components={patternComponents} pattern={weaponComponent.weapon.pattern} onApply={(next) => updateLevel((current) => ({ ...current, components: current.components.map((entry) => entry.id === weaponComponent.id ? { ...entry, weapon: entry.weapon ? { ...entry.weapon, pattern: next } : entry.weapon } : entry) }))} />
                <button className="inspector-action" type="button" onClick={() => setEditingPattern({ pattern: structuredClone(weaponComponent.weapon!.pattern ?? createPatternPreset("Pendulum Sweep")), target: { kind: "weapon", id: weaponComponent.id } })}>{weaponComponent.weapon.pattern ? "EDIT THIS PATTERN" : "DESIGN A PATTERN"}</button>
              </>; })()}<small>Fires simultaneously from mount {index + 1}.</small></div>)}
              <div className="inventory-grid">{level.components.filter((component) => component.kind === "weapon").map((component) => { const carried = level.player.inventory.includes(component.id); return <button type="button" className={carried ? "active" : ""} onClick={() => updateLevel((current) => { const inventory = carried ? current.player.inventory.filter((id) => id !== component.id) : [...current.player.inventory, component.id].slice(0, current.player.inventoryLimit); return { ...current, player: { ...current.player, inventory } }; })} key={component.id}>{carried ? "✓ " : "+ "}{component.name}</button>; })}</div>
            </>)}
            {section("armor", "ARMOR & FORCE FIELD", <>
              <label className="field wide"><span>ARMOR TYPE</span><select value={level.player.armor.type} onChange={(event) => updateLevel((current) => ({ ...current, player: { ...current.player, armor: defaultArmor(event.target.value as ArmorType) } }))}>{["none", "standard", "heavy", "ablative", "forcefield"].map((type) => <option value={type} key={type}>{type.toUpperCase()}</option>)}</select></label>
              <label className="range-field"><span><b>{level.player.armor.type === "forcefield" ? "SHIELD CAPACITY" : "ARMOR CAPACITY"}</b><em>{level.player.armor.capacity}</em></span><input type="range" min="1" max={level.player.armor.type === "forcefield" ? 1000 : 12} step={level.player.armor.type === "forcefield" ? 25 : 1} value={level.player.armor.capacity} onChange={(event) => updateLevel((current) => ({ ...current, player: { ...current.player, armor: { ...current.player.armor, capacity: Number(event.target.value) } } }))} /></label>
              <label className="range-field"><span><b>DAMAGE TAKEN</b><em>{Math.round(level.player.armor.damageMultiplier * 100)}%</em></span><input type="range" min="0.1" max="1" step="0.05" value={level.player.armor.damageMultiplier} onChange={(event) => updateLevel((current) => ({ ...current, player: { ...current.player, armor: { ...current.player.armor, damageMultiplier: Number(event.target.value) } } }))} /></label>
              {level.player.armor.type === "forcefield" && <><label className="range-field"><span><b>RECHARGE DELAY</b><em>{level.player.armor.rechargeDelay.toFixed(1)}s</em></span><input type="range" min="0" max="8" step="0.25" value={level.player.armor.rechargeDelay} onChange={(event) => updateLevel((current) => ({ ...current, player: { ...current.player, armor: { ...current.player.armor, rechargeDelay: Number(event.target.value) } } }))} /></label><label className="range-field"><span><b>RECHARGE RATE</b><em>{level.player.armor.rechargeRate}/s</em></span><input type="range" min="0" max="250" step="5" value={level.player.armor.rechargeRate} onChange={(event) => updateLevel((current) => ({ ...current, player: { ...current.player, armor: { ...current.player.armor, rechargeRate: Number(event.target.value) } } }))} /></label></>}
              <button className="inspector-action" type="button" onClick={() => saveArmorComponent(level.player.armor)}>SAVE AS ARMOR COMPONENT</button>
            </>)}
            {section("satellite", "SATELLITE SHIP", <>
              <label className="toggle-row"><span>ENABLED</span><input type="checkbox" checked={level.player.satellite.enabled} onChange={(event) => updateLevel((current) => ({ ...current, player: { ...current.player, satellite: { ...current.player.satellite, enabled: event.target.checked } } }))} /><i /></label>
              <label className="field wide"><span>CONTROL MODE</span><select value={level.player.satellite.mode} onChange={(event) => updateLevel((current) => ({ ...current, player: { ...current.player, satellite: { ...current.player.satellite, mode: event.target.value as SatelliteMode } } }))}><option value="orbit">ORBIT</option><option value="tether">TETHERED FREE MOVE</option><option value="aim">AIM ON RADIUS</option></select></label>
              <label className="range-field"><span><b>RANGE</b><em>{level.player.satellite.range}u</em></span><input type="range" min="50" max="280" value={level.player.satellite.range} onChange={(event) => updateLevel((current) => ({ ...current, player: { ...current.player, satellite: { ...current.player.satellite, range: Number(event.target.value) } } }))} /></label>
              <label className="range-field"><span><b>SPEED</b><em>{level.player.satellite.speed}u/s</em></span><input type="range" min="100" max="800" step="10" value={level.player.satellite.speed} onChange={(event) => updateLevel((current) => ({ ...current, player: { ...current.player, satellite: { ...current.player.satellite, speed: Number(event.target.value) } } }))} /></label>
              <label className="field wide"><span>SATELLITE WEAPON</span><select value={level.player.satellite.weaponId} onChange={(event) => updateLevel((current) => ({ ...current, player: { ...current.player, satellite: { ...current.player.satellite, weaponId: event.target.value } } }))}>{level.components.filter((component) => component.kind === "weapon").map((component) => <option value={component.id} key={component.id}>{component.name.toUpperCase()}</option>)}</select></label>
              {/* The satellite carries a Weapon Component like any mount, so its
                  pattern is reachable the same way rather than only through the
                  designer. Editing it edits that weapon everywhere it is used. */}
              {(() => { const satWeapon = level.components.find((component) => component.id === level.player.satellite.weaponId); if (!satWeapon?.weapon) return null; return <BulletPatternField components={patternComponents} pattern={satWeapon.weapon.pattern} onApply={(next) => updateLevel((current) => ({ ...current, components: current.components.map((entry) => entry.id === satWeapon.id ? { ...entry, weapon: entry.weapon ? { ...entry.weapon, pattern: next } : entry.weapon } : entry) }))} />; })()}
              <label className="field wide"><span>SATELLITE ARMOR</span><select value={level.player.satellite.armor.type} onChange={(event) => updateLevel((current) => ({ ...current, player: { ...current.player, satellite: { ...current.player.satellite, armor: defaultArmor(event.target.value as ArmorType) } } }))}>{["none", "standard", "heavy", "ablative", "forcefield"].map((type) => <option value={type} key={type}>{type.toUpperCase()}</option>)}</select></label>
              <label className="range-field"><span><b>{level.player.satellite.armor.type === "forcefield" ? "SATELLITE SHIELD" : "SATELLITE HULL"}</b><em>{level.player.satellite.armor.capacity}</em></span><input type="range" min="1" max={level.player.satellite.armor.type === "forcefield" ? 600 : 10} step={level.player.satellite.armor.type === "forcefield" ? 25 : 1} value={level.player.satellite.armor.capacity} onChange={(event) => updateLevel((current) => ({ ...current, player: { ...current.player, satellite: { ...current.player.satellite, armor: { ...current.player.satellite.armor, capacity: Number(event.target.value) } } } }))} /></label>
              <button className="inspector-action" type="button" onClick={() => saveSatelliteComponent(level.player.satellite)}>SAVE AS SATELLITE COMPONENT</button>
            </>)}
            </EbAccordion>
          </div> : !selected ? <div className="empty-inspector"><b>NO OBJECT SELECTED</b><p>Use the Select tool and choose an object to tune its behavior, or edit the player ship from the palette.</p></div> : <div className="inspector-form">
            {selectedIds.length > 1 && <div className="multi-selection-note"><strong>{selectedIds.length} OBJECTS SELECTED</strong><span>Move, duplicate, delete, rotate, or scale them together. The Inspector edits the primary Object.</span></div>}
            <div className="component-actions"><button type="button" onClick={() => saveObjectComponent(false)}>SAVE AS COMPONENT</button>{selected.componentId && <button type="button" onClick={() => saveObjectComponent(true)}>UPDATE COMPONENT</button>}</div>
            <label className="field wide"><span>NAME</span><input value={selected.name} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, name: event.target.value }))} /></label>
            <div className="type-tag"><span>TYPE</span><strong>{selected.type.toUpperCase()}</strong><i className={`sprite-icon ${selected.sprite.startsWith("asset:") ? "asset-custom" : selected.sprite}`} /></div>
            <div className="field-grid">
              <div className="field"><EbNumericInput label="POSITION X" sliderEnabled={false} min={0} max={level.length} value={Math.round(selected.x)} onValueChange={(x) => updateItem(selected.id, (item) => ({ ...item, x }))} /></div>
              <div className="field"><EbNumericInput label="POSITION Y" sliderEnabled={false} min={0} max={VIEW_H} value={Math.round(selected.y)} onValueChange={(y) => updateItem(selected.id, (item) => ({ ...item, y }))} /></div>
            </div>
            <label className="field wide"><span>SPRITE{selectedIds.length > 1 ? " (APPLY TO ALL)" : ""}</span><select value={selected.sprite} onChange={(event) => updateSelectedItems((item) => ({ ...item, sprite: event.target.value as Sprite }), "selection-sprite")}><optgroup label="BUILT-IN">{["orb", "blade", "diamond", "turret", "raider", "wraith", "carrier", "asteroid", "energy", "upgrade", "planet", "nebula", "wreck", "comet"].map((sprite) => <option value={sprite} key={sprite}>{sprite.toUpperCase()}</option>)}</optgroup>{level.assets.length > 0 && <optgroup label="CUSTOM SPRITES">{level.assets.map((asset) => <option value={`asset:${asset.id}`} key={asset.id}>{asset.name.toUpperCase()} ({asset.kind.toUpperCase()})</option>)}</optgroup>}</select></label>
            <label className="range-field"><span><b>HUE TINT{selectedIds.length > 1 ? " / ALL" : ""}</b><em>{Math.round(selected.tint)}°</em></span><input type="range" min="0" max="359" value={selected.tint} onChange={(event) => updateSelectedItems((item) => ({ ...item, tint: Number(event.target.value) }), "selection-tint")} /></label>
            <button className="mini-reset" type="button" onClick={() => updateSelectedItems((item) => ({ ...item, tint: 0 }), "selection-tint")}>RESET TINT</button>
            <label className="range-field"><span><b>SIZE{selectedIds.length > 1 ? " / ALL" : ""}</b><em>{selected.size}px</em></span><input type="range" min="12" max="220" value={selected.size} onChange={(event) => updateSelectedItems((item) => ({ ...item, size: Number(event.target.value) }), "selection-size")} /></label>
            <EbAccordion allowMultiple={sectionMode === "multiple"} className="inspector-sections">
            {section("transform", "TRANSFORM", <>
              <label className="range-field"><span><b>SCALE{selectedIds.length > 1 ? " / ALL" : ""}</b><em>{selected.scale.toFixed(2)}×</em></span><input type="range" min="0.25" max="4" step="0.05" value={selected.scale} onChange={(event) => updateSelectedItems((item) => ({ ...item, scale: Number(event.target.value) }), "selection-scale")} /></label>
              <label className="range-field"><span><b>ROTATION{selectedIds.length > 1 ? " / ALL" : ""}</b><em>{Math.round(selected.rotation)}°</em></span><input type="range" min="-180" max="180" step="1" value={selected.rotation} onChange={(event) => updateSelectedItems((item) => ({ ...item, rotation: Number(event.target.value) }), "selection-rotation")} /></label>
              {/* How far the sprite turns to face the way it flies. LEVEL is the
                  bob every sprite had before this; a rocket on a sine wave wants
                  something near 100%. Zero is stored as absent, so a level that
                  never touched this saves exactly as it did. */}
              <label className="range-field"><span><b>FACE DIRECTION OF TRAVEL</b><em>{selected.heading?.follow ? Math.round(selected.heading.follow * 100) + "%" : "LEVEL"}</em></span><input type="range" min="0" max="1" step="0.05" value={selected.heading?.follow ?? 0} onChange={(event) => updateSelectedItems((item) => ({ ...item, heading: Number(event.target.value) > 0 ? { follow: Number(event.target.value) } : undefined }), "selection-heading")} /></label>
              <GlowField glow={selected.glow} onChange={(glow) => updateSelectedItems((item) => ({ ...item, glow }), "item-glow")} />
              <DepthField depth={selected.depth} onChange={(depth) => updateSelectedItems((item) => ({ ...item, depth }), "item-depth")} />
            </>)}

            {(selected.type === "enemy" || selected.type === "terrain" || selected.type === "group") && section("durability", "DURABILITY", <>
              {/* Takes no damage and is never destroyed; shots still spark and stop on it.
                  Only ever true or absent, so a level that never set it saves as it did. */}
              <label className="toggle-row"><span>INDESTRUCTIBLE</span><input type="checkbox" checked={Boolean(selected.indestructible)} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, indestructible: event.target.checked ? true : undefined }))} /><i /></label>
              {!selected.indestructible && <label className="range-field"><span><b>HIT POINTS</b><em>{selected.hitPoints} HP</em></span><input type="range" min="50" max="2000" step="50" value={selected.hitPoints} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, hitPoints: Number(event.target.value) }))} /></label>}
              <label className="field wide"><span>ARMOR TYPE</span><select value={selected.armor?.type ?? "none"} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, armor: defaultArmor(event.target.value as ArmorType) }))}>{["none", "standard", "heavy", "ablative", "forcefield"].map((type) => <option value={type} key={type}>{type.toUpperCase()}</option>)}</select></label>
              {(selected.armor?.type === "forcefield") && <><label className="range-field"><span><b>SHIELD CAPACITY</b><em>{selected.armor.capacity}</em></span><input type="range" min="25" max="1000" step="25" value={selected.armor.capacity} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, armor: { ...(item.armor ?? defaultArmor("forcefield")), capacity: Number(event.target.value) } }))} /></label><label className="range-field"><span><b>RECHARGE RATE</b><em>{selected.armor.rechargeRate}/s</em></span><input type="range" min="0" max="250" step="5" value={selected.armor.rechargeRate} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, armor: { ...(item.armor ?? defaultArmor("forcefield")), rechargeRate: Number(event.target.value) } }))} /></label></>}
              <p className="inspector-note">{Math.max(1, Math.ceil(selected.hitPoints / level.player.shotPower))} hit{Math.ceil(selected.hitPoints / level.player.shotPower) === 1 ? "" : "s"} at base power {level.player.shotPower}.</p>
              {selected.armor && selected.armor.type !== "none" && <button className="inspector-action" type="button" onClick={() => saveArmorComponent(selected.armor!)}>SAVE ARMOR COMPONENT</button>}
            </>)}

            {selected.type === "group" && section("formation", "FORMATION", <>
              <div className="field-grid"><label className="field"><span>FORMATION</span><select value={selected.group?.pattern} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, group: { ...(item.group ?? { count: 5, spacing: 60, pattern: "line" }), pattern: event.target.value as GroupPattern } }))}><option value="line">LINE</option><option value="vee">VEE</option><option value="ring">RING</option></select></label><div className="field"><EbNumericInput label="COUNT" sliderEnabled={false} min={2} max={16} value={selected.group?.count ?? 5} onValueChange={(count) => updateItem(selected.id, (item) => ({ ...item, group: { ...(item.group ?? { pattern: "line", spacing: 60, count: 5 }), count } }))} /></div></div>
              <label className="range-field"><span><b>SPACING</b><em>{selected.group?.spacing ?? 60}u</em></span><input type="range" min="30" max="140" value={selected.group?.spacing ?? 60} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, group: { ...(item.group ?? { pattern: "line", spacing: 60, count: 5 }), spacing: Number(event.target.value) } }))} /></label>
            </>)}

            {section("movement", selected.type === "decoration" ? "DECORATION MOTION" : "MOVEMENT", <>
              <label className="field wide"><span>MOVEMENT</span><select value={selected.movement.pattern} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, movement: { ...item.movement, pattern: event.target.value as MovePattern } }))}><option value="straight">STRAIGHT</option><option value="sine">SINE WAVE</option><option value="zigzag">ZIGZAG</option><option value="arc">ARC</option><option value="bezier">BEZIER</option><option value="stationary">STATIONARY</option></select></label>
              <label className="range-field"><span><b>SPEED</b><em>{selected.movement.speed}u/s</em></span><input type="range" min="0" max="720" step="5" value={selected.movement.speed} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, movement: { ...item.movement, speed: Number(event.target.value) } }))} /></label>
              {/* Which way the whole path points. LEFT is the flight every level
                  already had; positive turns toward the top of the screen. The
                  dashed preview redraws as this moves, from the world's own path
                  function, so what is shown is what will fly. */}
              {selected.movement.pattern !== "stationary" && <label className="range-field"><span><b>PATH ANGLE</b><em>{describeAngle(selected.movement.angle ?? 0)}</em></span><input type="range" min="-180" max="180" step="5" value={selected.movement.angle ?? 0} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, movement: { ...item.movement, angle: Number(event.target.value) } }))} /></label>}
              {/* How fast an arc turns its heading. Radius is speed over this:
                  a slow, gentle curve or a tight dive are both here. */}
              {selected.movement.pattern === "arc" && <label className="range-field"><span><b>CURVE</b><em>{describeAngle(selected.movement.curve ?? 0, "/s")}</em></span><input type="range" min="-180" max="180" step="5" value={selected.movement.curve ?? 0} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, movement: { ...item.movement, curve: Number(event.target.value) } }))} /></label>}
              {/* A turn while it flies, in degrees per second: a tumbling rock, a
                  spinning mine. TRANSFORM's ROTATION is where the sprite starts;
                  this is how fast it keeps turning. Zero is stored as absent, so a
                  level that never touched it saves as it did. */}
              <label className="range-field"><span><b>ROTATION</b><em>{selected.movement.spin ? `${selected.movement.spin}°/s` : "NONE"}</em></span><input type="range" min="-360" max="360" step="5" value={selected.movement.spin ?? 0} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, movement: { ...item.movement, spin: Number(event.target.value) === 0 ? undefined : Number(event.target.value) } }))} /></label>
              {/* The curve's three points as numbers, for exactness; the cyan
                  handles on the playfield are the way to shape it by eye. Offsets
                  from the object in the path's own frame, before PATH ANGLE. */}
              {selected.movement.pattern === "bezier" && <>
                {(selected.movement.points ?? defaultBezierPoints()).map((point, index) => <label className="field wide" key={index}><span>{index === 2 ? "END POINT" : `CONTROL POINT ${index + 1}`}</span>
                  <span className="bezier-xy">
                    <input type="number" step="10" value={Math.round(point.x)} aria-label={`${index === 2 ? "End point" : `Control point ${index + 1}`} X`} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, movement: { ...item.movement, points: (item.movement.points ?? defaultBezierPoints()).map((entry, i) => (i === index ? { ...entry, x: Number(event.target.value) } : entry)) as LevelItem["movement"]["points"] } }))} />
                    <input type="number" step="10" value={Math.round(point.y)} aria-label={`${index === 2 ? "End point" : `Control point ${index + 1}`} Y`} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, movement: { ...item.movement, points: (item.movement.points ?? defaultBezierPoints()).map((entry, i) => (i === index ? { ...entry, y: Number(event.target.value) } : entry)) as LevelItem["movement"]["points"] } }))} />
                  </span>
                </label>)}
                <p className="inspector-note">Drag the cyan handles on the playfield to shape the curve. Past the end point it flies straight on.</p>
              </>}
              {(selected.movement.pattern === "sine" || selected.movement.pattern === "zigzag") && <><label className="range-field"><span><b>AMPLITUDE</b><em>{selected.movement.amplitude}u</em></span><input type="range" min="10" max="200" value={selected.movement.amplitude} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, movement: { ...item.movement, amplitude: Number(event.target.value) } }))} /></label><label className="range-field"><span><b>FREQUENCY</b><em>{selected.movement.frequency.toFixed(2)}Hz</em></span><input type="range" min="0.1" max="1.5" step="0.05" value={selected.movement.frequency} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, movement: { ...item.movement, frequency: Number(event.target.value) } }))} /></label></>}
            </>)}

            {selected.type === "decoration" && section("decoration", "DECORATION", <>
              <label className="field wide"><span>DRAW LAYER</span><select value={selected.decoration?.layer ?? "background"} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, decoration: { ...(item.decoration ?? { layer: "background", opacity: .5, parallax: .5 }), layer: event.target.value as DecorationLayer } }))}><option value="background">BACKGROUND</option><option value="foreground">FOREGROUND</option></select></label>
              <label className="range-field"><span><b>OPACITY</b><em>{Math.round((selected.decoration?.opacity ?? .5) * 100)}%</em></span><input type="range" min="0.1" max="1" step="0.05" value={selected.decoration?.opacity ?? .5} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, decoration: { ...(item.decoration ?? { layer: "background", opacity: .5, parallax: .5 }), opacity: Number(event.target.value) } }))} /></label>
              <label className="range-field"><span><b>PARALLAX</b><em>{(selected.decoration?.parallax ?? .5).toFixed(2)}x</em></span><input type="range" min="0.1" max="2" step="0.05" value={selected.decoration?.parallax ?? .5} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, decoration: { ...(item.decoration ?? { layer: "background", opacity: .5, parallax: .5 }), parallax: Number(event.target.value) } }))} /></label>
            </>)}

            {(selected.type === "powerup" || selected.type === "upgrade") && section("pickup", selected.type === "powerup" ? "TIMED POWERUP" : "PERMANENT UPGRADE", <>
              {selected.type === "powerup" && <label className="range-field"><span><b>DURATION</b><em>{selected.pickup?.duration ?? 8}s</em></span><input type="range" min="1" max="30" value={selected.pickup?.duration ?? 8} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, pickup: { ...(item.pickup ?? { duration: 8, xSpeedBoost: 0, ySpeedBoost: 0, shotSpeedBoost: 0, shotPowerBoost: 100, gun: "none" }), duration: Number(event.target.value) } }))} /></label>}
              <div className="field-grid"><div className="field"><EbNumericInput label="X SPEED +" sliderEnabled={false} min={0} max={800} step={10} value={selected.pickup?.xSpeedBoost ?? 0} onValueChange={(xSpeedBoost) => updateItem(selected.id, (item) => ({ ...item, pickup: { ...(item.pickup ?? { duration: 8, xSpeedBoost: 0, ySpeedBoost: 0, shotSpeedBoost: 0, shotPowerBoost: 100, gun: "none" }), xSpeedBoost } }))} /></div><div className="field"><EbNumericInput label="Y SPEED +" sliderEnabled={false} min={0} max={800} step={10} value={selected.pickup?.ySpeedBoost ?? 0} onValueChange={(ySpeedBoost) => updateItem(selected.id, (item) => ({ ...item, pickup: { ...(item.pickup ?? { duration: 8, xSpeedBoost: 0, ySpeedBoost: 0, shotSpeedBoost: 0, shotPowerBoost: 100, gun: "none" }), ySpeedBoost } }))} /></div></div>
              <div className="field-grid"><div className="field"><EbNumericInput label="SHOT SPEED +" sliderEnabled={false} min={0} max={1600} step={25} value={selected.pickup?.shotSpeedBoost ?? 0} onValueChange={(shotSpeedBoost) => updateItem(selected.id, (item) => ({ ...item, pickup: { ...(item.pickup ?? { duration: 8, xSpeedBoost: 0, ySpeedBoost: 0, shotSpeedBoost: 0, shotPowerBoost: 100, gun: "none" }), shotSpeedBoost } }))} /></div><div className="field"><EbNumericInput label="SHOT POWER +" sliderEnabled={false} min={0} max={1000} step={100} value={selected.pickup?.shotPowerBoost ?? 0} onValueChange={(shotPowerBoost) => updateItem(selected.id, (item) => ({ ...item, pickup: { ...(item.pickup ?? { duration: 8, xSpeedBoost: 0, ySpeedBoost: 0, shotSpeedBoost: 0, shotPowerBoost: 100, gun: "none" }), shotPowerBoost } }))} /></div></div>
              <label className="field wide"><span>GRANT GUN</span><select value={selected.pickup?.gun ?? "none"} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, pickup: { ...(item.pickup ?? { duration: 8, xSpeedBoost: 0, ySpeedBoost: 0, shotSpeedBoost: 0, shotPowerBoost: 100, gun: "none" }), gun: event.target.value as GunType | "none" } }))}><option value="none">NO NEW GUN</option><option value="pulse">PULSE</option><option value="spread">SPREAD</option><option value="rapid">RAPID</option></select></label>
            </>)}

            {selected.type !== "decoration" && section("effects", "EXPLOSION & SOUND", <>
              <EffectField label="EXPLOSION" kind="explosion" components={level.components} value={selected.fx?.explosionId}
                onChange={(next) => updateSelectedItems((item) => ({ ...item, fx: withEffect(item.fx, "explosionId", next) }), "item-explosion")} />
              <EffectField label="DEATH SOUND" kind="sound" components={level.components} value={selected.fx?.deathSoundId}
                onChange={(next) => updateSelectedItems((item) => ({ ...item, fx: withEffect(item.fx, "deathSoundId", next) }), "item-death-sound")} />
              {(selected.type === "enemy" || selected.type === "group") && <EffectField label="FIRE SOUND" kind="sound" components={level.components} value={selected.fx?.fireSoundId}
                onChange={(next) => updateSelectedItems((item) => ({ ...item, fx: withEffect(item.fx, "fireSoundId", next) }), "item-fire-sound")} />}
              <p className="inspector-note">Designed in the palette under COMPONENTS. Several objects can point at one explosion or sound; editing it reaches all of them.</p>
            </>)}

            {(selected.type === "enemy" || selected.type === "group") && section("weapon", "WEAPON", <>
              <label className="toggle-row"><span>WEAPON ENABLED</span><input type="checkbox" checked={selected.weapon.enabled} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, weapon: { ...item.weapon, enabled: event.target.checked } }))} /><i /></label>
              {selected.weapon.enabled && <><div className="field-grid"><label className="field"><span>PROJECTILE</span><select value={selected.weapon.projectile} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, weapon: { ...item.weapon, projectile: event.target.value as ProjectileSprite } }))}><option value="bolt">BOLT</option><option value="plasma">PLASMA</option></select></label><label className="field"><span>MOTION</span><select value={selected.weapon.projectileMovement} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, weapon: { ...item.weapon, projectileMovement: event.target.value as "straight" | "sine" } }))}><option value="straight">STRAIGHT</option><option value="sine">SINE</option></select></label></div>
                <label className="range-field"><span><b>SHOTS / SEC</b><em>{selected.weapon.shotsPerSecond.toFixed(1)}</em></span><input type="range" min="0.1" max="4" step="0.1" value={selected.weapon.shotsPerSecond} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, weapon: { ...item.weapon, shotsPerSecond: Number(event.target.value) } }))} /></label>
                <label className="range-field"><span><b>COOLDOWN</b><em>{selected.weapon.cooldown.toFixed(1)}s</em></span><input type="range" min="0" max="4" step="0.1" value={selected.weapon.cooldown} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, weapon: { ...item.weapon, cooldown: Number(event.target.value) } }))} /></label>
                <label className="range-field"><span><b>PROJECTILE SPEED</b><em>{selected.weapon.projectileSpeed}u/s</em></span><input type="range" min="100" max="700" step="10" value={selected.weapon.projectileSpeed} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, weapon: { ...item.weapon, projectileSpeed: Number(event.target.value) } }))} /></label>
                <label className="range-field"><span><b>POWER</b><em>{selected.weapon.power}</em></span><input type="range" min="1" max="3" value={selected.weapon.power} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, weapon: { ...item.weapon, power: Number(event.target.value) } }))} /></label>
                {/* Where the gun sits on the ship, forward along the way it faces and across it,
                    in world units. NOSE and CENTRE are where every weapon fired from before there
                    was a choice; the sight on the playfield shows the spot. */}
                <label className="range-field"><span><b>MOUNT FORWARD</b><em>{selected.weapon.mount ? `${selected.weapon.mount.x}u` : "NOSE"}</em></span><input type="range" min="-120" max="120" step="2" value={selected.weapon.mount?.x ?? Math.round(selected.size * selected.scale)} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, weapon: { ...item.weapon, mount: { x: Number(event.target.value), y: item.weapon.mount?.y ?? 0 } } }))} /></label>
                <label className="range-field"><span><b>MOUNT ACROSS</b><em>{selected.weapon.mount ? `${selected.weapon.mount.y}u` : "CENTRE"}</em></span><input type="range" min="-120" max="120" step="2" value={selected.weapon.mount?.y ?? 0} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, weapon: { ...item.weapon, mount: { x: item.weapon.mount?.x ?? Math.round(item.size * item.scale), y: Number(event.target.value) } } }))} /></label>
                <button className="inspector-action" type="button" onClick={() => saveWeaponComponent(selected.weapon, `${selected.name} Weapon`)}>SAVE WEAPON COMPONENT</button>
                {/* The dropdown covers removal too, as NONE, so the separate
                    "remove pattern" button it replaced is gone rather than
                    sitting beside a control that already does its job. */}
                <BulletPatternField components={patternComponents} pattern={selected.weapon.pattern} onApply={(next) => updateItem(selected.id, (item) => ({ ...item, weapon: { ...item.weapon, enabled: true, pattern: next } }))} />
                <button className="inspector-action pattern-designer-button" type="button" onClick={() => setEditingPattern({ pattern: structuredClone(selected.weapon.pattern ?? createPatternPreset("Pendulum Sweep")), target: { kind: "item", id: selected.id } })}>{selected.weapon.pattern ? "EDIT THIS PATTERN" : "DESIGN A PATTERN"}</button>
              </>}
            </>)}
            </EbAccordion>
          </div>}
        </aside>
      </section>

      {presenting && <div className="present-exit-hint">ESC TO RETURN TO THE EDITOR</div>}
      <footer className="shortcut-bar"><span><kbd>T</kbd> PLAYTEST</span><span><kbd>SHIFT T</kbd> PRESENT</span><span><kbd>ESC</kbd> SELECT / BUILD</span><span><kbd>S</kbd> SCROLL</span><span><kbd>D</kbd> DUPLICATE</span><span><kbd>Q / E</kbd> ROTATE</span><span><kbd>CTRL / SHIFT</kbd> MULTI-SELECT</span><span><kbd>1–9</kbd> EQUIP</span><span><kbd>CTRL Z</kbd> UNDO</span><span className="gamepad-shortcut">GAMEPAD: <kbd>LS</kbd> MOVE <kbd>RS</kbd> SATELLITE <kbd>Y</kbd> CYCLE WEAPON <kbd>A / RT</kbd> FIRE</span><strong>THE FATE OF THE GALAXY IS IN YOUR HANDS.</strong></footer>
      {editingAsset && <SpriteStudio asset={editingAsset} onSave={saveSpriteAsset} onCancel={() => setEditingAsset(null)} />}
      {pendingConfirm && <EbDialog visible title={pendingConfirm.title} onVisibleChange={(open) => { if (!open) setPendingConfirm(null); }} showCloseButton={false} className="confirm-dialog" footerContent={<>
        <button type="button" onClick={() => setPendingConfirm(null)}>CANCEL</button>
        {pendingConfirm.alternate && <button type="button" onClick={() => { const act = pendingConfirm.alternate!.action; setPendingConfirm(null); act(); }}>{pendingConfirm.alternate.label}</button>}
        <button type="button" className="confirm-commit" onClick={() => { const act = pendingConfirm.action; setPendingConfirm(null); act(); }}>{pendingConfirm.confirmLabel ?? "CONFIRM"}</button>
      </>}><p>{pendingConfirm.message}</p></EbDialog>}
      {showSettings && <EbDialog visible title="EDITOR SETTINGS" onVisibleChange={(open) => { if (!open) setShowSettings(false); }} className="settings-dialog" footerContent={<button type="button" onClick={() => setShowSettings(false)}>DONE</button>}>
        <label className="field wide"><span>TOOLBAR BEHAVIOR</span><select value={sectionMode} onChange={(event) => applySectionMode(event.target.value as SectionMode)}><option value="multiple">SEVERAL SECTIONS OPEN</option><option value="single">ONE SECTION AT A TIME</option></select></label>
        <p className="inspector-note">Governs the collapsible sections in the palette and the Inspector alike. Kept in this browser rather than in the level.</p>
        <label className="field wide"><span>DISPLAY FILTER</span><select value={displayPrefs.pixelFilter} onChange={(event) => applyDisplayPref("pixelFilter", event.target.value as DisplayFilter)}><option value="none">NONE</option><option value="display-scanlines">SCANLINES</option><option value="lcd-grid">LCD GRID</option><option value="crt">CRT TUBE</option></select></label>
        {displayPrefs.pixelFilter === "display-scanlines" && <>
          <label className="range-field"><span><b>LINE BRIGHTNESS</b><em>{Math.round(displayPrefs.lineBrightness * 100)}%</em></span><input type="range" min="0" max="1" step="0.02" value={displayPrefs.lineBrightness} onChange={(event) => applyDisplayPref("lineBrightness", Number(event.target.value))} /></label>
          <label className="range-field"><span><b>BAND ROWS</b><em>{displayPrefs.bandRows}</em></span><input type="range" min="1" max="6" step="1" value={displayPrefs.bandRows} onChange={(event) => applyDisplayPref("bandRows", Number(event.target.value))} /></label>
        </>}
        {displayPrefs.pixelFilter === "lcd-grid" && <label className="range-field"><span><b>GRID THICKNESS</b><em>{displayPrefs.gridThickness.toFixed(1)}px</em></span><input type="range" min="0" max="4" step="0.5" value={displayPrefs.gridThickness} onChange={(event) => applyDisplayPref("gridThickness", Number(event.target.value))} /></label>}
        {displayPrefs.pixelFilter === "crt" && <>
          <label className="range-field"><span><b>TUBE</b><em>{Math.round(displayPrefs.crtAmount * 100)}%</em></span><input type="range" min="0" max="1" step="0.02" value={displayPrefs.crtAmount} onChange={(event) => applyDisplayPref("crtAmount", Number(event.target.value))} /></label>
          <label className="range-field"><span><b>GLOW</b><em>{Math.round(displayPrefs.crtGlow * 100)}%</em></span><input type="range" min="0" max="1" step="0.02" value={displayPrefs.crtGlow} onChange={(event) => applyDisplayPref("crtGlow", Number(event.target.value))} /></label>
          <label className="range-field"><span><b>NOISE</b><em>{Math.round(displayPrefs.crtNoise * 100)}%</em></span><input type="range" min="0" max="1" step="0.02" value={displayPrefs.crtNoise} onChange={(event) => applyDisplayPref("crtNoise", Number(event.target.value))} /></label>
        </>}
        <p className="inspector-note">{displayPrefs.pixelFilter === "none" ? "The played picture, as drawn." : "Applied while playing and presenting; the editor stays as drawn. Kept in this browser."}</p>
      </EbDialog>}
      {editingPattern && <BulletPatternStudio pattern={editingPattern.pattern} onApply={applyPatternEditor} onSaveComponent={savePatternComponent} onCancel={() => setEditingPattern(null)} />}
      {editingSound && <SfxStudio sound={editingSound.sound} onApply={saveSoundComponent} onCancel={() => setEditingSound(null)} />}
      {editingExplosion && <BurstDesigner explosions={explosions} single={{ name: editingExplosion.name, burst: editingExplosion.burst }} onSaveSingle={saveExplosionComponent} onApply={() => setEditingExplosion(null)} onCancel={() => setEditingExplosion(null)} />}
      {designingBursts && <BurstDesigner explosions={explosions} onCancel={() => setDesigningBursts(false)} onApply={(next) => { setExplosions(next); saveExplosions(next); setDesigningBursts(false); flash("EXPLOSIONS SAVED"); }} />}
    </main>
  );
}
