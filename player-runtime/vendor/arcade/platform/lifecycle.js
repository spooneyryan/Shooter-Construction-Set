// The three orphaned behaviours, in one place.
//
// Pause on hide lives only in SpeegeBall. Release-all-inputs on blur lives only
// in Pinball. Resuming the audio context on the first gesture is in both, done
// differently. Each is a few lines, and each is a real bug in whichever game
// lacks it — so the library owns all three rather than leaving them to be
// remembered.

/**
 * @param {object} [options]
 * @param {Document} [options.document]
 * @param {typeof globalThis} [options.window]
 * @param {boolean} [options.pauseOnHide]
 * @param {boolean} [options.pauseOnBlur]
 * @param {{releaseAll?: () => void}} [options.input] Released on blur, so a
 *        held key does not survive alt-tab.
 * @param {{suspend?: () => void, resume?: () => void}} [options.audio]
 * @param {{setPaused?: (paused: boolean) => void}} [options.loop]
 * @param {() => void} [options.onPause]
 * @param {() => void} [options.onResume]
 */
export function createLifecycle({
  document: documentRef = globalThis.document,
  window: windowRef = globalThis,
  pauseOnHide = true,
  pauseOnBlur = false,
  input,
  audio,
  loop,
  onPause,
  onResume,
} = {}) {
  const cleanups = [];
  let paused = false;
  // A pause the player asked for must survive a tab switch: coming back from a
  // hidden tab should not silently resume a game they paused on purpose.
  let manual = false;

  function setPaused(next, { byUser = false } = {}) {
    if (byUser) manual = next;
    if (next === paused) return;
    paused = next;
    loop?.setPaused(paused);
    if (paused) {
      input?.releaseAll();
      onPause?.();
    } else {
      onResume?.();
    }
  }

  function listen(target, type, handler, options) {
    target?.addEventListener?.(type, handler, options);
    cleanups.push(() => target?.removeEventListener?.(type, handler, options));
  }

  if (pauseOnHide) {
    listen(documentRef, "visibilitychange", () => {
      if (documentRef.visibilityState === "hidden") setPaused(true);
      else if (!manual) setPaused(false);
    });
  }

  if (pauseOnBlur) {
    listen(windowRef, "blur", () => setPaused(true));
    listen(windowRef, "focus", () => { if (!manual) setPaused(false); });
  } else {
    // Even without pausing, a lost focus has to drop held inputs.
    listen(windowRef, "blur", () => input?.releaseAll());
  }

  if (audio) {
    const unlock = () => { void audio.resume(); };
    // `once` on each: whichever gesture arrives first warms the context.
    for (const type of ["pointerdown", "keydown", "touchstart"]) {
      listen(windowRef, type, unlock, { once: true, passive: true });
    }
  }

  return {
    get paused() { return paused; },
    /** Player-initiated, so a tab switch will not undo it. */
    pause() { setPaused(true, { byUser: true }); },
    resume() { setPaused(false, { byUser: true }); },
    toggle() { setPaused(!paused, { byUser: true }); },

    destroy() {
      for (const cleanup of cleanups) cleanup();
      cleanups.length = 0;
    },
  };
}
