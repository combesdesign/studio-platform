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

## State as of 20 Oct 2026
- **Done and tested on master:**
  - client app, studio app, admin app
  - booking engine, demo store
  - Supabase backend (RLS, RPCs, Stripe/Resend functions, Momence import)
  - platform foundation (multi-studio, white-label, admin, onboarding wizard, second demo studio "Harbour Reformer Co.")
- **Feature branches.** Each is a WIP commit, roughly 70–80% written, about 7k lines each, paused at a usage limit:

  | Branch | What's left |
  |---|---|
  | `feat/payroll` | live.ts and SQL tests |
  | `feat/commerce` | gift cards, promos, referrals, stock; finish, test |
  | `feat/marketing` | migration 1200 being applied/tested; edge functions |
  | `feat/appointments` | edge functions; finish, test |

  Each must follow docs/FEATURE-BRIEF.md and the AGENTS.md convention. Only touch your own feature folder and SQL ranges.
- **Platform backlog** (NOTES.md "## platform"):
  - Stripe Connect per studio, so only Snowy can take card payments for now
  - platform billing
  - per-studio app icons
  - custom-domain admin screen
- **Waiting on Pete or Libby:**
  - the Momence export
  - Supabase, Stripe and Resend accounts in Libby's business name
  - whether memberships bill from sign-up or from the first class
  - Apple and Google developer accounts

**Demo.** The clickable demo is published as an Artifact. Pete has the link. It was built from master before the platform work. Republish it after the features merge, from `node build.mjs` dist, landing page in the artifact.

**Sandbox notes:**
- There's no npm registry. `node_modules` is a symlink to `/opt/npm-tools/node_modules` (`ln -sfn …`).
- Postgres 16 for the SQL tests is at /usr/lib/postgresql/16/bin.
- Google Fonts are blocked, which is expected.
- Commit as "Combes Design" <combesdesign@users.noreply.github.com>.
