// Build the three apps with esbuild into dist/: client (/), studio (/studio/), platform admin (/admin/).
//   node build.mjs            -> production build
//   node build.mjs --watch    -> rebuild on change (serve dist/ with any static server)
// Env:
//   SUPABASE_URL, SUPABASE_ANON_KEY   live backend (omit for the demo build)
//   STUDIO_SLUG                       single-studio deployment, e.g. STUDIO_SLUG=snowy (the Snowy app). Omit for the platform.
//   PLATFORM_DOMAIN                   the platform's domain, so <slug>.<domain> opens that studio (e.g. studioplatform.app)
// Netlify: build command "npm run build", publish "dist".
import { build, context } from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname);
const out = path.join(root, 'dist');
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
    b.onResolve({ filter: /^@supabase\/supabase-js$/ }, (args) => {
      try { require.resolve(args.path, { paths: [root] }); return null; } catch {}
      return { path: path.join(root, 'scripts/supabase-stub.ts') };
    });
  },
};

const STUDIO_SLUG = (process.env.STUDIO_SLUG || '').trim().toLowerCase();
const PLATFORM_DOMAIN = (process.env.PLATFORM_DOMAIN || '').trim().toLowerCase();

/** Name, colours and language for the HTML shells and manifests: the build-time studio's, else the platform's. */
async function shellMeta() {
  const r = await build({ entryPoints: ['src/data/studios/index.ts', 'src/shared/branding.ts'], bundle: true, write: false, format: 'esm', platform: 'neutral', outdir: 'x', absWorkingDir: root, logLevel: 'silent' });
  const load = async (i) => import('data:text/javascript;base64,' + Buffer.from(r.outputFiles[i].text).toString('base64'));
  const [{ BUILTIN_STUDIOS }, { PLATFORM_BRANDING }] = await Promise.all([load(0), load(1)]);
  const s = STUDIO_SLUG ? BUILTIN_STUDIOS.find((x) => x.slug === STUDIO_SLUG) : null;
  const b = s?.branding ?? PLATFORM_BRANDING;
  return {
    APP_NAME: b.appName, SHORT_NAME: b.shortName, STUDIO_SHORT: `${s ? b.shortName : 'Studio'} Studio`.replace('Studio Studio', 'Studio app'),
    THEME: b.colors.primary, INK: b.colors.ink, BG: b.colors.bg, LANG: s?.locale ?? 'en',
    DESCRIPTION: s ? `Book classes at ${s.name}.` : 'Book classes at your studio.',
  };
}
function fillShells(meta) {
  for (const f of ['index.html', 'studio/index.html', 'manifest.webmanifest', 'studio/manifest.webmanifest']) {
    const p = path.join(out, f);
    if (!existsSync(p)) continue;
    const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    writeFileSync(p, readFileSync(p, 'utf8').replace(/%([A-Z_]+)%/g, (m, k) => (k in meta ? esc(meta[k]) : m)));
  }
}

if (!watch) rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(path.join(root, 'public'), out, { recursive: true });
fillShells(await shellMeta());

const opts = {
  entryPoints: { client: 'src/client/main.tsx', studio: 'src/studio/main.tsx', admin: 'src/admin/main.tsx' },
  bundle: true, splitting: true, format: 'esm', outdir: path.join(out, 'assets'),
  minify: !watch, sourcemap: watch ? 'inline' : false, target: ['es2020', 'safari15'],
  jsx: 'automatic', loader: { '.svg': 'file', '.webp': 'file', '.png': 'file' },
  define: {
    __SUPABASE_URL__: JSON.stringify(process.env.SUPABASE_URL || ''),
    __SUPABASE_ANON_KEY__: JSON.stringify(process.env.SUPABASE_ANON_KEY || ''),
    __STUDIO_SLUG__: JSON.stringify(STUDIO_SLUG),
    __PLATFORM_DOMAIN__: JSON.stringify(PLATFORM_DOMAIN),
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
