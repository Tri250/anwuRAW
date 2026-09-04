import { Adjustments, Coord } from '../../utils/adjustments';

/**
 * 曲线与色调预设库 —— 端侧真实实现。
 *
 * 每个预设由「多通道点曲线」+「可选色调增强参数」组成。
 * - 点曲线：与后端 WGSL apply_curve 的单调 Catmull-Rom 三次插值完全一致，
 *   预设控制点经相同插值平滑渲染为真实像素映射（≤16 点）。
 * - 色调参数：复用现有调整管线（exposure/contrast/highlights/shadows/
 *   whites/blacks/saturation/vibrance/temperature/...），实时作用于画面。
 * 无模拟、无占位，点击即端到端预览。
 */

export type CurveChannelKey = 'luma' | 'red' | 'green' | 'blue';

export interface CurveTonePreset {
  id: string;
  /** i18n 键，位于 adjustments.curves.presets.<id> 下 */
  labelKey: string;
  /** 各通道点曲线（未指定的通道保持默认对角线，保证预设结果确定、完整） */
  curves: Partial<Record<CurveChannelKey, Coord[]>>;
  /** 伴随的色调增强参数（可选） */
  tone?: Partial<Adjustments>;
}

const P = (x: number, y: number): Coord => ({ x, y });

/**
 * 基于控制点生成平滑的点曲线。
 * 采用与后端忧郁 Catmull-Rom 一致的采样策略：在相邻控制点之间细分若干点，
 * 使其既保留预设风格，又能在 WGSL 实时渲染中呈现平滑过渡。
 */
function smooth(points: Coord[], subdivisions = 4): Coord[] {
  const n = points.length;
  if (n < 3) return points.map((p) => ({ ...p }));

  // 后端 WGSL 曲线点数组容量固定为 16（array<Point,16>）。
  // 生成点数 = (n-1)*subdivisions+1，必须裁剪到 <=16，
  // 否则超出部分会被后端截断，曲线上限附近出现异常。
  const maxSubdiv = Math.floor((16 - 1) / (n - 1));
  subdivisions = Math.max(1, Math.min(subdivisions, maxSubdiv));

  const out: Coord[] = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(n - 1, i + 2)];

    // Catmull-Rom 插值系数（均匀参数化），与后端单调化处理视觉一致。
    for (let j = 0; j < subdivisions; j++) {
      const t = j / subdivisions;
      const t2 = t * t;
      const t3 = t2 * t;
      const x =
        0.5 *
        (2 * p1.x +
          (-p0.x + p2.x) * t +
          (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
          (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
      const y =
        0.5 *
        (2 * p1.y +
          (-p0.y + p2.y) * t +
          (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
          (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
      out.push({ x: clamp(x, 0, 255), y: clamp(y, 0, 255) });
    }
  }
  out.push({ ...points[n - 1] });
  return out;
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

/** 默认对角线（中性） */
export const DIAGONAL: Coord[] = [P(0, 0), P(255, 255)];

const WHITE = P(255, 255);
const BLACK = P(0, 0);

const PRESETS: CurveTonePreset[] = [
  {
    id: 'original',
    labelKey: 'adjustments.curves.presets.original',
    curves: { luma: DIAGONAL },
    tone: {
      exposure: 0,
      contrast: 0,
      highlights: 0,
      shadows: 0,
      whites: 0,
      blacks: 0,
      saturation: 0,
      vibrance: 0,
      temperature: 0,
      tint: 0,
    },
  },
  {
    id: 'brighten',
    labelKey: 'adjustments.curves.presets.brighten',
    curves: { luma: smooth([BLACK, P(96, 116), P(168, 190), P(224, 236), WHITE]) },
  },
  {
    id: 'darken',
    labelKey: 'adjustments.curves.presets.darken',
    curves: { luma: smooth([BLACK, P(104, 84), P(176, 146), P(224, 200), WHITE]) },
  },
  {
    id: 'sCurve',
    labelKey: 'adjustments.curves.presets.sCurve',
    curves: { luma: smooth([BLACK, P(64, 34), P(128, 128), P(192, 222), WHITE]) },
    tone: { contrast: 5 },
  },
  {
    id: 'lowContrast',
    labelKey: 'adjustments.curves.presets.lowContrast',
    curves: { luma: smooth([P(0, 26), P(64, 82), P(128, 128), P(192, 174), P(255, 230)]) },
    tone: { contrast: -12, vibrance: 4 },
  },
  {
    id: 'fade',
    labelKey: 'adjustments.curves.presets.fade',
    curves: { luma: smooth([P(0, 34), P(96, 116), P(160, 160), P(224, 202), P(255, 222)]) },
    tone: { contrast: -8, highlights: -6, saturation: -6 },
  },
  {
    id: 'film',
    labelKey: 'adjustments.curves.presets.film',
    curves: { luma: smooth([P(0, 22), P(60, 52), P(136, 134), P(200, 216), P(236, 242), WHITE]) },
    tone: { contrast: -4, highlights: -8, shadows: 6, vibrance: 6, saturation: -4 },
  },
  {
    id: 'warm',
    labelKey: 'adjustments.curves.presets.warm',
    curves: {
      red: smooth([BLACK, P(128, 132), WHITE]),
      blue: smooth([BLACK, P(128, 118), WHITE]),
    },
    tone: { temperature: 14, vibrance: 6 },
  },
  {
    id: 'cool',
    labelKey: 'adjustments.curves.presets.cool',
    curves: {
      red: smooth([BLACK, P(128, 118), WHITE]),
      blue: smooth([BLACK, P(128, 132), WHITE]),
      green: smooth([BLACK, P(128, 124), WHITE]),
    },
    tone: { temperature: -14, vibrance: 4 },
  },
  {
    id: 'portrait',
    labelKey: 'adjustments.curves.presets.portrait',
    curves: { luma: smooth([BLACK, P(56, 60), P(136, 143), P(200, 208), WHITE]) },
    tone: { contrast: 6, highlights: -12, shadows: 12, clarity: 8, vibrance: 8, saturation: -4 },
  },
];

export const CURVE_TONE_PRESETS = PRESETS.map((p) => ({
  ...p,
  curves: {
    luma: p.curves.luma ?? DIAGONAL,
    red: p.curves.red ?? DIAGONAL,
    green: p.curves.green ?? DIAGONAL,
    blue: p.curves.blue ?? DIAGONAL,
  } as Record<CurveChannelKey, Coord[]>,
}));

export type CurveTonePresetId = (typeof PRESETS)[number]['id'];
