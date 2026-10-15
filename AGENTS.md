# Studio Platform: build brief

This started as the Momence replacement for **Snowy Pilates Club** (a mat Pilates studio at 57 Vale St, Cooma NSW, owned by Libby, 4 staff). It is now a **multi-studio, white-label platform**: Snowy is studio #1 and must keep working (and looking) exactly as before, and Pete can add more studios, each with its own look, data and staff. Keep it simple, solid and easy to support.

## Three apps, one codebase
- **Client app** (`/` → `src/client`). What clients install on their phones. It's a PWA now and gets wrapped for the App Store and Google Play later with Capacitor, so **no browser-only tricks**. Hash routing, mobile-first.
- **Studio app** (`/studio/` → `src/studio`). For owners and staff, mainly on a front-desk iPad (landscape and portrait), plus laptops and phones. New studios get an onboarding wizard (`#/welcome`).
- **Platform admin** (`/admin/` → `src/admin`). For Pete only (platform admins): every studio, create one, branding with a live preview, invite the owner, suspend. Neutral "Studio Platform" look.
- Every app boots through `src/shared/boot.tsx`: it works out **which studio** (below), binds the data store to it, applies its branding, then loads the app.
- The apps talk **only** to the `DataStore` interface in `src/shared/store.ts`, exported as `store` from `src/data` (bound to the current studio), plus `platform` (`PlatformStore`: the studio directory, sign-in across studios, admin).
  - **Demo** (`src/data/demo`): every studio's fake data in one localStorage key (`spc-demo-v4`), shared across tabs.
  - **Live** (`src/data/supabase`): Supabase plus Stripe. Every request sends an `x-studio` header; RLS and RPCs only see that studio.

### Which studio (src/shared/resolve.ts)
1. Build config: `STUDIO_SLUG=snowy node build.mjs` makes a single-studio build (no picker, no switching). This is what Snowy deploys.
2. Subdomain of `PLATFORM_DOMAIN` (`harbour.studioplatform.app`), or a custom domain listed on the studio.
3. `#/s/<slug>` or `?studio=<slug>` in the address.
4. The last studio this device used.
5. Otherwise: the client app shows "Find your studio"; the studio app shows the studios you're staff at.

### Branding (src/shared/branding.ts)
A studio's `StudioBranding` (colours, Google fonts, logo, mark, photos, phrases, welcome copy, app name) becomes CSS variables at runtime (`applyBranding`). Snowy's config is `src/data/studios/snowy.ts`; the second demo studio is `src/data/studios/harbour.ts`. **Never hard-code a studio's name, town, timezone, colours or photos in shared, client, studio or feature code.** Read them from `useApp().studio` / `useStudio().studio`, `getBranding()`, or the format helpers (`src/shared/format.ts` uses the current studio's timezone, locale, currency and tax).

## Ownership
Don't edit other people's folders. If you need something from another area, write it in `NOTES.md` under your name.

| Area | Owner |
|---|---|
| `src/shared/*`, `src/data/index.ts`, `src/data/studios/*`, `src/admin/*`, `build.mjs`, `public/*.html`, `RULES.md`, `src/features/*.ts` (the four aggregator files) | lead / platform (read-only for agents) |
| `src/domain/**`, `src/data/demo/**`, `tests/**` | engine agent |
| `src/client/**`, `public/sw.js` | client agent |
| `src/studio/**` | studio agent |
| `supabase/**`, `src/data/supabase/**`, `docs/GO-LIVE.md` | backend agent |
| `src/features/appointments/**`, `supabase/migrations/11xx_*`, `supabase/tests/appointments_*` | appointments agent |
| `src/features/marketing/**`, `supabase/migrations/12xx_*`, `supabase/tests/marketing_*` | marketing agent |
| `src/features/commerce/**` (gift cards, promos), `supabase/migrations/13xx_*`, `supabase/tests/commerce_*` | commerce agent |
| `src/features/payroll/**`, `supabase/migrations/14xx_*`, `supabase/tests/payroll_*` | payroll agent |

Feature agents also own `tests/<feature>*.test.ts` and `docs/features/<feature>.md` if they need them.

## How to add a feature
Everything for a feature lives in `src/features/<name>/`. Core files (main/app.tsx, screens, `src/shared`, `src/data`) are **not edited**: you plug in through hooks and registries. The four feature folders already exist (`appointments`, `marketing`, `commerce`, `payroll`) with empty stubs, and are already imported by the aggregators, so you only fill in your own folder.

```
src/features/<name>/
  types.ts           your types + the store interface, added to DataStore.features
  permissions.ts     registerPermissions({...}): your '<name>.<action>' staff permissions
  demo.ts            registerDemoFeature(...): the demo implementation (+ seed data per studio)
  live.ts            registerLiveFeature(...): the Supabase implementation
  client/index.tsx   client app UI: registerClientTab / Route / ProfileEntry / Slot
  studio/index.tsx   studio app UI: registerStudioNav / Route / SettingsTab / TodayWidget / Slot
```
The aggregators that import them (lead-owned, one line per feature): `src/features/demo.ts` (loaded by the demo store), `src/features/live.ts` (live store), `src/features/client.ts` (client app), `src/features/studio.ts` (studio app).

### 1. The store: `types.ts`
```ts
export interface Slot { id: string; startsAt: string; staffId: string; booked: boolean }
export interface AppointmentsStore {
  listSlots(day: string): Promise<Slot[]>;
  bookSlot(id: string): Promise<Slot>;
}
declare module '../../shared/store' {
  interface FeatureStores { appointments: AppointmentsStore }
}
```
The apps call it as `store.features.appointments` (from `import { store } from '../../../data'`). It's `undefined` until your demo/live file registers it, so UI checks `if (!store.features.appointments) return null;`.

### 2. Permissions: `permissions.ts`
```ts
import { registerPermissions } from '../../domain/permissions';
registerPermissions({ 'appointments.manage': ['owner', 'manager'], 'appointments.view': ['owner', 'manager', 'front_desk', 'instructor'] });
```
Names must look like `<feature>.<action>`. `can(role, 'appointments.manage')` works everywhere, the registries' `perm` field takes them, and the demo/live contexts' `requireStaff('appointments.manage')` enforces them. Mirror the same rule in your SQL (`app.has_role_in(studio_id, 'owner', 'manager')`).

### 3. Demo: `demo.ts` (`src/data/demo/features.ts`)
```ts
import './permissions';
import { registerDemoFeature } from '../../data/demo/features';
interface Slice { slots: Slot[] }
registerDemoFeature({
  name: 'appointments',
  seed: ({ studio, state, now, newId }) => ({ slots: [] } as Slice),   // per studio; Snowy and Harbour both get one
  create: (ctx) => ({
    listSlots: (day) => ctx.read(() => ctx.slice<Slice>().slots.filter((s) => s.startsAt.startsWith(day))),
    bookSlot: (id) => ctx.write(() => {
      const me = ctx.me();
      const s = ctx.slice<Slice>().slots.find((x) => x.id === id);
      if (!s) throw ctx.error('NOT_FOUND', 'That time isn’t available any more.');
      s.booked = true; return s;
    }),
  }),
});
```
`ctx`: `studioId`, `studio()`, `now()`, `slice<T>()` (your data inside the studio's demo state; persists, syncs across tabs, is reset with the demo), `read(fn)`, `write(fn)` (rolls the whole studio back if fn throws), `me()`, `requireStaff(action)`, `requireSelfOrStaff(clientId, action?)`, `core()` (the studio's clients, sessions, bookings… and the booking engine), `newId(prefix)`, `error(code, message)`. Everything runs in that studio's timezone and currency. Adding seed data doesn't need a storage-key bump: a studio without your slice gets `{}` from `slice()`; write `seed` so the demo looks good from a fresh reset.

### 4. Live: `live.ts` (`src/data/supabase/features.ts`)
```ts
import './permissions';
import { registerLiveFeature } from '../../data/supabase/features';
registerLiveFeature({
  name: 'appointments',
  create: (ctx) => ({
    listSlots: (day) => ctx.read(async () => (await ctx.rows(ctx.sb.from('appointment_slots').select('*').eq('day', day))).map(toSlot)),
    bookSlot: (id) => ctx.write(async () => toSlot(await ctx.rpc('appointments_book_slot', { p_slot_id: id }) as Record<string, unknown>)),
  }),
});
```
`ctx.sb` already sends the `x-studio` header. `ctx.rpc` / `ctx.rows` turn `'CODE: message'` database errors into `StoreError(code, message)`.

### 5. SQL: your migration range and `app.scope_table`
| Feature | Migrations | SQL tests |
|---|---|---|
| appointments | `supabase/migrations/1100_appointments_*.sql` … `1199_*` | `supabase/tests/appointments_*.sql` |
| marketing | `1200`–`1299` | `marketing_*.sql` |
| commerce | `1300`–`1399` | `commerce_*.sql` |
| payroll | `1400`–`1499` | `payroll_*.sql` |

Every table has a studio:
```sql
create table public.appointment_slots (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null default app.current_studio_id() references public.studios(id) on delete restrict,
  staff_id uuid not null,
  starts_at timestamptz not null,
  foreign key (studio_id, staff_id) references public.staff (studio_id, id) on delete cascade   -- same-studio links
);
select app.scope_table('appointment_slots');   -- RLS on, guard trigger, restrictive x-studio policy, unique (studio_id, id)
create policy slots_read on public.appointment_slots for select to authenticated using (app.is_member_of(studio_id));
create policy slots_write on public.appointment_slots for all to authenticated
  using (app.has_role_in(studio_id, 'owner', 'manager')) with check (app.has_role_in(studio_id, 'owner', 'manager'));
grant select, insert, update, delete on public.appointment_slots to authenticated;
```
Helpers (all take the row's studio): `app.is_staff_of(studio_id)`, `app.has_role_in(studio_id, 'owner', …)`, `app.staff_role_in(studio_id)`, `app.client_id_in(studio_id)` (the signed-in client's id there), `app.staff_id_in(studio_id)`, `app.is_member_of(studio_id)`. Inside RPCs (`security definer`): `app.current_studio_id()`, `public.current_client_id()`, `public.current_staff_id()`, `public.has_role('owner', 'manager')`, `app.tz()` (studio timezone), `app.assert_in_studio('table', id, 'Not found message')` for every id you're given, `app.assert_studio_open(app.current_studio_id())` before writes, `app.fail('CODE', 'Friendly message')` for errors. Grant RPCs to `authenticated` only. Composite foreign keys need the parent's `unique (studio_id, id)`; core tables (staff, clients, class_types, class_sessions, products, passes, sales, schedule_templates) have it.

SQL tests: `supabase/tests/<feature>_*.sql` run automatically after the core tests (`bash supabase/tests/run.sh`). Wrap each file in `begin; … rollback;` and use the fixtures and helpers from `10_fixtures.sql` / `70_platform.sql` (`test.login('libby')`, `test.studio('snowy')`, `test.eq`, `test.ok`, `test.throws`, `test.count`). Always include a check that another studio's staff and clients can't read or change your rows.

### 6. UI: registries (`src/shared/registry.ts`)
```tsx
// src/features/appointments/studio/index.tsx
import React from 'react';
import '../permissions';
import { registerStudioNav, registerStudioRoute, registerSettingsTab, registerTodayWidget, registerSlot } from '../../../shared/registry';
import { AppointmentsPage } from './page';
registerStudioNav({ id: 'appointments', label: 'Appointments', short: 'Appts', icon: 'calendar', href: '#/appointments', order: 25, perm: 'appointments.view' });
registerStudioRoute({ id: 'appointments', path: '/appointments', nav: 'appointments', perm: 'appointments.view', render: () => <AppointmentsPage /> });
registerSettingsTab({ id: 'appointments', label: 'Appointments', order: 35, perm: 'appointments.manage', render: () => <AppointmentSettings /> });
registerTodayWidget({ id: 'appointments.today', column: 'side', perm: 'appointments.view', render: () => <TodaysAppointments /> });
registerSlot('client.profile', { id: 'appointments.upcoming', render: ({ client }) => <ClientAppointments client={client} /> });
```
- Client app: `registerClientTab({ id, path, label, icon, order })` (core tabs 10 Timetable, 20 Bookings, 30 Passes, 40 Profile; keep it to five tabs total), `registerClientRoute({ id, path, render, chrome?, tab? })`, `registerClientProfileEntry({ id, label, sub?, icon, path, order })`.
- Studio app: `registerStudioNav` (core 10 Today, 20 Schedule, 30 Clients, 40 Point of sale, 50 Reports, 60 Settings), `registerStudioRoute` (`path` like `/payroll/:runId`, `nav` = highlighted item id), `registerSettingsTab` (core 10 Studio, 15 Branding, 20 Policies, 30 Class types, 40 Products, 50 Staff, 90 Demo; URL `#/settings/<id>`), `registerTodayWidget` (`column: 'main' | 'side'`).
- Slots inside core screens (`SlotProps` lists the props each gets): `roster.header`, `roster.entry`, `client.profile`, `client.profile.actions`, `pos.cart` (`setDiscount(cents, note)` for promos and gift cards), `pos.products`, `staff.card`, `client.class`, `client.timetable`, `client.shop`. A slot that throws is hidden, not fatal. Need another slot? Ask the lead in `NOTES.md`; don't edit the core screen.
- ids are prefixed with your feature name. Icons: a core icon name from that app's `ui.tsx`, or your own `<svg>`. Reuse the core components and CSS classes (`btn`, `card`, `input`, `chip`, `sheet`…); put feature CSS in your folder and import it from your `index.tsx`, using the theme variables (`var(--primary)`, `var(--ink)`, `var(--soft)`, `var(--display)`…), never fixed colours.
- In components: `useApp()` (client) / `useStudio()` (studio) give the signed-in user and `studio`; `roleCan(role, 'appointments.manage')` from `src/studio/ui.tsx`.

### 7. Checks before you hand back
`npx tsc -p tsconfig.core.json`, `npm test`, `node build.mjs`, `bash supabase/tests/run.sh`, and a Playwright run of your screens for **both demo studios** (`?studio=snowy` and `?studio=harbour`) at 390 and 1024 wide with no console errors. Write your summary under your heading in `NOTES.md`.

## The rules
`RULES.md` holds Snowy's real booking, cancellation, waitlist and pricing policies. **It is the spec. Read it.** Other studios set their own windows and policies in Settings (and the onboarding wizard); code reads them from the studio's settings, never from constants.

## Tooling in this sandbox
There's no npm registry access. `node_modules` is a symlink to a shared tools folder that has react 19, react-dom, esbuild, typescript, tsx, playwright, sharp and dayjs. Don't add dependencies. `@supabase/supabase-js` gets stubbed for local builds.

- `node build.mjs` builds into `dist/`: client at `dist/index.html`, studio at `dist/studio/index.html`, admin at `dist/admin/index.html`. `STUDIO_SLUG=snowy` makes a single-studio build; `PLATFORM_DOMAIN=studioplatform.app` turns on subdomains.
- `npm test` runs node:test via tsx, for `tests/*.test.ts`.
- `npx tsc -p tsconfig.core.json` is a strict typecheck of shared/domain/data/features/tests. React files aren't typechecked because there are no @types/react, so be careful in TSX.
- `bash supabase/tests/run.sh` runs every migration, the seed (twice) and the SQL, live-store and edge-function tests on a throwaway Postgres.
- To serve dist for Playwright, run `python3 -m http.server 4173 -d dist` (in the background), then open `http://localhost:4173/?studio=snowy`, `http://localhost:4173/studio/?studio=harbour`, `http://localhost:4173/admin/`.
- Playwright: `import { chromium } from 'playwright'` works from a `.mjs` script in this folder. Chromium is preinstalled. Don't run `playwright install`. Google Fonts can't load here, which is expected.

## Design
Calm, airy, premium boutique, like Housed or a Framer template. Don't make it look like a generic SaaS dashboard.

- Use the role tokens from `src/shared/theme.css`, which each studio's branding fills in at runtime: `--primary`, `--ink`, `--accent`, `--soft`, `--highlight`, `--bg` (plus `--primary-600`, `--soft-2`, `--muted`, `--faint`, `--*-rgb`), fonts `--display` and `--body`. Headings use the display font with an italic `<em>` accent word (`<Accented text="Find your *studio*" />`).
  - Snowy: navy `#5069AC`, ink `#24345F`, sky `#85A2D1`, mist `#EEF2F9`, cream `#F2E6C6`, bg `#FAF8F3`, Instrument Serif + Questrial.
  - Harbour (demo studio 2): deep green and sand, Gloock + Work Sans.
  - **No pink.**
- Brand assets come from the studio's branding: `<Logo />`, `<Flower />` (the studio's mark), `<Marquee />` from `src/shared/brand.tsx`; photos via `classPhoto()` / `branding.photos`. Snowy's files are in `public/brand/` and `public/img/`; other studios' in `public/studios/<slug>/` or uploaded (Supabase Storage `branding` bucket).
- Tap targets are at least 44px. Text is at least 14px. Keep copy friendly and plain, in Australian English, sentence case.
- Paths are relative: client assets are `brand/...`, studio and admin assets are `../brand/...` (`brandAsset()` handles it).

## Done means
- It builds.
- Your tests and Playwright run-through pass, for both demo studios.
- Screenshots are checked by you.
- There's a short summary of what you built and any gaps, written to `NOTES.md` under your heading.
