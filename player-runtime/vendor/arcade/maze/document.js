// A maze level as a document: parse, migrate, download, share.
//
// `core/document` owns the envelope and the transport; `normalizeMazeLevel`
// owns the clamping and the arena repairs. The same pairing as every format
// in this package. The unit a person shares is one level, and a level is
// self-contained — a grid of small integers, placements, and rules.

import { defineFormat } from "../core/document.js";
import { MAZE_VERSION, emptyMazeLevel, normalizeMazeLevel } from "./contract.js";

/**
 * @param {object} [options]
 * @param {string} [options.format] Identity tag. Effectively permanent once
 *        anything has been saved under it — give each app its own.
 * @param {number} [options.maxBytes] Cap for share links. A field is a few
 *        thousand small integers, so the default is modest.
 * @param {(raw: any, fromVersion: number) => any} [options.migrate]
 * @param {{event?: Function} | ((name: string, data?: unknown) => unknown)} [options.report]
 */
export function defineMazeFormat({
  format = "arcade-maze-level",
  maxBytes = 128 * 1024,
  migrate,
  report,
} = {}) {
  return defineFormat({
    format,
    version: MAZE_VERSION,
    maxBytes,
    migrate,
    report,
    extension: "maze.json",
    // `normalizeMazeLevel` returns a `version` of its own, which the
    // envelope is about to set anyway; dropping it keeps one authority.
    sanitize: (raw) => {
      const { version, ...body } = normalizeMazeLevel(raw);
      void version;
      return body;
    },
  });
}

/** A blank sealed arena in document form, envelope and all. */
export function newMazeLevelDocument(format, name) {
  return format.parse(emptyMazeLevel(name));
}
