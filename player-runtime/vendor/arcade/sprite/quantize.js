// Turning a picture into pixel art.
//
// The bridge between the two raster kinds, and the reason importing a
// photograph is worth anything at all. Dropping a 3000-pixel holiday snap
// into a 32x32 grid by taking every ninety-fourth pixel gives a smear with
// no relationship to the original; what makes it read is doing the two
// things a person would do by hand — average the area each cell covers,
// then choose a small palette that suits the picture rather than a fixed
// one that suits nothing.
//
// Both halves are pure arithmetic over typed arrays: no DOM, no clock, no
// randomness, and therefore testable. The browser owns exactly one step of
// this pipeline — decoding a PNG or a JPEG into RGBA — because that is the
// step it is genuinely better at.
//
// Alpha is premultiplied before averaging and unpremultiplied after, which
// is not fussiness: averaging straight RGBA drags the colour of fully
// transparent pixels into their neighbours, and a sprite downsampled the
// naive way grows a dark halo everywhere its artist drew an edge.

/**
 * Area-average an RGBA buffer down (or up) to a new size.
 *
 * A box filter rather than anything cleverer. For downsampling, which is
 * what this is for, a box filter IS the correct answer — each output cell
 * is the mean of the input it covers — and the fancier kernels exist to
 * make *upsampling* look better, which is not this job.
 *
 * @param {Uint8ClampedArray} rgba
 * @param {number} width
 * @param {number} height
 * @param {number} targetWidth
 * @param {number} targetHeight
 * @returns {Uint8ClampedArray}
 */
export function resampleRgba(rgba, width, height, targetWidth, targetHeight) {
  const out = new Uint8ClampedArray(targetWidth * targetHeight * 4);
  const scaleX = width / targetWidth;
  const scaleY = height / targetHeight;

  for (let y = 0; y < targetHeight; y += 1) {
    // The window is half-open and always at least one pixel wide, so an
    // upscale samples the nearest source pixel rather than nothing.
    const y0 = Math.floor(y * scaleY);
    const y1 = Math.max(y0 + 1, Math.min(height, Math.ceil((y + 1) * scaleY)));
    for (let x = 0; x < targetWidth; x += 1) {
      const x0 = Math.floor(x * scaleX);
      const x1 = Math.max(x0 + 1, Math.min(width, Math.ceil((x + 1) * scaleX)));

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const at = (sy * width + sx) * 4;
          const alpha = rgba[at + 3] / 255;
          r += rgba[at] * alpha;
          g += rgba[at + 1] * alpha;
          b += rgba[at + 2] * alpha;
          a += rgba[at + 3];
          count += 1;
        }
      }
      const target = (y * targetWidth + x) * 4;
      if (count === 0) continue;
      const alpha = a / count;
      // Unpremultiply. A cell that averaged out fully transparent has no
      // colour to recover and keeps zeroes rather than dividing by one.
      const weight = alpha > 0 ? (count * alpha) / 255 : 0;
      out[target] = weight > 0 ? r / weight : 0;
      out[target + 1] = weight > 0 ? g / weight : 0;
      out[target + 2] = weight > 0 ? b / weight : 0;
      out[target + 3] = alpha;
    }
  }
  return out;
}

/** One box of the median cut: a slice of the sample list, and its extent. */
function quantExtent(samples, from, to) {
  let minR = 255;
  let maxR = 0;
  let minG = 255;
  let maxG = 0;
  let minB = 255;
  let maxB = 0;
  for (let at = from; at < to; at += 1) {
    const sample = samples[at];
    if (sample[0] < minR) minR = sample[0];
    if (sample[0] > maxR) maxR = sample[0];
    if (sample[1] < minG) minG = sample[1];
    if (sample[1] > maxG) maxG = sample[1];
    if (sample[2] < minB) minB = sample[2];
    if (sample[2] > maxB) maxB = sample[2];
  }
  const spread = [maxR - minR, maxG - minG, maxB - minB];
  const channel = spread[0] >= spread[1] && spread[0] >= spread[2] ? 0 : spread[1] >= spread[2] ? 1 : 2;
  return { from, to, channel, spread: spread[channel] };
}

/**
 * Median cut: choose `maxColors` colours that suit this picture.
 *
 * Repeatedly take the box with the widest spread on any channel, sort it on
 * that channel, and split it at its median. The result is a palette that
 * spends its entries where the image actually has colour — which is the
 * whole difference between a quantized photograph and a posterized one.
 *
 * Fully transparent pixels take no part: they have no colour, and letting
 * them vote drags every box towards black.
 *
 * @param {Uint8ClampedArray} rgba
 * @param {number} [maxColors]
 * @param {number} [alphaThreshold] Below this alpha a pixel is transparent.
 * @returns {Array<[number, number, number]>} Palette, darkest-first order
 *          is not promised; the order is the order boxes were cut in.
 */
export function quantizeRgba(rgba, maxColors = 16, alphaThreshold = 128) {
  const colors = Math.max(1, Math.min(256, Math.round(maxColors)));
  const samples = [];
  for (let at = 0; at < rgba.length; at += 4) {
    if (rgba[at + 3] < alphaThreshold) continue;
    samples.push([rgba[at], rgba[at + 1], rgba[at + 2]]);
  }
  if (samples.length === 0) return [];

  let boxes = [quantExtent(samples, 0, samples.length)];
  while (boxes.length < colors) {
    let widest = -1;
    let index = -1;
    for (let at = 0; at < boxes.length; at += 1) {
      if (boxes[at].to - boxes[at].from > 1 && boxes[at].spread > widest) {
        widest = boxes[at].spread;
        index = at;
      }
    }
    // Every box is a single colour, or a single sample: nothing left to cut.
    if (index < 0 || widest <= 0) break;

    const box = boxes[index];
    const slice = samples.slice(box.from, box.to);
    slice.sort((left, right) => left[box.channel] - right[box.channel]);
    for (let at = 0; at < slice.length; at += 1) samples[box.from + at] = slice[at];
    const middle = box.from + (slice.length >> 1);
    boxes = [
      ...boxes.slice(0, index),
      quantExtent(samples, box.from, middle),
      quantExtent(samples, middle, box.to),
      ...boxes.slice(index + 1),
    ];
  }

  return boxes.map((box) => {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let at = box.from; at < box.to; at += 1) {
      r += samples[at][0];
      g += samples[at][1];
      b += samples[at][2];
    }
    const count = Math.max(1, box.to - box.from);
    return [Math.round(r / count), Math.round(g / count), Math.round(b / count)];
  });
}

/** `#rrggbb`, lower case, which is what the pixel grid stores. */
function quantHex(r, g, b) {
  const pair = (value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
  return `#${pair(r)}${pair(g)}${pair(b)}`;
}

/** The nearest palette entry by squared distance. Linear: palettes are tiny. */
export function nearestColor(palette, r, g, b) {
  let best = 0;
  let bestDistance = Infinity;
  for (let at = 0; at < palette.length; at += 1) {
    const dr = palette[at][0] - r;
    const dg = palette[at][1] - g;
    const db = palette[at][2] - b;
    const distance = dr * dr + dg * dg + db * db;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = at;
    }
  }
  return best;
}

/**
 * A picture, as a `RasterSpriteAsset`'s pixel grid.
 *
 * The whole import path in one call: average down to the grid, choose a
 * palette that suits the picture, and map every cell to it. Cells below the
 * alpha threshold come back as `""`, which is what the grid means by
 * transparent.
 *
 * @param {Uint8ClampedArray} rgba
 * @param {number} width Source width.
 * @param {number} height Source height.
 * @param {number} gridWidth
 * @param {number} gridHeight
 * @param {object} [options]
 * @param {number} [options.colors] Palette size, 1..256.
 * @param {number} [options.alphaThreshold] 0..255.
 * @returns {string[]} Row-major, `gridWidth * gridHeight` long.
 */
export function rgbaToPixels(rgba, width, height, gridWidth, gridHeight, options = {}) {
  const { colors = 16, alphaThreshold = 128 } = options;
  const small = resampleRgba(rgba, width, height, gridWidth, gridHeight);
  const palette = quantizeRgba(small, colors, alphaThreshold);
  const pixels = new Array(gridWidth * gridHeight).fill("");
  if (palette.length === 0) return pixels;
  const hexes = palette.map(([r, g, b]) => quantHex(r, g, b));
  for (let at = 0; at < pixels.length; at += 1) {
    const source = at * 4;
    if (small[source + 3] < alphaThreshold) continue;
    pixels[at] = hexes[nearestColor(palette, small[source], small[source + 1], small[source + 2])];
  }
  return pixels;
}

/** The palette a grid actually uses, in first-seen order. For a swatch row. */
export function pixelsPalette(pixels) {
  const seen = [];
  for (const pixel of pixels) {
    if (pixel && !seen.includes(pixel)) seen.push(pixel);
    if (seen.length >= 256) break;
  }
  return seen;
}
