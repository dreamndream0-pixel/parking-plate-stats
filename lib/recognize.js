// 用 Claude 看照片辨識車牌
import Anthropic from '@anthropic-ai/sdk';
import { normalizePlate } from './pairing.js';

const MODEL = 'claude-opus-5-5';

const SCHEMA = {
  type: 'object',
  properties: {
    plates: {
      type: 'array',
      description: '照片中看得清楚的車牌，最主要（最近、最大）的放第一個',
      items: {
        type: 'object',
        properties: {
          plate: { type: 'string', description: '車牌號碼，大寫，英數之間用 - 分隔，例如 ABC-1234、1234-AB' },
          confidence: { type: 'number', description: '0 到 1，看不清楚的字越多越低' },
          vehicle: { type: 'string', description: '車型與顏色，例如「白色休旅車」' },
        },
        required: ['plate', 'confidence', 'vehicle'],
        additionalProperties: false,
      },
    },
    note: { type: 'string', description: '若找不到車牌或有疑慮，簡短說明原因；否則空字串' },
  },
  required: ['plates', 'note'],
  additionalProperties: false,
};

const PROMPT = `這是停車場出入口拍的照片。請找出照片中的汽車車牌（以台灣車牌為主）。
- 只回報能讀出完整號碼的車牌；部分被遮住的字用 ? 代替，並調低 confidence。
- 注意易混淆字元：0/O/D、1/I、8/B、5/S、2/Z。台灣車牌不使用英文字母 I 和 O。
- 背景遠處、模糊到無法辨識的車牌不要列出。
- 照片角落若有黃色的日期時間浮水印，那是系統加上的拍攝時間，不是車牌，請忽略。
- 這張照片是為了拍某一台車的車牌，請把最靠近鏡頭、最清楚的那台車放在第一個。
- 沒有車牌就回傳空陣列，並在 note 說明。`;

let client;

export async function recognizePlates(imageBase64, mediaType = 'image/jpeg') {
  client ??= new Anthropic();
  const res = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: SCHEMA },
    },
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

  if (res.stop_reason === 'refusal') {
    return { plates: [], note: 'AI 拒絕處理這張照片', model: res.model };
  }
  const text = res.content.find((b) => b.type === 'text')?.text ?? '{}';
  const data = JSON.parse(text);
  return {
    plates: (data.plates || [])
      .map((p) => ({ ...p, plate: normalizePlate(p.plate) }))
      .filter((p) => p.plate),
    note: data.note || '',
    model: res.model,
  };
}

// --mock 模式：不呼叫 AI，用檔名裡的車牌（例如 ABC-1234_in.jpg）或隨機車牌，方便測流程
export function mockRecognize(filename = '') {
  const m = filename.toUpperCase().match(/([A-Z]{2,3}-?\d{3,4}|\d{3,4}-?[A-Z]{2,3})/);
  const plate = m ? normalizePlate(m[1]) : `MCK-${String(Math.floor(Math.random() * 9000) + 1000)}`;
  return { plates: [{ plate, confidence: 0.99, vehicle: '（模擬）' }], note: '模擬模式', model: 'mock' };
}
