// Shared HTTP helpers for the edge functions (Deno, Supabase Edge Runtime).

export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

/** Errors the app understands: { code, message } (code matches StoreError codes). */
export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export function env(name: string, fallback?: string): string {
  const v = Deno.env.get(name) ?? fallback;
  if (v === undefined || v === '') throw new HttpError(500, 'CONFIG', `Server setting ${name} is missing.`);
  return v;
}

/** Wrap a handler: CORS preflight, JSON errors, logging. */
export function serve(handler: (req: Request) => Promise<Response>): void {
  Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
    try {
      return await handler(req);
    } catch (e) {
      if (e instanceof HttpError) return json({ code: e.code, message: e.message }, e.status);
      const msg = e instanceof Error ? e.message : String(e);
      // Database functions raise 'CODE: friendly message'.
      const m = /^([A-Z][A-Z_]+):\s*([\s\S]*)$/.exec(msg);
      if (m) return json({ code: m[1], message: m[2] }, 400);
      console.error(e);
      return json({ code: 'ERROR', message: 'Something went wrong. Please try again.' }, 500);
    }
  });
}

/** For scheduled/internal calls: the x-cron-secret header must match CRON_SECRET. */
export function requireCronSecret(req: Request): void {
  const want = Deno.env.get('CRON_SECRET') ?? '';
  const got = req.headers.get('x-cron-secret') ?? '';
  if (!want || !timingSafeEqual(got, want)) throw new HttpError(401, 'NOT_ALLOWED', 'Not allowed.');
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Only redirect back to our own app (stops checkout being used as an open redirect). */
export function safeReturnUrl(candidate: unknown): string {
  const allowed = (Deno.env.get('APP_URLS') ?? Deno.env.get('APP_URL') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const fallback = allowed[0] ?? '';
  if (typeof candidate !== 'string' || !candidate) {
    if (!fallback) throw new HttpError(500, 'CONFIG', 'Server setting APP_URL is missing.');
    return fallback;
  }
  try {
    const u = new URL(candidate);
    // The multi-studio platform: every studio's subdomain of PLATFORM_DOMAIN is ours too (https only).
    const platform = (Deno.env.get('PLATFORM_DOMAIN') ?? '').trim().toLowerCase();
    const onPlatform = !!platform && u.protocol === 'https:' && (u.hostname === platform || u.hostname.endsWith(`.${platform}`));
    const ok = onPlatform || allowed.some((a) => {
      try { return new URL(a).origin === u.origin; } catch { return a === candidate; }
    }) || u.protocol === 'capacitor:' || u.protocol === 'snowypilates:';
    if (ok) return candidate;
  } catch { /* fall through */ }
  if (!fallback) throw new HttpError(400, 'NOT_ALLOWED', 'That return address isn’t allowed.');
  return fallback;
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    return b && typeof b === 'object' ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
