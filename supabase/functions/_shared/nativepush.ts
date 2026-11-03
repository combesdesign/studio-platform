// Push to the native Capacitor apps, with Web Crypto only (no npm packages).
//   Android -> FCM HTTP v1. OAuth2 access token from a service account (RS256 JWT), cached until it expires.
//   iOS     -> APNs directly (ES256 provider token from a .p8 key). The Capacitor push plugin hands us raw APNs tokens on iOS,
//              so this needs no Firebase SDK in the iPhone app. Assumes Deno's fetch negotiates HTTP/2 (APNs requires it); Deno does.
// Env: FCM_SERVICE_ACCOUNT (the service-account JSON), APNS_KEY_P8, APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID (single studio build)
//      or APNS_BUNDLE_IDS (JSON {"slug":"com.bundle.id"}), APNS_SANDBOX=1 for development builds.
import { b64uToBytes, bytesToB64u } from './webpush.ts';

const enc = new TextEncoder();
export interface NativeNote { title: string; body: string; url: string; tag: string }
/** `gone`: the token is dead for good, delete it. Anything else that fails is worth retrying. */
export interface NativeResult { ok: boolean; gone: boolean; error?: string }
type Get = (k: string) => string | undefined;

const b64u = (s: string | Uint8Array) => bytesToB64u(typeof s === 'string' ? enc.encode(s) : s);
function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/\\n/g, '\n').replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(body);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// ---------------------------------------------------------------- Android (FCM)

export interface FcmAccount { projectId: string; clientEmail: string; privateKey: string }
export function fcmFromEnv(get: Get): FcmAccount | null {
  const raw = get('FCM_SERVICE_ACCOUNT');
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    if (!j.project_id || !j.client_email || !j.private_key) return null;
    return { projectId: j.project_id, clientEmail: j.client_email, privateKey: j.private_key };
  } catch { return null; }
}

let fcmToken: { key: string; token: string; exp: number } | null = null;
/** Exchange a signed RS256 JWT for an access token (valid about an hour); reused until a minute before it ends. */
export async function fcmAccessToken(a: FcmAccount, nowMs = Date.now()): Promise<string> {
  if (fcmToken && fcmToken.key === a.clientEmail && fcmToken.exp - 60_000 > nowMs) return fcmToken.token;
  const iat = Math.floor(nowMs / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64u(JSON.stringify({ iss: a.clientEmail, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 }));
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(a.privateKey), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${head}.${claims}`)));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${b64u(sig)}` }).toString(),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`FCM auth failed (${res.status})`);
  fcmToken = { key: a.clientEmail, token: j.access_token, exp: nowMs + Number(j.expires_in ?? 3600) * 1000 };
  return j.access_token;
}

export async function sendFcm(token: string, note: NativeNote, a: FcmAccount): Promise<NativeResult> {
  try {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${a.projectId}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await fcmAccessToken(a)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { token, notification: { title: note.title, body: note.body }, data: { url: note.url, tag: note.tag }, android: { collapse_key: note.tag, priority: 'HIGH', notification: { tag: note.tag } } } }),
    });
    if (res.ok) return { ok: true, gone: false };
    const j = await res.json().catch(() => ({}));
    const codes = JSON.stringify(j?.error?.details ?? []) + (j?.error?.status ?? '');
    // UNREGISTERED (or a plain 404) means the app was removed. INVALID_ARGUMENT on a token is a malformed one, also useless.
    const gone = res.status === 404 || /UNREGISTERED/.test(codes) || (res.status === 400 && /INVALID_ARGUMENT/.test(codes) && /registration token|token/i.test(String(j?.error?.message ?? '')));
    return { ok: false, gone, error: `FCM ${res.status} ${j?.error?.status ?? ''}`.trim() };
  } catch (e) { return { ok: false, gone: false, error: e instanceof Error ? e.message : String(e) }; }
}

// ---------------------------------------------------------------- iPhone (APNs)

export interface ApnsKeys { p8: string; keyId: string; teamId: string; sandbox: boolean; bundleId: string | null; bundleIds: Record<string, string> }
export function apnsFromEnv(get: Get): ApnsKeys | null {
  const p8 = get('APNS_KEY_P8'), keyId = get('APNS_KEY_ID'), teamId = get('APNS_TEAM_ID');
  if (!p8 || !keyId || !teamId) return null;
  let bundleIds: Record<string, string> = {};
  try { bundleIds = JSON.parse(get('APNS_BUNDLE_IDS') || '{}'); } catch { /* ignore */ }
  const bundleId = get('APNS_BUNDLE_ID') || null;
  if (!bundleId && !Object.keys(bundleIds).length) return null;
  return { p8, keyId, teamId, sandbox: get('APNS_SANDBOX') === '1', bundleId, bundleIds };
}
/** The app's bundle id for a studio (same as the Capacitor appId). */
export const apnsTopic = (k: ApnsKeys, slug: string): string | null => k.bundleIds[slug] || k.bundleId;

let apnsJwt: { key: string; jwt: string; at: number } | null = null;
/** Provider token: ES256, refreshed every 40 minutes (Apple wants one between 20 and 60 minutes old). */
export async function apnsToken(k: ApnsKeys, nowMs = Date.now()): Promise<string> {
  if (apnsJwt && apnsJwt.key === k.keyId + k.teamId && nowMs - apnsJwt.at < 40 * 60_000) return apnsJwt.jwt;
  const head = b64u(JSON.stringify({ alg: 'ES256', kid: k.keyId }));
  const claims = b64u(JSON.stringify({ iss: k.teamId, iat: Math.floor(nowMs / 1000) }));
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(k.p8), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${claims}`)));
  const jwt = `${head}.${claims}.${b64u(sig)}`;
  apnsJwt = { key: k.keyId + k.teamId, jwt, at: nowMs };
  return jwt;
}

export async function sendApns(token: string, note: NativeNote, k: ApnsKeys, topic: string): Promise<NativeResult> {
  try {
    const host = k.sandbox ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
    const res = await fetch(`https://${host}/3/device/${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { authorization: `bearer ${await apnsToken(k)}`, 'apns-topic': topic, 'apns-push-type': 'alert', 'apns-priority': '10', 'apns-collapse-id': note.tag.slice(0, 64), 'content-type': 'application/json' },
      body: JSON.stringify({ aps: { alert: { title: note.title, body: note.body }, sound: 'default' }, url: note.url, tag: note.tag }),
    });
    if (res.ok) return { ok: true, gone: false };
    const j = await res.json().catch(() => ({}));
    const reason = String(j?.reason ?? '');
    const gone = res.status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered' || reason === 'DeviceTokenNotForTopic';
    return { ok: false, gone, error: `APNs ${res.status} ${reason}`.trim() };
  } catch (e) { return { ok: false, gone: false, error: e instanceof Error ? e.message : String(e) }; }
}

/** Test hook: forget cached tokens. */
export function resetNativePushCache() { fcmToken = null; apnsJwt = null; }
void b64uToBytes;
