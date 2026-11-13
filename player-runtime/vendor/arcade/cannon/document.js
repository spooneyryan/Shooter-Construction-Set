// A cannon level as a document: parse, migrate, download, share.
//
// `core/document` owns the envelope and the transport; `normalizeCannonLevel`
// owns the clamping. The same pairing as every format in this package, for
// the same reason: refusal of foreign and future documents, base64url share
// links with a byte cap, and a download that names its own file — none of
// which a bare JSON.parse can do.
//
// The unit a person shares is one level. Unlike `runnjump`, whose levels
// reference definitions a game owns, a cannon level is self-contained —
// materials are overrides over the module's own table — so there is nothing
// for a travelling level to dangle.

import { defineFormat } from "../core/document.js";
import { CANNON_VERSION, emptyCannonLevel, normalizeCannonLevel } from "./contract.js";

/**
 * @param {object} [options]
 * @param {string} [options.format] Identity tag. Effectively permanent once
 *        anything has been saved under it — give each app its own.
 * @param {number} [options.maxBytes] Cap for share links. A level is a few
 *        hundred blocks of small numbers, so the default is modest.
 * @param {(raw: any, fromVersion: number) => any} [options.migrate]
 * @param {{event?: Function} | ((name: string, data?: unknown) => unknown)} [options.report]
 */
export function defineCannonFormat({
  format = "arcade-cannon-level",
  maxBytes = 256 * 1024,
  migrate,
  report,
} = {}) {
  return defineFormat({
    format,
    version: CANNON_VERSION,
    maxBytes,
    migrate,
    report,
    extension: "cannon.json",
    // `normalizeCannonLevel` returns a `version` of its own, which the
    // envelope is about to set anyway; dropping it keeps one authority.
    sanitize: (raw) => {
      const { version, ...body } = normalizeCannonLevel(raw);
      void version;
      return body;
    },
  });
}

/** A blank level in document form, envelope and all. */
export function newCannonLevelDocument(format, name) {
  return format.parse(emptyCannonLevel(name));
}
