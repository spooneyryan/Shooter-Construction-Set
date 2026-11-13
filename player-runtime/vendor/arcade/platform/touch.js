// On-screen controls, for the devices people actually reach for.
//
// `createInput` unified keyboard and gamepad and stopped there, so every game
// built on this library is unplayable on a phone — while the netcode's own
// notes talk about cellular radios waking from idle, which is to say that
// phones were already assumed to be players.
//
// The whole design goal is that A GAME NEEDS NO CHANGES. Touch feeds the same
// action map through `input.hold` and `input.setAxis`, so every `isDown`,
// `pressed`, `onPress` and `axis` call already written keeps working, and a
// finger and a keyboard held at once do not cancel each other.
//
// DRAWING IS OPTIONAL AND SEPARATE. The module owns the geometry and the
// pointer handling; `touchControlState` hands back where everything is and
// what is pressed, so a game can draw its own. `drawTouchControls` is a
// serviceable default, because a control nobody can see is not a control —
// but it is a function you call, not something that happens to you.

const DEFAULT_STICK_DEADZONE = 0.15;

/**
 * Is this a device where a finger is the primary pointer?
 *
 * Feature detection rather than a user-agent string: a laptop with a
 * touchscreen should keep its keyboard, and a tablet with a keyboard attached
 * should get both. `coarse` is the question actually being asked — "is the
 * pointer imprecise" — and it is the one that decides whether a 44-pixel target
 * is big enough.
 */
export function isTouchPrimary(win = globalThis) {
  return Boolean(win?.matchMedia?.("(pointer: coarse)")?.matches);
}

/**
 * @typedef {object} TouchButton
 * @property {string} action  Action name, as in the input map.
 * @property {string} [label] Drawn on the button by the default renderer.
 * @property {number} x  Centre, 0..1 across the surface.
 * @property {number} y  Centre, 0..1 down the surface.
 * @property {number} [radius] 0..1 of the SMALLER side. Defaults to 0.075.
 */

/**
 * @typedef {object} TouchStick
 * @property {string} xNegative Action for left, as `axis(xNegative, xPositive)`.
 * @property {string} xPositive
 * @property {string} [yNegative] Up. Omit for a one-dimensional stick.
 * @property {string} [yPositive] Down.
 * @property {number} x  Rest centre, 0..1.
 * @property {number} y
 * @property {number} [radius] 0..1 of the smaller side. Defaults to 0.13.
 * @property {boolean} [floating] Re-centre on first touch anywhere in its half
 *        of the surface, rather than staying put. Defaults to true — a fixed
 *        stick demands the player look at their thumb.
 */

/**
 * A stick on the left and two buttons on the right.
 *
 * Thumb-reachable rather than centred: the numbers put everything in the lower
 * corners, where thumbs are when a phone is held in two hands, and the buttons
 * are staggered so the two are not one target with a seam.
 */
export function defaultTouchLayout({ fire = "fire", jump = "jump" } = {}) {
  return {
    sticks: [
      {
        xNegative: "left",
        xPositive: "right",
        yNegative: "up",
        yPositive: "down",
        x: 0.17,
        y: 0.72,
        radius: 0.13,
        floating: true,
      },
    ],
    buttons: [
      { action: fire, label: "A", x: 0.86, y: 0.74, radius: 0.085 },
      { action: jump, label: "B", x: 0.7, y: 0.62, radius: 0.075 },
    ],
  };
}

/**
 * Wire on-screen controls to an existing input map.
 *
 * @param {object} options
 * @param {{hold: Function, setAxis: Function}} options.input The input to feed.
 *        Only those two functions are used, so a test can pass a pair of spies.
 * @param {EventTarget & {getBoundingClientRect?: Function, setPointerCapture?: Function, releasePointerCapture?: Function, hasPointerCapture?: Function}} options.target
 *        Usually the canvas. Pointer events are captured here. Typed loosely
 *        on purpose: the capture methods live on Element rather than
 *        EventTarget, and a test passes a stub with neither.
 * @param {{sticks?: TouchStick[], buttons?: TouchButton[]}} [options.layout]
 * @param {number} [options.deadzone] Below this the stick reads as centred.
 * @param {boolean} [options.enabled] Start switched on. Defaults to
 *        `isTouchPrimary()`, so a desktop pays nothing and a phone needs no
 *        decision from the game.
 * @param {() => {width: number, height: number}} [options.getSize] Override how
 *        the surface size is measured, for a test or an offscreen canvas.
 */
export function createTouchControls({
  input,
  target,
  layout = defaultTouchLayout(),
  deadzone = DEFAULT_STICK_DEADZONE,
  enabled = isTouchPrimary(),
  getSize,
}) {
  if (!input || typeof input.hold !== "function" || typeof input.setAxis !== "function") {
    throw new Error("createTouchControls needs an input with hold() and setAxis().");
  }

  const sticks = (layout.sticks ?? []).map((stick, index) => ({
    ...stick,
    id: `stick-${index}`,
    radius: stick.radius ?? 0.13,
    floating: stick.floating ?? true,
    // Where it is drawn right now: a floating stick moves to the first touch.
    liveX: stick.x,
    liveY: stick.y,
    dx: 0,
    dy: 0,
    pointer: null,
  }));
  const buttons = (layout.buttons ?? []).map((button, index) => ({
    ...button,
    id: `button-${index}`,
    radius: button.radius ?? 0.075,
    pressed: false,
    pointer: null,
  }));

  const size = () => {
    if (getSize) return getSize();
    const rect = target?.getBoundingClientRect?.();
    return { width: rect?.width ?? 0, height: rect?.height ?? 0 };
  };

  /** Pixels per unit. The SMALLER side, so a control is round on any shape. */
  const unit = ({ width, height }) => Math.min(width, height);

  function pointFor(event) {
    const rect = target?.getBoundingClientRect?.();
    return {
      x: (event.clientX ?? 0) - (rect?.left ?? 0),
      y: (event.clientY ?? 0) - (rect?.top ?? 0),
    };
  }

  function releaseStick(stick) {
    stick.pointer = null;
    stick.dx = 0;
    stick.dy = 0;
    stick.liveX = stick.x;
    stick.liveY = stick.y;
    input.setAxis(stick.xPositive, 0);
    if (stick.yPositive) input.setAxis(stick.yPositive, 0);
    // The digital actions go too. A stick released while the game reads
    // `isDown('left')` rather than `axis()` would otherwise stay held -- the
    // same stuck-flipper bug `releaseAll` on blur exists to prevent.
    for (const action of [stick.xNegative, stick.xPositive, stick.yNegative, stick.yPositive]) {
      if (action) input.hold(action, false);
    }
  }

  function applyStick(stick, point, dimensions) {
    const scale = unit(dimensions);
    const radius = stick.radius * scale;
    if (radius <= 0) return;
    let dx = (point.x - stick.liveX * dimensions.width) / radius;
    let dy = (point.y - stick.liveY * dimensions.height) / radius;
    const magnitude = Math.hypot(dx, dy);
    if (magnitude > 1) {
      dx /= magnitude;
      dy /= magnitude;
    }
    stick.dx = Math.abs(dx) < deadzone ? 0 : dx;
    stick.dy = Math.abs(dy) < deadzone ? 0 : dy;

    input.setAxis(stick.xPositive, stick.dx);
    if (stick.yPositive) input.setAxis(stick.yPositive, stick.dy);
    // Digital holds as well as the axis, so a game that only ever asks
    // `isDown('left')` is playable too. Both sources agree, because both come
    // from the same displacement.
    input.hold(stick.xNegative, stick.dx < -deadzone);
    input.hold(stick.xPositive, stick.dx > deadzone);
    if (stick.yNegative) input.hold(stick.yNegative, stick.dy < -deadzone);
    if (stick.yPositive) input.hold(stick.yPositive, stick.dy > deadzone);
  }

  function hitButton(point, dimensions) {
    const scale = unit(dimensions);
    for (const button of buttons) {
      const cx = button.x * dimensions.width;
      const cy = button.y * dimensions.height;
      // A generous target: the drawn radius plus a third. A 44-pixel minimum is
      // the accessibility floor and a drawn button is often smaller than the
      // area a thumb should hit.
      const reach = button.radius * scale * 1.33;
      if (Math.hypot(point.x - cx, point.y - cy) <= reach) return button;
    }
    return null;
  }

  function claimStick(point, dimensions) {
    const scale = unit(dimensions);
    for (const stick of sticks) {
      if (stick.pointer !== null) continue;
      if (stick.floating) {
        // A floating stick claims its whole half of the surface, so the player
        // puts a thumb down wherever it lands and the stick comes to them.
        const ownsLeft = stick.x <= 0.5;
        if (ownsLeft ? point.x <= dimensions.width / 2 : point.x > dimensions.width / 2) {
          stick.liveX = point.x / (dimensions.width || 1);
          stick.liveY = point.y / (dimensions.height || 1);
          return stick;
        }
        continue;
      }
      const cx = stick.x * dimensions.width;
      const cy = stick.y * dimensions.height;
      if (Math.hypot(point.x - cx, point.y - cy) <= stick.radius * scale * 1.5) return stick;
    }
    return null;
  }

  function onPointerDown(event) {
    if (!enabled) return;
    const dimensions = size();
    if (!dimensions.width || !dimensions.height) return;
    const point = pointFor(event);

    // Buttons first: they sit inside the floating stick's half on a small
    // screen, and a thumb on a button must not also steer.
    const button = hitButton(point, dimensions);
    if (button) {
      button.pressed = true;
      button.pointer = event.pointerId;
      input.hold(button.action, true);
      target?.setPointerCapture?.(event.pointerId);
      event.preventDefault?.();
      return;
    }

    const stick = claimStick(point, dimensions);
    if (stick) {
      stick.pointer = event.pointerId;
      applyStick(stick, point, dimensions);
      target?.setPointerCapture?.(event.pointerId);
      event.preventDefault?.();
    }
  }

  function onPointerMove(event) {
    if (!enabled) return;
    const stick = sticks.find((entry) => entry.pointer === event.pointerId);
    if (!stick) return;
    const dimensions = size();
    if (!dimensions.width || !dimensions.height) return;
    applyStick(stick, pointFor(event), dimensions);
    event.preventDefault?.();
  }

  function onPointerUp(event) {
    const stick = sticks.find((entry) => entry.pointer === event.pointerId);
    if (stick) releaseStick(stick);
    for (const button of buttons) {
      if (button.pointer !== event.pointerId) continue;
      button.pressed = false;
      button.pointer = null;
      input.hold(button.action, false);
    }
    if (target?.hasPointerCapture?.(event.pointerId)) {
      target.releasePointerCapture?.(event.pointerId);
    }
  }

  function releaseEverything() {
    for (const stick of sticks) releaseStick(stick);
    for (const button of buttons) {
      button.pressed = false;
      button.pointer = null;
      input.hold(button.action, false);
    }
  }

  target?.addEventListener?.("pointerdown", onPointerDown, { passive: false });
  target?.addEventListener?.("pointermove", onPointerMove, { passive: false });
  target?.addEventListener?.("pointerup", onPointerUp);
  // `pointercancel` is the one everybody forgets, and on a phone it is the
  // common case rather than the exception: an incoming call, a notification
  // pulled down, or the browser deciding the gesture was a scroll all cancel
  // rather than release. Without this the action stays held forever.
  target?.addEventListener?.("pointercancel", onPointerUp);

  return {
    get enabled() { return enabled; },
    /** Turn them on or off — a settings toggle, or a device that gained a pad. */
    setEnabled(next) {
      enabled = Boolean(next);
      if (!enabled) releaseEverything();
    },

    /**
     * Where everything is and what is pressed, in PIXELS, for drawing.
     *
     * Returned rather than drawn so a game can render controls in its own
     * style. `drawTouchControls` below is the default, and it consumes exactly
     * this.
     */
    state() {
      const dimensions = size();
      const scale = unit(dimensions);
      return {
        enabled,
        width: dimensions.width,
        height: dimensions.height,
        sticks: sticks.map((stick) => ({
          id: stick.id,
          x: stick.liveX * dimensions.width,
          y: stick.liveY * dimensions.height,
          radius: stick.radius * scale,
          // Where the thumb is, as an offset from the centre.
          thumbX: stick.liveX * dimensions.width + stick.dx * stick.radius * scale,
          thumbY: stick.liveY * dimensions.height + stick.dy * stick.radius * scale,
          active: stick.pointer !== null,
        })),
        buttons: buttons.map((button) => ({
          id: button.id,
          label: button.label ?? "",
          x: button.x * dimensions.width,
          y: button.y * dimensions.height,
          radius: button.radius * scale,
          pressed: button.pressed,
        })),
      };
    },

    releaseAll: releaseEverything,

    destroy() {
      releaseEverything();
      target?.removeEventListener?.("pointerdown", onPointerDown);
      target?.removeEventListener?.("pointermove", onPointerMove);
      target?.removeEventListener?.("pointerup", onPointerUp);
      target?.removeEventListener?.("pointercancel", onPointerUp);
    },
  };
}

/**
 * A serviceable default rendering. Call it from your draw, after the game.
 *
 * Deliberately plain and deliberately translucent: on-screen controls sit on
 * top of the thing the player is trying to look at, and the failure mode of a
 * handsome control scheme is that it covers the game. Colours are arguments so
 * a skinned game can pass its own tokens.
 *
 * @param {CanvasRenderingContext2D} context
 * @param {ReturnType<ReturnType<typeof createTouchControls>['state']>} state
 * @param {object} [colors]
 */
export function drawTouchControls(context, state, {
  ring = "rgba(255,255,255,0.28)",
  fill = "rgba(255,255,255,0.10)",
  active = "rgba(255,255,255,0.34)",
  label = "rgba(255,255,255,0.72)",
} = {}) {
  if (!state?.enabled || !context) return;
  context.save();
  context.lineWidth = 2;
  context.textAlign = "center";
  context.textBaseline = "middle";

  for (const stick of state.sticks) {
    context.beginPath();
    context.arc(stick.x, stick.y, stick.radius, 0, Math.PI * 2);
    context.strokeStyle = ring;
    context.fillStyle = fill;
    context.fill();
    context.stroke();

    context.beginPath();
    context.arc(stick.thumbX, stick.thumbY, stick.radius * 0.42, 0, Math.PI * 2);
    context.fillStyle = stick.active ? active : fill;
    context.fill();
    context.stroke();
  }

  for (const button of state.buttons) {
    context.beginPath();
    context.arc(button.x, button.y, button.radius, 0, Math.PI * 2);
    context.fillStyle = button.pressed ? active : fill;
    context.strokeStyle = ring;
    context.fill();
    context.stroke();
    if (button.label) {
      context.fillStyle = label;
      context.font = `600 ${Math.round(button.radius * 0.8)}px ui-monospace, monospace`;
      context.fillText(button.label, button.x, button.y);
    }
  }

  context.restore();
}
