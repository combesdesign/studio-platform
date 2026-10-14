-- Committed setup for the race test: 10 clients with a pack each, one class with 3 spots.
\o /dev/null
select test.at('2026-10-18 12:00+11');
insert into auth.users (email, raw_user_meta_data, email_confirmed_at)
select 'race' || i || '@example.test', jsonb_build_object('first_name', 'Racer' || i), now() from generate_series(1, 10) i;
insert into test.ids select split_part(email, '@', 1), id from auth.users where email like 'race%';
update public.clients set waiver_signed_at = now() where email like 'race%';
select public.checkout_cart(c.id, jsonb_build_array(jsonb_build_object('product_id', test.id('p_pack4'))), 'cash')
  from public.clients c where c.email like 'race%';
select test.mk_session('race_session', 'mat', '2026-10-24 08:00+11', 3, 'libby');
select test.at('');
