-- =============================================================================
-- Snowy Pilates Club: starting data for a fresh project (run once, after the migrations).
-- Real studio setup from RULES.md and snowypilatesclub.com. No fake clients.
-- Safe to re-run: it upserts by fixed ids.
-- =============================================================================

insert into public.studio_settings (id, name, timezone, address, email, phone, abn, gst_registered,
  cancel_window_hours, waitlist_cutoff_hours, late_cancel_fee_cents, no_show_fee_cents,
  booking_window_days, default_capacity, waiver_text, health_questions, cancellation_policy_text, waitlist_policy_text)
values (1, 'Snowy Pilates Club', 'Australia/Sydney', '57 Vale Street, Cooma NSW 2630', 'admin@snowypilatesclub.com',
  null, null, true, 3, 1, 0, 0, 14, 14,
  'I understand that Pilates involves physical exercise and that I take part at my own risk. I confirm I have told Snowy Pilates Club about any injuries, medical conditions or pregnancy that may affect my ability to exercise safely, and that I will let my instructor know if anything changes. I will work within my own limits, follow my instructor''s guidance and stop if I feel pain, dizziness or discomfort. I release Snowy Pilates Club and its instructors from liability for any injury or loss, except where caused by their negligence.',
  array[
    'Do you have any current injuries or pain?',
    'Do you have any medical conditions we should know about (e.g. heart, blood pressure, asthma, diabetes)?',
    'Are you pregnant, or have you had a baby in the last 12 months?',
    'Have you had any surgery in the last 12 months?',
    'Is there anything else your instructor should know?'
  ],
  'If you cancel more than 3 hours before class, your credit goes back on your membership or pack. If you cancel within 3 hours of the start time, or don''t show up, you lose that class credit. Please cancel as early as you can so others can book in or come off the waitlist.',
  'If a class is full you can join the waitlist (you won''t be charged). If a spot opens up you''ll be booked in automatically and we''ll email you. Automatic booking stops 1 hour before class, so if a spot opens after that it stays open for anyone to book.')
on conflict (id) do update set
  name = excluded.name, timezone = excluded.timezone, address = excluded.address, email = excluded.email,
  cancel_window_hours = excluded.cancel_window_hours, waitlist_cutoff_hours = excluded.waitlist_cutoff_hours,
  booking_window_days = excluded.booking_window_days, default_capacity = excluded.default_capacity,
  waiver_text = excluded.waiver_text, health_questions = excluded.health_questions,
  cancellation_policy_text = excluded.cancellation_policy_text, waitlist_policy_text = excluded.waitlist_policy_text;

-- ----------------------------------------------------------------------------- class types
insert into public.class_types (id, name, description, duration_min, color, default_capacity, level, booking_note, bookable, active, sort_order) values
  ('c1a55000-0000-4000-8000-000000000001', 'Mat Essentials',
   'Our signature mat Pilates class combines classical and modern exercises to work your entire body. You''ll build strength, feel more energised and notice everyday movement getting easier. No Pilates experience needed.',
   55, '#5069AC', 14, 'All levels', null, true, true, 1),
  ('c1a55000-0000-4000-8000-000000000002', 'Mums + Bubs',
   'A baby-friendly class that gives mums the space and time to ease back into movement, support postnatal recovery and connect with other local mums.',
   45, '#85A2D1', 14, 'Postnatal',
   'Mums must have clearance from a women''s health professional before booking. Bring a blanket, mat, bouncer or pram for bub. Crawling babies need to be in a seat or pram.',
   true, true, 2),
  ('c1a55000-0000-4000-8000-000000000003', 'Strength + Sculpt',
   'A little more intensity, with bursts of cardio and the option to add heavier weights.',
   50, '#24345F', 14, 'Intermediate', null, false, true, 3)
on conflict (id) do update set name = excluded.name, description = excluded.description, duration_min = excluded.duration_min,
  color = excluded.color, default_capacity = excluded.default_capacity, level = excluded.level,
  booking_note = excluded.booking_note, bookable = excluded.bookable, sort_order = excluded.sort_order;

-- ----------------------------------------------------------------------------- products (prices include GST)
insert into public.products (id, kind, name, description, price_cents, active, highlight, sort_order,
  credits, validity_days, billing_interval, new_clients_only, stock) values
  -- memberships: weekly, credits per Mon-Sun week, starts from first booking
  ('9a0d0000-0000-4000-8000-000000000001', 'membership', '1 class per week', 'A perfect option if you want to add Pilates to your current routine. 1 class credit each week, billed weekly.', 2200, true, null, 10, 1, null, 'week', false, null),
  ('9a0d0000-0000-4000-8000-000000000002', 'membership', '2 classes per week', '2 class credits each week, billed weekly.', 4000, true, 'Recommended', 20, 2, null, 'week', false, null),
  ('9a0d0000-0000-4000-8000-000000000003', 'membership', '3 classes per week', '3 class credits each week, billed weekly.', 5500, true, null, 30, 3, null, 'week', false, null),
  ('9a0d0000-0000-4000-8000-000000000004', 'membership', 'Unlimited', 'Come as often as you like, billed weekly.', 6900, true, null, 40, null, null, 'week', false, null),
  -- packs: expiry clock starts at first booking
  ('9a0d0000-0000-4000-8000-000000000011', 'dropin', 'Single class', '1 class credit. Expires 61 days after you first use it.', 3000, true, null, 50, 1, 61, null, false, null),
  ('9a0d0000-0000-4000-8000-000000000012', 'pack', '4 class pack', '4 class credits. Expires 2 months after your first booking.', 10000, true, null, 60, 4, 61, null, false, null),
  ('9a0d0000-0000-4000-8000-000000000013', 'pack', '8 class pack', '8 class credits. Expires 4 months after your first booking.', 19000, true, null, 70, 8, 122, null, false, null),
  -- intro offer: new clients only, once
  ('9a0d0000-0000-4000-8000-000000000021', 'intro', 'Intro offer: 2 weeks unlimited', '2 weeks of unlimited classes from your first booking. New clients only.', 4900, true, 'New clients', 0, null, 14, null, true, null),
  -- retail (sample)
  ('9a0d0000-0000-4000-8000-000000000031', 'retail', 'Grip socks', 'Non-slip Pilates socks.', 2000, true, null, 100, null, null, null, false, null),
  ('9a0d0000-0000-4000-8000-000000000032', 'retail', 'Water bottle', 'Snowy Pilates Club bottle.', 1500, true, null, 110, null, null, null, false, null)
on conflict (id) do update set kind = excluded.kind, name = excluded.name, description = excluded.description,
  price_cents = excluded.price_cents, highlight = excluded.highlight, sort_order = excluded.sort_order,
  credits = excluded.credits, validity_days = excluded.validity_days, billing_interval = excluded.billing_interval,
  new_clients_only = excluded.new_clients_only;

-- ----------------------------------------------------------------------------- staff
-- The team from snowypilatesclub.com. Fill in each person's real email (Table editor -> staff),
-- then create their login with the same email: the login links to the staff row automatically.
insert into public.staff (id, name, email, role, bio, photo_url, active) values
  ('5aff0000-0000-4000-8000-000000000001', 'Libby', null, 'owner',
   'The owner of Snowy Pilates Club. You are guaranteed a good time in her classes. They are fun and achievable, but you absolutely will feel muscles burning that you never knew existed.',
   'img/libby.webp', true),
  ('5aff0000-0000-4000-8000-000000000002', 'Julia', null, 'instructor',
   'A real life angel. Julia''s style is the perfect mix of satisfying and challenging, where you leave every class realising what you are capable of.',
   'img/julia.webp', true),
  ('5aff0000-0000-4000-8000-000000000003', 'Grace T', null, 'instructor',
   'Grace''s bright smile and easy going nature will put you at ease instantly, and her workouts will give you that signature Pilates burn you''ve been looking for.',
   'img/grace-t.webp', true),
  ('5aff0000-0000-4000-8000-000000000004', 'Grace P', null, 'front_desk',
   'Nurse by day (and night) and Pilates queen by early morning (and evening). Grace knows her stuff and wants every session to be challenging yet rewarding.',
   'img/grace-p.webp', true)
on conflict (id) do nothing;

-- ----------------------------------------------------------------------------- weekly timetable
-- RULES.md doesn't list the timetable, so none is seeded. Add Libby's weekly classes in the
-- studio app (Schedule -> Weekly timetable), or uncomment and edit the example below.
-- weekday: 0 = Sunday ... 6 = Saturday. start_time is studio (Sydney) time.
--
-- insert into public.schedule_templates (class_type_id, weekday, start_time, instructor_id, starts_on) values
--   ('c1a55000-0000-4000-8000-000000000001', 1, '06:00', '5aff0000-0000-4000-8000-000000000001', current_date),
--   ('c1a55000-0000-4000-8000-000000000001', 3, '18:00', '5aff0000-0000-4000-8000-000000000002', current_date),
--   ('c1a55000-0000-4000-8000-000000000002', 4, '09:30', '5aff0000-0000-4000-8000-000000000003', current_date);
-- select public.generate_sessions(current_date, current_date + 28);
