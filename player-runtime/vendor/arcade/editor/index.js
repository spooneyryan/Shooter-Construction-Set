// The construction-set half of a game, with no opinion about how it is drawn.
//
// Nothing here touches the DOM, React, or a canvas. Pinball binds these to
// imperative DOM and Starline binds them to React state, which is only possible
// because the modules hold no view of their own -- the same rule that lets
// `core` be tested without a browser.
//
// What is NOT here, deliberately: the pointer gesture machine. Both games run
// the same shape -- begin(kind) on pointerdown, update on move, commit on up --
// but Pinball's gestures carry curve control points, triangle vertices and a
// build-level filter while Starline's carry a camera offset, a level-end handle
// and group offsets, and the residue after injecting all of that looked likely
// to cost more in wiring than the duplication costs today. Recorded in
// docs/future.md as a decision to revisit with these three in service, rather
// than guessed at now.

export { createSelection } from "./selection.js";
export {
  fillRegion,
  liftCells,
  paintCell,
  paintLine,
  paintRect,
  readCell,
  stampCells,
} from "./tiles.js";
export { createEditorCommands } from "./commands.js";
export { createKeymap, isTextEntry } from "./keymap.js";
// The construction-set shell's headless half: the one key table and the one
// preferences schema every set shares. docs/SHELL.md is the standard.
export {
  SHELL_DISPLAY_FIELDS,
  SHELL_DOCUMENT_SHORTCUTS,
  SHELL_FILTER_CHOICES,
  SHELL_HOME_COOKIE,
  SHELL_KEY_GROUPS,
  SHELL_RAIL_LIMITS,
  SHELL_SHARED_FIELDS,
  SHELL_SHARED_NAMESPACE,
  SHELL_TEXT_SCALES,
  chordLabel,
  defineShellSettings,
  describeShortcuts,
  keyName,
  keymapConflicts,
  readShellHome,
  shellBindings,
  shellPresenterOptions,
  shellSettingsFields,
} from "./shell.js";
