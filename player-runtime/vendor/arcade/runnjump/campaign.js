// A campaign: the game's levels in order, with lives and score carried
// across them. Thin on purpose — the stage owns everything about a run, and
// this owns only what survives between runs. Pacing (a "WORLD 1-2" card, a
// game-over screen, whether retry is automatic) belongs to the app, which
// is why `advance` and `retry` are calls rather than things that happen.

import { createStage } from "./world.js";

/**
 * @param {object} game A game, already normalized.
 * @param {object} [options]
 * @param {number} [options.players]
 */
export function createCampaign(game, { players = 1 } = {}) {
  const state = {
    stageIndex: 0,
    lives: game.rules.lives,
    score: 0,
    /** null while playing; "victory" past the last level; "gameover" out of lives. */
    result: /** @type {null | "victory" | "gameover"} */ (null),
  };
  let stage = createStage(game, { levelIndex: 0, players, lives: state.lives, score: 0 });

  return {
    game,
    state,
    get stage() {
      return stage;
    },
    /** Steps the current stage; returns its outcome (null while live). */
    step(dt, inputs) {
      stage.step(dt, inputs);
      return stage.state.outcome;
    },
    /**
     * After a cleared stage: bank the run, move to the next level. Returns
     * the new stage, or null when that was the last one (`result` becomes
     * "victory").
     */
    advance() {
      state.score = stage.state.score;
      state.lives = stage.state.lives;
      if (state.stageIndex + 1 >= game.levels.length) {
        state.result = "victory";
        return null;
      }
      state.stageIndex += 1;
      const previousPlayers = stage.state.players;
      stage = createStage(game, {
        levelIndex: state.stageIndex,
        players,
        lives: state.lives,
        score: state.score,
      });
      for (const [index, player] of stage.state.players.entries()) {
        const old = previousPlayers[index]; if (!old) continue;
        for (const key of ["equipment", "satEquipment"]) if (old[key]) player[key] = JSON.parse(JSON.stringify(old[key]));
        if (old.defenseId) { player.defenseId = old.defenseId; const defense = game.defenses?.find((entry) => entry.id === old.defenseId); player.shield = defense?.type === "forcefield" ? defense.capacity : 0; player.shieldWait = 0; }
      }
      return stage;
    },
    /**
     * After a failed stage: spend a life and run the same level again, from
     * the checkpoint if one was touched. Returns the new stage, or null when
     * the lives are gone (`result` becomes "gameover").
     */
    retry() {
      state.lives = stage.state.lives - 1;
      if (state.lives < 0) {
        state.result = "gameover";
        return null;
      }
      const previousPlayers = stage.state.players;
      stage = createStage(game, {
        levelIndex: state.stageIndex,
        players,
        lives: state.lives,
        score: state.score,
        checkpoint: stage.state.checkpoint,
      });
      for (const [index, player] of stage.state.players.entries()) {
        const old = previousPlayers[index]; if (!old) continue;
        for (const key of ["equipment", "satEquipment"]) if (old[key]) player[key] = JSON.parse(JSON.stringify(old[key]));
        if (old.defenseId) { player.defenseId = old.defenseId; const defense = game.defenses?.find((entry) => entry.id === old.defenseId); player.shield = defense?.type === "forcefield" ? defense.capacity : 0; player.shieldWait = 0; }
      }
      return stage;
    },
  };
}
