/**
 * Kiosk: studio app UI. "Kiosk mode" in the nav (owner, manager, front desk) opens the full-screen client check-in;
 * Settings › Kiosk sets the exit PIN.
 */
import React from 'react';
import '../permissions';
import { registerSettingsTab, registerStudioNav, registerStudioRoute } from '../../../shared/registry';
import { KioskPage } from './page';
import { KioskSettingsTab } from './settings';
import { installKioskStyles } from './style';

installKioskStyles();

const tablet = (
  <svg className="ic" width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="4.5" y="3" width="15" height="18" rx="2.5" /><path d="M10.5 17.5h3" /><path d="m9 10.5 2.2 2.2L15.5 8.5" />
  </svg>
);
registerStudioNav({ id: 'kiosk', label: 'Kiosk mode', short: 'Kiosk', icon: tablet, href: '#/kiosk', order: 45, perm: 'kiosk.use' });
registerStudioRoute({ id: 'kiosk', path: '/kiosk', nav: 'kiosk', perm: 'kiosk.use', render: () => <KioskPage /> });
registerSettingsTab({ id: 'kiosk', label: 'Kiosk', order: 85, perm: 'kiosk.manage', render: () => <KioskSettingsTab /> });
