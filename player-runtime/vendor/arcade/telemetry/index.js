// Opt-in telemetry.
//
// The measurement problem is already solved — Pinball's frame sampler is better
// than most commercial ones. What is missing is somewhere for it to go. This is
// the transport: a buffered event queue that flushes on a timer and, crucially,
// on `visibilitychange: hidden` via sendBeacon, because that is the only moment
// a closing tab is still allowed to send anything.
//
// Deliberately not collected: anything identifying. No URLs beyond a page tag
// the caller supplies, no user agent parsing, no IP-adjacent fields, no
// input. It is off unless a caller turns it on.

import { uniqueId } from "../core/validate.js";

// Named for this module: a flat-scope consumer -- Pinball concatenates this
// package to build its standalone player -- would otherwise collide with
// core/perf.js, which owns the bare name.
const TELEMETRY_DEFAULTS = {
  enabled: false,
  sampleRate: 1,
  maxBuffer: 100,
  flushIntervalMs: 30_000,
  captureErrors: true,
};

function defaultSend(endpoint, payload) {
  const body = JSON.stringify(payload);
  // sendBeacon is the only transport that survives page teardown. It caps at
  // ~64 KB and can refuse; falling back to a keepalive fetch covers the rest.
  if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    try {
      const blob = new Blob([body], { type: "application/json" });
      if (navigator.sendBeacon(endpoint, blob)) return Promise.resolve(true);
    } catch {
      // fall through
    }
  }
  if (typeof fetch !== "function") return Promise.resolve(false);
  return fetch(endpoint, {
    method: "POST",
    body,
    keepalive: true,
    headers: { "content-type": "application/json" },
  }).then((response) => response.ok).catch(() => false);
}

/**
 * @param {object} [options]
 * @param {string} [options.app] Required. Names the application in every
 *        payload; the throw below is what enforces it.
 * @param {string} [options.endpoint] Where payloads go. Without one nothing is
 *        sent, which is why telemetry defaults to harmless.
 * @param {string} [options.version]
 * @param {boolean} [options.enabled]
 * @param {number} [options.sampleRate]
 * @param {number} [options.maxBuffer]
 * @param {number} [options.flushIntervalMs] Zero disables the timer.
 * @param {boolean} [options.captureErrors]
 * @param {object} [options.perf] A PerformanceMonitor to attach immediately.
 * @param {(endpoint: string, payload: object) => Promise<boolean>} [options.send]
 *        Swappable so a test can assert on payloads without a network.
 * @param {Document} [options.document]
 * @param {typeof globalThis} [options.window]
 */
export function createTelemetry(options = {}) {
  const config = { ...TELEMETRY_DEFAULTS, ...options };
  const {
    endpoint,
    app,
    version = "0.0.0",
    perf,
    send = defaultSend,
    document: documentRef = globalThis.document,
    window: windowRef = globalThis,
  } = config;

  if (!app) throw new Error("Telemetry needs an app name.");

  const session = uniqueId("session");
  const startedAt = Date.now();
  const cleanups = [];
  // Held in a binding rather than closed over, so a monitor created after the
  // telemetry instance can still be attached. Construction order is an
  // accident of how a game is laid out; it should not decide what gets
  // measured.
  let monitor = perf ?? null;
  let buffer = [];
  let enabled = Boolean(config.enabled) && Boolean(endpoint);
  let timer = null;
  // Sampling is decided once per session, not per event, so a sampled-in
  // session produces a complete picture rather than a scatter of fragments.
  const sampledIn = Math.random() < config.sampleRate;

  function device() {
    return {
      dpr: globalThis.devicePixelRatio ?? 1,
      viewport: windowRef?.innerWidth
        ? `${windowRef.innerWidth}x${windowRef.innerHeight}`
        : null,
      // A coarse platform hint, not a fingerprint.
      // userAgentData is not in lib.dom yet, and is absent in Safari and
      // Firefox at runtime too -- hence the optional chaining and the cast.
      platform: /** @type {any} */ (globalThis.navigator)?.userAgentData?.platform ?? null,
      cores: globalThis.navigator?.hardwareConcurrency ?? null,
    };
  }

  function record(type, name, data) {
    if (!enabled || !sampledIn) return false;
    buffer.push({
      t: Math.round(performance.now()),
      type,
      name,
      ...(data === undefined ? {} : { data }),
    });
    // Drop the oldest rather than the newest: whatever happened just before a
    // crash matters more than the first frame of the session.
    if (buffer.length > config.maxBuffer) buffer = buffer.slice(-config.maxBuffer);
    return true;
  }

  function flush({ final = false } = {}) {
    if (!enabled || !sampledIn || buffer.length === 0) return Promise.resolve(false);
    const payload = {
      app,
      version,
      session,
      startedAt,
      sentAt: Date.now(),
      final,
      device: device(),
      ...(monitor ? { perf: monitor.summary() } : {}),
      events: buffer,
    };
    buffer = [];
    return Promise.resolve(send(endpoint, payload));
  }

  function listen(target, type, handler, opts) {
    target?.addEventListener?.(type, handler, opts);
    cleanups.push(() => target?.removeEventListener?.(type, handler, opts));
  }

  // Whether start() has already wired its listeners. Toggling collection off
  // and on again must not register a second set: the listeners survive being
  // disabled — record() simply returns early — so re-running start() would
  // double every captured error and every flush-on-hide.
  let listening = false;

  function start() {
    if (!enabled || !sampledIn || listening) return;
    listening = true;
    if (config.flushIntervalMs > 0 && timer === null) {
      // Typed loosely because the two runtimes disagree: the DOM's setInterval
      // returns a number, Node's returns a Timeout that carries unref. The
      // optional call is what makes it work in a browser.
      timer = /** @type {any} */ (setInterval(() => void flush(), config.flushIntervalMs));
      // Never hold the Node process open — relevant for SSR and tests.
      timer?.unref?.();
    }
    listen(documentRef, "visibilitychange", () => {
      if (documentRef.visibilityState === "hidden") void flush({ final: true });
    });
    // pagehide fires in cases visibilitychange does not (bfcache, iOS).
    listen(windowRef, "pagehide", () => void flush({ final: true }));

    if (config.captureErrors) {
      listen(windowRef, "error", (event) => {
        record("error", event.message ?? "error", {
          // Filename and line only — never the surrounding source or state.
          source: event.filename ?? null,
          line: event.lineno ?? null,
          column: event.colno ?? null,
        });
      });
      listen(windowRef, "unhandledrejection", (event) => {
        const reason = event.reason;
        record("error", "unhandledrejection", {
          message: reason instanceof Error ? reason.message : String(reason ?? "").slice(0, 200),
        });
      });
    }

    subscribeToMonitor();
  }

  let unsubscribeMonitor = null;
  function subscribeToMonitor() {
    unsubscribeMonitor?.();
    unsubscribeMonitor = null;
    if (!monitor || !enabled || !sampledIn) return;
    unsubscribeMonitor = monitor.onQualityChange(({ degraded, threshold }) => {
      record("quality", degraded ? "degraded" : "restored", {
        threshold: threshold === undefined ? null : Math.round(threshold),
        ...monitor.summary(),
      });
    });
    // Not pushed onto `cleanups`: this can be called repeatedly — every
    // attachPerformance, every enable — and the current unsubscribe is always
    // reachable through the binding, which destroy() reads directly.
  }

  start();

  return {
    get session() { return session; },
    get enabled() { return enabled && sampledIn; },
    /** Buffered but unsent — exposed for tests and a debug overlay. */
    get pending() { return buffer.length; },

    /**
     * Attach a frame-rate monitor after construction. Quality changes are
     * recorded from here on, and every payload carries its summary.
     */
    attachPerformance(next) {
      monitor = next ?? null;
      subscribeToMonitor();
      return this;
    },

    event(name, data) { return record("event", name, data); },
    error(name, data) { return record("error", name, data); },
    timing(name, milliseconds) { return record("timing", name, { ms: Math.round(milliseconds) }); },

    flush,

    /** Opt in at runtime, e.g. from a settings toggle. */
    setEnabled(value) {
      const next = Boolean(value) && Boolean(endpoint);
      if (next === enabled) return;
      enabled = next;
      if (enabled) {
        start();
        subscribeToMonitor();
      } else {
        buffer = [];
        if (timer !== null) { clearInterval(timer); timer = null; }
        unsubscribeMonitor?.();
        unsubscribeMonitor = null;
      }
    },

    destroy() {
      void flush({ final: true });
      if (timer !== null) clearInterval(timer);
      timer = null;
      unsubscribeMonitor?.();
      unsubscribeMonitor = null;
      for (const cleanup of cleanups) cleanup();
      cleanups.length = 0;
      listening = false;
    },
  };
}
