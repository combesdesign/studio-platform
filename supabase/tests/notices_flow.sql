-- Notice board (3303): owner and manager post, edit, pin and remove; everyone in the studio reads what is still showing; clients and
-- other studios change nothing and see nothing of it. Obviously fake data only. "Now" is Monday 19 Oct 2026, 8:00am Sydney.
\o /dev/null
begin;
select test.at('2026-10-19 08:00+11');

create function test.nt_studio(p_slug text) returns void language plpgsql as $$
begin
  perform set_config('app.studio', '', false);
  perform set_config('request.headers', case when p_slug is null then '' else json_build_object('x-studio', p_slug)::text end, false);
end $$;
grant execute on all functions in schema test to anon, authenticated, service_role;

select test.login('libby');
select (public.notices_save('{"title":"  Studio closed Monday  ","body":"Public holiday.","linkUrl":"https://example.com/hours","showUntil":"2026-10-26","pinned":true}'::jsonb) ->> 'id') as n1 \gset
select (public.notices_save('{"title":"Bring a friend week"}'::jsonb) ->> 'id') as n2 \gset
select test.eq((select title from public.notices where id = :'n1'::uuid), 'Studio closed Monday', 'owner posts a notice (title trimmed)');
select test.eq((select count(*)::int from public.notices), 2, 'two notices');
select test.throws($$select public.notices_save('{"title":"   "}'::jsonb)$$, 'INVALID', 'a title is needed');
select test.throws(format($$select public.notices_save('{"title":"x","body":"%s"}'::jsonb)$$, repeat('x', 301)), 'INVALID', 'text is capped at 300 characters');
select test.throws($$select public.notices_save('{"title":"x","linkUrl":"javascript:alert(1)"}'::jsonb)$$, 'INVALID', 'links must be web addresses');
select test.throws($$select public.notices_save('{"title":"x","showUntil":"2026-10-18"}'::jsonb)$$, 'INVALID', 'show until can''t be in the past');
select test.throws($$select public.notices_save('{"title":"x","showUntil":"soon"}'::jsonb)$$, 'INVALID', 'show until must be a date');
select test.eq(public.notices_save(format('{"id":"%s","title":"Closed Monday 26th","pinned":false}', :'n1')::jsonb) ->> 'title', 'Closed Monday 26th', 'edit a notice');
select test.eq((select link_url from public.notices where id = :'n1'::uuid), null, '...a blank link clears it');
select test.eq(public.notices_set_pinned(:'n1'::uuid, true) ->> 'pinned', 'true', 'pin');

select test.login('mia');
select test.eq(public.notices_set_pinned(:'n2'::uuid, true) ->> 'pinned', 'true', 'a manager can pin too');

-- who reads what: a notice with an end date drops out for clients and front desk the day after, but owner and manager still see it
select test.admin();
update public.notices set show_until = '2026-10-19' where id = :'n1'::uuid;
select test.login('alice');
select test.eq((select count(*)::int from public.notices), 2, 'a client sees notices on their last day');
select test.throws($$select public.notices_save('{"title":"Nope"}'::jsonb)$$, 'NOT_ALLOWED', 'a client can''t post');
select test.throws(format('select public.notices_remove(%L)', :'n1'), 'NOT_ALLOWED', 'or remove');
select test.throws(format('select public.notices_set_pinned(%L, true)', :'n1'), 'NOT_ALLOWED', 'or pin');
select test.admin();
select test.at('2026-10-20 08:00+11');
select test.login('alice');
select test.eq((select count(*)::int from public.notices), 1, 'the day after, clients no longer see the finished one');
select test.login('fran');
select test.eq((select count(*)::int from public.notices), 1, 'front desk reads the active ones');
select test.throws($$select public.notices_save('{"title":"Nope"}'::jsonb)$$, 'NOT_ALLOWED', 'front desk can''t post');
select test.login('julia');
select test.throws(format('select public.notices_remove(%L)', :'n2'), 'NOT_ALLOWED', 'an instructor can''t remove');
select test.login('mia');
select test.eq((select count(*)::int from public.notices), 2, 'a manager still sees the finished one');
select test.login('libby');
select test.eq((select count(*)::int from public.notices), 2, '...and so does the owner');

-- another studio can't read, change or reach any of it
select test.admin();
insert into public.studios (slug, name, timezone, currency) values ('bayside', 'Bayside Test', 'Australia/Sydney', 'AUD') returning id as bay \gset
insert into public.studio_settings (studio_id, name) values (:'bay', 'Bayside Test');
insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values (gen_random_uuid(), 'owen@bay.test', '{"first_name":"Owen","studio":"bayside"}', now());
insert into public.staff (studio_id, name, email, role, user_id) values (:'bay', 'Owen', 'owen@bay.test', 'owner', (select id from auth.users where email = 'owen@bay.test'))
  on conflict do nothing;
update public.staff set user_id = (select id from auth.users where email = 'owen@bay.test') where email = 'owen@bay.test' and studio_id = :'bay';
insert into test.ids select 'owen', id from auth.users where email = 'owen@bay.test';
select test.login('owen');
select test.nt_studio('bayside');
select test.eq((select count(*)::int from public.notices), 0, 'studio B sees none of studio A''s notices');
select test.throws(format('select public.notices_remove(%L)', :'n2'), 'NOT_FOUND', 'and can''t remove one');
select test.throws(format('select public.notices_set_pinned(%L, false)', :'n2'), 'NOT_FOUND', 'or pin one');
select test.throws(format($$select public.notices_save('{"id":"%s","title":"Hijack"}'::jsonb)$$, :'n2'), 'NOT_FOUND', 'or edit one');
select (public.notices_save('{"title":"Bayside news"}'::jsonb) ->> 'id') as nb \gset
select test.eq((select count(*)::int from public.notices), 1, 'studio B has its own');
select test.nt_studio(null);
select test.login('libby');
select test.eq((select count(*)::int from public.notices where title = 'Bayside news'), 0, 'studio A never sees studio B''s');
select test.eq(public.notices_save('{"title":"Back in A"}'::jsonb) ->> 'title', 'Back in A', 'and posting in A goes to A');
select public.notices_remove(:'n2'::uuid);
select test.eq((select count(*)::int from public.notices), 2, 'owner removes a notice (one gone, one new)');

rollback;
