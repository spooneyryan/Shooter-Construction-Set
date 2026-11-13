// A burst as a document: parse, migrate, download, share.
//
// `core/document` owns the envelope and the transport; `normalizeBurst`
// owns the clamping. The same pairing as every format in this package, and
// the same one `sfx` uses — which is the point, because an explosion is
// the same KIND of thing as a sound effect: a small recipe a person tunes,
// shares, and expects to reproduce exactly wherever it lands.
//
// The cap is small on purpose. A burst is a dozen layers of numbers, so a
// share link is a URL rather than an attachment, and an explosion travels
// the way a sound already does.

import { defineFormat } from "../core/document.js";
import { BURST_VERSION, emptyBurst, normalizeBurst } from "./contract.js";

/**
 * @param {object} [options]
 * @param {string} [options.format] Identity tag. Effectively permanent once
 *        anything has been saved under it — give each app its own.
 * @param {number} [options.maxBytes]
 * @param {(raw: any, fromVersion: number) => any} [options.migrate]
 * @param {{event?: Function} | ((name: string, data?: unknown) => unknown)} [options.report]
 */
export function defineBurstFormat({
  format = "arcade-burst",
  maxBytes = 64 * 1024,
  migrate,
  report,
} = {}) {
  return defineFormat({
    format,
    version: BURST_VERSION,
    maxBytes,
    migrate,
    report,
    extension: "burst.json",
    // `normalizeBurst` returns a `version` of its own, which the envelope
    // is about to set anyway; dropping it keeps one authority.
    sanitize: (raw) => {
      const { version, ...body } = normalizeBurst(raw);
      void version;
      return body;
    },
  });
}

/** A blank burst in document form, envelope and all. */
export function newBurstDocument(format, name) {
  return format.parse(emptyBurst(name));
}
