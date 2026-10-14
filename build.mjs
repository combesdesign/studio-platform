// Build both apps with esbuild into dist/.
//   node build.mjs            -> production build
//   node build.mjs --watch    -> rebuild on change (serve dist/ with any static server)
// Env: SUPABASE_URL, SUPABASE_ANON_KEY (omit for the demo build).
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

if (!watch) rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(path.join(root, 'public'), out, { recursive: true });

const opts = {
  entryPoints: { client: 'src/client/main.tsx', studio: 'src/studio/main.tsx' },
  bundle: true, splitting: true, format: 'esm', outdir: path.join(out, 'assets'),
  minify: !watch, sourcemap: watch ? 'inline' : false, target: ['es2020', 'safari15'],
  jsx: 'automatic', loader: { '.svg': 'file', '.webp': 'file', '.png': 'file' },
  define: {
    __SUPABASE_URL__: JSON.stringify(process.env.SUPABASE_URL || ''),
    __SUPABASE_ANON_KEY__: JSON.stringify(process.env.SUPABASE_ANON_KEY || ''),
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
