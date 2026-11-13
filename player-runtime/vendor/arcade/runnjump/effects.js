// Portable presentation definitions. These never participate in simulation state.
import { normalizeSfx } from "../sfx/synth.js";
import { normalizeBurst } from "../burst/contract.js";

const runnjumpEffectId = (value) => typeof value === "string" ? value.slice(0, 80) : "";
/** @param {any} input */
export function normalizeRunNJumpEffects(input = {}) {
  const result = {};
  for (const key of ["fireSoundId", "deathSoundId", "deathExplosionId", "impactExplosionId", "sparkExplosionId"]) {
    if (typeof input?.[key] === "string") result[key] = runnjumpEffectId(input[key]);
  }
  return result;
}
/** @param {any} input */
export function normalizeRunNJumpSound(input = {}) {
  const sound = normalizeSfx(input?.sound);
  return { id: runnjumpEffectId(input?.id) || "sound", name: sound.name, sound };
}
/** @param {any} input */
export function normalizeRunNJumpExplosion(input = {}) {
  const burst = normalizeBurst(input?.burst && typeof input.burst === "object" ? input.burst : {});
  const tint = Number(input?.tint), grid = Number(input?.pixelGrid);
  return { id: runnjumpEffectId(input?.id) || "explosion", name: burst.name, burst,
    tint: Number.isFinite(tint) ? Math.max(0, Math.min(1, tint)) : 0,
    pixelGrid: Number.isFinite(grid) ? Math.max(0, Math.min(8, Math.round(grid))) : 0 };
}
