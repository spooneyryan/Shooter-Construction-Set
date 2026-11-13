// Frame-rate sampling and automatic quality reduction.
//
// Lifted from Pinball Construction Set, which is the only one of the three
// games that measures honestly. The reasoning behind each constant is
// preserved because it is not obvious:
//
//  - A display cannot report more frames than it can show, so judging the frame
//    rate against a fixed number either never trips on a fast panel or never
//    clears on an ordinary 60 Hz one, where 60 FPS is already perfect. The
//    threshold is a ratio of the best rate this display has actually reached.
//  - Degrading and restoring use different ratios, so routine jitter around the
//    limit cannot flip effects on and off every second.
//  - The opening seconds are dominated by first-frame costs (module startup,
//    font and shader warm-up, the first full render), so any window that began
//    inside the warm-up is reported live but kept out of the statistics and out
//    of the quality decision.

const DEFAULTS = {
  windowMs: 1000,
  staleWindowMs: 2500,
  warmUpMs: 2000,
  maxSamples: 120,
  minBaseline: 24,
  degradeRatio: 0.72,
  restoreRatio: 0.85,
  degradeSamples: 2,
  restoreSamples: 3,
};

function median(sorted) {
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function createPerformanceMonitor(options = {}) {
  const config = { ...DEFAULTS, ...options };
  const isHidden = options.isHidden
    ?? (() => globalThis.document?.visibilityState === "hidden");

  const listeners = new Set();
  const qualityListeners = new Set();

  let samples = [];
  let windowStart = null;
  let warmUpStart = null;
  let frameCount = 0;
  let current = null;
  let degraded = false;
  let degradeStreak = 0;
  let restoreStreak = 0;

  /** The best rate across retained samples stands in for the refresh rate. The
   *  rolling window also lets the baseline fall again if the machine or the
   *  window genuinely gets slower. */
  function baseline() {
    let best = 0;
    for (const sample of samples) if (sample > best) best = sample;
    return best;
  }

  function stats() {
    const sorted = [...samples].sort((left, right) => left - right);
    return Object.freeze({
      current,
      min: sorted.length ? sorted[0] : null,
      median: median(sorted),
      baseline: baseline(),
      sampleCount: sorted.length,
      degraded,
      warmingUp: warmUpStart !== null && samples.length === 0,
    });
  }

  function setDegraded(next, threshold) {
    if (degraded === next) return;
    degraded = next;
    degradeStreak = 0;
    restoreStreak = 0;
    const payload = Object.freeze({ degraded, threshold, stats: stats() });
    for (const listener of qualityListeners) listener(payload);
  }

  function updateQuality(fps) {
    const best = baseline();
    // Below this there is no trustworthy baseline to compare against — the
    // display has never been observed running well.
    if (best < config.minBaseline) return;
    const degradeBelow = best * config.degradeRatio;
    const restoreAbove = best * config.restoreRatio;

    if (!degraded) {
      degradeStreak = fps < degradeBelow ? degradeStreak + 1 : 0;
      if (degradeStreak >= config.degradeSamples) setDegraded(true, degradeBelow);
      return;
    }
    restoreStreak = fps > restoreAbove ? restoreStreak + 1 : 0;
    if (restoreStreak >= config.restoreSamples) setDegraded(false, restoreAbove);
  }

  /** Discard the window in progress and restart the warm-up, so the samples
   *  that follow describe steady play rather than a page still starting, a tab
   *  just restored, or a stall that has already passed. */
  function resetWindow() {
    windowStart = null;
    frameCount = 0;
    warmUpStart = null;
  }

  return {
    /** Call once per animation frame with the rAF timestamp. */
    frame(timestamp) {
      if (isHidden()) {
        resetWindow();
        return;
      }
      if (windowStart === null) {
        windowStart = timestamp;
        if (warmUpStart === null) warmUpStart = timestamp;
        return;
      }

      const span = timestamp - windowStart;
      // A window this long means the loop was not running — a backgrounded tab
      // or a blocked main thread. It describes the stall, not the game.
      if (span > config.staleWindowMs || span < 0) {
        resetWindow();
        return;
      }
      frameCount += 1;
      if (span < config.windowMs) return;

      const fps = (frameCount * 1000) / span;
      const startedAt = windowStart;
      windowStart = timestamp;
      frameCount = 0;
      current = fps;

      if (startedAt - warmUpStart < config.warmUpMs) {
        // Shown live, excluded from min, median and the quality decision.
        for (const listener of listeners) listener(stats());
        return;
      }

      samples.push(fps);
      if (samples.length > config.maxSamples) samples.shift();
      updateQuality(fps);
      for (const listener of listeners) listener(stats());
    },

    get stats() { return stats(); },
    get degraded() { return degraded; },

    /** Fires once per closed sampling window. */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Fires only when the quality verdict flips. */
    onQualityChange(listener) {
      qualityListeners.add(listener);
      return () => qualityListeners.delete(listener);
    },

    /** Start a completely fresh measurement — the retained history used to
     *  survive hiding and showing the counter, so one old outlier kept dragging
     *  the minimum down long after the conditions that produced it were gone. */
    clear() {
      samples = [];
      current = null;
      restoreStreak = 0;
      degradeStreak = 0;
      resetWindow();
      for (const listener of listeners) listener(stats());
    },

    resetWindow,

    /** Wire this to `visibilitychange`. */
    attach(target = globalThis.document) {
      const handler = () => resetWindow();
      target?.addEventListener?.("visibilitychange", handler);
      return () => target?.removeEventListener?.("visibilitychange", handler);
    },

    /** A flat object suitable for a telemetry payload. */
    summary() {
      const snapshot = stats();
      return {
        fpsCurrent: snapshot.current === null ? null : Math.round(snapshot.current),
        fpsMin: snapshot.min === null ? null : Math.round(snapshot.min),
        fpsMedian: snapshot.median === null ? null : Math.round(snapshot.median),
        fpsBaseline: Math.round(snapshot.baseline),
        samples: snapshot.sampleCount,
        degraded: snapshot.degraded,
      };
    },
  };
}
