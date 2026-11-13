// Snapshot undo/redo with coalescing.
//
// From Starline, which is the only one of the three with a coalescing key —
// the reason a drag or a slider sweep collapses into one undo step instead of
// forty. Pinball keeps a parallel string array with the same shape and no
// coalescing; this replaces both.

// Named for this module rather than just DEFAULTS: Pinball Construction
// Set concatenates every runtime module of this package into one flat scope to
// build its standalone player, and core/perf.js already owns that name there.
const HISTORY_DEFAULTS = {
  limit: 80,
  coalesceMs: 700,
  serialize: JSON.stringify,
  deserialize: JSON.parse,
};

export function createHistory(options = {}) {
  const { limit, coalesceMs, serialize, deserialize } = { ...HISTORY_DEFAULTS, ...options };
  // Injected so tests are deterministic and so a replay can drive it.
  const now = options.now ?? (() => Date.now());

  const listeners = new Set();
  let snapshots = [];
  let index = -1;
  let coalesceKey = "";
  let coalescedAt = 0;

  function notify() {
    if (!listeners.size) return;
    const state = Object.freeze({
      canUndo: index > 0,
      canRedo: index >= 0 && index < snapshots.length - 1,
      depth: snapshots.length,
      index,
    });
    for (const listener of listeners) listener(state);
  }

  return {
    get canUndo() { return index > 0; },
    get canRedo() { return index >= 0 && index < snapshots.length - 1; },
    get depth() { return snapshots.length; },
    get index() { return index; },

    /** Discard everything and start from `state`. Use after a load or a new
     *  document — the previous document's history must not be reachable. */
    reset(state) {
      snapshots = [serialize(state)];
      index = 0;
      coalesceKey = "";
      coalescedAt = 0;
      notify();
    },

    /**
     * Record a new snapshot. Passing the same `key` again inside the coalesce
     * window overwrites the top entry instead of pushing a new one, so a
     * continuous gesture is a single undo step.
     */
    commit(state, key = "") {
      const snapshot = serialize(state);
      if (snapshots[index] === snapshot) {
        // Nothing actually changed. A no-op commit must not clear the redo
        // stack, or clicking around after an undo silently discards the redo.
        notify();
        return false;
      }
      const at = now();
      const coalescing = key && key === coalesceKey && at - coalescedAt < coalesceMs && index > 0;
      if (coalescing) {
        snapshots[index] = snapshot;
      } else {
        snapshots = snapshots.slice(0, index + 1);
        snapshots.push(snapshot);
        if (snapshots.length > limit) snapshots.shift();
        index = snapshots.length - 1;
      }
      coalesceKey = key;
      coalescedAt = at;
      notify();
      return true;
    },

    undo() {
      if (index <= 0) return undefined;
      index -= 1;
      coalesceKey = "";
      notify();
      return deserialize(snapshots[index]);
    },

    redo() {
      if (index < 0 || index >= snapshots.length - 1) return undefined;
      index += 1;
      coalesceKey = "";
      notify();
      return deserialize(snapshots[index]);
    },

    /** The state at the current position, without moving. */
    current() {
      return index >= 0 ? deserialize(snapshots[index]) : undefined;
    },

    /** Ends the current gesture so the next commit always pushes. */
    breakCoalescing() {
      coalesceKey = "";
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
