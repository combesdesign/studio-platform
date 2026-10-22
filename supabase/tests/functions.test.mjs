// The edge functions (supabase/functions, written for Deno) run under Node with:
//   - a tiny Deno shim (Deno.env, Deno.serve captures the handler),
//   - fake-supabase.mjs in place of npm:@supabase/supabase-js@2 (real SQL against the test database;
//     the service role key acts as service_role, 'Bearer <user id>' acts as that user),
//   - fetch stubbed for api.stripe.com and api.resend.com (records every request).
// Run by run.sh after the live store checks. Proves the Stripe parameters, webhook signature +
// idempotency, membership pause/cancel sync, refunds and emails without Deno, Stripe or Resend.
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const FN = path.resolve(HERE, '../functions');
let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ok - ${name}`); } catch (e) { failed++; console.log(`  FAIL - ${name}\n    ${String(e?.stack ?? e).split('\n').slice(0, 6).join('\n    ')}`); }
}
function sql(q) {
  const r = spawnSync('psql', ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-c', q], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.replace(/\n$/, '');
}
const id = (name) => sql(`select id from test.ids where name = '${name}'`);

// ---------------------------------------------------------------- environment
const ENV = {
  SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_ANON_KEY: 'anon-key', SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  STRIPE_SECRET_KEY: 'sk_test_123', STRIPE_WEBHOOK_SECRET: 'whsec_test_secret', RESEND_API_KEY: 're_test',
  CRON_SECRET: 'cron-secret-1234567890', APP_URL: 'https://app.example', APP_URLS: 'https://app.example,https://snowy.netlify.app',
};
let handler = null;
globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: (h) => { handler = h; } };
globalThis.__fake ??= { now: null, users: new Map(), invoked: [], invokeResult: {}, log: [], invites: [] };
globalThis.__fake.now = '2026-10-19T08:00:00+11:00';

const calls = [];
const stripeObjects = {};
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const body = typeof init.body === 'string' ? init.body : '';
  calls.push({ host: u.host, path: u.pathname, method: init.method ?? 'GET', body, headers: init.headers ?? {} });
  const reply = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
  if (u.host === 'api.resend.com') return reply({ id: 'email_1' });
  const p = u.pathname.replace('/v1/', '');
  if (p in stripeObjects) return reply(typeof stripeObjects[p] === 'function' ? stripeObjects[p](body) : stripeObjects[p]);
  return reply({ error: { message: `no stub for ${init.method} ${p}` } }, 404);
};

const out = mkdtempSync(path.join(process.env.SNOWY_WORK || tmpdir(), 'fns-'));
async function load(name) {
  handler = null;
  const file = path.join(out, `${name}.mjs`);
  await build({
    entryPoints: [path.join(FN, name, 'index.ts')], bundle: true, format: 'esm', platform: 'node', outfile: file, logLevel: 'error',
    plugins: [{ name: 'deno-npm', setup(b) { b.onResolve({ filter: /^npm:@supabase\/supabase-js@2$/ }, () => ({ path: path.join(HERE, 'fake-supabase.mjs') })); } }],
  });
  await import(`${file}?${Date.now()}`);
  assert.ok(handler, `${name} did not call serve()`);
  return handler;
}
const post = (h, body, headers = {}) => h(new Request('https://proj.supabase.co/functions/v1/x', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
}));
const form = (body) => Object.fromEntries(new URLSearchParams(body));
const lastStripe = (pathPart, method = 'POST') => [...calls].reverse().find((c) => c.host === 'api.stripe.com' && c.path.includes(pathPart) && c.method === method);
function signed(event, secret = ENV.STRIPE_WEBHOOK_SECRET, at = Math.floor(Date.now() / 1000)) {
  const raw = JSON.stringify(event);
  const sig = createHmac('sha256', secret).update(`${at}.${raw}`).digest('hex');
  return { raw, header: `t=${at},v1=${sig}` };
}

// ---------------------------------------------------------------- pure helpers
const shared = path.join(out, 'shared.mjs');
await build({ stdin: { contents: `export * from '${FN}/_shared/stripe.ts'; export { render } from '${FN}/_shared/email.ts'; export { safeReturnUrl } from '${FN}/_shared/http.ts';`, resolveDir: FN, loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', outfile: shared, logLevel: 'error',
  plugins: [{ name: 'deno-npm', setup(b) { b.onResolve({ filter: /^npm:@supabase\/supabase-js@2$/ }, () => ({ path: path.join(HERE, 'fake-supabase.mjs') })); } }] });
const H = await import(shared);

console.log('\n-- shared helpers');
await t('Stripe form encoding (nested objects, arrays, skips undefined)', () => {
  const s = H.formEncode({ mode: 'subscription', line_items: [{ quantity: 1, price_data: { currency: 'aud', recurring: { interval: 'week' } } }], metadata: { a: 'b' }, phone: undefined, pause_collection: '' }).toString();
  assert.equal(decodeURIComponent(s), 'mode=subscription&line_items[0][quantity]=1&line_items[0][price_data][currency]=aud&line_items[0][price_data][recurring][interval]=week&metadata[a]=b&pause_collection=');
});
await t('webhook signatures: valid, tampered, wrong secret, too old, several v1s', async () => {
  const ev = { id: 'evt_x', type: 'ping' };
  const good = signed(ev);
  assert.equal(await H.verifyStripeSignature(good.raw, good.header, ENV.STRIPE_WEBHOOK_SECRET), true);
  assert.equal(await H.verifyStripeSignature(good.raw + ' ', good.header, ENV.STRIPE_WEBHOOK_SECRET), false);
  const wrong = signed(ev, 'whsec_other');
  assert.equal(await H.verifyStripeSignature(wrong.raw, wrong.header, ENV.STRIPE_WEBHOOK_SECRET), false);
  const old = signed(ev, ENV.STRIPE_WEBHOOK_SECRET, Math.floor(Date.now() / 1000) - 3600);
  assert.equal(await H.verifyStripeSignature(old.raw, old.header, ENV.STRIPE_WEBHOOK_SECRET), false);
  assert.equal(await H.verifyStripeSignature(good.raw, `${good.header.replace('v1=', 'v1=deadbeef,v1=')}`, ENV.STRIPE_WEBHOOK_SECRET), true);
  assert.equal(await H.verifyStripeSignature(good.raw, null, ENV.STRIPE_WEBHOOK_SECRET), false);
});
await t('Sydney midnight across daylight saving (AEDT / AEST)', () => {
  assert.equal(new Date(H.sydneyMidnightUnix('2026-10-05') * 1000).toISOString(), '2026-10-04T13:00:00.000Z');
  assert.equal(new Date(H.sydneyMidnightUnix('2026-07-01') * 1000).toISOString(), '2026-06-30T14:00:00.000Z');
  assert.equal(new Date(H.sydneyMidnightUnix('2026-04-06') * 1000).toISOString(), '2026-04-05T14:00:00.000Z');
});
await t('emails: booking, waitlist and reminder carry the cancellation policy; receipt shows GST + ABN', () => {
  const p = { first_name: 'Alice', class_name: 'Mat Essentials', when: '6:00pm Wed 21 Oct', cancellation_policy: 'If you cancel more than 3 hours before…' };
  for (const kind of ['booking_confirmed', 'waitlist_promoted', 'class_reminder']) {
    const m = H.render({ id: '1', kind, to_email: 'a@b.c', payload: p, attempts: 0 });
    assert.ok(m.html.includes('If you cancel more than 3 hours') && m.text.includes('If you cancel more than 3 hours'), kind);
  }
  const r = H.render({ id: '1', kind: 'receipt', to_email: 'a@b.c', attempts: 0,
    payload: { studio_name: 'Snowy Pilates Club', abn: '12 345 678 901', total_cents: 11000, gst_cents: 1000, items: [{ qty: 1, name: '4 class pack', unit_cents: 11000 }] } });
  assert.ok(r.html.includes('Total includes GST of $10.00') && r.html.includes('ABN 12 345 678 901'));
  const x = H.render({ id: '1', kind: 'booking_confirmed', to_email: 'a', attempts: 0, payload: { first_name: '<script>' } });
  assert.ok(!x.html.includes('<script>'), 'escapes HTML');
});
await t('return URLs: only our app (or the native app schemes)', () => {
  assert.equal(H.safeReturnUrl('https://app.example/#/passes?paid=1'), 'https://app.example/#/passes?paid=1');
  assert.equal(H.safeReturnUrl('https://snowy.netlify.app/x'), 'https://snowy.netlify.app/x');
  assert.equal(H.safeReturnUrl('https://evil.example/phish'), 'https://app.example');
  assert.equal(H.safeReturnUrl('capacitor://localhost/#/passes'), 'capacitor://localhost/#/passes');
});

// ---------------------------------------------------------------- functions
console.log('\n-- edge functions (Stripe and Resend stubbed, database real)');
const CARA = id('cara_client'), CARA_USER = id('cara'), FRAN_USER = id('fran'), JULIA_USER = id('julia');
const P_PACK4 = id('p_pack4'), P_WEEK2 = id('p_week2');

await t('create-checkout: one-off pack = payment mode, AUD, GST-inclusive price, our metadata, safe return URL', async () => {
  stripeObjects.customers = { id: 'cus_cara' };
  stripeObjects['checkout/sessions'] = { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' };
  const h = await load('create-checkout');
  const res = await post(h, { productId: P_PACK4, returnUrl: 'https://app.example/#/passes?paid=x' }, { Authorization: `Bearer ${CARA_USER}` });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).url, 'https://checkout.stripe.com/c/pay/cs_1');
  const f = form(lastStripe('checkout/sessions').body);
  assert.equal(f.mode, 'payment'); assert.equal(f.customer, 'cus_cara');
  assert.equal(f['line_items[0][price_data][currency]'], 'aud'); assert.equal(f['line_items[0][price_data][unit_amount]'], '10000');
  assert.equal(f['metadata[client_id]'], CARA); assert.equal(f['metadata[product_id]'], P_PACK4);
  assert.equal(f['payment_intent_data[metadata][client_id]'], CARA);
  assert.equal(f.success_url, 'https://app.example/#/passes?paid=x');
  assert.equal(f['payment_intent_data[receipt_email]'], undefined, 'no duplicate Stripe receipt');
  assert.equal(lastStripe('customers').headers['Idempotency-Key'], `customer-${CARA}`);
  assert.equal(lastStripe('checkout/sessions').headers.Authorization, 'Bearer sk_test_123');
  assert.equal(sql(`select stripe_customer_id from public.stripe_customers where client_id = '${CARA}'`), 'cus_cara');
});

await t('create-checkout: membership = weekly subscription; staff and intro repeats refused', async () => {
  const h = await load('create-checkout');
  const res = await post(h, { productId: P_WEEK2, returnUrl: 'https://app.example/#/passes' }, { Authorization: `Bearer ${CARA_USER}` });
  assert.equal(res.status, 200);
  const f = form(lastStripe('checkout/sessions').body);
  assert.equal(f.mode, 'subscription');
  assert.equal(f['line_items[0][price_data][recurring][interval]'], 'week');
  assert.equal(f['line_items[0][price_data][unit_amount]'], '4000');
  assert.equal(f['subscription_data[metadata][product_id]'], P_WEEK2);
  assert.equal(f['payment_intent_data[metadata][client_id]'], undefined, 'no payment_intent_data in subscription mode');
  const staff = await post(h, { productId: P_WEEK2 }, { Authorization: `Bearer ${FRAN_USER}` });
  assert.equal(staff.status, 403);
  const intro = await post(h, { productId: id('p_intro') }, { Authorization: `Bearer ${id('alice')}` });
  assert.equal((await intro.json()).code, 'INTRO_NOT_ELIGIBLE');
  const anon = await post(h, { productId: P_PACK4 });
  assert.equal(anon.status, 401);
});

let webhook;
await t('stripe-webhook: bad or missing signature is rejected', async () => {
  webhook = await load('stripe-webhook');
  const { raw } = signed({ id: 'evt_bad', type: 'charge.refunded', data: { object: {} } });
  assert.equal((await post(webhook, raw, { 'Stripe-Signature': 't=1,v1=00' })).status, 400);
  assert.equal((await post(webhook, raw)).status, 400);
  assert.equal(sql(`select count(*) from public.stripe_events where id = 'evt_bad'`), '0');
});

const sendEvent = (ev) => { const { raw, header } = signed(ev); return post(webhook, raw, { 'Stripe-Signature': header }); };
await t('stripe-webhook: checkout paid -> pass + sale once, even if Stripe sends it twice', async () => {
  const ev = { id: 'evt_pay_1', type: 'checkout.session.completed', data: { object: {
    id: 'cs_pay_1', object: 'checkout.session', mode: 'payment', payment_status: 'paid', amount_total: 10000,
    customer: 'cus_cara', client_reference_id: CARA, payment_intent: 'pi_pay_1', metadata: { client_id: CARA, product_id: P_PACK4, kind: 'pack' } } } };
  assert.equal((await sendEvent(ev)).status, 200);
  const again = await sendEvent(ev);
  assert.equal((await again.json()).duplicate, true);
  assert.equal((await sendEvent({ ...ev, id: 'evt_pay_1b' })).status, 200, 'a different event for the same checkout');
  assert.equal(sql(`select count(*) from public.sales where stripe_checkout_session_id = 'cs_pay_1'`), '1');
  assert.equal(sql(`select count(*) || ' ' || min(p.kind) || ' ' || min(s.method) || ' ' || min(s.total_cents) from public.passes p join public.sales s on s.id = p.sale_id where s.stripe_payment_intent_id = 'pi_pay_1'`), '1 pack card_online 10000');
  assert.ok(sql(`select processed_at is not null from public.stripe_events where id = 'evt_pay_1'`) === 't');
  assert.equal(sql(`select count(*) from public.notifications where kind = 'receipt' and client_id = '${CARA}'`), '1', 'receipt email queued');
});

await t('stripe-webhook: async payment (e.g. direct debit) waits for async_payment_succeeded', async () => {
  const obj = { id: 'cs_becs', mode: 'payment', payment_status: 'unpaid', amount_total: 3000, customer: 'cus_cara', payment_intent: 'pi_becs', metadata: { client_id: CARA, product_id: id('p_single') } };
  await sendEvent({ id: 'evt_becs_1', type: 'checkout.session.completed', data: { object: obj } });
  assert.equal(sql(`select count(*) from public.sales where stripe_checkout_session_id = 'cs_becs'`), '0');
  await sendEvent({ id: 'evt_becs_2', type: 'checkout.session.async_payment_succeeded', data: { object: { ...obj, payment_status: 'paid' } } });
  assert.equal(sql(`select count(*) from public.sales where stripe_checkout_session_id = 'cs_becs'`), '1');
});

await t('stripe-webhook: membership checkout, weekly renewal, refund, subscription ended', async () => {
  const periodEnd = Math.floor(Date.parse('2026-10-26T08:00:00+11:00') / 1000);
  stripeObjects['subscriptions/sub_1'] = { id: 'sub_1', status: 'active', current_period_end: periodEnd, cancel_at_period_end: false, pause_collection: null };
  stripeObjects['invoices/in_1'] = { id: 'in_1', payment_intent: 'pi_sub_1', subscription: 'sub_1', billing_reason: 'subscription_create' };
  const res = await sendEvent({ id: 'evt_sub_1', type: 'checkout.session.completed', data: { object: {
    id: 'cs_sub_1', mode: 'subscription', payment_status: 'paid', amount_total: 4000, customer: 'cus_cara', subscription: 'sub_1', invoice: 'in_1',
    metadata: { client_id: CARA, product_id: P_WEEK2 } } } });
  assert.equal(res.status, 200);
  assert.equal(sql(`select kind || ' ' || credits || ' ' || billing_interval || ' ' || (next_billing_at = to_timestamp(${periodEnd}))::text from public.passes where stripe_subscription_id = 'sub_1'`), 'membership 2 week true');
  // first invoice.paid is skipped (handled by checkout); a renewal records a sale
  await sendEvent({ id: 'evt_inv_0', type: 'invoice.paid', data: { object: { id: 'in_1' } } });
  stripeObjects['invoices/in_2'] = { id: 'in_2', payment_intent: 'pi_sub_2', subscription: 'sub_1', billing_reason: 'subscription_cycle', amount_paid: 4000,
    lines: { data: [{ period: { end: periodEnd + 7 * 86400 } }] } };
  assert.equal((await sendEvent({ id: 'evt_inv_2', type: 'invoice.paid', data: { object: { id: 'in_2' } } })).status, 200);
  assert.equal(sql(`select count(*) from public.sales s join public.sale_items i on i.sale_id = s.id where s.stripe_invoice_id in ('in_1','in_2') and i.kind = 'membership'`), '2');
  assert.equal(sql(`select (next_billing_at = to_timestamp(${periodEnd + 7 * 86400}))::text from public.passes where stripe_subscription_id = 'sub_1'`), 'true');
  assert.equal((await sendEvent({ id: 'evt_ref_1', type: 'charge.refunded', data: { object: { id: 'ch_2', payment_intent: 'pi_sub_2', amount_refunded: 1500 } } })).status, 200);
  assert.equal(sql(`select refunded_cents from public.sales where stripe_payment_intent_id = 'pi_sub_2'`), '1500');
  assert.equal((await sendEvent({ id: 'evt_del_1', type: 'customer.subscription.deleted', data: { object: { id: 'sub_1' } } })).status, 200);
  assert.equal(sql(`select status from public.passes where stripe_subscription_id = 'sub_1'`), 'cancelled');
});

await t('stripe-webhook: a renewal that arrives before its checkout is retried (500), not lost', async () => {
  stripeObjects['invoices/in_9'] = { id: 'in_9', subscription: 'sub_unknown', billing_reason: 'subscription_cycle', amount_paid: 2200, lines: { data: [{ period: { end: 1 } }] } };
  const r = await sendEvent({ id: 'evt_inv_9', type: 'invoice.paid', data: { object: { id: 'in_9' } } });
  assert.equal(r.status, 500);
  assert.ok(sql(`select error from public.stripe_events where id = 'evt_inv_9'`).includes('No membership'));
});

await t('manage-membership: pause -> pause_collection void until the day after; resume clears it; cancel at period end', async () => {
  // a fresh subscription-backed membership for Cara
  sql(`insert into public.passes (client_id, kind, name, status, credits, billing_interval, stripe_subscription_id, next_billing_at, activated_at)
       values ('${CARA}', 'membership', '2 classes per week', 'active', 2, 'week', 'sub_2', '2026-10-26 08:00+11', '2026-10-19 08:00+11')`);
  const passId = sql(`select id from public.passes where stripe_subscription_id = 'sub_2'`);
  let sub = { id: 'sub_2', status: 'active', cancel_at_period_end: false, pause_collection: null };
  stripeObjects['subscriptions/sub_2'] = (body) => { if (body) Object.assign(sub, { touched: true }); return sub; };
  const h = await load('manage-membership');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());
  const until = new Date(Date.parse(`${today}T00:00:00Z`) + 9 * 86400e3).toISOString().slice(0, 10);
  sql(`update public.passes set paused_from = '${today}', paused_until = '${until}', status = 'paused' where id = '${passId}'`);
  assert.equal((await post(h, { passId }, { Authorization: `Bearer ${CARA_USER}` })).status, 200);
  let f = form(lastStripe('subscriptions/sub_2').body);
  assert.equal(f['pause_collection[behavior]'], 'void');
  const resumeDay = new Date(Date.parse(`${until}T00:00:00Z`) + 86400e3).toISOString().slice(0, 10);
  assert.equal(Number(f['pause_collection[resumes_at]']), H.sydneyMidnightUnix(resumeDay));
  sub = { ...sub, pause_collection: { behavior: 'void', resumes_at: Number(f['pause_collection[resumes_at]']) } };
  sql(`update public.passes set paused_from = null, paused_until = null, status = 'active' where id = '${passId}'`);
  await post(h, { passId }, { Authorization: `Bearer ${FRAN_USER}` });
  f = form(lastStripe('subscriptions/sub_2').body);
  assert.equal(f.pause_collection, '', 'resume = empty pause_collection');
  sub = { ...sub, pause_collection: null };
  sql(`update public.passes set status = 'cancelled', cancel_at_period_end = true where id = '${passId}'`);
  await post(h, { passId }, { Authorization: `Bearer ${CARA_USER}` });
  assert.equal(form(lastStripe('subscriptions/sub_2').body).cancel_at_period_end, 'true');
  const julia = await post(h, { passId }, { Authorization: `Bearer ${JULIA_USER}` });
  assert.equal(julia.status, 404, 'instructors can\'t change billing');
  const other = await post(h, { passId }, { Authorization: `Bearer ${id('alice')}` });
  assert.equal(other.status, 404, 'another client can\'t either');
  const cron = await post(h, { all: true }, { 'x-cron-secret': 'nope' });
  assert.equal(cron.status, 401);
  assert.equal((await post(h, { all: true }, { 'x-cron-secret': ENV.CRON_SECRET })).status, 200);
});

await t('refund-payment: front desk refunds in Stripe (idempotency key), then the sale records Stripe\'s total', async () => {
  stripeObjects.refunds = { id: 're_1', charge: 'ch_pay_1' };
  stripeObjects['charges/ch_pay_1'] = { id: 'ch_pay_1', amount_refunded: 2500 };
  const saleId = sql(`select id from public.sales where stripe_payment_intent_id = 'pi_pay_1'`);
  const h = await load('refund-payment');
  assert.equal((await post(h, { saleId, amountCents: 2500 }, { Authorization: `Bearer ${JULIA_USER}` })).status, 403);
  const res = await post(h, { saleId, amountCents: 2500, reason: 'moving away' }, { Authorization: `Bearer ${FRAN_USER}` });
  assert.equal(res.status, 200);
  const f = form(lastStripe('refunds').body);
  assert.deepEqual([f.payment_intent, f.amount], ['pi_pay_1', '2500']);
  assert.equal(lastStripe('refunds').headers['Idempotency-Key'], `refund-${saleId}-0-2500`);
  assert.equal(sql(`select refunded_cents from public.sales where id = '${saleId}'`), '2500');
  assert.equal((await post(h, { saleId, amountCents: 999999 }, { Authorization: `Bearer ${FRAN_USER}` })).status, 400);
});

await t('send-email: needs the cron secret; sends queued emails through Resend with the policy text', async () => {
  const h = await load('send-email');
  assert.equal((await post(h, { flush: true })).status, 401);
  sql(`select app.notify((select id from public.bookings limit 1), 'booking_confirmed')`);
  let j = await (await post(h, { flush: true }, { 'x-cron-secret': ENV.CRON_SECRET })).json();
  assert.ok(j.sent >= 1 && j.failed === 0, JSON.stringify(j));
  for (let i = 0; i < 10 && j.sent > 0; i++) j = await (await post(h, { flush: true }, { 'x-cron-secret': ENV.CRON_SECRET })).json();
  const email = calls.filter((c) => c.host === 'api.resend.com').map((c) => JSON.parse(c.body)).find((b) => b.subject.startsWith('You\'re booked'));
  assert.ok(email && email.html.includes('Cancellation policy') && email.from.includes('Snowy Pilates Club'));
  assert.equal(calls.find((c) => c.host === 'api.resend.com').headers.Authorization, 'Bearer re_test');
  assert.equal(sql(`select count(*) from public.notifications where sent_at is null and error is null and claimed_at is null`), '0');
});

await t('send-reminders: cron secret, housekeeping + reminders queued for ~2 hours ahead', async () => {
  const h = await load('send-reminders');
  assert.equal((await post(h, {})).status, 401);
  const j = await (await post(h, {}, { 'x-cron-secret': ENV.CRON_SECRET })).json();
  assert.ok('tidy' in j && 'queued' in j && 'sent' in j);
});

// ---------------------------------------------------------------- gift cards online, and the feature outboxes
const SNOWY_ID = sql(`select id from public.studios where slug = 'snowy'`);
const issueCard = (studio, who, email, sendOn, status = 'active', purchaser = 'null') => sql(
  `select set_config('app.studio', '${studio}', false), set_config('app.now', '2026-10-19T08:00:00+11:00', false); select (app.commerce_issue('purchase', 'gift_card', 5000, 'Bought in the app', '${status}', 'Pat', ${email ? `'${email}'` : 'null'}, 'Happy birthday', '${who}', ${purchaser === 'null' ? 'null' : `'${purchaser}'`}, null, ${sendOn ? `'${sendOn}'` : 'null'})).id`).split('\n').pop();
let pendingCard;
await t('commerce-checkout: the buyer gets a Stripe Checkout for the pending card (studio name, currency, metadata); nobody else can', async () => {
  pendingCard = issueCard(SNOWY_ID, 'Cara', 'pat@example.test', null, 'pending', CARA);
  stripeObjects['checkout/sessions'] = { id: 'cs_gift_1', url: 'https://checkout.stripe.com/c/pay/cs_gift_1' };
  const h = await load('commerce-checkout');
  const ask = (who, extra = {}) => post(h, { cardId: pendingCard, studioId: SNOWY_ID, returnUrl: 'https://app.example/#/gift-cards', ...extra }, who ? { Authorization: `Bearer ${who}` } : {});
  assert.equal((await ask(null)).status, 401);
  assert.equal((await ask(id('alice'))).status, 403, 'someone else\'s card');
  assert.equal((await ask(FRAN_USER)).status, 403, 'staff can use the till instead');
  assert.equal((await ask(CARA_USER, { studioId: '00000000-0000-4000-8000-00000000dead' })).status, 404, 'wrong studio');
  const res = await ask(CARA_USER);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).url, 'https://checkout.stripe.com/c/pay/cs_gift_1');
  const f = form(lastStripe('checkout/sessions').body);
  assert.equal(f.mode, 'payment');
  assert.equal(f['line_items[0][price_data][unit_amount]'], '5000');
  assert.equal(f['line_items[0][price_data][currency]'], 'aud');
  assert.ok(f['line_items[0][price_data][product_data][name]'].startsWith(sql(`select name from public.studios where id = '${SNOWY_ID}'`)), 'named after the studio');
  assert.equal(f['metadata[kind]'], 'gift_card'); assert.equal(f['metadata[card_id]'], pendingCard); assert.equal(f['metadata[studio_id]'], SNOWY_ID);
  assert.equal(f['payment_intent_data[metadata][card_id]'], pendingCard);
});

await t('stripe-webhook: a paid gift card checkout switches the card on once (sale, ledger, email), however often it is told', async () => {
  const ev = { id: 'evt_gift_1', type: 'checkout.session.completed', data: { object: {
    id: 'cs_gift_1', mode: 'payment', payment_status: 'paid', amount_total: 5000, customer: 'cus_cara', payment_intent: 'pi_gift_1',
    metadata: { kind: 'gift_card', card_id: pendingCard, studio_id: SNOWY_ID, client_id: CARA } } } };
  assert.equal((await sendEvent(ev)).status, 200);
  assert.equal((await (await sendEvent(ev)).json()).duplicate, true);
  assert.equal((await sendEvent({ ...ev, id: 'evt_gift_1b' })).status, 200, 'a different event for the same checkout');
  assert.equal(sql(`select status from public.commerce_gift_cards where id = '${pendingCard}'`), 'active');
  assert.equal(sql(`select count(*) from public.sales where stripe_checkout_session_id = 'cs_gift_1'`), '1');
  assert.equal(sql(`select count(*) from public.commerce_gift_entries where card_id = '${pendingCard}' and kind = 'issue'`), '1');
  assert.equal(sql(`select count(*) from public.commerce_outbox where card_id = '${pendingCard}'`), '1', 'one e-card queued');
  assert.equal(sql(`select count(*) from public.passes p join public.sales s on s.id = p.sale_id where s.stripe_checkout_session_id = 'cs_gift_1'`), '0', 'no pass');
});

await t('send-email: gift card e-cards go out under the card\'s own studio (name, colours, address), on the send date', async () => {
  // a second studio with its own look
  const harbour = sql(`insert into public.studios (slug, name, email, address, currency, status, branding) values ('harbour-fn', 'Harbour Reformer Co.', 'hello@harbour.test', '12 Bay St, Double Bay', 'AUD', 'live',
    '{"colors":{"primary":"#1F4D3A","ink":"#10261D","soft":"#E7EFE9","bg":"#F4EFE4"}}') returning id`).split('\n')[0];
  const sameDay = issueCard(harbour, 'Hank', 'ella@example.test', null);
  const later = issueCard(harbour, 'Hank', 'later@example.test', '2026-12-25');
  const h = await load('send-email');
  const before = calls.filter((c) => c.host === 'api.resend.com').length;
  let j = await (await post(h, { flush: true }, { 'x-cron-secret': ENV.CRON_SECRET })).json();
  assert.ok(j.sent >= 2 && j.failed === 0, JSON.stringify(j));
  const mails = calls.filter((c) => c.host === 'api.resend.com').slice(before).map((c) => JSON.parse(c.body));
  const mine = mails.find((m) => m.to[0] === 'ella@example.test');
  assert.ok(mine, 'the Harbour e-card was sent');
  assert.ok(mine.from.startsWith('Harbour Reformer Co. <'), mine.from);
  assert.equal(mine.reply_to, 'hello@harbour.test');
  assert.ok(mine.html.includes('#1F4D3A') && mine.html.includes('Harbour Reformer Co.') && mine.html.includes('12 Bay St, Double Bay'), 'their colours, name and address');
  assert.ok(!/Snowy|Cooma|#5069AC/.test(mine.html + mine.text + mine.subject), 'nothing of Snowy in it');
  assert.ok(mine.html.includes('$50.00') && mine.html.includes('Happy birthday') && /[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}/.test(mine.html), 'amount, message and code');
  assert.ok(mine.subject.startsWith('Hank sent you a Harbour Reformer Co. gift card'));
  const snowyMail = mails.find((m) => m.to[0] === 'pat@example.test');
  assert.ok(snowyMail && snowyMail.from.includes('Snowy Pilates Club'), 'Snowy\'s own card still goes as Snowy');
  assert.ok(!mails.some((m) => m.to[0] === 'later@example.test'), 'a card with a future send date waits');
  assert.equal(sql(`select (sent_at is null)::text from public.commerce_outbox where card_id = '${sameDay}'`), 'false');
  // the send date arrives
  sql(`update public.commerce_gift_cards set send_on = '2026-10-19' where id = '${later}'`);
  j = await (await post(h, { flush: true }, { 'x-cron-secret': ENV.CRON_SECRET })).json();
  assert.ok(calls.filter((c) => c.host === 'api.resend.com').map((c) => JSON.parse(c.body)).some((m) => m.to[0] === 'later@example.test'), 'sent once the date comes');
  // nothing is sent twice
  const n = calls.filter((c) => c.host === 'api.resend.com').length;
  await post(h, { flush: true }, { 'x-cron-secret': ENV.CRON_SECRET });
  assert.equal(calls.filter((c) => c.host === 'api.resend.com').length, n);
});

await t('send-email: cover request emails reach the eligible staff, with the studio look', async () => {
  const row = (kind, to) => `insert into public.payroll_outbox (studio_id, kind, to_staff_id, to_email, payload) select '${SNOWY_ID}', '${kind}', id, email,
    jsonb_build_object('class_name', 'Mat Essentials', 'when', '6:00am Thu 22 Oct', 'requested_by', 'Grace', 'claimed_by', 'Julia', 'reason', 'Sick kid') from public.staff where email = '${to}'`;
  sql(`${row('cover_requested', 'julia@example.test')}; ${row('cover_claimed', 'libby@example.test')}; ${row('cover_approved', 'julia@example.test')}`);
  const h = await load('send-email');
  const before = calls.filter((c) => c.host === 'api.resend.com').length;
  const j = await (await post(h, { flush: true }, { 'x-cron-secret': ENV.CRON_SECRET })).json();
  assert.ok(j.sent >= 3 && j.failed === 0, JSON.stringify(j));
  const mails = calls.filter((c) => c.host === 'api.resend.com').slice(before).map((c) => JSON.parse(c.body));
  const ask = mails.find((m) => m.subject.startsWith('Cover needed'));
  assert.deepEqual(ask.to, ['julia@example.test']);
  assert.ok(ask.html.includes('Hi Julia') && ask.html.includes('Grace') && ask.html.includes('Sick kid') && ask.html.includes('Mat Essentials'));
  assert.ok(mails.some((m) => m.subject.startsWith('Cover claimed') && m.to[0] === 'libby@example.test'));
  assert.ok(mails.some((m) => m.subject.startsWith('Cover approved')));
  assert.equal(sql(`select count(*) from public.payroll_outbox where sent_at is null`), '0');
});

await t('invite-user: owners (or platform admins) email a login link for someone already on that studio\'s team', async () => {
  const h = await load('invite-user');
  const snowy = sql(`select id from public.studios where slug = 'snowy'`);
  sql(`insert into public.staff (name, email, role, studio_id) values ('Nell New', 'nell@example.test', 'instructor', '${snowy}')`);
  const as = (who) => ({ Authorization: `Bearer ${id(who)}` });
  let r = await post(h, { studioId: snowy, email: 'nell@example.test', name: 'Nell' }, as('julia'));
  assert.equal(r.status, 403, 'instructors can\'t invite');
  r = await post(h, { studioId: snowy, email: 'stranger@example.test' }, as('libby'));
  assert.equal(r.status, 404, 'only people already on the team');
  r = await post(h, { studioId: snowy, email: 'Nell@Example.test', name: 'Nell' }, as('libby'));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { invited: true });
  const inv = globalThis.__fake.invites.at(-1);
  assert.equal(inv.email, 'nell@example.test');
  assert.equal(inv.redirectTo, 'https://app.example/studio/?studio=snowy');
  assert.equal(inv.data.studio, 'snowy');
  ENV.PLATFORM_DOMAIN = 'studioplatform.app';
  r = await post(h, { studioId: snowy, email: 'nell@example.test' }, as('libby'));
  assert.equal(globalThis.__fake.invites.at(-1).redirectTo, 'https://snowy.studioplatform.app/studio/');
  delete ENV.PLATFORM_DOMAIN;
  r = await post(h, { studioId: snowy, email: 'julia@example.test' }, as('libby'));
  assert.deepEqual(await r.json(), { invited: false, existingLogin: true }, 'someone with a login just signs in');
  r = await post(h, { studioId: snowy, email: 'nell@example.test' });
  assert.equal(r.status, 401);
  sql(`delete from public.staff where email = 'nell@example.test'`);
});

await t('no secrets in the code: every key comes from the environment', () => {
  const r = spawnSync('grep', ['-rnE', 'sk_(live|test)_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{8,}|re_[A-Za-z0-9]{16,}|eyJhbGciOi', FN], { encoding: 'utf8' });
  assert.equal(r.stdout.trim(), '');
});

console.log(failed ? `\n  ${failed} edge function check(s) FAILED` : '\n  edge functions: all checks passed');
process.exit(failed ? 1 : 0);
