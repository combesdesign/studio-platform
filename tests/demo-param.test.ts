import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoParamForcesDemo } from '../src/data/demoParam';

test('?demo=1 only forces demo on a build with no Supabase URL, or with the explicit flag', () => {
  const live = 'https://abc.supabase.co';
  assert.equal(demoParamForcesDemo({ supabaseUrl: '', allowDemoParam: false, search: '?demo=1' }), true, 'demo build');
  assert.equal(demoParamForcesDemo({ supabaseUrl: live, allowDemoParam: false, search: '?demo=1' }), false, 'live build ignores it');
  assert.equal(demoParamForcesDemo({ supabaseUrl: live, allowDemoParam: true, search: '?studio=snowy&demo=1' }), true, 'explicit flag');
  assert.equal(demoParamForcesDemo({ supabaseUrl: live, allowDemoParam: true, search: '' }), false, 'no param');
  assert.equal(demoParamForcesDemo({ supabaseUrl: '', allowDemoParam: false, search: '?demo=10' }), false, 'exact match only');
});
