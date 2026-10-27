# Handoff: read this first in a fresh chat

**Project.** This is the Snowy Pilates Club app, now a multi-studio, white-label "Studio Platform" (a Momence replacement). Pete Combes (designer, Mac, prefers casual, plain-English replies) owns it. His sister Libby runs Snowy Pilates Club in Cooma, which is studio #1.

**Where things live:**
- main branch: `master`
- feature branches: `feat/appointments`, `feat/marketing`, `feat/commerce`, `feat/payroll`
- read next: AGENTS.md (how it all fits, plus the feature-module convention), ROADMAP.md (checklist), NOTES.md (per-area notes), RULES.md (studio policies), docs/ (GO-LIVE, PLATFORM, FEATURE-BRIEF)

## Working rules agreed with Pete (to save usage)
1. **Cheaper models for routine work.** Use subagents with `model: "sonnet"` (or haiku for trivial jobs). Resumed agents can come back on the top model, so for routine work start a fresh sonnet agent rather than resuming an old one.
2. **One feature agent at a time.** Don't run four in parallel.
3. **Light testing per feature:** tsc, `npm test`, `node build.mjs` and `bash supabase/tests/run.sh`, with a short Playwright smoke test and no big screenshot sweeps. Do one proper visual check at the end, after merging.
4. **Priority order:**
   1. Finish the 4 feature branches, one by one.
   2. Merge them into master and run the full test suite.
   3. Get Snowy launch-ready.
   4. Park the rest of B5 (on-demand video, kiosk, family accounts, etc.) until a second studio is actually interested.

## State as of 27 Oct 2026 (afternoon), paused by Pete
- Master is pushed to GitHub (combesdesign/studio-platform). All features merged: everything in ROADMAP phases A/B except Stripe Terminal; plus support, undo, family, locations, spots, Stripe Connect, platform billing/plan gating, web push, Libby's feedback rounds 1 and 2, Momence import for her real export format.
- Small gaps batch done.
- Libby's real Momence exports are in /home/claude/libby-data (NOT in git, real client data). Tidy-up report sent to Pete.
- Next after the gaps: refresh the demo artifact (STUDIO_SLUG=snowy build, landing page in scratchpad spc-demo), independent security review, Capacitor builds, real accounts + Stripe test run.
- Selling later: name, pricing (draft only), switching-guide PDF. Libby's feature rundown PDF was sent 27 Oct.
- Website: timetable strip on branch feat/timetable-strip (pushed, not merged; times from demo data, check with Libby).

**Demo.** The clickable demo is published as an Artifact. Pete has the link. It was built from master before the platform work. Republished 26 Oct from a `STUDIO_SLUG=snowy` build (before online classes/support/marketing/appointments); republish again when convenient.

**Sandbox notes:**
- There's no npm registry. `node_modules` is a symlink to `/opt/npm-tools/node_modules` (`ln -sfn …`).
- Postgres 16 for the SQL tests is at /usr/lib/postgresql/16/bin.
- Google Fonts are blocked, which is expected.
- Commit as "Combes Design" <combesdesign@users.noreply.github.com>.
