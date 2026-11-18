import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feeFor, summarizeFees } from '../lib/fees.js';

test('每半小時收費，15 分鐘內免費', () => {
  assert.equal(feeFor(10), 0);
  assert.equal(feeFor(15), 0);
  assert.equal(feeFor(16), 15);
  assert.equal(feeFor(30), 15);
  assert.equal(feeFor(31), 30);
  assert.equal(feeFor(40, { rate: 10 }), 20);
});

test('合計：月租不收、在場算到現在', () => {
  const now = Date.parse('2026-11-18T08:00:00Z');
  const sessions = [
    { plate: 'AAA-1111', status: 'done', entry_time: '2026-11-18T01:00:00Z', exit_time: '2026-11-18T02:10:00Z', monthly: null },
    { plate: 'BBB-2222', status: 'done', entry_time: '2026-11-18T01:00:00Z', exit_time: '2026-11-18T01:10:00Z', monthly: null },
    { plate: 'CCC-3333', status: 'done', entry_time: '2026-11-18T01:00:00Z', exit_time: '2026-11-18T05:00:00Z', monthly: { mask: 'CC***33' } },
    { plate: 'DDD-4444', status: 'inside', entry_time: '2026-11-18T07:00:00Z', exit_time: null, monthly: null },
    { plate: 'EEE-5555', status: 'missing_entry', entry_time: null, exit_time: '2026-11-18T03:00:00Z', monthly: null },
  ];
  const r = summarizeFees(sessions, { now });
  assert.deepEqual(r.exited, { count: 2, amount: 45, free: 1 });
  assert.deepEqual(r.inside, { count: 1, amount: 30 });
  assert.equal(r.total, 75);
  assert.equal(r.monthly, 1);
  assert.equal(r.missingEntry, 1);
});
