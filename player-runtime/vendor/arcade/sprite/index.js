// @ccllc/arcade/sprite — sprite assets and their documents.
//
// A sibling of `core` rather than part of it, and a sibling of the genre
// modules rather than inside one: a drawn thing is not a shoot-'em-up
// concept or a platformer concept, and both genres carry the same assets.
// Promoted out of `shmup` on 2026-08-22, the day `runnjump` became the
// second consumer; `shmup` re-exports everything here so the day cost no
// consumer a change.
//
// Deliberately not in the package's root barrel, the same stance as the
// genre modules: import the subpath.
//
// Drawing is not here and will not be. `@ccllc/studio/render` is the one
// renderer, shared by the games and the editors precisely so they cannot
// draw a shape differently.
//
// Two things here ARE picture processing rather than document handling, and
// they are here because they are arithmetic and therefore testable:
// `gif` decodes an animated GIF into frames, and `quantize` turns a
// decoded picture into a pixel grid. The browser owns exactly one step of
// that pipeline — PNG and JPEG into RGBA — because it is genuinely better
// at it; everything either side is in this package under `node --test`.

export {
  IMAGE_MAX_DATA,
  IMAGE_MIME_TYPES,
  clampTo,
  imageDataType,
  isImageData,
  normalizeAssets,
} from "./assets.js";
export { GIF_DISPOSAL, GifError, decodeGif } from "./gif.js";
export {
  nearestColor,
  pixelsPalette,
  quantizeRgba,
  resampleRgba,
  rgbaToPixels,
} from "./quantize.js";
export { SPRITE_VERSION, defineSpriteFormat, defineSpriteLibraryFormat } from "./document.js";
export {
  ANIMATION_VERSION,
  animationFrameAt,
  animationStates,
  clipDuration,
  clipForState,
  clipFrameAt,
  defineAnimationFormat,
  emptyAnimationSet,
  findClip,
  normalizeAnimationSet,
  normalizeClip,
} from "./animation.js";
