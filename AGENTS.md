# AGENTS.md

Orientation for coding agents working in this repository. Read this before
editing; it records the decisions that are not visible from any single file.

## What this is

**STARLINE Foundry** — a side-scrolling space-shooter construction set: a level
editor and the game that plays those levels, in one page. Build, tune, save,
and playtest custom sectors; levels live in `localStorage` and travel as
export files / share links. There is no server component at runtime: the whole
game is one `"use client"` React component, statically exported.

- Package name: `starline-sector-runner`. Node `>= 22.13.0`.
- Framework: [vinext](https://github.com/cloudflare/vinext) (Next.js App
  Router running on Vite) at `1.0.0-beta.2`, React 19, TypeScript, Tailwind 4
  (imported, but nearly all styling is hand-written CSS in
  `app/globals.css`).
- Deploys as a **static export** (`output: "export"` in `next.config.ts`)
  staged under `/games/starline/` on an Azure Static Web Apps "arcade"
  alongside sibling games. `STARLINE_ASSET_PREFIX` and `STARLINE_PUBLIC_URL`
  override the baked-in defaults at build time.
- The Cloudflare Worker (`worker/index.ts`), D1/Drizzle wiring (`db/`,
  `drizzle.config.ts`, `.openai/hosting.json`), and `examples/d1/` are
  scaffolding inherited from the vinext-starter template. The game uses none
  of it — `db/schema.ts` is intentionally empty. Leave the scaffolding intact
  unless a feature actually needs a database.

## Commands

```bash
npm run dev          # local development (vinext dev)
npm run build        # static export into dist/
npm test             # builds, then node --test tests/rendered-html.test.mjs
npm run lint         # eslint (flat config, type-aware, react + a11y + next)
npm run db:generate  # drizzle-kit generate — only relevant if db/schema.ts gains tables
```

`npm test` asserts on the **built output** in `dist/client/` (title, canvas,
bundled chunks), so it always runs a build first and takes correspondingly
long. Tests and lint both pass at baseline; keep them that way.

Two lint accommodations are deliberate and documented where they live:
`jsx-a11y/label-has-associated-control` runs with `depth: 3` (in
`eslint.config.mjs`) because the Inspector's label idiom nests its text one
level deeper than the rule's default search budget, and the draft restore in
`StarlineGame` carries one scoped `react-hooks/set-state-in-effect` disable
because its post-mount setState is the hydration-correct two-phase load, not
an accident. Follow the same pattern if you hit a genuine false positive:
narrowest possible suppression, with the why alongside it.

## CI/CD

[azure-pipelines.yml](azure-pipelines.yml) builds and deploys Starline to its
**own Azure Static Web App** (Free tier — the export is pure static files, so
there is no server for an App Service to run). Every pushed `master`/`dev*`
branch builds: feed auth (`npmAuthenticate`), `npm ci`, lint, then `npm test`
with `STARLINE_ASSET_PREFIX` set **empty** — this deployment serves the site
root, not the arcade's `/games/starline/`, and the post-build tests read the
same variable so they verify the layout actually shipped. A follow-up step
asserts `dist/client/_next` exists in case the empty variable ever fails to
reach the build. On `master` only, the Deploy stage uploads the prebuilt
`dist/client` via `AzureStaticWebApp@0` using a **secret pipeline variable
`SWA_DEPLOYMENT_TOKEN`** (from the SWA's "Manage deployment token").
`PLACEHOLDER-` values (public URL, environment name) must be filled in; PR
validation comes from a branch policy, not YAML. The earlier arcade-tenant
design — publish a `/games/starline/` overlay artifact and wake the shared
arcade deploy — lives in git history at `224cb96` if the game rejoins the
arcade.

## The private feed

`@ccllc/arcade` and `@ccllc/studio` come from a private Azure DevOps npm feed
(`GameBase`), mapped in `.npmrc`. Credentials live in the user-level
`~/.npmrc`, never in the repo. Two hard rules, both enforced by tests:

- Never point these dependencies at a local path (`file:`) — it builds on one
  machine and breaks everywhere else.
- The old `@candr/` scope is dead; no reference to it may survive in source
  or bundle.

If `npm install` fails on the `@ccllc` scope, the feed token is missing or
expired — that is an environment problem, not a code problem. Say so rather
than working around it.

## Vendored: @electricblazor/react

Starline's editor chrome comes from `@electricblazor/react` where a component
fits: the tool panels' collapsible sections (`EbAccordion` /
`EbAccordionItem`), the palette's OBJECTS/COMPONENTS switch (`EbTabbedCard`),
the Inspector's number fields (`EbNumericInput`, text-only mode), and the
destructive confirms (`EbDialog`). The suite's color pickers were evaluated
for the hue-tint fields and deliberately not adopted: they pick *colors*
(RgbColor), while tint is a hue *rotation* — a picker whose swatch shows a
color the game will never render is worse than the slider. The package is the
React port of the user's ElectricBlazor suite, which lives at
`C:\Users\sledz\source\ElectricBlazor\ElectricBlazor\react` and publishes to
an Azure DevOps feed in a *different* organization (MorrisonHotel). That feed
rejected authentication at integration time and the package is not on npmjs,
so the dependency is a **committed tarball**
(`vendor/electricblazor-react-0.9.2.tgz`, MIT) — reproducible for CI and
other machines, which a `file:` path into a sibling checkout is not. To
update: `npm pack --pack-destination <this repo>/vendor` in the port's
directory, then `npm install ./vendor/<new>.tgz` here. If the MorrisonHotel
feed becomes reachable, the better arrangement is a scoped registry line in
`.npmrc` plus a cross-organization service connection for `npmAuthenticate`
in the pipeline — then delete `vendor/`.

Integration rules: import components from `@electricblazor/react`, load its
`styles.css` once (layout.tsx) and never its `theme.css` — the `--eb-*`
token bridge in `globals.css` maps the suite's token contract onto Starline's
palette, and appearance overrides go through the suite's stable public class
names (`.eb-card-header`, `.eb-card-title`, …) scoped under `.workspace`.
Prefer an ElectricBlazor component over hand-rolling a new UI element when
one fits.

## Architecture: three owners, one game

The core discipline of this codebase is **what lives where**. Starline was
the donor for much of the shared library, and the extraction boundary is
maintained deliberately:

| Owner | Owns | Lives in |
|---|---|---|
| `@ccllc/arcade` (`shmup`, `core`, `platform`, …) | The level model, `normalizeLevel`/`normalizeBulletPattern`, the deterministic world simulation, damage, bullet-pattern engine, game loop, undo history, input action maps, perf monitoring | node_modules (feed) |
| `@ccllc/studio` | Authoring UI: `SpriteStudio` (raster + vector editors), `BulletPatternStudio`; plus `@ccllc/studio/render`, the React-free drawing routines for saved sprite assets | node_modules (feed) |
| **This repo** | Wiring and presentation: the editor shell (palette, inspector, tools, selection, dialogs), the canvas renderer and its built-in artwork, particles/stars, persistence in `localStorage`, keyboard/pad bindings | `app/` |

Consequences you must respect:

- **Do not re-implement engine logic in the app.** A test fails if
  `app/StarlineGame.tsx` declares `function advanceBulletPattern` — the
  simulation belongs to the package. If a feature needs new engine behavior,
  that is a change to `@ccllc/arcade` (a different repository), and the right
  move here is to say so, not to fork the logic locally.
- **The world never draws and never calls back.** `world.step(dt, input)`
  advances state; the renderer reads `world.state` and answers requests like
  `world.drainBursts()` with whatever effects it likes. Keep that direction.
- **Determinism is load-bearing.** The simulation runs a fixed 120 Hz step
  (`SIM_STEP`), with no `Math.random`, no `Date.now`, no wall-clock cooldowns
  inside it — that is what makes replays and future lockstep multiplayer
  possible. Anything that affects *what happens* must stay deterministic (use
  the `trig` helpers from `@ccllc/arcade/core` if you need sim-side
  trigonometry). Anything that is *only presentation* — particles, screen
  shake, star parallax — is explicitly allowed to use `Math` and
  `Math.random`, and does.
- **Normalize anything imported.** Levels, patterns, and sprite assets from
  files or share links go through `normalizeLevel` / `normalizeBulletPattern`
  / `normalizeAssets` before being trusted.

## Key files

- [app/StarlineGame.tsx](app/StarlineGame.tsx) — the entire game and editor
  (~1,200 lines, deliberately one file). Rough map: types/constants and the
  `ACTIONS` input map at the top; module-level draw helpers (`drawSprite`,
  `drawShip`); then the `StarlineGame` component — state (with refs mirroring
  state the loop needs), editor callbacks, the keyboard shortcut effect, the
  main loop-and-render effect, and finally the JSX shell.
- [app/starter-level.ts](app/starter-level.ts) — the level a fresh Foundry
  opens on. Content, not mechanism; that is why it survived the library
  extraction.
- [app/page.tsx](app/page.tsx) — the single route, `force-static` so the
  static export includes it.
- [app/layout.tsx](app/layout.tsx) — metadata/social cards; note the
  relative card URL reasoning in its comment.
- [app/globals.css](app/globals.css) — all UI styling: dark theme, CSS
  variables (`--ink`, `--lime`, `--cyan`, `--panel`, …), flat class names
  (`.topbar`, `.palette-item`, …). New UI should use these variables and the
  existing class idiom, not Tailwind utility soup.
- [tests/rendered-html.test.mjs](tests/rendered-html.test.mjs) — post-build
  assertions. When asserting that bundled code contains something, match a
  **string literal** that survives minification, never a function name.
- [build/sites-vite-plugin.ts](build/sites-vite-plugin.ts) — copies
  `.openai/hosting.json` and `drizzle/` into `dist/.openai` after build.
- [future.md](future.md) — the planning backlog **and its process**, below.
- localStorage keys: `starline-level-library-v1` (saved levels),
  `starline-level-draft-v1` (autosaved draft).

## The future.md process

`future.md` is the design record, with rules stated in its header:

- Active ideas get sequential `F-` numbers. **Adding an idea records it; it
  does not authorize implementation.** Do not build an `F-` item unless the
  user asks for it.
- Completed items move to the **Completed Features** archive as `C-` entries,
  and the vacated `F-` numbers are reused to keep both sections compact.
- The `C-` entries double as the specification of shipped features — consult
  them before changing editor behavior they describe.

## Conventions

- **Comments explain why, and carry history.** The house style is prose:
  what a thing replaced, why the obvious alternative was rejected ("This used
  to read the request `host`…", "`assetPrefix`, not `basePath`: …"). Match
  it. Do not add comments that narrate what the next line does.
- **Compact code.** Single-line state declarations, dense JSX, minimal
  ceremony. Follow the density of the surrounding code rather than
  reformatting it.
- **Branches:** `master` is the trunk; day-to-day work happens on `dev` /
  `dev-claude`. Commit to the current branch; do not push or merge without
  being asked.
- Vite/Wrangler tool state stays project-local (`.wrangler/`, configured in
  `vite.config.ts`); application environment belongs in ignored `.env*`
  files.

## Gotchas

- `next.config.ts` uses `assetPrefix`, **not** `basePath` — vinext's
  prerender fetch breaks under a `basePath` ("RSC handler returned 404").
  The comment in that file is the authority; don't "fix" it.
- `app/page.tsx` must keep `export const dynamic = "force-static"` — the
  build-time classifier cannot prove a pure-client route is static, and
  without it the export silently skips the page.
- The built page lands at `dist/client/index.html` with assets under
  `dist/client/games/starline/_next/…` — that split is what the arcade's
  deploy staging expects.
- `npm --prefix` from outside the project can corrupt `package.json` with a
  self-referencing `file:` dependency (see the arcade README). Run npm from
  the repo root.


## Product standard

Build exemplary code

- clean, readable, and lightweight

- highly reusable

- fairly highly configurable without becoming feature-heavy

- comparable in quality and polish to Telerik, but intentionally leaner

- browser-compatible by default

- CSS that is very well organized and thoughtfully implemented


If user says he has some ideas for later, flesh them out and add them to a file called future.md. Create it if need be.

Favor simple, durable abstractions over large option surfaces. Every component should be easy to understand, easy to consume, and safe to ship.

## Ending a work session

A **work session** ends whenever you finish what was asked and go idle waiting for the next
prompt &mdash; not only at the end of a large multi-slice request.
After every turn, whenever a notable chunk of work was done, add an entry to journal.md. Create it if need be.
  
Make this a habit rather than something to be asked for each time:

1. **Commit.** Never go idle on an uncommitted working tree. Unattended changes are easy for another session to trip over, and sessions here run in parallel worktrees.
2. **Merge the work to `dev-claude`**, the branch that collects finished session work. Create it if it does not exist yet (`git branch dev-claude` from the current tip, then push it).
3. `dev-claude` lives in the **primary checkout**, not in a session's own worktree under `.claude/worktrees/`. Merge outward into it; do not leave the work stranded on the session branch, and do not treat the copy inside a worktree as the real one.

Prefer a rebase onto `dev-claude`'s tip before pushing, so the branch keeps a linear history when several sessions land on it. A plain fast-forward needs no rebase. Never force-push it - another session's work is likely sitting there.

- **Commits here can reach `origin` without an explicit push.** Tooling outside the session has been observed pushing branches and rebasing `Main-RELEASE` onto a session's commit. Check the server with `git ls-remote --heads origin` rather than trusting local refs, and never tell the user something is unpushed without looking.

- **Pushing `Main-RELEASE` publishes.** It is the pipeline's trigger, so it packs every NuGet project and pushes with skip-duplicate, publishes `@electricblazor/react` to the npm registry (skipped when the feed already has that version), and redeploys both demo sites. Land session work on `dev-claude`, and treat a `Main-RELEASE` push as a deliberate release.

Close every work session with the block below, after any other comments. Bold each heading, keep one blank line between sections, and leave the `[[SUMMARY]]` marker unbolded on its own line. Length guidance is in the template; stay within it.

`Things You Have To Do` is for work that only the user can carry out — credentials, approvals, machine configuration, anything outside the repository. `Git Status` reports the actual state of the working tree: branch, whether anything was committed, and what is left uncommitted.
  

[[SUMMARY]]

**What Got Done:** 1-4 sentences.
--
**What Didn't Get Done:** 1-3 sentences.
--
**What I Suggest Doing Next:** 1-4 sentences.
--
**Things You Have To Do:** 1-4 sentences.
--
**Git Status:** 1-3 sentences.
--