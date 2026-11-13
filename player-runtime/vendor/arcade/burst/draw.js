// The emitters: one frame, three ways out.
//
// This is where Ryan's "both pixel-art and vector" is answered, and the
// answer is the decision this repository already made on 2026-08-24 for
// sprites: **bake, not branch.** A burst is a recipe. Drawn straight it is
// smooth vector shapes; drawn with a pixel grid and a palette it is era
// art; baked once into a sheet it is a texture that costs a blit
// thereafter. All three read the same frame from `burst/frames`, so an
// explosion cannot look like two different explosions depending on how a
// game chose to draw it.
//
// What makes the pixel half read as pixel art is exactly two knobs, and
// neither is a filter over the smooth version:
//
//   pixelGrid   positions and sizes snap to a grid, so nothing lands on a
//               half-pixel and shapes are rectangles rather than circles
//   palette     every colour snaps to the nearest entry, which is what
//               turns a smooth ramp into a limited palette instead of a
//               blurry photograph
//
// Nothing here creates a canvas on its own: `bakeBurstSheet` takes a
// factory. That keeps the module loadable in node — where the tests run
// against a recording stub — and lets a caller bake into whatever surface
// it already has.

import { burstFrameAt, burstFrameCount } from "./frames.js";
import { burstDuration } from "./contract.js";

/** Nearest palette entry by squared RGB distance. */
export function snapBurstColor(color, palette) {
  if (!Array.isArray(palette) || palette.length === 0) return color;
  const value = parseInt(color.slice(1), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  let best = palette[0];
  let bestDistance = Infinity;
  for (const entry of palette) {
    const other = parseInt(entry.slice(1), 16);
    const dr = r - ((other >> 16) & 255);
    const dg = g - ((other >> 8) & 255);
    const db = b - (other & 255);
    const distance = dr * dr + dg * dg + db * db;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = entry;
    }
  }
  return best;
}

const snapTo = (value, grid) => (grid > 0 ? Math.round(value / grid) * grid : value);

/**
 * Draw one frame.
 *
 * @param {object} ctx A 2D context.
 * @param {object} frame From `burstFrame` or `burstFrameAt`.
 * @param {object} [options]
 * @param {number} [options.scale] Pixels per unit. 1 draws at design size.
 * @param {number} [options.pixelGrid] Snap size in DESIGN units; 0 is the
 *        smooth vector path.
 * @param {string[]} [options.palette] Colours to snap to; omit for none.
 * @param {number} [options.alpha] A global multiplier, for fading a whole
 *        burst out.
 */
export function drawBurst(ctx, frame, options = {}) {
  const scale = options.scale ?? 1;
  const grid = options.pixelGrid ?? 0;
  const palette = options.palette;
  const globalAlpha = options.alpha ?? 1;
  const pixel = grid > 0;

  for (const shape of frame.shapes) {
    const alpha = shape.alpha * globalAlpha;
    if (alpha <= 0.01 || shape.size <= 0) continue;
    const color = palette ? snapBurstColor(shape.color, palette) : shape.color;
    const x = snapTo(shape.x, grid) * scale;
    const y = snapTo(shape.y, grid) * scale;
    const size = Math.max(pixel ? grid : 0.5, snapTo(shape.size, grid)) * scale;

    ctx.save();
    // Pixel art does not do partial opacity: a limited palette that fades
    // through alpha is a limited palette with a thousand colours in it.
    // Stepping it to quarters keeps the ramp visible and the look honest.
    ctx.globalAlpha = pixel ? Math.ceil(alpha * 4) / 4 : alpha;
    ctx.fillStyle = color;
    ctx.strokeStyle = color;

    if (shape.kind === "ring") {
      ctx.lineWidth = Math.max(pixel ? grid * scale : 1, size * 0.12);
      if (pixel) {
        // A stepped ring: rectangles around the circumference, because a
        // stroked arc at this scale is a grey smear.
        const steps = Math.max(8, Math.round(size / Math.max(1, grid * scale) * 3));
        for (let step = 0; step < steps; step += 1) {
          const angle = (step / steps) * Math.PI * 2;
          const px = snapTo(x + Math.cos(angle) * size, grid * scale);
          const py = snapTo(y + Math.sin(angle) * size, grid * scale);
          ctx.fillRect(px, py, grid * scale, grid * scale);
        }
      } else {
        ctx.beginPath();
        ctx.arc(x, y, size, 0, Math.PI * 2);
        ctx.stroke();
      }
    } else if (shape.kind === "shard") {
      if (pixel) {
        // A shard is a rotated rectangle, and a rotated rectangle cannot sit
        // on a pixel grid: rotating the context puts every corner wherever the
        // angle says, so the one kind that is supposed to look hand-placed was
        // the one kind landing on fractional pixels. The pixel path therefore
        // walks the shard's length and lays a cell at each step -- the same
        // trick the ring above uses, for the same reason. Direction survives;
        // every cell is on the grid.
        const cell = grid * scale;
        const steps = Math.max(1, Math.round((size * 2) / cell));
        const dx = Math.cos(shape.angle);
        const dy = Math.sin(shape.angle);
        for (let step = 0; step <= steps; step += 1) {
          const along = -size + (step / steps) * size * 2;
          ctx.fillRect(snapTo(x + dx * along, cell), snapTo(y + dy * along, cell), cell, cell);
        }
      } else {
        ctx.translate(x, y);
        ctx.rotate(shape.angle);
        ctx.fillRect(-size, -size * 0.35, size * 2, Math.max(1, size * 0.7));
      }
    } else if (pixel) {
      ctx.fillRect(x - size, y - size, size * 2, size * 2);
    } else {
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

/**
 * Bake the whole burst into one horizontal strip: `frames` cells of
 * `size` × `size`, origin centred in each. A game then blits a cell per
 * frame, which is a texture rather than a few hundred draw calls, and the
 * 2026-08-24 measurements are why that is worth having.
 *
 * @param {object} burst A normalized burst document.
 * @param {object} options
 * @param {(w: number, h: number) => any} options.createCanvas A factory
 *        returning something with `getContext("2d")`. Node has no canvas,
 *        so this is never assumed.
 * @param {number} [options.fps] Frames per second of the sheet.
 * @param {number} [options.size] Cell size in pixels; defaults to the
 *        document's reach, doubled, so the art fits.
 * @param {number} [options.scale]
 * @param {number} [options.pixelGrid] @param {string[]} [options.palette]
 */
export function bakeBurstSheet(burst, options) {
  const { createCanvas } = options ?? {};
  if (typeof createCanvas !== "function") {
    throw new Error("bakeBurstSheet needs a createCanvas factory; this module never assumes a DOM.");
  }
  const fps = options.fps ?? 30;
  const scale = options.scale ?? 1;
  const size = Math.max(4, Math.round((options.size ?? burst.reach * 2) * scale));
  const frames = burstFrameCount(burst, fps);
  const canvas = createCanvas(size * frames, size);
  const ctx = canvas.getContext("2d");
  const half = size / 2;
  for (let index = 0; index < frames; index += 1) {
    const time = (index + 0.5) / fps;
    const frame = burstFrameAt(burst, time);
    ctx.save();
    ctx.translate(index * size + half, half);
    drawBurst(ctx, frame, {
      scale,
      pixelGrid: options.pixelGrid ?? 0,
      palette: options.palette,
    });
    ctx.restore();
  }
  return { canvas, frames, size, fps, duration: burstDuration(burst) };
}

/**
 * One frame as an SVG string — the vector export, and the shape a CSS or
 * document context wants. Static by design: an animated SVG is a
 * different product, and a game that wants motion has the canvas paths or
 * the baked sheet already.
 *
 * @param {object} burst @param {number} time
 * @param {object} [options] `size`, `pixelGrid`, `palette`.
 */
export function burstToSvg(burst, time, options = {}) {
  const size = Math.max(4, Math.round(options.size ?? burst.reach * 2));
  const half = size / 2;
  const grid = options.pixelGrid ?? 0;
  const palette = options.palette;
  const frame = burstFrameAt(burst, time);
  const parts = [];
  for (const shape of frame.shapes) {
    if (shape.alpha <= 0.01 || shape.size <= 0) continue;
    const color = palette ? snapBurstColor(shape.color, palette) : shape.color;
    const x = snapTo(shape.x, grid) + half;
    const y = snapTo(shape.y, grid) + half;
    const radius = Math.max(grid > 0 ? grid : 0.5, snapTo(shape.size, grid));
    const alpha = (grid > 0 ? Math.ceil(shape.alpha * 4) / 4 : shape.alpha).toFixed(3);
    if (shape.kind === "ring" && grid <= 0) {
      parts.push(`<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${radius.toFixed(2)}" fill="none" stroke="${color}" stroke-width="${Math.max(1, radius * 0.12).toFixed(2)}" opacity="${alpha}"/>`);
    } else if (shape.kind === "ring") {
      // A stepped ring, exactly as the canvas emitter draws one: the two
      // must not disagree, or a burst exported to SVG would be a different
      // explosion from the one on the page.
      const steps = Math.max(8, Math.round((radius / grid) * 3));
      for (let step = 0; step < steps; step += 1) {
        const around = (step / steps) * Math.PI * 2;
        const px = snapTo(x + Math.cos(around) * radius, grid);
        const py = snapTo(y + Math.sin(around) * radius, grid);
        parts.push(`<rect x="${px.toFixed(2)}" y="${py.toFixed(2)}" width="${grid}" height="${grid}" fill="${color}" opacity="${alpha}"/>`);
      }
    } else if (shape.kind === "shard" && grid > 0) {
      // Stepped along its length, exactly as the canvas emitter draws one --
      // a rotated rect cannot sit on the grid, and the two emitters must not
      // disagree about what the pixel look is.
      const steps = Math.max(1, Math.round((radius * 2) / grid));
      const dx = Math.cos(shape.angle);
      const dy = Math.sin(shape.angle);
      for (let step = 0; step <= steps; step += 1) {
        const along = -radius + (step / steps) * radius * 2;
        const px = snapTo(x + dx * along, grid);
        const py = snapTo(y + dy * along, grid);
        parts.push(`<rect x="${px.toFixed(2)}" y="${py.toFixed(2)}" width="${grid}" height="${grid}" fill="${color}" opacity="${alpha}"/>`);
      }
    } else if (grid > 0 || shape.kind === "shard") {
      const w = radius * 2;
      const h = shape.kind === "shard" ? Math.max(1, radius * 0.7) : radius * 2;
      const spin = shape.kind === "shard" ? ` transform="rotate(${((shape.angle * 180) / Math.PI).toFixed(1)} ${x.toFixed(2)} ${y.toFixed(2)})"` : "";
      parts.push(`<rect x="${(x - w / 2).toFixed(2)}" y="${(y - h / 2).toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" fill="${color}" opacity="${alpha}"${spin}/>`);
    } else {
      parts.push(`<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${radius.toFixed(2)}" fill="${color}" opacity="${alpha}"/>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${parts.join("")}</svg>`;
}
