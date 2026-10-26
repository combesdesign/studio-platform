/**
 * Payroll: studio app UI. Cover (open · claimed · history), Payroll (pay periods, timesheets, rules), the front desk
 * clock and cover widgets on Today, the cover strip on the roster, pay rules on staff cards, and a Settings tab.
 */
import React from 'react';
import '../permissions';
import { registerSettingsTab, registerSlot, registerStudioNav, registerStudioRoute, registerTodayWidget } from '../../../shared/registry';
import { CoverPage, CoverToday, RosterCover } from './cover';
import { ClockWidget, MyTimesheet } from './clock';
import { PayrollPage, PayrollSettingsTab, StaffPayLine } from './payroll';
import { installPayrollStyles } from './style';

installPayrollStyles();

registerStudioNav({ id: 'payroll.cover', feature: 'payroll', label: 'Cover', icon: 'repeat', href: '#/cover', order: 55, perm: 'payroll.cover' });
registerStudioRoute({ id: 'payroll.cover', feature: 'payroll', path: '/cover', nav: 'payroll.cover', perm: 'payroll.cover', render: () => <CoverPage /> });

registerStudioNav({ id: 'payroll', feature: 'payroll', label: 'Payroll', short: 'Pay', icon: 'cash', href: '#/payroll', order: 58, perm: 'payroll.view' });
registerStudioRoute({ id: 'payroll', feature: 'payroll', path: '/payroll', nav: 'payroll', perm: 'payroll.view', render: () => <PayrollPage /> });
registerStudioRoute({ id: 'payroll.tab', feature: 'payroll', path: '/payroll/:tab', nav: 'payroll', perm: 'payroll.view', render: ({ params }) => <PayrollPage tab={params.tab} /> });
registerStudioRoute({ id: 'payroll.timesheet', feature: 'payroll', path: '/timesheet', nav: 'payroll', perm: 'payroll.clock', render: () => <MyTimesheet /> });

registerSettingsTab({ id: 'payroll', feature: 'payroll', label: 'Pay + cover', order: 55, perm: 'payroll.cover_approve', render: () => <PayrollSettingsTab /> });

registerTodayWidget({ id: 'payroll.clock', feature: 'payroll', column: 'side', order: 10, perm: 'payroll.clock', render: () => <ClockWidget /> });
registerTodayWidget({ id: 'payroll.cover', feature: 'payroll', column: 'side', order: 20, perm: 'payroll.cover', render: () => <CoverToday /> });

registerSlot('roster.header', { id: 'payroll.cover', feature: 'payroll', perm: 'payroll.cover', render: ({ session }) => <RosterCover session={session} /> });
registerSlot('staff.card', { id: 'payroll.pay', feature: 'payroll', perm: 'payroll.view', render: ({ staff }) => <StaffPayLine staff={staff} /> });
