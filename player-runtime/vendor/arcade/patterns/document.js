// A bullet pattern as a document: parse, migrate, download, share.
//
// Same pairing as `document.js` beside it — `core/document` for the envelope
// and the transport, `normalizeBulletPattern` for the clamping — and written
// for the same reason: `BulletPatternStudio` had grown its own `exportPattern`
// out of `JSON.stringify` and a synthetic anchor, and its own `importPattern`
// out of `JSON.parse`. Neither could tell a pattern from any other JSON, refuse
// one written by a newer build, or cap what it accepted.
//
// The share link is the part worth having. A pattern is the most obviously
// swappable thing in this package — it is the artefact somebody actually wants
// to send to somebody else — and `#doc=` costs nothing on top of a format that
// already exists.

import { defineFormat } from "../core/document.js";
import { createDefaultBulletPattern, normalizeBulletPattern } from "./patterns.js";

/** The pattern schema version. Lives on the document, not in the envelope. */
export const BULLET_PATTERN_VERSION = 1;

/**
 * @param {object} [options]
 * @param {string} [options.format] Identity tag; effectively permanent once
 *        anything has been saved under it.
 * @param {number} [options.maxBytes] Cap for share links. Six emitters with
 *        twelve oscillators each is a few kilobytes, so 64 KB is generous.
 * @param {(raw: any, fromVersion: number) => any} [options.migrate]
 * @param {{event?: Function} | ((name: string, data?: unknown) => unknown)} [options.report]
 */
export function defineBulletPatternFormat({
  format = "arcade-bullet-pattern",
  maxBytes = 64 * 1024,
  migrate,
  report,
} = {}) {
  return defineFormat({
    format,
    version: BULLET_PATTERN_VERSION,
    maxBytes,
    migrate,
    report,
    extension: "pattern.json",
    // normalizeBulletPattern insists on seeing its own version and answers the
    // default pattern when it does not, which would silently turn a document
    // the envelope has already accepted into an empty one. The envelope has
    // done the version negotiation by this point -- refusing the future,
    // running any migration -- so the number it settled on is stamped back on
    // before clamping.
    sanitize: (raw) => {
      const { version, ...body } = normalizeBulletPattern({
        ...raw,
        version: BULLET_PATTERN_VERSION,
      });
      void version;
      return body;
    },
  });
}

/** A blank pattern in document form, envelope and all. */
export function newBulletPatternDocument(format, name = "Pendulum Sweep") {
  return format.parse(createDefaultBulletPattern(name));
}
