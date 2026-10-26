/**
 * Appointments: client app UI.
 *   /appointments   Privates and events: book a private or duet, buy a pack, sign up to workshops and courses, see what's booked
 *                   (Profile entry; the fifth tab is already the online library, so it isn't a tab)
 *   client.timetable  a small banner at the top of the timetable linking to it
 */
import React from 'react';
import '../permissions';
import { registerClientProfileEntry, registerClientRoute, registerSlot } from '../../../shared/registry';
import { ApptIcon, AppointmentsScreen, TimetableBanner } from './screens';
import '../appointments.css';

registerClientRoute({ id: 'appointments.home', feature: 'appointments', path: '/appointments', tab: '/profile', render: ({ nav, path }) => <AppointmentsScreen nav={nav} path={path} /> });
registerClientProfileEntry({ id: 'appointments.home', feature: 'appointments', label: 'Privates and events', sub: 'Book a one on one, workshops and courses', icon: <ApptIcon />, path: '/appointments', order: 15 });
registerSlot('client.timetable', { id: 'appointments.banner', feature: 'appointments', order: 40, render: () => <TimetableBannerSlot /> });

function TimetableBannerSlot() {
  const nav = (to: string) => { location.hash = '#' + to; };
  return <TimetableBanner nav={nav} />;
}
