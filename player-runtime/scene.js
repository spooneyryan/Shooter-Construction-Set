// The picture, apart from the editor that draws it.
//
// Every sprite Starline puts on screen goes through here: the built-in art,
// the imported and authored assets, the tint, the halo, the depth wash, and
// the atlas that keeps a thousand of them cheap. It is a plain module with no
// React and no editor state so that two very different callers can share one
// answer to "what does a scout look like" -- the Foundry, and the standalone
// player an exported game runs on.
//
// Nothing here reads the simulation. It takes a shape and some numbers and
// paints; what to paint and where is the caller's business.
import { createSpriteCache } from "@ccllc/arcade/render";
import { drawSpriteAsset, imageAssetElement } from "@ccllc/studio/render";
import { PLAYER_R } from "@ccllc/arcade/shmup";
/**
 * Degrees a sprite turns to face the way it is flying, scaled by how far the
 * author wants it to follow (0 level, 1 fully along the velocity).
 *
 * Measured from the sprite's own forward axis rather than from screen-right,
 * so a left-flying enemy leaning down reads as leaning down: atan2 against the
 * SIZE of the along-speed gives the lean off straight-ahead, and the sign of
 * the along-speed puts it back on the side the picture actually tilts toward.
 * With no along-speed at all the sprite is assumed to face left, which is the
 * way every enemy flies. Presentation only -- Math.atan2 is fine here, and
 * nothing in the simulation reads the result.
 */
export function travelTilt(vx, vy, follow) {
    if (!follow || (!vx && !vy))
        return 0;
    return Math.atan2(vy, Math.abs(vx)) * (Math.sign(vx) || -1) * follow * 180 / Math.PI;
}
// The split is what makes it work: everything that changes the PIXELS goes in
// the key, and everything that only moves them stays per-instance. Position,
// rotation, scale, the horizontal flip and alpha are all transform or
// compositor state, so they cost nothing at blit time and must not be baked --
// scale especially, which is authored anywhere in 0.25 to 4 and would other-
// wise be a fresh bake per value.
const spriteCache = createSpriteCache({ pageSize: 2048, maxPages: 4 });
// A custom asset is a document the Sprite Studio edits, so a baked copy of one
// has to expire when it is saved. `updateLevel` replaces the asset array
// immutably, so identity changes on every save -- a WeakMap turns that into a
// cache key without hashing the asset on every frame.
const assetIdentities = new WeakMap();
let nextAssetIdentity = 0;
function assetIdentity(asset) {
    let id = assetIdentities.get(asset);
    if (id === undefined) {
        nextAssetIdentity += 1;
        id = nextAssetIdentity;
        assetIdentities.set(asset, id);
    }
    return id;
}
// Above this a sprite is a backdrop -- a nebula at 170, a planet at 110 -- and
// there are a handful on screen rather than hundreds. Baking those would spend
// most of the atlas on the sprites with the least to gain from it.
const BAKE_MAX_SIZE = 72;
// The same judgement in device pixels rather than authored units. A sprite
// magnified past this is one of a few on screen, and its region would be large
// enough that the atlas could hold only a handful -- so it is drawn straight
// from the recipe, which is sharper anyway.
const BAKE_MAX_PIXELS = 128;
// Bakes are made at multiples of this, so a scale slider sweeping through a
// hundred values reuses a dozen bakes rather than minting a hundred.
const BAKE_STEP = 8;
/** Half a baked region, in the pixels the region is rasterised at. The widest
 *  any recipe reaches is the comet's tail at 1.7x size; the constant covers the
 *  shadow blur, the stroke and slack, and stays constant because a shadow is
 *  blurred in device pixels rather than in the transform's units. */
const bakeHalf = (size) => Math.ceil(size * 1.75 + 22);
/** The recipe: one sprite, at the origin, with no transform of its own. */
export function paintSprite(context, sprite, size, selected, assets, tint, glow, depth) {
    // One filter string for everything that recolours or softens the sprite.
    //
    // Darken is `brightness`, deliberately NOT alpha: the starfield is drawn
    // behind everything, so a transparent sprite shows stars *inside* its own
    // artwork, which is the whole reason `depth` exists. Brightness below 1
    // walks the sprite toward black, and black is what the backdrop nearly is.
    const filters = [];
    if (tint)
        filters.push(`hue-rotate(${tint}deg)`);
    if (depth?.darken)
        filters.push(`brightness(${(1 - depth.darken).toFixed(3)})`);
    if (depth?.blur)
        filters.push(`blur(${depth.blur}px)`);
    if (filters.length)
        context.filter = filters.join(" ");
    const isPickup = sprite === "energy" || sprite === "upgrade";
    // No halo unless one was authored. The renderer used to give every sprite a
    // default glow of its own choosing; Ryan asked for objects to have none at
    // all by default, so the colour below is only ever used by a selection ring
    // or by an authored halo. Selection still gets its blur, because a selected
    // object has to read as selected whatever it was authored with.
    context.shadowColor = glow ? glow.color : sprite === "asteroid" ? "#87939c" : isPickup ? "#eaff62" : "#ff6a4d";
    context.shadowBlur = selected ? 24 : glow ? glow.blur : 0;
    context.lineWidth = selected ? 3 : 2;
    context.strokeStyle = selected ? "#eaff62" : sprite === "asteroid" ? "#8ca0a8" : isPickup ? "#eaff62" : "#ff947f";
    context.fillStyle = sprite === "asteroid" ? "#29343a" : "rgba(71, 24, 51, .92)";
    const customAsset = sprite.startsWith("asset:") ? assets.find((asset) => `asset:${asset.id}` === sprite) : undefined;
    if (customAsset) {
        // The same routine the editor previews with, so authoring and play cannot
        // drift apart -- this file used to carry its own copy of the vector half.
        drawSpriteAsset(context, customAsset, size * 2);
    }
    else if (sprite === "energy" || sprite === "upgrade") {
        context.rotate(sprite === "upgrade" ? Math.PI / 4 : 0);
        context.fillStyle = sprite === "upgrade" ? "rgba(100,227,255,.18)" : "rgba(234,255,98,.14)";
        context.beginPath();
        context.rect(-size * .62, -size * .62, size * 1.24, size * 1.24);
        context.fill();
        context.stroke();
        context.rotate(sprite === "upgrade" ? -Math.PI / 4 : 0);
        context.fillStyle = sprite === "upgrade" ? "#64e3ff" : "#eaff62";
        context.font = `bold ${Math.max(10, size * .75)}px monospace`;
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(sprite === "upgrade" ? "U" : "+", 0, 1);
    }
    else if (sprite === "raider" || sprite === "wraith" || sprite === "carrier") {
        context.fillStyle = "rgba(65,22,48,.94)";
        context.beginPath();
        if (sprite === "raider") {
            context.moveTo(-size, 0);
            context.lineTo(size * .5, -size * .72);
            context.lineTo(size, 0);
            context.lineTo(size * .5, size * .72);
        }
        if (sprite === "wraith") {
            context.moveTo(-size, -size * .7);
            context.lineTo(size, 0);
            context.lineTo(-size, size * .7);
            context.lineTo(-size * .45, 0);
        }
        if (sprite === "carrier") {
            context.moveTo(-size, -size * .38);
            context.lineTo(size * .55, -size * .65);
            context.lineTo(size, 0);
            context.lineTo(size * .55, size * .65);
            context.lineTo(-size, size * .38);
            context.lineTo(-size * .72, 0);
        }
        context.closePath();
        context.fill();
        context.stroke();
        context.fillStyle = "#ff6a4d";
        if (sprite === "carrier") {
            context.fillRect(-size * .55, -size * .13, size * 1.15, size * .26);
            context.fillStyle = "#211a30";
            context.fillRect(-size * .28, -size * .32, size * .4, size * .64);
        }
        else {
            context.beginPath();
            context.arc(size * .2, 0, size * .2, 0, Math.PI * 2);
            context.fill();
        }
    }
    else if (sprite === "planet" || sprite === "nebula" || sprite === "wreck" || sprite === "comet") {
        if (sprite === "planet") {
            const planet = context.createRadialGradient(-size * .25, -size * .25, size * .08, 0, 0, size);
            planet.addColorStop(0, "#547f98");
            planet.addColorStop(.45, "#293c62");
            planet.addColorStop(1, "#101525");
            context.fillStyle = planet;
            context.beginPath();
            context.arc(0, 0, size, 0, Math.PI * 2);
            context.fill();
            context.strokeStyle = "rgba(100,227,255,.35)";
            context.beginPath();
            context.ellipse(0, 0, size * 1.45, size * .28, -.18, 0, Math.PI * 2);
            context.stroke();
        }
        else if (sprite === "nebula") {
            const cloud = context.createRadialGradient(0, 0, 0, 0, 0, size);
            cloud.addColorStop(0, "rgba(148,82,208,.58)");
            cloud.addColorStop(.42, "rgba(72,84,177,.3)");
            cloud.addColorStop(1, "rgba(40,20,75,0)");
            context.fillStyle = cloud;
            context.beginPath();
            context.arc(0, 0, size, 0, Math.PI * 2);
            context.fill();
        }
        else if (sprite === "wreck") {
            context.rotate(-.22);
            context.fillStyle = "#26333b";
            context.strokeStyle = "#748994";
            context.beginPath();
            context.moveTo(-size, -size * .2);
            context.lineTo(size * .65, -size * .5);
            context.lineTo(size, 0);
            context.lineTo(size * .3, size * .24);
            context.lineTo(-size, size * .4);
            context.closePath();
            context.fill();
            context.stroke();
            context.fillStyle = "#ff6a4d";
            context.fillRect(-size * .25, -size * .08, size * .42, size * .12);
        }
        else {
            const tail = context.createLinearGradient(-size * 1.7, 0, size * .3, 0);
            tail.addColorStop(0, "rgba(100,227,255,0)");
            tail.addColorStop(.65, "rgba(100,227,255,.35)");
            tail.addColorStop(1, "#eaf7fb");
            context.fillStyle = tail;
            context.beginPath();
            context.moveTo(-size * 1.7, -size * .3);
            context.lineTo(size * .2, -size * .2);
            context.lineTo(size * .2, size * .2);
            context.lineTo(-size * 1.7, size * .3);
            context.closePath();
            context.fill();
            context.beginPath();
            context.arc(size * .2, 0, size * .28, 0, Math.PI * 2);
            context.fill();
        }
    }
    else if (sprite === "diamond") {
        context.rotate(Math.PI / 4);
        context.beginPath();
        context.rect(-size * 0.55, -size * 0.55, size * 1.1, size * 1.1);
        context.fill();
        context.stroke();
        context.fillStyle = "#ff6a4d";
        context.fillRect(-size * 0.18, -size * 0.18, size * 0.36, size * 0.36);
    }
    else if (sprite === "blade") {
        context.beginPath();
        for (let i = 0; i < 8; i += 1) {
            const angle = i * Math.PI / 4;
            const radius = i % 2 === 0 ? size : size * 0.48;
            const px = Math.cos(angle) * radius;
            const py = Math.sin(angle) * radius;
            if (i === 0)
                context.moveTo(px, py);
            else
                context.lineTo(px, py);
        }
        context.closePath();
        context.fill();
        context.stroke();
        context.fillStyle = "#ffbd71";
        context.beginPath();
        context.arc(0, 0, size * 0.22, 0, Math.PI * 2);
        context.fill();
    }
    else if (sprite === "turret") {
        context.beginPath();
        context.arc(0, 0, size * 0.76, 0, Math.PI * 2);
        context.fill();
        context.stroke();
        context.fillStyle = "#ff6a4d";
        context.fillRect(-size * 0.12, -size * 0.16, -size * 0.95, size * 0.32);
        context.fillStyle = "#18212b";
        context.beginPath();
        context.arc(0, 0, size * 0.34, 0, Math.PI * 2);
        context.fill();
    }
    else if (sprite === "asteroid") {
        context.beginPath();
        const points = [1, .78, .92, .7, 1, .82, .9, .68];
        points.forEach((radius, index) => {
            const angle = index / points.length * Math.PI * 2;
            const px = Math.cos(angle) * size * radius;
            const py = Math.sin(angle) * size * radius;
            if (index === 0)
                context.moveTo(px, py);
            else
                context.lineTo(px, py);
        });
        context.closePath();
        context.fill();
        context.stroke();
        context.strokeStyle = "rgba(195, 214, 220, .32)";
        context.beginPath();
        context.arc(-size * .22, -size * .1, size * .2, 0, Math.PI * 2);
        context.stroke();
    }
    else {
        const halo = context.createRadialGradient(0, 0, size * .12, 0, 0, size);
        halo.addColorStop(0, "#ffd2a2");
        halo.addColorStop(.3, "#ff6a4d");
        halo.addColorStop(1, "rgba(110, 24, 69, .2)");
        context.fillStyle = halo;
        context.beginPath();
        context.arc(0, 0, size, 0, Math.PI * 2);
        context.fill();
        context.beginPath();
        context.arc(0, 0, size * .7, 0, Math.PI * 2);
        context.stroke();
        context.fillStyle = "#351a37";
        context.beginPath();
        context.arc(size * .09, 0, size * .33, 0, Math.PI * 2);
        context.fill();
    }
    context.filter = "none";
    if (selected) {
        context.shadowBlur = 0;
        context.strokeStyle = "rgba(234,255,98,.8)";
        context.setLineDash([5, 5]);
        context.beginPath();
        context.arc(0, 0, size + 13, 0, Math.PI * 2);
        context.stroke();
    }
}
/**
 * A baked copy of this sprite, or null when it is not worth baking.
 *
 * Null for the cases where a cache would lose: a sprite too big to be
 * numerous, the selected one, of which there is exactly one on screen and
 * whose dashed ring would otherwise double the key space for nothing, and one
 * magnified so far that its bake would cost more atlas than it saves.
 *
 * **A bake is made at the resolution it will be drawn at.** The transform in
 * force here decides that -- the display's pixel ratio, the editor's zoom and
 * the item's own scale all multiply together -- and it is read off the context
 * rather than passed in, so no call site can forget it and quietly lose
 * resolution. Baking at `size` and letting the transform magnify the result is
 * what made a scaled-up sprite blocky while the selected copy, which skips the
 * cache entirely, stayed sharp.
 */
export function spriteRegion(context, sprite, size, selected, assets, tint, glow, depth) {
    if (selected || !(size > 0) || size > BAKE_MAX_SIZE)
        return null;
    const matrix = context.getTransform();
    // The larger of the two axes, so a non-uniform scale over-resolves the minor
    // one rather than under-resolving the major one.
    const detail = Math.max(Math.hypot(matrix.a, matrix.b), Math.hypot(matrix.c, matrix.d));
    // Quantised, because scale is a slider: without this, dragging it would mint
    // a fresh bake every frame. Rounding up never under-resolves.
    const pixels = Math.ceil(size * detail / BAKE_STEP) * BAKE_STEP;
    // Past the ceiling, drawing straight from the recipe is both sharper and
    // cheaper than an atlas region only a handful of sprites could share.
    if (!(pixels > 0) || pixels > BAKE_MAX_PIXELS)
        return null;
    const baked = pixels / size;
    // The halo is part of what was baked, so it is part of the key -- and so is
    // the resolution, or the first bake would be reused at every later size.
    let key = `${sprite}|${size}|${pixels}|${tint}|${glow ? glow.color + ":" + glow.blur : "-"}|${depth ? depth.darken + ":" + depth.blur : "-"}`;
    if (sprite.startsWith("asset:")) {
        const asset = assets.find((entry) => `asset:${entry.id}` === sprite);
        // An unresolved asset draws nothing and must not be cached under a key
        // that would still miss once the asset arrives.
        if (!asset)
            return null;
        // Nor may an image that has not finished decoding. `drawSpriteAsset` skips
        // one of those entirely, and baking that nothing would store an empty
        // region under a key that never changes again -- the sprite would stay
        // invisible for the rest of the session. Declining costs one blank frame
        // and fixes itself on the next.
        if (asset.kind === "image") {
            const element = imageAssetElement(asset);
            if (!element.complete || element.naturalWidth === 0)
                return null;
        }
        key += `|${assetIdentity(asset)}`;
    }
    // A Gaussian reaches about three times its radius, and the blur is in device
    // pixels rather than in the transform's units -- so the padding is added
    // after the scaling, in the same space `bakeHalf`'s own slack lives in.
    const half = bakeHalf(pixels) + Math.ceil((depth?.blur ?? 0) * 3);
    const region = spriteCache.sprite(key, half * 2, half * 2, (own) => {
        own.translate(half, half);
        own.scale(baked, baked);
        paintSprite(own, sprite, size, false, assets, tint, glow, depth);
    });
    return region ? { region, detail: baked } : null;
}
/** `extra` rather than two more positional parameters: this already takes
 *  eleven, and a call site with two bare numbers on the end says nothing. */
export function drawSprite(context, sprite, x, y, size, selected = false, alpha = 1, rotation = 0, scale = 1, faceLeft = false, assets = [], tint = 0, extra = {}) {
    context.save();
    context.translate(x, y);
    context.rotate(rotation * Math.PI / 180);
    // The vertical axis defaults to the horizontal one, so every existing call
    // site keeps the uniform scale it was written with.
    context.scale(scale * (faceLeft && (sprite === "raider" || sprite === "wraith" || sprite === "carrier") ? -1 : 1), extra.scaleY ?? scale);
    context.globalAlpha = alpha;
    // Asked for AFTER the transform is in force, because the transform is what
    // decides how much resolution the bake needs.
    const baked = spriteRegion(context, sprite, size, selected, assets, tint, extra.glow, extra.depth);
    if (baked) {
        // Divided back out so the blit lands 1:1 on device pixels: the region was
        // rasterised `detail` times larger than the units it is drawn in.
        const width = baked.region.width / baked.detail;
        const height = baked.region.height / baked.detail;
        context.drawImage(baked.region.canvas, baked.region.x, baked.region.y, baked.region.width, baked.region.height, -width / 2, -height / 2, width, height);
    }
    else
        paintSprite(context, sprite, size, selected, assets, tint, extra.glow, extra.depth);
    context.restore();
}
export function drawShip(context, x, y, now, sprite = "dart", blink = false, assets = [], tint = 0, ship = {}) {
    if (blink)
        return;
    // One number. The sprite's own dimensions are the ship's size, and this
    // scales them -- which is also why it needs no separate "resolution": a
    // sprite drawn at its own size is drawn 1:1, and scaling DOWN stays crisp.
    const scale = ship.scale ?? 1;
    const asset = sprite.startsWith("asset:") ? assets.find((entry) => `asset:${entry.id}` === sprite) : undefined;
    // `drawSpriteAsset` fits the picture inside a box of `extent`, so the extent
    // that draws it 1:1 is its longer edge. This is the same number
    // `playerExtent` collides against, which is what keeps the drawn ship and
    // the hit ship the same ship.
    const extent = (asset ? Math.max(asset.width, asset.height) : PLAYER_R * 2) * scale;
    if (asset) {
        drawSprite(context, sprite, x, y, extent / 2, false, 1, 0, 1, false, assets, tint, { glow: ship.glow });
        return;
    }
    // The built-in hulls are paths rather than a baked sprite, so the two axes
    // are a transform around the whole recipe rather than an argument to it.
    // A built-in hull is a path at a fixed geometry rather than a rasterised
    // sprite, so the scale is simply a transform around the recipe.
    context.save();
    context.translate(x, y);
    context.scale(scale, scale);
    const flame = 13 + Math.sin(now / 45) * 5;
    const flameGradient = context.createLinearGradient(-43, 0, -12, 0);
    flameGradient.addColorStop(0, "rgba(98,226,255,0)");
    flameGradient.addColorStop(.4, "#64e3ff");
    flameGradient.addColorStop(1, "#eaffaa");
    context.fillStyle = flameGradient;
    context.beginPath();
    context.moveTo(-17, -7);
    context.lineTo(-17 - flame, 0);
    context.lineTo(-17, 7);
    context.closePath();
    context.fill();
    context.shadowColor = "#64e3ff";
    context.shadowBlur = 17;
    context.fillStyle = "#eaf7fb";
    context.beginPath();
    if (sprite === "raven") {
        context.moveTo(29, 0);
        context.lineTo(-20, -24);
        context.lineTo(-8, -4);
        context.lineTo(-22, 0);
        context.lineTo(-8, 4);
        context.lineTo(-20, 24);
    }
    else if (sprite === "nova") {
        context.moveTo(30, 0);
        context.lineTo(-5, -17);
        context.lineTo(-22, -12);
        context.lineTo(-13, 0);
        context.lineTo(-22, 12);
        context.lineTo(-5, 17);
    }
    else if (sprite === "striker") {
        context.moveTo(34, 0);
        context.lineTo(-10, -12);
        context.lineTo(-20, -25);
        context.lineTo(-14, 0);
        context.lineTo(-20, 25);
        context.lineTo(-10, 12);
    }
    else {
        context.moveTo(31, 0);
        context.lineTo(-14, -20);
        context.lineTo(-6, -5);
        context.lineTo(-22, 0);
        context.lineTo(-6, 5);
        context.lineTo(-14, 20);
    }
    context.closePath();
    context.fill();
    context.shadowBlur = 0;
    context.fillStyle = "#163249";
    context.beginPath();
    context.moveTo(14, 0);
    context.lineTo(-8, -9);
    context.lineTo(-1, 0);
    context.lineTo(-8, 9);
    context.closePath();
    context.fill();
    context.fillStyle = "#eaff62";
    context.fillRect(3, -2, 11, 4);
    context.restore();
}
