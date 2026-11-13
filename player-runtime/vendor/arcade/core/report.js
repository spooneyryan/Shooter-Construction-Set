// How the library reports on itself.
//
// The layering only works in one direction: telemetry sits above core and
// platform and may import them, never the reverse. If core imported telemetry
// it would stop being zero-dependency and stop being testable without a DOM.
//
// So a module never reaches for a telemetry instance — it accepts an optional
// sink and calls it. The sink is anything with an `event(name, data)` method,
// which `createTelemetry` satisfies, or a plain function. Core depends on the
// shape, not the module, and passing nothing costs nothing.

const noop = () => {};

function normalize(sink) {
  if (!sink) return null;
  if (typeof sink === "function") return sink;
  if (typeof sink.event === "function") return (name, data) => sink.event(name, data);
  return null;
}

/**
 * @param {object|function|null|undefined} sink
 * @param {object} [options]
 * @param {number} [options.throttleMs] Coalesce repeats of the same event name.
 *        The first is reported immediately; later ones inside the window are
 *        counted and folded into the next report as `suppressed`.
 * @param {() => number} [options.now] Clock, swappable so a test can advance
 *        the throttle window without waiting for it.
 */
export function createReporter(sink, { throttleMs = 0, now = () => performance.now() } = {}) {
  const emit = normalize(sink);
  if (!emit) return noop;
  if (!throttleMs) return emit;

  const seen = new Map();
  return (name, data) => {
    const at = now();
    const entry = seen.get(name);
    if (!entry) {
      seen.set(name, { lastAt: at, suppressed: 0 });
      emit(name, data);
      return;
    }
    if (at - entry.lastAt < throttleMs) {
      // A frame-rate problem reports every frame by definition. Counting the
      // repeats is the useful signal; sending them all is a second problem.
      entry.suppressed += 1;
      return;
    }
    const { suppressed } = entry;
    entry.lastAt = at;
    entry.suppressed = 0;
    emit(name, suppressed ? { ...data, suppressed } : data);
  };
}
