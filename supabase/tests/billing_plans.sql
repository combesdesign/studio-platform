-- 0012 + 2100: plans and platform billing. Only platform admins edit plans; owners read their own billing (nobody else, no other
-- studio); a studio's plan switches features on or off in SQL; past due -> read-only for staff after the grace period, clients unaffected.
\o /dev/null
begin;
select test.at('2026-10-19 08:00+11');

create function test.bp_studio(p_slug text) returns void language plpgsql as $$
begin
  perform set_config('app.studio', '', false);
  perform set_config('request.headers', case when p_slug is null then '' else json_build_object('x-studio', p_slug)::text end, false);
end $$;
create function test.bp_count(p_sql text) returns int language plpgsql as $$
declare n int;
begin execute 'select count(*) from (' || p_sql || ') x' into n; return n; end $$;
grant execute on function test.bp_studio(text), test.bp_count(text) to anon, authenticated, service_role;

insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values
  (gen_random_uuid(), 'pete@billing.test', '{"first_name":"Pete"}', now()),
  (gen_random_uuid(), 'bea@billing.test', '{"first_name":"Bea"}', now());
insert into test.ids select split_part(email, '@', 1), id from auth.users where email in ('pete@billing.test', 'bea@billing.test');
insert into public.platform_admins (user_id) values (test.id('pete'));

-- ------------------------------------------------------------- the seeded plans and Snowy
select test.eq((select count(*)::int from public.plans), 3, 'three draft plans are seeded');
select test.eq((select price_cents from public.plans where key = 'studio'), 9900, 'Studio is $99');
select test.ok('marketing' = any (select unnest(features) from public.plans where key = 'studio') and 'marketing' = any (select unnest(features) from public.plans where key = 'signature'), 'bulk email is in every plan');
select test.ok(not ('payroll' = any (select unnest(features) from public.plans where key = 'studio')) and 'payroll' = any (select unnest(features) from public.plans where key = 'studio_plus'), 'payroll starts on Studio Plus');
select test.eq((select p.key || '/' || s.billing_status || '/' || s.billing_comped from public.studios s join public.plans p on p.id = s.plan_id where s.is_default), 'signature/active/true', 'Snowy is on Signature, comped');
select test.ok(app.studio_has_feature(app.default_studio(), 'payroll') and app.studio_has_feature(app.default_studio(), 'multi_location'), 'Snowy has everything');

-- Studio B: a new studio starts on the cheapest plan with a trial.
select test.login('pete');
select (public.platform_create_studio('Billing B', 'billb', 'hello@billb.test') ->> 'id') as billb_id \gset
select test.admin();
insert into test.ids values ('billb', :'billb_id');
select test.eq((select p.key || '/' || s.billing_status from public.studios s join public.plans p on p.id = s.plan_id where s.slug = 'billb'), 'studio/trialing', 'a new studio starts on Studio, trialing');
select test.eq((select (trial_ends_at::date - now()::date) from public.studios where slug = 'billb'), 14, 'with the 14 day trial');
select test.ok(app.studio_has_feature(test.id('billb'), 'core') and app.studio_has_feature(test.id('billb'), 'marketing'), 'Studio: core and marketing on');
select test.ok(not app.studio_has_feature(test.id('billb'), 'payroll') and not app.studio_has_feature(test.id('billb'), 'appointments'), 'Studio: payroll and appointments locked');
select test.ok(not app.studio_has_feature(gen_random_uuid(), 'marketing'), 'an unknown studio has nothing');

-- ------------------------------------------------------------- only platform admins edit plans
select test.login('libby');
select test.eq((select count(*)::int from public.plans), 3, 'an owner can read the price list');
select test.throws($$update public.plans set price_cents = 1 where key = 'studio'$$, '42501', 'an owner can''t update a plan directly');
select test.throws($$insert into public.plans (key, name) values ('free', 'Free')$$, '42501', 'an owner can''t add a plan');
select test.throws($$delete from public.plans where key = 'studio'$$, '42501', 'an owner can''t delete a plan');
select test.throws($$select public.platform_save_plan(null, 'Free', 0)$$, 'NOT_ALLOWED', 'an owner can''t save a plan through the function');
select test.throws($$select public.platform_save_billing_settings(30, 7)$$, 'NOT_ALLOWED', 'an owner can''t change the trial or grace settings');
select test.throws($$select public.platform_set_studio_plan(app.default_studio(), (select id from public.plans where key = 'studio'))$$, 'NOT_ALLOWED', 'an owner can''t change their own plan by hand');
select test.login('mia');
select test.throws($$select public.platform_save_plan(null, 'Free', 0)$$, 'NOT_ALLOWED', 'a manager can''t save a plan');
select test.anon();
select test.eq((select count(*)::int from public.plans), 3, 'the public can read the price list');
select test.throws($$update public.plans set price_cents = 1$$, '42501', 'the public can''t edit it');

select test.login('pete');
select test.ok((public.platform_save_plan(null, 'Studio Max', 39900, null, array['kiosk','payroll']) ->> 'key') = 'studio_max', 'a platform admin adds a plan (core is added)');
select test.ok((select 'core' = any (features) and 'payroll' = any (features) from public.plans where key = 'studio_max'), 'the new plan has core and its features');
select test.ok((public.platform_save_plan((select id from public.plans where key = 'studio_max'), 'Studio Max', 41900, 'price_1Abc23', array['payroll','custom_domain']) ->> 'price_cents') = '41900', 'and edits its price, Stripe price id and features');
select test.eq((select stripe_price_id from public.plans where key = 'studio_max'), 'price_1Abc23', 'the Stripe price id is stored');
select test.throws($$select public.platform_save_plan(null, 'Bad', 100, 'not-a-price')$$, 'INVALID', 'a Stripe price id is checked');
select test.throws($$select public.platform_save_plan(null, 'Bad', -5)$$, '23514', 'a negative price is refused');
select test.throws($$select public.platform_save_plan(null, 'Studio', 100)$$, 'INVALID', 'plan handles are unique');
select test.eq((public.platform_save_billing_settings(30, null) ->> 'trial_days')::int, 30, 'the trial can be 30 days');
select test.throws($$select public.platform_save_billing_settings(21, null)$$, 'INVALID', 'but only 14 or 30');
select public.platform_save_billing_settings(14, 14);
-- comp a studio onto Studio Plus
select test.eq((public.platform_set_studio_plan(test.id('billb'), (select id from public.plans where key = 'studio_plus')) -> 'plan' ->> 'name'), 'Studio Plus', 'a platform admin puts a studio on a plan by hand');
select test.admin();
select test.ok(app.studio_has_feature(test.id('billb'), 'payroll') and not app.studio_has_feature(test.id('billb'), 'multi_location'), 'Studio Plus: payroll on, multi-location off');
select test.eq((select billing_comped from public.studios where slug = 'billb'), true, 'and it is marked comped');

-- ------------------------------------------------------------- owners read their own billing, nobody else
select test.service();
select public.billing_apply(app.default_studio(), null, 'active', 'cus_SNOWY1', 'sub_SNOWY1', '2026-11-19 00:00+11', false);
select public.billing_apply(test.id('billb'), null, 'active', 'cus_BEE1', 'sub_BEE1');
select test.eq((select billing_comped from public.studios where slug = 'billb'), false, 'a real subscription replaces the comp');
select test.admin();
select test.bp_studio('snowy');
select test.login('libby');
select test.eq((public.my_billing() ->> 'status'), 'active', 'the owner reads my_billing');
select test.eq((public.my_billing() ->> 'hasSubscription')::boolean, true, 'and sees there is a subscription');
select test.eq(test.bp_count($$select 1 from public.studio_billing$$), 1, 'the owner reads her own billing row');
select test.eq((select stripe_customer_id from public.studio_billing), 'cus_SNOWY1', 'including the Stripe customer');
select test.login('mia');
select test.eq(test.bp_count($$select 1 from public.studio_billing$$), 0, 'a manager sees no billing rows');
select test.throws($$select public.my_billing()$$, 'NOT_ALLOWED', 'a manager can''t call my_billing');
select test.login('fran');
select test.throws($$select public.my_billing()$$, 'NOT_ALLOWED', 'front desk can''t call my_billing');
select test.login('cara');
select test.eq(test.bp_count($$select 1 from public.studio_billing$$), 0, 'a client sees no billing rows');
select test.throws($$select public.my_billing()$$, 'NOT_ALLOWED', 'a client can''t call my_billing');
select test.anon();
select test.throws($$select count(*) from public.studio_billing$$, '42501', 'the public can''t read billing at all');
select test.login('libby');
select test.throws($$update public.studio_billing set stripe_customer_id = 'cus_EVIL'$$, '42501', 'the owner can''t edit billing');
select test.throws($$select public.billing_apply(app.default_studio(), null, 'cancelled')$$, '42501', 'the owner can''t call billing_apply');
select test.bp_studio('billb');
select test.eq(test.bp_count($$select 1 from public.studio_billing$$), 0, 'asking as another studio shows the owner nothing');
select test.bp_studio('snowy');

-- ------------------------------------------------------------- feature RPCs check the plan
select test.service();
select test.admin();
update public.studios set plan_id = (select id from public.plans where key = 'studio') where is_default;
select test.login('libby');
select test.throws($$select public.payroll_get_settings()$$, 'FEATURE_LOCKED', 'payroll RPCs are locked on Studio');
select test.throws($$select public.commerce_list_gift_cards()$$, 'FEATURE_LOCKED', 'commerce RPCs are locked on Studio');
select test.throws($$select public.ondemand_admin_list()$$, 'FEATURE_LOCKED', 'on-demand RPCs are locked on Studio');
select test.throws($$select public.integrations_list_partners()$$, 'FEATURE_LOCKED', 'integrations RPCs are locked on Studio');
select test.throws($$select public.appointments_list_types()$$, 'FEATURE_LOCKED', 'appointments RPCs are locked on Studio');
select test.ok((public.marketing_get_settings()) is not null, 'marketing is in Studio, so it works');
select test.admin();
update public.studios set plan_id = (select id from public.plans where key = 'signature') where is_default;
select test.login('libby');
select test.ok(public.payroll_get_settings() is not null, 'on Signature the payroll RPC works');
select test.ok(public.commerce_list_gift_cards() is not null, 'and commerce');

-- ------------------------------------------------------------- past due: banner, then read-only for staff after the grace period
select test.service();
select public.billing_apply(app.default_studio(), null, 'past_due');
select test.admin();
select test.ok((select past_due_since is not null from public.studios where is_default), 'past due records when it started');
select test.ok(not app.studio_read_only(app.default_studio()), 'past due, inside the grace period: still fully working');
select test.login('libby');
update public.class_types set description = 'still editable' where id = test.id('mat');
select test.eq((select description from public.class_types where id = test.id('mat')), 'still editable', 'staff can still edit inside the grace period');
select test.admin();
update public.studios set past_due_since = now() - interval '15 days' where is_default;
select test.ok(app.studio_read_only(app.default_studio()), 'past the 14 day grace period the studio is read-only');
select test.login('libby');
select test.throws($$update public.class_types set description = 'nope' where id = test.id('mat')$$, 'READ_ONLY', 'the owner can''t edit class types');
select test.throws($$insert into public.products (kind, name, price_cents) values ('retail', 'Socks', 500)$$, 'READ_ONLY', 'or add products');
select test.throws($$update public.studio_settings set cancel_window_hours = 5$$, 'READ_ONLY', 'or change settings');
select test.login('fran');
select test.throws($$select public.checkout_cart(test.id('gus_client'), jsonb_build_array(jsonb_build_object('product_id', test.id('p_single'))), 'cash')$$, 'READ_ONLY', 'front desk can''t sell at the POS');
select test.ok(test.bp_count($$select 1 from public.clients$$) > 0, 'but staff can still look at everything');
select test.login('alice');
select test.ok((public.book_class(test.id('s_fri')) -> 'booking' ->> 'status') is not null, 'a client can still book while the studio is read-only');
select test.admin();
update public.studios set past_due_since = now() - interval '15 days' where is_default;
select test.service();
select public.billing_apply(app.default_studio(), null, 'active');
select test.admin();
select test.ok(not app.studio_read_only(app.default_studio()), 'paying brings the studio straight back');
select test.ok((select past_due_since is null from public.studios where is_default), 'and clears the past due date');
select test.login('libby');
update public.class_types set description = 'editable again' where id = test.id('mat');
select test.ok(true, 'staff can edit again');
select test.admin();
-- cancelled and a trial that ended long ago are read-only too
update public.studios set billing_status = 'cancelled' where is_default;
select test.ok(app.studio_read_only(app.default_studio()), 'cancelled = read-only');
update public.studios set billing_status = 'trialing', trial_ends_at = now() - interval '20 days' where is_default;
select test.ok(app.studio_read_only(app.default_studio()), 'a trial that ended over the grace period ago = read-only');
update public.studios set trial_ends_at = now() - interval '2 days' where is_default;
select test.ok(not app.studio_read_only(app.default_studio()), 'a trial that just ended gets the grace period');
update public.studios set billing_status = null, trial_ends_at = null where is_default;
select test.ok(not app.studio_read_only(app.default_studio()), 'a studio with no billing is never read-only');
rollback;
