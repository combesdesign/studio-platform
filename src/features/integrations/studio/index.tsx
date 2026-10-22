/**
 * Integrations: studio app UI.
 *   Settings › Partners      ClassPass / Gympass: IDs, write-only keys, spots held per class type
 *   roster.entry / header    a badge on partner bookings, and the spots held line
 */
import React from 'react';
import '../permissions';
import { registerSettingsTab, registerSlot } from '../../../shared/registry';
import { PartnersTab } from './partners';
import { PartnerChip, PartnerHeld } from './roster';
import './integrations.css';

registerSettingsTab({ id: 'integrations', label: 'Partners', order: 60, perm: 'integrations.manage', render: () => <PartnersTab /> });
registerSlot('roster.entry', { id: 'integrations.badge', order: 20, perm: 'integrations.view', render: ({ entry, session }) => <PartnerChip bookingId={entry.id} sessionId={session.id} /> });
registerSlot('roster.header', { id: 'integrations.held', order: 20, perm: 'integrations.view', render: ({ session }) => <PartnerHeld session={session} /> });
