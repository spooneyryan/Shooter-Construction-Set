/**
 * Starline's designed explosions.
 *
 * Content, not mechanism — the same reason `starter-level.ts` survived the
 * library extraction. `@ccllc/arcade/burst` owns what an explosion IS and how
 * one draws; this file owns which three Starline ships with, and how a world
 * request turns into one of them.
 *
 * The world asks for an explosion and says nothing about how it looks: a
 * `Burst` is `{ x, y, color, count }`, and `count` is the only size signal it
 * carries. That is enough, because the engine's own call sites cluster —
 * chip-damage sparks at 5–7, destroyed bullets and absorbed shots at 10–14,
 * and everything that dies outright at 18–24. Those three clusters are the
 * three roles below, which is why the mapping is a pair of thresholds rather
 * than a table the engine would have to grow a field to fill.
 *
 * Per-ENEMY explosions are a level-format change and therefore a change to
 * `@ccllc/arcade`, not something to fork locally; see F-14 in future.md.
 */
import {
  mixBurstColor,
  normalizeBurst,
  type BurstDefinition,
} from "@ccllc/arcade/burst";

export type ExplosionRole = "spark" | "impact" | "blast";
export const EXPLOSION_ROLES: readonly ExplosionRole[] = ["spark", "impact", "blast"];

export const ROLE_LABELS: Record<ExplosionRole, string> = {
  spark: "CHIP HIT",
  impact: "SHOT DESTROYED",
  blast: "DESTROYED",
};

export const ROLE_NOTES: Record<ExplosionRole, string> = {
  spark: "A shot connecting, or a shield soaking one. The engine asks for 5–7.",
  impact: "A bullet shot down, or a shield giving out. 10–14.",
  blast: "An enemy, a satellite or a pickup ending. 18–24.",
};

/**
 * How strongly the world's colour overrides the design's own. A chip hit
 * should read as the bullet that caused it, so it follows the request almost
 * completely; a destroyed enemy is its own fire and only catches the tint.
 */
export interface Explosion {
  burst: BurstDefinition;
  tint: number;
}

export interface ExplosionSet {
  spark: Explosion;
  impact: Explosion;
  blast: Explosion;
  /** 0 draws smooth vector shapes; 1–8 snaps to that grid for era art. */
  pixelGrid: number;
}

/** The engine's clusters, as thresholds. */
export function roleForCount(count: number): ExplosionRole {
  if (count <= 8) return "spark";
  if (count <= 15) return "impact";
  return "blast";
}

// Starline's palette, so a snapped explosion lands on the colours the rest of
// the game already draws with rather than on an unrelated ramp.
const CYAN = "#64e3ff";
const LIME = "#eaff62";
const INK = "#eaf7fb";
const EMBER = "#ff6a4d";
const PALETTE = [INK, LIME, CYAN, EMBER, "#c8542f", "#7a3f52", "#3a2740", "#141c26"];

/**
 * Authored as raw documents run through `normalizeBurst` rather than as typed
 * blanks that are then mutated: normalize is what fills every field a layer
 * needs, so the partials below say only what makes each explosion itself.
 */
export function defaultExplosions(): ExplosionSet {
  return {
    spark: {
      tint: 0.85,
      burst: normalizeBurst({
        name: "Chip", seed: 7, reach: 60, shake: 0, palette: PALETTE,
        layers: [
          { kind: "spark", count: 7, speed: 210, speedVary: 0.5, spread: 6.2832, size: 2.4, sizeEnd: 0.4, life: 0.24, lifeVary: 0.4, drag: 2.4, gravity: 0, colorFrom: INK, colorTo: CYAN, hold: 0.15 },
          { kind: "flash", count: 1, size: 9, sizeEnd: 0, life: 0.09, colorFrom: INK, colorTo: CYAN, hold: 0 },
        ],
      }),
    },
    impact: {
      tint: 0.6,
      burst: normalizeBurst({
        name: "Impact", seed: 19, reach: 110, shake: 0.2, palette: PALETTE,
        layers: [
          { kind: "flash", count: 1, size: 16, sizeEnd: 2, life: 0.12, colorFrom: INK, colorTo: LIME, hold: 0.1 },
          { kind: "spark", count: 12, speed: 260, speedVary: 0.55, spread: 6.2832, size: 3, sizeEnd: 0.5, life: 0.36, lifeVary: 0.45, drag: 1.9, gravity: 40, colorFrom: LIME, colorTo: EMBER, hold: 0.2 },
          { kind: "ring", count: 1, size: 6, sizeEnd: 34, life: 0.3, colorFrom: CYAN, colorTo: CYAN, hold: 0 },
        ],
      }),
    },
    blast: {
      tint: 0.25,
      burst: normalizeBurst({
        name: "Destroyed", seed: 41, reach: 220, shake: 0.75, palette: PALETTE,
        layers: [
          { kind: "flash", count: 1, size: 30, sizeEnd: 4, life: 0.14, colorFrom: INK, colorTo: LIME, hold: 0.15 },
          { kind: "ring", count: 1, size: 8, sizeEnd: 76, life: 0.42, colorFrom: INK, colorTo: EMBER, hold: 0 },
          { kind: "spark", count: 26, speed: 320, speedVary: 0.6, spread: 6.2832, size: 3.6, sizeEnd: 0.5, life: 0.55, lifeVary: 0.5, drag: 1.5, gravity: 90, colorFrom: LIME, colorTo: EMBER, hold: 0.18 },
          { kind: "shard", count: 9, speed: 200, speedVary: 0.7, spread: 6.2832, size: 5, sizeEnd: 1, life: 0.7, lifeVary: 0.5, drag: 1.1, gravity: 190, spin: 5, colorFrom: EMBER, colorTo: "#7a3f52", hold: 0.25 },
          { kind: "smoke", count: 10, speed: 70, speedVary: 0.6, spread: 6.2832, size: 7, sizeEnd: 22, life: 0.9, lifeVary: 0.4, drag: 2.6, gravity: -30, colorFrom: "#7a3f52", colorTo: "#141c26", delay: 0.05, hold: 0.1 },
        ],
      }),
    },
    pixelGrid: 0,
  };
}

/** Clamps to what the fields mean, the way the engine clamps a level. */
export function normalizeExplosionSet(input?: unknown): ExplosionSet {
  const base = defaultExplosions();
  if (!input || typeof input !== "object") return base;
  const raw = input as Partial<Record<ExplosionRole | "pixelGrid", unknown>>;
  const one = (role: ExplosionRole): Explosion => {
    const entry = raw[role];
    if (!entry || typeof entry !== "object") return base[role];
    const { burst, tint } = entry as { burst?: unknown; tint?: unknown };
    return {
      burst: burst ? normalizeBurst(burst) : base[role].burst,
      tint: typeof tint === "number" && Number.isFinite(tint) ? Math.min(1, Math.max(0, tint)) : base[role].tint,
    };
  };
  const grid = Number(raw.pixelGrid);
  return {
    spark: one("spark"), impact: one("impact"), blast: one("blast"),
    pixelGrid: Number.isFinite(grid) ? Math.min(8, Math.max(0, Math.round(grid))) : 0,
  };
}

/**
 * The design's colours pulled toward the one the world asked for. A shot that
 * hits should spark in the shot's colour whatever the explosion was designed
 * in, and a shield absorbing stays cyan — without this the whole game
 * explodes in one hue and the engine's only piece of art direction is lost.
 *
 * Tinting rebuilds the document, so results are cached: the call sites use a
 * handful of fixed colours, and a burst is spawned in the middle of a frame.
 */
const tintCache = new Map<string, BurstDefinition>();

export function tintedBurst(explosion: Explosion, color: string): BurstDefinition {
  if (explosion.tint <= 0) return explosion.burst;
  const key = explosion.burst.id + "|" + explosion.burst.name + "|" + color + "|" + explosion.tint;
  const hit = tintCache.get(key);
  if (hit) return hit;
  const made = normalizeBurst({
    ...explosion.burst,
    layers: explosion.burst.layers.map((layer) => ({
      ...layer,
      colorFrom: mixBurstColor(layer.colorFrom, color, explosion.tint),
      colorTo: mixBurstColor(layer.colorTo, color, explosion.tint),
    })),
  });
  // Bounded: bullet colours are authored, but a level could carry many, and a
  // cache that only grows is a leak with a long fuse.
  if (tintCache.size > 64) tintCache.clear();
  tintCache.set(key, made);
  return made;
}

export const EXPLOSIONS_KEY = "starline-explosions-v1";

/**
 * Read/write are plain and guarded rather than routed through `defineSettings`:
 * that store types scalar preference fields, and this is a document. What
 * matters for safety is that anything read back goes through the normalizer
 * above, which is the same bargain `normalizeLevel` makes.
 */
export function loadExplosions(): ExplosionSet {
  try {
    const raw = window.localStorage.getItem(EXPLOSIONS_KEY);
    return raw ? normalizeExplosionSet(JSON.parse(raw)) : defaultExplosions();
  } catch { return defaultExplosions(); }
}

export function saveExplosions(set: ExplosionSet) {
  try { window.localStorage.setItem(EXPLOSIONS_KEY, JSON.stringify(set)); } catch { /* private mode; the session keeps its edits */ }
}
