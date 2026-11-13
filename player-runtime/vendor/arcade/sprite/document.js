// A sprite as a document: parse, migrate, download, share.
//
// Moved here from `shmup/sprite-document.js` with the rest of the sprite
// module; the reasoning below is that file's, unchanged.
//
// The sprite editors were the only designers in this repository with NO file
// I/O at all — no export, no import, no download. Somebody could draw a ship in
// the studio demo and have nowhere to put it, and a game integrating the editor
// had to invent transport from scratch. This is that transport, and it is the
// same three lines over `core/document` the level and the pattern get.
//
// One asset per document, deliberately. `normalizeAssets` clamps a whole
// library at once because that is how a level carries them, but a file a person
// downloads, mails and re-opens is one sprite — and a format whose unit is
// "somebody's entire asset library" cannot express sending one ship to a
// friend. Use `defineSpriteLibraryFormat` when the unit really is the library.

import { defineFormat, DocumentError } from "../core/document.js";
import { normalizeAssets } from "./assets.js";

/**
 * Sprite schema version. All three kinds share it: they are one union at
 * every call site that matters (`SpriteStudio` dispatches on `kind`), so
 * versioning them apart would mean numbers that must be bumped together.
 *
 * Adding the `image` kind on 2026-08-31 did NOT bump it. A version is a
 * promise about documents that already exist, and every document written
 * under version 1 still reads exactly as it did — the new kind is a value
 * the union could not previously hold, not a change to one it could. What
 * would bump it is changing what `raster` or `vector` mean.
 */
export const SPRITE_VERSION = 1;

/** Clamp exactly one asset, refusing anything that is not a sprite at all. */
function sanitizeOne(raw) {
  const [asset] = normalizeAssets([raw]);
  if (!asset) {
    // normalizeAssets drops what it cannot understand, which is right for a
    // library -- one bad entry should not lose the other ninety-nine -- and
    // wrong here, where dropping the only asset would hand back an empty
    // document and call it success.
    throw new DocumentError(
      "This document is not a sprite.",
      "invalid",
    );
  }
  return asset;
}

/**
 * @param {object} [options]
 * @param {string} [options.format]
 * @param {number} [options.maxBytes] Cap for share links, and ONLY those:
 *        `download` and `readFile` are not capped, which is what lets a
 *        full-resolution `image` asset be a file while staying too big to
 *        be a URL. A 128x128 raster is 16,384 colour strings, so this is
 *        roomier than the sound's; a megapixel photograph is not going to
 *        fit under it and is not meant to.
 * @param {(raw: any, fromVersion: number) => any} [options.migrate]
 * @param {{event?: Function} | ((name: string, data?: unknown) => unknown)} [options.report]
 */
export function defineSpriteFormat({
  format = "arcade-sprite",
  maxBytes = 512 * 1024,
  migrate,
  report,
} = {}) {
  return defineFormat({
    format,
    version: SPRITE_VERSION,
    maxBytes,
    migrate,
    report,
    extension: "sprite.json",
    sanitize: sanitizeOne,
  });
}

/**
 * The whole library as one document, for a game that saves its assets together.
 * Drops what it cannot read rather than refusing the file, which is
 * `normalizeAssets`' own stance and the right one at this granularity.
 *
 * @param {object} [options]
 * @param {string} [options.format]
 * @param {number} [options.maxBytes] Cap for share links. A hundred sprites,
 *        so roomier than the single-asset format by the same factor.
 * @param {(raw: any, fromVersion: number) => any} [options.migrate]
 * @param {{event?: Function} | ((name: string, data?: unknown) => unknown)} [options.report]
 */
export function defineSpriteLibraryFormat({
  format = "arcade-sprite-library",
  maxBytes = 4 * 1024 * 1024,
  migrate,
  report,
} = {}) {
  return defineFormat({
    format,
    version: SPRITE_VERSION,
    maxBytes,
    migrate,
    report,
    extension: "sprites.json",
    sanitize: (raw) => ({
      name: typeof raw?.name === "string" ? raw.name.slice(0, 80) : "Sprites",
      assets: normalizeAssets(raw?.assets),
    }),
  });
}
