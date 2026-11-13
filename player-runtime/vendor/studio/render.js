import { animationFrameAt, clipFrameAt } from "@ccllc/arcade/sprite";
// Everything that turns a SpriteAsset into pixels on a 2D context, and
// nothing that is React. This is its own subpath (@ccllc/studio/render)
// because the game that renders sprites and the editor that authors them
// must draw a shape identically -- Starline carried two hand-kept copies of
// the vector routine for exactly as long as this module did not exist.
/**
 * The transparency checkerboard behind every editor's canvas.
 *
 * Light, and deliberately so since 2026-08-31. It used to be two near-black
 * greys, which sat prettily in the dark studio chrome and failed at the one
 * job a checkerboard has: Ryan erased part of a photograph and could not
 * tell the hole from the picture, because a dark checkerboard under dark
 * artwork reads as more artwork. Every image editor anyone has used is
 * light grey on white for exactly this reason, and the convention is worth
 * more here than the colour scheme.
 */
export function drawChecker(context, width, height, cell = 16, dark = "#d4d4d4", light = "#ffffff") {
    for (let y = 0; y < height; y += cell) {
        for (let x = 0; x < width; x += cell) {
            context.fillStyle = (x / cell + y / cell) % 2 ? light : dark;
            context.fillRect(x, y, cell, cell);
        }
    }
}
/** Draw one vector shape, honouring its rotation about its own centre. */
export function drawVectorShape(context, shape, options = {}) {
    const scaleX = options.scaleX ?? 1;
    const scaleY = options.scaleY ?? 1;
    context.save();
    context.scale(scaleX, scaleY);
    context.translate(shape.x + shape.w / 2, shape.y + shape.h / 2);
    context.rotate((shape.rotation * Math.PI) / 180);
    context.translate(-(shape.x + shape.w / 2), -(shape.y + shape.h / 2));
    context.fillStyle = shape.fill;
    context.strokeStyle = shape.stroke;
    context.lineWidth = shape.strokeWidth / Math.max(scaleX, scaleY);
    context.beginPath();
    if (shape.type === "rect")
        context.rect(shape.x, shape.y, shape.w, shape.h);
    else if (shape.type === "ellipse") {
        context.ellipse(shape.x + shape.w / 2, shape.y + shape.h / 2, Math.abs(shape.w / 2), Math.abs(shape.h / 2), 0, 0, Math.PI * 2);
    }
    else if (shape.type === "line") {
        context.moveTo(shape.x, shape.y);
        context.lineTo(shape.x + shape.w, shape.y + shape.h);
    }
    else {
        (shape.points ?? []).forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
    }
    if (shape.type !== "line" && shape.type !== "path")
        context.fill();
    context.stroke();
    context.restore();
}
// One offscreen canvas per raster asset, keyed weakly so replacing the asset
// object (which every edit does -- assets are immutable documents) naturally
// invalidates the cache and dropping the asset drops the bitmap.
const rasterCanvasCache = new WeakMap();
/**
 * The asset rendered 1:1 onto an offscreen canvas, cached per asset object.
 * The factory argument exists for tests; everything real uses the default.
 */
export function rasterAssetCanvas(asset, createCanvas = () => document.createElement("canvas")) {
    const cached = rasterCanvasCache.get(asset);
    if (cached)
        return cached;
    const canvas = createCanvas();
    canvas.width = asset.width;
    canvas.height = asset.height;
    const context = canvas.getContext("2d");
    if (context) {
        asset.pixels.forEach((pixel, index) => {
            if (!pixel)
                return;
            context.fillStyle = pixel;
            context.fillRect(index % asset.width, Math.floor(index / asset.width), 1, 1);
        });
    }
    rasterCanvasCache.set(asset, canvas);
    return canvas;
}
const imageElementCache = new WeakMap();
/**
 * The `<img>` behind an image asset, cached per asset object.
 *
 * Decoding a data URL is asynchronous and there is no way around that, so
 * this hands back an element that may not have loaded yet and the draw
 * below skips it until it has. A game that cannot afford a blank first
 * frame should call this during loading and await `element.decode()`;
 * that is the whole reason it is exported rather than private.
 */
export function imageAssetElement(asset, createImage = () => new Image()) {
    const cached = imageElementCache.get(asset);
    if (cached)
        return cached;
    const element = createImage();
    element.decoding = "async";
    element.src = asset.data;
    imageElementCache.set(asset, element);
    return element;
}
/**
 * Draw any kind of asset centred on the current origin, fitted inside a
 * square of `extent` units on its longest side. This is the game-side call:
 * position, rotate and tint the context first, then hand over the asset.
 *
 * An `image` asset draws nothing until its data URL has decoded. That is
 * stated rather than hidden because the alternative — a synchronous decode
 * — does not exist in a browser, and a placeholder would be this module
 * inventing art.
 */
export function drawSpriteAsset(context, asset, extent) {
    if (asset.kind === "image") {
        const element = imageAssetElement(asset);
        if (!element.complete || element.naturalWidth === 0)
            return;
        const ratio = Math.min(extent / asset.width, extent / asset.height);
        context.drawImage(element, (-asset.width * ratio) / 2, (-asset.height * ratio) / 2, asset.width * ratio, asset.height * ratio);
        return;
    }
    if (asset.kind === "raster") {
        const bitmap = rasterAssetCanvas(asset);
        context.imageSmoothingEnabled = false;
        const ratio = Math.min(extent / asset.width, extent / asset.height);
        context.drawImage(bitmap, (-asset.width * ratio) / 2, (-asset.height * ratio) / 2, asset.width * ratio, asset.height * ratio);
        return;
    }
    // Fitted by its longest side like the other two kinds. Until 2.0.42 a
    // vector asset was scaled to extent × extent, so a 64 × 32 car came out
    // square; the racer found it drawing cars.
    const ratio = Math.min(extent / asset.width, extent / asset.height);
    context.save();
    context.translate((-asset.width * ratio) / 2, (-asset.height * ratio) / 2);
    context.scale(ratio, ratio);
    asset.shapes.forEach((shape) => drawVectorShape(context, shape));
    context.restore();
}
const findSprite = (sprites, id) => (typeof sprites === "function" ? sprites(id) : sprites.get(id));
/**
 * Draw the frame a clip shows at `time`, centred on the current origin.
 *
 * Returns whether anything was drawn: false for a clip with no frames, a
 * frame whose sprite has been deleted, or an `image` asset that has not
 * decoded yet -- which is a caller's cue to draw its own placeholder rather
 * than to wonder where the character went.
 */
export function drawClipFrame(context, clip, time, sprites, options) {
    if (!clip || clip.frames.length === 0)
        return false;
    const frame = clip.frames[clipFrameAt(clip, time)];
    const asset = frame && findSprite(sprites, frame.assetId);
    if (!asset)
        return false;
    const mirrorX = Boolean(frame.flipX) !== Boolean(options.flipX);
    const mirrorY = Boolean(frame.flipY) !== Boolean(options.flipY);
    context.save();
    if (mirrorX || mirrorY)
        context.scale(mirrorX ? -1 : 1, mirrorY ? -1 : 1);
    drawSpriteAsset(context, asset, options.extent);
    context.restore();
    return true;
}
/**
 * Draw the character: the clip its state is bound to, `age` seconds in.
 *
 * The whole play-time call. A game keeps a state name and how long it has
 * held it -- `runnjump` hands both out as `player.anim` and `player.animAge`
 * -- positions the context, and calls this:
 *
 * ```js
 * context.translate(player.x, player.y);
 * drawAnimationState(context, hero, player.anim, player.animAge, sprites, {
 *   extent: 32, flipX: player.facing < 0,
 * });
 * ```
 */
export function drawAnimationState(context, set, state, age, sprites, options) {
    const shown = animationFrameAt(set, state, age);
    if (!shown)
        return false;
    const asset = findSprite(sprites, shown.frame.assetId);
    if (!asset)
        return false;
    const mirrorX = Boolean(shown.frame.flipX) !== Boolean(options.flipX);
    const mirrorY = Boolean(shown.frame.flipY) !== Boolean(options.flipY);
    context.save();
    if (mirrorX || mirrorY)
        context.scale(mirrorX ? -1 : 1, mirrorY ? -1 : 1);
    drawSpriteAsset(context, asset, options.extent);
    context.restore();
    return true;
}
//# sourceMappingURL=render.js.map