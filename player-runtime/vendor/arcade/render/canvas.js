// Where a drawing surface comes from.
//
// Internal to `render/`, and separate from its two callers for a reason the
// flat-scope test found: Pinball concatenates this package's modules into one
// scope, so two modules declaring `browserCanvas` cannot both exist. One
// definition, imported twice, is also just the right shape.

/**
 * A canvas to draw into. `OffscreenCanvas` where it exists — it is cheaper to
 * create, never joins the document, and works in a worker — and a detached
 * element otherwise.
 *
 * Off a browser there is neither, so callers that need to run in node (tests,
 * a headless renderer) pass their own factory rather than getting a stub they
 * did not ask for.
 *
 * @param {number} width
 * @param {number} height
 * @param {string} who Named in the error, so a caller off a browser is told
 *        which option to pass rather than which internal failed.
 */
export function browserCanvas(width, height, who = "This module") {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(width, height);
  if (typeof document === "undefined") {
    throw new Error(`${who} needs a canvas: pass \`createCanvas\` off a browser.`);
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/**
 * Give a canvas its size and hand back a 2d context.
 *
 * The size is set even when it looks right: a factory may have returned a
 * canvas at some other size, and an `OffscreenCanvas` took its size in the
 * constructor where a DOM canvas did not. Assigning width or height also
 * clears a canvas, so it is guarded — a needless clear here would throw away a
 * cache that was about to be reused.
 *
 * @param {any} canvas
 * @param {number} width
 * @param {number} height
 * @param {string} who
 */
export function context2d(canvas, width, height, who = "This module") {
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error(`${who} could not get a 2d context.`);
  return context;
}
