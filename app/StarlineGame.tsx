"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createHistory, createLoop, createPerformanceMonitor, defineLibrary, DocumentError, type PerfStats } from "@ccllc/arcade/core";
import { createInput } from "@ccllc/arcade/platform";
import { createSelection, createEditorCommands, createKeymap } from "@ccllc/arcade/editor";
import { uniqueId } from "@ccllc/arcade/core";
import { createTelemetry } from "@ccllc/arcade/telemetry";
import { createSpriteCache } from "@ccllc/arcade/render";
import { BulletPatternStudio, SpriteStudio } from "@ccllc/studio";
import { EbAccordion, EbAccordionItem, EbDialog, EbNumericInput, EbTabbedCard } from "@electricblazor/react";
import { drawSpriteAsset } from "@ccllc/studio/render";
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
  normalizeLevel,
  palette,
  VIEW_H,
  VIEW_W,
  type ArmorSettings,
  type ArmorType,
  type BulletPatternDefinition,
  type Burst,
  type ComponentDefinition,
  type DecorationLayer,
  type GroupPattern,
  type GunType,
  type Level,
  type LevelItem,
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
import { defaultLevel } from "./starter-level";

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

/** Short ids, the shape this game's saved levels already carry. */
const uid = () => uniqueId("item");
type Tool = "select" | "scroll" | "erase" | PaletteKey | `component:${string}`;
type PaletteTab = "objects" | "components" | "enhancements";
/** Toolbar Behavior: whether a tool panel keeps one section open, or several. */
type SectionMode = "single" | "multiple";
type PatternEditorTarget = { kind: "item"; id: string } | { kind: "weapon"; id: string } | { kind: "pattern"; id: string };

// Render-side only. Particles are not simulation state — nothing in the world
// reads one — so they live here, where Math.random is free to be Math.random.
type Particle = Point & { vx: number; vy: number; life: number; size: number; color: string };
type Star = Point & { size: number; speed: number; alpha: number };

type TransformOrigin = { id: string; x: number; y: number; rotation: number; scale: number };
type CanvasDrag =
  | { kind: "items"; ids: string[]; startWorld: Point; origins: TransformOrigin[]; startSnapshot: string }
  | { kind: "transform"; mode: "rotate" | "scale"; ids: string[]; center: Point; startAngle: number; startDistance: number; origins: TransformOrigin[]; startSnapshot: string }
  | { kind: "scroll"; startX: number; startCamera: number }
  | { kind: "end"; startSnapshot: string };

// Storage keys, above the two definitions that take them: both are read at
// module evaluation, and a const referenced before its own line is a TDZ
// ReferenceError rather than undefined.
const STORAGE_KEY = "starline-level-library-v1";
const DRAFT_KEY = "starline-level-draft-v1";
const SETTINGS_KEY = "starline-editor-settings-v1";

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
  limit: 60,
  migrate: (raw) => (raw && typeof raw === "object" && !Array.isArray(raw)
    ? Object.entries(raw as Record<string, Level>).map(([name, document]) => ({ name, document }))
    : []),
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

/** Half a baked region. The widest any recipe reaches is the comet's tail at
 *  1.7x size; the constant covers the shadow blur, the stroke and slack. */
const bakeHalf = (size: number) => Math.ceil(size * 1.75 + 22);

/** The recipe: one sprite, at the origin, with no transform of its own. */
function paintSprite(context: CanvasRenderingContext2D, sprite: string, size: number, selected: boolean, assets: SpriteAsset[], tint: number) {
  if (tint) context.filter = `hue-rotate(${tint}deg)`;
  const isPickup = sprite === "energy" || sprite === "upgrade";
  context.shadowColor = sprite === "asteroid" ? "#87939c" : isPickup ? "#eaff62" : "#ff6a4d";
  context.shadowBlur = selected ? 24 : 11;
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
 * Null for the three cases where a cache would lose: a sprite too big to be
 * numerous, and the selected one, of which there is exactly one on screen and
 * whose dashed ring would otherwise double the key space for nothing.
 */
function spriteRegion(sprite: string, size: number, selected: boolean, assets: SpriteAsset[], tint: number) {
  if (selected || !(size > 0) || size > BAKE_MAX_SIZE) return null;
  let key = `${sprite}|${size}|${tint}`;
  if (sprite.startsWith("asset:")) {
    const asset = assets.find((entry) => `asset:${entry.id}` === sprite);
    // An unresolved asset draws nothing and must not be cached under a key
    // that would still miss once the asset arrives.
    if (!asset) return null;
    key += `|${assetIdentity(asset)}`;
  }
  const half = bakeHalf(size);
  return spriteCache.sprite(key, half * 2, half * 2, (own) => {
    own.translate(half, half);
    paintSprite(own, sprite, size, false, assets, tint);
  });
}

function drawSprite(context: CanvasRenderingContext2D, sprite: string, x: number, y: number, size: number, selected = false, alpha = 1, rotation = 0, scale = 1, faceLeft = false, assets: SpriteAsset[] = [], tint = 0) {
  const region = spriteRegion(sprite, size, selected, assets, tint);
  context.save();
  context.translate(x, y);
  context.rotate(rotation * Math.PI / 180);
  context.scale(scale * (faceLeft && (sprite === "raider" || sprite === "wraith" || sprite === "carrier") ? -1 : 1), scale);
  context.globalAlpha = alpha;
  if (region) context.drawImage(region.canvas, region.x, region.y, region.width, region.height, -region.width / 2, -region.height / 2, region.width, region.height);
  else paintSprite(context, sprite, size, selected, assets, tint);
  context.restore();
}

function drawShip(context: CanvasRenderingContext2D, x: number, y: number, now: number, sprite: string = "dart", blink = false, assets: SpriteAsset[] = [], tint = 0) {
  if (blink) return;
  if (sprite.startsWith("asset:")) { drawSprite(context, sprite as Sprite, x, y, 27, false, 1, 0, 1, false, assets, tint); return; }
  context.save(); context.translate(x, y);
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
  const satellitePointerRef = useRef({ x: VIEW_W * .7, y: VIEW_H / 2, active: false });
  const mouseFireRef = useRef(false);
  const dragRef = useRef<CanvasDrag | null>(null);
  const miniDragRef = useRef<{ offset: number } | null>(null);
  const starsRef = useRef<Star[]>([]);
  // Particles are the renderer's, not the world's. The world asks for an
  // explosion at a point in a colour; what that means in pixels is decided here,
  // which is why Math.random can still be Math.random.
  const particlesRef = useRef<Particle[]>([]);
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

  const [level, setLevel] = useState<Level>(defaultLevel);
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
  const [camera, setCamera] = useState(0);
  const [score, setScore] = useState(0);
  const [lives, setLives] = useState(3);
  const [hullMax, setHullMax] = useState(3);
  const [shield, setShield] = useState(0);
  const [progress, setProgress] = useState(0);
  const [savedNames, setSavedNames] = useState<string[]>([]);
  const [loadName, setLoadName] = useState("");
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
  const [paletteTab, setPaletteTab] = useState<PaletteTab>("objects");
  const [editingAsset, setEditingAsset] = useState<SpriteAsset | null>(null);
  const [editingPattern, setEditingPattern] = useState<{ pattern: BulletPatternDefinition; target: PatternEditorTarget } | null>(null);
  const editingPatternRef = useRef(false);
  useEffect(() => { editingPatternRef.current = editingPattern !== null; }, [editingPattern]);
  // The destructive confirms, replacing window.confirm: what to ask, and what
  // to do on yes. window.confirm blocked the whole tab and dodged the game's
  // keyboard handling by accident; the dialog has to declare itself, hence the
  // ref the keydown handler checks.
  const [pendingConfirm, setPendingConfirm] = useState<{ title: string; message: string; action: () => void } | null>(null);
  const pendingConfirmRef = useRef(false);
  useEffect(() => { pendingConfirmRef.current = pendingConfirm !== null; }, [pendingConfirm]);
  const showSettingsRef = useRef(false);
  useEffect(() => { showSettingsRef.current = showSettings; }, [showSettings]);

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
    starsRef.current = createStars(155);
    try {
      // A shared link wins over the local draft: the player followed it to see
      // somebody else's sector, not to resume their own. Reading it also clears
      // the fragment, so a reload does not reopen it over the later edits.
      const shared = levelDocument.readShareFromLocation();
      let restored: Level | null = shared.document;
      if (!restored) {
        // Already parsed, and already null rather than a throw if the stored
        // draft will not read -- so the try/catch this replaces is the
        // library's problem now.
        restored = levelLibrary.readDraft();
      }
      // A deliberate second render: the exported HTML is built with the
      // starter level, so the first client render has to match it, and
      // localStorage only gets a say after mount. The rule is right that
      // this cascades; here the cascade is the feature.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (restored) installLevel(restored, true);
      // Same two-phase load and the same reason: a link that will not decode
      // has to say so, and there is nowhere earlier to say it from.
      if (shared.error) flash("SHARED LINK UNREADABLE");
      const names = levelLibrary.list().map((saved) => saved.name).sort();
      setSavedNames(names);
      setLoadName(names[0] || "");
    } catch { /* use the starter level */ }
  }, [flash, installLevel]);

  // Toolbar Behavior belongs to the user, not to the level, so it is stored
  // beside the level library rather than inside it — and like the draft above,
  // it can only be read after mount, because the exported HTML was built
  // without it.
  useEffect(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || "{}") as { sectionMode?: SectionMode };
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (stored.sectionMode === "single" || stored.sectionMode === "multiple") setSectionMode(stored.sectionMode);
    } catch { /* storage can be unavailable */ }
  }, []);

  // Written where the choice is made rather than from an effect on the value:
  // one control changes it, and an effect would race the restore above and put
  // the default back over the stored choice on the way in.
  const applySectionMode = useCallback((next: SectionMode) => {
    setSectionMode(next);
    try { window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ sectionMode: next })); } catch { /* storage can be unavailable */ }
  }, []);

  useEffect(() => {
    if (mode !== "build") return;
    const timer = window.setTimeout(() => {
      levelLibrary.saveDraft(level);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [level, mode]);

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
        y: clamp(copy.y + 45, 30, VIEW_H - 30),
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

  const saveLevel = useCallback(() => {
    const current = levelRef.current;
    const name = current.name.trim() || "Untitled Sector";
    // Upsert by name, so Save over a sector of the same name replaces it
    // rather than growing a second copy of it every time.
    const entry = levelLibrary.save(current, { name });
    if (!entry) { flash("SAVE FAILED — THIS BROWSER BLOCKED LOCAL SAVES"); return; }
    setSavedNames(levelLibrary.list().map((saved) => saved.name).sort());
    setLoadName(entry.name); flash("LEVEL SAVED TO THIS DEVICE");
  }, [flash]);

  const loadLevel = useCallback(() => {
    if (!loadName) return;
    const next = levelLibrary.readByName(loadName);
    if (!next) { flash("THAT SAVED LEVEL IS NO LONGER AVAILABLE"); return; }
    installLevel(next, true); setCamera(0); editorCameraRef.current = 0; flash(`LOADED ${loadName.toUpperCase()}`);
  }, [flash, installLevel, loadName]);

  const exportLevel = useCallback(() => {
    try { levelDocument.download(levelRef.current); flash("JSON EXPORTED"); }
    catch (error) { flash(documentMessage(error, "EXPORT FAILED")); }
  }, [flash]);

  const importLevel = useCallback(async (file: File) => {
    try {
      const parsed = await levelDocument.readFile(file);
      installLevel(parsed, true); setCamera(0); editorCameraRef.current = 0; flash("LEVEL IMPORTED");
    } catch (error) { flash(documentMessage(error, "INVALID LEVEL FILE")); }
  }, [flash, installLevel]);

  // A whole sector in the URL fragment: no server and no account, the same
  // trade Pinball already makes. The cap is the library's 256 KB default, and a
  // sector carrying several hand-drawn sprite assets can reach it -- which is
  // what the "too large to share" refusal is for.
  const shareLevel = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(levelDocument.shareLink(levelRef.current));
      flash("SHARE LINK COPIED");
    } catch (error) { flash(documentMessage(error, "SHARE FAILED")); }
  }, [flash]);

  // The renderer decides what an explosion looks like. The world only asks for
  // one, which is what lets the simulation stay free of Math.random.
  const spawnBursts = useCallback((bursts: Burst[]) => {
    const particles = particlesRef.current;
    for (const request of bursts) {
      for (let i = 0; i < request.count; i += 1) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 60 + Math.random() * 240;
        particles.push({ x: request.x, y: request.y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: .3 + Math.random() * .55, size: 2 + Math.random() * 5, color: request.color });
      }
    }
  }, []);

  const enterPlay = useCallback(() => {
    const world = createWorld(levelRef.current);
    worldRef.current = world;
    particlesRef.current = [];
    inputRef.current?.releaseAll();
    satellitePointerRef.current = { x: VIEW_W * .7, y: VIEW_H / 2, active: false };
    mouseFireRef.current = false;
    setScore(0); setLives(world.state.hullMax); setHullMax(world.state.hullMax);
    setShield(Math.round(world.state.player.shield)); setProgress(0);
    setMode("playing"); modeRef.current = "playing"; flash("PLAYTEST ACTIVE");
  }, [flash]);

  const exitPlay = useCallback(() => {
    inputRef.current?.releaseAll();
    worldRef.current = null;
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
        y: clamp(item.y + dy, 30, VIEW_H - 30),
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
      { code: "KeyS", ctrl: true, allowInTextEntry: true, label: "Save", run: () => saveLevel() },
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
      if (editingPatternRef.current || pendingConfirmRef.current || showSettingsRef.current) return;
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
    // The frame handle and the previous timestamp belong to createLoop now.
    let miniWidth = 800;
    let miniHeight = 86;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr);
      const scale = Math.min(rect.width / VIEW_W, rect.height / VIEW_H);
      const offsetX = (rect.width - VIEW_W * scale) / 2;
      const offsetY = (rect.height - VIEW_H * scale) / 2;
      viewportRef.current = { scale, offsetX, offsetY };
      context.setTransform(scale * dpr, 0, 0, scale * dpr, offsetX * dpr, offsetY * dpr);
      const miniRect = mini.getBoundingClientRect();
      miniWidth = miniRect.width; miniHeight = miniRect.height;
      mini.width = Math.round(miniWidth * dpr); mini.height = Math.round(miniHeight * dpr);
      miniContext.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
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

      return {
        dx: input.axis("left", "right"),
        dy: input.axis("up", "down"),
        fire: input.isDown("fire") || mouseFireRef.current,
        satelliteAxis: { x: input.axis("satLeft", "satRight"), y: input.axis("satUp", "satDown") },
        satellitePointer: satellitePointerRef.current,
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
      drawBackground(cameraX, false, 0);
      const drawPlacedItem = (item: LevelItem) => {
        const selectedItem = editorFor().selection.ids.includes(item.id);
        const offsets = groupOffsets(item.group, item.rotation, item.scale);
        offsets.forEach((offset, index) => {
          const screenX = item.x + offset.x - cameraX;
          if (screenX < -240 || screenX > VIEW_W + 240) return;
          const alpha = item.type === "decoration" ? item.decoration?.opacity ?? .5 : item.type === "group" ? .82 : 1;
          drawSprite(context, item.sprite, screenX, item.y + offset.y, item.size, selectedItem && index === 0, alpha, item.rotation, item.scale, item.type === "enemy" || item.type === "group", current.assets, item.tint);
        });
        if (item.type === "group" && item.x - cameraX > -100 && item.x - cameraX < VIEW_W + 100) {
          context.fillStyle = "#eaff62"; context.font = "10px monospace"; context.fillText(`GROUP x${item.group?.count ?? 1}`, item.x - cameraX - 28, item.y - item.size * item.scale - 22);
        }
        if ((item.type === "powerup" || item.type === "upgrade") && item.x - cameraX > -100 && item.x - cameraX < VIEW_W + 100) {
          context.fillStyle = item.type === "powerup" ? "#eaff62" : "#64e3ff"; context.font = "9px monospace"; context.fillText(item.type.toUpperCase(), item.x - cameraX - 22, item.y - item.size * item.scale - 15);
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
        context.font = "11px monospace"; context.fillText(worldX.toString().padStart(5, "0"), x + 7, 20);
      }
      const selected = current.items.find((item) => item.id === editorFor().selection.primary);
      if (selected && selected.movement.pattern !== "stationary") {
        context.save(); context.translate(-cameraX, 0); context.strokeStyle = "rgba(100,227,255,.45)"; context.lineWidth = 2; context.setLineDash([5, 7]); context.beginPath();
        for (let step = -260; step <= 260; step += 8) {
          const t = -step / Math.max(1, selected.movement.speed);
          let pathY = selected.y;
          if (selected.movement.pattern === "sine") pathY += Math.sin(t * selected.movement.frequency * Math.PI * 2) * selected.movement.amplitude;
          if (selected.movement.pattern === "zigzag") pathY += Math.asin(Math.sin(t * selected.movement.frequency * Math.PI * 2)) * 2 / Math.PI * selected.movement.amplitude;
          if (step === -260) context.moveTo(selected.x + step, pathY); else context.lineTo(selected.x + step, pathY);
        }
        context.stroke(); context.restore();
      }
      current.items.filter((item) => item.type !== "decoration").forEach(drawPlacedItem);
      current.items.filter((item) => item.type === "decoration" && item.decoration?.layer === "foreground").forEach(drawPlacedItem);
      const selectedItems = current.items.filter((item) => editorFor().selection.ids.includes(item.id)); const geometry = selectionGeometry(selectedItems);
      if (geometry) {
        const left = geometry.left - cameraX; const right = geometry.right - cameraX; const top = geometry.top; const bottom = geometry.bottom; const centerX = geometry.center.x - cameraX;
        context.save(); context.shadowBlur = 0; context.setLineDash([6, 5]); context.strokeStyle = "rgba(234,255,98,.78)"; context.lineWidth = 2; context.strokeRect(left, top, right - left, bottom - top); context.setLineDash([]);
        context.beginPath(); context.moveTo(centerX, top); context.lineTo(centerX, top - 30); context.stroke();
        context.fillStyle = "#09131b"; context.strokeStyle = "#eaff62"; context.lineWidth = 3; context.beginPath(); context.arc(centerX, top - 34, 9, 0, Math.PI * 2); context.fill(); context.stroke();
        context.fillStyle = "#eaff62"; context.strokeStyle = "#09131b"; context.lineWidth = 2; context.fillRect(right - 9, bottom - 9, 18, 18); context.strokeRect(right - 9, bottom - 9, 18, 18);
        context.fillStyle = "#eaff62"; context.font = "bold 10px monospace"; context.fillText(selectedItems.length > 1 ? `${selectedItems.length} SELECTED` : "ROTATE / SCALE", left, Math.max(14, top - 13)); context.restore();
      }
      const endX = current.length - cameraX;
      if (endX >= -24 && endX <= VIEW_W + 24) {
        context.strokeStyle = "#ff6a4d"; context.lineWidth = 2; context.setLineDash([8, 6]);
        context.beginPath(); context.moveTo(endX, 0); context.lineTo(endX, VIEW_H); context.stroke(); context.setLineDash([]);
        context.fillStyle = "#ff8a74"; context.fillRect(endX - 7, 0, 14, 28); context.font = "bold 11px monospace"; context.fillText("DRAG END LEVEL", endX - 105, 47);
      }
      if (current.items.length === 0) {
        context.fillStyle = "rgba(201,222,230,.38)"; context.font = "14px monospace"; context.textAlign = "center";
        context.fillText("SELECT AN OBJECT FROM THE PALETTE, THEN PLACE IT HERE", VIEW_W / 2, VIEW_H / 2); context.textAlign = "start";
      }
      drawShip(context, 95, VIEW_H / 2, now, current.player.sprite, false, current.assets, current.player.tint);
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
      spawnBursts(world.drainBursts());

      const particles = particlesRef.current;
      particles.forEach((particle) => { particle.x += particle.vx * dt; particle.y += particle.vy * dt; particle.vx *= .985; particle.vy *= .985; particle.life -= dt; });
      particlesRef.current = particles.filter((particle) => particle.life > 0);

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
      drawBackground(runtime.camera, modeRef.current === "playing", dt);
      const drawRuntimeItem = (enemy: RuntimeEnemy) => {
        if (!enemy.alive || !enemy.active) return;
        const parallax = enemy.type === "decoration" ? enemy.decoration?.parallax ?? 1 : 1;
        const x = enemy.x - runtime.camera * parallax;
        if (x < -260 || x > VIEW_W + 260) return;
        drawSprite(context, enemy.sprite, x, enemy.y, enemy.size, false, enemy.type === "decoration" ? enemy.decoration?.opacity ?? .5 : 1, enemy.rotation, enemy.scale, enemy.type === "enemy", levelRef.current.assets, enemy.tint);
        if (enemy.shield > 0 && enemy.armor?.type === "forcefield") { context.strokeStyle = "rgba(100,227,255,.7)"; context.lineWidth = 2; context.beginPath(); context.arc(x, enemy.y, enemy.size * enemy.scale + 8, 0, Math.PI * 2); context.stroke(); }
      };
      runtime.enemies.filter((item) => item.type === "decoration" && item.decoration?.layer === "background").forEach(drawRuntimeItem);
      for (const bullet of runtime.bullets) {
        const x = bullet.x - runtime.camera; context.shadowColor = bullet.color; context.shadowBlur = 15; context.fillStyle = bullet.color; context.fillRect(x - 15, bullet.y - 2, 20, 4);
      }
      context.shadowBlur = 0;
      for (const bullet of runtime.enemyBullets) {
        const x = bullet.x - runtime.camera; context.shadowColor = bullet.color; context.shadowBlur = 14; context.fillStyle = bullet.color;
        context.beginPath(); context.arc(x, bullet.y, bullet.radius, 0, Math.PI * 2); context.fill();
      }
      context.shadowBlur = 0;
      runtime.enemies.filter((item) => item.type !== "decoration").forEach(drawRuntimeItem);
      for (const particle of particlesRef.current) {
        context.globalAlpha = Math.min(1, particle.life * 2.5); context.fillStyle = particle.color; context.fillRect(particle.x - runtime.camera, particle.y, particle.size, particle.size);
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
      drawShip(context, player.x, player.y, now, levelRef.current.player.sprite, player.invulnerable > 0 && Math.floor(player.invulnerable * 10) % 2 === 0, levelRef.current.assets, levelRef.current.player.tint);
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
        const x = item.x / current.length * miniWidth; const y = item.y / VIEW_H * miniHeight;
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
        drawMini();
        // Last thing in the frame, so the steps the next frame runs all see the
        // input as it was when that frame began.
        frameInput = pollInput();
      },
    });
    loop.start();
    return () => { loop.stop(); observer.disconnect(); };
  }, [editorFor, enterPlay, equipInventoryWeapon, exitPlay, spawnBursts]);

  const canvasPoint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const viewport = viewportRef.current;
    return {
      x: clamp((event.clientX - rect.left - viewport.offsetX) / viewport.scale, 0, VIEW_W),
      y: clamp((event.clientY - rect.top - viewport.offsetY) / viewport.scale, 0, VIEW_H),
    };
  };

  const findItem = (world: Point) => {
    const items = levelRef.current.items;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i]; const radius = item.size * item.scale + 24;
      const hit = groupOffsets(item.group, item.rotation, item.scale).some((offset) => {
        const x = world.x - item.x - offset.x; const y = world.y - item.y - offset.y;
        return x * x + y * y < radius ** 2;
      });
      if (hit) return item;
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
      const selectedItems = levelRef.current.items.filter((item) => editorFor().selection.ids.includes(item.id)); const geometry = selectionGeometry(selectedItems);
      if (geometry) {
        const origins = selectedItems.map((item) => ({ id: item.id, x: item.x, y: item.y, rotation: item.rotation, scale: item.scale }));
        const rotateDistance = Math.hypot(world.x - geometry.center.x, world.y - (geometry.top - 34)); const scaleDistance = Math.hypot(world.x - geometry.right, world.y - geometry.bottom);
        if (rotateDistance <= 18 || scaleDistance <= 22) {
          dragRef.current = { kind: "transform", mode: rotateDistance <= 18 ? "rotate" : "scale", ids: editorFor().selection.ids.slice(), center: geometry.center, startAngle: Math.atan2(world.y - geometry.center.y, world.x - geometry.center.x), startDistance: Math.max(1, Math.hypot(world.x - geometry.center.x, world.y - geometry.center.y)), origins, startSnapshot: JSON.stringify(levelRef.current) }; return;
        }
      }
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
      updateLevel((current) => ({ ...current, items: current.items.map((item) => { const origin = drag.origins.find((entry) => entry.id === item.id); return origin ? { ...item, x: Math.round(clamp(origin.x + dx, 0, current.length)), y: Math.round(clamp(origin.y + dy, 30, VIEW_H - 30)) } : item; }) }), false);
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
  const componentCategories = ["ENEMIES", "TERRAIN", "GROUPS", "POWERUPS", "UPGRADES", "DECORATIONS", "WEAPONS", "PATTERNS", "ARMOR", "SATELLITES"];
  // Components are what the user saved; Enhancements are the fixed library that
  // arrives with every level. The id prefix already told the two apart — it is
  // what gates the delete button — so the split needed nothing added to the
  // level format and no migration for levels saved before it.
  const savedComponents = level.components.filter((component) => component.id.startsWith("component-"));
  const enhancements = level.components.filter((component) => !component.id.startsWith("component-"));
  const componentCategory = (component: ComponentDefinition) => component.kind === "enemy" ? "ENEMIES" : component.kind === "terrain" ? "TERRAIN" : component.kind === "group" ? "GROUPS" : component.kind === "powerup" ? "POWERUPS" : component.kind === "upgrade" ? "UPGRADES" : component.kind === "decoration" ? "DECORATIONS" : component.kind === "weapon" ? "WEAPONS" : component.kind === "pattern" ? "PATTERNS" : component.kind === "armor" ? "ARMOR" : "SATELLITES";
  const setCameraSafe = (next: number) => {
    if (next + VIEW_W > levelRef.current.length) {
      const length = Math.ceil((next + VIEW_W) / 500) * 500;
      updateLevel((current) => ({ ...current, length }), true, "infinite-scroll");
    }
    const value = clamp(next, 0, Math.max(0, levelRef.current.length - VIEW_W)); setCamera(value); editorCameraRef.current = value;
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
  const section = (key: string, title: string, children: ReactNode, group = "inspector") => (
    <EbAccordionItem key={key} title={title} expanded={sectionMode === "single" ? openSections[group] === key : !collapsedSections[key]} onExpandedChange={(expanded) => {
      setOpenSections((current) => expanded ? { ...current, [group]: key } : current[group] === key ? { ...current, [group]: "" } : current);
      setCollapsedSections((current) => ({ ...current, [key]: !expanded }));
    }}>{children}</EbAccordionItem>
  );

  // A saved Component and a built-in Enhancement are the same card in two
  // tabs; only the corner action differs, because only one of the two is the
  // user's to delete.
  const componentSections = (entries: ComponentDefinition[], prefix: string) => componentCategories.map((category) => {
    const inCategory = entries.filter((component) => componentCategory(component) === category);
    if (!inCategory.length) return null;
    return section(`${prefix}-${category}`, category, <div className="palette-category-items">{inCategory.map((component) => <div className="component-card-row" key={component.id}><button className={`palette-card ${tool === `component:${component.id}` ? "active" : ""}`} type="button" onClick={() => { if (component.object) { const value = `component:${component.id}` as Tool; setTool(value); toolRef.current = value; setInspectPlayer(false); } else applyEquipmentComponent(component); }}><span className={`sprite-icon ${component.object && !component.object.sprite.startsWith("asset:") ? component.object.sprite : component.kind === "weapon" ? "turret" : component.kind === "armor" ? "energy" : component.kind === "pattern" ? "blade" : "upgrade"}`} /><span><strong>{component.name}</strong><small>{component.object ? "PLACE COMPONENT" : component.kind === "weapon" ? `${component.weapon?.tag.toUpperCase()} WEAPON` : component.kind === "pattern" ? `${component.pattern?.spawns.length ?? 0} EMITTER PATTERN` : component.kind.toUpperCase()}</small></span><b>{component.object ? "+" : component.kind === "pattern" ? "EDIT / USE" : "USE"}</b></button>{component.id.startsWith("component-") ? <button className="component-delete" type="button" onClick={() => deleteComponent(component.id)} title="Delete Component">×</button> : <button className="component-save" type="button" onClick={() => saveAsComponent(component)} title="Save as Component">+</button>}</div>)}</div>, "palette");
  });

  return (
    <main className="editor-app">
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
          {mode === "build" ? <button className="test-button" type="button" onClick={enterPlay}><kbd>T</kbd> TEST RUN <b>▶</b></button> : <button className="exit-button" type="button" onClick={exitPlay}><kbd>ESC</kbd> RETURN TO BUILD</button>}
        </div>
      </header>

      <section className="levelbar" aria-label="Level controls">
        <label className="level-name"><span>LEVEL</span><input value={level.name} onChange={(event) => updateLevel((current) => ({ ...current, name: event.target.value }), true, "level-name")} /></label>
        <label className="length-control"><span>END LEVEL</span><input type="number" min="1600" step="250" value={level.length} onChange={(event) => {
          const length = Math.max(1600, Number(event.target.value) || 1600);
          updateLevel((current) => ({ ...current, length }), true, "level-length"); setCameraSafe(Math.min(editorCameraRef.current, length - VIEW_W));
        }} /><em>u</em></label>
        <div className="file-actions">
          <button type="button" onClick={() => setPendingConfirm({ title: "NEW LEVEL", message: "Start a new empty level? Your current draft will be replaced.", action: () => { const next = { ...defaultLevel(), name: "Untitled Sector", items: [] }; installLevel(next, true); setCameraSafe(0); flash("NEW LEVEL CREATED"); } })}>NEW</button>
          <button type="button" onClick={saveLevel}>SAVE</button>
          <select value={loadName} onChange={(event) => setLoadName(event.target.value)} aria-label="Saved levels"><option value="">LOAD LEVEL...</option>{savedNames.map((name) => <option value={name} key={name}>{name}</option>)}</select>
          <button type="button" onClick={loadLevel} disabled={!loadName}>LOAD</button>
          <button type="button" onClick={() => importRef.current?.click()}>IMPORT</button>
          <button type="button" onClick={exportLevel}>EXPORT</button>
          <button type="button" onClick={() => void shareLevel()}>SHARE</button>
          <input ref={importRef} className="hidden-input" type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importLevel(file); event.target.value = ""; }} />
        </div>
      </section>

      <section className={`workspace ${mode !== "build" ? "is-playing" : ""}`} id="workspace">
        <aside className="palette-panel">
          <div className="panel-heading"><span>FOUNDRY PALETTE</span><small>{level.items.length} PLACED</small></div>
          <button className="player-card" type="button" onClick={() => { setTool("select"); toolRef.current = "select"; setSelection([]); setInspectPlayer(true); }}><span className={`player-icon ${level.player.sprite.startsWith("asset:") ? "asset-custom" : level.player.sprite}`} /><span><strong>PLAYER SHIP</strong><small>{level.player.sprite.startsWith("asset:") ? "CUSTOM" : level.player.sprite.toUpperCase()} / {level.player.weaponSlots.length} WEAPON SLOT{level.player.weaponSlots.length === 1 ? "" : "S"}</small></span><b>EDIT</b></button>
          <div className="tool-strip">
            {(["select", "scroll", "erase"] as Tool[]).map((value) => <button type="button" className={tool === value ? "active" : ""} onClick={() => { setTool(value); toolRef.current = value; }} key={value}><b>{value === "select" ? "↖" : value === "scroll" ? "↔" : "⌫"}</b>{value.toUpperCase()}</button>)}
          </div>
          {/* The OBJECTS / COMPONENTS / ENHANCEMENTS switch is ElectricBlazor's
              tabbed card in its bare form, moved below the player card and
              tools so the strip sits directly on the list it switches — which
              is also what lets the list live inside the tab panel it belongs
              to. The third tab arrived with the Components split; equal-width
              tabs went with it, since ENHANCEMENTS does not fit a third of a
              214px column. */}
          <EbTabbedCard<PaletteTab>
            items={[{ value: "objects", label: "OBJECTS" }, { value: "components", label: "COMPONENTS" }, { value: "enhancements", label: "ENHANCEMENTS" }]}
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
              <div className="asset-actions"><button type="button" onClick={() => setEditingAsset({ id: uid(), name: "New Raster", kind: "raster", width: 16, height: 16, pixels: Array(256).fill("") })}>+ RASTER SPRITE</button><button type="button" onClick={() => setEditingAsset({ id: uid(), name: "New Vector", kind: "vector", width: 256, height: 256, shapes: [] })}>+ VECTOR SPRITE</button></div>
              {level.assets.length > 0 && section("SPRITES", "SPRITES", <div className="palette-category-items">{level.assets.map((asset) => <div className="component-card-row" key={asset.id}><button className="palette-card" type="button" onClick={() => setEditingAsset(structuredClone(asset))}><SpriteAssetPreview asset={asset} /><span><strong>{asset.name}</strong><small>{asset.kind.toUpperCase()} / {asset.width}×{asset.height}</small></span><b>EDIT</b></button><button className="component-delete" type="button" onClick={() => deleteSpriteAsset(asset.id)} title="Delete sprite">×</button></div>)}</div>, "palette")}
              {componentSections(savedComponents, "COMP")}
              {!savedComponents.length && !level.assets.length && <p className="palette-empty">Nothing saved yet. Select an Object and choose SAVE AS COMPONENT, or keep a copy of one of the Enhancements.</p>}
            </> : componentSections(enhancements, "ENH")}
          </EbAccordion>}
          />
          <p className="palette-hint">{paletteTab === "objects" ? "Choose an object, then click the playfield to place it." : paletteTab === "components" ? "What you have saved: place your Objects, equip your Components, or author custom sprite assets." : "The built-in library. Apply one to the current selection, or keep an editable copy of it with +."}</p>
        </aside>

        <section className="stage-panel">
          <div className="stage-toolbar">
            <div><span>SECTOR POSITION</span><strong>{Math.round(camera).toString().padStart(5, "0")} — {Math.round(Math.min(level.length, camera + VIEW_W)).toString().padStart(5, "0")}</strong></div>
            <div className="camera-controls"><button type="button" onClick={() => setCameraSafe(camera - VIEW_W * .7)}>◀</button><input type="range" min="0" max={Math.max(0, level.length - VIEW_W)} value={camera} onChange={(event) => setCameraSafe(Number(event.target.value))} aria-label="Horizontal level position" /><button type="button" onClick={() => setCameraSafe(camera + VIEW_W * .7)}>▶</button></div>
            <span className="zoom-readout">1:1 VIEW</span>
          </div>
          <div className="stage-canvas-wrap">
            <canvas
              ref={mainCanvasRef}
              onPointerDown={onCanvasDown}
              onPointerMove={onCanvasMove}
              onPointerUp={finishCanvasDrag}
              onPointerCancel={finishCanvasDrag}
              onWheel={(event) => { if (modeRef.current === "build") { event.preventDefault(); setCameraSafe(editorCameraRef.current + event.deltaY + event.deltaX); } }}
              onContextMenu={(event) => event.preventDefault()}
              aria-label={mode === "build" ? "Scrollable level editing playfield" : "Playable Starline level"}
            />
            <div className="scanlines" aria-hidden="true" />
            {mode !== "build" && <div className="play-hud">
              <div><span>SCORE</span><strong>{score.toString().padStart(6, "0")}</strong></div>
              <div className="play-progress"><span>SECTOR CLEARANCE</span><i><b style={{ width: `${progress}%` }} /></i></div>
              <div><span>HULL {lives}/{hullMax}{level.player.armor.type === "forcefield" ? ` // SHIELD ${shield}` : ""}</span><strong className="hull-pips">{Array.from({ length: hullMax }, (_, life) => <i className={life < lives ? "live" : ""} key={life} />)}</strong></div>
            </div>}
            {(mode === "paused" || mode === "gameover" || mode === "victory") && <div className="play-overlay">
              <span>{mode === "paused" ? "FLIGHT SUSPENDED" : mode === "victory" ? "SECTOR SECURED" : "MISSION TERMINATED"}</span>
              <h1>{mode === "paused" ? "PAUSED" : mode === "victory" ? "LEVEL CLEAR" : "SIGNAL LOST"}</h1>
              <p>{mode === "paused" ? "Press P or Start to resume. Escape, B, or Back returns to edit." : "Press Enter to run again. Escape, B, or Back returns to the Foundry."}</p>
              <div><button type="button" onClick={mode === "paused" ? () => { setMode("playing"); modeRef.current = "playing"; } : enterPlay}>{mode === "paused" ? "RESUME" : "RETRY"}</button><button type="button" onClick={exitPlay}>RETURN TO BUILD</button></div>
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
          <div className="panel-heading"><span>INSPECTOR</span>{selected && <button type="button" onClick={deleteSelected}>DELETE {selectedIds.length > 1 ? selectedIds.length : ""}</button>}</div>
          {inspectPlayer ? <div className="inspector-form player-settings">
            <div className="type-tag"><span>EDITING</span><strong>PLAYER SHIP</strong><span className={`player-icon ${level.player.sprite.startsWith("asset:") ? "asset-custom" : level.player.sprite}`} /></div>
            <label className="field wide"><span>SHIP SPRITE</span><select value={level.player.sprite} onChange={(event) => updateLevel((current) => ({ ...current, player: { ...current.player, sprite: event.target.value as PlayerSpriteChoice } }), true, "player-sprite")}><optgroup label="PLAYER SHIPS">{["dart", "raven", "nova", "striker"].map((sprite) => <option value={sprite} key={sprite}>{sprite.toUpperCase()}</option>)}</optgroup>{level.assets.length > 0 && <optgroup label="CUSTOM SPRITES">{level.assets.map((asset) => <option value={`asset:${asset.id}`} key={asset.id}>{asset.name.toUpperCase()}</option>)}</optgroup>}</select></label>
            <label className="range-field"><span><b>SHIP HUE TINT</b><em>{level.player.tint}°</em></span><input type="range" min="0" max="359" value={level.player.tint} onChange={(event) => updateLevel((current) => ({ ...current, player: { ...current.player, tint: Number(event.target.value) } }), true, "player-tint")} /></label>
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
              {level.player.weaponSlots.map((slot, index) => <div className="equipment-slot" key={slot.id}><strong>{slot.name}</strong><label className="field"><span>ACCEPTS</span><select value={slot.accepts} onChange={(event) => updateLevel((current) => ({ ...current, player: { ...current.player, weaponSlots: current.player.weaponSlots.map((entry) => entry.id === slot.id ? { ...entry, accepts: event.target.value } : entry) } }))}><option value="any">ANY</option><option value="standard">STANDARD</option><option value="light">LIGHT</option><option value="heavy">HEAVY</option><option value="satellite">SATELLITE</option></select></label><label className="field"><span>WEAPON</span><select value={slot.weaponId} onChange={(event) => updateLevel((current) => ({ ...current, player: { ...current.player, weaponSlots: current.player.weaponSlots.map((entry) => entry.id === slot.id ? { ...entry, weaponId: event.target.value } : entry) } }))}>{level.components.filter((component) => component.kind === "weapon" && weaponFitsSlot(component, slot.accepts)).map((component) => <option value={component.id} key={component.id}>{component.name.toUpperCase()}</option>)}</select></label>{(() => { const weaponComponent = level.components.find((component) => component.id === slot.weaponId); if (!weaponComponent?.weapon) return null; return <button className="inspector-action" type="button" onClick={() => setEditingPattern({ pattern: structuredClone(weaponComponent.weapon!.pattern ?? createPatternPreset("Pendulum Sweep")), target: { kind: "weapon", id: weaponComponent.id } })}>{weaponComponent.weapon.pattern ? "EDIT BULLET PATTERN" : "ADD BULLET PATTERN"}</button>; })()}<small>Fires simultaneously from mount {index + 1}.</small></div>)}
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
            </>)}

            {(selected.type === "enemy" || selected.type === "terrain" || selected.type === "group") && section("durability", "DURABILITY", <>
              <label className="range-field"><span><b>HIT POINTS</b><em>{selected.hitPoints} HP</em></span><input type="range" min="50" max="2000" step="50" value={selected.hitPoints} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, hitPoints: Number(event.target.value) }))} /></label>
              <label className="field wide"><span>ARMOR TYPE</span><select value={selected.armor?.type ?? "none"} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, armor: defaultArmor(event.target.value as ArmorType) }))}>{["none", "standard", "heavy", "ablative", "forcefield"].map((type) => <option value={type} key={type}>{type.toUpperCase()}</option>)}</select></label>
              {(selected.armor?.type === "forcefield") && <><label className="range-field"><span><b>SHIELD CAPACITY</b><em>{selected.armor.capacity}</em></span><input type="range" min="25" max="1000" step="25" value={selected.armor.capacity} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, armor: { ...(item.armor ?? defaultArmor("forcefield")), capacity: Number(event.target.value) } }))} /></label><label className="range-field"><span><b>RECHARGE RATE</b><em>{selected.armor.rechargeRate}/s</em></span><input type="range" min="0" max="250" step="5" value={selected.armor.rechargeRate} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, armor: { ...(item.armor ?? defaultArmor("forcefield")), rechargeRate: Number(event.target.value) } }))} /></label></>}
              <p className="inspector-note">{Math.max(1, Math.ceil(selected.hitPoints / level.player.shotPower))} hit{Math.ceil(selected.hitPoints / level.player.shotPower) === 1 ? "" : "s"} at base power {level.player.shotPower}.</p>
              {selected.armor && selected.armor.type !== "none" && <button className="inspector-action" type="button" onClick={() => saveArmorComponent(selected.armor!)}>SAVE ARMOR COMPONENT</button>}
            </>)}

            {selected.type === "group" && section("formation", "FORMATION", <>
              <div className="field-grid"><label className="field"><span>PATTERN</span><select value={selected.group?.pattern} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, group: { ...(item.group ?? { count: 5, spacing: 60, pattern: "line" }), pattern: event.target.value as GroupPattern } }))}><option value="line">LINE</option><option value="vee">VEE</option><option value="ring">RING</option></select></label><div className="field"><EbNumericInput label="COUNT" sliderEnabled={false} min={2} max={16} value={selected.group?.count ?? 5} onValueChange={(count) => updateItem(selected.id, (item) => ({ ...item, group: { ...(item.group ?? { pattern: "line", spacing: 60, count: 5 }), count } }))} /></div></div>
              <label className="range-field"><span><b>SPACING</b><em>{selected.group?.spacing ?? 60}u</em></span><input type="range" min="30" max="140" value={selected.group?.spacing ?? 60} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, group: { ...(item.group ?? { pattern: "line", spacing: 60, count: 5 }), spacing: Number(event.target.value) } }))} /></label>
            </>)}

            {section("movement", selected.type === "decoration" ? "DECORATION MOTION" : "MOVEMENT", <>
              <label className="field wide"><span>PATTERN</span><select value={selected.movement.pattern} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, movement: { ...item.movement, pattern: event.target.value as MovePattern } }))}><option value="straight">STRAIGHT</option><option value="sine">SINE WAVE</option><option value="zigzag">ZIGZAG</option><option value="stationary">STATIONARY</option></select></label>
              <label className="range-field"><span><b>SPEED</b><em>{selected.movement.speed}u/s</em></span><input type="range" min="0" max="240" value={selected.movement.speed} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, movement: { ...item.movement, speed: Number(event.target.value) } }))} /></label>
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

            {(selected.type === "enemy" || selected.type === "group") && section("weapon", "WEAPON", <>
              <label className="toggle-row"><span>WEAPON ENABLED</span><input type="checkbox" checked={selected.weapon.enabled} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, weapon: { ...item.weapon, enabled: event.target.checked } }))} /><i /></label>
              {selected.weapon.enabled && <><div className="field-grid"><label className="field"><span>PROJECTILE</span><select value={selected.weapon.projectile} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, weapon: { ...item.weapon, projectile: event.target.value as ProjectileSprite } }))}><option value="bolt">BOLT</option><option value="plasma">PLASMA</option></select></label><label className="field"><span>MOTION</span><select value={selected.weapon.projectileMovement} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, weapon: { ...item.weapon, projectileMovement: event.target.value as "straight" | "sine" } }))}><option value="straight">STRAIGHT</option><option value="sine">SINE</option></select></label></div>
                <label className="range-field"><span><b>SHOTS / SEC</b><em>{selected.weapon.shotsPerSecond.toFixed(1)}</em></span><input type="range" min="0.1" max="4" step="0.1" value={selected.weapon.shotsPerSecond} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, weapon: { ...item.weapon, shotsPerSecond: Number(event.target.value) } }))} /></label>
                <label className="range-field"><span><b>COOLDOWN</b><em>{selected.weapon.cooldown.toFixed(1)}s</em></span><input type="range" min="0" max="4" step="0.1" value={selected.weapon.cooldown} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, weapon: { ...item.weapon, cooldown: Number(event.target.value) } }))} /></label>
                <label className="range-field"><span><b>PROJECTILE SPEED</b><em>{selected.weapon.projectileSpeed}u/s</em></span><input type="range" min="100" max="700" step="10" value={selected.weapon.projectileSpeed} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, weapon: { ...item.weapon, projectileSpeed: Number(event.target.value) } }))} /></label>
                <label className="range-field"><span><b>POWER</b><em>{selected.weapon.power}</em></span><input type="range" min="1" max="3" value={selected.weapon.power} onChange={(event) => updateItem(selected.id, (item) => ({ ...item, weapon: { ...item.weapon, power: Number(event.target.value) } }))} /></label>
                <button className="inspector-action" type="button" onClick={() => saveWeaponComponent(selected.weapon, `${selected.name} Weapon`)}>SAVE WEAPON COMPONENT</button>
                <button className="inspector-action pattern-designer-button" type="button" onClick={() => setEditingPattern({ pattern: structuredClone(selected.weapon.pattern ?? createPatternPreset("Pendulum Sweep")), target: { kind: "item", id: selected.id } })}>{selected.weapon.pattern ? "EDIT BULLET HELL PATTERN" : "OPEN BULLET HELL DESIGNER"}</button>
                {selected.weapon.pattern && <button className="inspector-action" type="button" onClick={() => updateItem(selected.id, (item) => ({ ...item, weapon: { ...item.weapon, pattern: undefined } }))}>REMOVE PATTERN / USE STANDARD FIRE</button>}
              </>}
            </>)}
            </EbAccordion>
          </div>}
        </aside>
      </section>

      <footer className="shortcut-bar"><span><kbd>T</kbd> PLAYTEST</span><span><kbd>ESC</kbd> SELECT / BUILD</span><span><kbd>S</kbd> SCROLL</span><span><kbd>D</kbd> DUPLICATE</span><span><kbd>Q / E</kbd> ROTATE</span><span><kbd>CTRL / SHIFT</kbd> MULTI-SELECT</span><span><kbd>1–9</kbd> EQUIP</span><span><kbd>CTRL Z</kbd> UNDO</span><span className="gamepad-shortcut">GAMEPAD: <kbd>LS</kbd> MOVE <kbd>RS</kbd> SATELLITE <kbd>Y</kbd> CYCLE WEAPON <kbd>A / RT</kbd> FIRE</span><strong>THE FATE OF THE GALAXY IS IN YOUR HANDS.</strong></footer>
      {editingAsset && <SpriteStudio asset={editingAsset} onSave={saveSpriteAsset} onCancel={() => setEditingAsset(null)} />}
      {pendingConfirm && <EbDialog visible title={pendingConfirm.title} onVisibleChange={(open) => { if (!open) setPendingConfirm(null); }} showCloseButton={false} className="confirm-dialog" footerContent={<>
        <button type="button" onClick={() => setPendingConfirm(null)}>CANCEL</button>
        <button type="button" className="confirm-commit" onClick={() => { const act = pendingConfirm.action; setPendingConfirm(null); act(); }}>CONFIRM</button>
      </>}><p>{pendingConfirm.message}</p></EbDialog>}
      {showSettings && <EbDialog visible title="EDITOR SETTINGS" onVisibleChange={(open) => { if (!open) setShowSettings(false); }} className="settings-dialog" footerContent={<button type="button" onClick={() => setShowSettings(false)}>DONE</button>}>
        <label className="field wide"><span>TOOLBAR BEHAVIOR</span><select value={sectionMode} onChange={(event) => applySectionMode(event.target.value as SectionMode)}><option value="multiple">SEVERAL SECTIONS OPEN</option><option value="single">ONE SECTION AT A TIME</option></select></label>
        <p className="inspector-note">Governs the collapsible sections in the palette and the Inspector alike. Kept in this browser rather than in the level.</p>
      </EbDialog>}
      {editingPattern && <BulletPatternStudio pattern={editingPattern.pattern} onApply={applyPatternEditor} onSaveComponent={savePatternComponent} onCancel={() => setEditingPattern(null)} />}
    </main>
  );
}
