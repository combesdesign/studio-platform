// Build the three apps with esbuild into dist/: client (/), studio (/studio/), platform admin (/admin/).
//   node build.mjs            -> production build
//   node build.mjs --watch    -> rebuild on change (serve dist/ with any static server)
// Env:
//   SUPABASE_URL, SUPABASE_ANON_KEY   live backend (omit for the demo build)
//   ALLOW_DEMO_PARAM=1                let ?demo=1 force demo data on a live (Supabase) build. Off by default; demo builds always allow it.
//   STUDIO_SLUG                       single-studio deployment, e.g. STUDIO_SLUG=snowy (the Snowy app). Omit for the platform.
//   PLATFORM_DOMAIN                   the platform's domain, so <slug>.<domain> opens that studio (e.g. studioplatform.app)
//   VAPID_PUBLIC_KEY                  web push public key (npx web-push generate-vapid-keys). Omit and the notification switch stays hidden.
// App Store / Google Play (Capacitor) build, client app only, into dist-app/:
//   npm run build:app -- --studio=snowy        (same as: node build.mjs --app --studio=snowy)
// Extra env for the app build: APP_ID (default derived from the studio website, e.g. com.snowypilatesclub.app),
//   WEB_URL (the studio's web app address Stripe returns to, default its first custom domain or website).
// Netlify: build command "npm run build", publish "dist".
import { build, context } from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname);
const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const APP = process.argv.includes('--app');
const out = path.join(root, APP ? 'dist-app' : 'dist');
const watch = process.argv.includes('--watch');
const require = createRequire(import.meta.url);

// Local fallback: this sandbox has no npm registry, so resolve react from the shared tools dir
// and stub @supabase/supabase-js when it isn't installed. On Netlify/your Mac, normal node_modules are used.
const FALLBACK = '/opt/npm-tools/node_modules';
const resolveFallback = {
  name: 'fallback-resolve',
  setup(b) {
    b.onResolve({ filter: /^(react|react-dom)(\/.*)?$/ }, (args) => {
      try { require.resolve(args.path, { paths: [root] }); return null; } catch {}
      return { path: require.resolve(args.path, { paths: [FALLBACK] }) };
    });
    // The Capacitor plugins are only bundled by the app build. Where they aren't installed (this sandbox), harmless stand-ins.
    b.onResolve({ filter: /^@capacitor\// }, (args) => {
      try { require.resolve(args.path, { paths: [root] }); return null; } catch {}
      return { path: path.join(root, 'scripts/capacitor-stub.ts') };
    });
    b.onResolve({ filter: /^@supabase\/supabase-js$/ }, (args) => {
      try { require.resolve(args.path, { paths: [root] }); return null; } catch {}
      return { path: path.join(root, 'scripts/supabase-stub.ts') };
    });
  },
};

const STUDIO_SLUG = (arg('studio') || process.env.STUDIO_SLUG || '').trim().toLowerCase();
if (APP && !STUDIO_SLUG) { console.error('The app build is for one studio: npm run build:app -- --studio=snowy'); process.exit(1); }
const PLATFORM_DOMAIN = (process.env.PLATFORM_DOMAIN || '').trim().toLowerCase();

/** Name, colours and language for the HTML shells and manifests: the build-time studio's, else the platform's. */
async function shellMeta() {
  const r = await build({ entryPoints: ['src/data/studios/index.ts', 'src/shared/branding.ts', 'src/shared/nativeLink.ts'], bundle: true, write: false, format: 'esm', platform: 'neutral', outdir: 'x', absWorkingDir: root, logLevel: 'silent' });
  const load = async (i) => import('data:text/javascript;base64,' + Buffer.from(r.outputFiles[i].text).toString('base64'));
  const [{ BUILTIN_STUDIOS }, { PLATFORM_BRANDING }, link] = await Promise.all([load(0), load(1), load(2)]);
  const s = STUDIO_SLUG ? BUILTIN_STUDIOS.find((x) => x.slug === STUDIO_SLUG) : null;
  if (APP && !s) { console.error(`No built-in studio called "${STUDIO_SLUG}". Known: ${BUILTIN_STUDIOS.map((x) => x.slug).join(', ')}`); process.exit(1); }
  const b = s?.branding ?? PLATFORM_BRANDING;
  return {
    _studio: s, _link: link,
    APP_NAME: b.appName, SHORT_NAME: b.shortName, STUDIO_SHORT: `${s ? b.shortName : 'Studio'} Studio`.replace('Studio Studio', 'Studio app'),
    THEME: b.colors.primary, INK: b.colors.ink, BG: b.colors.bg, LANG: s?.locale ?? 'en',
    DESCRIPTION: s ? `Book classes at ${s.name}.` : 'Book classes at your studio.',
  };
}
function fillShells(meta) {
  for (const f of ['index.html', 'open.html', 'studio/index.html', 'manifest.webmanifest', 'studio/manifest.webmanifest']) {
    const p = path.join(out, f);
    if (!existsSync(p)) continue;
    const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    writeFileSync(p, readFileSync(p, 'utf8').replace(/%([A-Z_]+)%/g, (m, k) => (k in meta ? esc(meta[k]) : m)));
  }
}

if (!watch) rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
// The app build ships the client only: no studio app, no admin, no service worker, and only this studio's own assets.
const appSkip = ['admin', 'studio', 'sw.js', 'open.html'].map((n) => path.join(root, 'public', n));
const otherStudios = path.join(root, 'public', 'studios');
cpSync(path.join(root, 'public'), out, { recursive: true, filter: (src) => !APP || (!appSkip.includes(src) && !(path.dirname(src) === otherStudios && path.basename(src) !== STUDIO_SLUG)) });
const meta = await shellMeta();
fillShells(meta);
let nativeInfo = { appId: '', scheme: '', webUrl: '' };
if (APP) {
  const { _studio: st, _link: link } = meta;
  const appId = (process.env.APP_ID || link.deriveAppId(st)).trim();
  if (!link.isValidAppId(appId)) { console.error(`"${appId}" isn't a valid app id (like com.snowypilatesclub.app).`); process.exit(1); }
  const host = st.customDomains?.[0];
  const webUrl = (process.env.WEB_URL || (host ? `https://${host}` : st.website || '')).trim().replace(/\/+$/, '');
  nativeInfo = { appId, scheme: link.appSchemeFor(appId), webUrl };
  writeFileSync(path.join(out, 'app.json'), JSON.stringify({
    slug: st.slug, appId, appName: meta.APP_NAME, shortName: meta.SHORT_NAME, scheme: nativeInfo.scheme, webUrl,
    colors: { primary: meta.THEME, ink: meta.INK, bg: meta.BG },
  }, null, 2) + '\n');
}

const opts = {
  entryPoints: APP ? { client: 'src/client/main.tsx' } : { client: 'src/client/main.tsx', studio: 'src/studio/main.tsx', admin: 'src/admin/main.tsx' },
  bundle: true, splitting: true, format: 'esm', outdir: path.join(out, 'assets'),
  minify: !watch, sourcemap: watch ? 'inline' : false, target: ['es2020', 'safari15'],
  jsx: 'automatic', loader: { '.svg': 'file', '.webp': 'file', '.png': 'file' },
  define: {
    __SUPABASE_URL__: JSON.stringify(process.env.SUPABASE_URL || ''),
    __SUPABASE_ANON_KEY__: JSON.stringify(process.env.SUPABASE_ANON_KEY || ''),
    __ALLOW_DEMO_PARAM__: JSON.stringify(/^(1|true)$/i.test(process.env.ALLOW_DEMO_PARAM || '')),
    __STUDIO_SLUG__: JSON.stringify(STUDIO_SLUG),
    __PLATFORM_DOMAIN__: JSON.stringify(PLATFORM_DOMAIN),
    __VAPID_PUBLIC_KEY__: JSON.stringify((process.env.VAPID_PUBLIC_KEY || '').trim()),
    __NATIVE_BUILD__: JSON.stringify(APP),
    __APP_SCHEME__: JSON.stringify(nativeInfo.scheme),
    __WEB_URL__: JSON.stringify(nativeInfo.webUrl),
    'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production'),
  },
  plugins: [resolveFallback], logLevel: 'info', absWorkingDir: root,
};

// HTML shells live in public/ (index.html = client app, studio/index.html = studio app).
if (watch) { const ctx = await context(opts); await ctx.watch(); }
else {
  await build(opts);
  // cache-bust the service worker
  const sw = path.join(out, 'sw.js');
  if (existsSync(sw)) writeFileSync(sw, readFileSync(sw, 'utf8').replace('__BUILD__', Date.now().toString(36)));
}
