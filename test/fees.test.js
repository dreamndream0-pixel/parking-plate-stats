import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feeFor, feeRange, summarizeFees, dailyReport } from '../lib/fees.js';

test('平均不算盤點推估的車，但收入照算', () => {
  const sessions = [
    { plate: 'A', status: 'done', entry_time: '2026-11-18T01:00:00Z', exit_time: '2026-11-18T02:00:00Z', monthly: null },
    { plate: 'G', status: 'done', entry_time: '2026-11-18T01:00:00Z', exit_time: '2026-11-18T06:00:00Z', exit_estimated_from: '2026-11-18T03:00:00Z', monthly: null },
  ];
  const r = summarizeFees(sessions, { now: Date.parse('2026-11-18T08:00:00Z') });
  // G 實際出場在 11:00～14:00 之間：最少停 2 小時 $60，最多 5 小時 $150
  assert.deepEqual(r.exited, { count: 1, amount: 30, free: 0, avgFee: 30, avgMin: 60 });
  assert.deepEqual(r.estimated, { count: 1, min: 60, max: 150 });
  assert.equal(r.total, 30);
  const [d] = dailyReport(sessions, { from: '2026-11-17T16:00:00Z', to: '2026-11-18T16:00:00Z', now: Date.parse('2026-11-18T08:00:00Z') });
  assert.equal(d.revenue, 30);
  assert.deepEqual([d.estCars, d.estMin, d.estMax], [1, 60, 150]);
});

test('盤點時才拍到的車：進場時間是推估的', () => {
  // 員工 19:00 離開，隔天 08:30 盤點拍到（進場記 08:30），09:00 出場 → 最少 30 分 $15，最多 14 小時 $420
  const s = { entry_time: '2026-11-19T00:30:00Z', entry_estimated_from: '2026-11-18T11:00:00Z', exit_time: '2026-11-19T01:00:00Z' };
  assert.deepEqual(feeRange(s), { min: 15, max: 420 });
  assert.equal(feeRange({ entry_time: s.entry_time, exit_time: s.exit_time }), null);
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
  assert.deepEqual(r.exited, { count: 2, amount: 45, free: 1, avgFee: 23, avgMin: 40 });
  assert.deepEqual(r.inside, { count: 1, amount: 30 });
  assert.equal(r.total, 75);
  assert.equal(r.monthly, 1);
  assert.equal(r.missingEntry, 1);
});
