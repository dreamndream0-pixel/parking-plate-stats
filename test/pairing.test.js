import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairSessions, normalizePlate } from '../lib/pairing.js';

let id = 0;
const ev = (plate, direction, t) => ({ id: ++id, plate, direction, taken_at: `2026-11-17T${t}:00.000Z`, photo: `${id}.jpg` });

test('明確進/出配對與停留時間', () => {
  const s = pairSessions([ev('ABC-1234', 'in', '01:00'), ev('ABC-1234', 'out', '03:30')]);
  assert.equal(s.length, 1);
  assert.equal(s[0].status, 'done');
  assert.equal(s[0].duration_min, 150);
});

test('自動模式：交替判斷，且不受上傳順序影響', () => {
  const s = pairSessions([ev('XY-88', 'auto', '05:00'), ev('XY-88', 'auto', '01:00'), ev('XY-88', 'auto', '02:00')]);
  const done = s.find((x) => x.status === 'done');
  const inside = s.find((x) => x.status === 'inside');
  assert.equal(done.duration_min, 60);
  assert.equal(inside.entry_time, '2026-11-17T05:00:00.000Z');
});

test('在場內重複拍進場：算確認在場，不另開一筆', () => {
  const s = pairSessions([ev('A-1', 'in', '01:00'), ev('A-1', 'in', '02:00'), ev('A-1', 'in', '04:00'), ev('A-1', 'out', '05:00')]);
  assert.equal(s.length, 1);
  assert.equal(s[0].status, 'done');
  assert.equal(s[0].entry_time, '2026-11-17T01:00:00.000Z');
  assert.equal(s[0].checks.length, 2);
  assert.equal(s[0].duration_min, 240);
});

test('出場後重複拍出場：掛在同一筆，不算缺進場', () => {
  const s = pairSessions([ev('C-3', 'in', '01:00'), ev('C-3', 'out', '02:00'), ev('C-3', 'out', '02:01')]);
  assert.equal(s.length, 1);
  assert.equal(s[0].repeat_exits.length, 1);
});

test('在場內超過 12 小時又拍進場：視為新的一次進場，上次缺出場', () => {
  const s = pairSessions([
    { id: 900, plate: 'D-4', direction: 'in', taken_at: '2026-11-17T01:00:00.000Z', photo: 'a' },
    { id: 901, plate: 'D-4', direction: 'in', taken_at: '2026-11-18T02:00:00.000Z', photo: 'b' },
  ]);
  assert.deepEqual(s.map((x) => x.status).sort(), ['inside', 'missing_exit']);
});

test('空檔推估時間會帶到停車紀錄', () => {
  const s = pairSessions([
    { id: 910, plate: 'E-5', direction: 'in', taken_at: '2026-11-18T03:05:00.000Z', estimated_from: '2026-11-18T02:00:00.000Z', photo: 'a' },
  ]);
  assert.equal(s[0].entry_estimated_from, '2026-11-18T02:00:00.000Z');
});

test('只拍到出場：缺進場紀錄', () => {
  const s = pairSessions([ev('B-2', 'out', '03:00')]);
  assert.equal(s[0].status, 'missing_entry');
});

test('車牌正規化', () => {
  assert.equal(normalizePlate('abc 1234'), 'ABC-1234');
  assert.equal(normalizePlate('ＡＢＣ－１２３４'), 'ABC-1234');
  assert.equal(normalizePlate('ABC1234'), 'ABC-1234');
  assert.equal(normalizePlate('1234AB'), '1234-AB');
  assert.equal(normalizePlate('RAA·5678'), 'RAA-5678');
});
