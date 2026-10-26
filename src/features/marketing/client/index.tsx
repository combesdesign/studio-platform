/**
 * Marketing: client app UI.
 *   /messages   a conversation with the studio, plus a switch for notifications on this device (Profile entry "Messages")
 * News and offers opt-out already lives in Profile; every marketing email also carries a one-click unsubscribe link.
 */
import React from 'react';
import '../permissions';
import { registerClientProfileEntry, registerClientRoute } from '../../../shared/registry';
import { MessagesIcon, MessagesScreen } from './messages';
import './client.css';

registerClientRoute({ id: 'marketing.messages', path: '/messages', tab: '/profile', chrome: false, render: ({ nav, path }) => <MessagesScreen nav={nav} path={path} /> });
registerClientProfileEntry({ id: 'marketing.messages', label: 'Messages', sub: 'Write to the studio', icon: <MessagesIcon />, path: '/messages', order: 15 });
