// A game as a document: parse, migrate, download, share.
//
// `core/document` owns the envelope and the transport; `normalizeGame` owns
// the clamping. Same pairing as every other format in this package, and the
// same reason: refusal of foreign and future documents, base64url share
// links with a byte cap, and a download that names its own file, none of
// which a bare JSON.parse can do.
//
// One format for the whole game rather than one per level, because a level
// references definitions the game owns — actors, tilesets, sprites — and a
// level document that travels without them is a bag of dangling ids. The
// unit a person shares is the game.

import { defineFormat } from "../core/document.js";
import { RUNNJUMP_VERSION, emptyGame, normalizeGame } from "./contract.js";

/**
 * @param {object} [options]
 * @param {string} [options.format] Identity tag. Effectively permanent once
 *        anything has been saved under it — give each app its own.
 * @param {number} [options.maxBytes] Cap for share links. Grids are RLE and
 *        sprites are the heavy part, so this sits between the sprite and the
 *        sprite-library caps.
 * @param {(raw: any, fromVersion: number) => any} [options.migrate]
 * @param {{event?: Function} | ((name: string, data?: unknown) => unknown)} [options.report]
 */
export function defineGameFormat({
  format = "arcade-runnjump-game",
  maxBytes = 1024 * 1024,
  migrate,
  report,
} = {}) {
  return defineFormat({
    format,
    version: RUNNJUMP_VERSION,
    maxBytes,
    migrate,
    report,
    extension: "runnjump.json",
    // `normalizeGame` returns a `version` of its own, which the envelope is
    // about to set anyway; dropping it keeps one authority for the number.
    sanitize: (raw) => {
      const { version, ...body } = normalizeGame(raw);
      void version;
      return body;
    },
  });
}

/** A blank game in document form, envelope and all. */
export function newGameDocument(format, name) {
  return format.parse(emptyGame(name));
}
