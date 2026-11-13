// A course as a document: parse, migrate, download, share.
//
// `core/document` owns the envelope and the transport; `normalizeWheelsCourse`
// owns the clamping and the repairs. The same pairing as every format in
// this package.
//
// **A course is small, and that is a design property rather than luck.**
// The ground is a segment list — eleven of them describe a minute of
// riding — where a tile grid of the same course would be tens of
// thousands of cells. So a whole level fits in a share link with room to
// spare, which is the thing that makes a track editor worth building and
// a "beat my time" link worth sending.

import { defineFormat } from "../core/document.js";
import { WHEELS_VERSION, emptyWheelsCourse, normalizeWheelsCourse } from "./contract.js";

/**
 * @param {object} [options]
 * @param {string} [options.format] Identity tag. Effectively permanent once
 *        anything has been saved under it — give each app its own.
 * @param {number} [options.maxBytes] Cap for share links. Generous, because
 *        the heavy part of a course is its prop list, not its ground.
 * @param {(raw: any, fromVersion: number) => any} [options.migrate]
 * @param {{event?: Function} | ((name: string, data?: unknown) => unknown)} [options.report]
 */
export function defineWheelsFormat({
  format = "arcade-wheels-course",
  maxBytes = 512 * 1024,
  migrate,
  report,
} = {}) {
  return defineFormat({
    format,
    version: WHEELS_VERSION,
    maxBytes,
    migrate,
    report,
    extension: "course.json",
    // `normalizeWheelsCourse` returns a `version` of its own, which the
    // envelope is about to set anyway; dropping it keeps one authority.
    sanitize: (raw) => {
      const { version, ...body } = normalizeWheelsCourse(raw);
      void version;
      return body;
    },
  });
}

/** A blank course in document form, envelope and all. */
export function newWheelsDocument(format, name) {
  return format.parse(emptyWheelsCourse(name));
}
