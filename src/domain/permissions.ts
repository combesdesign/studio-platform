/** Staff permissions (RULES.md › Staff permissions). Pure lookup so UIs can hide what staff can't do. */
import type { StaffRole } from '../shared/types';

export type StaffAction =
  | 'settings' // studio settings (non-financial)
  | 'settings_financial' // ABN, bank, Stripe
  | 'staff' // add/edit staff
  | 'staff_pay' // change pay rates
  | 'products' // edit shop products
  | 'schedule' // class types, templates, one-off sessions, cancel classes
  | 'roster_all' // any class roster, book/cancel/check-in for any class
  | 'roster_own' // rosters + check-in for classes they teach
  | 'clients_view'
  | 'clients_edit'
  | 'client_staff_notes' // see/edit staff-only notes (payment notes etc.)
  | 'waiver_record' // record a waiver on a client's behalf
  | 'pos' // sell passes/retail
  | 'pos_refund'
  | 'passes_manage' // pause/resume/cancel/adjust any client pass
  | 'reports' // attendance reports
  | 'reports_revenue'
  | 'reports_pay' // instructor pay in reports, pay rates visible
  | 'export_sales'
  | 'export_clients'
  | 'sales_view';

const ALL: StaffAction[] = [
  'settings', 'settings_financial', 'staff', 'staff_pay', 'products', 'schedule', 'roster_all', 'roster_own', 'clients_view',
  'clients_edit', 'client_staff_notes', 'waiver_record', 'pos', 'pos_refund', 'passes_manage', 'reports', 'reports_revenue',
  'reports_pay', 'export_sales', 'export_clients', 'sales_view',
];

export const PERMISSIONS: Record<StaffRole, readonly StaffAction[]> = {
  owner: ALL,
  manager: ALL.filter((a) => a !== 'staff_pay' && a !== 'settings_financial'),
  front_desk: ['schedule', 'roster_all', 'roster_own', 'clients_view', 'clients_edit', 'client_staff_notes', 'waiver_record', 'pos', 'pos_refund', 'passes_manage', 'reports', 'export_clients', 'sales_view'],
  instructor: ['roster_own', 'clients_view', 'waiver_record', 'pos', 'reports'],
};

/**
 * Feature permission actions, namespaced '<feature>.<action>' (e.g. 'appointments.manage').
 * Features register them from their own folder; nobody edits the core matrix above.
 */
export type FeatureAction = `${string}.${string}`;
const FEATURE_PERMISSIONS = new Map<string, readonly StaffRole[]>();

/** registerPermissions({ 'payroll.view': ['owner', 'manager'], 'payroll.export': ['owner'] }) */
export function registerPermissions(map: Record<FeatureAction, readonly StaffRole[]>): void {
  for (const [action, roles] of Object.entries(map)) {
    if (!/^[a-z][a-z0-9_-]*\.[a-z0-9_.-]+$/.test(action)) throw new Error(`Feature permission "${action}" must look like "<feature>.<action>".`);
    FEATURE_PERMISSIONS.set(action, [...roles]);
  }
}
export function featurePermissions(): ReadonlyMap<string, readonly StaffRole[]> { return FEATURE_PERMISSIONS; }

export function can(role: StaffRole, action: StaffAction | FeatureAction): boolean {
  if (action.includes('.')) return FEATURE_PERMISSIONS.get(action)?.includes(role) ?? false;
  return PERMISSIONS[role].includes(action as StaffAction);
}

/** Settings fields only the owner may change (ABN / bank / Stripe). */
export const FINANCIAL_SETTINGS_KEYS = ['abn', 'gstRegistered'] as const;
