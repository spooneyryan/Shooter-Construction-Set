// Do the enemies actually explode with a designed explosion?
//
// The other test file asks what the build produced. This one asks whether the
// feature is true, and it can, because none of it needs a browser: the engine
// runs headless, `app/explosions.ts` is the app's own resolver, and the burst
// module's emitters take any context-shaped object. So this drives the REAL
// world, kills REAL enemies, and pushes the REAL burst requests through the
// real resolver into the real emitter.
//
// It exists because the design rests on an assumption about somebody else's
// code: that the engine's burst `count` separates a chip hit from a death.
// That is true today by inspection of @ccllc/arcade/shmup's call sites, and
// this is what will say so out loud on the day a library upgrade changes it —
// which a screenshot never would, and which the bundle assertions cannot see.
//
// `app/explosions.ts` is imported as TypeScript directly; Node strips the
// types (unflagged from 22.18, and the flag in the test script covers the
// 22.13 floor this package declares).

import assert from "node:assert/strict";
import test from "node:test";
import { createWorld, emptyLevel, idleInput, makeItem, normalizeLevel } from "@ccllc/arcade/shmup";
import { advanceBurst, burstFrame, createBurstRuntime, drawBurst } from "@ccllc/arcade/burst";
import { defaultExplosions, roleForCount, tintedBurst } from "../app/explosions.ts";

/** A context that remembers what was asked of it, like the package's own tests use. */
function recordingContext() {
  const calls = [];
  return {
    calls, globalAlpha: 1, fillStyle: "", strokeStyle: "", lineWidth: 1,
    save() {}, restore() {}, translate() {}, rotate() {},
    beginPath() {}, fill() {}, stroke() {},
    arc(...a) { calls.push(["arc", ...a, this.fillStyle]); },
    fillRect(...a) { calls.push(["fillRect", ...a, this.fillStyle]); },
  };
}

/** Every burst the engine asks for while the player holds fire on a firing line. */
function requestsFromRealPlay() {
  // Where the guns point, asked rather than assumed.
  const gunLine = createWorld(normalizeLevel(emptyLevel("probe"))).state.player.y;
  const level = normalizeLevel({
    ...emptyLevel("Proof"), mode: "horizontal", length: 6000,
    items: [0, 1, 2, 3, 4].map((n) => ({
      ...makeItem("raider", 520 + n * 260, gunLine, () => "foe" + n),
      // The first is tough enough to be chipped before it dies, and armed, so
      // the shield gets something to stop. The rest die in a shot each.
      hitPoints: n === 0 ? 14 : 3,
      movement: { pattern: "stationary", speed: 0, amplitude: 0, frequency: 0 },
      weapon: n === 0
        ? { enabled: true, projectile: "bolt", projectileMovement: "straight", shotsPerSecond: 3, cooldown: 0, projectileSpeed: 260, power: 1 }
        : { enabled: false, projectile: "bolt", projectileMovement: "straight", shotsPerSecond: 1, cooldown: 1, projectileSpeed: 200, power: 1 },
    })),
  });
  const world = createWorld(level);
  const held = { ...idleInput(), fire: true };
  const requests = [];
  for (let tick = 0; tick < 3600 && requests.length < 40; tick += 1) {
    world.step(1 / 120, held);
    for (const burst of world.drainBursts()) requests.push(burst);
    if (world.state.outcome) break;
  }
  return requests;
}

test("the engine's burst counts still separate a chip hit from a death", () => {
  const requests = requestsFromRealPlay();
  assert.ok(requests.length > 0, "the engine asked for no explosions at all — the fixture stopped working");

  const counts = new Set(requests.map((request) => request.count));
  const deaths = requests.filter((request) => roleForCount(request.count) === "blast");
  const chips = requests.filter((request) => roleForCount(request.count) === "spark");
  assert.ok(deaths.length > 0, `nothing mapped to a death; engine counts were {${[...counts].join(", ")}}`);
  assert.ok(chips.length > 0, `nothing mapped to a chip hit; engine counts were {${[...counts].join(", ")}}`);

  // The thresholds are the whole design, so they are asserted rather than
  // trusted: a library change that made a death ask for 9 would land here.
  for (const request of deaths) assert.ok(request.count >= 16, `a death asked for only ${request.count}`);
  for (const request of chips) assert.ok(request.count <= 8, `a chip hit asked for ${request.count}`);
});

test("an enemy dying draws a designed explosion, and it is drawn both ways", () => {
  const set = defaultExplosions();
  const death = requestsFromRealPlay().find((request) => roleForCount(request.count) === "blast");
  assert.ok(death, "no enemy died");

  const document = tintedBurst(set.blast, death.color);
  const runtime = createBurstRuntime(document, death.x, death.y);
  advanceBurst(runtime, 0.12);
  const frame = burstFrame(runtime);

  // The designed blast is five layers; the ad-hoc spray it replaced was one
  // loop of identical squares, so the shape count is the difference itself.
  assert.ok(frame.shapes.length > 20, `a death drew only ${frame.shapes.length} shapes`);

  const smooth = recordingContext();
  drawBurst(smooth, frame);
  assert.ok(smooth.calls.some((call) => call[0] === "arc"), "the vector emitter drew nothing");

  const pixel = recordingContext();
  drawBurst(pixel, frame, { pixelGrid: 4, palette: document.palette });
  const rects = pixel.calls.filter((call) => call[0] === "fillRect");
  assert.ok(rects.length > 0, "the pixel emitter drew nothing");
  assert.equal(pixel.calls.filter((call) => call[0] === "arc").length, 0, "the pixel path must never draw arcs");

  // Whether a rect lands on the grid is the PACKAGE's invariant and is tested
  // there; what is asserted here is only that this app gets a pixel-mode draw
  // at all. The one exception is worth naming rather than hiding: a `shard` is
  // drawn inside a rotation, and @ccllc/arcade/burst 2.0.8-dev.240 snaps its
  // x extent but not its y — so a shard is the one kind that misses the grid.
  // Reported upstream; drop this filter once the module is fixed.
  const snapped = rects.filter(([, , , width, height]) => width === height);
  for (const [, x, y] of snapped) {
    assert.equal(Math.abs(x % 4), 0, `x ${x} is off the grid`);
    assert.equal(Math.abs(y % 4), 0, `y ${y} is off the grid`);
  }
});

test("the world's colour still reaches the designed explosion", () => {
  const set = defaultExplosions();
  // Without this the whole sector explodes in one hue and the engine's only
  // piece of art direction — a cyan shield, a lime bolt — is thrown away.
  const tinted = tintedBurst(set.spark, "#00ff00");
  assert.notEqual(tinted.layers[0].colorFrom, set.spark.burst.layers[0].colorFrom);

  // And a design that asks to keep its own colours is left alone.
  const untouched = tintedBurst({ ...set.blast, tint: 0 }, "#00ff00");
  assert.equal(untouched, set.blast.burst);
});
