/**
 * Appointments: studio app UI.
 *   Appointments (#/appointments[/events|/hours])  the week calendar, workshops / courses / events, instructors' hours
 *   Settings › Appointments                         booking rules, session types, packs
 *   Today › Today's privates                        side widget
 *   client.profile                                  a client's private sessions, credits, book and sell a pack
 */
import React from 'react';
import '../permissions';
import { registerSettingsTab, registerSlot, registerStudioNav, registerStudioRoute, registerTodayWidget } from '../../../shared/registry';
import { AppointmentsPage } from './page';
import { AppointmentSettingsTab } from './settings';
import { ClientAppointmentsCard, TodaysAppointments } from './widgets';
import '../appointments.css';

registerStudioNav({ id: 'appointments', feature: 'appointments', label: 'Appointments', short: 'Appts', icon: 'calendar', href: '#/appointments', order: 25, perm: 'appointments.view' });
registerStudioRoute({ id: 'appointments', feature: 'appointments', path: '/appointments', nav: 'appointments', perm: 'appointments.view', render: () => <AppointmentsPage /> });
registerStudioRoute({ id: 'appointments.tab', feature: 'appointments', path: '/appointments/:tab', nav: 'appointments', perm: 'appointments.view', render: ({ params }) => <AppointmentsPage tab={params.tab} /> });
registerSettingsTab({ id: 'appointments', feature: 'appointments', label: 'Appointments', order: 35, perm: 'appointments.manage', render: () => <AppointmentSettingsTab /> });
registerTodayWidget({ id: 'appointments.today', feature: 'appointments', column: 'side', order: 20, perm: 'appointments.view', render: () => <TodaysAppointments /> });
registerSlot('client.profile', { id: 'appointments.client', feature: 'appointments', order: 35, perm: 'appointments.book', render: ({ client }) => <ClientAppointmentsCard client={client} /> });
