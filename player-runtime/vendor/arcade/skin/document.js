// A skin as a file you can write, and as a document you can share.
//
// The skin system could read a skin file and could not write one. `parseSkinFile`
// treats an imported file as hostile — unknown tokens dropped, unsafe values
// dropped, whatever survives layered over a known-good fallback — and has a
// whole demo page attacking it. There was no counterpart going the other way,
// so the only way to get a skin out of a game was to read it off the screen.

import { defineFormat } from "../core/document.js";
import { SKIN_CONTRACT_VERSION, tokenDefinitions } from "./contract.js";
import { isValidTokenValue, parseSkinFile } from "./skin.js";
import { defaultSkin } from "./skins.js";

/**
 * A skin as the JSON text `parseSkinFile` reads.
 *
 * The direct counterpart to that function, and validated the same way on the
 * way out: an unsafe value is dropped here rather than written to a file that
 * a stricter reader would then refuse whole. Writing something we would not
 * accept is how a format grows a dialect.
 *
 * @param {object} skin
 * @param {object} [options]
 * @param {boolean} [options.pretty] Defaults to true — a skin file is a thing
 *        people hand-edit, which is not true of most documents here.
 */
export function serializeSkin(skin, { pretty = true } = {}) {
  const tokens = {};
  for (const name of Object.keys(tokenDefinitions)) {
    const value = skin?.tokens?.[name];
    if (typeof value === "string" && isValidTokenValue(name, value)) tokens[name] = value;
  }
  return JSON.stringify(
    {
      id: typeof skin?.id === "string" ? skin.id.slice(0, 60) : "custom",
      name: typeof skin?.name === "string" ? skin.name.slice(0, 60) : "Custom skin",
      description:
        typeof skin?.description === "string" ? skin.description.slice(0, 200) : "",
      contractVersion: SKIN_CONTRACT_VERSION,
      tokens,
    },
    null,
    pretty ? 2 : 0,
  );
}

/** Hand the player a `.skin.json` they can keep, mail or re-import. */
export function downloadSkin(skin, name) {
  const blob = new Blob([serializeSkin(skin)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = globalThis.document.createElement("a");
  anchor.href = url;
  anchor.download = `${String(name ?? skin?.id ?? "skin").replace(/[^a-z0-9_-]+/gi, "-").slice(0, 60) || "skin"}.skin.json`;
  globalThis.document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoking synchronously races the download in Firefox — the same note
  // core/document carries, for the same reason.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return anchor.download;
}

/**
 * The full document format: share links, size caps, refusal reasons.
 *
 * Layered ON TOP of the plain skin file rather than replacing it. A document
 * this produces still carries `contractVersion` and `tokens`, so it is a valid
 * skin file too and `parseSkinFile` reads it unchanged — deliberately, because
 * two shapes for one concept is how a format ends up with a dialect nobody
 * documented.
 *
 * @param {object} [options]
 * @param {string} [options.format]
 * @param {number} [options.maxBytes] Cap for share links. 26 tokens of CSS
 *        values, so a skin is small and a large one is not a skin.
 * @param {object} [options.fallback] Skin to layer accepted tokens over, so a
 *        partial file still produces a complete skin. Defaults to the built-in.
 * @param {(raw: any, fromVersion: number) => any} [options.migrate]
 * @param {{event?: Function} | ((name: string, data?: unknown) => unknown)} [options.report]
 */
export function defineSkinFormat({
  format = "arcade-skin",
  maxBytes = 32 * 1024,
  fallback = defaultSkin,
  migrate,
  report,
} = {}) {
  return defineFormat({
    format,
    version: SKIN_CONTRACT_VERSION,
    maxBytes,
    migrate,
    report,
    extension: "skin.json",
    // parseSkinFile keys off `contractVersion`; the envelope keys off
    // `version`. A plain skin file has only the first, a document has both, and
    // this is the one place they have to be reconciled. Reading the file's own
    // contractVersion first -- rather than forcing the envelope's -- is what
    // keeps a v1 file from being waved through as v2 by the envelope's default.
    sanitize: (raw) =>
      parseSkinFile(
        { ...raw, contractVersion: raw?.contractVersion ?? raw?.version ?? SKIN_CONTRACT_VERSION },
        fallback,
      ),
  });
}
