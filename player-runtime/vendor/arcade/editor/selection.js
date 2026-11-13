// What is selected, and which one of them is "the" one.
//
// Both construction sets arrived at the same pair independently -- Pinball's
// `state.selectedIds` / `state.selectedId` with `setSelection(ids, primaryId)`,
// and Starline's `selectedIds` / `selectedId` with `setSelection(ids, primary)`
// -- down to the same argument order and the same rule that the primary
// defaults to the last id given. That is a strong hint the shape is right and a
// stronger one that there should be one of it.
//
// The primary is not decoration: it is the item an Inspector shows fields for
// when several are selected, and the anchor a group operation measures from.

/**
 * @param {object} [options]
 * @param {(state: {ids: string[], primary: string|null}) => void} [options.onChange]
 *        Convenience for the single listener most callers want; equivalent to
 *        subscribing immediately.
 */
export function createSelection({ onChange } = {}) {
  const listeners = new Set();
  if (onChange) listeners.add(onChange);

  let ids = Object.freeze([]);
  let primary = null;

  function publish() {
    const snapshot = Object.freeze({ ids, primary });
    for (const listener of [...listeners]) listener(snapshot);
  }

  /**
   * The one rule worth stating: the primary must be a member. Passing a primary
   * that is not in `ids` is how a stale Inspector ends up bound to an item that
   * is no longer selected, so it falls back to the last id instead.
   */
  function commit(nextIds, requestedPrimary) {
    const unique = Object.freeze([...new Set(nextIds)]);
    const fallback = unique.at(-1) ?? null;
    const nextPrimary = requestedPrimary === undefined
      ? fallback
      : (requestedPrimary !== null && unique.includes(requestedPrimary) ? requestedPrimary : fallback);
    if (nextPrimary === primary && unique.length === ids.length &&
        unique.every((id, index) => id === ids[index])) {
      return false;
    }
    ids = unique;
    primary = nextPrimary;
    publish();
    return true;
  }

  return {
    get ids() { return ids; },
    get primary() { return primary; },
    get size() { return ids.length; },
    get isEmpty() { return ids.length === 0; },

    has(id) { return ids.includes(id); },

    /** Replace outright. Omit `primary` to take the last id given. */
    set(nextIds, primaryId) { return commit(nextIds ?? [], primaryId); },

    /** Union, for a shift-click that extends rather than replaces. */
    add(moreIds, primaryId) {
      const incoming = Array.isArray(moreIds) ? moreIds : [moreIds];
      return commit([...ids, ...incoming], primaryId === undefined ? incoming.at(-1) : primaryId);
    },

    remove(goneIds) {
      const gone = new Set(Array.isArray(goneIds) ? goneIds : [goneIds]);
      return commit(ids.filter((id) => !gone.has(id)), primary && gone.has(primary) ? undefined : primary);
    },

    /** In or out, for a ctrl-click. */
    toggle(id) {
      return ids.includes(id) ? this.remove(id) : this.add(id);
    },

    clear() { return commit([], null); },

    /**
     * Drop whatever no longer exists. Every editor needs this after an undo or
     * a delete, and both games hand-wrote the same filter at every such site.
     * @param {(id: string) => boolean} stillExists
     */
    retain(stillExists) {
      const kept = ids.filter((id) => stillExists(id));
      if (kept.length === ids.length) return false;
      return commit(kept, primary && kept.includes(primary) ? primary : undefined);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
