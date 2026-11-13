// Motion interpolation: drawing between the ticks.
//
// A fixed-step simulation produces poses at its own rate — sixty a second, on
// displays that show a hundred and twenty or more. Drawn directly, each pose
// is held for two frames, then three when the scheduler's jitter walks the
// step boundary across a frame, and that 2-3-2-3 cadence is the judder people
// cannot name but always feel. `createLoop` already hands `render` the cure's
// other half: `alpha`, the fraction of a step accumulated toward the next
// tick. This module is the remembering half — where everything WAS one tick
// ago — so a renderer can draw each thing a fraction of the way from there to
// where it IS, and motion becomes as smooth as the display instead of as
// coarse as the simulation.
//
// The contract, per moving thing: call `put(id, x, y, angle)` once per
// simulation tick, after stepping; call `at(id, alpha)` when drawing. The one
// trade to know about: interpolating draws up to one tick behind the
// simulation — 16.7 ms at 1/60, half that at 1/120. For these games that is
// the right trade; extrapolation has no lag and overshoots at every wall.
//
// This is presentation. It reads the simulation and never writes it, so
// determinism and replays are untouched. It is also rollback-safe by
// construction: a correction re-steps the ticks, `put` runs again for each,
// and the buffer ends holding exactly the corrected poses. A discontinuity
// that should NOT be smoothed — a teleport, a respawn, a camera cut — either
// announces itself (a tick with no `put` for that id snaps automatically,
// which covers despawn-and-reuse in pooled games) or is declared, with
// `snapDistance` or an explicit `snap()`.

// Not named TAU: core/trig.js exports that name, and a flat-scope consumer
// concatenating this package cannot hold two declarations of it.
const FULL_TURN = Math.PI * 2;

function lerpAngle(from, to, alpha) {
  let arc = (to - from) % FULL_TURN;
  if (arc > Math.PI) arc -= FULL_TURN;
  else if (arc < -Math.PI) arc += FULL_TURN;
  return from + arc * alpha;
}

export function createMotionInterpolator(options = {}) {
  const snapDistance = options.snapDistance ?? Infinity;
  const snapDistanceSq = snapDistance === Infinity ? Infinity : snapDistance * snapDistance;

  /** id -> { px, py, pa, cx, cy, ca, tick } — reused, never reallocated. */
  const poses = new Map();
  let tick = 0;

  return {
    /**
     * Mark a tick boundary. Call once after each simulation step, before the
     * `put` calls for that tick.
     */
    begin() {
      tick += 1;
      // Entities gone longer than a tick would snap anyway; sweeping them
      // keeps the map from holding every id a long session has ever seen.
      if ((tick & 127) === 0) {
        for (const [id, pose] of poses) {
          if (pose.tick < tick - 2) poses.delete(id);
        }
      }
    },

    /** Record where `id` is NOW, making its previous capture the lerp origin. */
    put(id, x, y, angle = 0) {
      let pose = poses.get(id);
      if (pose === undefined) {
        pose = { px: x, py: y, pa: angle, cx: x, cy: y, ca: angle, tick };
        poses.set(id, pose);
        return;
      }
      if (pose.tick === tick - 1) {
        pose.px = pose.cx;
        pose.py = pose.cy;
        pose.pa = pose.ca;
      } else {
        // A missed tick means this is not the same continuous motion — the
        // entity despawned, or a pooled id was reissued. Snap, never streak.
        pose.px = x;
        pose.py = y;
        pose.pa = angle;
      }
      if (snapDistanceSq !== Infinity) {
        const dx = x - pose.px;
        const dy = y - pose.py;
        if (dx * dx + dy * dy > snapDistanceSq) {
          pose.px = x;
          pose.py = y;
          pose.pa = angle;
        }
      }
      pose.cx = x;
      pose.cy = y;
      pose.ca = angle;
      pose.tick = tick;
    },

    /**
     * The pose to draw: `alpha` of the way from last tick toward this one.
     * Returns null for an id never captured. Pass `out` to avoid the
     * allocation — at hundreds of calls a frame, that is the difference
     * between smoothing the garbage collector's hiccups and causing them.
     */
    at(id, alpha, out) {
      const pose = poses.get(id);
      if (pose === undefined) return null;
      const target = out ?? { x: 0, y: 0, angle: 0 };
      target.x = pose.px + (pose.cx - pose.px) * alpha;
      target.y = pose.py + (pose.cy - pose.py) * alpha;
      target.angle = pose.pa === pose.ca ? pose.ca : lerpAngle(pose.pa, pose.ca, alpha);
      return target;
    },

    /**
     * Collapse previous onto current so the next frame draws things where
     * they are: one id, or every id when the whole world jumped — a level
     * load, a camera cut, a restored snapshot outside normal stepping.
     */
    snap(id) {
      if (id !== undefined) {
        const pose = poses.get(id);
        if (pose === undefined) return;
        pose.px = pose.cx;
        pose.py = pose.cy;
        pose.pa = pose.ca;
        return;
      }
      for (const pose of poses.values()) {
        pose.px = pose.cx;
        pose.py = pose.cy;
        pose.pa = pose.ca;
      }
    },

    /** Forget every pose — a new run should not inherit the old one's motion. */
    clear() {
      poses.clear();
      tick = 0;
    },

    get size() {
      return poses.size;
    },
  };
}
