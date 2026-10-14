-- After 10 simultaneous bookings for 3 spots: exactly 3 booked, 7 waitlisted, 3 credits used.
\o /dev/null
select test.eq((select count(*) from public.bookings where session_id = test.id('race_session') and status = 'booked')::int, 3,
               'race: exactly 3 booked (no overbooking)');
select test.eq((select count(*) from public.bookings where session_id = test.id('race_session') and status = 'waitlisted')::int, 7,
               'race: the other 7 are waitlisted');
select test.eq((select array_agg(waitlist_position order by waitlist_position) from public.bookings
                 where session_id = test.id('race_session') and status = 'waitlisted'), array[1,2,3,4,5,6,7],
               'race: waitlist positions are 1..7 with no duplicates');
select test.eq((select sum(credits_used) from public.passes p join public.clients c on c.id = p.client_id where c.email like 'race%')::int, 3,
               'race: exactly 3 credits taken');
