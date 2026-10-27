-- =============================================================================
-- Settings > Emails, the rest: receipts, gift cards (to the recipient), appointment emails (confirmed, cancelled, moved, reminder)
-- and event emails (registered, cancelled, reminder, waitlist offer) can now be switched off and reworded, the same way as the
-- class emails in 2500. Same table, same two RPCs. The edge functions apply the wording and the switch when they send
-- (supabase/functions/_shared/email.ts), so nothing else about how these emails are queued changes.
-- =============================================================================

create function app.editable_email_kinds() returns text[]
language sql immutable as $$
  select array['booking_confirmed', 'waitlist_joined', 'waitlist_promoted', 'booking_cancelled', 'class_cancelled', 'class_reminder', 'welcome',
               'receipt', 'gift_card', 'appointment_confirmed', 'appointment_cancelled', 'appointment_moved', 'appointment_reminder',
               'event_registered', 'event_cancelled', 'event_reminder', 'waitlist_offer']
$$;

alter table public.email_templates drop constraint email_templates_kind_check;
alter table public.email_templates add constraint email_templates_kind_check check (kind = any (app.editable_email_kinds()));

-- A test gift card has no card behind it, so tests for it go through the notifications queue like the class tests do.
alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('booking_confirmed', 'waitlist_promoted', 'class_cancelled', 'receipt', 'class_reminder', 'late_cancel', 'waitlist_joined', 'booking_cancelled', 'welcome', 'gift_card'));

create function app.patch_function(p_fn regprocedure, p_from text, p_to text) returns void
language plpgsql as $$
declare d text := pg_get_functiondef(p_fn);
begin
  if position(p_from in d) = 0 then raise exception 'patch_function: text not found in %', p_fn::text; end if;
  execute replace(d, p_from, p_to);
end $$;

select app.patch_function('public.save_email_template(text, jsonb)'::regprocedure,
  $q$p_kind not in ('booking_confirmed', 'waitlist_joined', 'waitlist_promoted', 'booking_cancelled', 'class_cancelled', 'class_reminder', 'welcome')$q$,
  $q$not (p_kind = any (app.editable_email_kinds()))$q$);
select app.patch_function('public.send_test_email(text)'::regprocedure,
  $q$p_kind not in ('booking_confirmed', 'waitlist_joined', 'waitlist_promoted', 'booking_cancelled', 'class_cancelled', 'class_reminder', 'welcome')$q$,
  $q$not (p_kind = any (app.editable_email_kinds()))$q$);

-- "Send me a test" for the new kinds: only who it is for is stored. The edge function fills in a made-up session, sale or gift
-- card (the shared samplePayload) when it sees is_test. Appointment and event kinds go through their own outbox.
select app.patch_function('public.send_test_email(text)'::regprocedure,
  $q$  insert into public.notifications (studio_id, client_id, kind, to_email, payload)
  values (v_studio, null, p_kind, st.email, jsonb_build_object($q$,
  $q$  if p_kind in ('appointment_confirmed', 'appointment_cancelled', 'appointment_moved', 'appointment_reminder',
                 'event_registered', 'event_cancelled', 'event_reminder', 'waitlist_offer') then
    insert into public.appointments_outbox (studio_id, kind, client_id, to_email, payload)
    values (v_studio, p_kind, null, st.email, jsonb_build_object('is_test', true, 'first_name', split_part(btrim(st.name), ' ', 1),
      'cancellation_policy', (select cancellation_policy_text from public.studio_settings where studio_id = v_studio)));
    return jsonb_build_object('to', st.email);
  end if;
  if p_kind in ('receipt', 'gift_card') then
    insert into public.notifications (studio_id, client_id, kind, to_email, payload)
    values (v_studio, null, p_kind, st.email, jsonb_build_object('is_test', true, 'first_name', split_part(btrim(st.name), ' ', 1)));
    return jsonb_build_object('to', st.email);
  end if;
  insert into public.notifications (studio_id, client_id, kind, to_email, payload)
  values (v_studio, null, p_kind, st.email, jsonb_build_object($q$);

drop function app.patch_function(regprocedure, text, text);
