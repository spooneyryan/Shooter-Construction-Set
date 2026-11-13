// Canvas sizing: device pixel ratio, letterboxing, and pointer mapping.
//
// Starline and Pinball each grew their own version of this. Starline's caps DPR
// at 2 and letterboxes a fixed design space; Pinball's tracks a zoom level and
// draws at table coordinates. Both are covered here by the `mode` option.
//
// Nothing here is a singleton: a display owns exactly one canvas, so two games
// can share a page.

const MODES = new Set(["letterbox", "stretch", "native"]);
const SCALE_MODES = new Set(["fit", "integer"]);

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object} [options]
 * @param {number} [options.designWidth]  World-space width. Ignored in "native".
 * @param {number} [options.designHeight]
 * @param {number} [options.dprCap] Backing-store multiplier ceiling. Above ~2
 *        the cost is real and the visible gain is not.
 * @param {"letterbox"|"stretch"|"native"} [options.mode]
 * @param {"fit"|"integer"} [options.scaleMode] Integer scaling snaps a
 *        letterboxed design space to whole backing pixels. It still shrinks
 *        to fit when the canvas is smaller than the design space.
 * @param {boolean} [options.autoResize]
 * @param {string} [options.contextType] Passed straight to getContext. "2d"
 *        by default; anything else is honoured, and the transform handling
 *        below feature-detects rather than assuming.
 * @param {object} [options.contextAttributes] Second argument to getContext,
 *        e.g. `{ alpha: false }`.
 */
export function createDisplay(canvas, options = {}) {
  const {
    designWidth = 1280,
    designHeight = 720,
    dprCap = 2,
    mode = "letterbox",
    scaleMode = "fit",
    autoResize = true,
    contextType = "2d",
    contextAttributes,
  } = options;

  if (!canvas) throw new Error("createDisplay needs a canvas.");
  if (!MODES.has(mode)) throw new Error(`Unknown display mode "${mode}".`);
  if (!SCALE_MODES.has(scaleMode)) throw new Error(`Unknown display scale mode "${scaleMode}".`);

  // Typed loosely on purpose. getContext returns a union across every context
  // kind, and this module is generic over which one you asked for -- the
  // transform code below guards with `if (context.setTransform)` rather than
  // assuming 2d. Narrowing to CanvasRenderingContext2D here would be a claim
  // the module does not actually make.
  /** @type {any} */
  const context = canvas.getContext(contextType, contextAttributes);
  if (!context) throw new Error(`This browser did not provide a "${contextType}" canvas context.`);

  const listeners = new Set();
  let viewport = {
    scale: 1, offsetX: 0, offsetY: 0,
    cssWidth: 0, cssHeight: 0,
    dpr: 1, width: designWidth, height: designHeight,
  };
  let observer = null;

  function measure() {
    const rect = canvas.getBoundingClientRect();
    // A hidden canvas measures zero; keeping the previous viewport avoids a
    // divide-by-zero in toWorld and a pointless full clear.
    const cssWidth = rect.width || viewport.cssWidth || designWidth;
    const cssHeight = rect.height || viewport.cssHeight || designHeight;
    const dpr = Math.min(globalThis.devicePixelRatio || 1, dprCap);
    return { cssWidth, cssHeight, dpr };
  }

  function resize() {
    const { cssWidth, cssHeight, dpr } = measure();
    const nextWidth = Math.round(cssWidth * dpr);
    const nextHeight = Math.round(cssHeight * dpr);
    // Assigning width/height clears the canvas even when the value is
    // unchanged, so guard it — a ResizeObserver fires more often than the size
    // actually changes.
    if (canvas.width !== nextWidth) canvas.width = nextWidth;
    if (canvas.height !== nextHeight) canvas.height = nextHeight;

    let scale = 1;
    let offsetX = 0;
    let offsetY = 0;
    let width = cssWidth;
    let height = cssHeight;

    if (mode === "letterbox") {
      scale = Math.min(cssWidth / designWidth, cssHeight / designHeight);
      if (scaleMode === "integer" && scale * dpr >= 1) {
        scale = Math.floor(scale * dpr) / dpr;
      }
      offsetX = (cssWidth - designWidth * scale) / 2;
      offsetY = (cssHeight - designHeight * scale) / 2;
      width = designWidth;
      height = designHeight;
    } else if (mode === "stretch") {
      width = designWidth;
      height = designHeight;
      offsetX = 0;
      offsetY = 0;
      scale = 1;
    }

    if (context.setTransform) {
      if (mode === "stretch") {
        context.setTransform(
          (cssWidth / designWidth) * dpr, 0,
          0, (cssHeight / designHeight) * dpr,
          0, 0,
        );
      } else {
        context.setTransform(scale * dpr, 0, 0, scale * dpr, offsetX * dpr, offsetY * dpr);
      }
    }

    viewport = Object.freeze({ scale, offsetX, offsetY, cssWidth, cssHeight, dpr, width, height });
    for (const listener of listeners) listener(viewport);
    return viewport;
  }

  if (autoResize && typeof ResizeObserver === "function") {
    observer = new ResizeObserver(() => resize());
    observer.observe(canvas);
  }
  resize();

  return {
    canvas,
    context,
    get viewport() { return viewport; },
    /** World-space dimensions — what you draw against. */
    get width() { return viewport.width; },
    get height() { return viewport.height; },

    resize,

    /** Client coordinates (from a pointer event) to world coordinates. */
    toWorld(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      if (mode === "stretch") {
        return {
          x: ((clientX - rect.left) / (rect.width || 1)) * designWidth,
          y: ((clientY - rect.top) / (rect.height || 1)) * designHeight,
        };
      }
      const scale = viewport.scale || 1;
      return {
        x: (clientX - rect.left - viewport.offsetX) / scale,
        y: (clientY - rect.top - viewport.offsetY) / scale,
      };
    },

    /** World coordinates back to client coordinates — for DOM overlays. */
    toClient(worldX, worldY) {
      const rect = canvas.getBoundingClientRect();
      if (mode === "stretch") {
        return {
          x: rect.left + (worldX / designWidth) * (rect.width || 1),
          y: rect.top + (worldY / designHeight) * (rect.height || 1),
        };
      }
      return {
        x: rect.left + viewport.offsetX + worldX * viewport.scale,
        y: rect.top + viewport.offsetY + worldY * viewport.scale,
      };
    },

    /** Clear the full backing store, ignoring the world transform. Letterbox
     *  bars live outside world space and would otherwise keep stale pixels. */
    clear(fillStyle) {
      context.save();
      context.setTransform(1, 0, 0, 1, 0, 0);
      if (fillStyle) {
        context.fillStyle = fillStyle;
        context.fillRect(0, 0, canvas.width, canvas.height);
      } else {
        context.clearRect(0, 0, canvas.width, canvas.height);
      }
      context.restore();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    destroy() {
      observer?.disconnect();
      observer = null;
      listeners.clear();
    },
  };
}
