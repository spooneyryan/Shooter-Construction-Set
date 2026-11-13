// The four things every editor does to whatever is selected.
//
// A deliberately small surface, and the smallness is the point. What the two
// construction sets genuinely share is not "nudge" or "rotate" -- those are
// geometry, and a pinball flipper and a Starline formation do not share any --
// but the plumbing around them: read the items, apply something to the selected
// ones, write the whole collection back, keep the selection pointing at
// something that still exists, and hand the write a coalesce key so a gesture
// lands as one undo step instead of forty.
//
// So `update` takes the transform rather than defining it. `nudge` and `rotate`
// stay in the games, four lines each, written in their own units -- which is
// the right side of the line. What was worth taking is that both games had
// written the surrounding five lines a dozen times each, slightly differently:
// one cleared the selection after a delete and the other did not, one selected
// the copies after a duplicate and the other selected the last of them.

/**
 * @param {object} options
 * @param {() => any[]} options.items      Reads the current collection.
 * @param {(next: any[], context: {coalesceKey: string, reason: string}) => void} options.replace
 *        Writes it back. The game decides whether that also commits history --
 *        it is the game's document, and only it knows what else must follow.
 * @param {ReturnType<typeof import("./selection.js").createSelection>} options.selection
 * @param {(item: any) => string} options.identify
 * @param {(item: any) => any} [options.clone] Required only for `duplicate`.
 *        Must return an item carrying a NEW id; the module cannot invent one
 *        because it does not know what a valid id looks like here.
 */
export function createEditorCommands({ items, replace, selection, identify, clone }) {
  for (const [name, value] of Object.entries({ items, replace, selection, identify })) {
    if (!value) throw new Error(`createEditorCommands needs ${name}.`);
  }

  const selectedSet = () => new Set(selection.ids);

  return {
    /** The selected items themselves, in collection order, not selection order. */
    selectedItems() {
      const chosen = selectedSet();
      return items().filter((item) => chosen.has(identify(item)));
    },

    /** The primary item, which is what an Inspector binds its fields to. */
    primaryItem() {
      const id = selection.primary;
      return id ? items().find((item) => identify(item) === id) ?? null : null;
    },

    /**
     * Apply `transform` to every selected item and write the collection back.
     * Returning the item unchanged is fine; returning a new object is expected.
     *
     * @param {(item: any, index: number) => any} transform
     * @param {object} [options]
     * @param {string} [options.coalesceKey] Same key inside the history's
     *        coalescing window folds into one undo step. Default keys off the
     *        selection, so nudging A then nudging B are two steps, and nudging
     *        A four times is one.
     * @param {string} [options.reason] Names the write for the game's `replace`
     *        and seeds the default coalesce key. "update" unless said otherwise.
     * @returns {boolean} false when nothing was selected.
     */
    update(transform, { coalesceKey, reason = "update" } = {}) {
      const chosen = selectedSet();
      if (!chosen.size) return false;
      let index = -1;
      const next = items().map((item) => {
        if (!chosen.has(identify(item))) return item;
        index += 1;
        return transform(item, index);
      });
      replace(next, { coalesceKey: coalesceKey ?? `${reason}:${selection.ids.join(",")}`, reason });
      return true;
    },

    /**
     * Remove the selected items and clear the selection -- clearing it is not
     * optional, because leaving ids pointing at deleted items is how the
     * Inspector ends up editing a ghost.
     * @returns {number} how many were removed.
     */
    remove({ coalesceKey = "" } = {}) {
      const chosen = selectedSet();
      if (!chosen.size) return 0;
      const next = items().filter((item) => !chosen.has(identify(item)));
      const removed = items().length - next.length;
      if (!removed) return 0;
      replace(next, { coalesceKey, reason: "remove" });
      selection.clear();
      return removed;
    },

    /**
     * Copy the selected items, append them, and select the copies -- so the
     * next drag moves the new ones, which is what "duplicate" is for.
     *
     * @param {object} [options]
     * @param {(copy: any) => any} [options.offset] Moves each copy clear of its
     *        original. Game geometry, so the game supplies it; without one the
     *        copies land exactly on top.
     * @param {string} [options.coalesceKey] As for `update`; empty by default,
     *        so each duplicate is an undo step of its own.
     * @returns {any[]} the copies, empty when nothing was selected.
     */
    duplicate({ offset, coalesceKey = "" } = {}) {
      if (!clone) throw new Error("duplicate needs a clone function.");
      const chosen = selectedSet();
      if (!chosen.size) return [];
      const copies = items()
        .filter((item) => chosen.has(identify(item)))
        .map((item) => {
          const copy = clone(item);
          return offset ? offset(copy) : copy;
        });
      if (!copies.length) return [];
      replace([...items(), ...copies], { coalesceKey, reason: "duplicate" });
      selection.set(copies.map(identify));
      return copies;
    },

    /**
     * Append new items and select them, which is what placing from a palette
     * does. Separate from `duplicate` because the items come from elsewhere.
     */
    add(newItems, { select = true, coalesceKey = "" } = {}) {
      const incoming = Array.isArray(newItems) ? newItems : [newItems];
      if (!incoming.length) return [];
      replace([...items(), ...incoming], { coalesceKey, reason: "add" });
      if (select) selection.set(incoming.map(identify));
      return incoming;
    },

    /**
     * Drop selected ids that no longer name an item. Call after an undo, or
     * after anything that replaced the collection from outside these commands.
     */
    pruneSelection() {
      const present = new Set(items().map(identify));
      return selection.retain((id) => present.has(id));
    },
  };
}
