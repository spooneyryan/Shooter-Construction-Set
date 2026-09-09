// Stages the standalone player's runtime into public/player-runtime/.
//
// An exported game is a folder someone can host or open, and it has to bring
// its own engine. That is possible at all because `@ccllc/arcade` ships as
// plain ES modules with no build step -- the same property its README calls
// out for the import-map games -- so the package's own source runs in a
// browser as-is, behind an import map. `@ccllc/studio`'s render subpath is
// compiled but importless of React, so it comes too; the sprite renderer
// Starline and the player share is compiled here from app/scene.ts.
//
// The staged folder is served statically in dev and in production, which is
// how the editor gets at it: EXPORT fetches these files from its own origin
// and writes them into the zip beside the game. Nothing here is committed --
// it is all derived, and public/player-runtime is ignored.
//
// Run by `npm run dev` and `npm run build`, before either.

import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const out = join(root, "public", "player-runtime");
const vendor = join(out, "vendor");

/**
 * Everything but the parts a browser will never ask for. Hand-listing the
 * directories looked tidier and was wrong: `shmup` re-exports through `burst`,
 * `net` and `patterns`, and the player died on their 404s. The package is
 * source and its modules know their own dependencies, so copy the source.
 */
const ARCADE_SKIP = new Set(["tests", "desktop", "node_modules"]);

/** Every relative import a module makes, so only what is reachable is copied. */
const relativeImports = (source) =>
  [...source.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*from\s*["'](\.[^"']+)["']/g)].map((match) => match[1]);

/** Copy `entry` and everything it reaches through relative imports. */
async function copyReachable(fromFile, toFile, seen = new Set()) {
  if (seen.has(fromFile)) return;
  seen.add(fromFile);
  const source = await readFile(fromFile, "utf8");
  await mkdir(dirname(toFile), { recursive: true });
  await writeFile(toFile, source);
  for (const specifier of relativeImports(source)) {
    const next = resolve(dirname(fromFile), specifier);
    if (!existsSync(next)) continue;
    await copyReachable(next, resolve(dirname(toFile), specifier), seen);
  }
}

/** Every file under `dir`, relative to `base`, with forward slashes. */
async function listFiles(dir, base = dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await listFiles(full, base));
    else found.push(relative(base, full).split("\\").join("/"));
  }
  return found;
}

await rm(out, { recursive: true, force: true });
await mkdir(vendor, { recursive: true });

// The engine, as the source it is.
const arcadeRoot = join(root, "node_modules", "@ccllc", "arcade");
const arcadeDirs = (await readdir(arcadeRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && !ARCADE_SKIP.has(entry.name))
  .map((entry) => entry.name);
for (const dir of arcadeDirs) {
  const from = join(arcadeRoot, dir);
  if (!existsSync(from)) continue;
  await cp(from, join(vendor, "arcade", dir), {
    recursive: true,
    filter: (path) => {
      const inside = relative(from, path);
      return !inside.endsWith(".d.ts") && !inside.split(/[\/]/).includes("node_modules");
    },
  });
}

// Studio's renderer, and only what it reaches.
await copyReachable(
  join(root, "node_modules", "@ccllc", "studio", "dist", "render.js"),
  join(vendor, "studio", "render.js"),
);

// The sprite renderer the editor and the player share, compiled from its TypeScript.
execFileSync("npx", [
  "tsc", "app/scene.ts",
  "--outDir", "public/player-runtime",
  "--module", "esnext", "--target", "es2022",
  "--moduleResolution", "bundler", "--skipLibCheck",
], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });

// The shell, authored by hand beside this script.
await cp(join(root, "build", "player"), out, { recursive: true });

// What EXPORT fetches. Written last so a half-staged folder has no manifest.
const files = (await listFiles(out)).filter((name) => name !== "manifest.json").sort();
await writeFile(join(out, "manifest.json"), JSON.stringify({ files }, null, 2));
console.log(`staged ${files.length} player-runtime files`);
