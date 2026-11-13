// Optional platformer motion. Curve geometry is shared with Starline; tile
// contacts and moving-solid carrying remain owned by the platformer world.
import { movementPosition, movementPathLength } from "../core/curve-motion.js";
import { atan2, cos, sin } from "../core/trig.js";
const rjMotionNumber = (v, fallback, min, max) => Number.isFinite(Number(v ?? fallback)) ? Math.max(min, Math.min(max, Number(v ?? fallback))) : fallback;
export function normalizeRunNJumpMount(input) {
  return input && typeof input === "object" ? { x: rjMotionNumber(input.x, 0, -256, 256), y: rjMotionNumber(input.y, 0, -256, 256) } : undefined;
}
export function normalizeRunNJumpMotion(input = {}) {
  input = input && typeof input === "object" ? input : {};
  const pattern = ["behavior", "stationary", "straight", "sine", "zigzag", "arc", "bezier"].includes(input.pattern) ? input.pattern : "straight";
  const defaults = [{x:-64,y:-48},{x:-128,y:48},{x:-192,y:0}];
  return { pattern, speed: rjMotionNumber(input.speed, 40, 0, 900), amplitude: rjMotionNumber(input.amplitude, 24, 0, 500), frequency: rjMotionNumber(input.frequency, .5, 0, 10),
    angle: rjMotionNumber(input.angle, 0, -360, 360), curve: rjMotionNumber(input.curve, 45, -720, 720), spin: rjMotionNumber(input.spin, 0, -720, 720), faceTravel: rjMotionNumber(input.faceTravel, 0, 0, 1),
    points: defaults.map((p,i) => ({x:rjMotionNumber(input.points?.[i]?.x,p.x,-4000,4000),y:rjMotionNumber(input.points?.[i]?.y,p.y,-4000,4000)})) };
}
export function runNJumpMotionPosition(motion, x, y, age) {
  return motion.pattern === "behavior" ? {x,y} : movementPosition(motion,x,y,age);
}
export const runNJumpMotionLength = movementPathLength;
/** Sprite offset from its usual left/right facing, clockwise screen degrees. */
export function runNJumpFacing(motion, age, vx, vy, facing = -1, rotation = 0) {
  let lean = 0;
  if (motion?.faceTravel && (vx !== 0 || vy !== 0)) {
    const relative = atan2(vy,vx)*180/Math.PI - (facing < 0 ? 180 : 0);
    lean = ((relative + 540) % 360 - 180) * motion.faceTravel;
  }
  return rotation + (motion?.spin ?? 0)*age + lean;
}
/** Forward/across offsets in the firing frame. No mount preserves the origin. */
export function runNJumpMuzzle(at, aim, mount) {
  return mount ? {x:at.x + mount.x*aim.x - mount.y*aim.y, y:at.y + mount.x*aim.y + mount.y*aim.x} : at;
}
export function runNJumpActorAim(actor) {
  const angle = ((actor.facing < 0 ? 180 : 0) + (actor.motionRotation ?? actor.authoredRotation ?? 0))*Math.PI/180;
  return {x:cos(angle),y:sin(angle)};
}
export function runNJumpCanFire(world, actor, def) {
  if (!(def?.weapon?.visibleOnly ?? (def?.motion && def.motion.pattern !== "behavior"))) return true;
  const camera=world.state.camera, ts=world.game.tileSize;
  return actor.x+actor.w>camera.x && actor.x<camera.x+world.level.camera.viewCols*ts && actor.y+actor.h>camera.y && actor.y<camera.y+world.level.camera.viewRows*ts;
}
