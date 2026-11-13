// A property panel as data.
//
// Pinball's `TUNING_FIELDS` and this package's own `SFX_FIELDS` are the same
// idea arrived at twice: a list of sections, each holding fields with a label,
// a path, a range, a step and a unit, rendered by walking it. Starline has no
// schema at all — its Inspector is hand-written JSX, one control at a time, and
// every new field on a weapon or an armour type is another hand-written block.
//
// So the shape exists, proven, in two places, and the third is where the pain
// is. `docs/future.md` held this back until there were two real samples rather
// than one and a guess; there are now three, counting the pattern designer's
// Basic tab.
//
// DELIBERATELY NARROW. Numbers, integers, enums, booleans, colours and short
// strings — and nothing else. Pinball's inspector also carries group
// synchronisation, per-part conditional sections and a live preview that writes
// as you drag; Starline's carries nested weapon, armour and satellite editors.
// A schema that expressed all of that would not be a schema any more. This
// covers the plain fields, which is most of the rows and none of the hard part,
// and a renderer is free to hand-write anything it does not fit.
//
// It renders NOTHING. `core` has no DOM and this is not where that changes:
// two renderers over one schema is the whole point, an imperative one for the
// games with no bundler and a React one in @ccllc/studio.

import { boundedNumber, boundedInteger, hexColor, oneOf, snapped, asBoolean, boundedString } from "./validate.js";

/**
 * @typedef {object} FieldSpec
 * @property {string} key Identifier, and the default path into the document.
 * @property {string} [path] Dotted path, when the value does not live at `key`.
 *        `"weapon.damage"` reads and writes `document.weapon.damage`.
 * @property {string} label
 * @property {"range"|"integer"|"enum"|"boolean"|"color"|"text"|"vector2"|"reference"} [type]
 *        Defaults to `"range"`, which is what most rows are. `vector2` is an
 *        `{x, y}` pair bounded per component — a spawn point, a waypoint.
 *        `reference` is a string id into a list of definitions the RENDERER
 *        resolves at draw time (see `refKind`); the schema clamps it as a
 *        bounded string, because which ids exist is the document's business,
 *        not the schema's.
 * @property {number} [min] Required for range and integer unless `range` supplies it.
 * @property {number} [max]
 * @property {number} [step] Slider granularity. Also snaps the value.
 * @property {number} [decimals] How many to show. Display only.
 * @property {string} [unit] Appended to the displayed value, verbatim — the
 *        leading space in `" oct/s"` is deliberate and belongs to the unit.
 * @property {number|string|boolean} [fallback] What a garbage value becomes.
 *        Defaults to the minimum for a number, the first option for an enum.
 *        Supplied by the `ranges` table when one is given, since that table
 *        already carries the document's own default.
 * @property {readonly string[]} [options] For `enum`.
 * @property {number} [maxLength] For `text`.
 * @property {string} [refKind] For `reference`: which definition list the
 *        renderer should offer — "actor", "tileset", "pattern", "sprite",
 *        "animation", or anything a host recognises. Data for the renderer;
 *        the schema itself never resolves it.
 * @property {string} [help]
 * @property {(document: any) => boolean} [when] Conditional visibility. A
 *        function rather than a data predicate because the one real sample --
 *        "duty cycle applies only to a square wave" -- is a comparison, and a
 *        data language for comparisons is a language.
 */

/**
 * @typedef {object} FieldGroupSpec
 * @property {string} title
 * @property {FieldSpec[]} fields
 * @property {(document: any) => boolean} [when]
 */

const TYPES = new Set(["range", "integer", "enum", "boolean", "color", "text", "vector2", "reference"]);

/** Read a dotted path. Missing intermediate objects read as undefined. */
export function readPath(document, path) {
  if (!document || !path) return undefined;
  let node = document;
  for (const part of String(path).split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = node[part];
  }
  return node;
}

/**
 * Write a dotted path, creating plain objects along the way.
 *
 * Mutates. Callers here are already working on a draft they cloned — every
 * designer in this repository does `structuredClone` then mutate then commit —
 * and a version that returned a new document would make each of them clone
 * twice.
 */
export function writePath(document, path, value) {
  if (!document || !path) return document;
  const parts = String(path).split(".");
  let node = document;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (node[part] === null || typeof node[part] !== "object") node[part] = {};
    node = node[part];
  }
  node[parts[parts.length - 1]] = value;
  return document;
}

/**
 * Normalize a schema: fill in defaults, resolve paths, index by key.
 *
 * @param {FieldGroupSpec[]} groups
 * @param {object} [options]
 * @param {Record<string, readonly [number, number, number?]>} [options.ranges]
 *        `[min, max, default?]` per key, for a schema whose ranges live
 *        elsewhere. This is exactly the shape `SFX_RANGES` already has, and the
 *        reason it is supported rather than requiring min/max inline: that
 *        table is the synth's own, it is what clamps the document, and copying
 *        the numbers into the presentation schema is how the two drift.
 */
export function defineFields(groups, { ranges = {} } = {}) {
  const normalized = (Array.isArray(groups) ? groups : []).map((group) => ({
    title: String(group?.title ?? ""),
    when: typeof group?.when === "function" ? group.when : null,
    fields: (Array.isArray(group?.fields) ? group.fields : []).map((field) => {
      const key = String(field?.key ?? "");
      const bounds = ranges[key];
      const type = TYPES.has(field?.type) ? field.type : "range";
      return {
        key,
        path: String(field?.path ?? key),
        label: String(field?.label ?? key),
        type,
        min: field?.min ?? bounds?.[0],
        max: field?.max ?? bounds?.[1],
        fallback: field?.fallback ?? bounds?.[2],
        step: field?.step,
        decimals: field?.decimals,
        unit: field?.unit ?? "",
        options: field?.options ? [...field.options] : undefined,
        maxLength: field?.maxLength,
        refKind: typeof field?.refKind === "string" ? field.refKind : undefined,
        help: field?.help ?? "",
        when: typeof field?.when === "function" ? field.when : null,
      };
    }),
  }));

  const byKey = new Map();
  for (const group of normalized) {
    for (const field of group.fields) byKey.set(field.key, field);
  }
  const all = normalized.flatMap((group) => group.fields);

  return {
    groups: normalized,
    /** Every field, ungrouped, for a renderer laying them out its own way. */
    all,
    field(key) {
      return byKey.get(key);
    },

    /** Does this field apply to the document as it currently stands? */
    applies(field, document) {
      const spec = typeof field === "string" ? byKey.get(field) : field;
      if (!spec) return false;
      return spec.when ? Boolean(spec.when(document)) : true;
    },

    /** The groups and fields that apply, for rendering a panel in one pass. */
    visible(document) {
      return normalized
        .filter((group) => (group.when ? group.when(document) : true))
        .map((group) => ({
          ...group,
          fields: group.fields.filter((field) => (field.when ? field.when(document) : true)),
        }))
        .filter((group) => group.fields.length > 0);
    },

    /** The document's current value for a field. */
    read(document, key) {
      const spec = typeof key === "string" ? byKey.get(key) : key;
      return spec ? readPath(document, spec.path) : undefined;
    },

    /**
     * Coerce and clamp a raw value the way this field's type says to.
     *
     * The reason a schema is worth having at all: an inspector that reads
     * `event.target.value` is holding a string, and every hand-written control
     * in both games converts it separately. One of them will forget.
     */
    coerce(key, raw) {
      const spec = typeof key === "string" ? byKey.get(key) : key;
      if (!spec) return raw;
      // NOTE the argument order throughout: core/validate takes the fallback
      // SECOND, not last. Every one of these reads wrong at a glance and is
      // right; getting it backwards produces a clamp to the fallback rather
      // than to the range, which is a plausible-looking value and a silent one.
      const min = spec.min ?? 0;
      const max = spec.max ?? 1;
      const fallback = spec.fallback ?? min;
      switch (spec.type) {
        case "integer":
          return boundedInteger(raw, Math.round(fallback), min, max);
        case "enum":
          return oneOf(raw, spec.options ?? [], spec.fallback ?? spec.options?.[0] ?? "");
        case "boolean":
          return asBoolean(raw, Boolean(spec.fallback));
        case "color":
          return hexColor(raw, typeof spec.fallback === "string" ? spec.fallback : "#000000");
        case "text":
          return boundedString(
            raw,
            typeof spec.fallback === "string" ? spec.fallback : "",
            spec.maxLength ?? 80,
          );
        case "reference":
          // An id, clamped as a string. Whether it names a definition that
          // exists is the document's business -- the same division as the
          // level normalizers, which keep unknown defIds and let the stage
          // skip them, so an id does not vanish because its target is
          // momentarily deleted mid-edit.
          return boundedString(raw, typeof spec.fallback === "string" ? spec.fallback : "", spec.maxLength ?? 80);
        case "vector2": {
          const source = raw && typeof raw === "object" ? raw : {};
          const fallbackPair = spec.fallback && typeof spec.fallback === "object"
            ? spec.fallback
            : { x: min, y: min };
          return {
            x: boundedNumber(source.x, fallbackPair.x ?? min, min, max),
            y: boundedNumber(source.y, fallbackPair.y ?? min, min, max),
          };
        }
        case "range":
        default:
          // Snapped to the step, so the value stored is one the slider can
          // actually return to. Without it, typing 0.333 into a 0.01-step
          // control leaves a value the slider rounds away the next time it is
          // touched, and the document silently changes for a click that moved
          // nothing. `snapped` clamps as well, so this is one call and not two.
          return spec.step
            ? snapped(raw, fallback, min, max, spec.step)
            : boundedNumber(raw, fallback, min, max);
      }
    },

    /** Coerce, then write it into the document. Mutates; see `writePath`. */
    apply(document, key, raw) {
      const spec = typeof key === "string" ? byKey.get(key) : key;
      if (!spec) return document;
      return writePath(document, spec.path, this.coerce(spec, raw));
    },

    /**
     * How this field's current value should read on screen.
     *
     * Here rather than in each renderer because it is where the drift was:
     * `decimals` and `unit` are presentation, both games invented them
     * separately, and three of twenty-five disagreed before anybody compared.
     */
    format(document, key) {
      const spec = typeof key === "string" ? byKey.get(key) : key;
      if (!spec) return "";
      const value = readPath(document, spec.path);
      if (spec.type === "boolean") return value ? "on" : "off";
      if (spec.type === "vector2" && value && typeof value === "object") {
        return `${value.x ?? 0}, ${value.y ?? 0}`;
      }
      if (typeof value !== "number") return `${value ?? ""}`;
      const shown = spec.decimals === undefined ? String(value) : value.toFixed(spec.decimals);
      return `${shown}${spec.unit}`;
    },
  };
}
