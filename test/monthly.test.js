import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMask, maskOf, buildMatcher } from '../lib/monthly.js';

test('名單車號整理', () => {
  assert.equal(normalizeMask('AQ***26'), 'AQ***26');
  assert.equal(normalizeMask('aq＊＊＊26'), 'AQ***26');
  assert.equal(normalizeMask(' 49 *** 7 '), '49***7');
  assert.equal(normalizeMask('AQ26'), '');
});

test('完整車牌轉遮蔽格式', () => {
  assert.equal(maskOf('AQB-1226'), 'AQ***26');
  assert.equal(maskOf('4936-M7'), '49***7');
  assert.equal(maskOf('BKY-1232'), 'BK***32');
});

test('比對月租名單', () => {
  const match = buildMatcher([{ mask: 'AQ***26', name: '林O華' }, { mask: 'BM***32', name: '陳O霖' }, { mask: 'BM***32', name: '陳O霖' }]);
  assert.deepEqual(match('AQB-1226'), { mask: 'AQ***26', names: ['林O華'] });
  assert.deepEqual(match('BMX-5532'), { mask: 'BM***32', names: ['陳O霖'] });
  assert.equal(match('BKY-1232'), null);
});
