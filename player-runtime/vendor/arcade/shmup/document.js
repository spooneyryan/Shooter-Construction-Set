// A level as a document: parse, migrate, download, share.
//
// `core/document` owns the envelope and the transport; this owns the clamping,
// which is the half that genuinely differs between a pinball table and a sector
// full of enemies. The two are joined here so a game gets both from one call
// rather than wiring `normalizeLevel` into `defineFormat` itself and getting
// the version negotiation subtly wrong.
//
// What this buys over the hand-rolled save Starline arrived with: refusal of
// documents from another application or a newer build, base64url share links
// with a byte cap, a download that names its own file, and a `readFile` that
// reports why a bad one was bad.

import { defineFormat } from "../core/document.js";
import { LEVEL_VERSION, emptyLevel, normalizeLevel } from "./contract.js";
import { GAME_VERSION, normalizeShmupGame } from "./game.js";

/**
 * @param {object} [options]
 * @param {string} [options.format] Identity tag. Change it and documents from
 *        the old tag are refused as foreign, so it is effectively permanent —
 *        give each game its own rather than sharing one.
 * @param {number} [options.maxBytes] Cap for share links.
 * @param {(raw: any, fromVersion: number) => any} [options.migrate] Runs before
 *        clamping, for anything older than the current version. Levels below
 *        version 3 predate this package; a game carrying them supplies this.
 * @param {{event?: Function} | ((name: string, data?: unknown) => unknown)} [options.report]
 *        Sink for `document.rejected` and `document.too-large-to-share`.
 */
export function defineLevelFormat({
  format = "arcade-shmup-level",
  maxBytes = 256 * 1024,
  migrate,
  report,
} = {}) {
  return defineFormat({
    format,
    version: LEVEL_VERSION,
    maxBytes,
    migrate,
    report,
    // `normalizeLevel` returns a `version` of its own, which the envelope is
    // about to set anyway. Dropping it here keeps one authority for the number
    // instead of two that agree until the day they do not.
    sanitize: (raw) => {
      const { version, ...body } = normalizeLevel(raw);
      void version;
      return body;
    },
  });
}

/**
 * A whole Game as a document: the ship, the shared sprites and components, and
 * every level.
 *
 * The cap is megabytes rather than the level format's quarter of one, because
 * a game carries the image sprites its levels share and those are the whole
 * reason assets moved up to it. Music is not in here and will not be: an
 * editor keeps the audio beside its games, and a level names a track.
 *
 * @param {object} [options]
 * @param {string} [options.format] Identity tag, and effectively permanent:
 *        change it and documents from the old tag are refused as foreign.
 * @param {number} [options.maxBytes] Cap for share links.
 * @param {(raw: any, fromVersion: number) => any} [options.migrate] Runs before
 *        clamping, for anything older than the current version.
 * @param {{event?: Function} | ((name: string, data?: unknown) => unknown)} [options.report]
 *        Sink for `document.rejected` and `document.too-large-to-share`.
 */
export function defineShmupGameFormat({
  format = "arcade-shmup-game",
  maxBytes = 16 * 1024 * 1024,
  migrate,
  report,
} = {}) {
  return defineFormat({
    format,
    version: GAME_VERSION,
    maxBytes,
    migrate,
    report,
    sanitize: (raw) => {
      const { version, ...body } = normalizeShmupGame(raw);
      void version;
      return body;
    },
  });
}

/** A blank level in document form, envelope and all. */
export function newLevelDocument(format, name) {
  return format.parse(emptyLevel(name));
}
