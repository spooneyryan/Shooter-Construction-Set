// The shortcut table, as a value: the construction-set shell's standard rows
// for everything this set can do, then Starline's own.
//
// The standard table is GameBase docs/SHELL.md §2.2, from
// `@ccllc/arcade/editor`'s `shellBindings`: the chords every construction
// set shares, with the labels and groups the help sheet shows, so a person
// who knows one set finds nothing surprising here. Starline's table already
// agreed with it everywhere -- Ctrl+S, Ctrl+Shift+S, Ctrl+Z, T and Shift+T,
// Esc, D, Delete, Q and E, the arrows, F, F8, P -- so nothing moved; what
// it gains is V for the select tool, the standard labels, and a sheet
// rendered from the same table (`?` or `F1`), which this set never had.
// What is its own -- S for the scroll tool, the number keys for the
// inventory while flying -- sits in groups of its own after the standard.
// Movement and fire are not here: `createInput` owns those codes.

import { shellBindings, type Binding } from "@ccllc/arcade/editor";

export interface StarlineActions {
  /** Building, or flying (playing, paused, game over, victory). */
  mode(): "edit" | "play";
  save(): void;
  duplicateLevel(): void;
  undo(): void;
  redo(): void;
  test(): void;
  present(): void;
  leave(): void;
  deleteSelected(): void;
  duplicateSelected(): void;
  rotate(degrees: number): void;
  nudge(dx: number, dy: number): void;
  selectTool(): void;
  /** Esc while building: the select tool, then the selection let go. */
  deselect(): void;
  scrollTool(): void;
  fullscreen(): void;
  togglePause(): void;
  restart(): void;
  toggleRates(): void;
  toggleHelp(): void;
  equip(slot: number): void;
}

const INVENTORY = ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8", "Digit9"];

export function starlineBindings(actions: StarlineActions): Binding[] {
  const editing = () => actions.mode() === "edit";
  const playing = () => actions.mode() === "play";
  return [
    ...shellBindings({
      mode: actions.mode,
      save: actions.save,
      duplicateDocument: actions.duplicateLevel,
      undo: actions.undo,
      redo: actions.redo,
      deleteSelected: actions.deleteSelected,
      duplicateSelected: actions.duplicateSelected,
      rotate: actions.rotate,
      nudge: actions.nudge,
      selectTool: actions.selectTool,
      deselect: actions.deselect,
      fullscreen: actions.fullscreen,
      test: actions.test,
      present: actions.present,
      leave: actions.leave,
      togglePause: actions.togglePause,
      restart: actions.restart,
      toggleRates: actions.toggleRates,
      toggleHelp: actions.toggleHelp,
    }),
    { code: "KeyS", label: "S", description: "Scroll tool", group: "Tools", when: editing, run: () => actions.scrollTool() },
    { code: INVENTORY, label: "1 – 9", description: "Equip the inventory weapon in that slot", group: "Playing", when: playing, run: (event) => actions.equip(Number(event.code.slice(-1)) - 1) },
  ];
}

/** Flying, for the help sheet: the input layer reads these keys itself. */
export const FLIGHT_KEYS: ReadonlyArray<{ label: string; description: string }> = [
  { label: "Arrows / WASD", description: "Fly" },
  { label: "Space", description: "Fire" },
  { label: "Gamepad", description: "The d-pad or the left stick flies; A, X or the right trigger fires; the right stick aims the satellite; Start pauses" },
];
