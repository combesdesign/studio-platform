# Marketing (B2)

Studio app: **Marketing** in the nav (Campaigns, Automations, Audiences, Inbox), a Marketing tab in Settings, a "New messages" Today widget, and tags plus a Message button on the client profile. Client app: **Messages** under Profile (a conversation with the studio, and a notifications switch). The existing News and offers switch in Profile is the opt-out; every marketing email also carries a one-click unsubscribe link.

- **Audiences**: saved filters over clients (active member, pack running low, no visit in N days, on the intro offer, birthday this month, opted in, tag, joined recently; each can be flipped with Not; match all or any). Seven starter audiences per studio.
- **Campaigns**: email (blocks: heading, text, image, button, divider, in the studio's own colours and fonts) or text. Save a draft, send a test, send now or schedule. Only opted-in clients with an address are sent to; the rest are counted as left out. Results show sent, opened, clicked and unsubscribed.
- **Automations**: welcome, welcome part two, intro ending, pack running low or expiring, win-back, birthday, after first class, membership pause ending. Each can be switched off, edited (copy, channel, delay) and previewed ("Who's next?"). Each client gets each message once (the sent log has a unique key). Marketing ones respect opt-in; messages about a client's own pass or pause go to everyone it applies to.
- **Inbox**: one thread per client, both directions, with unread counts. Live it updates through Supabase realtime.
- **Push**: `push.ts` has a web provider (Push API through the app's service worker) and a Capacitor provider (found on `window.Capacitor` at runtime, nothing imported). Devices register with the store. Sending needs keys, see NOTES.md.

Sending: queued in `marketing_messages` (the outbox), drained by the existing `send-email` (flush, every 2 minutes) and `send-reminders` functions through `drainFeatureOutboxes`, which first runs `marketing_tick` (due scheduled campaigns and every studio's automations). The `marketing-send` function is only the open / click / unsubscribe endpoint, "Send now" and test sends.

Code: `src/features/marketing/`; SQL `supabase/migrations/1200_*` to `1202_*`; sender `supabase/functions/_shared/marketing.ts` (+ `marketing-render.ts`, a copy of `render.ts` for Deno); tests `tests/marketing.test.ts`, `supabase/tests/marketing_core.sql`, and a drain test in `supabase/tests/functions.test.mjs`.
Permissions: `marketing.view` (owner, manager, front desk), `marketing.manage` (owner, manager), `marketing.inbox` (owner, manager, front desk).
