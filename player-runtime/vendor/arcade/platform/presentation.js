// Full screen and windowed presentation.
//
// The DOM Fullscreen API is the browser half. On the desktop wrappers it is the
// wrong tool — Electron and Electrobun can put the *window* into full screen,
// which keeps the OS chrome behaving correctly and survives a reload. When a
// native bridge is present it wins; otherwise this falls back to the DOM API,
// which is what both games do today.
//
// Windowed bounds are remembered through a settings store when one is supplied,
// which is the piece neither game has: leaving full screen currently forgets
// whatever size the player had chosen.

/**
 * The contract a desktop wrapper exposes on `globalThis` (see
 * `desktop/electron-preload.cjs` for the reference implementation).
 *
 * @typedef {object} DesktopBridge
 * @property {() => boolean} isFullscreen
 * @property {(value: boolean) => void | Promise<void>} setFullscreen
 * @property {(listener: (value: boolean) => void) => () => void} onChange
 * @property {() => {width: number, height: number}} [getBounds]
 * @property {(bounds: {width: number, height: number}) => void} [setBounds]
 */

/**
 * @param {object} [options]
 * @param {HTMLElement} [options.element] What goes fullscreen.
 * @param {Document} [options.document]
 * @param {DesktopBridge} [options.bridge] Preferred over the DOM Fullscreen
 *        API when present, so a desktop wrapper puts the real window
 *        fullscreen rather than an element inside it.
 * @param {{field?: Function, set?: Function, get?: Function}} [options.settings] Where the
 *        windowed size is remembered between runs. Needs the field named by
 *        `boundsField` to exist, or remembering is skipped.
 * @param {string} [options.boundsField]
 */
export function createPresentation({
  element = globalThis.document?.documentElement,
  document: documentRef = globalThis.document,
  bridge = globalThis.arcadeDesktop,
  settings,
  boundsField = "windowBounds",
} = {}) {
  const listeners = new Set();
  const cleanups = [];
  let fullscreen = false;

  const native = Boolean(bridge && typeof bridge.setFullscreen === "function");
  const domSupported = Boolean(
    documentRef &&
    (documentRef.fullscreenEnabled ?? true) &&
    element?.requestFullscreen,
  );

  function read() {
    return native ? Boolean(bridge.isFullscreen()) : Boolean(documentRef?.fullscreenElement);
  }

  function publish() {
    const next = read();
    if (next === fullscreen) return;
    fullscreen = next;
    for (const listener of listeners) listener(fullscreen);
  }

  if (native && typeof bridge.onChange === "function") {
    const off = bridge.onChange(() => publish());
    if (typeof off === "function") cleanups.push(off);
  } else if (documentRef?.addEventListener) {
    const handler = () => publish();
    documentRef.addEventListener("fullscreenchange", handler);
    cleanups.push(() => documentRef.removeEventListener("fullscreenchange", handler));
  }
  fullscreen = read();

  /** Remember the windowed size so returning from full screen restores it. */
  function rememberBounds() {
    if (!settings || !settings.field?.(boundsField)) return;
    const bounds = native && bridge.getBounds
      ? bridge.getBounds()
      : { width: globalThis.innerWidth, height: globalThis.innerHeight };
    if (!bounds?.width || !bounds?.height) return;
    settings.set(boundsField, `${Math.round(bounds.width)}x${Math.round(bounds.height)}`);
  }

  function restoreBounds() {
    if (!settings || !native || !bridge.setBounds) return;
    const stored = settings.get(boundsField);
    const match = /^(\d{2,5})x(\d{2,5})$/.exec(String(stored ?? ""));
    if (!match) return;
    bridge.setBounds({ width: Number(match[1]), height: Number(match[2]) });
  }

  async function enter() {
    if (fullscreen) return true;
    rememberBounds();
    try {
      if (native) await bridge.setFullscreen(true);
      else if (domSupported) await element.requestFullscreen();
      else return false;
    } catch {
      return false;
    }
    publish();
    return true;
  }

  async function exit() {
    if (!fullscreen) return true;
    try {
      if (native) await bridge.setFullscreen(false);
      else if (documentRef?.exitFullscreen) await documentRef.exitFullscreen();
      else return false;
    } catch {
      return false;
    }
    publish();
    restoreBounds();
    return true;
  }

  return {
    get isFullscreen() { return fullscreen; },
    get supported() { return native || domSupported; },
    /** "native" when a desktop wrapper is driving the real window. */
    get kind() { return native ? "native" : domSupported ? "dom" : "none"; },

    enter,
    exit,
    toggle() { return fullscreen ? exit() : enter(); },

    subscribe(listener) {
      listeners.add(listener);
      listener(fullscreen);
      return () => listeners.delete(listener);
    },

    /**
     * Wire a button: click to toggle, and keep its label, `aria-pressed` and
     * title in sync. Both games hand-roll this today and word it differently.
     */
    bindButton(button, { enterLabel = "Full screen", exitLabel = "Exit full screen" } = {}) {
      if (!button) return () => {};
      const onClick = () => { void this.toggle(); };
      button.addEventListener("click", onClick);
      const off = this.subscribe((active) => {
        button.setAttribute("aria-pressed", String(active));
        button.textContent = active ? exitLabel : enterLabel;
      });
      if (!this.supported) button.hidden = true;
      return () => {
        button.removeEventListener("click", onClick);
        off();
      };
    },

    destroy() {
      for (const cleanup of cleanups) cleanup();
      cleanups.length = 0;
      listeners.clear();
    },
  };
}
