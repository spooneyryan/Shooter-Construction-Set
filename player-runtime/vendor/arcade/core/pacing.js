// Frame pacing: the difference between fast and smooth.
//
// perf.js answers a different question — "is this machine keeping up?" — with
// frame rates averaged over one-second windows, feeding the automatic quality
// decision. Averages cannot see a hiccup. A game can hold a flawless 120 FPS
// average while one frame in four hundred arrives 25 ms late, and that one
// frame is the whole complaint: the game feels 99% smooth and stutters "here
// and there". This module measures exactly that — every frame's delta, the
// distribution's tail, and a log of the frames that broke cadence.
//
// Each logged hiccup carries a cause when the caller supplies its own work
// time: a long frame the game spent computing is the game's problem
// ("work" — a heavy draw, a garbage collection triggered by allocation), and
// a long frame the game spent idle is imposed from outside ("external" — the
// compositor, another tab, the OS). The two have different fixes, and a
// histogram that cannot tell them apart sends people optimizing draw calls
// when the time went to a GC pause, or vice versa.
//
// Deliberately not here: any reaction. This is a diagnostic instrument, not a
// controller — perf.js owns the quality decision, and a pacing readout that
// also changed behaviour would corrupt its own measurement.

// Not named DEFAULTS: perf.js already declares that at top level, and Pinball
// links this package by concatenating modules into one flat scope, where the
// second declaration is a SyntaxError. The test that would catch it is
// tests/flat-scope.test.mjs, and DEFAULTS-in-perf is the collision it was
// built from.
const PACING_DEFAULTS = {
  maxSamples: 720, // six seconds at 120 Hz, twelve at 60
  hiccupRatio: 1.5, // a delta this many times the median is a broken cadence
  maxHiccups: 32,
  warmUpMs: 1000, // first-frame costs are startup, not pacing
  resetAfterMs: 1000, // a gap this long is a stall or a hidden tab, not a frame
  workShare: 0.5, // a hiccup is "work" when the caller's own time covers this share of it
};

function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

export function createPacingMonitor(options = {}) {
  const config = { ...PACING_DEFAULTS, ...options };

  const samples = new Float64Array(config.maxSamples);
  let count = 0; // valid entries in `samples`
  let cursor = 0; // next write position
  const hiccups = [];

  let last = null;
  let warmUpStart = null;
  let cachedMedian = 0;
  let sinceMedian = 0;
  let totalFrames = 0;
  let totalHiccups = 0;
  let recordedMs = 0;

  function sortedCopy() {
    return Array.from(samples.subarray(0, count)).sort((a, b) => a - b);
  }

  function refreshMedian() {
    const sorted = sortedCopy();
    const middle = Math.floor(sorted.length / 2);
    cachedMedian = sorted.length
      ? (sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2)
      : 0;
    sinceMedian = 0;
  }

  return {
    /**
     * Call once per animation frame with the scheduler timestamp — the same
     * value `createLoop` exposes as `context.timestamp`. `workMs`, when
     * given, is how long the game's own update-and-render took on the
     * PREVIOUS frame; it is what lets a hiccup name its cause.
     */
    frame(timestamp, workMs) {
      if (last === null) {
        last = timestamp;
        if (warmUpStart === null) warmUpStart = timestamp;
        return;
      }
      const delta = timestamp - last;
      last = timestamp;
      if (delta <= 0) return; // mixed clocks; not a frame
      if (delta >= config.resetAfterMs) {
        // The loop was not running — describe the game, not the stall, and
        // treat the frames that follow a restore as a fresh warm-up.
        warmUpStart = timestamp;
        return;
      }
      if (timestamp - warmUpStart < config.warmUpMs) return;

      samples[cursor] = delta;
      cursor = (cursor + 1) % samples.length;
      if (count < samples.length) count += 1;
      totalFrames += 1;
      recordedMs += delta;

      sinceMedian += 1;
      if (cachedMedian === 0 || sinceMedian >= 30) refreshMedian();

      if (cachedMedian > 0 && delta > cachedMedian * config.hiccupRatio) {
        totalHiccups += 1;
        const work = typeof workMs === "number" && workMs >= 0 ? workMs : null;
        hiccups.push(Object.freeze({
          at: timestamp,
          ms: delta,
          /** How many ordinary frames this one cost. */
          frames: delta / cachedMedian,
          workMs: work,
          cause: work === null ? "unknown" : (work >= delta * config.workShare ? "work" : "external"),
        }));
        if (hiccups.length > config.maxHiccups) hiccups.shift();
      }
    },

    /** The distribution. Sorted fresh per call — poll it, do not spin on it. */
    get stats() {
      const sorted = sortedCopy();
      const middle = Math.floor(sorted.length / 2);
      const medianMs = sorted.length
        ? (sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2)
        : null;
      return Object.freeze({
        sampleCount: count,
        totalFrames,
        medianMs,
        p95Ms: percentile(sorted, 0.95),
        p99Ms: percentile(sorted, 0.99),
        worstMs: sorted.length ? sorted[sorted.length - 1] : null,
        /** What the display seems to be running at, judged by the median. */
        hz: medianMs ? 1000 / medianMs : null,
        hiccupCount: totalHiccups,
        hiccupsPerMinute: recordedMs > 0 ? (totalHiccups * 60000) / recordedMs : 0,
      });
    },

    /** The recent broken-cadence frames, oldest first. */
    hiccups() {
      return hiccups.slice();
    },

    /** Forget everything, including the warm-up. */
    clear() {
      count = 0;
      cursor = 0;
      hiccups.length = 0;
      last = null;
      warmUpStart = null;
      cachedMedian = 0;
      sinceMedian = 0;
      totalFrames = 0;
      totalHiccups = 0;
      recordedMs = 0;
    },
  };
}
