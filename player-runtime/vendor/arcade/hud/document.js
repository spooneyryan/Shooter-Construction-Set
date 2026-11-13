// A HUD as a document: complete, parsed, migrated, downloaded, shared.
//
// `normalizeHud` is the contract's clamp plus the stylesheet's rules, joined
// here because `hud/contract` does not import upward and `hud/css` is where
// the rules about author CSS live. Everything that hands a HUD to a game —
// the format, the presets, the designer — comes through this function, so a
// document a game mounts never carries a stylesheet a mount would refuse.
//
// The format is the same pairing every document here uses: `core/document`
// owns the envelope and the transport, the normalizer owns the body. The
// cap is small because a HUD is a dozen readouts and a page of CSS, and a
// share link should stay a URL.

import { defineFormat } from "../core/document.js";
import { createReporter } from "../core/report.js";
import { HUD_VERSION, emptyHud, normalizeHudBody } from "./contract.js";
import { sanitizeHudCss } from "./css.js";

/**
 * The whole document, clamped, with the author's CSS checked. A refused
 * stylesheet is dropped and reported as `hud.css-rejected` with the reasons,
 * rather than refusing the document — the readouts are still a HUD without
 * it, and a designer would rather see "your CSS was refused because…" than
 * "this file is invalid".
 *
 * @param {any} [input]
 * @param {object} [options]
 * @param {{event?: Function} | ((name: string, data?: unknown) => unknown)} [options.report]
 */
export function normalizeHud(input = {}, { report } = {}) {
  const emit = createReporter(report);
  return normalizeHudBody(input, {
    sanitizeCss: (css) => {
      const result = sanitizeHudCss(css);
      if (result.rejected.length) emit("hud.css-rejected", { reasons: result.rejected });
      return result;
    },
  });
}

/**
 * @param {object} [options]
 * @param {string} [options.format] Identity tag. Effectively permanent once
 *        anything has been saved under it — give each app its own.
 * @param {number} [options.maxBytes]
 * @param {(raw: any, fromVersion: number) => any} [options.migrate]
 * @param {{event?: Function} | ((name: string, data?: unknown) => unknown)} [options.report]
 */
export function defineHudFormat({
  format = "arcade-hud",
  maxBytes = 64 * 1024,
  migrate,
  report,
} = {}) {
  return defineFormat({
    format,
    version: HUD_VERSION,
    maxBytes,
    migrate,
    report,
    extension: "hud.json",
    // The normalizer returns a `version` of its own, which the envelope is
    // about to set anyway; dropping it keeps one authority.
    sanitize: (raw) => {
      const { version, ...body } = normalizeHud(raw, { report });
      void version;
      return body;
    },
  });
}

/** A blank HUD in document form, envelope and all. */
export function newHudDocument(format, name) {
  return format.parse(emptyHud(name));
}
