// Turns Momence's CSV exports into the two staging files that supabase/import/momence_import.sql loads.
//
//   npx tsx scripts/momence-convert.mts <folder of Momence CSVs> [--out <folder>] [--report] [--studio-domain snowypilatesclub.com] [--ignore "<part of a product name>"]
//
// Reads from the folder: one "...Momence-Customers.csv" and one "...ribbon-active-members-<Product_Name>.csv" per product.
// Writes to --out (default: <folder>/out): momence_clients.csv, momence_passes.csv and, with --report, tidy-up-report.md.
// The report lists likely duplicates and problems. It changes nothing and merges nothing.
// Keep the exports and the output OUTSIDE the git repo: they hold real client details. Only counts are printed here.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildReport, CLIENT_COLUMNS, convert, PASS_COLUMNS, renderReport, reportCounts, toCsv } from './momence-lib';

function main(argv: string[]) {
  const args = { folder: '', out: '', report: false, studioDomain: undefined as string | undefined, ignore: [] as string[] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--report') args.report = true;
    else if (a === '--out') args.out = argv[++i] ?? '';
    else if (a === '--studio-domain') args.studioDomain = argv[++i];
    else if (a === '--ignore') args.ignore.push(argv[++i] ?? '');
    else if (a.startsWith('--')) throw new Error(`Unknown option ${a}`);
    else args.folder = a;
  }
  if (!args.folder) throw new Error('Usage: npx tsx scripts/momence-convert.mts <folder of Momence CSVs> [--out <folder>] [--report]');
  const folder = resolve(args.folder);
  const out = resolve(args.out || join(folder, 'out'));
  const files = readdirSync(folder).filter((f) => /\.csv$/i.test(f)).map((name) => ({ name, text: readFileSync(join(folder, name), 'utf8') }));

  const result = convert(files, { ignore: args.ignore });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'momence_clients.csv'), toCsv(CLIENT_COLUMNS, result.clients));
  writeFileSync(join(out, 'momence_passes.csv'), toCsv(PASS_COLUMNS, result.passes));
  console.log(`Wrote ${join(out, 'momence_clients.csv')} (${result.clients.length} clients)`);
  console.log(`Wrote ${join(out, 'momence_passes.csv')} (${result.passes.length} passes)`);
  for (const [name, n] of Object.entries(result.stats.byProduct)) console.log(`  ${n} x ${name}`);
  console.log(`  ${result.stats.introBlankExpiry} intro offers not started yet; ${result.stats.placeholderEmails} made-up Momence emails`);

  if (args.report) {
    const data = buildReport(result, { studioDomain: args.studioDomain });
    const path = join(out, 'tidy-up-report.md');
    writeFileSync(path, renderReport(data, result));
    console.log(`Wrote ${path}`);
    console.log('Tidy-up items: ' + Object.entries(reportCounts(data)).map(([k, v]) => `${k} ${v}`).join(', '));
  }
}

try { main(process.argv.slice(2)); } catch (e) { console.error((e as Error).message); process.exit(1); }
