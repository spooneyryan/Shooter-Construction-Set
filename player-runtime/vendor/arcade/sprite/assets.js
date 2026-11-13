// Sprite assets: the shapes a drawn thing travels as.
//
// Promoted out of `shmup/contract.js` on 2026-08-22, the day a second genre
// wanted them. A raster or vector sprite is not a scrolling-shooter concept —
// `@ccllc/studio` was already importing these types from `/shmup` and reading
// wrong — so they live here now, and `shmup` re-exports them unchanged. No
// consumer moved on the day this did.
//
// The code itself is the code that was there: same caps, same stance that a
// level or a game is something a player can be handed by a stranger, and an
// asset list is the part of it that is unbounded by construction.
//
// Three kinds now. `raster` is a pixel grid — one colour string per cell,
// capped small, the format palette swaps and indexed rendering want.
// `vector` is shapes. `image` is a full-resolution picture carried as a
// data URL, added 2026-08-31 because the grid could not hold one and
// widening it would have meant a million strings a sprite. They are three
// kinds rather than two-with-a-mode so that no consumer has to branch on
// storage while pretending it is not branching.

import { uniqueId } from "../core/validate.js";

/**
 * Plain range clamp for values already known to be numbers.
 *
 * The asset-carrying modules (this one, `runnjump`) share this single
 * declaration rather than each writing their own, because Pinball's
 * standalone exporter concatenates this package's modules into one flat
 * scope and two modules declaring the same top-level name is a SyntaxError
 * there — the reason `tests/flat-scope.test.mjs` exists. `shmup` and `sfx`
 * keep their own private copies; those predate this file and un-clashing
 * them is recorded in docs/future.md.
 *
 * @param {number} value
 * @param {number} min
 * @param {number} max
 */
export const clampTo = (value, min, max) => Math.max(min, Math.min(max, value));

/**
 * The image types an `image` asset may carry, and the reason there is a
 * list at all.
 *
 * This is the first thing this package stores that a browser will
 * INTERPRET rather than display: a data URL goes into an `<img src>`, and
 * an asset list arrives inside levels and games that strangers share. SVG
 * is the one that matters — it is a document format with a script element,
 * and while a modern browser refuses to run script for an image loaded as
 * `<img>`, that guarantee belongs to one loading context and the same
 * string put in an `<object>`, a CSS `url()` or an `<iframe>` by some
 * future consumer would not have it. So the allowlist is three raster
 * formats and it is checked here, once, where every asset passes.
 */
export const IMAGE_MIME_TYPES = Object.freeze(["image/png", "image/jpeg", "image/webp"]);

/**
 * How long an image asset's data URL may be.
 *
 * Six megabytes of base64 is about four and a half of pixels: a
 * 2048-square PNG with room to spare, and far more than a sprite. The cap
 * exists because an asset list is the unbounded part of a shared document
 * and one hundred assets is already the list's own limit — without this,
 * that limit is one hundred times whatever a stranger felt like sending.
 */
export const IMAGE_MAX_DATA = 6 * 1024 * 1024;

const IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

/**
 * Whether a string is a data URL this package will store and hand to an
 * `<img>`. Exported because an importer wants to check before building an
 * asset, and because "what is a legal image here" should have one answer.
 *
 * @param {unknown} value
 */
export function isImageData(value) {
  if (typeof value !== "string" || value.length > IMAGE_MAX_DATA) return false;
  const match = IMAGE_DATA_URL.exec(value);
  if (!match) return false;
  // Base64 arrives in four-character groups. A length that is not a
  // multiple of four is truncated, and a truncated data URL renders as a
  // broken image with no explanation anywhere.
  return match[2].length % 4 === 0;
}

/** The mime type of a data URL this package accepts, or null. */
export function imageDataType(value) {
  if (!isImageData(value)) return null;
  return IMAGE_DATA_URL.exec(String(value))[1];
}

/**
 * Clamp a list of sprite assets into range, dropping what it cannot read.
 *
 * Caps everywhere: an asset list arrives inside levels and games that
 * strangers share, and it is the unbounded part of them. Dropping a bad
 * entry rather than refusing the file is the right stance at this
 * granularity — one unreadable sprite must not cost somebody the level it
 * rode in on. `defineSpriteFormat` takes the opposite stance for a file
 * that IS one sprite.
 *
 * @param {unknown} input
 */
export function normalizeAssets(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 100).map((asset) => {
    if (!asset || typeof asset.id !== "string" || typeof asset.name !== "string") return null;
    if (asset.kind === "raster") {
      const width = clampTo(Math.round(Number(asset.width) || 16), 8, 128);
      const height = clampTo(Math.round(Number(asset.height) || width), 8, 128);
      const pixels = Array.from({ length: width * height }, (_, index) =>
        (typeof asset.pixels?.[index] === "string" && asset.pixels[index].length <= 24 ? asset.pixels[index] : ""));
      return { id: asset.id, name: asset.name.slice(0, 80), kind: "raster", width, height, pixels };
    }
    if (asset.kind === "image") {
      // A full-resolution picture: the bytes as a data URL, and the size
      // they decode to. Deliberately NOT the `raster` kind with a bigger
      // cap — a grid of named colour strings is the right structure for
      // pixel art and the wrong one for a photograph, and 1024 square
      // would be a million strings per sprite. The two convert into each
      // other on purpose (`sprite/quantize`), which is a better story
      // than one kind that is secretly two.
      if (!isImageData(asset.data)) return null;
      return {
        id: asset.id,
        name: asset.name.slice(0, 80),
        kind: "image",
        width: clampTo(Math.round(Number(asset.width) || 1), 1, 4096),
        height: clampTo(Math.round(Number(asset.height) || 1), 1, 4096),
        data: asset.data,
      };
    }
    if (asset.kind === "vector") {
      const width = clampTo(Number(asset.width) || 256, 32, 1024);
      const height = clampTo(Number(asset.height) || 256, 32, 1024);
      const shapes = (Array.isArray(asset.shapes) ? asset.shapes : [])
        .slice(0, 500)
        .filter((shape) => ["rect", "ellipse", "line", "path"].includes(shape.type))
        .map((shape) => ({
          ...shape,
          id: String(shape.id || uniqueId("shape")),
          x: clampTo(Number(shape.x) || 0, -width * 2, width * 3),
          y: clampTo(Number(shape.y) || 0, -height * 2, height * 3),
          w: clampTo(Number(shape.w) || 0, -width * 3, width * 3),
          h: clampTo(Number(shape.h) || 0, -height * 3, height * 3),
          strokeWidth: clampTo(Number(shape.strokeWidth) || 1, 0.1, 50),
          rotation: Number(shape.rotation) || 0,
          points: shape.points?.slice(0, 1000).map((point) => ({
            x: clampTo(Number(point.x) || 0, -width * 2, width * 3),
            y: clampTo(Number(point.y) || 0, -height * 2, height * 3),
          })),
        }));
      return { id: asset.id, name: asset.name.slice(0, 80), kind: "vector", width, height, shapes };
    }
    return null;
  }).filter(Boolean);
}
