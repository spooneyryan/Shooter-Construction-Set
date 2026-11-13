// The two proof games.
//
// "Done" for this module is two playable courses rather than a feature
// list, for the reason PLATFORMER.md gave first: a feature list is a thing
// you can finish while the result is unplayable. They are here, as data,
// because that is the claim being tested — **one module, two flavours,
// differing in data rather than in kind**. If a flavour needed engine work
// these functions could not exist, and the bet would have been wrong.
//
//   sampleLunarPatrol   the Moon Patrol shape — a bumpy course, craters to
//                       jump, rocks and mines, UFOs overhead, two guns, a
//                       clock and three lives
//   sampleRidgeRun      the ExciteBike/Trials shape — vector ramps, three
//                       gaps that need genuine speed, ice, sand, a boost
//                       pad, and a landing angle that decides everything
//
// Each returns a raw course DOCUMENT: plain data for `createRide` to
// normalize like anything an author typed. Nothing here is privileged, and
// a game may take one as a starting point and edit it into its own.

import { WHEELS_BOOST, WHEELS_ICE, WHEELS_SAND } from "./contract.js";

/**
 * Moon Patrol.
 *
 * The rover is heavy, its springs are long and slow, and it hops — which
 * on a course whose craters are fatal is not a flourish but the verb the
 * whole game is built around. Lunar gravity is a third of the trials
 * course's, so a hop hangs, and the UFOs have that long to be shot.
 */
export function sampleLunarPatrol() {
  return {
    name: "Lunar Patrol",
    flavour: "patrol",
    feel: "moon",
    vehicle: "rover",
    ground: {
      x: 0,
      y: 330,
      resolution: 6,
      segments: [
        { kind: "flat", length: 320 },
        { kind: "bumps", length: 280, rise: 7, count: 3 },
        { kind: "flat", length: 140 },
        { kind: "crater", length: 130, rise: 80 },
        { kind: "flat", length: 200 },
        { kind: "bumps", length: 260, rise: 8, count: 3 },
        { kind: "crater", length: 160, rise: 95 },
        { kind: "flat", length: 180 },
        { kind: "slope", length: 200, rise: -55 },
        { kind: "bumps", length: 260, rise: 9, count: 3 },
        { kind: "crater", length: 150, rise: 90 },
        { kind: "flat", length: 160 },
        { kind: "slope", length: 220, rise: 55 },
        { kind: "bumps", length: 220, rise: 8, count: 2 },
        { kind: "crater", length: 140, rise: 85 },
        { kind: "flat", length: 220 },
        { kind: "crater", length: 175, rise: 100 },
        { kind: "flat", length: 460 },
      ],
    },
    props: [
      { kind: "rock", x: 520, points: 50 },
      { kind: "mine", x: 880 },
      { kind: "ufo", x: 1150, height: 168 },
      { kind: "rock", x: 1420 },
      { kind: "tank", x: 1760 },
      { kind: "ufo", x: 2050, height: 190 },
      { kind: "rock", x: 2280 },
      { kind: "mine", x: 2520 },
      { kind: "ufo", x: 2760, height: 160 },
      { kind: "tank", x: 3040 },
      { kind: "rock", x: 3260 },
    ],
    checkpoints: [900, 1800, 2700],
    rules: { lives: 3, timeLimit: 150, startSpeed: 240, checkpointGrace: 60 },
  };
}

/**
 * The trials course.
 *
 * Three gaps, each wider than the last, each preceded by a ramp — which
 * makes the course a speed exam, because a ramp's lip angle is fixed and
 * the only variable a rider brings to it is how fast they arrive. Ice
 * before the second landing and sand before the third punish the two
 * obvious ways to cheat that: carrying too much speed, and braking late.
 */
export function sampleRidgeRun() {
  return {
    name: "Ridge Run",
    flavour: "trials",
    feel: "earth",
    vehicle: "bike",
    ground: {
      x: 0,
      y: 340,
      resolution: 6,
      segments: [
        { kind: "flat", length: 420 },
        { kind: "hill", length: 180, rise: -30 },
        { kind: "ramp", length: 150, rise: -45 },
        { kind: "pit", length: 200, rise: 300 },
        { kind: "slope", length: 200, rise: 75 },
        { kind: "bumps", length: 260, rise: 9, count: 3 },
        { kind: "slope", length: 160, rise: 45 },
        { kind: "flat", length: 260, surface: WHEELS_BOOST },
        { kind: "ramp", length: 170, rise: -55 },
        { kind: "pit", length: 260, rise: 340 },
        { kind: "slope", length: 220, rise: 75 },
        { kind: "hill", length: 240, rise: -60, surface: WHEELS_ICE },
        { kind: "slope", length: 200, rise: 55 },
        { kind: "flat", length: 220, surface: WHEELS_SAND },
        { kind: "flat", length: 300 },
        { kind: "ramp", length: 180, rise: -60 },
        { kind: "pit", length: 300, rise: 360 },
        { kind: "slope", length: 260, rise: 95 },
        { kind: "bumps", length: 240, rise: 8, count: 3 },
        { kind: "hill", length: 220, rise: -40 },
        { kind: "flat", length: 340 },
      ],
    },
    props: [],
    checkpoints: [1150, 2200, 3300],
    rules: { lives: 99, timeLimit: 0, checkpointGrace: 24, faultPenalty: 3 },
  };
}

/** Both, for a menu that wants to list them. */
export function wheelsSamples() {
  return [
    { id: "lunar-patrol", label: "Lunar Patrol", flavour: "patrol", build: sampleLunarPatrol },
    { id: "ridge-run", label: "Ridge Run", flavour: "trials", build: sampleRidgeRun },
  ];
}
