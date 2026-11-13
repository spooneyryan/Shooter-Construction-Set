// A top-down world as a document: parse, migrate, download, share.
//
// `core/document` owns the envelope and the transport; `normalizeTopdownWorld`
// owns the clamping and the repairs. The same pairing as every format in
// this package.
//
// **The unit a person shares is the whole world, not one map** — the same
// call `runnjump` made and for the same reason: a map references actor
// definitions the world owns, so a map travelling alone is a bag of
// dangling ids. A procedural crawl is the happy exception that proves the
// design: its floors are a seed in `rules`, so sharing the world shares
// the dungeon.

import { defineFormat } from "../core/document.js";
import { TOPDOWN_VERSION, emptyTopdownWorld, normalizeTopdownWorld } from "./contract.js";

/**
 * @param {object} [options]
 * @param {string} [options.format] Identity tag. Effectively permanent once
 *        anything has been saved under it — give each app its own.
 * @param {number} [options.maxBytes] Cap for share links. Tile grids are the
 *        heavy part, so this sits where a few maps fit and a campaign does
 *        not pretend to.
 * @param {(raw: any, fromVersion: number) => any} [options.migrate]
 * @param {{event?: Function} | ((name: string, data?: unknown) => unknown)} [options.report]
 */
export function defineTopdownFormat({
  format = "arcade-topdown-world",
  maxBytes = 1024 * 1024,
  migrate,
  report,
} = {}) {
  return defineFormat({
    format,
    version: TOPDOWN_VERSION,
    maxBytes,
    migrate,
    report,
    extension: "topdown.json",
    // `normalizeTopdownWorld` returns a `version` of its own, which the
    // envelope is about to set anyway; dropping it keeps one authority.
    sanitize: (raw) => {
      const { version, ...body } = normalizeTopdownWorld(raw);
      void version;
      return body;
    },
  });
}

/** A blank world in document form, envelope and all. */
export function newTopdownDocument(format, name) {
  return format.parse(emptyTopdownWorld(name));
}
