// A track's property panels, as data.
//
// Every value an editor can show a control for has a row here, in the
// `core/fields` shape, so a panel is walked rather than hand-written — and so
// no panel ever shows a control for a value the normalizer would drop on
// save, which is the failure the Platformer's parity plan named twice. The
// numbers come from the contract's own range tables where it has them; where
// its bounds are written inline, a test writes every row's minimum, maximum
// and options through a save and checks each survives.
//
// Paths are relative to the object a panel edits: a car's rows read a car, a
// patch's rows read a patch. What is not here is not a field: ids, which the
// normalizer owns; the lists, which an editor draws; checkpoints, which are
// dragged; and sounds and sprites, which have designers of their own.

import { defineFields } from "../core/fields.js";
import {
  RACING_CAR_PRESETS,
  RACING_CAR_RANGES,
  RACING_DECOR_LAYERS,
  RACING_EDGES,
  RACING_FEEL_PRESETS,
  RACING_FEEL_RANGES,
  RACING_FLAVOURS,
  RACING_MODES,
  RACING_PATCH_SHAPES,
  RACING_PICKUP_KINDS,
  RACING_POLES,
  RACING_RULE_RANGES,
  RACING_SURFACES,
  RACING_UPGRADE_STATS,
  RACING_VIEWS,
} from "./contract.js";

/**
 * A surface code is a whole number, 0 to 9; `RACING_SURFACES` names each.
 * @type {{type: "integer", min: number, max: number, help: string}}
 */
const RACING_SURFACE_ROW = { type: "integer", min: 0, max: 9, help: "A surface code: tarmac 0, grass 1, dirt 2, ice 3, oil 4, water 5, sand 6, boost 7, ramp 8, hole 9." };

/** The three ways a thing is placed, each shown only for the way it is. */
const racingByNode = (item) => typeof item?.node === "string";
const racingByLap = (item) => !racingByNode(item) && item?.at !== undefined;
const racingInWorld = (item) => !racingByNode(item) && item?.at === undefined;

/** @type {import("../core/fields.js").FieldGroupSpec} */
const RACING_PLACEMENT_GROUP = {
  title: "Placement",
  fields: [
    { key: "node", type: "reference", refKind: "node", label: "After node", maxLength: 24, when: racingByNode, help: "The node it is anchored to; it moves when that stretch does." },
    { key: "along", label: "Past the node", min: -200000, max: 200000, step: 1, unit: " px", when: racingByNode },
    { key: "at", label: "Round the lap", min: 0, max: 0.9999, step: 0.0001, decimals: 4, when: racingByLap, help: "A fraction of the lap from the start line." },
    { key: "offset", label: "Right of the line", min: -20000, max: 20000, step: 1, unit: " px", when: (item) => racingByNode(item) || racingByLap(item) },
    { key: "x", label: "X", min: -100000, max: 100000, step: 1, unit: " px", when: racingInWorld },
    { key: "y", label: "Y", min: -100000, max: 100000, step: 1, unit: " px", when: racingInWorld },
  ],
};

/** The track as a whole: its name and flavour, the defaults new nodes take, and the world's edge. */
export const RACING_TRACK_FIELDS = defineFields([
  {
    title: "Track",
    fields: [
      { key: "name", type: "text", label: "Name", maxLength: 80, fallback: "Untitled Track" },
      { key: "flavour", type: "enum", label: "Flavour", options: RACING_FLAVOURS, help: "Which game's defaults: a walled circuit or an open table." },
      { key: "offroad", ...RACING_SURFACE_ROW, label: "Offroad", fallback: 1 },
    ],
  },
  {
    title: "New nodes",
    fields: [
      { key: "routeWidth", path: "route.width", label: "Road width", min: 8, max: 2000, step: 1, unit: " px", fallback: 90 },
      { key: "routeVerge", path: "route.verge", label: "Verge", min: 0, max: 2000, step: 1, unit: " px", fallback: 16 },
      { key: "routeEdgeLeft", path: "route.edge.left", type: "enum", label: "Left edge", options: RACING_EDGES },
      { key: "routeEdgeRight", path: "route.edge.right", type: "enum", label: "Right edge", options: RACING_EDGES },
      { key: "routeSurface", path: "route.surface", ...RACING_SURFACE_ROW, label: "Surface", fallback: 0 },
      { key: "routeBand", path: "route.band", label: "Wall thickness", min: 16, max: 2000, step: 1, unit: " px", fallback: 32 },
      { key: "routeResolution", path: "route.resolution", label: "Sample spacing", min: 2, max: 200, step: 1, unit: " px", fallback: 12, help: "How finely the built road is sampled. Smaller is smoother and slower." },
    ],
  },
  {
    title: "World edge",
    when: (track) => Boolean(track?.bounds),
    fields: [
      { key: "boundsX", path: "bounds.x", label: "Left", min: -100000, max: 100000, step: 1, unit: " px" },
      { key: "boundsY", path: "bounds.y", label: "Top", min: -100000, max: 100000, step: 1, unit: " px" },
      { key: "boundsW", path: "bounds.w", label: "Width", min: 32, max: 200000, step: 1, unit: " px", fallback: 1000 },
      { key: "boundsH", path: "bounds.h", label: "Height", min: 32, max: 200000, step: 1, unit: " px", fallback: 1000 },
      { key: "boundsBeyond", path: "bounds.beyond", type: "enum", label: "Beyond it", options: ["wall", "drop"], help: "A drop is a table's edge." },
    ],
  },
]);

/** One route node: where it is, how wide the road is there, and the stretch that starts at it. */
export const RACING_NODE_FIELDS = defineFields([
  {
    title: "Node",
    fields: [
      { key: "x", label: "X", min: -100000, max: 100000, step: 1, unit: " px" },
      { key: "y", label: "Y", min: -100000, max: 100000, step: 1, unit: " px" },
      { key: "width", label: "Road width", min: 8, max: 2000, step: 1, unit: " px", fallback: 90 },
      { key: "verge", label: "Verge", min: 0, max: 2000, step: 1, unit: " px", fallback: 16 },
    ],
  },
  {
    title: "The stretch from here",
    fields: [
      { key: "edgeLeft", type: "enum", label: "Left edge", options: RACING_EDGES },
      { key: "edgeRight", type: "enum", label: "Right edge", options: RACING_EDGES },
      { key: "surface", ...RACING_SURFACE_ROW, label: "Surface", fallback: 0 },
    ],
  },
]);

/** A patch of different ground. */
export const RACING_PATCH_FIELDS = defineFields([
  {
    title: "Patch",
    fields: [
      { key: "surface", ...RACING_SURFACE_ROW, label: "Surface", fallback: 5 },
      { key: "shape", type: "enum", label: "Shape", options: RACING_PATCH_SHAPES },
      { key: "angle", label: "Angle", min: -3600, max: 3600, step: 1, unit: "°", help: "From the road's direction, or from east for one placed in the world. Zippers and ramps act along it." },
      { key: "radius", label: "Radius", min: 1, max: 4000, step: 1, unit: " px", fallback: 30, when: (patch) => patch?.shape === "circle" },
      { key: "length", label: "Length", min: 1, max: 8000, step: 1, unit: " px", fallback: 40, when: (patch) => patch?.shape === "rect" },
      { key: "width", label: "Width", min: 1, max: 8000, step: 1, unit: " px", fallback: 40, when: (patch) => patch?.shape === "rect" },
    ],
  },
  RACING_PLACEMENT_GROUP,
]);

/** A pickup. */
export const RACING_PICKUP_FIELDS = defineFields([
  {
    title: "Pickup",
    fields: [
      { key: "kind", type: "enum", label: "Kind", options: RACING_PICKUP_KINDS, fallback: "bonus" },
      { key: "amount", label: "Amount", min: 0, max: 100000, step: 0.01, help: "Rounds, seconds of turbo, points, or an upgrade's fraction." },
      { key: "stat", type: "enum", label: "Improves", options: RACING_UPGRADE_STATS, when: (pickup) => pickup?.kind === "upgrade" },
      { key: "respawn", label: "Back after", min: 0, max: 600, step: 0.1, unit: " s", help: "Zero is once per race." },
      { key: "label", type: "text", label: "Label", maxLength: 12, help: "A letter or a word for the renderer." },
    ],
  },
  RACING_PLACEMENT_GROUP,
]);

/** A solid prop. */
export const RACING_PROP_FIELDS = defineFields([
  {
    title: "Prop",
    fields: [
      { key: "kind", type: "text", label: "Kind", maxLength: 24, fallback: "block" },
      { key: "radius", label: "Radius", min: 1, max: 2000, step: 1, unit: " px", fallback: 10 },
      { key: "mass", label: "Mass", min: 0, max: 1000, step: 0.05, help: "Zero never moves." },
      { key: "tall", label: "Height", min: 0, max: 4000, step: 1, unit: " px", fallback: 20, help: "A car in the air above it passes over." },
      { key: "bounce", label: "Bounce", min: 0, max: 1, step: 0.05, fallback: 0.4 },
      { key: "drag", label: "Rolling drag", min: 0, max: 60, step: 0.1, unit: " /s", fallback: 2.5 },
      { key: "sprite", type: "reference", refKind: "sprite", label: "Sprite", maxLength: 60 },
    ],
  },
  RACING_PLACEMENT_GROUP,
]);

/** A decoration: seen, never hit. */
export const RACING_DECOR_FIELDS = defineFields([
  {
    title: "Decoration",
    fields: [
      { key: "kind", type: "text", label: "Kind", maxLength: 24, fallback: "scenery" },
      { key: "shape", type: "enum", label: "Shape", options: RACING_PATCH_SHAPES },
      { key: "angle", label: "Angle", min: -3600, max: 3600, step: 1, unit: "°" },
      { key: "radius", label: "Radius", min: 1, max: 8000, step: 1, unit: " px", fallback: 20, when: (item) => item?.shape === "circle" },
      { key: "length", label: "Length", min: 1, max: 20000, step: 1, unit: " px", fallback: 40, when: (item) => item?.shape === "rect" },
      { key: "width", label: "Width", min: 1, max: 20000, step: 1, unit: " px", fallback: 40, when: (item) => item?.shape === "rect" },
      { key: "layer", type: "enum", label: "Drawn", options: RACING_DECOR_LAYERS, help: "Under the cars or over them." },
      { key: "color", type: "color", label: "Colour", fallback: "#8a8f98" },
      { key: "sprite", type: "reference", refKind: "sprite", label: "Sprite", maxLength: 60 },
      { key: "tall", label: "Height", min: 0, max: 4000, step: 1, unit: " px", help: "For a three-quarter view." },
    ],
  },
  RACING_PLACEMENT_GROUP,
]);

/** The feel: the world's physics, as opposed to a car's. */
export const RACING_FEEL_FIELDS = defineFields([
  { title: "Preset", fields: [{ key: "preset", type: "enum", label: "Preset", options: Object.keys(RACING_FEEL_PRESETS) }] },
  {
    title: "The world",
    fields: [
      { key: "gravity", label: "Gravity", step: 10, unit: " px/s²", help: "Pulls on height only: how long a jump hangs." },
      { key: "maxSpeed", label: "Speed limit", step: 10, unit: " px/s" },
      { key: "maxYaw", label: "Spin limit", step: 0.5, unit: " rad/s" },
      { key: "substeps", type: "integer", label: "Substeps", help: "Not taste: nothing may cross half a wall in one." },
    ],
  },
  {
    title: "Contact",
    fields: [
      { key: "wallBounce", label: "Wall bounce", step: 0.05 },
      { key: "wallFriction", label: "Wall friction", step: 0.05 },
      { key: "carBounce", label: "Car bounce", step: 0.05 },
    ],
  },
  {
    title: "Timing",
    fields: [
      { key: "spinTicks", type: "integer", label: "Spin-out", unit: " ticks" },
      { key: "fallTicks", type: "integer", label: "Fall", unit: " ticks" },
      { key: "respawnGrace", type: "integer", label: "Ghost after respawn", unit: " ticks" },
      { key: "turboTicks", type: "integer", label: "Turbo", unit: " ticks" },
      { key: "wrongWayTicks", type: "integer", label: "Wrong way after", unit: " ticks" },
    ],
  },
  {
    title: "Camera",
    fields: [
      { key: "cameraAhead", label: "Lead", step: 0.05, unit: " s" },
      { key: "cameraEase", label: "Ease", step: 0.5, unit: " /s" },
    ],
  },
], { ranges: RACING_FEEL_RANGES });

/** A car: the track's, or a computer driver's. */
export const RACING_CAR_FIELDS = defineFields([
  {
    title: "Car",
    fields: [
      { key: "preset", type: "enum", label: "Preset", options: Object.keys(RACING_CAR_PRESETS) },
      { key: "name", type: "text", label: "Name", maxLength: 60 },
      { key: "livery", type: "color", label: "Livery", fallback: "#ff5a4f" },
      { key: "sprite", type: "reference", refKind: "sprite", label: "Sprite", maxLength: 60 },
    ],
  },
  {
    title: "Body",
    fields: [
      { key: "length", label: "Length", step: 1, unit: " px", help: "At least its width." },
      { key: "width", label: "Width", step: 1, unit: " px" },
      { key: "wheelbase", label: "Wheelbase", step: 1, unit: " px", help: "At most its length." },
      { key: "balance", label: "Weight on the front", step: 0.01 },
      { key: "mass", label: "Mass", step: 0.05 },
      { key: "inertia", label: "Inertia", step: 0.05 },
      { key: "bounce", label: "Bounce", step: 0.05 },
    ],
  },
  {
    title: "Engine and brakes",
    fields: [
      { key: "power", label: "Power", step: 10, unit: " px/s²", help: "From a standstill, fading to nothing at top speed." },
      { key: "topSpeed", label: "Top speed", step: 5, unit: " px/s" },
      { key: "braking", label: "Braking", step: 10, unit: " px/s²" },
      { key: "reverse", label: "Reverse", step: 0.05, help: "As a share of power and top speed." },
      { key: "drive", label: "Front drive", step: 0.05, help: "The front axle's share: 0 is rear drive." },
      { key: "drag", label: "Air drag", step: 0.0001, decimals: 4 },
    ],
  },
  {
    title: "Steering and grip",
    fields: [
      { key: "steer", label: "Lock", step: 1, unit: "°" },
      { key: "steerRate", label: "Turn rate", step: 5, unit: " °/s" },
      { key: "steerFade", label: "Lock halves at", step: 10, unit: " px/s" },
      { key: "grip", label: "Grip", step: 10, unit: " px/s²", help: "The most sideways acceleration an axle holds on tarmac." },
      { key: "rearGrip", label: "Rear grip", step: 0.05 },
      { key: "cornering", label: "Cornering", step: 0.5 },
      { key: "handbrake", label: "Handbrake", step: 0.05, help: "The rear's grip while it is held." },
      { key: "transfer", label: "Weight transfer", step: 0.01 },
    ],
  },
], { ranges: RACING_CAR_RANGES });

/** A computer driver's character; its car is a car. */
export const RACING_DRIVER_FIELDS = defineFields([
  {
    title: "Driver",
    fields: [
      { key: "name", type: "text", label: "Name", maxLength: 40 },
      { key: "skill", label: "Skill", min: 0, max: 1, step: 0.01, fallback: 0.85 },
      { key: "line", label: "Line", min: -2000, max: 2000, step: 1, unit: " px", help: "Shift of its racing line to the right." },
      { key: "aggression", label: "Aggression", min: 0, max: 1, step: 0.01, fallback: 0.5 },
    ],
  },
]);

/** The rules, with the rows that only one mode reads shown only for it. */
export const RACING_RULE_FIELDS = defineFields([
  {
    title: "Race",
    fields: [
      { key: "mode", type: "enum", label: "Mode", options: RACING_MODES },
      { key: "laps", type: "integer", label: "Laps", help: "0 races for ever." },
      { key: "qualify", type: "integer", label: "Finish in the top", when: (rules) => rules?.mode === "race" },
      { key: "pole", type: "enum", label: "At the front", options: RACING_POLES },
      { key: "countdown", type: "integer", label: "Countdown", unit: " s" },
      { key: "timeLimit", label: "Time limit", step: 1, unit: " s", help: "0 is none." },
      { key: "catchup", label: "Catch-up", step: 0.05 },
      { key: "leash", type: "integer", label: "Put back beyond", unit: " px", help: "Past the road; 0 never." },
    ],
  },
  {
    title: "Weapons",
    fields: [
      { key: "weapons", type: "boolean", label: "Weapons" },
      { key: "ammoMissile", path: "ammo.missile", type: "integer", label: "Missiles at the start", min: 0, max: 99 },
      { key: "ammoBomb", path: "ammo.bomb", type: "integer", label: "Bombs at the start", min: 0, max: 99 },
    ],
  },
  {
    title: "Elimination",
    when: (rules) => rules?.mode === "elimination",
    fields: [
      { key: "target", type: "integer", label: "Points to win" },
      { key: "roundDelay", label: "Pause between rounds", step: 0.1, unit: " s" },
      { key: "viewW", path: "view.w", label: "View width", min: 64, max: 20000, step: 1, unit: " px", fallback: 640 },
      { key: "viewH", path: "view.h", label: "View height", min: 64, max: 20000, step: 1, unit: " px", fallback: 360 },
    ],
  },
], { ranges: RACING_RULE_RANGES });

/** How the track looks: a view, a colour per surface, and the chrome. */
export const RACING_LOOK_FIELDS = defineFields([
  {
    title: "Look",
    fields: [
      { key: "view", type: "enum", label: "View", options: RACING_VIEWS },
      { key: "background", type: "color", label: "Background" },
      { key: "wall", type: "color", label: "Walls" },
      { key: "kerb", type: "color", label: "Kerbs" },
      { key: "music", type: "text", label: "Music", maxLength: 400, help: "A URL, or a name in the game's own list." },
    ],
  },
  {
    title: "Surfaces",
    fields: Object.keys(RACING_SURFACES).map((code) => ({
      key: `surface${code}`,
      path: `surfaces.${code}`,
      type: "color",
      label: RACING_SURFACES[Number(code)].name[0].toUpperCase() + RACING_SURFACES[Number(code)].name.slice(1),
    })),
  },
]);
