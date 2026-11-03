// Capacitor wrap: app id, bridge page address and deep-link routing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appSchemeFor, bridgeUrl, cleanRoute, deriveAppId, isValidAppId, routeFromDeepLink, schemeUrl } from '../src/shared/nativeLink';
import { SNOWY_STUDIO } from '../src/data/studios/snowy';

test('deriveAppId follows the studio website, with a safe fallback', () => {
  assert.equal(deriveAppId(SNOWY_STUDIO), 'com.snowypilatesclub.app');
  assert.equal(deriveAppId({ slug: 'harbour', website: 'https://www.harbourreformer.com.au' }), 'au.com.harbourreformer.app');
  assert.equal(deriveAppId({ slug: 'harbour-co' }), 'app.studioplatform.harbourco');
  assert.equal(deriveAppId({ slug: '9lives', website: 'https://9lives.com' }), 'com.x9lives.app');
  for (const id of ['com.snowypilatesclub.app', 'app.studioplatform.harbourco', 'com.x9lives.app']) assert.ok(isValidAppId(id), id);
});

test('bridge and scheme addresses round-trip into the same in-app route', () => {
  const scheme = appSchemeFor('com.snowypilatesclub.app');
  const b = bridgeUrl('https://app.snowypilatesclub.com/', scheme, '#/passes?paid=p1&for=c2');
  assert.equal(b, 'https://app.snowypilatesclub.com/open.html?scheme=com.snowypilatesclub.app&to=%2Fpasses%3Fpaid%3Dp1%26for%3Dc2');
  assert.equal(routeFromDeepLink(b, { hosts: ['app.snowypilatesclub.com'] }), '/passes?paid=p1&for=c2');
  const s = schemeUrl(scheme, '/passes?paid=p1&for=c2')!;
  assert.equal(routeFromDeepLink(s, { scheme }), '/passes?paid=p1&for=c2');
});

test('deep links: hash routes, scheme paths, and anything unsafe is ignored', () => {
  const o = { scheme: 'com.snowypilatesclub.app', hosts: ['app.snowypilatesclub.com'] };
  assert.equal(routeFromDeepLink('https://app.snowypilatesclub.com/#/class/abc', o), '/class/abc');
  assert.equal(routeFromDeepLink('com.snowypilatesclub.app://class/abc', o), '/class/abc');
  assert.equal(routeFromDeepLink('com.snowypilatesclub.app://passes', o), '/passes');
  assert.equal(routeFromDeepLink('com.snowypilatesclub.app://open', o), '/');
  assert.equal(routeFromDeepLink('https://evil.example/#/class/abc', o), null);
  assert.equal(routeFromDeepLink('other.app://class/abc', o), null);
  assert.equal(routeFromDeepLink('com.snowypilatesclub.app://open?to=//evil.com', o), null);
  assert.equal(routeFromDeepLink('com.snowypilatesclub.app://open?to=javascript:alert(1)', o), null);
  assert.equal(routeFromDeepLink('not a url', o), null);
  assert.equal(cleanRoute('#/passes'), '/passes');
  assert.equal(cleanRoute('passes'), null);
});
