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
  STRIPE_SECRET_KEY: 'sk_test_123', STRIPE_WEBHOOK_SECRET: 'whsec_test_secret', RESEND_API_KEY: 're_test', EMAIL_FROM: 'Studios <hello@studios.test>',
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
  if (u.host === 'sms.example') return reply({ ok: true });
  if (u.host === 'api.anthropic.com') return anthropic(JSON.parse(body));
  const p = u.pathname.replace('/v1/', '');
  if (p in stripeObjects) return reply(typeof stripeObjects[p] === 'function' ? stripeObjects[p](body) : stripeObjects[p]);
  return reply({ error: { message: `no stub for ${init.method} ${p}` } }, 404);
};

// Fake Anthropic Messages API for support-assist: set `anthropicReply` to a function (request body) -> Response, or leave it for a default answer.
let anthropicReply = null;
const anthropic = (req) => anthropicReply ? anthropicReply(req) : new Response(JSON.stringify({ content: [{ type: 'text', text: '{"answer":"1. Open Schedule.\\n2. Tap the class.","suggestHuman":false}' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });

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
    payload: { studio_name: 'Snowy Pilates Club', abn: '12 345 678 901', tax_id_label: 'ABN', tax_name: 'GST', total_cents: 11000, gst_cents: 1000, items: [{ qty: 1, name: '4 class pack', unit_cents: 11000 }] } });
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

await t('emails: a second studio gets its own details in every email, and no Snowy strings or colours', async () => {
  const studio = { studio_name: 'Harbour Reformer Co.', address: '12 Bay St, Double Bay', brand: { primary: '#1F4D3A', ink: '#10261D', soft: '#E7EFE9', bg: '#F4EFE4' },
    currency: 'NZD', locale: 'en-NZ', timezone: 'Pacific/Auckland', tax_id_label: 'NZBN', tax_name: 'GST', abn: '9429 0000 12345' };
  const p = { ...studio, first_name: 'Alice', class_name: 'Reformer Flow', when: '6:00pm Wed 21 Oct', cancellation_policy: 'Cancel 12 hours ahead or the credit is used.',
    total_cents: 11500, gst_cents: 1500, items: [{ qty: 1, name: '4 class pack', unit_cents: 11500 }], sale_id: 'abcdef123456' };
  const SNOWY = /Snowy|Cooma|5069AC|24345F|Vale Street|snowypilates/i;
  for (const kind of ['booking_confirmed', 'waitlist_promoted', 'class_cancelled', 'class_reminder', 'receipt', 'bogus']) {
    const m = H.render({ id: '1', kind, to_email: 'a@b.c', payload: p, attempts: 0 });
    const all = m.html + m.text + m.subject;
    assert.ok(!SNOWY.test(all), `${kind}: nothing of Snowy`);
    assert.ok(m.html.includes('#1F4D3A') && m.html.includes('Harbour Reformer Co.') && m.html.includes('12 Bay St, Double Bay'), `${kind}: their colours, name and address`);
    if (['booking_confirmed', 'waitlist_promoted', 'class_reminder'].includes(kind)) assert.ok(m.html.includes('Cancel 12 hours ahead') && m.text.includes('Cancel 12 hours ahead'), `${kind}: their policy`);
  }
  const r = H.render({ id: '1', kind: 'receipt', to_email: 'a@b.c', attempts: 0, payload: p });
  assert.ok(r.html.includes('NZBN 9429 0000 12345') && !r.html.includes('ABN') && r.html.includes('Total includes GST of') && r.html.includes('$115.00') && r.subject === 'Your receipt from Harbour Reformer Co.', 'their tax label and currency');
  // no branding at all: the neutral platform look, never Snowy's
  for (const kind of ['booking_confirmed', 'receipt', 'bogus']) {
    const m = H.render({ id: '1', kind, to_email: 'a@b.c', payload: { first_name: 'Al', class_name: 'Mat', when: 'now', total_cents: 1000, items: [] }, attempts: 0 });
    assert.ok(!SNOWY.test(m.html + m.text + m.subject), `${kind}: unbranded studio has no Snowy`);
    assert.ok(m.html.includes('#2F3B4C') && m.html.includes('Studio Platform'), `${kind}: platform defaults`);
  }
});

await t('send-email: queued booking and receipt emails go out as their own studio (sender, reply-to, colours, address, link, tax label)', async () => {
  const harbour = sql(`select id from public.studios where slug = 'harbour-fn'`);
  sql(`update public.studios set tax_id = '9429 0000 12345', tax_id_label = 'NZBN' where id = '${harbour}'`);
  const plain = sql(`insert into public.studios (slug, name, email, currency, status) values ('plain-fn', 'Plain Studio', 'hi@plain.test', 'AUD', 'live') returning id`).split('\n')[0];
  const queue = (studio, kind, to, extra) => sql(`insert into public.notifications (studio_id, kind, to_email, payload) values ('${studio}', '${kind}', '${to}',
    '{"first_name":"Al","class_name":"Reformer Flow","when":"6:00pm Wed 21 Oct","cancellation_policy":"Their own policy.","total_cents":5000,"gst_cents":0,"items":[{"qty":1,"name":"Drop in","unit_cents":5000}]${extra}}')`);
  queue(harbour, 'booking_confirmed', 'hb@example.test', '');
  queue(harbour, 'receipt', 'hr@example.test', '');
  queue(plain, 'booking_confirmed', 'pb@example.test', '');
  const h = await load('send-email');
  const before = calls.filter((c) => c.host === 'api.resend.com').length;
  const j = await (await post(h, { flush: true }, { 'x-cron-secret': ENV.CRON_SECRET })).json();
  assert.ok(j.sent >= 3 && j.failed === 0, JSON.stringify(j));
  const mails = calls.filter((c) => c.host === 'api.resend.com').slice(before).map((c) => JSON.parse(c.body));
  const SNOWY = /Snowy|Cooma|5069AC|24345F|snowypilates/i;
  const hb = mails.find((m) => m.to[0] === 'hb@example.test'), hr = mails.find((m) => m.to[0] === 'hr@example.test'), pb = mails.find((m) => m.to[0] === 'pb@example.test');
  assert.ok(hb && hr && pb, 'all three were sent');
  assert.ok(hb.from.startsWith('Harbour Reformer Co. <') && hb.reply_to === 'hello@harbour.test', 'their sender name and reply-to');
  assert.ok(hb.html.includes('#1F4D3A') && hb.html.includes('12 Bay St, Double Bay') && hb.html.includes('Their own policy.') && hb.html.includes('studio=harbour-fn'), 'their colours, address, policy and app link');
  assert.ok(hr.html.includes('NZBN 9429 0000 12345') && !hr.html.includes('ABN'), 'receipt carries the studio tax label');
  assert.ok(pb.from.startsWith('Plain Studio <') && pb.reply_to === 'hi@plain.test' && pb.html.includes('#2F3B4C') && !pb.html.includes('Cooma'), 'a studio with no branding gets the platform look');
  for (const m of mails) assert.ok(!SNOWY.test(m.html + m.text + m.subject + m.from), `no Snowy in the email to ${m.to[0]}`);
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

await t('partner-webhook (a stub): off by default, refuses unsigned calls, and books / cancels through the database when the check is skipped for local testing', async () => {
  const h = await load('partner-webhook');
  const S_THU = id('s_thu');
  const ev = (over = {}) => ({ partner: 'classpass', event: 'booking.created', studio_id: 'CP-FN', booking_id: 'FN-1', session_id: S_THU, member: { id: 'fn-m1', first_name: 'Wendy', last_name: 'Webhook' }, ...over });
  assert.equal((await post(h, ev())).status, 501, 'switched off unless PARTNER_WEBHOOK_ENABLED=true');
  ENV.PARTNER_WEBHOOK_ENABLED = 'true';
  try {
    const unsigned = await post(h, ev());
    assert.equal(unsigned.status, 401, 'the signature check is a TODO that rejects everything');
    assert.equal((await unsigned.json()).code, 'BAD_SIGNATURE');
    sql(`insert into public.integrations_partners (studio_id, partner, enabled, partner_studio_id) values ('${SNOWY_ID}', 'classpass', true, 'CP-FN');
         insert into public.integrations_reserved (studio_id, class_type_id, partner, spots) values ('${SNOWY_ID}', '${id('mat')}', 'classpass', 1)`);
    ENV.PARTNER_WEBHOOK_SKIP_VERIFY = 'true';
    assert.equal((await post(h, '{not json')).status, 400);
    const made = await post(h, ev());
    assert.equal(made.status, 200);
    const out = await made.json();
    assert.equal(out.duplicate, false);
    assert.equal(sql(`select pb.source || '/' || b.status from public.integrations_partner_bookings pb join public.bookings b on b.id = pb.booking_id where pb.booking_id = '${out.booking_id}'`), 'classpass/booked');
    assert.equal((await (await post(h, ev())).json()).duplicate, true, 'the same booking id twice is one booking');
    const full = await post(h, ev({ booking_id: 'FN-2', member: { id: 'fn-m2', first_name: 'Xavier', last_name: 'Extra' } }));
    assert.equal((await full.json()).code, 'NO_PARTNER_SPOTS', 'only one spot is held');
    assert.equal((await post(h, ev({ studio_id: 'CP-OTHER', booking_id: 'FN-3' }))).status, 400, 'an unknown studio ID is refused');
    assert.equal((await post(h, ev({ event: 'booking.moved' }))).status, 400);
    const cancelled = await (await post(h, ev({ event: 'booking.cancelled' }))).json();
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(sql(`select count(*) from public.bookings where id = '${out.booking_id}' and status = 'cancelled'`), '1');
  } finally {
    delete ENV.PARTNER_WEBHOOK_ENABLED; delete ENV.PARTNER_WEBHOOK_SKIP_VERIFY;
    sql(`delete from public.clients where first_name = 'Wendy' and last_name = 'Webhook';
         delete from public.integrations_reserved where studio_id = '${SNOWY_ID}'; delete from public.integrations_partners where studio_id = '${SNOWY_ID}'`);
  }
});

await t('send-reminders: an urgent support request is emailed to SUPPORT_ALERT_EMAIL (and posted to the SMS webhook), once', async () => {
  const req = (urgent, body) => sql(`insert into public.support_requests (studio_id, studio_name, created_by, staff_name, staff_role, body, urgent, route)
    values ('${SNOWY_ID}', 'Snowy Pilates Club', gen_random_uuid(), 'Fran', 'front_desk', '${body}', ${urgent}, '#/pos')`);
  req(false, 'How do I add a holiday closure?');
  assert.equal(sql(`select count(*) from public.support_alert_outbox`), '0', 'a normal request queues no alert');
  req(true, 'Clients cannot pay <b>for packs</b>');
  assert.equal(sql(`select count(*) from public.support_alert_outbox where sent_at is null`), '1');
  const h = await load('send-reminders');
  const run = async () => (await post(h, {}, { 'x-cron-secret': ENV.CRON_SECRET })).json();
  const mailsAfter = (n) => calls.filter((c) => c.host === 'api.resend.com').slice(n).map((c) => JSON.parse(c.body));
  try {
    await run();
    assert.equal(sql(`select count(*) from public.support_alert_outbox where sent_at is null`), '1', 'no SUPPORT_ALERT_EMAIL set: the alert waits');
    ENV.SUPPORT_ALERT_EMAIL = 'pete@support.test'; ENV.SUPPORT_ALERT_SMS_WEBHOOK = 'https://sms.example/hook';
    const before = calls.filter((c) => c.host === 'api.resend.com').length;
    const j = await run();
    assert.ok(j.sent >= 1 && j.failed === 0, JSON.stringify(j));
    const mails = mailsAfter(before).filter((m) => m.to[0] === 'pete@support.test');
    assert.equal(mails.length, 1);
    const m = mails[0];
    assert.ok(m.subject.startsWith('URGENT') && m.subject.includes('Snowy Pilates Club'));
    for (const bit of ['Snowy Pilates Club', 'Fran', 'Clients cannot pay', '#/pos', 'https://app.example/admin/#/support']) assert.ok(m.html.includes(bit) && m.text.includes(bit.replace('<b>', '')), `email has ${bit}`);
    assert.ok(!m.html.includes('<b>for packs'), 'the message is escaped');
    const hook = calls.find((c) => c.host === 'sms.example');
    assert.ok(hook, 'webhook called');
    const body = JSON.parse(hook.body);
    assert.equal(hook.method, 'POST');
    assert.deepEqual([body.kind, body.studio, body.person, body.page, body.inboxUrl], ['support_urgent', 'Snowy Pilates Club', 'Fran', '#/pos', 'https://app.example/admin/#/support']);
    assert.equal(sql(`select count(*) from public.support_alert_outbox where sent_at is null`), '0');
    const again = mailsAfter(before).filter((x) => x.to[0] === 'pete@support.test').length;
    await run();
    assert.equal(mailsAfter(before).filter((x) => x.to[0] === 'pete@support.test').length, again, 'sent once only');
  } finally {
    delete ENV.SUPPORT_ALERT_EMAIL; delete ENV.SUPPORT_ALERT_SMS_WEBHOOK;
    sql(`delete from public.support_requests where studio_id = '${SNOWY_ID}' and staff_name = 'Fran'`);
  }
});

await t('support-assist: staff get a written answer (Anthropic stubbed), no key is a 501, 30 a day, non-staff refused', async () => {
  const h = await load('support-assist');
  const as = (who) => ({ Authorization: `Bearer ${id(who)}` });
  const ask = (who, over = {}) => post(h, { question: 'How do I move a class?', page: '#/schedule', studioId: SNOWY_ID, ...over }, who ? as(who) : {});
  const asks = () => calls.filter((c) => c.host === 'api.anthropic.com');
  const logged = (who) => sql(`select count(*) from public.support_assist_log where user_id = '${id(who)}'`);
  try {
    // no key: 501, and nothing is called or counted
    let r = await ask('fran');
    assert.equal(r.status, 501);
    assert.equal(asks().length, 0);
    assert.equal(logged('fran'), '0');

    ENV.ANTHROPIC_API_KEY = 'sk-ant-test';
    // an answer: the right request goes to Anthropic
    r = await ask('fran');
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { answer: '1. Open Schedule.\n2. Tap the class.', suggestHuman: false });
    let call = asks().at(-1);
    let sent = JSON.parse(call.body);
    assert.equal(call.path, '/v1/messages');
    assert.equal(call.headers['x-api-key'], 'sk-ant-test');
    assert.equal(call.headers['anthropic-version'], '2023-06-01');
    assert.equal(sent.model, 'claude-haiku-5-5', 'default model');
    assert.equal(sent.max_tokens, 400);
    assert.match(sent.system, /Add a class/, 'the help articles are in the prompt');
    assert.match(sent.system, /Clients can book up to 14 days ahead/);
    assert.match(sent.system, /free of charge until 3 hours before class/);
    assert.match(sent.system, /never invent/i);
    assert.match(sent.messages[0].content, /How do I move a class\?/);
    assert.match(sent.messages[0].content, /#\/schedule/);
    assert.equal(logged('fran'), '1');

    // the model can be changed, and it can say "ask a person"
    ENV.SUPPORT_ASSIST_MODEL = 'claude-sonnet-5-5';
    anthropicReply = () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'Sure.\n```json\n{"answer":"That needs Pete.","suggestHuman":true}\n```' }] }), { status: 200 });
    r = await ask('fran', { question: 'A client was charged twice' });
    assert.deepEqual(await r.json(), { answer: 'That needs Pete.', suggestHuman: true });
    assert.equal(JSON.parse(asks().at(-1).body).model, 'claude-sonnet-5-5');
    delete ENV.SUPPORT_ASSIST_MODEL;

    // plain text back instead of JSON: still shown
    anthropicReply = () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'Open Schedule and tap the class.' }] }), { status: 200 });
    assert.equal((await (await ask('fran')).json()).answer, 'Open Schedule and tap the class.');

    // Anthropic down: a 502 the app answers from the articles instead
    anthropicReply = () => new Response('{"error":"overloaded"}', { status: 529 });
    r = await ask('fran');
    assert.equal(r.status, 502);
    assert.equal((await r.json()).code, 'ASSIST_FAILED');
    anthropicReply = null;

    // refused before Anthropic is called: not staff, signed out, another studio's staff, nothing asked
    const before = asks().length;
    assert.equal((await ask('alice')).status, 403, 'a client is not staff');
    assert.equal((await ask(null)).status, 401);
    const other = sql(`insert into public.studios (slug, name, email, currency, status) values ('assist-other', 'Other', 'o@assist.test', 'AUD', 'live') returning id`).split('\n')[0];
    assert.equal((await ask('fran', { studioId: other })).status, 403, 'staff of one studio cannot use another');
    assert.equal((await ask('fran', { question: ' ' })).status, 400);
    assert.equal(asks().length, before, 'none of those reached Anthropic');
    sql(`delete from public.studios where id = '${other}'`);

    // the daily cap: 30 in a rolling 24 hours, per person
    sql(`delete from public.support_assist_log where user_id = '${id('fran')}';
         insert into public.support_assist_log (user_id, studio_id, created_at) select '${id('fran')}', '${SNOWY_ID}', now() - interval '2 hours' from generate_series(1, 29);
         insert into public.support_assist_log (user_id, studio_id, created_at) select '${id('fran')}', '${SNOWY_ID}', now() - interval '30 hours' from generate_series(1, 10)`);
    assert.equal((await ask('fran')).status, 200, 'the 30th question in a day still works (older ones do not count)');
    const n = asks().length;
    r = await ask('fran');
    assert.equal(r.status, 429, 'the 31st does not');
    assert.equal((await r.json()).code, 'RATE_LIMITED');
    assert.equal(asks().length, n, 'and it never reaches Anthropic');
    assert.equal((await ask('mia')).status, 200, 'someone else is unaffected');
  } finally {
    delete ENV.ANTHROPIC_API_KEY; delete ENV.SUPPORT_ASSIST_MODEL; anthropicReply = null;
    sql(`delete from public.support_assist_log`);
  }
});

await t('no secrets in the code: every key comes from the environment', () => {
  const r = spawnSync('grep', ['-rnE', 'sk_(live|test)_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{8,}|re_[A-Za-z0-9]{16,}|eyJhbGciOi', FN], { encoding: 'utf8' });
  assert.equal(r.stdout.trim(), '');
});

console.log(failed ? `\n  ${failed} edge function check(s) FAILED` : '\n  edge functions: all checks passed');
process.exit(failed ? 1 : 0);
