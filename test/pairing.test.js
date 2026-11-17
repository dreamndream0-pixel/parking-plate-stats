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

test('漏拍：連續兩次進場、只有出場', () => {
  const s = pairSessions([ev('A-1', 'in', '01:00'), ev('A-1', 'in', '02:00'), ev('B-2', 'out', '03:00')]);
  assert.deepEqual(s.map((x) => x.status).sort(), ['inside', 'missing_entry', 'missing_exit']);
});

test('車牌正規化', () => {
  assert.equal(normalizePlate('abc 1234'), 'ABC-1234');
  assert.equal(normalizePlate('ＡＢＣ－１２３４'), 'ABC-1234');
  assert.equal(normalizePlate('ABC1234'), 'ABC-1234');
  assert.equal(normalizePlate('1234AB'), '1234-AB');
  assert.equal(normalizePlate('RAA·5678'), 'RAA-5678');
});
