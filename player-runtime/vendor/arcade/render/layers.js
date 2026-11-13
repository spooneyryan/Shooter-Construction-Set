// Cached layers: paint once, blit until something changes.
//
// The measurement that produced this module, taken in a browser against a
// realistic 20x14 viewport with three tile layers -- 840 tiles a frame:
//
//   fillStyle + fillRect per tile      0.24 ms     what a game does today
//   a four-segment path per tile       3.35 ms     slopes, girders, ladders
//   drawImage from an atlas per tile   1.09 ms     4.6x WORSE than fillRect
//   blit three pre-rendered layers     0.011 ms
//
// Two things follow, and the second is the reason this file is not a sprite
// batcher. Path-drawn tiles are the hotspot, at a fifth of a frame. And
// atlasing tiles -- turning them into sprites, which is the reflex -- is
// slower than the plain rectangle fill it would replace, because a solid-colour
// fillRect is a heavily optimised fast path and drawImage has to sample.
//
// So: do not draw the same picture sixty times a second. Draw it when it
// changes.
//
// Nothing here knows what a tile looks like. The game supplies a paint
// callback, exactly as `runnjump` supplies a simulation and draws nothing.

import { browserCanvas, context2d } from "./canvas.js";

/**
 * A picture kept on its own canvas and repainted only when its key changes.
 *
 * The key is whatever the picture depends on, folded into a string or number by
 * the caller -- a level id, a palette name, a scroll position. Comparing it is
 * the whole invalidation policy, deliberately: a cache that tries to work out
 * for itself when it is stale needs to know what the picture means, and then it
 * is not a cache any more.
 *
 * @param {object} options
 * @param {number} options.width Width in the caller's own units.
 * @param {number} options.height
 * @param {number} [options.resolution] Backing pixels per unit of the two
 *        above. Leave it at 1 when the destination draws at 1:1, and pass the
 *        destination's own scale when it does not -- see the note below,
 *        because getting this wrong is the difference between a cache and a
 *        blur.
 * @param {(width: number, height: number) => any} [options.createCanvas]
 */
export function createLayerCache({
  width,
  height,
  resolution = 1,
  createCanvas = (w, h) => browserCanvas(w, h, "createLayerCache"),
}) {
  // Two sizes, and the distinction is the whole of `resolution`. The logical
  // size is what the caller draws and blits in; the backing size is how many
  // real pixels that is stored as.
  //
  // A game drawing through a letterbox or device-pixel-ratio transform is
  // NOT at 1:1 -- its context maps a design pixel onto two or three real ones.
  // Cache such a layer at resolution 1 and it is rasterised at design size and
  // then magnified on every blit, which is worse than not caching: it costs the
  // memory, saves the drawing, and throws away the sharpness that the transform
  // existed to provide. Pass the same scale the destination uses and a cache
  // pixel is a device pixel, so the blit is a copy rather than a resample.
  const scale = resolution > 0 ? resolution : 1;
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  const pw = Math.max(1, Math.ceil(w * scale));
  const ph = Math.max(1, Math.ceil(h * scale));
  const canvas = createCanvas(pw, ph);
  const own = context2d(canvas, pw, ph, "createLayerCache");

  let painted = null;
  let repaints = 0;

  return {
    get canvas() { return canvas; },
    get context() { return own; },
    /** Repaints so far. A frame counter that does not move is the win. */
    get repaints() { return repaints; },
    /** The key currently on the canvas, or null when nothing has been painted. */
    get key() { return painted; },

    /**
     * Blit the picture, repainting first if `key` has moved.
     *
     * `paint` is called with the layer's own context, already cleared, and the
     * layer's canvas. It draws in LOGICAL units and never learns the
     * resolution -- the scale is on the context before it is called.
     *
     * @param {any} ctx Destination context.
     * @param {string|number} key
     * @param {(own: any, canvas: any) => void} paint
     * @param {number} [dx] Destination x, in the destination's coordinates.
     * @param {number} [dy]
     */
    draw(ctx, key, paint, dx = 0, dy = 0) {
      if (key !== painted) {
        own.setTransform(scale, 0, 0, scale, 0, 0);
        own.clearRect(0, 0, w, h);
        paint(own, canvas);
        painted = key;
        repaints += 1;
      }
      // Always the explicit source-and-destination form. The short
      // `drawImage(canvas, dx, dy)` would paint the backing pixels 1:1 into the
      // destination's units, which is right only at resolution 1 and silently
      // draws a triple-size tilemap otherwise.
      ctx.drawImage(canvas, 0, 0, pw, ph, dx, dy, w, h);
    },

    /** Force the next draw to repaint. After a palette change, a skin swap. */
    invalidate() { painted = null; },
  };
}

/**
 * A scrolling tilemap layer, cached a screenful at a time.
 *
 * The point is what it does NOT repaint. The cache holds the visible tile
 * window plus a margin, keyed on that window's origin, so it survives every
 * frame the camera stays inside it -- a level scrolling at 90 px/s across 16 px
 * tiles crosses a tile boundary about six times a second, not sixty. Between
 * crossings the whole tilemap is one drawImage.
 *
 * `paintTile` draws ONE tile in LEVEL coordinates -- the same `(col, row)` a
 * game already loops over -- and the translation is applied for it. An existing
 * `drawTile(ctx, def, col * ts, row * ts, ts)` needs no change to be used here.
 *
 * Animated tiles do not belong in the cache: bake the still ones here and draw
 * the moving few over the top, which is cheap because there are always few.
 * If a whole layer animates, it is not a cacheable layer and should be drawn
 * directly.
 *
 * @param {object} options
 * @param {number} options.tileSize
 * @param {number} options.cols Level width, in tiles.
 * @param {number} options.rows
 * @param {number} options.viewWidth Viewport width, in world units.
 * @param {number} options.viewHeight
 * @param {(ctx: any, col: number, row: number) => void} options.paintTile
 * @param {number} [options.margin] Extra tiles cached around the viewport. One
 *        is enough to cover a partial tile at each edge; more only if a game
 *        draws tiles that overhang their own cell.
 * @param {number} [options.resolution] Backing pixels per world unit. A game
 *        drawing through a letterbox or device-pixel-ratio transform must pass
 *        that transform's scale here, or the tilemap is cached at design size
 *        and magnified on every blit. `createDisplay` exposes it as
 *        `viewport.scale * viewport.dpr`.
 * @param {(width: number, height: number) => any} [options.createCanvas]
 */
export function createTileLayer({
  tileSize,
  cols,
  rows,
  viewWidth,
  viewHeight,
  paintTile,
  margin = 1,
  resolution = 1,
  createCanvas,
}) {
  const ts = tileSize;
  if (!(ts > 0)) throw new Error("createTileLayer needs a positive tileSize.");
  if (typeof paintTile !== "function") throw new Error("createTileLayer needs a paintTile callback.");

  // Ceil plus one: a viewport that is not a whole number of tiles wide still
  // shows a sliver of the tile after the last full one.
  const cacheCols = Math.ceil(viewWidth / ts) + 2 * margin + 1;
  const cacheRows = Math.ceil(viewHeight / ts) + 2 * margin + 1;
  const cache = createLayerCache({
    width: cacheCols * ts,
    height: cacheRows * ts,
    resolution,
    createCanvas,
  });

  let originCol = 0;
  let originRow = 0;

  function repaint(own) {
    // Draw in level coordinates; the translate puts the window's origin at the
    // layer's own (0, 0), so paintTile never learns it is being cached.
    own.translate(-originCol * ts, -originRow * ts);
    const colEnd = Math.min(cols, originCol + cacheCols);
    const rowEnd = Math.min(rows, originRow + cacheRows);
    for (let row = Math.max(0, originRow); row < rowEnd; row += 1) {
      for (let col = Math.max(0, originCol); col < colEnd; col += 1) {
        paintTile(own, col, row);
      }
    }
  }

  return {
    get repaints() { return cache.repaints; },
    get canvas() { return cache.canvas; },
    /** The tile window currently cached — what a test asserts on. */
    get window() {
      return { col: originCol, row: originRow, cols: cacheCols, rows: cacheRows };
    },

    /**
     * Blit the tilemap for this camera position, repainting only if the camera
     * has left the cached window or `revision` has moved.
     *
     * Call with the context you would have drawn the tiles into: positions are
     * world units, so whatever transform is already applied still applies. The
     * camera offset is subtracted here — do not also translate by it.
     *
     * `revision` is anything that changes the picture without moving the
     * camera: a broken tile, an edited level, a new palette. Bump it and the
     * next draw repaints.
     *
     * @param {any} ctx
     * @param {number} cameraX World-space left edge of the viewport.
     * @param {number} cameraY
     * @param {string|number} [revision]
     */
    draw(ctx, cameraX, cameraY, revision = 0) {
      originCol = Math.floor(cameraX / ts) - margin;
      originRow = Math.floor(cameraY / ts) - margin;
      const key = `${originCol},${originRow},${revision}`;
      cache.draw(ctx, key, repaint, originCol * ts - cameraX, originRow * ts - cameraY);
    },

    invalidate() { cache.invalidate(); },
  };
}
