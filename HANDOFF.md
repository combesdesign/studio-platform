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

## State as of 4 Nov 2026
- Build is feature-complete for Snowy and the platform. Master is pushed (combesdesign/studio-platform); 280 node tests + full SQL suite pass.
- Done 3-4 Nov: independent security review (docs/SECURITY-REVIEW.md, all high/medium fixed), full QA click-through (docs/QA-PASS.md), Capacitor/app-store prep (docs/APP-STORES.md, icons in resources/), delete-my-account, privacy/terms pages (DRAFT, needs a lawyer), health-notes visibility setting, native push (FCM + APNs), gap sweep.
- Docs for Pete (Claude Docs): Developer Brief, Snowy Switch-Day Checklist, Snowy Accounts Setup Guide. Libby got the feature-rundown PDF and the Studio App Checklist (no answers back yet).
- Everything left needs people: Libby's decisions (billing start, surcharge, health-notes default, online classes in the iPhone app, switch week), real accounts, a developer, a lawyer for privacy/terms, Apple/Google accounts, a platform name.
- Optional build work: Stripe Terminal at the desk.
- Libby's real Momence exports are in /home/claude/libby-data (NOT in git).
- Website: timetable strip on branch feat/timetable-strip (pushed, not merged; check times with Libby).

**Demo.** The clickable demo is published as an Artifact. Pete has the link. It was built from master before the platform work. Republished 26 Oct from a `STUDIO_SLUG=snowy` build (before online classes/support/marketing/appointments); republish again when convenient.

**Sandbox notes:**
- There's no npm registry. `node_modules` is a symlink to `/opt/npm-tools/node_modules` (`ln -sfn …`).
- Postgres 16 for the SQL tests is at /usr/lib/postgresql/16/bin.
- Google Fonts are blocked, which is expected.
- Commit as "Combes Design" <combesdesign@users.noreply.github.com>.
