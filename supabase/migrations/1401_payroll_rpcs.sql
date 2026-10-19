-- Payroll RPCs (ROADMAP B4). Same rules and error codes as the demo store (src/features/payroll/demo.ts); the
-- permission map is in 1400_payroll_tables.sql and src/features/payroll/permissions.ts.
-- Rows go back as to_jsonb(row) (snake_case); src/features/payroll/live.ts maps them. Pay itself is worked out in
-- TypeScript (calc.ts) from payroll_period_inputs + the RLS-readable rules, timesheets and adjustments, so the demo
-- and live stores share one calculation.

-- ---------------------------------------------------------------- internal helpers (not callable by users)

create or replace function public.payroll_sdate(p_at timestamptz) returns date
language sql stable security definer set search_path = public, pg_temp as $$ select (p_at at time zone app.tz())::date $$;

create or replace function public.payroll_me() returns public.staff
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v public.staff;
begin
  select * into v from public.staff where user_id = auth.uid() and active and studio_id = app.current_studio_id();
  if v.id is null then perform app.fail('NOT_ALLOWED', 'Only staff can do that.'); end if;
  return v;
end $$;

create or replace function public.payroll_require(p_roles text[]) returns public.staff
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v public.staff := public.payroll_me();
begin
  if not (v.role = any(p_roles)) then perform app.fail('NOT_ALLOWED', 'You don''t have permission to do that.'); end if;
  return v;
end $$;

create or replace function public.payroll_settings_json() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select jsonb_build_object('frequency', frequency, 'period_anchor', period_anchor, 'cover_auto_approve', cover_auto_approve)
                     from public.payroll_settings where studio_id = app.current_studio_id()),
                  jsonb_build_object('frequency', 'weekly', 'period_anchor', '2024-01-01', 'cover_auto_approve', false))
$$;

-- Any paid run covering this studio date? Then its timesheets, adjustments and pay are frozen.
create or replace function public.payroll_assert_open(p_date date) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if exists (select 1 from public.payroll_runs where studio_id = app.current_studio_id() and p_date between period_from and period_to) then
    perform app.fail('PERIOD_PAID', 'That pay period has already been paid. Reopen it first if it needs a change.');
  end if;
end $$;

-- Who is told about, and may claim, a class that needs cover: active teachers other than the person asking.
create or replace function public.payroll_eligible(p_requester uuid) returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select st.id from public.staff st
   where st.studio_id = app.current_studio_id() and st.active and st.id <> p_requester
     and (st.role = 'instructor'
          or exists (select 1 from public.schedule_templates t where t.studio_id = st.studio_id and t.active and t.instructor_id = st.id)
          or exists (select 1 from public.class_sessions s where s.studio_id = st.studio_id and s.instructor_id = st.id))
$$;

-- Is this person already teaching something that overlaps the class?
create or replace function public.payroll_clash(p_staff uuid, p_session uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.class_sessions s join public.class_sessions o
                   on o.studio_id = s.studio_id and o.id <> s.id and o.instructor_id = p_staff and o.status = 'scheduled'
                  and o.starts_at < s.ends_at and o.ends_at > s.starts_at
                where s.id = p_session)
$$;

-- A request as the app sees it: the row, its class, the live status (expired once the class starts) and canClaim.
create or replace function public.payroll_cover_json(r public.payroll_cover_requests, p_viewer uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare s public.class_sessions; v_status text := r.status; v_can boolean;
begin
  if r.id is null then return null; end if;
  select * into s from public.class_sessions where id = r.session_id;
  if s.id is null then return null; end if;
  if r.status in ('open','claimed') then
    if s.status = 'cancelled' then v_status := 'cancelled';
    elsif s.starts_at <= app.now() then v_status := 'expired';
    end if;
  end if;
  v_can := p_viewer is not null and v_status = 'open' and p_viewer <> r.requested_by and not (p_viewer = any(r.declined_by))
           and exists (select 1 from public.payroll_eligible(r.requested_by) e(id) where e.id = p_viewer)
           and not public.payroll_clash(p_viewer, s.id);
  return to_jsonb(r) || jsonb_build_object(
    'status', v_status, 'can_claim', v_can,
    'session', jsonb_build_object('id', s.id, 'class_type_id', s.class_type_id, 'starts_at', s.starts_at, 'ends_at', s.ends_at,
                                  'instructor_id', s.instructor_id, 'status', s.status));
end $$;

-- open / claimed and the class hasn't started or been cancelled
create or replace function public.payroll_need_live(r public.payroll_cover_requests) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare s public.class_sessions;
begin
  if r.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that cover request.'); end if;
  if r.status = 'cancelled' then perform app.fail('CANCELLED', 'That request was cancelled.'); end if;
  if r.status = 'approved' then perform app.fail('ALREADY_COVERED', 'That class already has its cover sorted.'); end if;
  select * into s from public.class_sessions where id = r.session_id;
  if s.status = 'cancelled' then perform app.fail('CANCELLED', 'That class has been cancelled.'); end if;
  if s.starts_at <= app.now() then perform app.fail('TOO_LATE', 'That class has already started.'); end if;
end $$;

-- Queue staff emails (the email hook on live; the in-app notice is the cover list itself).
create or replace function public.payroll_notify(p_kind text, p_to uuid[], r public.payroll_cover_requests) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into public.payroll_outbox (studio_id, kind, to_staff_id, to_email, payload)
  select r.studio_id, p_kind, st.id, nullif(st.email, ''),
         jsonb_build_object('request_id', r.id, 'session_id', r.session_id, 'class_name', ct.name, 'starts_at', s.starts_at,
                            'when', app.fmt_when_tz(s.starts_at, app.tz()), 'requested_by', rq.name, 'claimed_by', cl.name,
                            'reason', r.reason, 'note', r.decision_note)
    from public.staff st
    join public.class_sessions s on s.id = r.session_id
    join public.class_types ct on ct.id = s.class_type_id
    join public.staff rq on rq.id = r.requested_by
    left join public.staff cl on cl.id = r.claimed_by
   where st.studio_id = r.studio_id and st.active and st.id = any(p_to)
$$;

-- Approve a claim: the class's instructor becomes the claimer (live counterpart of engine.upsertSession in the demo).
create or replace function public.payroll_approve_now(p_id uuid, p_by uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.payroll_cover_requests; s public.class_sessions;
begin
  select * into r from public.payroll_cover_requests where id = p_id for update;
  if r.claimed_by is null then perform app.fail('INVALID', 'Nobody has claimed this yet.'); end if;
  select * into s from public.class_sessions where id = r.session_id for update;
  if s.instructor_id <> r.requested_by then
    perform app.fail('CHANGED', 'This class has a different instructor now, so the request is out of date.');
  end if;
  update public.class_sessions set instructor_id = r.claimed_by where id = s.id;
  update public.payroll_cover_requests
     set status = 'approved', decided_at = app.now(), decided_by = p_by, auto_approved = (p_by is null)
   where id = r.id returning * into r;
  perform public.payroll_notify('cover_approved', array[r.claimed_by, r.requested_by], r);
end $$;

-- ---------------------------------------------------------------- settings

create or replace function public.payroll_get_settings() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.payroll_me();
  return public.payroll_settings_json();
end $$;

create or replace function public.payroll_update_settings(p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.staff := public.payroll_me(); cur jsonb := public.payroll_settings_json(); v_anchor date;
begin
  perform app.assert_studio_open(app.current_studio_id());
  if p_patch ? 'frequency' or p_patch ? 'period_anchor' then
    if me.role <> 'owner' then perform app.fail('NOT_ALLOWED', 'Only the owner can change the pay period.'); end if;
    if p_patch ? 'frequency' then
      if (p_patch ->> 'frequency') not in ('weekly','fortnightly') or p_patch ->> 'frequency' is null then
        perform app.fail('INVALID', 'Pick weekly or fortnightly.');
      end if;
      cur := cur || jsonb_build_object('frequency', p_patch ->> 'frequency');
    end if;
    if p_patch ? 'period_anchor' then
      begin v_anchor := (p_patch ->> 'period_anchor')::date;
      exception when others then perform app.fail('INVALID', 'Pick the first day of a pay period.'); end;
      if v_anchor is null then perform app.fail('INVALID', 'Pick the first day of a pay period.'); end if;
      cur := cur || jsonb_build_object('period_anchor', v_anchor);
    end if;
  end if;
  if p_patch ? 'cover_auto_approve' then
    if me.role not in ('owner','manager') then perform app.fail('NOT_ALLOWED', 'Only the owner or a manager can change that.'); end if;
    cur := cur || jsonb_build_object('cover_auto_approve', coalesce((p_patch ->> 'cover_auto_approve')::boolean, false));
  end if;
  insert into public.payroll_settings (studio_id, frequency, period_anchor, cover_auto_approve, updated_at)
  values (app.current_studio_id(), cur ->> 'frequency', (cur ->> 'period_anchor')::date, (cur ->> 'cover_auto_approve')::boolean, now())
  on conflict (studio_id) do update set frequency = excluded.frequency, period_anchor = excluded.period_anchor,
    cover_auto_approve = excluded.cover_auto_approve, updated_at = now();
  return public.payroll_settings_json();
end $$;

-- ---------------------------------------------------------------- cover

create or replace function public.payroll_list_cover() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare me public.staff := public.payroll_me();
begin
  return coalesce((
    select jsonb_agg(public.payroll_cover_json(r, me.id) order by s.starts_at)
      from public.payroll_cover_requests r join public.class_sessions s on s.id = r.session_id
     where r.studio_id = app.current_studio_id() and s.starts_at >= app.now() - interval '60 days'), '[]'::jsonb);
end $$;

create or replace function public.payroll_cover_for_session(p_session_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare me public.staff := public.payroll_me(); v jsonb; r public.payroll_cover_requests;
begin
  perform app.assert_in_studio('class_sessions', p_session_id, 'We couldn''t find that class.');
  for r in select * from public.payroll_cover_requests where session_id = p_session_id and studio_id = app.current_studio_id()
           order by (status in ('open','claimed')) desc, decided_at desc nulls last loop
    v := public.payroll_cover_json(r, me.id);
    if v ->> 'status' in ('open','claimed','approved') then return v; end if;
  end loop;
  return null;
end $$;

create or replace function public.payroll_request_cover(p_session_id uuid, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.staff := public.payroll_me(); s public.class_sessions; r public.payroll_cover_requests;
begin
  perform app.assert_studio_open(app.current_studio_id());
  perform app.assert_in_studio('class_sessions', p_session_id, 'We couldn''t find that class.');
  select * into s from public.class_sessions where id = p_session_id for update;
  if s.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that class.'); end if;
  if s.instructor_id <> me.id and me.role not in ('owner','manager') then
    perform app.fail('NOT_ALLOWED', 'You can ask for cover on your own classes.');
  end if;
  if s.status = 'cancelled' then perform app.fail('CANCELLED', 'That class has been cancelled.'); end if;
  if s.starts_at <= app.now() then perform app.fail('TOO_LATE', 'That class has already started.'); end if;
  if exists (select 1 from public.payroll_cover_requests where session_id = s.id and status in ('open','claimed')) then
    perform app.fail('ALREADY_REQUESTED', 'Cover has already been asked for on this class.');
  end if;
  insert into public.payroll_cover_requests (studio_id, session_id, requested_by, posted_by, reason, notified, created_at)
  values (s.studio_id, s.id, s.instructor_id, me.id, nullif(left(btrim(coalesce(p_reason, '')), 300), ''),
          coalesce((select array_agg(e.id) from public.payroll_eligible(s.instructor_id) e(id)), '{}'), app.now())
  returning * into r;
  perform public.payroll_notify('cover_requested', r.notified, r);
  return public.payroll_cover_json(r, me.id);
end $$;

create or replace function public.payroll_claim_cover(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.staff := public.payroll_me(); r public.payroll_cover_requests;
begin
  perform app.assert_studio_open(app.current_studio_id());
  perform app.assert_in_studio('payroll_cover_requests', p_id, 'We couldn''t find that cover request.');
  select * into r from public.payroll_cover_requests where id = p_id and studio_id = app.current_studio_id() for update;
  perform public.payroll_need_live(r);
  if r.status <> 'open' then perform app.fail('ALREADY_CLAIMED', 'Someone else has already put their hand up for this one.'); end if;
  if r.requested_by = me.id then perform app.fail('NOT_ALLOWED', 'This is your own class.'); end if;
  if me.id = any(r.declined_by) then perform app.fail('NOT_ALLOWED', 'Your earlier offer for this class wasn''t accepted.'); end if;
  if not exists (select 1 from public.payroll_eligible(r.requested_by) e(id) where e.id = me.id) then
    perform app.fail('NOT_ALLOWED', 'Cover requests go to the people who teach here.');
  end if;
  if public.payroll_clash(me.id, r.session_id) then perform app.fail('CONFLICT', 'You''re already teaching at that time.'); end if;
  update public.payroll_cover_requests set status = 'claimed', claimed_by = me.id, claimed_at = app.now() where id = r.id returning * into r;
  if (public.payroll_settings_json() ->> 'cover_auto_approve')::boolean then
    perform public.payroll_approve_now(r.id, null);
  else
    perform public.payroll_notify('cover_claimed',
      coalesce((select array_agg(id) from public.staff where studio_id = r.studio_id and active and role in ('owner','manager')), '{}'), r);
  end if;
  select * into r from public.payroll_cover_requests where id = p_id;
  return public.payroll_cover_json(r, me.id);
end $$;

create or replace function public.payroll_withdraw_claim(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.staff := public.payroll_me(); r public.payroll_cover_requests;
begin
  perform app.assert_studio_open(app.current_studio_id());
  perform app.assert_in_studio('payroll_cover_requests', p_id, 'We couldn''t find that cover request.');
  select * into r from public.payroll_cover_requests where id = p_id and studio_id = app.current_studio_id() for update;
  perform public.payroll_need_live(r);
  if r.status <> 'claimed' then perform app.fail('INVALID', 'Nobody has claimed this one.'); end if;
  if r.claimed_by <> me.id and me.role not in ('owner','manager') then
    perform app.fail('NOT_ALLOWED', 'Only the person who claimed it can step back.');
  end if;
  update public.payroll_cover_requests set status = 'open', claimed_by = null, claimed_at = null where id = r.id returning * into r;
  return public.payroll_cover_json(r, me.id);
end $$;

create or replace function public.payroll_decide_cover(p_id uuid, p_decision text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.staff := public.payroll_require(array['owner','manager']); r public.payroll_cover_requests; v_claimer uuid;
begin
  perform app.assert_studio_open(app.current_studio_id());
  perform app.assert_in_studio('payroll_cover_requests', p_id, 'We couldn''t find that cover request.');
  if p_decision not in ('approve','decline') then perform app.fail('INVALID', 'Approve or decline.'); end if;
  select * into r from public.payroll_cover_requests where id = p_id and studio_id = app.current_studio_id() for update;
  perform public.payroll_need_live(r);
  if r.status <> 'claimed' or r.claimed_by is null then perform app.fail('INVALID', 'There''s no claim to decide on yet.'); end if;
  if nullif(btrim(coalesce(p_note, '')), '') is not null then
    update public.payroll_cover_requests set decision_note = left(btrim(p_note), 300) where id = r.id;
  end if;
  if p_decision = 'approve' then
    perform public.payroll_approve_now(r.id, me.id);
  else
    v_claimer := r.claimed_by;
    update public.payroll_cover_requests
       set status = 'open', declined_by = declined_by || v_claimer, claimed_by = null, claimed_at = null
     where id = r.id returning * into r;
    perform public.payroll_notify('cover_declined', array[v_claimer], r);
  end if;
  select * into r from public.payroll_cover_requests where id = p_id;
  return public.payroll_cover_json(r, me.id);
end $$;

create or replace function public.payroll_cancel_cover(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.staff := public.payroll_me(); r public.payroll_cover_requests;
begin
  perform app.assert_studio_open(app.current_studio_id());
  perform app.assert_in_studio('payroll_cover_requests', p_id, 'We couldn''t find that cover request.');
  select * into r from public.payroll_cover_requests where id = p_id and studio_id = app.current_studio_id() for update;
  perform public.payroll_need_live(r);
  if r.posted_by <> me.id and r.requested_by <> me.id and me.role not in ('owner','manager') then
    perform app.fail('NOT_ALLOWED', 'Only the person who asked can cancel this.');
  end if;
  update public.payroll_cover_requests set status = 'cancelled' where id = r.id returning * into r;
  return public.payroll_cover_json(r, me.id);
end $$;

-- ---------------------------------------------------------------- pay rules (owner)

create or replace function public.payroll_save_rule(p_rule jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me public.staff := public.payroll_require(array['owner']);
  v_id uuid := nullif(p_rule ->> 'id', '')::uuid;
  v_staff uuid := nullif(p_rule ->> 'staff_id', '')::uuid;
  v_kind text := p_rule ->> 'kind';
  v_ct uuid := nullif(p_rule ->> 'class_type_id', '')::uuid;
  v_key text := left(btrim(regexp_replace(lower(coalesce(p_rule ->> 'session_type', '')), '[^a-z0-9]+', '_', 'g'), '_'), 40);
  v_active boolean := coalesce((p_rule ->> 'active')::boolean, true);
  v_tiers jsonb := null;
  v_rate int; v_base int; v_head int; v_above int;
  r public.payroll_pay_rules;
  t jsonb;
begin
  perform app.assert_studio_open(app.current_studio_id());
  if v_kind is null or v_kind not in ('flat','per_head','tiered','hourly','session') then perform app.fail('INVALID', 'Pick how this person is paid.'); end if;
  perform app.assert_in_studio('staff', v_staff, 'We couldn''t find that staff member.');
  if v_staff is null or not exists (select 1 from public.staff where id = v_staff and studio_id = app.current_studio_id()) then
    perform app.fail('NOT_FOUND', 'We couldn''t find that staff member.');
  end if;
  if v_kind not in ('flat','per_head','tiered') then v_ct := null; end if;
  if v_ct is not null then
    perform app.assert_in_studio('class_types', v_ct, 'We couldn''t find that class type.');
    if not exists (select 1 from public.class_types where id = v_ct and studio_id = app.current_studio_id()) then
      perform app.fail('NOT_FOUND', 'We couldn''t find that class type.');
    end if;
  end if;
  begin
    v_rate := round(coalesce((p_rule ->> 'rate_cents')::numeric, 0));
    v_base := round(coalesce((p_rule ->> 'base_cents')::numeric, 0));
    v_head := round(coalesce((p_rule ->> 'per_head_cents')::numeric, 0));
    v_above := round(coalesce((p_rule ->> 'above_n')::numeric, 0));
  exception when others then perform app.fail('INVALID', 'Check the amounts.');
  end;
  if least(v_rate, v_base, v_head, v_above) < 0 or greatest(v_rate, v_base, v_head) > 10000000 or v_above > 10000 then
    perform app.fail('INVALID', 'Check the amounts.');
  end if;
  if v_kind in ('hourly','session') and v_rate < 1 then perform app.fail('INVALID', 'Check the rate.'); end if;
  if v_kind = 'session' and v_key = '' then perform app.fail('INVALID', 'Say which kind of session this is for, like “private”.'); end if;
  if v_kind = 'tiered' then
    if jsonb_typeof(p_rule -> 'tiers') <> 'array' or jsonb_array_length(p_rule -> 'tiers') = 0 then perform app.fail('INVALID', 'Add at least one tier.'); end if;
    begin
      select jsonb_agg(jsonb_build_object('minAttendees', m, 'payCents', c) order by m), count(distinct m) = count(*)
        into v_tiers, v_active
        from (select round((x ->> 'minAttendees')::numeric)::int m, round((x ->> 'payCents')::numeric)::int c from jsonb_array_elements(p_rule -> 'tiers') x) y;
    exception when others then perform app.fail('INVALID', 'Check the attendance tiers.');
    end;
    if not v_active then perform app.fail('INVALID', 'Two tiers start at the same number of attendees.'); end if;
    v_active := coalesce((p_rule ->> 'active')::boolean, true);
    for t in select * from jsonb_array_elements(v_tiers) loop
      if (t ->> 'minAttendees') is null or (t ->> 'payCents') is null or (t ->> 'minAttendees')::int < 0 or (t ->> 'payCents')::int < 0
         or (t ->> 'payCents')::int > 10000000 then
        perform app.fail('INVALID', 'Check the attendance tiers.');
      end if;
    end loop;
  end if;
  if v_active and exists (select 1 from public.payroll_pay_rules x where x.studio_id = app.current_studio_id() and x.active and x.staff_id = v_staff
                            and x.id is distinct from v_id
                            and x.slot = case v_kind when 'hourly' then 'hourly' when 'session' then 'session:' || v_key
                                                     else 'class:' || coalesce(v_ct::text, '*') end) then
    perform app.fail('DUPLICATE_RULE', 'There''s already a rule like that for this person. Edit it instead of adding a second.');
  end if;
  if v_id is not null then
    perform app.assert_in_studio('payroll_pay_rules', v_id, 'We couldn''t find that rule.');
    update public.payroll_pay_rules set
      staff_id = v_staff, kind = v_kind, earnings_rate = nullif(left(btrim(coalesce(p_rule ->> 'earnings_rate', '')), 60), ''),
      class_type_id = v_ct, session_type = case when v_kind = 'session' then v_key end,
      rate_cents = case when v_kind in ('flat','hourly','session') then v_rate end,
      per_hour = (v_kind = 'session' and coalesce((p_rule ->> 'per_hour')::boolean, false)),
      base_cents = case when v_kind = 'per_head' then v_base end, per_head_cents = case when v_kind = 'per_head' then v_head end,
      above_n = case when v_kind = 'per_head' then v_above end, tiers = v_tiers, active = v_active, updated_at = now()
    where id = v_id and studio_id = app.current_studio_id() returning * into r;
    if r.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that rule.'); end if;
  else
    insert into public.payroll_pay_rules (studio_id, staff_id, kind, earnings_rate, class_type_id, session_type, rate_cents, per_hour,
                                          base_cents, per_head_cents, above_n, tiers, active)
    values (app.current_studio_id(), v_staff, v_kind, nullif(left(btrim(coalesce(p_rule ->> 'earnings_rate', '')), 60), ''), v_ct,
            case when v_kind = 'session' then v_key end, case when v_kind in ('flat','hourly','session') then v_rate end,
            (v_kind = 'session' and coalesce((p_rule ->> 'per_hour')::boolean, false)),
            case when v_kind = 'per_head' then v_base end, case when v_kind = 'per_head' then v_head end,
            case when v_kind = 'per_head' then v_above end, v_tiers, v_active)
    returning * into r;
  end if;
  return to_jsonb(r);
end $$;

create or replace function public.payroll_delete_rule(p_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.payroll_require(array['owner']);
  perform app.assert_studio_open(app.current_studio_id());
  perform app.assert_in_studio('payroll_pay_rules', p_id, 'We couldn''t find that rule.');
  delete from public.payroll_pay_rules where id = p_id and studio_id = app.current_studio_id();
  if not found then perform app.fail('NOT_FOUND', 'We couldn''t find that rule.'); end if;
end $$;

-- ---------------------------------------------------------------- timesheets

create or replace function public.payroll_clocks_in(p_staff public.staff) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select p_staff.role = 'front_desk'
      or exists (select 1 from public.payroll_pay_rules where staff_id = p_staff.id and kind = 'hourly' and active)
$$;

create or replace function public.payroll_clock_status() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare me public.staff := public.payroll_me(); v_open public.payroll_timesheets; v_today date := public.payroll_sdate(app.now());
begin
  select * into v_open from public.payroll_timesheets where staff_id = me.id and kind = 'shift' and ended_at is null;
  return jsonb_build_object(
    'eligible', public.payroll_clocks_in(me),
    'open', case when v_open.id is null then null else to_jsonb(v_open) end,
    'today_minutes', coalesce((select sum(greatest(0, round(extract(epoch from ended_at - started_at) / 60) - break_min))
                                 from public.payroll_timesheets
                                where staff_id = me.id and kind = 'shift' and status <> 'rejected' and ended_at is not null
                                  and public.payroll_sdate(started_at) = v_today), 0));
end $$;

create or replace function public.payroll_clock_in(p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.staff := public.payroll_me(); e public.payroll_timesheets;
begin
  perform app.assert_studio_open(app.current_studio_id());
  if not public.payroll_clocks_in(me) then
    perform app.fail('NOT_ALLOWED', 'Clocking in is for front desk shifts. Ask the owner to set you up with an hourly rate.');
  end if;
  if exists (select 1 from public.payroll_timesheets where staff_id = me.id and kind = 'shift' and ended_at is null) then
    perform app.fail('ALREADY_CLOCKED_IN', 'You''re already clocked in.');
  end if;
  perform public.payroll_assert_open(public.payroll_sdate(app.now()));
  insert into public.payroll_timesheets (studio_id, staff_id, kind, started_at, source, status, note, created_by, created_at)
  values (me.studio_id, me.id, 'shift', app.now(), 'clock', 'pending', nullif(left(btrim(coalesce(p_note, '')), 200), ''), me.id, app.now())
  returning * into e;
  return to_jsonb(e);
end $$;

create or replace function public.payroll_clock_out() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.staff := public.payroll_me(); e public.payroll_timesheets;
begin
  perform app.assert_studio_open(app.current_studio_id());
  select * into e from public.payroll_timesheets where staff_id = me.id and kind = 'shift' and ended_at is null for update;
  if e.id is null then perform app.fail('NOT_CLOCKED_IN', 'You''re not clocked in.'); end if;
  update public.payroll_timesheets set ended_at = greatest(app.now(), started_at + interval '1 minute') where id = e.id returning * into e;
  return to_jsonb(e);
end $$;

create or replace function public.payroll_list_timesheets(p_from date, p_to date, p_staff_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare me public.staff := public.payroll_me(); v_all boolean;
begin
  v_all := me.role in ('owner','manager');
  if p_staff_id is not null and p_staff_id <> me.id and not v_all then perform app.fail('NOT_ALLOWED', 'You can see your own timesheet.'); end if;
  return coalesce((
    select jsonb_agg(to_jsonb(e) order by e.started_at desc) from public.payroll_timesheets e
     where e.studio_id = app.current_studio_id()
       and (case when v_all then p_staff_id is null or e.staff_id = p_staff_id else e.staff_id = me.id end)
       and public.payroll_sdate(e.started_at) between p_from and p_to), '[]'::jsonb);
end $$;

create or replace function public.payroll_save_timesheet(p_entry jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me public.staff := public.payroll_me();
  v_manager boolean := me.role in ('owner','manager');
  v_approver boolean := me.role = 'owner';
  v_id uuid := nullif(p_entry ->> 'id', '')::uuid;
  v_old public.payroll_timesheets;
  v_staff uuid; v_kind text; v_start timestamptz; v_end timestamptz; v_break int; v_units int; v_key text := '';
  e public.payroll_timesheets;
begin
  perform app.assert_studio_open(app.current_studio_id());
  if v_id is not null then
    perform app.assert_in_studio('payroll_timesheets', v_id, 'We couldn''t find that entry.');
    select * into v_old from public.payroll_timesheets where id = v_id and studio_id = app.current_studio_id() for update;
    if v_old.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that entry.'); end if;
  end if;
  v_staff := coalesce(v_old.staff_id, nullif(p_entry ->> 'staff_id', '')::uuid, me.id);
  if v_staff <> me.id and not v_manager then perform app.fail('NOT_ALLOWED', 'You can add hours to your own timesheet.'); end if;
  perform app.assert_in_studio('staff', v_staff, 'We couldn''t find that staff member.');
  if not exists (select 1 from public.staff where id = v_staff and studio_id = app.current_studio_id() and active) then
    perform app.fail('NOT_FOUND', 'We couldn''t find that staff member.');
  end if;
  v_kind := coalesce(v_old.kind, p_entry ->> 'kind', 'shift');
  if v_kind not in ('shift','session') then perform app.fail('INVALID', 'Pick a shift or a session.'); end if;
  if v_kind = 'session' and not v_manager then perform app.fail('NOT_ALLOWED', 'The owner or a manager logs private sessions.'); end if;
  if v_old.status = 'approved' and not v_approver then perform app.fail('NOT_ALLOWED', 'Approved hours can only be changed by the owner.'); end if;
  begin
    v_start := (p_entry ->> 'started_at')::timestamptz;
    v_end := (p_entry ->> 'ended_at')::timestamptz;
    v_break := greatest(0, round(coalesce((p_entry ->> 'break_min')::numeric, 0)));
    v_units := greatest(1, round(coalesce((p_entry ->> 'units')::numeric, 1)));
  exception when others then perform app.fail('INVALID', 'Check the times.');
  end;
  if v_start is null or v_end is null or v_end <= v_start then perform app.fail('INVALID', 'The finish needs to be after the start.'); end if;
  if v_end - v_start > interval '24 hours' then perform app.fail('INVALID', 'That''s longer than a day. Split it into separate shifts.'); end if;
  if v_end > app.now() + interval '5 minutes' then perform app.fail('INVALID', 'You can''t log time that hasn''t happened yet.'); end if;
  if make_interval(mins => v_break) >= v_end - v_start then perform app.fail('INVALID', 'The break can''t be as long as the shift.'); end if;
  if v_kind = 'session' then
    v_key := left(btrim(regexp_replace(lower(coalesce(p_entry ->> 'session_type', '')), '[^a-z0-9]+', '_', 'g'), '_'), 40);
    if v_key = '' then perform app.fail('INVALID', 'Say what kind of session it was.'); end if;
  end if;
  perform public.payroll_assert_open(public.payroll_sdate(v_start));
  if v_old.id is not null then perform public.payroll_assert_open(public.payroll_sdate(v_old.started_at)); end if;
  if v_kind = 'shift' and exists (
      select 1 from public.payroll_timesheets x where x.id is distinct from v_id and x.staff_id = v_staff and x.kind = 'shift' and x.status <> 'rejected'
         and x.started_at < v_end and coalesce(x.ended_at, 'infinity'::timestamptz) > v_start) then
    perform app.fail('OVERLAP', 'That overlaps another shift on the timesheet.');
  end if;
  if v_old.id is null then
    insert into public.payroll_timesheets (studio_id, staff_id, kind, session_type, started_at, ended_at, break_min, units, note, source,
                                           status, reviewed_by, reviewed_at, created_by, created_at)
    values (app.current_studio_id(), v_staff, v_kind, nullif(v_key, ''), v_start, v_end, v_break, case when v_kind = 'session' then v_units else 1 end,
            nullif(left(btrim(coalesce(p_entry ->> 'note', '')), 200), ''), coalesce(nullif(left(p_entry ->> 'source', 40), ''), 'manual'),
            case when v_approver then 'approved' else 'pending' end, case when v_approver then me.id end,
            case when v_approver then app.now() end, me.id, app.now())
    returning * into e;
  else
    update public.payroll_timesheets set started_at = v_start, ended_at = v_end, break_min = v_break,
      units = case when v_kind = 'session' then v_units else 1 end, session_type = coalesce(nullif(v_key, ''), session_type),
      note = nullif(left(btrim(coalesce(p_entry ->> 'note', '')), 200), ''), review_note = null,
      status = case when v_approver then 'approved' else 'pending' end,
      reviewed_by = case when v_approver then me.id end, reviewed_at = case when v_approver then app.now() end
    where id = v_old.id returning * into e;
  end if;
  return to_jsonb(e);
end $$;

create or replace function public.payroll_delete_timesheet(p_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.staff := public.payroll_me(); e public.payroll_timesheets;
begin
  perform app.assert_studio_open(app.current_studio_id());
  perform app.assert_in_studio('payroll_timesheets', p_id, 'We couldn''t find that entry.');
  select * into e from public.payroll_timesheets where id = p_id and studio_id = app.current_studio_id() for update;
  if e.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that entry.'); end if;
  if me.role <> 'owner' and (e.status = 'approved' or (e.staff_id <> me.id and me.role <> 'manager')) then
    perform app.fail('NOT_ALLOWED', 'Approved hours can only be removed by the owner.');
  end if;
  perform public.payroll_assert_open(public.payroll_sdate(e.started_at));
  delete from public.payroll_timesheets where id = e.id;
end $$;

create or replace function public.payroll_review_timesheets(p_ids uuid[], p_decision text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.staff := public.payroll_require(array['owner']); v_id uuid; e public.payroll_timesheets; v_out jsonb := '[]'::jsonb;
begin
  perform app.assert_studio_open(app.current_studio_id());
  if p_decision not in ('approve','reject') then perform app.fail('INVALID', 'Approve or reject.'); end if;
  foreach v_id in array coalesce(p_ids, '{}') loop
    perform app.assert_in_studio('payroll_timesheets', v_id, 'We couldn''t find that entry.');
    select * into e from public.payroll_timesheets where id = v_id and studio_id = app.current_studio_id() for update;
    if e.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that entry.'); end if;
    if p_decision = 'approve' and e.ended_at is null then perform app.fail('STILL_CLOCKED_IN', 'That shift is still running. Wait for them to clock out.'); end if;
    perform public.payroll_assert_open(public.payroll_sdate(e.started_at));
    update public.payroll_timesheets set status = case when p_decision = 'approve' then 'approved' else 'rejected' end,
      reviewed_by = me.id, reviewed_at = app.now(), review_note = nullif(left(btrim(coalesce(p_note, '')), 200), '')
    where id = e.id returning * into e;
    v_out := v_out || jsonb_build_array(to_jsonb(e));
  end loop;
  return v_out;
end $$;

-- ---------------------------------------------------------------- payroll (owner/manager read, owner changes)

-- What calc.ts needs that RLS doesn't already give the app: finished classes in the period with checked-in counts,
-- every staff name, legacy per-class pay, class type names.
create or replace function public.payroll_period_inputs(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_studio uuid := app.current_studio_id();
begin
  perform public.payroll_require(array['owner','manager']);
  if p_to < p_from or p_to - p_from > 62 then perform app.fail('INVALID', 'That isn''t a pay period.'); end if;
  return jsonb_build_object(
    'classes', coalesce((
      select jsonb_agg(jsonb_build_object('session_id', s.id, 'staff_id', s.instructor_id, 'class_type_id', s.class_type_id,
                                          'starts_at', s.starts_at,
                                          'attendees', (select count(*) from public.bookings b where b.session_id = s.id and b.status = 'checked_in'))
                       order by s.starts_at)
        from public.class_sessions s
       where s.studio_id = v_studio and s.status = 'scheduled' and s.ends_at <= app.now()
         and s.starts_at >= (p_from::timestamp at time zone app.tz()) and s.starts_at < ((p_to + 1)::timestamp at time zone app.tz())), '[]'::jsonb),
    'staff', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'role', role, 'active', active) order by name)
                         from public.staff where studio_id = v_studio), '[]'::jsonb),
    'legacy', coalesce((select jsonb_object_agg(staff_id, pay_per_class_cents) from public.staff_pay
                         where studio_id = v_studio and pay_per_class_cents > 0), '{}'::jsonb),
    'class_types', coalesce((select jsonb_object_agg(id, name) from public.class_types where studio_id = v_studio), '{}'::jsonb),
    'today', public.payroll_sdate(app.now()));
end $$;

create or replace function public.payroll_add_adjustment(p_from date, p_to date, p_staff_id uuid, p_label text, p_amount_cents integer, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.staff := public.payroll_require(array['owner']); a public.payroll_adjustments;
begin
  perform app.assert_studio_open(app.current_studio_id());
  perform app.assert_in_studio('staff', p_staff_id, 'We couldn''t find that staff member.');
  if not exists (select 1 from public.staff where id = p_staff_id and studio_id = app.current_studio_id()) then
    perform app.fail('NOT_FOUND', 'We couldn''t find that staff member.');
  end if;
  if coalesce(p_amount_cents, 0) = 0 or abs(p_amount_cents) > 100000000 then perform app.fail('INVALID', 'Enter an amount, plus or minus.'); end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then perform app.fail('INVALID', 'Add a reason so there''s a record of why.'); end if;
  if p_from is null or p_to is null or p_to < p_from then perform app.fail('INVALID', 'That isn''t a pay period.'); end if;
  if exists (select 1 from public.payroll_runs where studio_id = app.current_studio_id() and period_from = p_from and period_to = p_to) then
    perform app.fail('PERIOD_PAID', 'That pay period has already been paid. Reopen it first.');
  end if;
  insert into public.payroll_adjustments (studio_id, period_from, period_to, staff_id, label, amount_cents, reason, created_by, created_at)
  values (app.current_studio_id(), p_from, p_to, p_staff_id, coalesce(nullif(left(btrim(coalesce(p_label, '')), 60), ''), 'Adjustment'),
          p_amount_cents, left(btrim(p_reason), 300), me.id, app.now())
  returning * into a;
  return to_jsonb(a);
end $$;

create or replace function public.payroll_remove_adjustment(p_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.payroll_adjustments;
begin
  perform public.payroll_require(array['owner']);
  perform app.assert_studio_open(app.current_studio_id());
  perform app.assert_in_studio('payroll_adjustments', p_id, 'We couldn''t find that adjustment.');
  select * into a from public.payroll_adjustments where id = p_id and studio_id = app.current_studio_id() for update;
  if a.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that adjustment.'); end if;
  if exists (select 1 from public.payroll_runs where studio_id = a.studio_id and period_from = a.period_from and period_to = a.period_to) then
    perform app.fail('PERIOD_PAID', 'That pay period has already been paid. Reopen it first.');
  end if;
  delete from public.payroll_adjustments where id = a.id;
end $$;

-- Mark a finished period paid. The app sends the period view it worked out (calc.ts) as the saved copy; the database
-- checks the period has ended and nothing is still waiting (pending hours, open clocks).
create or replace function public.payroll_mark_paid(p_from date, p_to date, p_total_cents integer, p_snapshot jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare me public.staff := public.payroll_require(array['owner']); v_studio uuid := app.current_studio_id(); n int; run public.payroll_runs;
begin
  perform app.assert_studio_open(v_studio);
  if p_from is null or p_to is null or p_to < p_from then perform app.fail('INVALID', 'That isn''t a pay period.'); end if;
  if exists (select 1 from public.payroll_runs where studio_id = v_studio and period_from = p_from and period_to = p_to) then
    perform app.fail('ALREADY_PAID', 'This pay period is already marked as paid.');
  end if;
  if exists (select 1 from public.payroll_runs where studio_id = v_studio and period_from <= p_to and period_to >= p_from) then
    perform app.fail('PERIOD_PAID', 'Part of this period has already been paid.');
  end if;
  if p_to >= public.payroll_sdate(app.now()) then perform app.fail('PERIOD_OPEN', 'This pay period hasn''t finished yet.'); end if;
  if exists (select 1 from public.payroll_timesheets where studio_id = v_studio and kind = 'shift' and ended_at is null
               and public.payroll_sdate(started_at) between p_from and p_to) then
    perform app.fail('STILL_CLOCKED_IN', 'Someone is still clocked in. Close their shift first.');
  end if;
  select count(*) into n from public.payroll_timesheets
   where studio_id = v_studio and status = 'pending' and ended_at is not null and public.payroll_sdate(started_at) between p_from and p_to;
  if n > 0 then
    perform app.fail('TIMESHEETS_PENDING', case when n = 1 then '1 timesheet entry needs' else n || ' timesheet entries need' end || ' approving first.');
  end if;
  if p_snapshot is null or jsonb_typeof(p_snapshot) <> 'object' then perform app.fail('INVALID', 'Missing the pay details.'); end if;
  insert into public.payroll_runs (studio_id, period_from, period_to, paid_at, paid_by, total_cents, snapshot)
  values (v_studio, p_from, p_to, app.now(), me.id, coalesce(p_total_cents, 0), p_snapshot)
  returning * into run;
  return to_jsonb(run);
end $$;

create or replace function public.payroll_reopen(p_from date, p_to date) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.payroll_require(array['owner']);
  perform app.assert_studio_open(app.current_studio_id());
  delete from public.payroll_runs where studio_id = app.current_studio_id() and period_from = p_from and period_to = p_to;
  if not found then perform app.fail('NOT_FOUND', 'That pay period isn''t marked as paid.'); end if;
end $$;

-- ---------------------------------------------------------------- grants
revoke execute on function public.payroll_sdate(timestamptz), public.payroll_me(), public.payroll_require(text[]),
  public.payroll_settings_json(), public.payroll_assert_open(date), public.payroll_eligible(uuid), public.payroll_clash(uuid, uuid),
  public.payroll_cover_json(public.payroll_cover_requests, uuid), public.payroll_need_live(public.payroll_cover_requests),
  public.payroll_notify(text, uuid[], public.payroll_cover_requests), public.payroll_approve_now(uuid, uuid),
  public.payroll_clocks_in(public.staff)
  from public, anon, authenticated;

revoke execute on function public.payroll_get_settings(), public.payroll_update_settings(jsonb), public.payroll_list_cover(),
  public.payroll_cover_for_session(uuid), public.payroll_request_cover(uuid, text), public.payroll_claim_cover(uuid),
  public.payroll_withdraw_claim(uuid), public.payroll_decide_cover(uuid, text, text), public.payroll_cancel_cover(uuid),
  public.payroll_save_rule(jsonb), public.payroll_delete_rule(uuid), public.payroll_clock_status(), public.payroll_clock_in(text),
  public.payroll_clock_out(), public.payroll_list_timesheets(date, date, uuid), public.payroll_save_timesheet(jsonb),
  public.payroll_delete_timesheet(uuid), public.payroll_review_timesheets(uuid[], text, text), public.payroll_period_inputs(date, date),
  public.payroll_add_adjustment(date, date, uuid, text, integer, text), public.payroll_remove_adjustment(uuid),
  public.payroll_mark_paid(date, date, integer, jsonb), public.payroll_reopen(date, date)
  from public, anon;
grant execute on function public.payroll_get_settings(), public.payroll_update_settings(jsonb), public.payroll_list_cover(),
  public.payroll_cover_for_session(uuid), public.payroll_request_cover(uuid, text), public.payroll_claim_cover(uuid),
  public.payroll_withdraw_claim(uuid), public.payroll_decide_cover(uuid, text, text), public.payroll_cancel_cover(uuid),
  public.payroll_save_rule(jsonb), public.payroll_delete_rule(uuid), public.payroll_clock_status(), public.payroll_clock_in(text),
  public.payroll_clock_out(), public.payroll_list_timesheets(date, date, uuid), public.payroll_save_timesheet(jsonb),
  public.payroll_delete_timesheet(uuid), public.payroll_review_timesheets(uuid[], text, text), public.payroll_period_inputs(date, date),
  public.payroll_add_adjustment(date, date, uuid, text, integer, text), public.payroll_remove_adjustment(uuid),
  public.payroll_mark_paid(date, date, integer, jsonb), public.payroll_reopen(date, date)
  to authenticated;
