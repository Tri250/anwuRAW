/**
 * PWA 图标生成（零依赖 PNG 编码器）
 * 品牌图标：天山青渐变底 + 白色牛奶滴 + 奶波
 */
'use strict';
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

/* ---------- PNG 编码 ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------- 绘制 ---------- */
function mix(c1, c2, t) {
  return [
    Math.round(c1[0] + (c2[0] - c1[0]) * t),
    Math.round(c1[1] + (c2[1] - c1[1]) * t),
    Math.round(c1[2] + (c2[2] - c1[2]) * t),
  ];
}
function drawIcon(size, { maskable = false } = {}) {
  const px = Buffer.alloc(size * size * 4);
  const TOP = [26, 156, 128], BOT = [8, 78, 66]; // 品牌渐变
  const rr = maskable ? 0 : Math.round(size * 0.215);         // 圆角
  const cx = size / 2, cy = size / 2;
  const s = maskable ? 0.60 : 0.78;                            // 主体缩放
  const R = size * 0.21 * s;                                   // 滴腹半径
  const dcx = cx, dcy = cy + size * 0.055 * s;
  const tip = { x: cx, y: dcy - R - size * 0.30 * s };         // 滴尖
  const waveY = dcy + R * 1.28;
  const put = (x, y, rgb, a) => {
    const i = (y * size + x) * 4;
    const na = a / 255;
    px[i] = Math.round(rgb[0] * na + px[i] * (1 - na));
    px[i + 1] = Math.round(rgb[1] * na + px[i + 1] * (1 - na));
    px[i + 2] = Math.round(rgb[2] * na + px[i + 2] * (1 - na));
    px[i + 3] = Math.min(255, px[i + 3] + a);
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 背板（圆角矩形 mask）
      const dx = Math.max(rr - x, x - (size - 1 - rr), 0);
      const dy = Math.max(rr - y, y - (size - 1 - rr), 0);
      const corner = Math.hypot(dx, dy);
      if (corner > rr + 0.5) continue;
      const bg = mix(TOP, BOT, y / size);
      put(x, y, bg, 255);
      const fx = x + 0.5, fy = y + 0.5;
      // 奶滴：圆 + 尖角三角
      const dCircle = Math.hypot(fx - dcx, fy - dcy) - R;
      const inTri = fy >= tip.y && fy <= dcy &&
        Math.abs(fx - tip.x) <= (R * 0.78) * ((fy - tip.y) / (dcy - tip.y));
      if (dCircle <= 0 || inTri) {
        const aa = Math.min(1, Math.max(0, -dCircle / 1.2));
        put(x, y, [255, 255, 255], Math.round(255 * (inTri && dCircle > 0 ? 1 : aa)));
      }
      // 奶波（半透明正弦带）
      const wv = waveY + Math.sin((fx / size) * Math.PI * 3.2 + 0.6) * size * 0.022 * s;
      if (fy > wv && fy < wv + size * 0.115 * s) put(x, y, [255, 255, 255], 42);
      // 左上高光
      const hl = Math.hypot(fx - size * 0.34, fy - size * (maskable ? 0.30 : 0.27)) - size * 0.14 * s;
      if (hl <= 0 && fy < dcy - R * 0.2) put(x, y, [255, 255, 255], 46);
    }
  }
  return encodePNG(size, size, px);
}

const OUT = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'icon-192.png'), drawIcon(192));
fs.writeFileSync(path.join(OUT, 'icon-512.png'), drawIcon(512));
fs.writeFileSync(path.join(OUT, 'maskable-512.png'), drawIcon(512, { maskable: true }));
fs.writeFileSync(path.join(OUT, 'icon-180.png'), drawIcon(180)); // apple touch
console.log('[icons] generated: icon-192 / icon-512 / maskable-512 / icon-180');
