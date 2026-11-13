// @ccllc/arcade/hud — the heads-up display as a document.
//
// A HUD is a list of readouts in seven slots, a few style tokens and the
// author's own CSS over a DOM with published hooks. `contract` is the
// document, `format` what a readout shows, `css` the stylesheet and the
// rules for author CSS, `view` the DOM, `presets` five to start from, and
// `document` the file format. Presentation only: it lives outside `step`.

export {
  HUD_BAR_READOUTS,
  HUD_FIELD_FIELDS,
  HUD_FIELD_KINDS,
  HUD_ICON_OVERFLOWS,
  HUD_SIZES,
  HUD_SLOTS,
  HUD_STYLE_FIELDS,
  HUD_STYLE_TOKENS,
  HUD_TIME_FORMATS,
  HUD_VERSION,
  emptyHud,
  hudColor,
  hudFont,
  hudSlug,
  hudStyleTokenNames,
  hudTitle,
  newHudField,
  normalizeHudField,
  normalizeHudStyle,
} from "./contract.js";
export {
  hudDelta,
  hudFormatBar,
  hudFormatIcons,
  hudFormatNumber,
  hudFormatText,
  hudFormatTime,
  hudPresent,
  hudSameShown,
} from "./format.js";
export {
  HUD_BASE_CSS,
  HUD_CSS_MAX_BYTES,
  HUD_HOOKS,
  hudCssVariable,
  hudToCss,
  hudTokensToCss,
  sanitizeHudCss,
} from "./css.js";
export { hudToHtml, hudTree, mountHud } from "./view.js";
export { HUD_PRESETS, createHudPreset, hudPresetNames } from "./presets.js";
export { defineHudFormat, newHudDocument, normalizeHud } from "./document.js";
