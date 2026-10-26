/**
 * Client app: the calm notification opt-in.
 *   - PushSwitchRow   a row in Profile (slot client.account) with a switch. Hidden when this browser can't do web push or there's no VAPID key.
 *   - PushPrompt      a one-time, gentle line on the "you're booked in" screen (slot client.booked), only after a client's first booking.
 * Both go through usePushOptIn: Notification.requestPermission + PushManager.subscribe (push.ts), then the marketing device registration.
 * Capacitor (native apps, later): canOptIn() is web only for now. When APNs / FCM sending exists, pushProvider() already returns the
 * Capacitor provider inside the native shell, so this same hook works there once canOptIn allows it.
 */
import React, { useState } from 'react';
import { errorMessage, store, useData, useToast } from '../../../shared/react';
import { Icon, Toggle, useApp } from '../../../client/ui';
import { needMarketing } from '../api';
import { canOptIn, pushProvider, saveToken, savedToken, VAPID_PUBLIC_KEY } from '../push';

const ASKED = 'mk-push-asked';
const asked = (): boolean => { try { return localStorage.getItem(ASKED) === '1'; } catch { return true; } };
const markAsked = (): void => { try { localStorage.setItem(ASKED, '1'); } catch { /* private mode: we just might ask again */ } };

export function usePushOptIn() {
  const toast = useToast();
  const status = useData(() => needMarketing().getPushStatus(), []);
  const [busy, setBusy] = useState(false);
  const key = VAPID_PUBLIC_KEY || status.data?.vapidPublicKey || '';
  const available = canOptIn(status.data?.vapidPublicKey) && !!status.data;
  const on = !!status.data?.registered && !!savedToken();
  const set = async (v: boolean): Promise<boolean> => {
    const p = pushProvider();
    setBusy(true);
    try {
      if (v) {
        const reg = await p.subscribe({ vapidPublicKey: key });
        await needMarketing().registerPush(reg); saveToken(reg.token); toast('Notifications are on');
      } else {
        const t = (await p.unsubscribe()) ?? savedToken();
        if (t) await needMarketing().unregisterPush(t);
        saveToken(null); toast('Notifications are off');
      }
      status.reload();
      return true;
    } catch (x) { toast(errorMessage(x)); return false; } finally { setBusy(false); }
  };
  return { available, on, busy, set, permission: pushProvider().permission() };
}

/** Profile row. */
export function PushSwitchRow() {
  const o = usePushOptIn();
  if (!o.available) return null;
  return (
    <div className="list-row">
      <span className="row-ic"><Icon name="bell" size={20} /></span>
      <span className="list-row-main"><span className="list-row-title">Notifications</span><span className="list-row-sub">A nudge on this device when the studio replies</span></span>
      <Toggle checked={o.on} disabled={o.busy} onChange={(v) => void o.set(v)} label="Notifications on this device" />
    </div>
  );
}

/** One gentle ask after a client's very first booking. Never shown again once they've answered, and never if it can't work. */
export function PushPrompt() {
  const app = useApp();
  const cid = app.client.id;
  const o = usePushOptIn();
  const [gone, setGone] = useState(false);
  // "first booking": they have exactly one booking so far (this one)
  const mine = useData(() => store.listClientBookings(cid, { when: 'all' }), [cid]);
  const first = !!mine.data && mine.data.length === 1;
  if (gone || !o.available || o.on || o.permission !== 'default' || !first || asked()) return null;
  const answer = async (yes: boolean) => {
    markAsked();
    if (yes) await o.set(true);
    setGone(true);
  };
  return (
    <div className="mk-notify mk-prompt" role="group" aria-label="Notifications">
      <span className="row-ic"><Icon name="bell" size={20} /></span>
      <span className="mk-notify-t"><strong>Want a nudge when we reply?</strong><span>You can change this any time in Profile.</span></span>
      <span className="mk-prompt-btns">
        <button className="btn sm" disabled={o.busy} onClick={() => void answer(true)}>Turn on</button>
        <button className="btn soft sm" disabled={o.busy} onClick={() => void answer(false)}>Not now</button>
      </span>
    </div>
  );
}
