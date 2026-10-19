/**
 * Input checks shared by the demo and live stores, so both give the same friendly messages.
 * The database re-checks everything (supabase/migrations/1200_marketing_*.sql); these just fail early and kindly.
 */
import { automationDef, ruleDef } from './catalog';
import { smsInfo, buildSms } from './render';
import type { Automation, AutomationInput, CampaignInput, EmailBlock, SegmentFilter, SegmentRule } from './types';

export type MakeError = (code: string, message: string) => Error;

const RULE_TYPES = new Set(['active_member', 'pack_low', 'no_visit', 'intro', 'birthday_month', 'opted_in', 'tag', 'new_client']);
const int = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

export function cleanFilter(f: SegmentFilter | undefined, err: MakeError): SegmentFilter {
  if (!f || typeof f !== 'object') return { match: 'all', rules: [] };
  const rules = Array.isArray(f.rules) ? f.rules : [];
  if (rules.length > 12) throw err('INVALID', 'That’s a lot of rules. Keep it to 12 or fewer.');
  const out: SegmentRule[] = rules.map((r) => {
    if (!r || !RULE_TYPES.has(r.type)) throw err('INVALID', 'One of the rules isn’t recognised.');
    const def = ruleDef(r.type);
    const o: SegmentRule = { type: r.type };
    if (r.not) o.not = true;
    if (def.params?.includes('days')) o.days = int(r.days, 1, 730, def.defaults?.days ?? 30);
    if (def.params?.includes('credits')) o.credits = int(r.credits, 0, 100, def.defaults?.credits ?? 1);
    if (def.params?.includes('tag')) {
      const tag = String(r.tag ?? '').trim().slice(0, 24);
      if (!tag) throw err('INVALID', 'Pick a tag for the tag rule.');
      o.tag = tag;
    }
    return o;
  });
  return { match: f.match === 'any' ? 'any' : 'all', rules: out };
}

export function cleanTags(tags: string[], err: MakeError): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags ?? []) {
    const t = String(raw).replace(/\s+/g, ' ').trim().slice(0, 24);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  if (out.length > 10) throw err('INVALID', 'A client can have up to 10 tags.');
  return out;
}

export function cleanBody(body: string, err: MakeError): string {
  const t = String(body ?? '').replace(/\r\n/g, '\n').trim();
  if (!t) throw err('INVALID', 'Write a message first.');
  if (t.length > 2000) throw err('INVALID', 'Messages can be up to 2,000 characters.');
  return t;
}

const hasContent = (b: EmailBlock) =>
  b.type === 'divider' ? false : b.type === 'image' ? !!b.src?.trim() : b.type === 'button' ? !!(b.label?.trim() && b.url?.trim()) : !!b.text?.trim();

/** Check a campaign. forSend also needs everything a recipient will see (subject, content, working buttons). */
export function validateCampaign(c: Pick<CampaignInput, 'name' | 'channel' | 'subject' | 'preheader' | 'blocks' | 'body'>, err: MakeError, o: { forSend: boolean }): {
  name: string; channel: 'email' | 'sms'; subject: string; preheader: string; blocks: EmailBlock[]; body: string;
} {
  const name = String(c.name ?? '').trim();
  if (!name) throw err('INVALID', 'Give the campaign a name so you can find it later.');
  if (name.length > 80) throw err('INVALID', 'Campaign names can be up to 80 characters.');
  const channel = c.channel === 'sms' ? 'sms' : 'email';
  const subject = String(c.subject ?? '').trim();
  const preheader = String(c.preheader ?? '').trim().slice(0, 140);
  const body = String(c.body ?? '').replace(/\r\n/g, '\n').trim();
  const blocks: EmailBlock[] = (c.blocks ?? []).slice(0, 40).map((b, i) => ({
    id: b.id || `b${i + 1}`, type: b.type,
    ...(b.text !== undefined ? { text: String(b.text).slice(0, 5000) } : {}), ...(b.src !== undefined ? { src: String(b.src).slice(0, 1000) } : {}),
    ...(b.alt !== undefined ? { alt: String(b.alt).slice(0, 200) } : {}), ...(b.label !== undefined ? { label: String(b.label).slice(0, 80) } : {}),
    ...(b.url !== undefined ? { url: String(b.url).trim().slice(0, 1000) } : {}),
  }));
  for (const b of blocks) {
    if (!['heading', 'text', 'image', 'button', 'divider'].includes(b.type)) throw err('INVALID', 'One of the blocks isn’t recognised.');
    if (b.url && !/^(https?:\/\/|mailto:|tel:|\{\{\s*app_url\s*\}\})/i.test(b.url)) throw err('INVALID', 'Links need to start with https:// (or be the app link).');
  }
  if (o.forSend) {
    if (channel === 'email') {
      if (!subject) throw err('INVALID', 'Add a subject line before sending.');
      if (!blocks.some(hasContent)) throw err('INVALID', 'Add some content before sending.');
      const bad = blocks.find((b) => b.type === 'button' && (!b.label?.trim() || !b.url?.trim()));
      if (bad) throw err('INVALID', 'Your button needs a label and a link.');
      if (blocks.some((b) => b.type === 'image' && !b.src?.trim())) throw err('INVALID', 'One of your images has no picture yet.');
    } else {
      if (!body) throw err('INVALID', 'Write the text message before sending.');
      const info = smsInfo(buildSms(body, { first_name: 'Alex', last_name: 'Smith', studio_name: 'Studio', app_url: 'https://app.example/' }));
      if (info.segments > 4) throw err('INVALID', 'That text is too long. Keep it to 4 message parts (about 600 characters) or fewer.');
    }
  }
  return { name, channel, subject, preheader, blocks, body };
}

export function cleanAutomation(input: AutomationInput, cur: Automation, err: MakeError): Partial<Automation> {
  const def = automationDef(cur.key);
  const out: Partial<Automation> = {};
  if (input.enabled !== undefined) out.enabled = !!input.enabled;
  if (input.channel !== undefined) out.channel = input.channel === 'sms' ? 'sms' : 'email';
  if (input.delay !== undefined) {
    const n = Math.round(Number(input.delay));
    if (!Number.isFinite(n) || n < def.delay.min || n > def.delay.max) throw err('INVALID', `Choose between ${def.delay.min} and ${def.delay.max} days.`);
    out.delay = n;
  }
  const text = (k: 'subject' | 'heading' | 'body' | 'buttonLabel', max: number) => {
    if (input[k] === undefined) return;
    const t = String(input[k]).replace(/\r\n/g, '\n').trim();
    if (t.length > max) throw err('INVALID', `That’s too long. Keep it under ${max} characters.`);
    out[k] = t;
  };
  text('subject', 150); text('heading', 120); text('body', 3000); text('buttonLabel', 40);
  const next = { ...cur, ...out };
  if (next.enabled) {
    if (next.channel === 'email' && !next.subject.trim()) throw err('INVALID', 'Add a subject line first.');
    if (!next.body.trim()) throw err('INVALID', 'Write the message first.');
    if (next.channel === 'sms') {
      const info = smsInfo(buildSms(next.body, { first_name: 'Alex', studio_name: 'Studio', app_url: 'https://app.example/' }));
      if (info.segments > 4) throw err('INVALID', 'That text is too long for an SMS. Keep it to about 600 characters.');
    }
  }
  return out;
}
