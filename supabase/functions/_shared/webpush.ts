// Web Push for the edge functions, with Web Crypto only (no npm packages).
//   VAPID (RFC 8292): an ES256 JWT for the push service's origin, sent as `Authorization: vapid t=<jwt>, k=<public key>`.
//   Payload encryption (RFC 8291 + RFC 8188, "aes128gcm"): the notification JSON is encrypted to the browser's p256dh key and
//   auth secret, so only that browser can read it. A subscription without keys gets an empty (payload-less) push instead and the
//   service worker shows a generic "You have a new message".
// Env: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (both base64url, as `npx web-push generate-vapid-keys` prints them), VAPID_SUBJECT (mailto: or https: URL).

const enc = new TextEncoder();

export function b64uToBytes(s: string): Uint8Array {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
export function bytesToB64u(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

export interface VapidKeys { publicKey: string; privateKey: string; subject: string }

/** The three env settings, or null when web push isn't switched on. */
export function vapidFromEnv(get: (k: string) => string | undefined): VapidKeys | null {
  const publicKey = (get('VAPID_PUBLIC_KEY') ?? '').trim(), privateKey = (get('VAPID_PRIVATE_KEY') ?? '').trim();
  const subject = (get('VAPID_SUBJECT') ?? '').trim();
  return publicKey && privateKey && subject ? { publicKey, privateKey, subject } : null;
}

/** The ES256 JWT that proves who is sending. Valid for 12 hours (the limit is 24). */
export async function vapidJwt(audience: string, v: VapidKeys, nowMs = Date.now()): Promise<string> {
  const pub = b64uToBytes(v.publicKey); // 0x04 || x (32) || y (32)
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID_PUBLIC_KEY must be the 65-byte uncompressed key from web-push generate-vapid-keys.');
  const key = await crypto.subtle.importKey('jwk',
    { kty: 'EC', crv: 'P-256', d: v.privateKey, x: bytesToB64u(pub.slice(1, 33)), y: bytesToB64u(pub.slice(33, 65)), ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = bytesToB64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = bytesToB64u(enc.encode(JSON.stringify({ aud: audience, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: v.subject })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${claims}`))); // raw r||s, what JWT wants
  return `${head}.${claims}.${bytesToB64u(sig)}`;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, bytes * 8));
}

/** Encrypt `plaintext` for one subscription: the complete aes128gcm request body (header + one record). */
export async function encryptPayload(plaintext: Uint8Array, p256dh: string, auth: string): Promise<Uint8Array> {
  const uaPublic = b64uToBytes(p256dh), authSecret = b64uToBytes(auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('Bad subscription keys');
  if (plaintext.length > 3993) throw new Error('Push payload too large'); // 4096 record - 86 header - 17 (delimiter + tag)
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const record = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(plaintext, new Uint8Array([2])))); // 0x02 = last record
  const header = new Uint8Array(21 + 65);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = 65;
  header.set(asPublic, 21);
  return concat(header, record);
}

export interface WebPushResult { ok: boolean; status: number; /** the subscription is gone for good (404 / 410): delete it */ expired: boolean; error?: string }

/** Send one push. `payload` null (or a subscription without keys) sends an empty push. Never throws on a push-service error. */
export async function sendWebPush(
  sub: { endpoint: string; keys?: { p256dh?: string; auth?: string } | null },
  payload: unknown | null,
  vapid: VapidKeys,
  opts: { ttl?: number; urgency?: 'very-low' | 'low' | 'normal' | 'high'; topic?: string } = {},
): Promise<WebPushResult> {
  try {
    const url = new URL(sub.endpoint);
    if (url.protocol !== 'https:') return { ok: false, status: 0, expired: false, error: 'Push endpoint must be https' };
    const headers: Record<string, string> = {
      Authorization: `vapid t=${await vapidJwt(url.origin, vapid)}, k=${vapid.publicKey}`,
      TTL: String(opts.ttl ?? 86400),
      Urgency: opts.urgency ?? 'normal',
    };
    if (opts.topic) headers.Topic = opts.topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
    let body: Uint8Array | undefined;
    if (payload != null && sub.keys?.p256dh && sub.keys.auth) {
      body = await encryptPayload(enc.encode(JSON.stringify(payload)), sub.keys.p256dh, sub.keys.auth);
      headers['Content-Encoding'] = 'aes128gcm';
      headers['Content-Type'] = 'application/octet-stream';
    }
    const res = await fetch(sub.endpoint, { method: 'POST', headers, body });
    const text = res.ok ? '' : (await res.text().catch(() => '')).slice(0, 200);
    return { ok: res.ok, status: res.status, expired: res.status === 404 || res.status === 410, ...(res.ok ? {} : { error: `Push service ${res.status} ${text}`.trim() }) };
  } catch (e) {
    return { ok: false, status: 0, expired: false, error: e instanceof Error ? e.message : String(e) };
  }
}
