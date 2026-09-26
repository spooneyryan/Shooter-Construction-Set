// Ready-made artwork for the fourteen shapes the Foundry ships with.
//
// Every built-in sprite — orb, blade, diamond, turret, raider, wraith,
// carrier, asteroid, planet, nebula, wreck, comet, energy, upgrade — is drawn
// by hand in `scene.ts` as flat wireframe geometry. That is deliberate: it is
// one readable look that needs no assets and cannot fail to load. It is also
// the only look, and a sector built from it looks like every other sector.
//
// A pack answers that without asking anyone to draw: a themed set of sprite
// assets, one per built-in shape, added to the level in a click and editable
// afterwards in the vector editor like anything else the user drew.
//
// **Vector, not pixels.** Assets travel inside the level through IndexedDB,
// export files and the player an exported game runs on, and a 24x24 raster is
// 576 colour strings per sprite — 24,000 for three packs. These are a handful
// of shapes each, they scale to any size the author picks, and they arrive in
// the editor as something you can pull apart rather than a grid of cells.
//
// What the renderer will actually do with these, which is what the artwork is
// built around (see `drawVectorShape` in `@ccllc/studio/render`):
//
//   - `rect` and `ellipse` fill AND stroke. `line` and `path` only stroke,
//     so every solid mass here is a box or an oval, and paths are outlines,
//     seams and antennae rather than silhouettes.
//   - A shape rotates about its own centre, in degrees.
//   - The asset's box is scaled onto a SQUARE, x and y independently, so a
//     non-square asset arrives stretched. Every sprite here is 64x64.
//   - A custom asset is never mirrored — only the three built-in ship shapes
//     are — so enemy art is drawn facing LEFT, the way it flies.

import type { VectorShape, VectorSpriteAsset } from "@ccllc/arcade/shmup";

/** The side of every pack sprite's own coordinate box, and its centre. */
const BOX = 64;
const MID = BOX / 2;

/** A shape before it is given an id, which the sprite builder does positionally. */
type Part = Omit<VectorShape, "id">;

const box = (x: number, y: number, w: number, h: number, fill: string, stroke: string, strokeWidth = 1.6, rotation = 0): Part =>
  ({ type: "rect", x, y, w, h, fill, stroke, strokeWidth, rotation });

/** Centre and radii, because that is how a body is thought about. */
const oval = (cx: number, cy: number, rx: number, ry: number, fill: string, stroke: string, strokeWidth = 1.6, rotation = 0): Part =>
  ({ type: "ellipse", x: cx - rx, y: cy - ry, w: rx * 2, h: ry * 2, fill, stroke, strokeWidth, rotation });

const bar = (x1: number, y1: number, x2: number, y2: number, stroke: string, strokeWidth = 1.2): Part =>
  ({ type: "line", x: x1, y: y1, w: x2 - x1, h: y2 - y1, fill: "transparent", stroke, strokeWidth, rotation: 0 });

/**
 * A polyline in the sprite's own coordinates. Stroked only, so a closed
 * outline has to repeat its first point rather than relying on a fill to
 * imply the last edge.
 */
const edge = (points: Array<[number, number]>, stroke: string, strokeWidth = 1.6): Part =>
  ({ type: "path", x: 0, y: 0, w: 0, h: 0, fill: "transparent", stroke, strokeWidth, rotation: 0, points: points.map(([x, y]) => ({ x, y })) });

/** Ids are positional: stable across loads, and unique inside the one asset. */
function sprite(packId: string, shape: BuiltinShape, name: string, parts: Part[]): VectorSpriteAsset {
  return {
    id: `pack-${packId}-${shape}`,
    name,
    kind: "vector",
    width: BOX,
    height: BOX,
    shapes: parts.map((part, index) => ({ ...part, id: `${packId}-${shape}-${index}` })),
  };
}

/** The fourteen shapes a pack covers, in the order the palette lists them. */
export type BuiltinShape =
  | "orb" | "blade" | "diamond" | "turret" | "raider" | "wraith" | "carrier"
  | "asteroid" | "planet" | "nebula" | "wreck" | "comet" | "energy" | "upgrade";

export interface SpritePack {
  id: string;
  name: string;
  /** One line, shown on the card: what the set looks like and what it suits. */
  blurb: string;
  sprites: VectorSpriteAsset[];
}

// -- Chitin ------------------------------------------------------------------
//
// Grown rather than built: carapace plates, mandibles, egg sacs and a single
// amber eye that reads at a distance. Violet because the backdrop is violet
// and the hue rotation an author reaches for lands somewhere useful from here.

const CH = {
  dark: "#241236",
  shell: "#43265c",
  plate: "#6c3c92",
  lit: "#965cc0",
  rim: "#d7a6ff",
  eye: "#ffb347",
  membrane: "rgba(150,92,192,.34)",
};

const chitin: SpritePack = {
  id: "chitin",
  name: "Chitin",
  blurb: "Grown, not built. Violet carapace, amber eyes.",
  sprites: [
    sprite("chitin", "orb", "Chitin Spore", [
      oval(MID, MID, 21, 21, CH.plate, CH.rim, 2),
      oval(27, 27, 12, 12, CH.lit, CH.rim, 1),
      oval(MID, MID, 21, 8, "transparent", CH.shell, 1),
      oval(23, 25, 4.5, 4.5, CH.eye, CH.rim, 1),
      oval(48, 40, 5, 4, CH.shell, CH.rim, 1),
      oval(18, 44, 4, 3.5, CH.shell, CH.rim, 1),
    ]),
    sprite("chitin", "blade", "Chitin Mandible", [
      box(26, 12, 28, 8, CH.plate, CH.rim, 1.6, 22),
      box(26, 44, 28, 8, CH.plate, CH.rim, 1.6, -22),
      oval(44, MID, 13, 13, CH.shell, CH.rim, 2),
      oval(44, MID, 5, 5, CH.eye, CH.rim, 1),
      edge([[26, 18], [8, 28], [12, MID], [8, 36], [26, 46]], CH.rim, 1.4),
    ]),
    sprite("chitin", "diamond", "Chitin Shard", [
      box(14, 14, 36, 36, CH.plate, CH.rim, 2, 45),
      box(23, 23, 18, 18, CH.lit, CH.rim, 1, 45),
      bar(MID, 8, MID, 56, CH.shell, 1),
      bar(8, MID, 56, MID, CH.shell, 1),
      oval(MID, MID, 4, 4, CH.eye, CH.rim, 1),
    ]),
    sprite("chitin", "turret", "Chitin Spitter", [
      box(38, 16, 20, 32, CH.shell, CH.rim, 1.8),
      oval(34, MID, 15, 15, CH.plate, CH.rim, 2),
      box(6, 28, 28, 8, CH.plate, CH.rim, 1.6),
      oval(9, MID, 5, 5, CH.eye, CH.rim, 1.2),
      bar(36, 22, 36, 42, CH.rim, 1),
      oval(44, MID, 5, 5, CH.lit, CH.rim, 1),
    ]),
    sprite("chitin", "raider", "Chitin Drone", [
      box(30, 12, 22, 9, CH.shell, CH.rim, 1.4, 34),
      box(30, 43, 22, 9, CH.shell, CH.rim, 1.4, -34),
      box(14, 22, 20, 20, CH.plate, CH.rim, 1.6, 45),
      oval(38, MID, 20, 11, CH.plate, CH.rim, 2),
      bar(30, 24, 30, 40, CH.shell, 1),
      oval(28, MID, 4.5, 4.5, CH.eye, CH.rim, 1),
      bar(44, 26, 54, 22, CH.rim, 1),
      bar(44, 38, 54, 42, CH.rim, 1),
    ]),
    sprite("chitin", "wraith", "Chitin Skimmer", [
      box(30, 10, 30, 7, CH.shell, CH.rim, 1.3, 30),
      box(30, 47, 30, 7, CH.shell, CH.rim, 1.3, -30),
      box(12, 25, 14, 14, CH.plate, CH.rim, 1.4, 45),
      oval(40, MID, 22, 7, CH.plate, CH.rim, 1.8),
      bar(26, 27, 26, 37, CH.shell, 1),
      oval(30, MID, 3.5, 3.5, CH.eye, CH.rim, 1),
      bar(56, 28, 62, 26, CH.lit, 1),
      bar(56, 36, 62, 38, CH.lit, 1),
    ]),
    sprite("chitin", "carrier", "Chitin Broodship", [
      box(10, 20, 24, 24, CH.shell, CH.rim, 1.6, 45),
      oval(38, MID, 24, 18, CH.shell, CH.rim, 2),
      oval(42, MID, 15, 12, CH.plate, CH.rim, 1.2),
      oval(28, 21, 7, 5, CH.lit, CH.rim, 1),
      oval(28, 43, 7, 5, CH.lit, CH.rim, 1),
      oval(26, MID, 5, 5, CH.eye, CH.rim, 1.2),
      bar(48, 21, 48, 43, CH.rim, 1),
      bar(56, 26, 56, 38, CH.rim, 1),
      edge([[34, 18], [50, 16], [56, 22]], CH.rim, 1.2),
      edge([[34, 46], [50, 48], [56, 42]], CH.rim, 1.2),
    ]),
    sprite("chitin", "asteroid", "Chitin Egg Cluster", [
      oval(26, 28, 17, 19, CH.shell, CH.rim, 2),
      oval(44, 40, 13, 14, CH.shell, CH.rim, 2),
      oval(42, 20, 10, 10, CH.shell, CH.rim, 1.6),
      oval(24, 26, 6, 7, CH.lit, CH.rim, 1),
      oval(45, 40, 5, 5, CH.eye, CH.rim, 1),
      oval(42, 20, 3.5, 3.5, CH.lit, CH.rim, 1),
    ]),
    sprite("chitin", "planet", "Chitin Hive World", [
      oval(MID, MID, 27, 27, CH.shell, CH.rim, 2),
      oval(MID, MID, 27, 10, "transparent", CH.plate, 1.4),
      oval(24, 24, 8, 7, CH.plate, CH.rim, 1),
      oval(43, 39, 6, 6, CH.plate, CH.rim, 1),
      oval(30, 44, 5, 4, CH.plate, CH.rim, 1),
      oval(24, 24, 3, 2.5, CH.eye, CH.rim, 0.8),
    ]),
    sprite("chitin", "nebula", "Chitin Miasma", [
      oval(28, 30, 24, 19, CH.membrane, "transparent", 0.1),
      oval(42, 38, 18, 15, CH.membrane, "transparent", 0.1),
      oval(24, 42, 14, 11, CH.membrane, "transparent", 0.1),
      oval(38, 22, 13, 10, CH.membrane, "transparent", 0.1),
      oval(30, 30, 7, 6, "rgba(255,179,71,.22)", "transparent", 0.1),
    ]),
    sprite("chitin", "wreck", "Chitin Husk", [
      box(18, 14, 22, 14, CH.shell, CH.rim, 1.5, -18),
      edge([[14, 20], [34, 13], [50, 25]], CH.rim, 1.5),
      oval(26, 40, 16, 12, CH.shell, CH.rim, 1.8, -12),
      edge([[12, 44], [22, 50], [36, 46]], CH.rim, 1.2),
      bar(30, 30, 34, 44, CH.plate, 1),
      oval(46, 46, 5, 4, CH.shell, CH.rim, 1),
      oval(50, 22, 3.5, 3, CH.shell, CH.rim, 1),
    ]),
    sprite("chitin", "comet", "Chitin Seed", [
      oval(20, MID, 11, 11, CH.plate, CH.rim, 2),
      oval(17, 29, 5, 5, CH.lit, CH.rim, 1),
      bar(31, 28, 58, 22, CH.rim, 1.4),
      bar(31, MID, 60, MID, CH.rim, 1.4),
      bar(31, 36, 58, 42, CH.rim, 1.4),
      oval(18, MID, 3.5, 3.5, CH.eye, CH.rim, 1),
    ]),
    sprite("chitin", "energy", "Chitin Nectar", [
      box(18, 18, 28, 28, "rgba(255,179,71,.16)", CH.eye, 1.8, 45),
      box(27, 20, 10, 24, CH.eye, CH.rim, 1.2),
      box(20, 27, 24, 10, CH.eye, CH.rim, 1.2),
      oval(MID, MID, 5, 5, "#fff2d0", CH.eye, 1),
    ]),
    sprite("chitin", "upgrade", "Chitin Chrysalis", [
      oval(MID, MID, 14, 22, CH.plate, CH.rim, 2),
      oval(MID, 26, 9, 9, CH.lit, CH.rim, 1),
      bar(20, 34, 44, 34, CH.rim, 1),
      bar(22, 42, 42, 42, CH.rim, 1),
      edge([[24, 28], [MID, 18], [40, 28]], CH.eye, 2),
      oval(MID, 46, 4, 4, CH.eye, CH.rim, 1),
    ]),
  ],
};

// -- Ironclad ----------------------------------------------------------------
//
// Built, and built heavy. Where Chitin is ellipses, this is boxes: plated
// hulls, rivet heads, hazard stripes and a hot orange running light. Rolled
// steel reads at a glance against the violet backdrop, and it is the set to
// reach for when the sector is meant to feel like someone's navy.

const IR = {
  dark: "#161b21",
  hull: "#3b444e",
  plate: "#5d6a77",
  rim: "#aebdc9",
  hot: "#ff8a3c",
  warn: "#ffd166",
  smoke: "rgba(120,136,150,.30)",
};

const ironclad: SpritePack = {
  id: "ironclad",
  name: "Ironclad",
  blurb: "Plated steel, rivets, hazard orange.",
  sprites: [
    sprite("ironclad", "orb", "Ironclad Mine", [
      bar(MID, 4, MID, 60, IR.rim, 2),
      bar(4, MID, 60, MID, IR.rim, 2),
      bar(13, 13, 51, 51, IR.rim, 2),
      bar(51, 13, 13, 51, IR.rim, 2),
      oval(MID, MID, 19, 19, IR.hull, IR.rim, 2),
      oval(MID, MID, 11, 11, IR.plate, IR.rim, 1.2),
      oval(MID, MID, 5, 5, IR.hot, IR.warn, 1.2),
    ]),
    sprite("ironclad", "blade", "Ironclad Sawblade", [
      box(8, 28, 48, 8, IR.plate, IR.rim, 1.2, 22),
      box(8, 28, 48, 8, IR.plate, IR.rim, 1.2, 67),
      box(8, 28, 48, 8, IR.plate, IR.rim, 1.2, 112),
      box(8, 28, 48, 8, IR.plate, IR.rim, 1.2, 157),
      oval(MID, MID, 16, 16, IR.hull, IR.rim, 2),
      oval(MID, MID, 6, 6, IR.hot, IR.warn, 1.2),
    ]),
    sprite("ironclad", "diamond", "Ironclad Crate", [
      box(15, 15, 34, 34, IR.hull, IR.rim, 2, 45),
      box(24, 24, 16, 16, IR.plate, IR.rim, 1.2, 45),
      box(20, 30, 24, 5, IR.warn, IR.dark, 0.8, 45),
      oval(MID, 13, 2.5, 2.5, IR.rim, IR.dark, 0.8),
      oval(MID, 51, 2.5, 2.5, IR.rim, IR.dark, 0.8),
      oval(13, MID, 2.5, 2.5, IR.rim, IR.dark, 0.8),
      oval(51, MID, 2.5, 2.5, IR.rim, IR.dark, 0.8),
    ]),
    sprite("ironclad", "turret", "Ironclad Emplacement", [
      box(40, 14, 18, 36, IR.hull, IR.rim, 1.8),
      box(28, 22, 16, 20, IR.plate, IR.rim, 1.6),
      box(6, 28, 26, 8, IR.plate, IR.rim, 1.6),
      box(4, 26, 6, 12, IR.hull, IR.rim, 1.4),
      oval(44, 22, 2.5, 2.5, IR.rim, IR.dark, 0.8),
      oval(44, 42, 2.5, 2.5, IR.rim, IR.dark, 0.8),
      oval(52, MID, 4, 4, IR.hot, IR.warn, 1.2),
    ]),
    sprite("ironclad", "raider", "Ironclad Interceptor", [
      box(30, 10, 22, 10, IR.plate, IR.rim, 1.4, 20),
      box(30, 44, 22, 10, IR.plate, IR.rim, 1.4, -20),
      box(10, 23, 20, 20, IR.plate, IR.rim, 1.5, 45),
      box(26, 25, 30, 14, IR.hull, IR.rim, 1.8),
      box(32, 28, 14, 8, IR.plate, IR.rim, 1),
      oval(26, MID, 3.5, 3.5, IR.hot, IR.warn, 1),
      box(54, 27, 5, 10, IR.hot, IR.warn, 1),
    ]),
    sprite("ironclad", "wraith", "Ironclad Lancer", [
      box(28, 8, 30, 8, IR.plate, IR.rim, 1.2, 28),
      box(28, 48, 30, 8, IR.plate, IR.rim, 1.2, -28),
      box(6, 24, 17, 17, IR.plate, IR.rim, 1.4, 45),
      box(22, 27, 36, 10, IR.hull, IR.rim, 1.6),
      bar(28, MID, 54, MID, IR.rim, 1),
      oval(30, MID, 3, 3, IR.hot, IR.warn, 1),
      box(56, 29, 4, 6, IR.hot, IR.warn, 1),
    ]),
    sprite("ironclad", "carrier", "Ironclad Dreadnought", [
      box(4, 18, 28, 28, IR.plate, IR.rim, 1.7, 45),
      box(22, 16, 38, 32, IR.hull, IR.rim, 2),
      box(30, 21, 24, 8, IR.plate, IR.rim, 1.2),
      box(30, 35, 24, 8, IR.plate, IR.rim, 1.2),
      box(34, 10, 16, 6, IR.plate, IR.rim, 1.2),
      box(34, 48, 16, 6, IR.plate, IR.rim, 1.2),
      box(26, 29, 18, 6, IR.warn, IR.dark, 0.8),
      oval(26, MID, 4, 4, IR.hot, IR.warn, 1.2),
      box(58, 24, 4, 16, IR.hot, IR.warn, 1),
    ]),
    sprite("ironclad", "asteroid", "Ironclad Slag", [
      box(14, 20, 24, 22, IR.hull, IR.rim, 1.8, 14),
      box(32, 28, 20, 20, IR.hull, IR.rim, 1.8, -22),
      box(30, 14, 14, 13, IR.hull, IR.rim, 1.5, 32),
      bar(20, 30, 34, 26, IR.rim, 1),
      bar(36, 38, 48, 34, IR.rim, 1),
      oval(24, 36, 3, 3, IR.hot, IR.warn, 0.9),
    ]),
    sprite("ironclad", "planet", "Ironclad Foundry World", [
      oval(MID, MID, 27, 27, IR.hull, IR.rim, 2),
      oval(38, MID, 17, 26, IR.plate, "transparent", 0.1),
      bar(8, 24, 56, 24, IR.rim, 0.9),
      bar(6, MID, 58, MID, IR.rim, 0.9),
      bar(8, 40, 56, 40, IR.rim, 0.9),
      box(20, 20, 4, 3, IR.warn, "transparent", 0.1),
      box(30, 34, 5, 3, IR.warn, "transparent", 0.1),
      box(24, 43, 4, 3, IR.hot, "transparent", 0.1),
    ]),
    sprite("ironclad", "nebula", "Ironclad Smoke", [
      oval(30, 32, 25, 18, IR.smoke, "transparent", 0.1),
      oval(42, 40, 17, 13, IR.smoke, "transparent", 0.1),
      oval(22, 42, 14, 10, IR.smoke, "transparent", 0.1),
      oval(38, 22, 14, 10, IR.smoke, "transparent", 0.1),
      oval(34, 34, 8, 6, "rgba(255,138,60,.20)", "transparent", 0.1),
    ]),
    sprite("ironclad", "wreck", "Ironclad Hulk", [
      box(14, 22, 26, 14, IR.hull, IR.rim, 1.6, -14),
      box(36, 34, 16, 12, IR.hull, IR.rim, 1.5, 22),
      bar(18, 38, 22, 48, IR.rim, 1),
      bar(26, 40, 28, 50, IR.rim, 1),
      bar(34, 40, 34, 48, IR.rim, 1),
      edge([[12, 20], [26, 14], [40, 20]], IR.rim, 1.2),
      oval(46, 24, 3, 3, IR.hot, IR.warn, 0.9),
      oval(20, 52, 2.5, 2.5, IR.rim, IR.dark, 0.8),
    ]),
    sprite("ironclad", "comet", "Ironclad Bolt", [
      box(12, 26, 16, 12, IR.hull, IR.rim, 1.6, 45),
      oval(20, MID, 7, 7, IR.plate, IR.rim, 1.4),
      bar(30, 26, 60, 20, IR.warn, 1.4),
      bar(30, MID, 62, MID, IR.hot, 1.6),
      bar(30, 38, 60, 44, IR.warn, 1.4),
      oval(19, MID, 3, 3, IR.hot, IR.warn, 1),
    ]),
    sprite("ironclad", "energy", "Ironclad Cell", [
      box(16, 12, 32, 40, IR.hull, IR.rim, 2),
      box(21, 17, 22, 30, "rgba(255,209,102,.18)", IR.warn, 1.2),
      box(28, 22, 8, 20, IR.warn, IR.hot, 1),
      box(23, 28, 18, 8, IR.warn, IR.hot, 1),
      box(26, 7, 12, 5, IR.plate, IR.rim, 1),
      box(26, 52, 12, 5, IR.plate, IR.rim, 1),
    ]),
    sprite("ironclad", "upgrade", "Ironclad Module", [
      box(14, 16, 36, 32, IR.hull, IR.rim, 2),
      box(19, 21, 26, 22, IR.plate, IR.rim, 1.2),
      edge([[22, 36], [MID, 24], [42, 36]], IR.hot, 2.4),
      bar(22, 42, 42, 42, IR.warn, 1.4),
      oval(18, 20, 2.5, 2.5, IR.rim, IR.dark, 0.8),
      oval(46, 20, 2.5, 2.5, IR.rim, IR.dark, 0.8),
      oval(18, 44, 2.5, 2.5, IR.rim, IR.dark, 0.8),
      oval(46, 44, 2.5, 2.5, IR.rim, IR.dark, 0.8),
    ]),
  ],
};

// -- Halcyon -----------------------------------------------------------------
//
// Neither grown nor welded: faceted, mostly hollow, lit from inside. The
// fills are translucent so the starfield shows through the glass, which is
// the one thing the other two packs deliberately never do -- and the reason
// this set reads as energy rather than as matter.

const HA = {
  deep: "rgba(12,48,66,.70)",
  glass: "rgba(60,150,190,.34)",
  pale: "rgba(140,230,255,.22)",
  rim: "#7fe8ff",
  hot: "#ffffff",
  accent: "#64e3ff",
};

const halcyon: SpritePack = {
  id: "halcyon",
  name: "Halcyon",
  blurb: "Faceted glass, lit from inside.",
  sprites: [
    sprite("halcyon", "orb", "Halcyon Prism", [
      box(14, 14, 36, 36, HA.deep, HA.rim, 1.6, 45),
      box(19, 19, 26, 26, HA.glass, HA.rim, 1.2),
      bar(MID, 8, MID, 56, HA.accent, 0.9),
      bar(8, MID, 56, MID, HA.accent, 0.9),
      oval(MID, MID, 7, 7, HA.pale, HA.hot, 1.4),
    ]),
    sprite("halcyon", "blade", "Halcyon Splinter", [
      box(10, 28, 44, 8, HA.glass, HA.rim, 1.4, 20),
      box(10, 28, 44, 8, HA.glass, HA.rim, 1.4, -20),
      box(24, 24, 16, 16, HA.deep, HA.rim, 1.4, 45),
      oval(MID, MID, 4, 4, HA.hot, HA.hot, 1),
      bar(6, MID, 58, MID, HA.accent, 0.8),
    ]),
    sprite("halcyon", "diamond", "Halcyon Facet", [
      box(13, 13, 38, 38, HA.deep, HA.rim, 1.8, 45),
      box(23, 23, 18, 18, HA.glass, HA.rim, 1.2, 45),
      edge([[MID, 6], [14, MID], [MID, 58], [50, MID], [MID, 6]], HA.accent, 0.9),
      bar(MID, 6, MID, 58, HA.accent, 0.8),
      oval(MID, MID, 4.5, 4.5, HA.hot, HA.hot, 1),
    ]),
    sprite("halcyon", "turret", "Halcyon Pylon", [
      box(42, 12, 14, 40, HA.deep, HA.rim, 1.6),
      box(30, 24, 16, 16, HA.glass, HA.rim, 1.4, 45),
      box(8, 29, 26, 6, HA.glass, HA.rim, 1.2),
      oval(10, MID, 5, 5, HA.pale, HA.hot, 1.4),
      bar(4, MID, 20, MID, HA.hot, 1),
      bar(46, 16, 46, 48, HA.accent, 0.9),
    ]),
    sprite("halcyon", "raider", "Halcyon Dart", [
      box(28, 12, 26, 7, HA.glass, HA.rim, 1.2, 24),
      box(28, 45, 26, 7, HA.glass, HA.rim, 1.2, -24),
      box(14, 23, 20, 20, HA.deep, HA.rim, 1.5, 45),
      box(30, 26, 26, 12, HA.glass, HA.rim, 1.4),
      bar(20, MID, 54, MID, HA.accent, 0.9),
      oval(28, MID, 4, 4, HA.hot, HA.hot, 1.2),
    ]),
    sprite("halcyon", "wraith", "Halcyon Glaive", [
      box(26, 9, 32, 6, HA.glass, HA.rim, 1.1, 30),
      box(26, 49, 32, 6, HA.glass, HA.rim, 1.1, -30),
      box(11, 26, 15, 15, HA.deep, HA.rim, 1.4, 45),
      box(26, 28, 32, 8, HA.glass, HA.rim, 1.3),
      bar(16, MID, 58, MID, HA.accent, 0.9),
      oval(26, MID, 3.5, 3.5, HA.hot, HA.hot, 1.1),
    ]),
    sprite("halcyon", "carrier", "Halcyon Monolith", [
      box(8, 18, 26, 26, HA.deep, HA.rim, 1.6, 45),
      box(24, 15, 34, 34, HA.deep, HA.rim, 1.8),
      box(30, 21, 22, 22, HA.glass, HA.rim, 1.2),
      bar(24, MID, 58, MID, HA.accent, 1),
      bar(41, 15, 41, 49, HA.accent, 0.9),
      edge([[24, 15], [58, 15], [58, 49], [24, 49], [24, 15]], HA.rim, 1),
      oval(24, MID, 5, 5, HA.hot, HA.hot, 1.3),
    ]),
    sprite("halcyon", "asteroid", "Halcyon Geode", [
      box(14, 18, 24, 24, HA.deep, HA.rim, 1.6, 18),
      box(32, 28, 19, 19, HA.deep, HA.rim, 1.5, -26),
      box(31, 14, 13, 13, HA.glass, HA.rim, 1.3, 40),
      bar(20, 30, 36, 24, HA.accent, 0.9),
      bar(34, 40, 48, 34, HA.accent, 0.9),
      oval(26, 32, 4, 4, HA.hot, HA.hot, 1),
    ]),
    sprite("halcyon", "planet", "Halcyon Ice World", [
      oval(MID, MID, 27, 27, HA.deep, HA.rim, 2),
      oval(MID, MID, 27, 10, "transparent", HA.accent, 1.1),
      box(20, 20, 16, 16, HA.glass, HA.rim, 1, 45),
      bar(10, 20, 54, 20, HA.accent, 0.8),
      bar(10, 44, 54, 44, HA.accent, 0.8),
      oval(40, 24, 5, 4, HA.pale, HA.rim, 0.9),
    ]),
    sprite("halcyon", "nebula", "Halcyon Aurora", [
      oval(30, 32, 26, 18, "rgba(100,227,255,.16)", "transparent", 0.1),
      oval(40, 26, 18, 14, "rgba(140,230,255,.14)", "transparent", 0.1),
      oval(24, 42, 16, 12, "rgba(60,150,190,.18)", "transparent", 0.1),
      bar(10, 26, 54, 20, "rgba(127,232,255,.45)", 1.6),
      bar(12, 40, 56, 46, "rgba(127,232,255,.35)", 1.4),
    ]),
    sprite("halcyon", "wreck", "Halcyon Shatter", [
      box(16, 20, 20, 14, HA.deep, HA.rim, 1.5, -20),
      box(34, 32, 15, 12, HA.deep, HA.rim, 1.4, 26),
      box(22, 40, 11, 9, HA.glass, HA.rim, 1.2, 12),
      bar(14, 16, 30, 30, HA.accent, 0.9),
      bar(38, 18, 30, 30, HA.accent, 0.9),
      bar(30, 30, 44, 48, HA.accent, 0.9),
      oval(30, 30, 3.5, 3.5, HA.hot, HA.hot, 1),
    ]),
    sprite("halcyon", "comet", "Halcyon Spark", [
      oval(20, MID, 9, 9, HA.pale, HA.hot, 1.6),
      oval(20, MID, 4, 4, HA.hot, HA.hot, 1),
      bar(30, 26, 60, 18, HA.rim, 1.3),
      bar(30, MID, 62, MID, HA.hot, 1.5),
      bar(30, 38, 60, 46, HA.rim, 1.3),
      bar(20, 42, 20, 58, HA.accent, 0.9),
    ]),
    sprite("halcyon", "energy", "Halcyon Charge", [
      box(16, 16, 32, 32, HA.deep, HA.rim, 1.8, 45),
      box(28, 20, 8, 24, HA.pale, HA.hot, 1.2),
      box(20, 28, 24, 8, HA.pale, HA.hot, 1.2),
      oval(MID, MID, 5, 5, HA.hot, HA.hot, 1.2),
      edge([[MID, 8], [8, MID], [MID, 56], [56, MID], [MID, 8]], HA.accent, 0.9),
    ]),
    sprite("halcyon", "upgrade", "Halcyon Lattice", [
      box(18, 14, 28, 36, HA.deep, HA.rim, 1.8),
      box(23, 19, 18, 26, HA.glass, HA.rim, 1.1),
      edge([[24, 36], [MID, 22], [40, 36]], HA.hot, 2.4),
      bar(24, 43, 40, 43, HA.accent, 1.2),
      bar(MID, 8, MID, 14, HA.accent, 1),
      bar(MID, 50, MID, 56, HA.accent, 1),
    ]),
  ],
};

export const SPRITE_PACKS: SpritePack[] = [chitin, ironclad, halcyon];

/** Every sprite across every pack, for the "add them all" count and guards. */
export const PACK_SPRITE_COUNT = SPRITE_PACKS.reduce((total, pack) => total + pack.sprites.length, 0);
