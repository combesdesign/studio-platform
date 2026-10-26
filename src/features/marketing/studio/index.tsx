/**
 * Marketing: studio app UI.
 *   Marketing (#/marketing/<tab>)  Campaigns (email + text), Automations, Audiences, Inbox
 *   Settings › Marketing           sender details, provider status, this device's notifications
 *   Today › New messages           unread client messages
 *   client.profile(.actions)       tags + a Message button on a client's profile
 */
import React from 'react';
import '../permissions';
import { registerSettingsTab, registerSlot, registerStudioNav, registerStudioRoute, registerTodayWidget } from '../../../shared/registry';
import { MarketingPage } from './page';
import { MarketingSettingsTab } from './settings';
import { ClientTagsCard, InboxWidget, MessageButton } from './widgets';
import './studio.css';

registerStudioNav({ id: 'marketing', label: 'Marketing', short: 'Marketing', icon: 'mail', href: '#/marketing', order: 47, perm: 'marketing.view' });
registerStudioRoute({ id: 'marketing', path: '/marketing', nav: 'marketing', perm: 'marketing.view', render: () => <MarketingPage /> });
registerStudioRoute({ id: 'marketing.tab', path: '/marketing/:tab', nav: 'marketing', perm: 'marketing.view', render: ({ params }) => <MarketingPage tab={params.tab} /> });
registerStudioRoute({ id: 'marketing.thread', path: '/marketing/inbox/:id', nav: 'marketing', perm: 'marketing.inbox', render: ({ params }) => <MarketingPage tab="inbox" id={params.id} /> });
registerSettingsTab({ id: 'marketing', label: 'Marketing', order: 47, perm: 'marketing.view', render: () => <MarketingSettingsTab /> });
registerTodayWidget({ id: 'marketing.inbox', column: 'side', order: 20, perm: 'marketing.inbox', render: () => <InboxWidget /> });
registerSlot('client.profile.actions', { id: 'marketing.message', order: 20, perm: 'marketing.inbox', render: ({ client }) => <MessageButton client={client} /> });
registerSlot('client.profile', { id: 'marketing.client', order: 50, perm: 'marketing.view', render: ({ client }) => <ClientTagsCard client={client} /> });
