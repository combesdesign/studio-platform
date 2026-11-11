// `npm run test:e2e`: build the Snowy single-studio app and the platform app, serve both on free ports, run every
// tests/e2e/*.e2e.mjs journey headless (one process each), exit non-zero if any fail.
//   npm run test:e2e              all journeys
//   npm run test:e2e -- 03 12     only files whose name contains 03 or 12
//   E2E_JOBS=1 npm run test:e2e   run one at a time (default 4)
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'snowy-e2e-'));
const build = (name, env) => {
  console.log(`building ${name}…`);
  const r = spawnSync(process.execPath, ['build.mjs'], { cwd: ROOT, env: { ...process.env, STUDIO_SLUG: '', ...env }, encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stdout, r.stderr); process.exit(2); }
  cpSync(path.join(ROOT, 'dist'), path.join(tmp, name), { recursive: true });
};
build('snowy', { STUDIO_SLUG: 'snowy' });
build('platform', {});

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const serve = (dir) => new Promise((resolve) => {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let f = path.join(dir, p);
    if (!f.startsWith(dir)) { res.writeHead(403).end(); return; }
    if (existsSync(f) && statSync(f).isDirectory()) f = path.join(f, 'index.html');
    if (!existsSync(f)) { res.writeHead(404).end('not found'); return; }   // e.g. sw.js is not served in these builds: expected
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }).end(readFileSync(f));
  });
  srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
});
const [snowy, platform] = await Promise.all([serve(path.join(tmp, 'snowy')), serve(path.join(tmp, 'platform'))]);

const here = path.join(ROOT, 'tests/e2e');
const filters = process.argv.slice(2);
const files = readdirSync(here).filter((f) => f.endsWith('.e2e.mjs')).sort().filter((f) => !filters.length || filters.some((x) => f.includes(x)));
const jobs = Number(process.env.E2E_JOBS || 4);
const results = [];
let next = 0;
const worker = async () => {
  while (next < files.length) {
    const f = files[next++];
    await new Promise((done) => {
      const c = spawn(process.execPath, [path.join(here, f)], { cwd: ROOT, env: { ...process.env, E2E_SNOWY_URL: snowy.url, E2E_PLATFORM_URL: platform.url } });
      let out = '';
      c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (out += d));
      c.on('close', (code) => { results.push({ f, code, out }); process.stdout.write(out); done(); });
    });
  }
};
await Promise.all(Array.from({ length: Math.min(jobs, files.length) }, worker));
snowy.srv.close(); platform.srv.close();
rmSync(tmp, { recursive: true, force: true });
const failed = results.filter((r) => r.code !== 0);
console.log(`\n${results.length - failed.length}/${results.length} journeys passed${failed.length ? `. Failed: ${failed.map((r) => r.f).join(', ')}. Screenshots: screenshots/e2e-failures/` : ''}`);
process.exit(failed.length || !results.length ? 1 : 0);
