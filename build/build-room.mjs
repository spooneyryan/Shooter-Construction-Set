// Builds Starline as a room under the GameBase app, which serves each
// construction set's own build under a path of its own (GameBase
// docs/GAMEBASE-APP.md). The asset prefix is baked in at build time and the
// bundler refuses a relative one, so the room is a second export of the same
// commit with the prefix set to the room's path, laid out so that dist/room/
// is exactly what is served at that path:
//
//   dist/client/index.html            -> dist/room/index.html
//   dist/client/player-runtime/...    -> dist/room/player-runtime/...
//   dist/client/starline/_next/...    -> dist/room/_next/...
//
// The export writes its scripts under the prefix (dist/client/starline/_next)
// and its pages and public files at its root; served from the room's path,
// both have to sit side by side.
import { spawnSync } from "node:child_process";
import { cp, readFile, rm, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const roomPath = process.env.STARLINE_ROOM_PATH ?? "/starline";
if (!/^\/[a-z0-9-]+$/.test(roomPath)) throw new Error(`STARLINE_ROOM_PATH must look like "/starline", not "${roomPath}".`);

const build = spawnSync("npm", ["run", "build"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, STARLINE_ASSET_PREFIX: roomPath },
});
if (build.status !== 0) process.exit(build.status ?? 1);

const client = resolve("dist/client");
const nested = join(client, roomPath.slice(1));
const room = resolve("dist/room");
await stat(join(nested, "_next")).catch(() => {
  throw new Error(`the export did not write its scripts under ${roomPath}/_next; did the prefix reach the build?`);
});

await rm(room, { recursive: true, force: true });
await cp(client, room, {
  recursive: true,
  filter: (source) => {
    const path = relative(client, source);
    return path !== roomPath.slice(1) && !path.startsWith(roomPath.slice(1) + sep);
  },
});
await cp(join(nested, "_next"), join(room, "_next"), { recursive: true });

const page = await readFile(join(room, "index.html"), "utf8");
if (!page.includes(`src="${roomPath}/_next/`)) throw new Error(`dist/room/index.html does not load its scripts from ${roomPath}/_next/`);
await stat(join(room, "player-runtime", "manifest.json"));
console.log(`room written to dist/room, served at ${roomPath}/`);
