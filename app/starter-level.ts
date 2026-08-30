// The levels a fresh Foundry ships with.
//
// All that is left of `app/sim/` after the move to `@ccllc/arcade/shmup`: the
// library knows what a level *is*, and this is what Starline thinks good ones
// look like. Content, not mechanism — which is why it stayed.
//
// One sample per mode, and each is written in that mode's own terms. An item's
// x is always distance along the level and its y position across it; what
// those mean to the eye is the mode's business. In the arena, x is *when* and
// y is a bearing — 0 east, 160 south, 320 west, 480 north, wrapping at 640.

import { emptyLevel, makeItem, type Level } from "@ccllc/arcade/shmup";

/** The horizontal opener a fresh Foundry starts on. */
export function defaultLevel(): Level {
  return {
    ...emptyLevel("First Contact"),
    length: 9000,
    items: [
      makeItem("veeGroup", 1050, 300),
      makeItem("asteroid", 1720, 130),
      makeItem("asteroid", 1980, 520),
      makeItem("brute", 2440, 315),
      makeItem("lineGroup", 3380, 320),
      makeItem("gunship", 4300, 170),
      makeItem("gunship", 4520, 470),
      makeItem("overdrive", 5050, 320),
      makeItem("ringGroup", 5580, 315),
      makeItem("asteroid", 6900, 390),
      makeItem("brute", 7420, 220),
      makeItem("veeGroup", 8050, 340),
      makeItem("planet", 3100, 160),
      makeItem("wreck", 6500, 500),
    ],
  };
}

/**
 * The vertical sample: a climb through falling terrain into a carrier finale.
 * The playfield is the 640 square, so y runs 0..640 exactly as the editor
 * strip shows it; the screen's flanks are rails.
 */
export function skyfallRun(): Level {
  return {
    ...emptyLevel("Skyfall Run"),
    mode: "vertical",
    length: 7200,
    items: [
      makeItem("veeGroup", 900, 320),
      makeItem("asteroid", 1500, 150),
      makeItem("asteroid", 1800, 480),
      makeItem("asteroid", 2100, 210),
      makeItem("planet", 2400, 120),
      makeItem("gunship", 2600, 210),
      makeItem("gunship", 2900, 430),
      makeItem("powerCore", 3300, 320),
      makeItem("lineGroup", 3800, 320),
      makeItem("wraith", 4400, 180),
      makeItem("wraith", 4550, 460),
      makeItem("nebula", 4800, 520),
      makeItem("brute", 5000, 160),
      makeItem("brute", 5150, 320),
      makeItem("brute", 5300, 480),
      makeItem("overdrive", 5700, 320),
      makeItem("ringGroup", 6100, 320),
      makeItem("raider", 6450, 140),
      makeItem("raider", 6520, 500),
      makeItem("carrier", 6800, 320),
    ],
  };
}

/**
 * The twin-stick sample: waves converge from the compass points while the
 * right stick — or the mouse — aims the guns. Here x is when a wave arrives
 * and y where around the edge it comes from.
 */
export function nullPointArena(): Level {
  const level = {
    ...emptyLevel("Null Point Arena"),
    mode: "arena" as const,
    length: 6200,
    items: [
      makeItem("scout", 500, 0),
      makeItem("scout", 560, 160),
      makeItem("scout", 620, 320),
      makeItem("scout", 680, 480),
      makeItem("raider", 1400, 80),
      makeItem("raider", 1450, 240),
      makeItem("raider", 1500, 400),
      makeItem("raider", 1550, 560),
      makeItem("powerCore", 2000, 100),
      makeItem("gunship", 2500, 0),
      makeItem("gunship", 2600, 320),
      makeItem("lineGroup", 3200, 160),
      makeItem("wraith", 3900, 80),
      makeItem("wraith", 3980, 400),
      makeItem("overdrive", 4400, 300),
      makeItem("brute", 4900, 0),
      makeItem("carrier", 5000, 480),
      makeItem("brute", 5100, 320),
    ],
  };
  // The arena rewards presence over pace: the sample ships with the satellite
  // escort on, so the second stick has something to show for itself even
  // before the player finds the aim.
  level.player = { ...level.player, satellite: { ...level.player.satellite, enabled: true } };
  return level;
}

/** What the LOAD menu offers under SAMPLES, in the order it offers them. */
export const starterLevels: { key: string; name: string; build: () => Level }[] = [
  { key: "first-contact", name: "First Contact", build: defaultLevel },
  { key: "skyfall-run", name: "Skyfall Run", build: skyfallRun },
  { key: "null-point-arena", name: "Null Point Arena", build: nullPointArena },
];
