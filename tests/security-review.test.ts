// Security review (docs/SECURITY-REVIEW.md): a studio's logo SVG is markup, so only plain shapes and text may be rendered.
// Mirrors app.svg_is_safe in supabase/migrations/2900_security_review.sql (the SQL side is tested in supabase/tests/security_review.sql).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSafeSvg } from '../src/shared/svgsafe';
import { textLogo } from '../src/shared/branding';
import { HARBOUR_BRANDING } from '../src/data/studios/harbour';

test('the logos the app builds itself are safe', () => {
  assert.equal(isSafeSvg(textLogo('Harbour Reformer Co.').svg), true);
  assert.equal(isSafeSvg(textLogo('Snowy', { markD: 'M10 10L90 90', markViewBox: '0 0 100 100' }).svg), true);
  assert.equal(isSafeSvg(textLogo('A "quoted" <name> & more').svg), true, 'names are escaped by textLogo');
  const seeded = HARBOUR_BRANDING.logo.svg;
  if (seeded) assert.equal(isSafeSvg(seeded), true, 'the seeded demo studio logo');
});

test('empty is fine (no svg logo)', () => {
  assert.equal(isSafeSvg(''), true);
  assert.equal(isSafeSvg(undefined), true);
  assert.equal(isSafeSvg(null), true);
});

test('script, handlers, links, foreign content and external references are refused', () => {
  const bad = [
    '<script>alert(1)</script>',
    '<SCRIPT >alert(1)</SCRIPT>',
    '<svg onload="alert(1)"></svg>',
    '<g ONCLICK=alert(1)><path d="M0 0"/></g>',
    '<path d="M0 0" onmouseover = "x()"/>',
    '<a href="javascript:alert(1)"><text>x</text></a>',
    '<text><a xlink:href="https://evil.test">x</a></text>',
    '<use href="#x"/>',
    '<image href="https://evil.test/x.png"/>',
    '<foreignObject><iframe src="https://evil.test"></iframe></foreignObject>',
    '<style>text{fill:red}</style>',
    '<animate attributeName="href" values="javascript:alert(1)"/>',
    '<set attributeName="onclick" to="alert(1)"/>',
    '<path d="M0 0" style="fill:url(https://evil.test/x)"/>',
    '<path d="M0 0" style="fill:url( //evil.test/x)"/>',
    '<path d="M0 0" fill="url(data:image/svg+xml;base64,AAAA)"/>',
    '<!DOCTYPE svg><svg/>',
    '<?xml version="1.0"?><svg/>',
    '<!-- hi --><svg/>',
    '<svg><![CDATA[x]]></svg>',
    '<text>vbscript:msgbox(1)</text>',
    'x'.repeat(200001),
  ];
  for (const svg of bad) assert.equal(isSafeSvg(svg), false, svg.slice(0, 60));
});

test('plain shapes, gradients and local url(#id) references are fine', () => {
  assert.equal(isSafeSvg('<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><path d="M0 0L10 10" fill="url(#g)"/>'), true);
  assert.equal(isSafeSvg('<g class="lf" style="--n:0"><circle cx="5" cy="5" r="4"/><rect x="0" y="0" width="3" height="3"/></g>'), true);
  assert.equal(isSafeSvg('<text x="0" y="1" font-family="var(--display)">Hello &amp; welcome</text>'), true);
});
