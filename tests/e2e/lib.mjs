// Shared helpers for the E2E journeys. Each journey file calls journey(name, fn) and the runner (run.mjs) runs one file per process.
// The demo lives in localStorage, so every journey starts from a brand new browser context (empty storage) and a fixed demo clock.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SNOWY = process.env.E2E_SNOWY_URL || 'http://localhost:4173';
const PLATFORM = process.env.E2E_PLATFORM_URL || 'http://localhost:4174';
export const CLIENT = { width: 390, height: 844 };
export const STUDIO = { width: 1024, height: 768 };

/** Only these console errors are allowed: Google Fonts can't load in the sandbox, and there is no sw.js in the demo. */
const IGNORED = /fonts\.(googleapis|gstatic)\.com|\/sw\.js|sw\.js/;

/** Next Tuesday 08:00 in Sydney (as a Date). Pinning "now" keeps the seeded timetable, windows and late-cancel rules the same on every run. */
function anchor() {
  const d = new Date();
  const ymd = (x) => x.toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
  for (let i = 1; i <= 7; i++) {
    const t = new Date(d.getTime() + i * 864e5);
    if (t.toLocaleDateString('en-US', { timeZone: 'Australia/Sydney', weekday: 'short' }) === 'Tue') {
      const off = new Date(t.toLocaleString('en-US', { timeZone: 'Australia/Sydney' })).getTime() - new Date(t.toLocaleString('en-US', { timeZone: 'UTC' })).getTime();
      return new Date(Date.parse(`${ymd(t)}T08:00:00Z`) - off);
    }
  }
}
export const ANCHOR = anchor();

export async function journey(name, fn, opts = {}) {
  const browser = await chromium.launch();
  const errors = [];
  const pages = [];
  let ctx;
  const t0 = Date.now();
  try {
    ctx = await browser.newContext({ viewport: CLIENT, locale: 'en-AU', timezoneId: 'Australia/Sydney', acceptDownloads: true });
    await ctx.clock.install({ time: opts.time ?? ANCHOR });
    await ctx.clock.resume();
    const watch = (p, tag) => {
      p.on('console', (m) => {
        if (m.type() !== 'error') return;
        if (IGNORED.test(m.location().url || '') || IGNORED.test(m.text())) return;
        errors.push(`${tag} console: ${m.text()} (${m.location().url})`);
      });
      p.on('pageerror', (e) => errors.push(`${tag} pageerror: ${e.message}`));
    };
    const base = opts.platform ? PLATFORM : SNOWY;
    const open = async (kind, url, size) => {
      const p = await ctx.newPage();
      await p.setViewportSize(size);
      watch(p, kind); p._tag = kind; pages.push(p);
      await p.goto(base + url);
      return p;
    };
    const env = {
      ctx, base,
      client: (hash = '') => open('client', `/${opts.platform ? '?studio=harbour' : ''}${hash}`, CLIENT),
      studio: (hash = '') => open('studio', `/studio/${opts.platform ? '?studio=harbour' : ''}${hash}`, STUDIO),
    };
    // clean state: this context is new, but clear anyway so a reused browser profile can never leak data in.
    const warm = await ctx.newPage(); await warm.goto(base + '/'); await warm.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); await warm.close();
    await fn(env);
    if (errors.length) throw new Error('Console/page errors:\n  ' + errors.join('\n  '));
    console.log(`PASS ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    await browser.close();
  } catch (e) {
    console.error(`FAIL ${name}: ${e.stack || e}`);
    try {
      const dir = path.join(ROOT, 'screenshots/e2e-failures'); mkdirSync(dir, { recursive: true });
      const slug = name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      for (const [i, p] of pages.entries()) await p.screenshot({ path: path.join(dir, `${slug}-${p._tag}${i}.png`), fullPage: false }).catch(() => {});
    } catch {}
    await browser.close().catch(() => {});
    process.exit(1);
  }
}

// ---- small shared actions -------------------------------------------------------------------------------------
export const T = { timeout: 8000 };
/** Client app: tap a demo persona on the welcome screen. */
export async function clientSignInAs(p, who) {
  await p.locator('.demo-box .list-row', { hasText: who }).first().click();
  await p.locator('.strip-day').first().waitFor(T);
}
/** Studio app: quick sign-in as a demo staff member ("Libby", "Grace T"...). */
export async function studioSignInAs(p, who) {
  await p.getByRole('button', { name: new RegExp(`Sign in as ${who}`) }).click();
  await p.locator('nav, .nav, .sidebar').first().waitFor(T);
}
export const goStudio = (p, hash) => p.evaluate((h) => { location.hash = h; }, hash);

/** Retry an async check until it stops throwing (real waits, no sleeps). Use for assertions on values that settle after a render. */
export async function eventually(fn, what = 'condition', ms = 8000) {
  const end = Date.now() + ms; let last;
  for (;;) {
    try { const r = await fn(); if (r !== false) return r; last = new Error(`${what} was false`); } catch (e) { last = e; }
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}: ${last?.message}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
export const textOf = (p, sel) => p.locator(sel).first().innerText();

/** Dates relative to the pinned demo "today" (a Tuesday). */
export const dayStr = (offset = 0) => new Date(ANCHOR.getTime() + offset * 864e5).toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
export const dayLabel = (offset = 0) => new Date(ANCHOR.getTime() + offset * 864e5).toLocaleDateString('en-AU', { timeZone: 'Australia/Sydney', weekday: 'long', day: 'numeric', month: 'long' }).replace(',', '');
/** Client timetable: jump to a day (0 = today) using the date strip. */
export const pickDay = (p, offset) => p.getByRole('button', { name: dayLabel(offset) }).click();
/** Studio: monday of the week containing offset days from today (for #/schedule/<week>). */
export const weekOf = (offset = 0) => { const d = new Date(dayStr(offset) + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };

/** In an open class sheet: "Book this class", answer the quick health check "No" if it is asked, wait for the confirmation. */
export async function bookOpenClass(p) {
  await p.getByRole('button', { name: /Book this class/ }).click();
  const booked = p.getByText(/You.re booked in/);
  const confirm = p.getByRole('button', { name: /Confirm booking/ });
  await booked.or(confirm).first().waitFor(T);
  if (await confirm.isVisible()) await confirm.click();
  await booked.waitFor(T);
}
/** Close the class sheet that is open on the client app. */
export async function closeSheet(p) {
  await p.keyboard.press('Escape');
  await p.locator('.cs-foot').waitFor({ state: 'hidden', ...T });
}
