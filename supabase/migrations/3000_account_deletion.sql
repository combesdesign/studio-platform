-- =============================================================================
-- 3000: "Delete my account" (Apple 5.1.1(v), Google Play). Docs: NOTES.md "Account deletion".
--
-- Two steps, split on purpose:
--   public.account_deletion_plan(client)   anyone signed in. Checks WHO may delete (the person themselves, or the studio's owner)
--                                          and returns what the edge function must do outside the database (Stripe subscriptions,
--                                          avatar files, the sign-in user).
--   public.account_delete_apply(...)       SERVICE ROLE ONLY (not callable from the apps). Does the database work. The delete-account
--                                          edge function calls it after Stripe has stopped billing, so a membership can never keep
--                                          charging a deleted person.
--
-- What it does, for the person and their dependants in THIS studio only:
--   * clients: name, email, phone, birthday, photo, injuries, emergency contact, health form and answers are cleared; the row stays
--     (archived, deleted_at set) so bookings, passes and sales keep their client for the studio's tax records.
--   * future bookings cancelled (spots freed, waitlist promoted), passes cancelled, queued/sent personal messages scrubbed,
--     staff notes, messages, tags, devices, interest, viewing history and referral codes deleted.
--   * sign-in: if they have no other studio (as client or staff), the edge function deletes the auth user; otherwise only this
--     studio's link (clients.user_id) is removed.
--   * audit_log gets one row (ids and counts only, no personal details). Running it again does nothing and logs nothing.
-- =============================================================================

alter table public.clients add column if not exists deleted_at timestamptz;

-- ----------------------------------------------------------------------------- plan (who may, and what lives outside the database)
create or replace function public.account_deletion_plan(p_client_id uuid default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_target uuid := coalesce(p_client_id, public.current_client_id());
  c public.clients;
  v_by text;
  v_ids uuid[];
begin
  if v_target is null then perform app.fail('AUTH_REQUIRED', 'Please sign in first.'); end if;
  perform app.assert_in_studio('clients', v_target, 'We couldn''t find that account.');
  select * into c from public.clients where id = v_target;
  if c.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that account.'); end if;
  -- Only the person themselves (their own login in this studio) or this studio's owner. Not managers, not other clients, not parents.
  if c.user_id is not null and c.user_id = auth.uid() and c.guardian_client_id is null then v_by := 'self';
  elsif app.has_role_in(c.studio_id, 'owner') then v_by := 'owner';
  else perform app.fail('NOT_ALLOWED', 'You can only delete your own account.');
  end if;

  select array_agg(x.id) into v_ids from public.clients x where x.id = c.id or x.guardian_client_id = c.id;
  return jsonb_build_object(
    'studio_id', c.studio_id, 'client_id', c.id, 'by', v_by, 'already_deleted', c.deleted_at is not null,
    'user_id', c.user_id,
    'client_ids', to_jsonb(v_ids),
    'subscriptions', coalesce((select jsonb_agg(distinct p.stripe_subscription_id) from public.passes p
                                where p.client_id = any (v_ids) and p.stripe_subscription_id is not null), '[]'::jsonb),
    'stripe_customers', coalesce((select jsonb_agg(distinct s.stripe_customer_id) from public.stripe_customers s
                                   where s.client_id = any (v_ids)), '[]'::jsonb),
    'avatar_paths', coalesce((select jsonb_agg(o.name) from storage.objects o
                               where o.bucket_id = 'avatars' and (storage.foldername(o.name))[1] = any (select i::text from unnest(v_ids) i)), '[]'::jsonb)
  );
end $$;

-- ----------------------------------------------------------------------------- apply (service role only)
create or replace function public.account_delete_apply(p_client_id uuid, p_actor_user_id uuid default null, p_by text default 'self') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c public.clients;
  v_ids uuid[];
  v_now timestamptz := app.now();
  v_user uuid;
  v_other_links int;
  v_cancelled_bookings int := 0;
  v_cancelled_passes int := 0;
  r record;
  v_delete_auth boolean;
begin
  if not app.is_privileged() then perform app.fail('NOT_ALLOWED', 'Not allowed.'); end if;
  select * into c from public.clients where id = p_client_id;
  if c.id is null then perform app.fail('NOT_FOUND', 'We couldn''t find that account.'); end if;
  perform app.use_studio(c.studio_id);
  v_user := c.user_id;

  -- Anyone else tied to the same login (another studio as client, or staff anywhere, or a platform admin) keeps the login.
  select (select count(*) from public.clients o where o.user_id = v_user and o.id <> c.id and o.deleted_at is null)
       + (select count(*) from public.staff s where s.user_id = v_user)
       + (select count(*) from public.platform_admins a where a.user_id = v_user)
    into v_other_links;
  v_delete_auth := v_user is not null and v_other_links = 0;

  if c.deleted_at is not null then      -- already done: just tell the caller what's left to do (idempotent)
    return jsonb_build_object('client_id', c.id, 'already_deleted', true, 'user_id', v_user, 'delete_auth_user', v_delete_auth);
  end if;

  select array_agg(x.id) into v_ids from public.clients x where x.id = c.id or x.guardian_client_id = c.id;

  -- 1. Future classes: free the spots (and give pack credits back, so the numbers stay true) before the passes are cancelled.
  for r in select b.id, b.session_id, b.pass_id, b.status from public.bookings b join public.class_sessions s on s.id = b.session_id
            where b.client_id = any (v_ids) and b.status in ('booked', 'waitlisted') and s.starts_at >= v_now order by s.id loop
    update public.bookings set status = 'cancelled', cancelled_at = v_now where id = r.id;
    if r.status = 'booked' and r.pass_id is not null then perform app.return_credit(r.pass_id); end if;
    perform app.promote_waitlist(r.session_id, v_now);
    v_cancelled_bookings := v_cancelled_bookings + 1;
  end loop;

  -- 2. Passes and memberships stop (Stripe was already told by the edge function). Rows stay for the records.
  update public.passes set status = 'cancelled', cancel_at_period_end = false, paused_from = null, paused_until = null,
         next_billing_at = case when kind = 'membership' then least(coalesce(next_billing_at, v_now), v_now) else next_billing_at end,
         pending_change = null
   where client_id = any (v_ids) and status <> 'cancelled';
  get diagnostics v_cancelled_passes = row_count;

  -- 3. Personal details gone from the client rows. Booking, pass and sale rows keep their client_id (anonymised) for tax records.
  update public.clients set
         first_name = 'Deleted', last_name = 'client', email = '', phone = null, birthday = null, photo_url = null,
         injuries = null, emergency_contact_name = null, emergency_contact_phone = null,
         health_form = null, health_update = null, health_checked_at = null,
         marketing_opt_in = false, archived = true, momence_id = null, deleted_at = v_now,
         user_id = case when id = c.id and v_delete_auth then user_id else null end   -- kept only until the login itself is deleted (retry-safe)
   where id = any (v_ids);

  -- 4. Things that are only about the person: delete.
  delete from public.client_notes where client_id = any (v_ids);
  delete from public.notifications where client_id = any (v_ids);
  delete from public.appointments_outbox where client_id = any (v_ids);
  delete from public.class_interest where client_id = any (v_ids);
  delete from public.ondemand_views where client_id = any (v_ids);
  delete from public.reviews_skips where client_id = any (v_ids);
  delete from public.marketing_thread_messages where client_id = any (v_ids);
  delete from public.marketing_threads where client_id = any (v_ids);
  delete from public.marketing_client_tags where client_id = any (v_ids);
  delete from public.marketing_push_devices where client_id = any (v_ids);
  delete from public.commerce_ref_codes where client_id = any (v_ids);
  delete from public.studio_event_waitlist where client_id = any (v_ids);
  delete from public.integrations_partner_clients where client_id = any (v_ids);

  -- 5. Records we keep, with the personal text taken out.
  update public.marketing_messages set to_address = '', ref_name = '', payload = '{}'::jsonb, error = null where client_id = any (v_ids);
  update public.reviews_entries set client_first_name = '', comment = null where client_id = any (v_ids);
  update public.appointments set note = null where client_id = any (v_ids);
  update public.integrations_partner_bookings set member_name = '' where booking_id in (select id from public.bookings where client_id = any (v_ids));
  update public.commerce_gift_cards set recipient_name = null, recipient_email = null, message = null, from_name = null
   where purchaser_client_id = any (v_ids) or owner_client_id = any (v_ids);

  insert into public.audit_log (studio_id, actor_user_id, actor_staff_id, action, entity, entity_id, details)
  values (c.studio_id, p_actor_user_id, app.staff_id_in(c.studio_id), 'account.delete', 'client', c.id::text,
          jsonb_build_object('by', p_by, 'dependants', coalesce(array_length(v_ids, 1), 1) - 1, 'bookingsCancelled', v_cancelled_bookings,
                             'passesCancelled', v_cancelled_passes, 'loginRemoved', v_delete_auth));

  return jsonb_build_object('client_id', c.id, 'already_deleted', false, 'user_id', v_user, 'delete_auth_user', v_delete_auth);
end $$;

revoke all on function public.account_deletion_plan(uuid) from public, anon;
grant execute on function public.account_deletion_plan(uuid) to authenticated, service_role;
revoke all on function public.account_delete_apply(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.account_delete_apply(uuid, uuid, text) to service_role;
