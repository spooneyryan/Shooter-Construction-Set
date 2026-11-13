// A designed sound as a document: parse, migrate, download, share.
//
// `core/document` owns the envelope and the transport; `normalizeSfx` owns the
// clamping. The pairing is exactly the one `shmup/document` makes for a level,
// and it exists for the same reason it did there — every consumer that needed
// to move one of these around wrote its own transport.
//
// What it replaces: `SfxStudio` built a Blob out of `JSON.stringify(sound)` and
// clicked a synthetic anchor, and read one back with a bare `JSON.parse`. That
// works until a file arrives from somewhere. There was no way to tell a sound
// from another application's JSON, no way to refuse a document written by a
// newer build, no size cap, and no share link — a sound is a couple of hundred
// bytes, which makes it the format in this package most obviously suited to
// being pasted into a chat window.

import { defineFormat } from "../core/document.js";
import { SFX_VERSION, createDefaultSfx, normalizeSfx } from "./synth.js";

/**
 * @param {object} [options]
 * @param {string} [options.format] Identity tag. Change it and documents
 *        written under the old tag are refused as foreign, so it is
 *        effectively permanent.
 * @param {number} [options.maxBytes] Cap for share links. Small by the
 *        standards of this module's default: a sound is ~30 numbers, so a
 *        document anywhere near 256 KB is not a sound.
 * @param {(raw: any, fromVersion: number) => any} [options.migrate]
 * @param {{event?: Function} | ((name: string, data?: unknown) => unknown)} [options.report]
 */
export function defineSfxFormat({
  format = "arcade-sfx",
  maxBytes = 16 * 1024,
  migrate,
  report,
} = {}) {
  return defineFormat({
    format,
    version: SFX_VERSION,
    maxBytes,
    migrate,
    report,
    extension: "sfx.json",
    // normalizeSfx stamps a `version` of its own, which the envelope is about
    // to set anyway. Dropped here so there is one authority for the number
    // rather than two that agree until the day they do not — the same call
    // `shmup/document` makes about normalizeLevel.
    sanitize: (raw) => {
      const { version, ...body } = normalizeSfx(raw);
      void version;
      return body;
    },
  });
}

/** A blank sound in document form, envelope and all. */
export function newSfxDocument(format, name = "Untitled") {
  return format.parse(createDefaultSfx(name));
}
