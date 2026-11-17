// 從照片檔讀出拍攝時間（EXIF DateTimeOriginal），支援 JPEG 和 iPhone 的 HEIC，不需要外部套件。
// 回傳 { date: Date, source: 'exif' } 或 null。
export async function readExifDate(file) {
  try {
    // HEIC 的 EXIF 可能不在檔頭，整個檔案讀進來找（手機照片通常 1–5MB）
    const limit = Math.min(file.size, 16 * 1024 * 1024);
    const bytes = new Uint8Array(await file.slice(0, limit).arrayBuffer());
    const v = new DataView(bytes.buffer);

    // JPEG：照標準走 APP1 區段
    if (v.getUint16(0) === 0xffd8) {
      let off = 2;
      while (off + 4 < bytes.length) {
        const marker = v.getUint16(off);
        const len = v.getUint16(off + 2);
        if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) {
          const r = tryParse(v, off + 10);
          if (r) return r;
        }
        if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) break; // 影像資料開始，不再有 EXIF
        off += 2 + len;
      }
    }

    // HEIC 或其他格式：找 "Exif\0\0" 標記，後面接著 TIFF 資料
    for (let i = 0; i + 10 < bytes.length; i++) {
      if (bytes[i] === 0x45 && bytes[i + 1] === 0x78 && bytes[i + 2] === 0x69 && bytes[i + 3] === 0x66 && bytes[i + 4] === 0 && bytes[i + 5] === 0) {
        const r = tryParse(v, i + 6);
        if (r) return r;
      }
    }
    // 最後手段：直接找 TIFF 檔頭（II*\0 或 MM\0*）
    for (let i = 0; i + 8 < bytes.length; i++) {
      const isII = bytes[i] === 0x49 && bytes[i + 1] === 0x49 && bytes[i + 2] === 0x2a && bytes[i + 3] === 0;
      const isMM = bytes[i] === 0x4d && bytes[i + 1] === 0x4d && bytes[i + 2] === 0 && bytes[i + 3] === 0x2a;
      if (isII || isMM) {
        const r = tryParse(v, i);
        if (r) return r;
      }
    }
  } catch {}
  return null;
}

function tryParse(v, start) {
  try {
    return parseTiff(v, start);
  } catch {
    return null;
  }
}

function parseTiff(v, start) {
  const bom = v.getUint16(start);
  if (bom !== 0x4949 && bom !== 0x4d4d) return null;
  const little = bom === 0x4949;
  const u16 = (o) => v.getUint16(start + o, little);
  const u32 = (o) => v.getUint32(start + o, little);
  if (u16(2) !== 42) return null;
  const str = (o, n) => {
    let s = '';
    for (let i = 0; i < n; i++) {
      const c = v.getUint8(start + o + i);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  };
  const readIfd = (ifdOff) => {
    const tags = {};
    const n = u16(ifdOff);
    if (n > 500) throw new Error('bad ifd');
    for (let i = 0; i < n; i++) {
      const e = ifdOff + 2 + i * 12;
      const tag = u16(e);
      const type = u16(e + 2);
      const count = u32(e + 4);
      if (type === 2 && count < 256) tags[tag] = str(count > 4 ? u32(e + 8) : e + 8, count);
      else if (type === 4) tags[tag] = u32(e + 8);
    }
    return tags;
  };
  const ifd0 = readIfd(u32(4));
  const exif = ifd0[0x8769] ? readIfd(ifd0[0x8769]) : {};
  const dt = exif[0x9003] || exif[0x9004] || ifd0[0x0132]; // 拍攝時間 / 數位化時間 / 修改時間
  if (!dt) return null;
  const m = dt.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m || m[1] === '0000') return null;
  const offset = exif[0x9011] || exif[0x9010]; // 例如 +08:00
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${/^[+-]\d{2}:\d{2}$/.test(offset || '') ? offset : ''}`;
  const date = new Date(iso); // 沒有時區資訊時，視為這支手機的當地時間
  return Number.isNaN(date.getTime()) ? null : { date, source: 'exif' };
}
