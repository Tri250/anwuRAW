import { Coord } from './adjustments';

/**
 * 端侧颜色工具：用于「点按画面取样」的取色交互（白平衡估色、HSL 目标色定位）。
 * 全部为本地 HSV/HSL 数学实现，不依赖任何云服务或外部库。
 */

export interface HslColor {
  h: number; // 0-360
  s: number; // 0-1
  l: number; // 0-1
}

/** sRGB (0-255) → HSL (h:0-360, s:0-1, l:0-1)。
 *  注意：H 值可小于 0（色相围绕 360 环绕），调用方应按需取模。 */
export function rgbToHsl(r: number, g: number, b: number): HslColor {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;

  let h = 0;
  let s = 0;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rn:
        h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
        break;
      case gn:
        h = ((bn - rn) / d + 2) * 60;
        break;
      default:
        h = ((rn - gn) / d + 4) * 60;
        break;
    }
  }

  return { h, s, l };
}

/** sRGB(0-255) → 线性光强度（gamma 2.2 近似，与白平衡估色器一致） */
export function srgbToLinear(v: number): number {
  const c = v / 255;
  return Math.pow(Math.max(c, 0), 2.2);
}

export type HslColorKey = 'reds' | 'oranges' | 'yellows' | 'greens' | 'aquas' | 'blues' | 'purples' | 'magentas';

const HUE_BUCKET_BOUNDARIES: Array<{ key: HslColorKey; start: number; end: number }> = [
  { key: 'reds', start: 0, end: 15 },
  { key: 'oranges', start: 15, end: 45 },
  { key: 'yellows', start: 45, end: 70 },
  { key: 'greens', start: 70, end: 160 },
  { key: 'aquas', start: 160, end: 200 },
  { key: 'blues', start: 200, end: 250 },
  { key: 'purples', start: 250, end: 290 },
  { key: 'magentas', start: 290, end: 345 },
];

/** 把 0-360 的色相(已取模)映射到 8 个 HSL 颜色桶 */
export function hueToColorKey(hueDeg: number): HslColorKey {
  const h = ((hueDeg % 360) + 360) % 360;
  for (const b of HUE_BUCKET_BOUNDARIES) {
    if (h >= b.start && h < b.end) return b.key;
  }
  return 'reds';
}

/** 颜色桶的基准色相角（用于取色器命中文案/高亮判断） */
export const COLOR_HUE_REFERENCE: Record<HslColorKey, number> = {
  reds: 0,
  oranges: 30,
  yellows: 60,
  greens: 120,
  aquas: 180,
  blues: 240,
  purples: 270,
  magentas: 315,
};

/** 采样区域取中位数（对偶发非中性像素稳健） */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** 取色器的选区：图片坐标系内相对坐标 (+-radius) */
export interface ColorSampleRect {
  startX: number;
  startY: number;
  width: number;
  height: number;
}

export type Point2D = Coord;
