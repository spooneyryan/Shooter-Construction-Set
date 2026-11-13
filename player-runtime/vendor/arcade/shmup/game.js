// A Game: the thing a player is handed, and the thing an author actually
// builds. Levels belong to it, and so does everything they share.
//
// Until this, a Level was the whole document. It carried its own sprites, its
// own saved components and its own ship, which meant two levels of one game
// could not share a sprite without a copy in each, and nothing said "these
// five levels are one thing". `runnjump` already had the answer for the other
// genre -- a `GameDef` owning the hero, the assets and the levels, with
// `createCampaign` chaining them -- and this is the same shape for the shmup.
//
// What is shared and what is not:
//
//   the Game   name, the ship, sprite assets, saved components, rules, and an
//              ordered list of levels
//   a Level    what is genuinely per-level: its mode, its length, the items
//              placed in it, and the piece of music that plays over it
//
// The engine is untouched by any of this. `createWorld` still takes a Level
// with its own assets and player, and `gameLevel(game, index)` is what makes
// one: the game's shared parts spliced into the level as it goes out. So an
// exported level is still self-contained, every level file written before
// Games still loads, and none of the world, the renderer or the collision
// code learns a new word.
//
// The three names that would otherwise read `normalizeGame`, `emptyGame` and
// `defineGameFormat` carry `Shmup` instead: `runnjump` got there first with a
// Game of its own, and a consumer that flattens both genres into one scope --
// a compilation of the two Construction Sets is not far-fetched -- would get a
// redeclaration rather than a game. tests/flat-scope.test.mjs is what caught
// it; renaming was cheap because nothing depended on the names yet.
//
// No DOM, no clock, no randomness. The other top-level names here start with
// `game` or `GAME`, which is the same rule keeping them apart.

import {
  defaultComponents,
  emptyLevel,
  normalizeLevel,
  LEVEL_VERSION,
} from "./contract.js";

/** Bumped when the shape below changes in a way a reader must know about. */
export const GAME_VERSION = 1;

/** More levels than this in one game is a series, not a game. */
export const GAME_MAX_LEVELS = 60;

const gameFinite = (value, fallback) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

/**
 * A level as a game stores one: valid, and without the parts the game owns.
 * `normalizeLevel` fills in a ship, a sprite shelf and a component shelf for
 * anything that lacks them, which is right for a level standing on its own and
 * exactly wrong here -- it would put a second copy of the ship in every level
 * and leave two places to change it. Normalize for validity, then strip.
 */
function gameStripLevel(level) {
  const { player, assets, components, version, ...rest } = normalizeLevel(level);
  void player; void assets; void components; void version;
  return rest;
}

/**
 * A valid Game from whatever was handed over, including a bare Level: a level
 * on its own is a one-level game, which is what every level saved before this
 * becomes. Nothing is invented that the level did not have -- its ship, its
 * assets and its components rise to the game, which is exactly where they
 * were headed.
 *
 * @param {unknown} input
 */
export function normalizeShmupGame(input) {
  const raw = input && typeof input === "object" ? /** @type {Record<string, unknown>} */ (input) : {};
  // A Level has items and no levels; a Game has levels. That is the whole
  // test, and it is what lets a shelf full of levels open as games.
  const asLevel = !Array.isArray(raw.levels) && (Array.isArray(raw.items) || typeof raw.length === "number");
  if (asLevel) {
    const level = normalizeLevel(raw);
    return normalizeShmupGame({
      version: GAME_VERSION,
      name: level.name,
      player: level.player,
      assets: level.assets,
      components: level.components,
      levels: [level],
    });
  }
  const levels = (Array.isArray(raw.levels) ? raw.levels : []).slice(0, GAME_MAX_LEVELS).map(gameStripLevel);
  return {
    version: GAME_VERSION,
    name: typeof raw.name === "string" && raw.name ? raw.name : "Untitled Game",
    // The ship is the game's, following runnjump's hero: a ship that changes
    // between levels of one game is almost never what an author meant.
    player: normalizeLevel({ player: raw.player }).player,
    assets: normalizeLevel({ assets: raw.assets }).assets,
    components: Array.isArray(raw.components) ? normalizeLevel({ components: raw.components }).components : defaultComponents(),
    rules: { lives: Math.max(1, Math.round(gameFinite(/** @type {any} */ (raw.rules)?.lives, 3))) },
    // A game with no levels still opens; it opens on a blank one, which is
    // what a new game is.
    levels: levels.length ? levels : [gameStripLevel(emptyLevel("Sector 1"))],
  };
}

/** A new game, with one blank level in it. */
export function emptyShmupGame(name = "Untitled Game") {
  return normalizeShmupGame({ version: GAME_VERSION, name, levels: [emptyLevel("Sector 1")] });
}

/**
 * One of a game's levels as the engine wants it: a whole, self-contained Level
 * with the game's ship, sprites and components spliced in.
 *
 * This is the join between the two shapes, and the reason the engine did not
 * have to learn about Games. Everything downstream -- `createWorld`, the
 * renderer, an exported level file -- sees exactly what it always saw.
 *
 * @param {ReturnType<typeof normalizeShmupGame>} game
 * @param {number} [index]
 */
export function gameLevel(game, index = 0) {
  const level = game.levels[index];
  if (!level) return null;
  return normalizeLevel({
    ...level,
    version: LEVEL_VERSION,
    player: game.player,
    assets: game.assets,
    components: game.components,
  });
}

/**
 * The other direction: a level put into a game, with everything the game
 * already owns stripped back out of it. An editor saves through this, so the
 * shared parts have exactly one home and a level file dragged in from
 * elsewhere does not quietly fork the ship.
 *
 * @param {ReturnType<typeof normalizeShmupGame>} game
 * @param {number} index
 * @param {object} level
 */
export function gameWithLevel(game, index, level) {
  const rest = gameStripLevel(level);
  const levels = game.levels.slice();
  if (index < 0 || index >= levels.length) levels.push(rest);
  else levels[index] = rest;
  return normalizeShmupGame({ ...game, levels });
}

/** Every level of a game, each self-contained. What an export writes out. */
export function gameLevels(game) {
  return game.levels.map((_level, index) => gameLevel(game, index)).filter(Boolean);
}
