// A versioned document format: parse, serialize, download, share, migrate.
//
// Pinball's `sanitizeTableDocument` and Starline's `normalizeLevel` are the
// same function with different field lists — an envelope check, a refusal to
// open documents from the future, and a deep clamp of everything inside. This
// keeps the envelope and the transport, and leaves the field clamping to the
// game, which is the only part that genuinely differs.

import { createReporter } from "./report.js";
import { safeFilename, uniqueId } from "./validate.js";

export class DocumentError extends Error {
  constructor(message, reason = "invalid", options) {
    super(message, options);
    this.name = "DocumentError";
    this.reason = reason;
  }
}

function bytesToBase64Url(bytes) {
  let binary = "";
  // Chunked so a large document cannot blow the argument limit on apply().
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  let binary;
  try {
    binary = atob(padded);
  } catch {
    throw new DocumentError("The shared link is not valid base64.", "corrupt");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * @param {object} options
 * @param {string} options.format     Identity tag written into every document.
 * @param {number} options.version    Current schema version.
 * @param {(raw: any, context: {version: number}) => any} options.sanitize
 *        Clamps the body. Throw a DocumentError for anything unrecoverable.
 * @param {(raw: any, fromVersion: number) => any} [options.migrate]
 * @param {number} [options.maxBytes] Cap for share links.
 * @param {string} [options.extension]
 * @param {{event?: Function} | ((name: string, data?: unknown) => void)} [options.report]
 *        Sink for `document.rejected` and `document.too-large-to-share`.
 */
export function defineFormat({
  format,
  version,
  sanitize,
  migrate,
  maxBytes = 256 * 1024,
  extension = "json",
  report,
}) {
  if (!format) throw new Error("A document format needs a format tag.");
  if (typeof sanitize !== "function") throw new Error("A document format needs a sanitize function.");

  // Which documents get turned away, and why. A spike in "future" means players
  // are on stale builds; a spike in "corrupt" means something upstream is
  // truncating saves. Neither is visible without counting.
  const emit = createReporter(report);

  /** Strip the envelope, migrate, clamp, then put a fresh envelope back on. */
  function parse(input) {
    try {
      return parseInner(input);
    } catch (error) {
      emit("document.rejected", {
        format,
        reason: error instanceof DocumentError ? error.reason : "invalid",
      });
      throw error;
    }
  }

  function parseInner(input) {
    if (input === null || input === undefined) {
      throw new DocumentError("There is no document here.", "empty");
    }
    const raw = typeof input === "string" ? parseJson(input) : input;
    // `typeof null === "object"`, so null has to be excluded by hand or the
    // field reads below throw a TypeError instead of a DocumentError. A
    // truncated file whose whole body is the literal `null` parses to exactly
    // that.
    if (!raw || typeof raw !== "object") {
      throw new DocumentError("This file does not contain a document.", "invalid");
    }
    if (raw.format && raw.format !== format) {
      throw new DocumentError("This file belongs to a different application.", "foreign");
    }
    const storedVersion = Number(raw.version ?? version);
    if (!Number.isFinite(storedVersion)) {
      throw new DocumentError("This document has no readable version.", "invalid");
    }
    if (storedVersion > version) {
      throw new DocumentError("This document was created by a newer version of the game.", "future");
    }
    const upgraded = storedVersion < version && typeof migrate === "function"
      ? migrate(raw, storedVersion)
      : raw;
    const body = sanitize(upgraded, { version: storedVersion });
    return {
      ...body,
      format,
      version,
      savedAt: typeof raw.savedAt === "string" ? raw.savedAt : new Date().toISOString(),
    };
  }

  function parseJson(text) {
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new DocumentError("This file is not valid JSON.", "corrupt", { cause: error });
    }
  }

  /** Round-trips through parse so a serialized document is always valid. */
  function serialize(document, { pretty = false } = {}) {
    const clean = parse(document);
    return JSON.stringify(clean, null, pretty ? 2 : 0);
  }

  function encodeShare(document) {
    const bytes = new TextEncoder().encode(serialize(document));
    if (bytes.byteLength > maxBytes) {
      // Worth counting separately from a rejected import: this is the player's
      // own work hitting a cap we chose, which is a reason to reconsider it.
      emit("document.too-large-to-share", {
        format,
        kilobytes: Math.ceil(bytes.byteLength / 1024),
        capKilobytes: Math.floor(maxBytes / 1024),
      });
      throw new DocumentError(
        `This document is too large to share as a link (${Math.ceil(bytes.byteLength / 1024)} KB of ${Math.floor(maxBytes / 1024)} KB).`,
        "too-large",
      );
    }
    return bytesToBase64Url(bytes);
  }

  function decodeShare(encoded) {
    const bytes = base64UrlToBytes(encoded);
    if (bytes.byteLength > maxBytes) {
      throw new DocumentError("The shared document is larger than this game accepts.", "too-large");
    }
    let json;
    try {
      json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new DocumentError("The shared text is not valid UTF-8.", "corrupt", { cause: error });
    }
    return parse(json);
  }

  return {
    format,
    version,
    maxBytes,
    parse,
    serialize,
    encodeShare,
    decodeShare,

    /** A blank envelope for "new document". */
    create(body = {}) {
      return parse({ ...body, format, version, savedAt: new Date().toISOString() });
    },

    id: () => uniqueId(format),

    filename(name) {
      return safeFilename(name, format, extension);
    },

    toBlob(document) {
      return new Blob([serialize(document, { pretty: true })], { type: "application/json" });
    },

    /**
     * @param {any} document
     * @param {string} [name] Falls back to the document's own `name` field.
     */
    download(document, name) {
      const url = URL.createObjectURL(toBlobSafely(document));
      const anchor = globalThis.document.createElement("a");
      anchor.href = url;
      anchor.download = safeFilename(name ?? document?.name, format, extension);
      globalThis.document.body.append(anchor);
      anchor.click();
      anchor.remove();
      // Revoking synchronously races the download in Firefox.
      setTimeout(() => URL.revokeObjectURL(url), 0);
      return anchor.download;

      function toBlobSafely(value) {
        return new Blob([serialize(value, { pretty: true })], { type: "application/json" });
      }
    },

    async readFile(file) {
      return parse(await file.text());
    },

    /**
     * `https://host/path#doc=<base64url>`
     *
     * @param {object} document
     * @param {object} [options]
     * @param {string} [options.baseUrl] Overrides the page's own URL, for a
     *        link meant to be opened somewhere else.
     * @param {string} [options.param]
     * @param {Location} [options.location]
     */
    shareLink(document, { baseUrl, param = "doc", location = globalThis.location } = {}) {
      const isWebPage = location?.protocol === "http:" || location?.protocol === "https:";
      const target = isWebPage && !baseUrl
        ? `${location.origin}${location.pathname}`
        : baseUrl;
      if (!target) throw new DocumentError("No base URL is available for a share link.", "invalid");
      const url = new URL(target);
      url.hash = `${param}=${encodeShare(document)}`;
      return url.toString();
    },

    /**
     * Reads and then clears the share parameter, so a reload does not reopen
     * the shared document over whatever the player has since been editing.
     * Only its own parameter goes: anything else in the fragment -- a host's
     * state, another link's parameter -- is kept as it was written.
     * Never throws — a broken link should surface as a message, not a crash.
     */
    readShareFromLocation({ location = globalThis.location, history = globalThis.history, param = "doc" } = {}) {
      const fragment = String(location?.hash ?? "").replace(/^#/, "");
      const encoded = new URLSearchParams(fragment).get(param);
      if (!encoded) return { document: null, error: null };
      try {
        return { document: decodeShare(encoded), error: null };
      } catch (error) {
        return { document: null, error: error instanceof Error ? error.message : "invalid shared document" };
      } finally {
        // Split by hand rather than round-tripping URLSearchParams, which
        // would rewrite a plain anchor ("#top") as "top=".
        const kept = fragment.split("&").filter((part) => part && part.split("=")[0] !== param).join("&");
        try {
          history?.replaceState(null, "", `${location.pathname}${location.search}${kept ? `#${kept}` : ""}`);
        } catch {
          // The document is already decoded; a restrictive URL policy should
          // not stop it from opening.
        }
      }
    },
  };
}
