// POST { action: 'register' | 'list' | 'remove', code?, label?, readerId? }   (register / remove: owner or manager; list: any staff)
// Manages the studio's Stripe Terminal readers (Stripe Reader S700 / BBPOS WisePOS E, which are driven from the server).
//   register: makes the studio's Terminal Location the first time, then registers the reader with the code shown on its screen
//             (Settings on the reader > Generate pairing code; Stripe's simulated reader uses the code simulated-wpe).
//   list:     this studio's readers with their online status from Stripe.
//   remove:   deletes the reader in Stripe and forgets it. Another studio's reader id is "not found".
// Connect mode: every call is made on the studio's connected account (Stripe-Account header), like the other functions.
import { adminClient, must, userClient } from '../_shared/db.ts';
import { payAs } from '../_shared/connect.ts';
import { HttpError, json, readJson, serve } from '../_shared/http.ts';
import { stripe, type StripeObject } from '../_shared/stripe.ts';
import { requireStaffStudio } from '../_shared/terminal.ts';

const view = (r: StripeObject, label?: string) => ({
  id: String(r.id), label: String(label ?? r.label ?? ''), deviceType: String(r.device_type ?? ''), status: r.status === 'online' ? 'online' : 'offline',
  serialNumber: r.serial_number ? String(r.serial_number) : undefined,
});

serve(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'NOT_ALLOWED', 'Use POST.');
  const body = await readJson(req);
  const admin = adminClient();
  const staff = await requireStaffStudio(admin, userClient(req, String(body.studioId ?? '')));
  const action = String(body.action ?? 'list');
  const manage = ['owner', 'manager'].includes(staff.role);
  const pay = await payAs(admin, staff.studioId, 'Connect your Stripe account first (Settings > Payments), then add a card reader.');

  if (action === 'list') {
    const rows = must(await admin.from('terminal_readers').select('reader_id, label').eq('studio_id', staff.studioId).order('created_at', { ascending: true })) as { reader_id: string; label: string }[];
    const out = [];
    for (const row of rows) {
      let r: StripeObject = { id: row.reader_id, status: 'offline' };
      try { r = await stripe('GET', `terminal/readers/${row.reader_id}`, {}, undefined, pay.account); } catch (e) { console.warn('reader lookup failed', row.reader_id, e instanceof Error ? e.message : e); }
      out.push(view(r, row.label));
    }
    return json({ readers: out });
  }

  if (!manage) throw new HttpError(403, 'NOT_ALLOWED', 'Only the owner or a manager can change card readers.');

  if (action === 'register') {
    const code = String(body.code ?? '').trim();
    const label = String(body.label ?? '').trim().slice(0, 60) || 'Front desk';
    if (!/^[a-z0-9-]{3,40}$/i.test(code)) throw new HttpError(400, 'INVALID', 'Enter the pairing code shown on the reader (words separated by dashes).');
    // The studio's Terminal Location, made once.
    let loc = must(await admin.from('studio_terminal').select('location_id').eq('studio_id', staff.studioId).maybeSingle()) as { location_id: string } | null;
    if (!loc) {
      const studio = must(await admin.from('studios').select('name, address').eq('id', staff.studioId).maybeSingle()) as { name: string; address: string } | null;
      const parts = String(studio?.address ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const created = await stripe('POST', 'terminal/locations', {
        display_name: studio?.name || 'Studio',
        address: { line1: parts[0] || 'Studio', city: parts[1] || parts[0] || 'Studio', country: 'AU', state: 'NSW', postal_code: /\b\d{4}\b/.exec(String(studio?.address ?? ''))?.[0] || '2000' },
        metadata: { studio_id: staff.studioId },
      }, `terminal-location-${staff.studioId}`, pay.account);
      loc = { location_id: String(created.id) };
      must(await admin.from('studio_terminal').upsert({ studio_id: staff.studioId, location_id: loc.location_id }));
    }
    const reader = await stripe('POST', 'terminal/readers', { registration_code: code, label, location: loc.location_id, metadata: { studio_id: staff.studioId } }, undefined, pay.account);
    must(await admin.from('terminal_readers').upsert({ reader_id: String(reader.id), studio_id: staff.studioId, label }));
    return json({ reader: view(reader, label) });
  }

  if (action === 'remove') {
    const readerId = String(body.readerId ?? '');
    const row = must(await admin.from('terminal_readers').select('reader_id').eq('reader_id', readerId).eq('studio_id', staff.studioId).maybeSingle());
    if (!row) throw new HttpError(404, 'NOT_FOUND', 'We couldn’t find that card reader.');
    try { await stripe('DELETE', `terminal/readers/${readerId}`, {}, undefined, pay.account); } catch (e) { console.warn('reader delete failed (forgetting it anyway)', e instanceof Error ? e.message : e); }
    must(await admin.from('terminal_readers').delete().eq('reader_id', readerId).eq('studio_id', staff.studioId));
    return json({ removed: true });
  }

  throw new HttpError(400, 'INVALID', 'Unknown action.');
});
