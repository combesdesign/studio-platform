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
import { ClientTagsCard, InboxWidget, MessageButton, SendTextButton } from './widgets';
import './studio.css';

registerStudioNav({ id: 'marketing', feature: 'marketing', label: 'Marketing', short: 'Marketing', icon: 'mail', href: '#/marketing', order: 47, perm: 'marketing.view' });
registerStudioRoute({ id: 'marketing', feature: 'marketing', path: '/marketing', nav: 'marketing', perm: 'marketing.view', render: () => <MarketingPage /> });
registerStudioRoute({ id: 'marketing.tab', feature: 'marketing', path: '/marketing/:tab', nav: 'marketing', perm: 'marketing.view', render: ({ params }) => <MarketingPage tab={params.tab} /> });
registerStudioRoute({ id: 'marketing.thread', feature: 'marketing', path: '/marketing/inbox/:id', nav: 'marketing', perm: 'marketing.inbox', render: ({ params }) => <MarketingPage tab="inbox" id={params.id} /> });
registerSettingsTab({ id: 'marketing', feature: 'marketing', label: 'Marketing', order: 47, perm: 'marketing.view', render: () => <MarketingSettingsTab /> });
registerTodayWidget({ id: 'marketing.inbox', feature: 'marketing', column: 'side', order: 20, perm: 'marketing.inbox', render: () => <InboxWidget /> });
registerSlot('client.profile.actions', { id: 'marketing.message', feature: 'marketing', order: 20, perm: 'marketing.inbox', render: ({ client }) => <MessageButton client={client} /> });
registerSlot('client.profile.actions', { id: 'marketing.text', feature: 'marketing', order: 21, perm: 'marketing.inbox', render: ({ client }) => <SendTextButton client={client} /> });
registerSlot('client.profile', { id: 'marketing.client', feature: 'marketing', order: 50, perm: 'marketing.view', render: ({ client }) => <ClientTagsCard client={client} /> });
