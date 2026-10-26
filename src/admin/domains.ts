/**
 * Custom domains for a studio (platform admin). Pure helpers: tidy what Pete typed, and say what's wrong with it.
 * The database does the final check too (migration 1800: valid host name, at most 10, one domain on one studio),
 * but the demo store has no such check, so this is the check that counts there.
 */
export const MAX_DOMAINS = 10;
const HOST = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** "https://Book.Example.com:443/classes?x=1" -> "book.example.com" */
export function normaliseDomain(raw: string): string {
  let d = raw.trim().toLowerCase();
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  d = d.replace(/[/?#].*$/, '').replace(/^[^@]*@/, '').replace(/:\d+$/, '').replace(/\.+$/, '');
  return d;
}

export interface DomainContext {
  platformDomain: string;
  /** Domains already on this studio. */
  existing: string[];
  /** Domain -> name of the other studio that uses it. */
  takenBy: Record<string, string>;
}

/** Why a domain can't be added, in plain words, or '' when it's fine. */
export function domainProblem(domain: string, ctx: DomainContext): string {
  if (!domain) return 'Type a domain, like book.yourstudio.com.au.';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(domain)) return 'That is an IP address. Use a domain name, like book.yourstudio.com.au.';
  if (domain === 'localhost' || !domain.includes('.')) return 'That does not look like a full domain name. It needs a dot, like book.yourstudio.com.au.';
  if (!HOST.test(domain)) return 'That is not a valid domain name. Use letters, numbers and dashes only, like book.yourstudio.com.au.';
  const p = ctx.platformDomain.toLowerCase();
  if (p && (domain === p || domain.endsWith('.' + p))) return `${domain} is on the platform's own domain. Studios get their ${p} address automatically.`;
  if (ctx.existing.includes(domain)) return 'This studio already has that domain.';
  if (ctx.takenBy[domain]) return `${domain} is already linked to ${ctx.takenBy[domain]}. A domain can only belong to one studio.`;
  if (ctx.existing.length >= MAX_DOMAINS) return `A studio can have up to ${MAX_DOMAINS} domains.`;
  return '';
}

/** Domain -> studio name for every studio except `exceptId`. */
export function domainOwners(studios: { id: string; name: string; customDomains?: string[] }[], exceptId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of studios) if (s.id !== exceptId) for (const d of s.customDomains ?? []) out[d.toLowerCase()] = s.name;
  return out;
}

export interface DnsStep { title: string; body: string; record?: { type: string; name: string; value: string } }

/** A root domain (yourstudio.com.au) can't carry a CNAME, a sub-domain (book.yourstudio.com.au) can. Good enough without a public-suffix list. */
export function isApex(domain: string): boolean {
  const parts = domain.split('.');
  const second = ['com', 'net', 'org', 'co', 'edu', 'gov'];
  return parts.length <= 2 || (parts.length === 3 && second.includes(parts[1] ?? '') && (parts[2] ?? '').length === 2);
}

/** What to tell the studio (and what Pete does on his side) to bring a domain online. */
export function dnsSteps(domain: string, slug: string, platformDomain: string): DnsStep[] {
  const target = platformDomain ? `${slug}.${platformDomain}` : 'your-platform-address (the Netlify site, e.g. your-site.netlify.app)';
  const apex = isApex(domain);
  const labelOf = domain.split('.')[0] ?? domain;
  return [
    apex
      ? { title: 'At the studio’s domain provider', body: `${domain} is a root domain, and root domains can’t use a CNAME. Add an ALIAS or ANAME record (or an A record to Netlify’s load balancer, 75.2.60.5) pointing at the platform. If the provider offers neither, use a sub-domain such as book.${domain} instead.`, record: { type: 'ALIAS / ANAME', name: '@', value: target } }
      : { title: 'At the studio’s domain provider', body: `Add a CNAME record so ${domain} points at the platform.`, record: { type: 'CNAME', name: labelOf, value: target } },
    { title: 'In Netlify (once per domain)', body: `Site configuration › Domain management › Add a domain alias › ${domain}. HTTPS is issued automatically once the DNS has caught up, which can take from a few minutes up to a day.` },
    { title: 'In Supabase (once per domain)', body: `Authentication › URL Configuration › Redirect URLs: add https://${domain}/** so sign-in links come back to the studio’s own address.` },
    { title: 'Check it', body: `Open https://${domain}. It should show the studio’s client app. Add /studio/ for the studio app.` },
  ];
}
