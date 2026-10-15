# Brief for feature agents (Phase B)

You're building one feature of a multi-studio, Momence-style booking platform. Snowy Pilates Club is studio #1 and Harbour Reformer Co. is a second demo studio.

## Read first
- AGENTS.md, in full. The "How to add a feature" section is your contract.
- RULES.md
- ROADMAP.md
- NOTES.md: the platform, engine, client and studio sections
- src/shared/registry.ts
- src/data/demo/features.ts
- src/data/supabase/features.ts
- Your stub folder in src/features/<name>/

## Rules
- Work only in your own area: `src/features/<name>/**`, your migration number range, your `supabase/tests/<name>_*.sql`, `tests/<name>*.test.ts` and `docs/features/<name>.md`.
- Don't edit core files, src/shared, src/data, or the other features.
- If you need a new registry slot or core hook, write the request under your heading in NOTES.md. Then build the best version you can without it.
- No hard-coded studio names, colours, timezones or currency. Use the studio context, theme CSS variables and format helpers.

## Setup in a git worktree
- `node_modules` isn't checked in. Run `ln -sfn /opt/npm-tools/node_modules node_modules` first.
- There's no npm registry, so don't add dependencies.
- Use your assigned ports so you don't clash with the other agents running at the same time:
  - **Static server:** `python3 -m http.server <PORT> -d dist`
  - **DB tests:** `PGTEST_PORT=<DBPORT> bash supabase/tests/run.sh`

## Quality bar
This is calm, premium and on-brand for each studio. Build both the demo implementation (with realistic seed data for both Snowy and Harbour) and the live implementation (SQL migration with RLS and a cross-studio isolation test, plus the RPCs and live.ts).

**Checks:**
- `npx tsc -p tsconfig.core.json` passes.
- `npm test` passes.
- `node build.mjs` succeeds.
- The DB tests pass.
- A Playwright pass works on `?studio=snowy` and `?studio=harbour`, client at 390 wide and studio at 1024 wide, with zero console errors. Google Fonts failing in the sandbox is expected.
- Look at your screenshots and fix anything that looks off.
- Save the screenshots to `screenshots/<name>/`.

## Finish
1. Write a short summary under `## <name>` in NOTES.md.
2. Tick your items in ROADMAP.md.
3. Commit in your worktree as `git -c user.name="Combes Design" -c user.email="combesdesign@users.noreply.github.com" commit`. End the message with these two lines:
   Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
   Claude-Session: https://claude.ai/code/session_017mr3FXtrAmMgCqLWVZSZfp
4. Reply with a concise summary. Include your branch or worktree name and the commit hash.

Work efficiently. Get it solid and complete rather than gold-plated.
