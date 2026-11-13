// Keyboard and gamepad behind one action map.
//
// Three behaviours that each exist in exactly one game today, and are bugs in
// the other two, are unconditional here:
//   - releasing every held key on blur (Pinball), so alt-tabbing mid-flip does
//     not leave a flipper stuck up;
//   - gamepad polling with a deadzone and edge detection (Starline);
//   - ignoring keys while a text field has focus (both, worded differently).
//
// Keyboard and pad holds are tracked separately and unioned, so letting go of
// the stick never cancels an action the keyboard is still holding.
//
// TWO READERS, AND WHY BOTH. `axis(negative, positive)` is one dimension: a
// flipper, a throttle, a paddle. `stick({left, right, up, down})` is a
// vector, and it is a different thing rather than a pair of the first --
// deadzoning two axes separately leaves a dead cross rather than a dead
// circle, a square gate reads 1.41 on the diagonal, and neither matters until
// the day a game aims. `axis` is unchanged and three shipped games keep
// reading it; `stick` is what a twin-stick game calls twice.
//
// The pointer is tracked here too, because Abuse is a control scheme --
// keyboard to move, mouse to aim -- and not a genre. Input maps client
// coordinates through `mapPointer` and nothing else: where the crosshair is
// relative to an actor is the game's arithmetic, in `core/stick`.

import { resolveStick, stickFromKeys, neutralStick } from "../core/stick.js";

const DEFAULT_DEADZONE = 0.18;

function defaultIsTextEntry(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable === true;
}

/**
/**
 * One action, as keys and/or a gamepad control.
 *
 * @typedef {object} ActionSpec
 * @property {string[]} [keys] KeyboardEvent.code values.
 * @property {{buttons?: number[], axis?: {index: number, dir?: 1|-1}}} [pad]
 *        Gamepad bindings. NESTED under `pad`, not alongside `keys` — button
 *        and axis bindings written at the top level are silently ignored.
 * @property {boolean} [preventDefault]
 */

/**
 * @param {object} [options]
 * @param {Record<string, ActionSpec>} [options.actions] Keyed by action name.
 * @param {EventTarget} [options.target] Where key listeners are attached.
 * @param {number} [options.deadzone] Below this, an axis reads as centred.
 * @param {boolean} [options.preventDefault]
 * @param {(target: EventTarget|null) => boolean} [options.isTextEntry] Decides
 *        when a keypress belongs to a text field rather than the game.
 * @param {() => ArrayLike<Gamepad|null>} [options.getGamepads]
 * @param {(clientX: number, clientY: number) => {x: number, y: number}}
 *        [options.mapPointer] Client coordinates into the space the game
 *        thinks in. Pass `display.toWorld` -- input cannot know the canvas,
 *        its letterboxing or its scale, and guessing would be wrong in
 *        exactly the games that letterbox. Defaults to the identity, which is
 *        client space, which is right for a canvas that fills its window and
 *        wrong the moment one does not.
 */
export function createInput({
  actions = {},
  target = globalThis,
  deadzone = DEFAULT_DEADZONE,
  preventDefault = true,
  isTextEntry = defaultIsTextEntry,
  getGamepads = () => (typeof navigator !== "undefined" && navigator.getGamepads ? navigator.getGamepads() : []),
  mapPointer = (clientX, clientY) => ({ x: clientX, y: clientY }),
} = {}) {
  const names = Object.keys(actions);
  const keyToActions = new Map();
  for (const name of names) {
    for (const code of actions[name].keys ?? []) {
      if (!keyToActions.has(code)) keyToActions.set(code, []);
      keyToActions.get(code).push(name);
    }
  }

  const keyDown = new Set();       // held by keyboard
  const padDown = new Set();       // held by gamepad
  // A third source, for anything that is neither: on-screen touch controls,
  // a replay driving the game, a bot. Unioned with the other two exactly as
  // they are unioned with each other, so a finger on a virtual button and a
  // hand on the keyboard do not cancel one another -- which is the same bug
  // the keyboard/pad split exists to avoid, met a third time.
  const virtualDown = new Set();   // held by an external source
  const active = new Set();        // the live union, updated as events arrive
  // Edge queries compare two *polled* snapshots rather than reading `active`
  // directly. Key events land between frames, so copying the live set at poll
  // time would erase the very transition `pressed` exists to report.
  let frameCurrent = new Set();
  let framePrevious = new Set();
  const axes = new Map();
  // The same readings before the deadzone, which `stick()` needs and `axis()`
  // must not get. A deadzone applied per axis carves a dead CROSS out of the
  // circle: a stick pushed gently up-right loses its horizontal component
  // entirely, and the shallow angles a twin-stick game is played in cannot be
  // reached. `stick()` applies a radial one instead, which needs the vector
  // intact. `axis()` keeps the old per-axis behaviour exactly, because three
  // shipped games read it and one dimension has no shallow angles to lose.
  const rawAxes = new Map();
  let pointerX = 0;
  let pointerY = 0;
  let pointerActive = false;
  const pressListeners = new Map();
  const releaseListeners = new Map();
  let padButtons = [];
  let padName = "";
  // Whether a pad is THERE, which is not the same as whether it has a name:
  // some controllers report an empty id, and one of those drives every button
  // and axis perfectly while `Boolean(padName)` calls it absent.
  let padPresent = false;

  function fire(map, name) {
    const listeners = map.get(name);
    if (!listeners) return;
    for (const listener of listeners) listener(name);
  }

  /** Recompute one action from its two sources and emit any edge. */
  function sync(name) {
    const next = keyDown.has(name) || padDown.has(name) || virtualDown.has(name);
    if (next === active.has(name)) return;
    if (next) {
      active.add(name);
      fire(pressListeners, name);
    } else {
      active.delete(name);
      fire(releaseListeners, name);
    }
  }

  function onKeyDown(event) {
    if (isTextEntry(event.target)) return;
    const bound = keyToActions.get(event.code);
    if (!bound) return;
    for (const name of bound) {
      if (preventDefault && (actions[name].preventDefault ?? true)) event.preventDefault();
      // Auto-repeat must not re-fire a press: a held key is one press.
      if (event.repeat) continue;
      keyDown.add(name);
      sync(name);
    }
  }

  function onKeyUp(event) {
    const bound = keyToActions.get(event.code);
    if (!bound) return;
    // Deliberately not gated on isTextEntry: a key pressed on the canvas and
    // released after focus moved must still be released.
    for (const name of bound) {
      keyDown.delete(name);
      sync(name);
    }
  }

  function releaseAll() {
    keyDown.clear();
    padDown.clear();
    virtualDown.clear();
    for (const name of [...active]) sync(name);
    axes.clear();
    rawAxes.clear();
    padButtons = [];
    // The pointer is deliberately NOT cleared: where the mouse was is still
    // where it is, and an aim that snaps to the origin on alt-tab would be a
    // worse bug than the stuck flipper this function exists to prevent. Only
    // its button state is released, which the `active` loop above did.
    pointerActive = false;
  }

  const onBlur = () => releaseAll();

  function onPointerMove(event) {
    const mapped = mapPointer(event.clientX ?? 0, event.clientY ?? 0);
    pointerX = mapped?.x ?? 0;
    pointerY = mapped?.y ?? 0;
    pointerActive = true;
  }

  const onPointerLeave = () => { pointerActive = false; };

  target.addEventListener?.("keydown", onKeyDown, { passive: false });
  target.addEventListener?.("keyup", onKeyUp);
  target.addEventListener?.("blur", onBlur);
  target.addEventListener?.("pointermove", onPointerMove, { passive: true });
  target.addEventListener?.("pointerdown", onPointerMove, { passive: true });
  target.addEventListener?.("pointerleave", onPointerLeave, { passive: true });

  const applyDeadzone = (value) => {
    const magnitude = Math.abs(value);
    if (magnitude < deadzone) return 0;
    // Rescale so the axis still reaches 1 at full deflection instead of
    // jumping from 0 to `deadzone` the moment it engages.
    return Math.sign(value) * ((magnitude - deadzone) / (1 - deadzone));
  };

  /** Fold the current pad state into `padDown`, leaving keyboard holds alone. */
  function readGamepad() {
    const pads = getGamepads() ?? [];
    const pad = Array.from(pads).find((candidate) => candidate?.connected);
    padPresent = Boolean(pad);
    if (!pad) {
      if (padName || padDown.size) {
        padName = "";
        padDown.clear();
        for (const name of names) {
          if (actions[name].pad?.axis) {
            axes.set(name, 0);
            rawAxes.set(name, 0);
          }
          sync(name);
        }
      }
      padButtons = [];
      return;
    }
    if (padName !== pad.id) padName = pad.id;

    const pressed = pad.buttons.map((button) => button.pressed || button.value > 0.45);
    for (const name of names) {
      const spec = actions[name].pad;
      if (!spec) continue;
      let held = (spec.buttons ?? []).some((index) => pressed[index]);
      if (spec.axis) {
        const reading = pad.axes[spec.axis.index] ?? 0;
        const raw = applyDeadzone(reading);
        axes.set(name, raw);
        rawAxes.set(name, reading);
        if (spec.axis.dir) held = held || Math.sign(raw) === spec.axis.dir;
      }
      if (held) padDown.add(name);
      else padDown.delete(name);
      sync(name);
    }
    padButtons = pressed;
  }

  return {
    get actions() { return [...names]; },
    get gamepadName() { return padName; },
    get connected() { return padPresent; },

    /** Poll the pad and roll edge state. Call once per frame, before reads. */
    poll() {
      framePrevious = frameCurrent;
      readGamepad();
      frameCurrent = new Set(active);
    },

    isDown(name) { return active.has(name); },
    /**
     * True only on the frame the action went down. Compares two polled
     * snapshots, so a press and release that both land between polls is not
     * seen here — use `onPress` when you need every one.
     */
    pressed(name) { return frameCurrent.has(name) && !framePrevious.has(name); },
    released(name) { return !frameCurrent.has(name) && framePrevious.has(name); },

    /**
     * -1..1 for an action pair, preferring an analogue stick and falling back
     * to the digital keys, so keyboard and pad feed the same movement code.
     */
    axis(negativeAction, positiveAction) {
      if (positiveAction === undefined) return axes.get(negativeAction) ?? 0;
      const stick = (axes.get(positiveAction) ?? 0) || -(axes.get(negativeAction) ?? 0);
      if (stick) return stick;
      return (active.has(positiveAction) ? 1 : 0) - (active.has(negativeAction) ? 1 : 0);
    },

    padButton(index) { return Boolean(padButtons[index]); },

    /**
     * Hold or release an action from a source that is neither key nor pad.
     *
     * The seam touch controls are built on, and the reason they need no
     * cooperation from the game: a virtual button holds the same action a key
     * would, so every `isDown`, `pressed`, `onPress` and `axis` call already
     * written keeps working unchanged. A replay or a bot can drive the same
     * seam.
     *
     * @param {string} name
     * @param {boolean} held
     */
    hold(name, held) {
      if (held) virtualDown.add(name); else virtualDown.delete(name);
      sync(name);
    },

    /**
     * Set an analogue axis directly, for a virtual stick.
     *
     * Stored in the same map the gamepad writes, so `axis()` prefers it over
     * the digital fallback exactly as it prefers a real stick. Pass 0 to hand
     * the axis back to the keys.
     *
     * @param {string} name Action name, as used by `axis(negative, positive)`.
     * @param {number} value -1..1
     */
    setAxis(name, value) {
      const clamped = Math.max(-1, Math.min(1, Number(value) || 0));
      if (clamped === 0) {
        axes.delete(name);
        rawAxes.delete(name);
      } else {
        axes.set(name, clamped);
        // Into both, so an on-screen stick reaches `stick()` as well as
        // `axis()`. A virtual stick has already had its own deadzone applied
        // by whatever drew it, so there is no raw reading to keep separate.
        rawAxes.set(name, clamped);
      }
    },

    /**
     * Where the pointer is, in whatever space `mapPointer` produces.
     *
     * `active` is false before the mouse has ever moved and after it leaves,
     * which is what tells a game to fall back to the pad rather than aim at
     * a stale corner. The position survives that -- see `releaseAll`.
     */
    get pointer() {
      return { x: pointerX, y: pointerY, active: pointerActive };
    },

    /**
     * Two axes as one **vector**, which is the reader a twin-stick game
     * wants and `axis()` cannot be without changing what it means for the
     * games already using it.
     *
     * Prefers a real stick and falls back to the keys, exactly as `axis()`
     * does, so one call site serves a pad and a keyboard. What it adds is
     * everything that only makes sense in two dimensions: a radial deadzone,
     * a clamp to the unit disc, and four-way or eight-way snapping. The
     * result is quantized, so it may be handed straight to a simulation.
     *
     * Bind a second set of four actions to axes 2 and 3 and call this twice —
     * that is the whole of twin-stick:
     *
     * ```js
     * const move = input.stick({ left: "left", right: "right", up: "up", down: "down" })
     * const aim  = input.stick({ left: "aimLeft", right: "aimRight", up: "aimUp", down: "aimDown" })
     * ```
     *
     * @param {{left: string, right: string, up: string, down: string}} bindings
     * @param {object} [options] `deadzone`, `resolution`, `previous`,
     *        `previousRaw`, `tiebreak` — see `core/stick`. The deadzone
     *        defaults to this input's own.
     */
    stick(bindings, options = {}) {
      if (!bindings) return neutralStick();
      // Oriented by each binding's own `dir` rather than by which slot it sits
      // in. This is the one place `stick` deliberately does NOT match `axis`:
      // `axis(negative, positive)` falls back to `-(negative)`, which reads
      // backwards when only the negative side names an axis -- push right on a
      // map that binds an axis to `left` alone and it reports left. That is
      // shipped behaviour in three games and stays; a vector reader whose
      // whole job is direction should not inherit it.
      const pair = (negative, positive) => {
        const forward = rawAxes.get(positive);
        if (forward !== undefined) {
          return (actions[positive]?.pad?.axis?.dir ?? 1) === -1 ? -forward : forward;
        }
        const backward = rawAxes.get(negative);
        if (backward !== undefined) {
          return (actions[negative]?.pad?.axis?.dir ?? -1) === -1 ? backward : -backward;
        }
        return 0;
      };
      const x = pair(bindings.left, bindings.right);
      const y = pair(bindings.up, bindings.down);
      if (x !== 0 || y !== 0) {
        return resolveStick(x, y, { deadzone, ...options });
      }
      return stickFromKeys(
        active.has(bindings.left), active.has(bindings.right),
        active.has(bindings.up), active.has(bindings.down),
        options,
      );
    },

    onPress(name, listener) {
      if (!pressListeners.has(name)) pressListeners.set(name, new Set());
      pressListeners.get(name).add(listener);
      return () => pressListeners.get(name)?.delete(listener);
    },

    onRelease(name, listener) {
      if (!releaseListeners.has(name)) releaseListeners.set(name, new Set());
      releaseListeners.get(name).add(listener);
      return () => releaseListeners.get(name)?.delete(listener);
    },

    releaseAll,

    destroy() {
      target.removeEventListener?.("keydown", onKeyDown);
      target.removeEventListener?.("keyup", onKeyUp);
      target.removeEventListener?.("blur", onBlur);
      target.removeEventListener?.("pointermove", onPointerMove);
      target.removeEventListener?.("pointerdown", onPointerMove);
      target.removeEventListener?.("pointerleave", onPointerLeave);
      releaseAll();
      pressListeners.clear();
      releaseListeners.clear();
    },
  };
}
