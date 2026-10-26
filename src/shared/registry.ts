/**
 * UI registries: how feature modules (src/features/<name>) hook into the client and studio apps WITHOUT
 * editing main.tsx, app.tsx or any shared/core screen. A feature's client/index.tsx or studio/index.tsx calls
 * these at import time; the core apps read them when they render.
 *
 *   Client app:  registerClientTab, registerClientRoute, registerClientProfileEntry
 *   Studio app:  registerStudioNav, registerStudioRoute, registerSettingsTab, registerTodayWidget
 *   Both:        registerSlot(name, …)  for the extension slots inside core screens (see SlotProps)
 *
 * Permissions: `perm` is either a core studio permission ('pos', 'reports', 'settings', …: see Perm in
 * src/studio/ui.tsx) or a feature action registered with registerPermissions ('payroll.view').
 * Icons: a core icon name (see the Icon set in each app's ui.tsx) or your own <svg> element.
 * OWNED BY THE LEAD / PLATFORM.
 */
import type React from 'react';
import type { RosterEntry } from './store';
import type { Client, SessionWithCounts, Staff } from './types';

type Node = React.ReactNode;
export type IconRef = string | React.ReactElement;
type Nav = (to: string, opts?: { replace?: boolean }) => void;

function sorted<T extends { order?: number; id: string }>(list: T[]): T[] {
  return [...list].sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id));
}
function upsert<T extends { id: string }>(list: T[], item: T): void {
  const i = list.findIndex((x) => x.id === item.id);
  if (i >= 0) list[i] = item; else list.push(item);
}

// ------------------------------------------------------------------ client app
export interface ClientTab {
  /** Unique, prefixed with your feature: 'appointments.book'. */
  id: string;
  /** Hash path of the tab's screen, e.g. '/appointments'. Register its screen with registerClientRoute. */
  path: string;
  label: string;
  icon: IconRef;
  /** Core tabs are 10 Timetable, 20 Bookings, 30 Passes, 40 Profile. */
  order?: number;
}
export interface ClientRoute {
  id: string;
  /** '/gift-cards' or '/gift-cards/:code' (matched like the core routes). */
  path: string;
  render: (p: { params: Record<string, string>; path: string; nav: Nav }) => Node;
  /** Show the tab bar (default true). Full-screen flows set false. */
  chrome?: boolean;
  /** Which tab is highlighted (its path). Default: the route's own path if it's a tab, else none. */
  tab?: string;
}
export interface ClientProfileEntry {
  id: string;
  label: string;
  sub?: string;
  icon: IconRef;
  /** Where it goes (a registered client route). */
  path: string;
  order?: number;
}
const clientTabs: ClientTab[] = [];
const clientRoutes: ClientRoute[] = [];
const clientProfile: ClientProfileEntry[] = [];
export const registerClientTab = (t: ClientTab) => upsert(clientTabs, t);
export const registerClientRoute = (r: ClientRoute) => upsert(clientRoutes, r);
export const registerClientProfileEntry = (e: ClientProfileEntry) => upsert(clientProfile, e);
export const clientTabsList = () => sorted(clientTabs);
export const clientRoutesList = () => [...clientRoutes];
export const clientProfileEntries = () => sorted(clientProfile);

// ------------------------------------------------------------------ studio app
export interface StudioNavItem {
  id: string;
  label: string;
  /** Short label for the phone tab bar. */
  short?: string;
  icon: IconRef;
  /** '#/payroll' */
  href: string;
  /** Core items: 10 Today, 20 Schedule, 30 Clients, 40 Point of sale, 50 Reports, 60 Settings. */
  order?: number;
  perm?: string;
}
export interface StudioRoute {
  id: string;
  /** '/payroll' or '/payroll/:runId' */
  path: string;
  render: (p: { params: Record<string, string>; path: string }) => Node;
  perm?: string;
  /** Which nav item is highlighted (its id). */
  nav?: string;
}
export interface SettingsTab {
  /** Also the URL: '#/settings/<id>'. */
  id: string;
  label: string;
  render: () => Node;
  perm?: string;
  /** Core tabs: 10 Studio, 15 Branding, 20 Policies, 30 Class types, 40 Products, 50 Staff, 90 Demo. */
  order?: number;
}
export interface TodayWidget {
  id: string;
  render: () => Node;
  perm?: string;
  /** 'main' sits under today's classes; 'side' sits with Heads up. */
  column?: 'main' | 'side';
  order?: number;
}
const studioNav: StudioNavItem[] = [];
const studioRoutes: StudioRoute[] = [];
const settingsTabs: SettingsTab[] = [];
const todayWidgets: TodayWidget[] = [];
export const registerStudioNav = (n: StudioNavItem) => upsert(studioNav, n);
export const registerStudioRoute = (r: StudioRoute) => upsert(studioRoutes, r);
export const registerSettingsTab = (t: SettingsTab) => upsert(settingsTabs, t);
export const registerTodayWidget = (w: TodayWidget) => upsert(todayWidgets, w);
export const studioNavItems = () => sorted(studioNav);
export const studioRoutesList = () => [...studioRoutes];
export const settingsTabsList = () => sorted(settingsTabs);
export const todayWidgetsList = () => sorted(todayWidgets);

// ------------------------------------------------------------------ slots inside core screens
/** Every extension slot and the props it renders with. Ask the lead for a new slot rather than editing a core screen. */
export interface SlotProps {
  /** Studio roster: above the list (e.g. "Spot map", "Sub requested"). */
  'roster.header': { session: SessionWithCounts };
  /** Studio roster: extra chips/actions on one booking row. */
  'roster.entry': { entry: RosterEntry; session: SessionWithCounts };
  /** Studio client profile: a card in the main column (gift card balance, messages, appointments). */
  'client.profile': { client: Client };
  /** Studio client profile: extra buttons in the header (e.g. "Send message"). */
  'client.profile.actions': { client: Client };
  /** Studio POS: under the cart, before payment (promo code, gift card redemption). Return null when not relevant. */
  'pos.cart': { clientId?: string; subtotalCents: number; setDiscount: (cents: number, note: string) => void };
  /** Studio POS: extra product tiles (gift cards, appointment packs). */
  'pos.products': { clientId?: string };
  /** Studio staff card in Settings › Staff (pay rules, availability). */
  'staff.card': { staff: Staff };
  /** Client app: the class sheet, under the description (spot picker, workshop details). */
  'client.class': { session: SessionWithCounts };
  /** Client app: top of the timetable (announcements, "Book a private"). */
  'client.timetable': Record<string, never>;
  /** Client app: Passes screen, under the shop (gift cards, referrals). */
  'client.shop': Record<string, never>;
  /** Client app: Profile, in the settings list next to News + offers (e.g. the notifications switch). */
  'client.account': Record<string, never>;
  /** Client app: the "you're booked in" screen, under the note (a gentle one-time prompt). */
  'client.booked': { session: SessionWithCounts };
}
export type SlotName = keyof SlotProps;
export interface SlotEntry<N extends SlotName> {
  id: string;
  render: (props: SlotProps[N]) => Node;
  perm?: string;
  order?: number;
}
const slots = new Map<SlotName, SlotEntry<SlotName>[]>();
export function registerSlot<N extends SlotName>(name: N, entry: SlotEntry<N>): void {
  const list = slots.get(name) ?? [];
  upsert(list, entry as unknown as SlotEntry<SlotName>);
  slots.set(name, list);
}
export function slotEntries<N extends SlotName>(name: N): SlotEntry<N>[] {
  return sorted((slots.get(name) ?? []) as unknown as SlotEntry<N>[]);
}
