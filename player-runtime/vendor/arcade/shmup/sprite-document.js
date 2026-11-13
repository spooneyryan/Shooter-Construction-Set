// The sprite documents moved to `../sprite/document.js` on 2026-08-22, when
// sprites were promoted out of this genre module. This shim is why the move
// cost no consumer a change: `@ccllc/arcade/shmup` and
// `@ccllc/arcade/shmup/sprite-document` keep resolving to the same exports.
// New code should import from `@ccllc/arcade/sprite`.

export { SPRITE_VERSION, defineSpriteFormat, defineSpriteLibraryFormat } from "../sprite/document.js";
