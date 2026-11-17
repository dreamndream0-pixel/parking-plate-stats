// 從 JPEG 讀出拍攝時間（EXIF DateTimeOriginal），不需要外部套件。
// 回傳 { date: Date, source: 'exif' } 或 null。
export async function readExifDate(file) {
  try {
    const buf = await file.slice(0, 256 * 1024).arrayBuffer();
    const v = new DataView(buf);
    if (v.getUint16(0) !== 0xffd8) return null; // 不是 JPEG
    let off = 2;
    while (off + 4 < v.byteLength) {
      const marker = v.getUint16(off);
      const len = v.getUint16(off + 2);
      if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) {
        return parseTiff(v, off + 10);
      }
      if ((marker & 0xff00) !== 0xff00) break;
      off += 2 + len;
    }
  } catch {}
  return null;
}

function parseTiff(v, start) {
  const little = v.getUint16(start) === 0x4949;
  const u16 = (o) => v.getUint16(start + o, little);
  const u32 = (o) => v.getUint32(start + o, little);
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
    for (let i = 0; i < n; i++) {
      const e = ifdOff + 2 + i * 12;
      const tag = u16(e);
      const type = u16(e + 2);
      const count = u32(e + 4);
      if (type === 2) tags[tag] = str(count > 4 ? u32(e + 8) : e + 8, count);
      else if (type === 4) tags[tag] = u32(e + 8);
    }
    return tags;
  };
  const ifd0 = readIfd(u32(4));
  const exif = ifd0[0x8769] ? readIfd(ifd0[0x8769]) : {};
  const dt = exif[0x9003] || exif[0x9004] || ifd0[0x0132]; // 拍攝時間 / 數位化時間 / 修改時間
  if (!dt) return null;
  const m = dt.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const offset = exif[0x9011] || exif[0x9010]; // 例如 +08:00
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${/^[+-]\d{2}:\d{2}$/.test(offset || '') ? offset : ''}`;
  const date = new Date(iso); // 沒有時區資訊時，視為這支手機/電腦的當地時間
  return Number.isNaN(date.getTime()) ? null : { date, source: 'exif' };
}
