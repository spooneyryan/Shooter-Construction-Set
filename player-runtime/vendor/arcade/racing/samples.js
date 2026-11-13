// The two proof games.
//
// "Done" for this module is two raceable tracks rather than a feature list,
// for the reason PLATFORMER.md gave first: a feature list is a thing you can
// finish while the result is unplayable. They are here, as data, because
// that is the claim being tested — **one module, two games, differing in
// data rather than in kind**. If either needed engine work these functions
// could not exist, and the bet would have been wrong.
//
//   sampleStadiumCircuit   the RC Pro-Am shape — a walled dirt-stadium
//                          circuit, a ramp over a pit, a zipper, a puddle
//                          and an oil slick, missiles, bombs, letters and a
//                          motor upgrade on the road, and three computer
//                          trucks that use what they pick up
//   sampleBreakfastTable   the Micro Machines shape — a figure of eight
//                          round a cereal bowl and a juice glass, on a table
//                          whose edge is a drop and whose leaf gap has to be
//                          jumped twice a lap, spilled milk on a corner,
//                          cereal to scatter, no weapons at all
//
// Each returns a raw track DOCUMENT: plain data for `createRace` to
// normalize like anything an author typed. Nothing here is privileged, and a
// game may take one as a starting point and edit it into its own.

import {
  RACING_BOOST,
  RACING_DIRT,
  RACING_HOLE,
  RACING_ICE,
  RACING_OIL,
  RACING_RAMP,
  RACING_SAND,
  RACING_WATER,
} from "./contract.js";

/**
 * RC Pro-Am.
 *
 * A walled circuit of about 4,600 px: the start-finish straight with a ramp
 * over a pit halfway down it, a square corner, the long right-hand side with
 * a zipper before the top hairpin, a dive into the infield and out of a
 * tight U with a puddle on its inside line, a chicane with oil on it, and
 * the corner back onto the straight. The truck's grip is set so that this
 * track has to be braked for: a driver who never lifts is slower round it
 * than one who does, and meets the walls doing it — which the suite asserts.
 */
export function sampleStadiumCircuit() {
  return {
    name: "Stadium Circuit",
    flavour: "circuit",
    feel: "stadium",
    car: "truck",
    route: {
      width: 104,
      verge: 14,
      edge: "wall",
      band: 32,
      resolution: 12,
      nodes: [
        { x: 560, y: 950 }, { x: 1000, y: 950 }, { x: 1420, y: 950 }, { x: 1600, y: 930 },
        { x: 1680, y: 860 }, { x: 1710, y: 720 }, { x: 1710, y: 440 }, { x: 1690, y: 300 },
        { x: 1610, y: 215 }, { x: 1500, y: 200 }, { x: 1400, y: 250 }, { x: 1300, y: 330 },
        { x: 1180, y: 470 }, { x: 1110, y: 580 }, { x: 1040, y: 620 }, { x: 960, y: 590 },
        { x: 900, y: 480 }, { x: 860, y: 320 }, { x: 780, y: 230 }, { x: 640, y: 200 },
        { x: 520, y: 230 }, { x: 440, y: 320 }, { x: 450, y: 430 }, { x: 540, y: 520 },
        { x: 520, y: 620 }, { x: 400, y: 690 }, { x: 270, y: 760 }, { x: 230, y: 870 },
        { x: 330, y: 950 },
      ],
    },
    patches: [
      // The jump: a ramp that launches whatever crosses it fast enough, and
      // the pit beyond it, wall to wall so there is no way round.
      { at: 0.0826, shape: "rect", length: 30, width: 132, surface: RACING_RAMP },
      { at: 0.0965, shape: "rect", length: 90, width: 136, surface: RACING_HOLE },
      // A zipper on the right-hand side, pointing up the track, which
      // arrives at the hairpin faster than anyone would choose to.
      { at: 0.30, shape: "rect", length: 40, width: 44, surface: RACING_BOOST },
      // A puddle on the inside of the infield U, where the racing line goes.
      { at: 0.563, offset: 26, radius: 34, surface: RACING_WATER },
      // Oil at the chicane, a car's width off the centreline.
      { at: 0.81, offset: -18, radius: 16, surface: RACING_OIL },
    ],
    pickups: [
      { kind: "missile", at: 0.2, offset: -22 },
      { kind: "missile", at: 0.62, offset: 18 },
      { kind: "bomb", at: 0.44 },
      { kind: "turbo", at: 0.68 },
      { kind: "bonus", at: 0.14, offset: 30, amount: 250, label: "R" },
      { kind: "bonus", at: 0.33, amount: 250, label: "A" },
      { kind: "bonus", at: 0.52, offset: -20, amount: 250, label: "C" },
      { kind: "bonus", at: 0.92, amount: 250, label: "E" },
      { kind: "upgrade", at: 0.49, stat: "topSpeed", amount: 0.06, label: "MOTOR" },
    ],
    props: [],
    field: [
      { name: "Blaze", skill: 0.96, line: -10, aggression: 0.7, car: { preset: "truck", power: 840 } },
      { name: "Dozer", skill: 0.86, line: 16, aggression: 0.35, car: { preset: "truck", mass: 1.35, power: 800, grip: 780 } },
      { name: "Viper", skill: 0.8, line: 0, aggression: 0.9, car: { preset: "truck", power: 780, topSpeed: 480, grip: 760 } },
    ],
    rules: {
      mode: "race",
      laps: 4,
      qualify: 3,
      weapons: true,
      countdown: 3,
      catchup: 0.35,
      ammo: { missile: 1, bomb: 0 },
      view: { w: 640, h: 360 },
    },
  };
}

/**
 * Micro Machines.
 *
 * A figure of eight on a breakfast table, crossing itself at the middle —
 * one level, so the crossing is a junction and the cars meet there. The left
 * loop runs round the cereal bowl anticlockwise and the right loop round the
 * juice glass clockwise; each loop is a rounded rectangle whose corners sit a
 * car's length from the table's edge, which is a drop. The table is two
 * leaves with a gap between them across the whole of it, so the right loop
 * jumps it twice a lap off a ruler, once in each direction. The route's
 * edges are open — it is a table — so the only thing that keeps a car on the
 * route is its driver, and the leash that puts back a car that wandered too
 * far from it.
 */
export function sampleBreakfastTable() {
  const cereal = [];
  // A line of cereal along the inside of the left loop's top, the way the
  // original marked its borders — pushable, so it scatters when driven into.
  for (let step = 0; step < 9; step += 1) {
    cereal.push({ kind: "cereal", at: 0.70 + step * 0.012, offset: -43, radius: 6, mass: 0.12, tall: 6, drag: 3 });
  }
  // And a handful spilled across the crossing.
  for (const [x, y] of [[700, 470], [780, 530], [730, 560], [800, 440]]) {
    cereal.push({ kind: "cereal", x, y, radius: 6, mass: 0.12, tall: 6, drag: 3 });
  }
  return {
    name: "Breakfast Table",
    flavour: "tabletop",
    feel: "tabletop",
    car: "micro",
    route: {
      width: 72,
      verge: 0,
      edge: "open",
      resolution: 10,
      nodes: [
        { x: 430, y: 780 }, { x: 560, y: 760 }, { x: 660, y: 640 }, { x: 750, y: 500 },
        { x: 840, y: 360 }, { x: 940, y: 240 }, { x: 1040, y: 210 }, { x: 1300, y: 210 },
        { x: 1375, y: 235 }, { x: 1400, y: 310 }, { x: 1400, y: 690 }, { x: 1375, y: 765 },
        { x: 1300, y: 790 }, { x: 1040, y: 790 }, { x: 940, y: 760 }, { x: 840, y: 640 },
        { x: 750, y: 500 }, { x: 660, y: 360 }, { x: 560, y: 240 }, { x: 460, y: 210 },
        { x: 200, y: 210 }, { x: 125, y: 235 }, { x: 100, y: 310 }, { x: 100, y: 690 },
        { x: 125, y: 765 }, { x: 200, y: 790 }, { x: 300, y: 790 },
      ],
    },
    offroad: RACING_DIRT,
    bounds: { x: 40, y: 90, w: 1420, h: 820, beyond: "drop" },
    patches: [
      // The gap between the table's leaves, across the whole table.
      { x: 1080, y: 500, shape: "rect", length: 44, width: 1000, surface: RACING_HOLE },
      // A ruler on each pass, short of the gap in the direction of travel.
      { at: 0.2129, shape: "rect", length: 24, width: 130, surface: RACING_RAMP },
      { at: 0.4877, shape: "rect", length: 24, width: 130, surface: RACING_RAMP },
      // Spilled milk on the outside of the top-right corner, a car's length
      // from the edge; jam on the exit of the top-left one.
      { at: 0.31, offset: -18, radius: 46, surface: RACING_ICE },
      { at: 0.835, offset: 8, radius: 34, surface: RACING_SAND },
    ],
    props: [
      { kind: "bowl", x: 390, y: 500, radius: 100, mass: 0, tall: 60 },
      { kind: "glass", x: 1250, y: 500, radius: 46, mass: 0, tall: 110 },
      { kind: "grape", at: 0.07, offset: 14, radius: 8, mass: 0.35, tall: 16 },
      { kind: "grape", at: 0.56, offset: -16, radius: 8, mass: 0.35, tall: 16 },
      ...cereal,
    ],
    pickups: [],
    field: [
      { name: "Scoot", skill: 0.94, line: 8 },
      { name: "Zip", skill: 0.86, line: -10 },
      { name: "Bolt", skill: 0.8, line: 0 },
    ],
    rules: {
      mode: "race",
      laps: 3,
      qualify: 2,
      weapons: false,
      countdown: 3,
      catchup: 0.2,
      leash: 420,
      target: 3,
      view: { w: 480, h: 270 },
    },
  };
}

/** Both, for a menu that wants to list them. */
export function racingSamples() {
  return [
    { id: "stadium-circuit", label: "Stadium Circuit", flavour: "circuit", build: sampleStadiumCircuit },
    { id: "breakfast-table", label: "Breakfast Table", flavour: "tabletop", build: sampleBreakfastTable },
  ];
}
