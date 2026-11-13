// The shortcut table as data.
//
// Both construction sets ended up with almost the same map -- Ctrl+S to save,
// Ctrl+Z and Ctrl+Y for history, Delete to delete, D to duplicate, Escape to
// clear, Q and E to rotate, arrows to nudge with Shift for the coarse step, F
// for full screen -- and both wrote it as one long if-chain of hand-repeated
// modifier checks. Two chains, arrived at separately, that agree by luck and
// drift silently. This makes the map a value, so the two can be compared.
//
// Three rules were rediscovered in both chains and are built in here:
//
//   1. Ctrl means Ctrl OR Cmd. Every binding in both games wrote
//      `event.ctrlKey || event.metaKey`; not one meant Ctrl alone.
//   2. A bare letter must NOT fire while Ctrl or Cmd is held, or Ctrl+D
//      duplicates on its way to the browser's bookmark dialog. Both games
//      wrote `!event.ctrlKey && !event.metaKey` on nearly every bare letter,
//      and both missed it somewhere.
//   3. Nothing fires while the user is typing -- except the save shortcut,
//      which both games deliberately allow through, because losing an edit
//      because focus was still in the name field is worse than the alternative.

const TEXT_ENTRY = new Set(["INPUT", "SELECT", "TEXTAREA"]);

/** Is this event aimed at something the user is typing into? */
export function isTextEntry(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  return TEXT_ENTRY.has(String(target.tagName ?? "").toUpperCase());
}

function modifiersMatch(binding, event) {
  // `ctrl` covers the Command key: see rule 1.
  const control = Boolean(event.ctrlKey || event.metaKey);
  if (Boolean(binding.ctrl) !== control) return false;
  if (Boolean(binding.shift) !== Boolean(event.shiftKey)) return false;
  // Alt is only ever checked when a binding asks about it. Some layouts
  // produce it as part of ordinary typing, so demanding its absence
  // everywhere would break those keyboards for no gain.
  if (binding.alt !== undefined && Boolean(binding.alt) !== Boolean(event.altKey)) return false;
  return true;
}

/**
 * @typedef {object} Binding
 * @property {string|string[]} code  KeyboardEvent.code, e.g. "KeyD", "Escape",
 *   "ArrowLeft". `code` rather than `key` on purpose: it is layout-independent
 *   and unaffected by Shift, so one binding covers "d" and "D".
 * @property {boolean} [ctrl]   Ctrl or Cmd. Absent means "must not be held".
 * @property {boolean} [shift]  Absent means "must not be held".
 * @property {boolean} [alt]    Absent means "do not care".
 * @property {() => boolean} [when]  Gate on game state -- build mode, a modal
 *   being open. Checked before `run`, and a false gate does not consume.
 * @property {boolean} [allowInTextEntry] Fire even while typing. For save.
 * @property {boolean} [allowRepeat] Fire on auto-repeat. Off by default:
 *   holding D should duplicate once, holding an arrow should nudge many times.
 * @property {boolean} [passive] Do not preventDefault when this one fires.
 * @property {string} [label] The chord as a help sheet prints it, "Ctrl+S".
 * @property {string} [description] What it does, for the sheet. A binding
 *   with no label or no description is not listed -- the unlabelled half of
 *   a chord that has a Shift variant, say.
 * @property {string} [group] The sheet's heading it sits under; see
 *   `SHELL_KEY_GROUPS` in shell.js.
 * @property {(event: any) => void} run
 */

/**
 * @param {Binding[]} bindings Order matters: the first match wins, so put the
 *   specific ones first. A Ctrl+S binding and a bare-S binding do not collide,
 *   because the modifier check is exact.
 * @param {object} [options]
 * @param {(target: any) => boolean} [options.isTextEntry] Override how a
 *   typing target is recognised, for a host with its own editable widgets.
 */
export function createKeymap(bindings, { isTextEntry: typing = isTextEntry } = {}) {
  const table = bindings.map((binding) => ({
    ...binding,
    codes: new Set(Array.isArray(binding.code) ? binding.code : [binding.code]),
  }));

  return {
    get size() { return table.length; },

    /**
     * @param {KeyboardEvent} event
     * @returns {boolean} true if a binding ran, so a caller can tell whether
     *   the key was theirs. Movement and fire keys usually belong to the input
     *   layer instead, and it must not treat "no shortcut matched" as an error.
     */
    handle(event) {
      const editing = typing(event.target);
      for (const binding of table) {
        if (!binding.codes.has(event.code)) continue;
        if (editing && !binding.allowInTextEntry) continue;
        if (event.repeat && !binding.allowRepeat) continue;
        if (!modifiersMatch(binding, event)) continue;
        if (binding.when && !binding.when()) continue;
        if (!binding.passive && typeof event.preventDefault === "function") event.preventDefault();
        binding.run(event);
        return true;
      }
      return false;
    },

    /**
     * Every binding, for rendering a help panel or a shortcut bar from the same
     * source the handler reads -- which is the other half of making the map a
     * value. Both games maintain a printed shortcut list by hand today, and
     * both have drifted from the code at least once.
     */
    describe() {
      return table.map(({ code, ctrl, shift, alt, label, description, group }) => ({
        code: Array.isArray(code) ? [...code] : [code],
        ctrl: Boolean(ctrl),
        shift: Boolean(shift),
        alt: Boolean(alt),
        label: label ?? null,
        description: description ?? null,
        group: group ?? null,
      }));
    },
  };
}
