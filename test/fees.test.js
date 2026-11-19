import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feeFor, summarizeFees, dailyReport } from '../lib/fees.js';

test('平均不算盤點推估的車，但收入照算', () => {
  const sessions = [
    { plate: 'A', status: 'done', entry_time: '2026-11-18T01:00:00Z', exit_time: '2026-11-18T02:00:00Z', monthly: null },
    { plate: 'G', status: 'done', entry_time: '2026-11-18T01:00:00Z', exit_time: '2026-11-18T06:00:00Z', exit_estimated_from: '2026-11-18T03:00:00Z', monthly: null },
  ];
  const r = summarizeFees(sessions, { now: Date.parse('2026-11-18T08:00:00Z') });
  assert.equal(r.exited.count, 2);
  assert.equal(r.exited.amount, 30 + 150);
  assert.equal(r.exited.avgFee, 30);
  assert.equal(r.exited.avgMin, 60);
  assert.equal(r.exited.estimated, 1);
});

test('每天收入與使用率', () => {
  // 台灣 11/18：A 09:00–10:00（臨停 $30）、B 09:30–10:30（月租）、C 10:00 進場還在（現在 11:00，應收 $30）
  const now = Date.parse('2026-11-18T03:00:00Z');
  const sessions = [
    { plate: 'A', status: 'done', entry_time: '2026-11-18T01:00:00Z', exit_time: '2026-11-18T02:00:00Z', monthly: null },
    { plate: 'B', status: 'done', entry_time: '2026-11-18T01:30:00Z', exit_time: '2026-11-18T02:30:00Z', monthly: { mask: 'x' } },
    { plate: 'C', status: 'inside', entry_time: '2026-11-18T02:00:00Z', exit_time: null, monthly: null },
  ];
  const [d] = dailyReport(sessions, { from: '2026-11-17T16:00:00Z', to: '2026-11-18T16:00:00Z', now });
  assert.equal(d.date, '2026-11-18');
  assert.equal(d.today, true);
  assert.equal(d.entries, 3);
  assert.equal(d.monthlyEntries, 1);
  assert.equal(d.revenue, 30);
  assert.equal(d.pending, 30);
  assert.equal(d.peak, 2); // 09:30–10:00 A+B；10:00 A 走 C 進，仍 2 台
  assert.deepEqual(d.hourly.slice(9, 11), [1.5, 1.5]);
  assert.equal(d.openFrom, 9);
  assert.equal(d.openTo, 11);
  assert.equal(d.avgInside, 1.5);
});

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
  assert.deepEqual(r.exited, { count: 2, amount: 45, free: 1, avgFee: 23, avgMin: 40, estimated: 0 });
  assert.deepEqual(r.inside, { count: 1, amount: 30 });
  assert.equal(r.total, 75);
  assert.equal(r.monthly, 1);
  assert.equal(r.missingEntry, 1);
});
