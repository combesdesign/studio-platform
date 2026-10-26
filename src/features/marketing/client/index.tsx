/**
 * Marketing: client app UI.
 *   /messages   a conversation with the studio, plus a switch for notifications on this device (Profile entry "Messages")
 *   Profile switch + one-time prompt after a first booking (notify.tsx)
 * News and offers opt-out already lives in Profile; every marketing email also carries a one-click unsubscribe link.
 */
import React from 'react';
import '../permissions';
import { registerClientProfileEntry, registerClientRoute, registerSlot } from '../../../shared/registry';
import { MessagesIcon, MessagesScreen } from './messages';
import { PushPrompt, PushSwitchRow } from './notify';
import './client.css';

registerClientRoute({ id: 'marketing.messages', feature: 'marketing', path: '/messages', tab: '/profile', chrome: false, render: ({ nav, path }) => <MessagesScreen nav={nav} path={path} /> });
registerClientProfileEntry({ id: 'marketing.messages', feature: 'marketing', label: 'Messages', sub: 'Write to the studio', icon: <MessagesIcon />, path: '/messages', order: 15 });
// Notifications opt-in: a switch in Profile, and one gentle ask after a client's first booking (both hide when push can't work here).
registerSlot('client.account', { id: 'marketing.push', feature: 'marketing', order: 20, render: () => <PushSwitchRow /> });
registerSlot('client.booked', { id: 'marketing.push-prompt', feature: 'marketing', order: 20, render: () => <PushPrompt /> });
