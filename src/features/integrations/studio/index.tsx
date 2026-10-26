/**
 * Integrations: studio app UI.
 *   Settings › Partners      ClassPass / Gympass: IDs, write-only keys, spots held per class type
 *   Settings › Xero export   account codes and the sales export (sales invoices or manual journals CSV)
 *   roster.entry / header    a badge on partner bookings, and the spots held line
 */
import React from 'react';
import '../permissions';
import { registerSettingsTab, registerSlot } from '../../../shared/registry';
import { PartnersTab } from './partners';
import { PartnerChip, PartnerHeld } from './roster';
import { XeroTab } from './xero';
import './integrations.css';

registerSettingsTab({ id: 'integrations', feature: 'integrations', label: 'Partners', order: 60, perm: 'integrations.manage', render: () => <PartnersTab /> });
registerSettingsTab({ id: 'integrations.xero', feature: 'integrations', label: 'Xero export', order: 61, perm: 'integrations.accounting', render: () => <XeroTab /> });
registerSlot('roster.entry', { id: 'integrations.badge', feature: 'integrations', order: 20, perm: 'integrations.view', render: ({ entry, session }) => <PartnerChip bookingId={entry.id} sessionId={session.id} /> });
registerSlot('roster.header', { id: 'integrations.held', feature: 'integrations', order: 20, perm: 'integrations.view', render: ({ session }) => <PartnerHeld session={session} /> });
