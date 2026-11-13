// The standalone player an exported Starline game runs on.
//
// It plays the game's levels in order. The simulation is @ccllc/arcade's own
// `createWorld` -- the same one the Foundry playtests with -- and the sprites
// come from the same scene.js the Foundry draws with, so an exported game
// looks and behaves like the playtest it came from.
//
// What it deliberately is not: an editor. There is no palette, no inspector,
// no presenter filters and no debug overlay. What it adds that a playtest does
// not have is the thing a game needs and a single level does not: levels in
// sequence, a hull that carries between them, a score that accumulates, and
// somewhere to land when you win or run out.

import { createWorld, gameLevel, normalizeShmupGame, idleInput, VIEW_W, VIEW_H, viewSpans } from "@ccllc/arcade/shmup";
import { createMusic } from "@ccllc/arcade/platform";
import { drawShip, drawSprite, travelTilt } from "./scene.js";

const SIM_STEP = 1 / 120;
/** More than this in one frame and we drop the rest: a tab that slept is not owed the time. */
const MAX_FRAME = 0.25;

const screen = document.getElementById("screen");
const context = screen.getContext("2d");
const overlay = document.getElementById("overlay");
const titleEl = document.getElementById("title");
const subtitleEl = document.getElementById("subtitle");
const controlsEl = document.getElementById("controls");
const startEl = document.getElementById("start");
const hudEl = document.getElementById("hud");
const scoreEl = document.getElementById("score");
const hullEl = document.getElementById("hull");
const stageNameEl = document.getElementById("stage-name");

// --- the game ----------------------------------------------------------------------------

let game = null;
let music = null;
const stars = [];

const say = (title, subtitle, button) => {
  titleEl.textContent = title;
  subtitleEl.innerHTML = subtitle;
  startEl.hidden = !button;
  startEl.textContent = button ?? "";
  overlay.hidden = false;
};

async function load() {
  try {
    const response = await fetch("./game.json", { cache: "no-store" });
    if (!response.ok) throw new Error(String(response.status));
    game = normalizeShmupGame(await response.json());
  } catch (error) {
    say("NO GAME HERE", `game.json could not be read (${error.message}).<br />Serve this folder over http rather than opening the file directly.`);
    return;
  }
  // Music is optional and its absence is silence, not an error.
  try {
    const tracks = await fetch("./music/tracks.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null));
    if (tracks && Object.keys(tracks).length) {
      music = createMusic({ masterGain: 0.45 });
      for (const [id, file] of Object.entries(tracks)) music.define(id, { src: `./music/${file}` });
    }
  } catch { music = null; }
  document.title = game.name;
  const levels = game.levels.length;
  say(game.name, `${levels} ${levels === 1 ? "SECTOR" : "SECTORS"}`, "START");
  controlsEl.hidden = false;
  startEl.hidden = false;
  startEl.focus();
}

// --- input -------------------------------------------------------------------------------

const held = new Set();
const DOWN = { ArrowLeft: "left", KeyA: "left", ArrowRight: "right", KeyD: "right", ArrowUp: "up", KeyW: "up", ArrowDown: "down", KeyS: "down", Space: "fire", KeyJ: "fire" };
addEventListener("keydown", (event) => {
  if (event.code === "KeyP" && run) { paused = !paused; return; }
  const action = DOWN[event.code];
  if (!action) return;
  event.preventDefault();
  held.add(action);
});
addEventListener("keyup", (event) => { const action = DOWN[event.code]; if (action) held.delete(action); });
addEventListener("blur", () => held.clear());

const readInput = (vertical) => {
  const x = (held.has("right") ? 1 : 0) - (held.has("left") ? 1 : 0);
  const y = (held.has("down") ? 1 : 0) - (held.has("up") ? 1 : 0);
  // A vertical sector is the same simulation turned a quarter: what the player
  // pushes on screen has to be turned with it, exactly as the Foundry does.
  return {
    ...idleInput(),
    dx: vertical ? -y : x,
    dy: vertical ? x : y,
    fire: held.has("fire"),
  };
};

// --- the run -----------------------------------------------------------------------------

let run = null;
let paused = false;

function startGame() {
  run = { index: 0, score: 0, hull: null, world: null, level: null };
  overlay.hidden = true;
  hudEl.hidden = false;
  enterLevel(0);
  requestAnimationFrame(frame);
}

function enterLevel(index) {
  const level = gameLevel(game, index);
  if (!level) return finish("VICTORY", "Every sector cleared.");
  run.index = index;
  run.level = level;
  run.world = createWorld(level);
  // The hull carries between sectors; the first one sets it.
  if (run.hull === null) run.hull = run.world.state.hullMax;
  else run.world.state.hull = run.hull;
  stageNameEl.textContent = `${index + 1}/${game.levels.length} ${level.name.toUpperCase()}`;
  sizeScreen(level);
  if (music) {
    if (level.music) void music.resume().then(() => music.play(level.music));
    else music.stop({ fadeSeconds: 0.4 });
  }
}

function finish(title, subtitle) {
  run = null;
  hudEl.hidden = true;
  if (music) music.stop({ fadeSeconds: 0.6 });
  say(title, subtitle, "PLAY AGAIN");
  startEl.focus();
}

function sizeScreen(level) {
  const spans = viewSpans(level.mode);
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const width = level.mode === "vertical" ? spans.cross : VIEW_W;
  const height = level.mode === "vertical" ? spans.along : VIEW_H;
  screen.width = Math.round(width * dpr);
  screen.height = Math.round(height * dpr);
  screen.style.aspectRatio = `${width} / ${height}`;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (!stars.length) for (let i = 0; i < 240; i += 1) stars.push({ x: Math.random(), y: Math.random(), z: 0.3 + Math.random() * 0.7 });
}

let last = 0;
function frame(now) {
  if (!run) return;
  const dt = Math.min(MAX_FRAME, last ? (now - last) / 1000 : 0);
  last = now;
  if (!paused) {
    const vertical = run.level.mode === "vertical";
    let left = dt;
    while (left > 0) {
      const step = Math.min(SIM_STEP, left);
      run.world.step(step, readInput(vertical));
      left -= step;
    }
    const state = run.world.state;
    run.score = state.score;
    run.hull = state.hull;
    scoreEl.textContent = String(state.score).padStart(6, "0");
    hullEl.textContent = String(Math.max(0, state.hull));
    if (state.outcome === "victory") {
      if (run.index + 1 < game.levels.length) enterLevel(run.index + 1);
      else return finish("VICTORY", `Every sector cleared.<br />Final score <b>${String(state.score).padStart(6, "0")}</b>`);
    } else if (state.outcome === "gameover") {
      return finish("GAME OVER", `Sector ${run.index + 1} of ${game.levels.length}.<br />Final score <b>${String(state.score).padStart(6, "0")}</b>`);
    }
  }
  draw(now / 1000);
  requestAnimationFrame(frame);
}

// --- the picture -------------------------------------------------------------------------

function draw(seconds) {
  const level = run.level;
  const state = run.world.state;
  const spans = viewSpans(level.mode);
  const vertical = level.mode === "vertical";
  const width = vertical ? spans.cross : VIEW_W;
  const height = vertical ? spans.along : VIEW_H;

  context.fillStyle = "#05090d";
  context.fillRect(0, 0, width, height);
  // A starfield that drifts with the camera, the same idea as the editor's.
  context.fillStyle = "rgba(210,235,245,.55)";
  for (const star of stars) {
    const drift = (state.camera * star.z * 0.4) % width;
    const x = (star.x * width - drift + width) % width;
    context.globalAlpha = 0.25 + star.z * 0.5;
    context.fillRect(x, star.y * height, star.z > 0.85 ? 2 : 1, star.z > 0.85 ? 2 : 1);
  }
  context.globalAlpha = 1;

  context.save();
  if (vertical) { context.translate(0, height); context.rotate(-Math.PI / 2); }
  const camera = state.camera;

  const drawItem = (item) => {
    if (!item.alive || !item.active) return;
    const x = item.x - camera;
    if (x < -260 || x > spans.along + 260) return;
    const alpha = item.type === "decoration" ? item.decoration?.opacity ?? 0.5 : 1;
    drawSprite(context, item.sprite, x, item.y, item.size, false, alpha,
      item.rotation + (item.turned ?? 0) + travelTilt(item.vx, item.vy, item.heading?.follow ?? 0),
      item.scale, item.type === "enemy", level.assets, item.tint, { glow: item.glow, depth: item.depth });
  };

  state.enemies.filter((item) => item.type === "decoration" && item.decoration?.layer === "background").forEach(drawItem);
  for (const bullet of state.bullets) {
    context.fillStyle = bullet.color;
    context.fillRect(bullet.x - camera - 15, bullet.y - 2, 20, 4);
  }
  for (const bullet of state.enemyBullets) {
    context.fillStyle = bullet.color;
    context.beginPath(); context.arc(bullet.x - camera, bullet.y, bullet.radius, 0, Math.PI * 2); context.fill();
  }
  state.enemies.filter((item) => item.type !== "decoration").forEach(drawItem);
  state.enemies.filter((item) => item.type === "decoration" && item.decoration?.layer === "foreground").forEach(drawItem);

  const player = state.player;
  const blinking = player.invulnerable > 0 && Math.floor(player.invulnerable * 10) % 2 === 0;
  drawShip(context, player.x, player.y, seconds * 1000, level.player.sprite, blinking, level.assets, level.player.tint,
    { scale: level.player.scale, glow: level.player.glow });
  context.restore();

  if (paused) {
    context.fillStyle = "rgba(3,7,11,.7)";
    context.fillRect(0, 0, width, height);
    context.fillStyle = "#eaff62";
    context.font = "600 20px ui-monospace, monospace";
    context.textAlign = "center";
    context.fillText("PAUSED", width / 2, height / 2);
    context.textAlign = "left";
  }
}

startEl.addEventListener("click", () => { last = 0; paused = false; startGame(); });
void load();
