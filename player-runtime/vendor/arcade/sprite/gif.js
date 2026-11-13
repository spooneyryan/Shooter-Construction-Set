// A GIF decoder, by hand.
//
// Written rather than borrowed for the reason everything else here is: it
// has to run under `node --test`. The browser will decode a GIF for you —
// `ImageDecoder` does it natively — but only in a browser, which would
// make the one path in this package that turns somebody's artwork into an
// animation the one path with no test. A decoder is arithmetic over bytes;
// arithmetic is testable; so it is written down.
//
// It is also the piece that makes an animated GIF worth importing at all.
// A still image is a canvas draw the platform already does. What a game
// actually wants from a GIF is its FRAMES — a walk cycle somebody drew in
// 1998 becoming an `AnimationSet` — and no browser API hands you those in
// a form you can test.
//
// What it supports: GIF87a and GIF89a, global and local colour tables,
// interlaced frames, transparency, and all four disposal methods. Frames
// come out fully composited, because a consumer wants pictures rather than
// the patch-and-restore protocol the format stores them as.
//
// What it does not: plain-text extensions (skipped, as every decoder
// does), and it makes no attempt to be fast. It is an import path — it
// runs once, on a file a person chose, and clarity is worth more there
// than a tight inner loop.
//
// No DOM, no clock, no randomness: bytes in, pixels out.

/** Frame disposal, as the specification numbers them. */
export const GIF_DISPOSAL = Object.freeze({
  unspecified: 0,
  keep: 1,
  background: 2,
  previous: 3,
});

/** Everything a GIF may not be. Each one is a different sentence to show. */
export class GifError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = "GifError";
    this.reason = reason;
  }
}

/** A cursor over the bytes, so no reader has to track an offset by hand. */
function gifReader(bytes) {
  let at = 0;
  return {
    get at() { return at; },
    get done() { return at >= bytes.length; },
    byte() {
      if (at >= bytes.length) throw new GifError("This GIF ends in the middle of a block.", "truncated");
      return bytes[at++];
    },
    /** Little-endian, which every multi-byte field in a GIF is. */
    short() {
      const low = this.byte();
      return low | (this.byte() << 8);
    },
    take(count) {
      if (at + count > bytes.length) throw new GifError("This GIF ends in the middle of a block.", "truncated");
      const slice = bytes.subarray(at, at + count);
      at += count;
      return slice;
    },
    skip(count) { this.take(count); },
  };
}

/**
 * Read a chain of length-prefixed sub-blocks into one buffer.
 *
 * GIF stores every variable-length payload this way — image data, comments,
 * application extensions — terminated by a zero-length block. Concatenating
 * is correct for LZW data because the code stream ignores the boundaries;
 * they exist so a 1987 decoder could work in 256 bytes of RAM.
 */
function gifSubBlocks(reader) {
  const parts = [];
  let total = 0;
  for (;;) {
    const size = reader.byte();
    if (size === 0) break;
    const part = reader.take(size);
    parts.push(part);
    total += part.length;
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
}

/** A colour table: `count` RGB triples, flattened. */
function gifColorTable(reader, count) {
  const raw = reader.take(count * 3);
  return { r: raw.filter((_, index) => index % 3 === 0), g: raw.filter((_, index) => index % 3 === 1), b: raw.filter((_, index) => index % 3 === 2) };
}

/**
 * LZW, the variable-width kind GIF uses.
 *
 * Codes start one bit wider than the minimum code size and grow each time
 * the dictionary fills, to twelve bits. Two codes are reserved: `clear`
 * resets the dictionary, `end` stops. The dictionary is stored as two
 * parallel arrays — a prefix code and a suffix byte — rather than as
 * strings, which is the classic representation and the reason this stays
 * allocation-free in its inner loop.
 *
 * @param {Uint8Array} data The concatenated sub-blocks.
 * @param {number} minCodeSize
 * @param {number} expected How many indices the frame needs.
 * @returns {Uint8Array} One palette index per pixel.
 */
function gifInflate(data, minCodeSize, expected) {
  if (minCodeSize < 2 || minCodeSize > 11) {
    throw new GifError("This GIF declares an impossible code size.", "corrupt");
  }
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const MAX = 4096;

  const prefix = new Int32Array(MAX);
  const suffix = new Uint8Array(MAX);
  const stack = new Uint8Array(MAX);
  const out = new Uint8Array(expected);

  let width = minCodeSize + 1;
  let next = clear + 2;
  let previous = -1;
  let bits = 0;
  let hold = 0;
  let at = 0;
  let written = 0;

  for (let code = 0; code < clear; code += 1) {
    prefix[code] = -1;
    suffix[code] = code;
  }

  while (written < expected) {
    while (bits < width) {
      if (at >= data.length) {
        // A truncated stream is common in the wild — a download cut short,
        // an encoder that forgot its terminator. Return what was decoded
        // rather than losing the frames that did arrive.
        return out;
      }
      hold |= data[at++] << bits;
      bits += 8;
    }
    const code = hold & ((1 << width) - 1);
    hold >>= width;
    bits -= width;

    if (code === clear) {
      width = minCodeSize + 1;
      next = clear + 2;
      previous = -1;
      continue;
    }
    if (code === end) break;

    let current = code;
    let depth = 0;
    // An unseen code is legal exactly once: the KwKwK case, where the
    // encoder used an entry on the same step it defined it.
    if (code >= next) {
      if (previous < 0) throw new GifError("This GIF's image data is corrupt.", "corrupt");
      stack[depth++] = suffix[previous];
      current = previous;
    }
    while (current >= clear) {
      if (depth >= MAX) throw new GifError("This GIF's image data is corrupt.", "corrupt");
      stack[depth++] = suffix[current];
      current = prefix[current];
    }
    stack[depth++] = suffix[current];
    const first = suffix[current];

    while (depth > 0 && written < expected) out[written++] = stack[--depth];

    if (previous >= 0 && next < MAX) {
      prefix[next] = previous;
      suffix[next] = first;
      next += 1;
      if ((next & (next - 1)) === 0 && next < MAX && width < 12) width += 1;
    }
    previous = code;
  }
  return out;
}

/** The row order an interlaced frame stores its lines in. */
function gifInterlacedRows(height) {
  const rows = [];
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
    for (let y = start; y < height; y += step) rows.push(y);
  }
  return rows;
}

/**
 * Decode a GIF into fully composited RGBA frames.
 *
 * @param {Uint8Array | ArrayBuffer} input
 * @returns {{width: number, height: number, loops: number, frames: Array<{
 *   rgba: Uint8ClampedArray, delay: number, disposal: number,
 * }>}} `delay` is seconds. Frames are `width * height * 4` bytes each and
 *      each one is a complete picture, not a patch.
 */
export function decodeGif(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 13) throw new GifError("That file is too short to be a GIF.", "corrupt");
  const signature = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]);
  if (signature !== "GIF87a" && signature !== "GIF89a") {
    throw new GifError("That file is not a GIF.", "foreign");
  }

  const reader = gifReader(bytes);
  reader.skip(6);
  const width = reader.short();
  const height = reader.short();
  const packed = reader.byte();
  reader.skip(2); // background colour index and pixel aspect ratio: presentation.
  if (width === 0 || height === 0) throw new GifError("This GIF has no size.", "corrupt");

  let globalTable = null;
  if (packed & 0x80) globalTable = gifColorTable(reader, 1 << ((packed & 0x07) + 1));

  const frames = [];
  let loops = 0;
  // The pending graphic control extension: it precedes the frame it
  // describes, so it is read here and consumed by the next image block.
  let delay = 0;
  // Annotated because `GIF_DISPOSAL` is frozen: without this the checker
  // narrows the variable to the literal 0 it was seeded with and then calls
  // every later comparison unreachable.
  /** @type {number} */
  let disposal = GIF_DISPOSAL.unspecified;
  let transparent = -1;

  /** The composed canvas, carried between frames so disposal can work. */
  const canvas = new Uint8ClampedArray(width * height * 4);
  let previous = null;

  for (;;) {
    if (reader.done) break;
    const marker = reader.byte();
    if (marker === 0x3b) break; // trailer

    if (marker === 0x21) {
      const label = reader.byte();
      if (label === 0xf9) {
        reader.byte(); // block size, always 4
        const flags = reader.byte();
        delay = reader.short() / 100;
        const index = reader.byte();
        reader.byte(); // terminator
        disposal = (flags >> 2) & 0x07;
        transparent = flags & 0x01 ? index : -1;
      } else if (label === 0xff) {
        const block = gifSubBlocks(reader);
        // NETSCAPE2.0: eleven identifier bytes, then a sub-block whose
        // second and third bytes are the loop count. Zero means forever.
        if (block.length >= 14 && String.fromCharCode(...block.subarray(0, 11)) === "NETSCAPE2.0") {
          loops = block[12] | (block[13] << 8);
        }
      } else {
        gifSubBlocks(reader);
      }
      continue;
    }

    if (marker !== 0x2c) {
      // An unknown block cannot be skipped safely, because its length is
      // not knowable. Stop with what was decoded rather than reading noise.
      break;
    }

    const left = reader.short();
    const top = reader.short();
    const frameWidth = reader.short();
    const frameHeight = reader.short();
    const framePacked = reader.byte();
    const localTable = framePacked & 0x80
      ? gifColorTable(reader, 1 << ((framePacked & 0x07) + 1))
      : null;
    const table = localTable ?? globalTable;
    if (!table) throw new GifError("This GIF has a frame with no colours.", "corrupt");

    const minCodeSize = reader.byte();
    const data = gifSubBlocks(reader);
    const indices = gifInflate(data, minCodeSize, frameWidth * frameHeight);

    if (disposal === GIF_DISPOSAL.previous) previous = canvas.slice();

    const rows = framePacked & 0x40 ? gifInterlacedRows(frameHeight) : null;
    for (let y = 0; y < frameHeight; y += 1) {
      const sourceRow = rows ? rows[y] : y;
      const canvasY = top + sourceRow;
      if (canvasY < 0 || canvasY >= height) continue;
      for (let x = 0; x < frameWidth; x += 1) {
        const canvasX = left + x;
        if (canvasX < 0 || canvasX >= width) continue;
        const index = indices[y * frameWidth + x];
        if (index === transparent) continue;
        const target = (canvasY * width + canvasX) * 4;
        canvas[target] = table.r[index] ?? 0;
        canvas[target + 1] = table.g[index] ?? 0;
        canvas[target + 2] = table.b[index] ?? 0;
        canvas[target + 3] = 255;
      }
    }

    frames.push({ rgba: canvas.slice(), delay, disposal });

    // Disposal applies AFTER the frame is shown, which is why it is here
    // and not at the top: `background` clears the rectangle this frame
    // drew, `previous` restores what was underneath it, and the other two
    // leave the canvas alone.
    if (disposal === GIF_DISPOSAL.background) {
      for (let y = top; y < top + frameHeight && y < height; y += 1) {
        for (let x = left; x < left + frameWidth && x < width; x += 1) {
          const target = (y * width + x) * 4;
          canvas[target] = 0;
          canvas[target + 1] = 0;
          canvas[target + 2] = 0;
          canvas[target + 3] = 0;
        }
      }
    } else if (disposal === GIF_DISPOSAL.previous && previous) {
      canvas.set(previous);
    }

    delay = 0;
    disposal = GIF_DISPOSAL.unspecified;
    transparent = -1;
  }

  if (frames.length === 0) throw new GifError("This GIF has no frames.", "corrupt");
  return { width, height, loops, frames };
}
