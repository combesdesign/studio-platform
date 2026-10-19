// Serve local brand fonts instead of Google Fonts (sandbox has no access). Test-only.
import { readFileSync } from 'node:fs';
const D = '/mnt/skills/examples/canvas-design/canvas-fonts/';
const files = { 'is-r.ttf': 'InstrumentSerif-Regular.ttf', 'is-i.ttf': 'InstrumentSerif-Italic.ttf', 'q.ttf': 'Outfit-Regular.ttf' };
const css = `
@font-face{font-family:'Instrument Serif';font-style:normal;font-weight:400;src:url(https://fonts.gstatic.com/local/is-r.ttf) format('truetype')}
@font-face{font-family:'Instrument Serif';font-style:italic;font-weight:400;src:url(https://fonts.gstatic.com/local/is-i.ttf) format('truetype')}
@font-face{font-family:'Questrial';font-style:normal;font-weight:400 700;src:url(https://fonts.gstatic.com/local/q.ttf) format('truetype')}`;
export async function localFonts(ctx) {
  await ctx.route(/fonts\.googleapis\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', headers: { 'access-control-allow-origin': '*' }, body: css }));
  await ctx.route(/fonts\.gstatic\.com/, (r) => {
    const f = files[r.request().url().split('/').pop()];
    return f ? r.fulfill({ status: 200, contentType: 'font/ttf', headers: { 'access-control-allow-origin': '*' }, body: readFileSync(D + f) }) : r.fulfill({ status: 404, body: '' });
  });
}
