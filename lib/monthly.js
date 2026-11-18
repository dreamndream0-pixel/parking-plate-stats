// 月租名單比對。公告上的車號會遮住中間 3 碼：
//   7 碼車牌 AQB1226 → AQ***26（前 2 碼＋後 2 碼）
//   6 碼車牌 4936M7  → 49***7 （前 2 碼＋後 1 碼）
// 把辨識到的車牌用同樣規則遮起來，就能跟名單比對。中間看不到，所以只能算「疑似月租」。
import Anthropic from '@anthropic-ai/sdk';

const fullToHalf = (s) => String(s ?? '').replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

// 名單上的遮蔽車號整理成統一格式，例如「aq＊＊＊26」→「AQ***26」
export function normalizeMask(raw) {
  const s = fullToHalf(raw).toUpperCase().replace(/[×※]/g, '*').replace(/[^A-Z0-9*]/g, '');
  const m = s.match(/^([A-Z0-9]{2})\*+([A-Z0-9]{1,3})$/);
  return m ? `${m[1]}***${m[2]}` : '';
}

// 完整車牌 → 遮蔽格式
export function maskOf(plate) {
  const s = String(plate || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length < 5) return '';
  return `${s.slice(0, 2)}***${s.slice(5)}`;
}

export function buildMatcher(list) {
  const byMask = new Map();
  for (const r of list) {
    if (!byMask.has(r.mask)) byMask.set(r.mask, []);
    byMask.get(r.mask).push(r);
  }
  // 回傳 { mask, names } 或 null
  return (plate) => {
    const m = maskOf(plate);
    const hit = m && byMask.get(m);
    return hit ? { mask: m, names: [...new Set(hit.map((r) => r.name).filter(Boolean))] } : null;
  };
}

// 用 AI 讀公告照片上的月租名單（只讀「中籤」名單，不讀「候補」）
const SCHEMA = {
  type: 'object',
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          no: { type: 'integer', description: '表格的 NO 欄' },
          name: { type: 'string', description: '姓名欄，照抄（例如 林O華）' },
          mask: { type: 'string', description: '車號欄，照抄含星號（例如 AQ***26、49***7）' },
        },
        required: ['no', 'name', 'mask'],
        additionalProperties: false,
      },
    },
    note: { type: 'string', description: '看不清楚或被遮住的部分，簡短說明；沒有就空字串' },
  },
  required: ['rows', 'note'],
  additionalProperties: false,
};

const PROMPT = `這是停車場公告的月租名單照片。請把表格裡每一列的 NO、姓名、車號讀出來。
- 只讀標題寫「中籤」的名單；標題寫「候補」的名單整張忽略。
- 車號照抄，保留星號，例如 AQ***26、49***7。
- 被遮住或模糊到讀不出來的列不要猜，略過並在 note 說明是哪幾號。
- 電話欄不要讀。`;

let client;
export async function readMonthlyList(imageBase64, mediaType = 'image/jpeg') {
  client ??= new Anthropic();
  const res = await client.beta.messages.create({
    model: 'claude-sonnet-5-5',
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
          { type: 'text', text: PROMPT },
        ],
      },
    ],
  });
  if (res.stop_reason === 'refusal') return { rows: [], note: 'AI 拒絕處理這張照片' };
  const data = JSON.parse(res.content.find((b) => b.type === 'text')?.text ?? '{}');
  const rows = (data.rows || [])
    .map((r) => ({ no: r.no, name: String(r.name || '').trim(), mask: normalizeMask(r.mask), raw: r.mask }))
    .filter((r) => r.mask);
  return { rows, note: data.note || '' };
}
