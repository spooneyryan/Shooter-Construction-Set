// The high-score board: a top-N table that survives a reload.
//
// The arcade classic, as a module instead of the dozen lines every game
// writes badly at 11pm: submit a name and a score, keep the best N in
// order, tell a finishing player whether they made the board BEFORE asking
// for their initials, and never lose the table to one corrupt byte.
//
// The rules that make it feel right are all small and all deliberate:
//
// - **Ties rank the earlier entry first.** Matching the champion does not
//   depose them; the newcomer goes underneath. That is how every cabinet
//   did it, and the other choice makes a stale board churn.
// - **A full board is beaten, not joined.** `rankFor` answers null for a
//   score that only equals the last place on a full table.
// - **The key is the caller's**, exactly as `defineLibrary`'s is, and for
//   the same reason: a shared convention invented here would orphan
//   whatever a game already stored.
// - **Reads never throw and never trust.** A tampered blob comes back as a
//   legal board — clamped, resorted, trimmed — or as an empty one, never
//   as an exception in a render loop.
//
// This is a shelf, not a simulation: it may read the wall clock (through
// an injectable stamp, so tests need not), and it must never be called
// from inside a deterministic `step`. Submit when the run is over.
//
// What is deliberately NOT here: proof. A deterministic game could attach
// a replay to a score and make the claim re-simulable — the idea is
// recorded in docs/future.md, and it waits for a consumer that asks.

import { createReporter } from "./report.js";
import { resolveStorage } from "./storage.js";
import { boundedNumber } from "./validate.js";

/** The shape this module writes. Anything else on the key is clamped in. */
const SCORES_VERSION = 1;

/** Wide enough for any honest game, JSON-safe, and sort-stable. */
const SCORE_RANGE = 1e15;

function isScoresShape(raw) {
  return Boolean(raw) && typeof raw === "object" && !Array.isArray(raw) &&
    raw.version === SCORES_VERSION && Array.isArray(raw.entries);
}

/**
 * @param {object} options
 * @param {string} options.key      Storage key for the board. The caller's.
 * @param {number} [options.limit]  How many places the board has. Default 10.
 * @param {number} [options.nameLength] Longest name kept. Default 12 —
 *        room for a word, not a paragraph; three-initial purists pass 3.
 * @param {string} [options.fallbackName] What an empty or unusable name
 *        becomes. Default "???", the cabinet tradition.
 * @param {Storage|null} [options.storage] Defaults to localStorage, memory
 *        when the browser blocks it. Pass null to force memory.
 * @param {() => string} [options.stamp] Clock for the `at` field, returning
 *        an ISO string. Injectable so tests are exact; defaults to now.
 * @param {"higher" | "lower"} [options.order] Which way is better. "higher"
 *        is a score; "lower" is a time — a best lap, a fastest clear. Every
 *        rule above holds either way round: an equal time still files under
 *        the one set first, and a full board still has to be beaten.
 * @param {{event?: Function} | ((name: string, data?: unknown) => void)} [options.report]
 */
export function defineScoreboard({
  key,
  limit = 10,
  nameLength = 12,
  fallbackName = "???",
  storage,
  stamp,
  order = "higher",
  report,
}) {
  if (!key) throw new Error("A scoreboard needs a storage key.");
  const lowerWins = order === "lower";
  /** Whether `a` beats `b` outright — a tie is not a win, either way round. */
  const beats = (a, b) => (lowerWins ? a < b : a > b);
  const places = Math.max(1, Math.min(100, Math.round(limit) || 1));
  const nameCap = Math.max(1, Math.min(40, Math.round(nameLength) || 1));
  const at = typeof stamp === "function" ? stamp : () => new Date().toISOString();

  const { store, persistent } = resolveStorage(storage);
  const emit = createReporter(report);
  // Reported once, not per write — the library's rule, for the same reason:
  // a board silently going nowhere is worth exactly one event.
  let blockedReported = !persistent;
  if (!persistent) emit("scores.storage-blocked", { key });

  function reportBlocked(during) {
    if (blockedReported) return;
    blockedReported = true;
    emit("scores.storage-blocked", { key, during });
  }

  function clampName(value) {
    const name = typeof value === "string" ? value.trim().slice(0, nameCap) : "";
    return name || fallbackName;
  }

  function clampScore(value) {
    return boundedNumber(value, 0, -SCORE_RANGE, SCORE_RANGE);
  }

  /**
   * Best first — descending by score, ascending by time — and equal scores
   * keep their existing order, which is what puts the earlier entry above the
   * equal newcomer. `sort` alone would do it — the spec made
   * Array.prototype.sort stable — but the intent is load-bearing here, so it
   * is written where it can be read.
   */
  function sortScores(entries) {
    const direction = lowerWins ? 1 : -1;
    return entries
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => (direction * (a.entry.score - b.entry.score)) || (a.index - b.index))
      .map((pair) => pair.entry);
  }

  /** Never throws. A board that cannot be read is an empty board. */
  function readBoard() {
    let raw;
    try {
      const stored = store.getItem(key);
      if (!stored) return [];
      raw = JSON.parse(stored);
    } catch {
      return [];
    }
    if (!isScoresShape(raw)) return [];
    const entries = [];
    for (const row of raw.entries) {
      if (!row || typeof row !== "object") continue;
      entries.push({
        name: clampName(row.name),
        score: clampScore(row.score),
        at: typeof row.at === "string" ? row.at.slice(0, 40) : "",
      });
    }
    // A tampered board comes back legal: ordered and no longer than the
    // table it claims to be.
    return sortScores(entries).slice(0, places);
  }

  function writeBoard(entries) {
    try {
      store.setItem(key, JSON.stringify({ version: SCORES_VERSION, entries }));
      return true;
    } catch {
      reportBlocked("write");
      return false;
    }
  }

  /**
   * The place a score would take, 1-based, or null when it misses the
   * board. This is the "NEW HIGH SCORE #3" moment, answered before the
   * name prompt rather than after.
   */
  function rankFor(score) {
    const value = clampScore(score);
    const entries = readBoard();
    let rank = entries.length + 1;
    for (let index = 0; index < entries.length; index += 1) {
      if (beats(value, entries[index].score)) {
        rank = index + 1;
        break;
      }
    }
    return rank <= places ? rank : null;
  }

  return {
    /** False when the browser blocked storage: the board still works, but
     *  only until the tab closes. Say so in the UI rather than pretending. */
    get available() { return persistent; },

    /** "higher" for scores, "lower" for times — which way this board ranks. */
    get order() { return lowerWins ? "lower" : "higher"; },

    /** The board, best first. A copy — mutate it freely. */
    top(count = places) {
      return readBoard().slice(0, Math.max(0, Math.min(places, Math.round(count) || 0)));
    },

    rankFor,

    /** Whether a score makes the board at all — `rankFor`, as a yes or no. */
    qualifies(score) {
      return rankFor(score) !== null;
    },

    /**
     * Enter a score. Returns `{rank, entry}` when it took a place, null
     * when it missed — a game may call this unconditionally at the end of
     * every run and let the board decide.
     */
    submit(name, score) {
      const rank = rankFor(score);
      if (rank === null) return null;
      const entry = { name: clampName(name), score: clampScore(score), at: at() };
      const entries = readBoard();
      entries.splice(rank - 1, 0, entry);
      writeBoard(entries.slice(0, places));
      return { rank, entry };
    },

    /** Wipe the board. The one destructive call, for a settings screen. */
    clear() {
      return writeBoard([]);
    },
  };
}
