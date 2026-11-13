// The camera, which is simulation, not presentation: the activation window
// hangs off it, and an auto-scroller's crush edge can kill. So it lives in
// the step, is part of the snapshot, and is deterministic like everything
// else here. What a renderer does with it — smoothing, shake — is its own
// business, applied on top and never fed back.
//
// The modes are what make one engine serve both target games:
//   fixed       the whole level is one screen
//   roomFlip    the camera snaps a screen at a time — chained fixed screens
//   followX/XY  dead zone plus look-ahead, clamped to the level
//   autoScroll  forced, at a speed, with a crush edge

import { clampTo } from "../sprite/assets.js";
import { exactX, exactY, moveActorX } from "./move.js";
import { killPlayer } from "./player.js";

/**
 * @param {any} world
 * @param {number} dt
 */
export function updateCamera(world, dt) {
  const state = world.state;
  const config = world.level.camera;
  const ts = world.field.tileSize;
  const viewW = config.viewCols * ts;
  const viewH = config.viewRows * ts;
  const maxX = Math.max(0, world.field.cols * ts - viewW);
  const maxY = Math.max(0, world.field.rows * ts - viewH);

  const alive = state.players.filter((player) => player.alive);
  const primary = alive[0] ?? state.players[0];

  if (config.mode === "fixed") {
    state.camera.x = 0;
    state.camera.y = 0;
    return;
  }

  if (config.mode === "autoScroll") {
    state.camera.x = clampTo(state.camera.x + config.speed * dt, 0, maxX);
    state.camera.y = clampTo(state.camera.y, 0, maxY);
    // The crush edge: whoever falls behind is shoved along; shoved into a
    // wall is dead. Squeeze, not teleport — the push goes through the
    // collision core like any other movement.
    for (const player of alive) {
      const edge = Math.round(state.camera.x) + 2;
      if (player.x < edge) {
        moveActorX(world.field, player, edge - player.x, { glue: false });
        if (player.x < edge - 2) killPlayer(world, player);
      }
    }
    return;
  }

  if (config.mode === "roomFlip") {
    if (primary) {
      const pageX = Math.floor((primary.x + primary.w / 2) / viewW);
      const pageY = Math.floor((primary.y + primary.h / 2) / viewH);
      state.camera.x = clampTo(pageX * viewW, 0, maxX);
      state.camera.y = clampTo(pageY * viewH, 0, maxY);
    }
    return;
  }

  // followX / followXY. Two players share a midpoint; one leads alone.
  if (alive.length > 0) {
    let targetX = 0;
    let targetY = 0;
    for (const player of alive) {
      // The EXACT position, not the rounded one. A player's `x` is a whole
      // pixel, so a camera targeting it inherits that rounding: at a walk of
      // 1.5px a step the camera advances 1, 2, 1, 2 while the body advances an
      // even 1.5, and the difference between them — which is where the player
      // sits on screen — oscillates by half a pixel every step. The player
      // vibrates against a world that is itself moving smoothly, and no amount
      // of render smoothing can fix it, because the two are quantised
      // differently at the source.
      targetX += exactX(world.field, player) + player.w / 2;
      targetY += exactY(world.field, player) + player.h / 2;
    }
    targetX = targetX / alive.length + config.lookAhead * (primary ? primary.facing : 1);
    targetY /= alive.length;

    const left = state.camera.x + (viewW - config.deadZoneW) / 2;
    const right = state.camera.x + (viewW + config.deadZoneW) / 2;
    if (targetX < left) state.camera.x = targetX - (viewW - config.deadZoneW) / 2;
    else if (targetX > right) state.camera.x = targetX - (viewW + config.deadZoneW) / 2;

    if (config.mode === "followXY") {
      const top = state.camera.y + (viewH - config.deadZoneH) / 2;
      const bottom = state.camera.y + (viewH + config.deadZoneH) / 2;
      if (targetY < top) state.camera.y = targetY - (viewH - config.deadZoneH) / 2;
      else if (targetY > bottom) state.camera.y = targetY - (viewH + config.deadZoneH) / 2;
    } else {
      state.camera.y = maxY;
    }
  }
  state.camera.x = clampTo(state.camera.x, 0, maxX);
  state.camera.y = clampTo(state.camera.y, 0, maxY);
}
