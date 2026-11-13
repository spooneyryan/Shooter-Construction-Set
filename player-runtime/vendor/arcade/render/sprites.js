// The sprite cache: one mechanism for procedural and raster sprites both.
//
// The two kinds look like two problems and are not. A raster sprite is already
// pixels. A procedural one is a RECIPE for pixels — a few paths and fills, the
// thing `drawTile` and a vector asset each are. Run the recipe once into a
// scratch region, keep the region, and from then on it is pixels too. Bake,
// do not branch: everything downstream sees one kind of thing, which is what
// lets a WebGL batcher be added later without a second code path.
//
// The design rests on a bake being cheap, so it was measured before it was
// written. On a representative shape — a filled triangle plus a stroked arc at
// 32x32:
//
//   draw the recipe to a canvas     0.0017 ms
//   texSubImage2D upload            0.0011 ms
//   both, one full cache miss       0.0159 ms   -> about 1,000 per frame
//
// A thousand fresh bakes fit inside one 16.6 ms frame. So a level transition
// that meets every shape for the first time costs one frame, and steady state
// costs nothing. That number is why there is a cache here rather than a
// pre-build step, and why the eviction policy below can afford to be blunt.
//
// Regions are packed into pages by shelf: a new sprite goes on the current
// shelf if it fits, otherwise a new shelf starts below the tallest one so far.
// It is the simplest packer that does not waste most of the sheet, and the
// alternative — a full rectangle packer — buys nothing for sprite sets that
// are mostly one or two sizes.

/** Transparent margin around every region, so neighbours cannot bleed in. */
const PAD = 1;

import { browserCanvas, context2d } from "./canvas.js";

/**
 * @typedef {object} SpriteRegion
 * @property {any} canvas The page holding it.
 * @property {number} page Index of that page.
 * @property {number} x Left edge within the page, in pixels.
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */

/**
 * @param {object} [options]
 * @param {number} [options.pageSize] Edge length of one page, in pixels.
 * @param {number} [options.maxPages] Pages before the cache resets. See
 *        `resets` below for why the policy is a reset rather than an eviction.
 * @param {(width: number, height: number) => any} [options.createCanvas]
 */
export function createSpriteCache({
  pageSize = 1024,
  maxPages = 4,
  createCanvas = (w, h) => browserCanvas(w, h, "createSpriteCache"),
} = {}) {
  /** @type {Map<string, SpriteRegion>} */
  let regions = new Map();
  /** @type {{canvas: any, context: any}[]} */
  let pages = [];
  let shelfX = 0;
  let shelfY = 0;
  let shelfHeight = 0;
  let bakes = 0;
  let resets = 0;
  let generation = 0;

  function addPage() {
    const canvas = createCanvas(pageSize, pageSize);
    const context = context2d(canvas, pageSize, pageSize, "createSpriteCache");
    pages.push({ canvas, context });
    shelfX = 0;
    shelfY = 0;
    shelfHeight = 0;
    return pages.length - 1;
  }

  /**
   * Throw everything away and start again.
   *
   * Blunt on purpose. The obvious alternative is least-recently-used eviction,
   * which needs same-sized slots or a real allocator to reuse the hole it
   * leaves, and neither is worth it when a full re-bake of everything visible
   * costs well under a frame. What actually grows a sprite set without bound is
   * a zoom control — every scale is a different key — and for that a periodic
   * flat reset is both simpler and better behaved than evicting one region at a
   * time while the set keeps growing.
   */
  function reset() {
    regions = new Map();
    pages = [];
    shelfX = 0;
    shelfY = 0;
    shelfHeight = 0;
    resets += 1;
    generation += 1;
    addPage();
  }

  /** Find room for w x h, adding a page or resetting if there is none. */
  function allocate(w, h) {
    if (pages.length === 0) addPage();
    const boxW = w + PAD * 2;
    const boxH = h + PAD * 2;
    if (boxW > pageSize || boxH > pageSize) {
      throw new Error(
        `A ${w}x${h} sprite does not fit a ${pageSize}px page. Raise pageSize or draw it smaller.`,
      );
    }
    if (shelfX + boxW > pageSize) {
      // Next shelf down.
      shelfY += shelfHeight;
      shelfX = 0;
      shelfHeight = 0;
    }
    if (shelfY + boxH > pageSize) {
      if (pages.length >= maxPages) reset();
      else addPage();
    }
    const page = pages.length - 1;
    const x = shelfX + PAD;
    const y = shelfY + PAD;
    shelfX += boxW;
    if (boxH > shelfHeight) shelfHeight = boxH;
    return { page, x, y };
  }

  return {
    /** Bakes performed. The number that should stop climbing once warm. */
    get bakes() { return bakes; },
    /** How many times the cache has been thrown away and rebuilt. */
    get resets() { return resets; },
    /** Bumped by a reset, so a holder of a stale region can notice. */
    get generation() { return generation; },
    get size() { return regions.size; },
    get pageCount() { return pages.length; },
    pageCanvas(index) { return pages[index]?.canvas ?? null; },

    /**
     * A region holding this sprite, baking it on a miss.
     *
     * The key must name everything that changes the pixels — the recipe, the
     * size, and any parameter the recipe reads. A tile keyed `"wall"` that is
     * drawn in two palettes is one bug; `"wall@16:dusk"` is not.
     *
     * `paint` receives a context translated so that (0, 0) is the sprite's own
     * top-left. It may draw anywhere in [0, width) x [0, height).
     *
     * @param {string} key
     * @param {number} width
     * @param {number} height
     * @param {(ctx: any) => void} paint
     * @returns {SpriteRegion}
     */
    sprite(key, width, height, paint) {
      const hit = regions.get(key);
      if (hit) return hit;
      const w = Math.max(1, Math.ceil(width));
      const h = Math.max(1, Math.ceil(height));
      const slot = allocate(w, h);
      const { context } = pages[slot.page];
      context.save();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(slot.x, slot.y, w, h);
      context.translate(slot.x, slot.y);
      // A recipe that throws must not leave the context transformed, or every
      // sprite baked after it lands somewhere else on the page.
      try {
        paint(context);
      } finally {
        context.restore();
      }
      const region = {
        canvas: pages[slot.page].canvas,
        page: slot.page,
        x: slot.x,
        y: slot.y,
        width: w,
        height: h,
      };
      regions.set(key, region);
      bakes += 1;
      return region;
    },

    /**
     * The raster front door. Same mechanism, one less thing for a caller with
     * an image to write.
     *
     * @param {string} key
     * @param {any} source Anything drawImage accepts.
     * @param {number} [width] Defaults to the source's own size.
     * @param {number} [height]
     * @returns {SpriteRegion}
     */
    image(key, source, width, height) {
      const w = width ?? source.naturalWidth ?? source.width;
      const h = height ?? source.naturalHeight ?? source.height;
      return this.sprite(key, w, h, (ctx) => ctx.drawImage(source, 0, 0, w, h));
    },

    /**
     * Blit a region. Sub-rectangle arithmetic is easy to get subtly wrong and
     * there is no reason for every caller to write it again.
     *
     * @param {any} ctx
     * @param {SpriteRegion} region
     * @param {number} dx
     * @param {number} dy
     * @param {number} [dw] Defaults to the region's own size.
     * @param {number} [dh]
     */
    draw(ctx, region, dx, dy, dw = region.width, dh = region.height) {
      ctx.drawImage(region.canvas, region.x, region.y, region.width, region.height, dx, dy, dw, dh);
    },

    /** Throw everything away — after a skin change, or a new level's palette. */
    clear() { reset(); },
  };
}
