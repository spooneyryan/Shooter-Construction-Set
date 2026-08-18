// The level a fresh Foundry opens on.
//
// All that is left of `app/sim/` after the move to `@ccllc/arcade/shmup`: the
// library knows what a level *is*, and this is what Starline thinks a good
// first one looks like. Content, not mechanism — which is why it stayed.

import { emptyLevel, makeItem, type Level } from "@ccllc/arcade/shmup";

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
