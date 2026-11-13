// A track as a document: parse, migrate, download, share.
//
// `core/document` owns the envelope and the transport; `normalizeRacingTrack`
// owns the clamping and the repairs. The same pairing as every format in
// this package.
//
// **A track is small, and that is a design property rather than luck.** Its
// geometry is a route — a few dozen nodes with a width each — where a
// painted tile map of the same circuit would be tens of thousands of cells.
// So a whole track, hazards and field included, fits in a share link with
// room to spare, which is the thing that makes a track editor worth building
// and a "beat my lap" link worth sending.

import { defineFormat } from "../core/document.js";
import { RACING_VERSION, emptyRacingTrack, normalizeRacingTrack } from "./contract.js";

/**
 * @param {object} [options]
 * @param {string} [options.format] Identity tag. Effectively permanent once
 *        anything has been saved under it — give each app its own.
 * @param {number} [options.maxBytes] Cap for share links.
 * @param {(raw: any, fromVersion: number) => any} [options.migrate]
 * @param {{event?: Function} | ((name: string, data?: unknown) => unknown)} [options.report]
 */
export function defineRacingFormat({
  format = "arcade-racing-track",
  maxBytes = 512 * 1024,
  migrate,
  report,
} = {}) {
  return defineFormat({
    format,
    version: RACING_VERSION,
    maxBytes,
    migrate,
    report,
    extension: "track.json",
    // `normalizeRacingTrack` returns a `version` of its own, which the
    // envelope is about to set anyway; dropping it keeps one authority.
    sanitize: (raw) => {
      const { version, ...body } = normalizeRacingTrack(raw);
      void version;
      return body;
    },
  });
}

/** A blank track in document form, envelope and all. */
export function newRacingDocument(format, name) {
  return format.parse(emptyRacingTrack(name));
}
