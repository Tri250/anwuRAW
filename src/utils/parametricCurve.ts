import { Coord, DEFAULT_PARAMETRIC_CURVE_SETTINGS } from './adjustments';

export interface ParametricLike {
  darks: number;
  shadows: number;
  highlights: number;
  lights: number;
  blackLevel: number;
  whiteLevel: number;
  split1: number;
  split2: number;
  split3: number;
}

/**
 * 将参数化曲线（暗部/阴影/高光/亮部 + 黑白场）转换为点曲线坐标（0-255）。
 * 与桌面 Curves 面板保持同一套数学（响应曲线 + 钳制），供移动端直接写入
 * `curves.luma` 渲染。实现必须与桌面端完全一致，避免两端观感漂移。
 */
export function buildParametricPoints(settings: ParametricLike): Array<Coord> {
  const vH = settings.highlights / 100;
  const vL = settings.lights / 100;
  const vD = settings.darks / 100;
  const vS = settings.shadows / 100;

  const blackYOffset = settings.blackLevel;
  const whiteYOffset = settings.whiteLevel;

  const s1 = settings.split1 / 100;
  const s2 = settings.split2 / 100;
  const s3 = settings.split3 / 100;

  const xH = (s3 + 1) / 2;
  const xS = s1 / 2;
  const xs = [0, xS, s1, s2, s3, xH, 1];

  const SLIDER_GAIN = 1.2;
  const MAX_DISPLACEMENT = 0.35;

  const response = (v: number, x: number): number => {
    const headroom = v >= 0 ? 1 - x : x;
    const compressedHeadroom = Math.sqrt(headroom);
    const sigmoid = Math.tanh(v * SLIDER_GAIN);
    return sigmoid * MAX_DISPLACEMENT * compressedHeadroom;
  };

  const ys = [
    0,
    xS + response(vS, xS),
    s1 + (response(vS, s1) + response(vD, s1)) / 2,
    s2 + (response(vD, s2) + response(vL, s2)) / 2,
    s3 + (response(vL, s3) + response(vH, s3)) / 2,
    xH + response(vH, xH),
    1,
  ];

  const clamp = (v: number) => Math.max(0, Math.min(1, v));

  const points = xs.map((x, i) => ({
    x: x * 255,
    y: clamp(ys[i]) * 255,
  }));

  if (points.length >= 2) {
    points[0].y = Math.max(0, Math.min(255, points[0].y + blackYOffset));

    const lastIndex = points.length - 1;
    points[lastIndex].y = Math.max(0, Math.min(255, points[lastIndex].y + whiteYOffset));
  }

  return points;
}

/** 判断参数化曲线是否处于中性（未调整）状态。 */
export function isDefaultParametricCurve(settings: ParametricLike | undefined): boolean {
  if (!settings) return true;
  return (
    settings.darks === DEFAULT_PARAMETRIC_CURVE_SETTINGS.darks &&
    settings.shadows === DEFAULT_PARAMETRIC_CURVE_SETTINGS.shadows &&
    settings.lights === DEFAULT_PARAMETRIC_CURVE_SETTINGS.lights &&
    settings.highlights === DEFAULT_PARAMETRIC_CURVE_SETTINGS.highlights &&
    settings.whiteLevel === DEFAULT_PARAMETRIC_CURVE_SETTINGS.whiteLevel &&
    settings.blackLevel === DEFAULT_PARAMETRIC_CURVE_SETTINGS.blackLevel &&
    settings.split1 === DEFAULT_PARAMETRIC_CURVE_SETTINGS.split1 &&
    settings.split2 === DEFAULT_PARAMETRIC_CURVE_SETTINGS.split2 &&
    settings.split3 === DEFAULT_PARAMETRIC_CURVE_SETTINGS.split3
  );
}
