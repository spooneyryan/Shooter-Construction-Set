// What the build actually produced.
//
// This file used to hold two tests inherited from the template Starline was
// scaffolded from. They asserted on a "loading skeleton" page, a
// `react-loading-skeleton` dependency and an `app/_sites-preview/` directory —
// none of which have ever existed in this repository, so both failed from the
// day they arrived and kept failing for reasons nobody had to think about.
// Tests that have never passed teach people to ignore a red suite.
//
// Replaced with the things that are actually worth knowing after a build, and
// in particular the one that a broken dependency would break: the shared
// runtime has to end up inside the bundle. Starline consumes @ccllc/arcade
// from the GameBase feed and bundles it, so if the dependency were missing,
// misnamed, or resolved to something empty, the game would ship without a
// game loop and nothing else here would notice.

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const clientRoot = new URL("../dist/client/", import.meta.url);

/** Every emitted JavaScript chunk, whatever the build hashed them to. */
async function chunks() {
  const dir = new URL("games/starline/_next/static/chunks/", clientRoot);
  const names = await readdir(dir);
  const out = [];
  for (const name of names.filter((n) => n.endsWith(".js"))) {
    out.push(await readFile(new URL(name, dir), "utf8"));
  }
  return out;
}

test("the export produced a real page", async () => {
  const html = await readFile(new URL("index.html", clientRoot), "utf8");
  assert.match(html, /<title>STARLINE Foundry/i);
  assert.match(html, /<canvas/i, "the editor draws to a canvas");
  // A static export with no script is a page that will never do anything.
  assert.match(html, /<script[^>]+src=/i);
});

test("the shared runtime was bundled in", async () => {
  const all = await chunks();
  assert.ok(all.length > 0, "the build emitted no chunks at all");

  // A STRING LITERAL, not a function name. Once bundled, an imported function
  // is a module-local binding and the minifier renames it freely — asserting
  // on `createPerformanceMonitor` fails against a production build even when
  // the code is right there. String literals survive, and this one is the
  // telemetry event @ccllc/arcade's createLoop emits when the simulation falls
  // behind real time, so it can only be present if arcade was bundled in.
  assert.ok(
    all.some((source) => source.includes("loop.overrun")),
    "@ccllc/arcade is missing from the bundle — the dependency did not make it in",
  );
});

test("nothing still refers to the pre-feed package name", async () => {
  const all = await chunks();
  const html = await readFile(new URL("index.html", clientRoot), "utf8");
  for (const source of [...all, html]) {
    assert.doesNotMatch(
      source,
      /@candr\//,
      "a reference to the old @candr scope survived the port to @ccllc",
    );
  }
});

test("the packages really are the ones from the feed", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  for (const name of ["@ccllc/arcade", "@ccllc/studio"]) {
    const spec = manifest.dependencies?.[name];
    assert.ok(spec, `${name} should be a dependency`);
    // A file: specifier means somebody pointed this back at a directory on
    // their machine, which builds locally and then fails for everyone else.
    assert.doesNotMatch(spec, /^file:/, `${name} is a local path: ${spec}`);
  }
  void fileURLToPath(clientRoot);
});

test("the bullet-pattern designer is wired in, and its engine stayed in the package", async () => {
  const all = await chunks();
  // The designer's header copy — a string literal that survives minification,
  // present only if @ccllc/studio's BulletPatternStudio was bundled.
  assert.ok(
    all.some((source) => source.includes("BULLET HELL DESIGNER")),
    "the pattern designer did not make it into the bundle",
  );
  // The intent inherited from the Concepts-era test: the game wires the
  // feature but owns none of its simulation. The engine's public surface must
  // come from the package, so the app source must not re-declare it.
  const game = await readFile(new URL("../app/StarlineGame.tsx", import.meta.url), "utf8");
  assert.match(game, /<BulletPatternStudio/, "the designer is mounted");
  assert.match(game, /kind: "pattern"/, "pattern components are wired");
  assert.doesNotMatch(game, /function advanceBulletPattern/, "the engine belongs to @ccllc/arcade/shmup, not the app");
});
