/**
 * Picks the data store. Live (Supabase) when the build has SUPABASE_URL + SUPABASE_ANON_KEY,
 * otherwise the demo store (fake data in the browser).
 * OWNED BY THE LEAD.
 */
import type { DataStore } from '../shared/store';
import { createDemoStore } from './demo';
import { createSupabaseStore } from './supabase';

declare const __SUPABASE_URL__: string;
declare const __SUPABASE_ANON_KEY__: string;

const url = typeof __SUPABASE_URL__ === 'string' ? __SUPABASE_URL__ : '';
const key = typeof __SUPABASE_ANON_KEY__ === 'string' ? __SUPABASE_ANON_KEY__ : '';
const forceDemo = typeof location !== 'undefined' && /[?&]demo=1/.test(location.search);

export const store: DataStore = url && key && !forceDemo ? createSupabaseStore(url, key) : createDemoStore();
