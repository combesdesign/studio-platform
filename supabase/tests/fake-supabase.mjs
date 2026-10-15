// TEST ONLY. A stand-in for @supabase/supabase-js that runs the live store's calls against the
// local test PostgreSQL (see run.sh) the way PostgREST would: as the signed-in user, with RLS,
// calling RPCs with named arguments. Used by live_store.test.mjs. Never shipped.
//
// Supports what src/data/supabase uses: from().select/insert/update/upsert/delete with
// eq/neq/lt/lte/gt/gte/in/ilike/not(is null)/order/limit/single/maybeSingle, embedded
// "child(*)" selects, rpc(), auth.*, storage.from().upload/getPublicUrl/remove, functions.invoke,
// channel(). Errors come back as { message, code } like PostgREST.
import { spawnSync } from 'node:child_process';

const state = (globalThis.__fake ??= {
  now: null,             // 'app.now' for SQL (ISO string) or null
  users: new Map(),      // storageKey -> auth user id (each app keeps its own session)
  invoked: [],           // functions.invoke calls
  userUpdates: [],       // auth.updateUser attrs (password / email)
  invokeResult: {},      // name -> data to return
  log: [],               // SQL run (for debugging)
});

function psql(script) {
  const r = spawnSync('psql', ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1'], { input: script, encoding: 'utf8' });
  if (r.status !== 0) {
    const m = /ERROR:\s+([0-9A-Z]{5}):\s+([\s\S]*?)(?:\n(?:LOCATION|DETAIL|HINT|CONTEXT|QUERY):|\n*$)/.exec(r.stderr || '');
    const code = m ? m[1] : 'XX000';
    const message = (m ? m[2] : r.stderr || 'psql failed').trim();
    return { error: { code, message, details: r.stderr } };
  }
  return { out: r.stdout.replace(/\n$/, '') };
}

const quote = (s) => {
  let tag = 'q';
  while (s.includes(`$${tag}$`)) tag += 'q';
  return `$${tag}$${s}$${tag}$`;
};
/** SQL literal (untyped where possible, so Postgres casts it to the column/argument type). */
function lit(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return quote(v);
  if (Array.isArray(v) && v.every((x) => typeof x !== 'object' || x === null)) {
    return quote(`{${v.map((x) => (x === null ? 'NULL' : `"${String(x).replace(/["\\]/g, '\\$&')}"`)).join(',')}}`);
  }
  return quote(JSON.stringify(v));
}
const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;

const serviceKeys = (state.serviceKeys ??= new Set());
const headersOf = (state.headers ??= new Map()); // key -> the client's global headers object (read at request time, like a fetch wrapper)
function requestHeaders(storageKey) {
  const h = headersOf.get(storageKey);
  const studio = h && h['x-studio'];
  return studio ? JSON.stringify({ 'x-studio': studio }) : '';
}
function preamble(storageKey) {
  const uid = state.users.get(storageKey) ?? null;
  const hdr = `select set_config('request.headers', ${lit(requestHeaders(storageKey))}, false) \\g /dev/null
`;
  if (serviceKeys.has(storageKey)) {
    return `\\set VERBOSITY verbose
select set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claims', '{"role":"service_role"}', false),
       set_config('app.now', ${lit(state.now ?? '')}, false), set_config('role', 'service_role', false) \\g /dev/null
` + hdr;
  }
  const claims = uid ? { sub: uid, role: 'authenticated' } : { role: 'anon' };
  return `\\set VERBOSITY verbose
select set_config('request.jwt.claim.sub', ${lit(uid ?? '')}, false), set_config('request.jwt.claims', ${lit(JSON.stringify(claims))}, false),
       set_config('app.now', ${lit(state.now ?? '')}, false), set_config('role', ${lit(uid ? 'authenticated' : 'anon')}, false) \\g /dev/null
` + hdr;
}

function run(storageKey, sql) {
  state.log.push(sql);
  const r = psql(preamble(storageKey) + sql + ';\n');
  if (r.error) return { data: null, error: r.error };
  return { data: r.out === '' ? null : JSON.parse(r.out), error: null };
}
function admin(sql) {
  const r = psql(sql + ';\n');
  if (r.error) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.out === '' ? null : JSON.parse(r.out);
}

// ---------------------------------------------------------------- catalog (embedded selects, upsert keys)
let catalog;
function cat() {
  catalog ??= admin(`select json_build_object(
    'fks', (select json_agg(json_build_object('child', tc.table_name, 'col', kcu.column_name, 'parent', ccu.table_name))
              from information_schema.table_constraints tc
              join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
              join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
             where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public'),
    'pks', (select json_object_agg(table_name, cols) from (
              select tc.table_name, json_agg(kcu.column_name) cols from information_schema.table_constraints tc
                join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
               where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = 'public' group by tc.table_name) x),
    'voids', (select coalesce(json_agg(p.proname), '[]'::json) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.prorettype = 'void'::regtype),
    'setofs', (select coalesce(json_agg(p.proname), '[]'::json) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proretset))`);
  return catalog;
}

// ---------------------------------------------------------------- query builder
class Query {
  constructor(key, table) {
    Object.assign(this, { key, table, op: 'select', cols: '*', where: [], orders: [], lim: null, mode: null, values: null, returning: false, onConflict: null });
  }
  select(cols = '*') { if (this.op === 'select') this.cols = cols; else this.returning = true; return this; }
  insert(v) { this.op = 'insert'; this.values = v; return this; }
  update(v) { this.op = 'update'; this.values = v; return this; }
  upsert(v, o = {}) { this.op = 'upsert'; this.values = v; this.onConflict = o.onConflict ?? null; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(c, v) { this.where.push(`t.${ident(c)} = ${lit(v)}`); return this; }
  neq(c, v) { this.where.push(`t.${ident(c)} <> ${lit(v)}`); return this; }
  lt(c, v) { this.where.push(`t.${ident(c)} < ${lit(v)}`); return this; }
  lte(c, v) { this.where.push(`t.${ident(c)} <= ${lit(v)}`); return this; }
  gt(c, v) { this.where.push(`t.${ident(c)} > ${lit(v)}`); return this; }
  gte(c, v) { this.where.push(`t.${ident(c)} >= ${lit(v)}`); return this; }
  ilike(c, v) { this.where.push(`t.${ident(c)} ilike ${lit(v)}`); return this; }
  in(c, vs) { this.where.push(`t.${ident(c)} = any(${lit(vs)})`); return this; }
  contains(c, vs) { this.where.push(`t.${ident(c)} @> ${lit(vs)}`); return this; }
  is(c, v) { this.where.push(`t.${ident(c)} is ${v === null ? 'null' : String(v)}`); return this; }
  not(c, op, v) {
    if (op !== 'is') throw new Error(`fake: not(${op}) unsupported`);
    this.where.push(`t.${ident(c)} is not ${v === null ? 'null' : String(v)}`); return this;
  }
  order(c, o = {}) { this.orders.push(`t.${ident(c)} ${o.ascending === false ? 'desc' : 'asc'}`); return this; }
  limit(n) { this.lim = n; return this; }
  maybeSingle() { this.mode = 'maybe'; return this; }
  single() { this.mode = 'one'; return this; }
  then(ok, fail) { return Promise.resolve().then(() => this.exec()).then(ok, fail); }

  selectList() {
    const parts = []; let depth = 0, cur = '';
    for (const ch of this.cols) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; } else cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts.map((p) => {
      if (p === '*') return 't.*';
      const emb = /^(\w+)\((.*)\)$/.exec(p);
      if (emb) {
        const child = emb[1];
        const fk = (cat().fks ?? []).find((f) => f.child === child && f.parent === this.table);
        if (!fk) throw new Error(`fake: no relationship ${this.table} -> ${child}`);
        return `(select coalesce(json_agg(c), '[]'::json) from public.${ident(child)} c where c.${ident(fk.col)} = t.id) as ${ident(child)}`;
      }
      return `t.${ident(p.trim())}`;
    }).join(', ');
  }
  sql() {
    const where = this.where.length ? ` where ${this.where.join(' and ')}` : '';
    const T = `public.${ident(this.table)}`;
    if (this.op === 'select') {
      const order = this.orders.length ? ` order by ${this.orders.join(', ')}` : '';
      const limit = this.lim !== null ? ` limit ${Number(this.lim)}` : '';
      return `select coalesce(json_agg(x), '[]'::json) from (select ${this.selectList()} from ${T} t${where}${order}${limit}) x`;
    }
    const rowsOf = (v) => (Array.isArray(v) ? v : [v]);
    if (this.op === 'insert' || this.op === 'upsert') {
      const rows = rowsOf(this.values);
      const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
      const values = rows.map((r) => `(${cols.map((c) => (c in r ? lit(r[c]) : 'default')).join(', ')})`).join(', ');
      let conflict = '';
      if (this.op === 'upsert') {
        const keys = this.onConflict ? this.onConflict.split(',') : cat().pks[this.table];
        const sets = cols.filter((c) => !keys.includes(c)).map((c) => `${ident(c)} = excluded.${ident(c)}`);
        conflict = ` on conflict (${keys.map(ident).join(', ')}) do ${sets.length ? `update set ${sets.join(', ')}` : 'nothing'}`;
      }
      return `with w as (insert into ${T} as t (${cols.map(ident).join(', ')}) values ${values}${conflict} returning t.*) select coalesce(json_agg(w), '[]'::json) from w`;
    }
    if (this.op === 'update') {
      const sets = Object.entries(this.values).map(([c, v]) => `${ident(c)} = ${lit(v)}`).join(', ');
      return `with w as (update ${T} as t set ${sets}${where} returning t.*) select coalesce(json_agg(w), '[]'::json) from w`;
    }
    return `with w as (delete from ${T} as t${where} returning t.*) select coalesce(json_agg(w), '[]'::json) from w`;
  }
  exec() {
    const r = run(this.key, this.sql());
    if (r.error) return r;
    let data = r.data;
    if (this.op !== 'select' && !this.returning) data = null;
    if (this.mode === 'maybe') {
      if (data.length > 1) return { data: null, error: { code: 'PGRST116', message: 'more than one row' } };
      data = data[0] ?? null;
    } else if (this.mode === 'one') {
      if (data.length !== 1) return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
      data = data[0];
    }
    return { data, error: null };
  }
}

// ---------------------------------------------------------------- client
export function createClient(url, _key, opts = {}) {
  // Each store instance is its own browser (its own saved session).
  const key = `${opts.auth?.storageKey ?? 'default'}#${(state.instances = (state.instances ?? 0) + 1)}`;
  // Edge functions: the service role key acts as service_role; a user's 'Bearer <user id>' acts as them.
  if (_key === 'test-service-role-key') serviceKeys.add(key);
  if (opts.global?.headers) headersOf.set(key, opts.global.headers);
  const bearer = /^Bearer (.+)$/.exec(opts.global?.headers?.Authorization ?? '')?.[1];
  if (bearer) state.users.set(key, bearer);
  const listeners = new Set();
  const fire = (event) => { for (const l of listeners) l(event, null); };
  const userId = () => state.users.get(key) ?? null;
  const base = String(url).replace(/\/$/, '');
  return {
    from(table) { return new Query(key, table); },
    rpc(fn, args = {}) {
      const named = Object.entries(args).map(([k, v]) => `${ident(k)} => ${lit(v)}`).join(', ');
      const call = `public.${ident(fn)}(${named})`;
      if (cat().voids.includes(fn)) return Promise.resolve(run(key, `select ${call} \\g /dev/null
select 'null'::json`));
      if (cat().setofs.includes(fn)) return Promise.resolve(run(key, `select coalesce(json_agg(r), '[]'::json) from ${call} r`));
      return Promise.resolve(run(key, `select to_json(${call})`));
    },
    auth: {
      async getSession() { return { data: { session: userId() ? { user: { id: userId() } } : null }, error: null }; },
      async getUser() { return { data: { user: userId() ? { id: userId() } : null }, error: null }; },
      async signInWithPassword({ email, password }) {
        if (password === 'wrong') return { data: {}, error: { message: 'Invalid login credentials' } };
        const u = admin(`select to_json(id) from auth.users where lower(email) = lower(${lit(email)})`);
        if (!u) return { data: {}, error: { message: 'Invalid login credentials' } };
        state.users.set(key, u); fire('SIGNED_IN');
        return { data: { session: { user: { id: u } } }, error: null };
      },
      async signUp({ email, options }) {
        const exists = admin(`select to_json(count(*)) from auth.users where lower(email) = lower(${lit(email)})`);
        if (exists) return { data: {}, error: { message: 'User already registered' } };
        admin(`with w as (insert into auth.users (email, raw_user_meta_data) values (${lit(email)}, ${lit(options?.data ?? {})}) returning id) select to_json(w.id) from w`);
        return { data: { session: null, user: { email } }, error: null };
      },
      async signOut() { state.users.delete(key); fire('SIGNED_OUT'); return { error: null }; },
      async resetPasswordForEmail() { return { data: {}, error: null }; },
      async updateUser(attrs) {
        state.userUpdates.push({ ...attrs, userId: userId() });
        if (!userId()) return { data: { user: null }, error: { message: 'Auth session missing!' } };
        if (attrs.email) admin(`with w as (update auth.users set email = ${lit(attrs.email)} where id = ${lit(userId())} returning id) select to_json(count(*)) from w`);
        return { data: { user: { id: userId() } }, error: null };
      },
      onAuthStateChange(cb) { listeners.add(cb); return { data: { subscription: { unsubscribe: () => listeners.delete(cb) } } }; },
    },
    storage: {
      from(bucket) {
        return {
          async upload(path, blob, o = {}) {
            const size = blob && typeof blob.size === 'number' ? blob.size : 0;
            const r = run(key, `with w as (insert into storage.objects (bucket_id, name, metadata) values (${lit(bucket)}, ${lit(path)}, ${lit({ size, mimetype: o.contentType ?? null })}) returning name) select to_json(w.name) from w`);
            return r.error ? { data: null, error: { ...r.error, statusCode: '403' } } : { data: { path }, error: null };
          },
          getPublicUrl(path) { return { data: { publicUrl: `${base}/storage/v1/object/public/${bucket}/${path}` } }; },
          async remove(paths) {
            const r = run(key, `with w as (delete from storage.objects where bucket_id = ${lit(bucket)} and name = any(${lit(paths)}) returning name) select coalesce(json_agg(w.name), '[]'::json) from w`);
            return r.error ? { data: null, error: r.error } : { data: r.data, error: null };
          },
        };
      },
    },
    functions: {
      async invoke(name, { body } = {}) {
        state.invoked.push({ name, body, userId: userId() });
        return { data: state.invokeResult[name] ?? {}, error: null };
      },
    },
    /** Test hook: fire an auth event at this client's onAuthStateChange listeners (e.g. PASSWORD_RECOVERY). */
    __fireAuth(event) { fire(event); },
    channel() { const ch = { on: () => ch, subscribe: () => ch }; return ch; },
    removeChannel() {},
  };
}
export default { createClient };
export const fake = state;
export const sqlAdmin = admin;
