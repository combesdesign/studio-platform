# Snowy Pilates Club app: build brief

This replaces Momence for **one studio**: Snowy Pilates Club, a mat Pilates studio at 57 Vale St, Cooma NSW. It's owned by Libby and has 4 staff. The goal is to drop a $300/month subscription. It's not a product for other studios, so keep it simple, solid and easy to support.

## Two apps, one codebase
- **Client app** (`/` → `src/client`). This is what clients install on their phones. It's a PWA now and gets wrapped for the App Store and Google Play later with Capacitor, so **no browser-only tricks**. Use hash routing and keep everything mobile-first.
- **Studio app** (`/studio/` → `src/studio`). This is for Libby and the staff, mainly on the front-desk iPad (landscape and portrait), plus laptops and phones.
- Both apps talk **only** to the `DataStore` interface in `src/shared/store.ts`, which is exported as `store` from `src/data`.
  - **Demo** (`src/data/demo`): fake data in localStorage. It's shared across tabs, so you can book in the client app and see it appear in the studio.
  - **Live** (`src/data/supabase`): Supabase plus Stripe.

## Ownership
Don't edit other people's folders. If you need something from another area, write it in `NOTES.md` under your name.

| Area | Owner |
|---|---|
| `src/shared/*`, `src/data/index.ts`, `build.mjs`, `public/*.html`, `RULES.md` | lead (read-only for agents) |
| `src/domain/**`, `src/data/demo/**`, `tests/**` | engine agent |
| `src/client/**`, `public/sw.js` | client agent |
| `src/studio/**` | studio agent |
| `supabase/**`, `src/data/supabase/**`, `docs/GO-LIVE.md` | backend agent |

## The rules
`RULES.md` holds the studio's real booking, cancellation, waitlist and pricing policies. **It is the spec. Read it.**

## Tooling in this sandbox
There's no npm registry access. `node_modules` is a symlink to a shared tools folder that has react 19, react-dom, esbuild, typescript, tsx, playwright, sharp and dayjs. Don't add dependencies. `@supabase/supabase-js` gets stubbed for local builds.

- `node build.mjs` builds into `dist/`, with client at `dist/index.html` and studio at `dist/studio/index.html`.
- `npm test` runs node:test via tsx, for `tests/*.test.ts`.
- `npx tsc -p tsconfig.core.json` is a strict typecheck of shared/domain/data/tests. React files aren't typechecked because there are no @types/react, so be careful in TSX.
- To serve dist for Playwright, run `python3 -m http.server 4173 -d dist` (in the background), then open `http://localhost:4173/` and `http://localhost:4173/studio/`.
- Playwright: `import { chromium } from 'playwright'` works from a `.mjs` script in this folder. Chromium is preinstalled. Don't run `playwright install`.

## Design
Calm, airy, premium boutique, like Housed or a Framer template. Don't make it look like a generic SaaS dashboard.

- Use the tokens in `src/shared/theme.css`.
  - Colours: navy `#5069AC`, ink `#24345F`, sky `#85A2D1`, mist `#EEF2F9`, cream `#F2E6C6`, bg `#FAF8F3`.
  - Fonts: Instrument Serif for headings (italic `<em>` in sky for an accent word), Questrial for body.
  - **No pink.**
- Brand assets:
  - `public/brand/logo.svg`, `logo-white.svg` (wordmark)
  - `flower.svg`, `flower-white.svg` (the flower mark, a nice stand-in for icons and empty states)
  - Team photos in `public/img/` (libby, julia, grace-t, grace-p .webp) and studio photos (portrait, square, wide .webp)
- Tap targets are at least 44px. Text is at least 14px. Keep copy friendly and plain, in Australian English, sentence case.
- Paths are relative: client assets are `brand/...`, studio assets are `../brand/...`. Or compute them from `document.baseURI`.

## Done means
- It builds.
- Your tests and Playwright run-through pass.
- Screenshots are checked by you.
- There's a short summary of what you built and any gaps, written to `NOTES.md` under your heading.
