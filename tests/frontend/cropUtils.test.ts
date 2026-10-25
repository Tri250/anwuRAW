import { describe, expect, it } from 'vitest';
import {
  calculateAreaPreservingCrop,
  calculateAutoCropForRotation,
  calculateCenteredCrop,
  calculateStraightenAngle,
  getOrientedDimensions,
  isCropWithinBounds,
} from '../../src/utils/cropUtils';

describe('裁剪几何纯函数', () => {
  describe('getOrientedDimensions', () => {
    it('orientationSteps 为 0/2 时保持原始宽高', () => {
      expect(getOrientedDimensions(4000, 3000, 0)).toEqual({ width: 4000, height: 3000 });
      expect(getOrientedDimensions(4000, 3000, 2)).toEqual({ width: 4000, height: 3000 });
      expect(getOrientedDimensions(4000, 3000, 4)).toEqual({ width: 4000, height: 3000 });
    });

    it('orientationSteps 为 1/3 时交换宽高', () => {
      expect(getOrientedDimensions(4000, 3000, 1)).toEqual({ width: 3000, height: 4000 });
      expect(getOrientedDimensions(4000, 3000, 3)).toEqual({ width: 3000, height: 4000 });
    });
  });

  describe('calculateCenteredCrop', () => {
    it('无比例或非法比例时返回 null', () => {
      expect(calculateCenteredCrop(4000, 3000, 0, null)).toBeNull();
      expect(calculateCenteredCrop(4000, 3000, 0, 0)).toBeNull();
      expect(calculateCenteredCrop(4000, 3000, 0, -1.5)).toBeNull();
    });

    it('与图像同比例时铺满画面并居中', () => {
      expect(calculateCenteredCrop(4000, 3000, 0, 4 / 3)).toEqual({
        unit: 'px',
        x: 0,
        y: 0,
        width: 4000,
        height: 3000,
      });
    });

    it('横图裁 1:1 时垂直居中', () => {
      const crop = calculateCenteredCrop(4000, 3000, 0, 1)!;
      expect(crop).toEqual({ unit: 'px', x: 500, y: 0, width: 3000, height: 3000 });
    });

    it('orientationSteps=1 时按交换后的方向计算', () => {
      const crop = calculateCenteredCrop(4000, 3000, 1, 1)!;
      expect(crop).toEqual({ unit: 'px', x: 0, y: 500, width: 3000, height: 3000 });
    });

    it('旋转 45° 时收缩为内接区域', () => {
      const crop = calculateCenteredCrop(4000, 3000, 0, 1, 45)!;
      expect(crop.width).toBe(2121);
      expect(crop.height).toBe(2121);
      expect(crop.x).toBe(939);
      expect(crop.y).toBe(439);
      expect(isCropWithinBounds(crop, 4000, 3000, 45)).toBe(true);
    });

    it('负角度使用绝对值,正负旋转结果一致', () => {
      expect(calculateCenteredCrop(4000, 3000, 0, 1, -30)).toEqual(
        calculateCenteredCrop(4000, 3000, 0, 1, 30),
      );
    });
  });

  describe('isCropWithinBounds', () => {
    const crop = { unit: 'px' as const, x: 10, y: 10, width: 80, height: 80 };

    it('未旋转时四角均在画面内返回 true', () => {
      expect(isCropWithinBounds(crop, 100, 100, 0)).toBe(true);
    });

    it('超出左/上边界返回 false', () => {
      expect(isCropWithinBounds({ ...crop, x: -5 }, 100, 100, 0)).toBe(false);
      expect(isCropWithinBounds({ ...crop, y: -5 }, 100, 100, 0)).toBe(false);
    });

    it('超出右/下边界返回 false', () => {
      expect(isCropWithinBounds({ ...crop, width: 95 }, 100, 100, 0)).toBe(false);
      expect(isCropWithinBounds({ ...crop, height: 95 }, 100, 100, 0)).toBe(false);
    });

    it('旋转后角点越界返回 false,内接裁剪返回 true', () => {
      const full = { unit: 'px' as const, x: 0, y: 0, width: 100, height: 100 };
      expect(isCropWithinBounds(full, 100, 100, 0)).toBe(true);
      expect(isCropWithinBounds(full, 100, 100, 45)).toBe(false);
      const inscribed = { unit: 'px' as const, x: 15, y: 15, width: 70, height: 70 };
      expect(isCropWithinBounds(inscribed, 100, 100, 45)).toBe(true);
    });

    it('允许 1px 浮点容差', () => {
      expect(
        isCropWithinBounds({ unit: 'px', x: -0.5, y: -0.5, width: 100.5, height: 100.5 }, 100, 100, 0),
      ).toBe(true);
    });
  });

  describe('calculateAreaPreservingCrop', () => {
    it('缺少比例/当前裁剪/尺寸时返回 null', () => {
      expect(calculateAreaPreservingCrop(1000, 1000, 0, null, 0, null)).toBeNull();
      expect(
        calculateAreaPreservingCrop(1000, 1000, 0, 1, 0, { unit: 'px', x: 0, y: 0, width: 0, height: 100 }),
      ).toBeNull();
      expect(calculateAreaPreservingCrop(1000, 1000, 0, -1, 0, undefined)).toBeNull();
    });

    it('保持面积并按目标比例重排,中心不变', () => {
      const current = { unit: 'px' as const, x: 1000, y: 1000, width: 2000, height: 1000 };
      const result = calculateAreaPreservingCrop(4000, 3000, 0, 1, 0, current)!;
      expect(result.width).toBe(1414);
      expect(result.height).toBe(1414);
      expect(result.width * result.height).toBeCloseTo(2_000_000, -4);
      expect(result.x + result.width / 2).toBeCloseTo(current.x + current.width / 2, 0);
      expect(result.y + result.height / 2).toBeCloseTo(current.y + current.height / 2, 0);
    });

    it('目标比例在边界外时返回 null', () => {
      const current = { unit: 'px' as const, x: 0, y: 0, width: 1000, height: 1000 };
      expect(calculateAreaPreservingCrop(1000, 1000, 0, 0.1, 0, current)).toBeNull();
    });

    it('旋转状态下使用旋转后的边界判定', () => {
      const current = { unit: 'px' as const, x: 250, y: 250, width: 500, height: 500 };
      const result = calculateAreaPreservingCrop(1000, 1000, 0, 1, 45, current)!;
      expect(result).not.toBeNull();
      expect(isCropWithinBounds(result, 1000, 1000, 45)).toBe(true);
    });
  });

  describe('calculateAutoCropForRotation', () => {
    it('无当前裁剪时退回居中裁剪', () => {
      expect(calculateAutoCropForRotation(4000, 3000, 0, 1, 30, null)).toEqual(
        calculateCenteredCrop(4000, 3000, 0, 1, 30),
      );
    });

    it('比例为 null 时使用图像原始宽高比', () => {
      expect(calculateAutoCropForRotation(4000, 3000, 0, null, 0, null)).toEqual(
        calculateCenteredCrop(4000, 3000, 0, 4000 / 3000, 0),
      );
    });

    it('旋转增量非 0 时跟随旋转中心', () => {
      const crop = { unit: 'px' as const, x: 100, y: 100, width: 200, height: 200 };
      const result = calculateAutoCropForRotation(1000, 1000, 0, null, 0, crop, 90)!;
      expect(result).toEqual({ unit: 'px', x: 700, y: 100, width: 200, height: 200 });
    });

    it('当前裁剪在旋转后仍合法时原样返回(含旋转增量 0)', () => {
      const crop = { unit: 'px' as const, x: 100, y: 100, width: 200, height: 200 };
      expect(calculateAutoCropForRotation(1000, 1000, 0, null, 0, crop, 0)).toBe(crop);
      expect(calculateAutoCropForRotation(1000, 1000, 0, null, 10, crop, 0)).toBe(crop);
    });

    it('越界时按同一中心二分缩放,结果仍在内接范围', () => {
      const crop = { unit: 'px' as const, x: 0, y: 0, width: 1000, height: 1000 };
      const result = calculateAutoCropForRotation(1000, 1000, 0, null, 45, crop)!;
      expect(result.width).toBeLessThan(1000);
      expect(result.width).toBeGreaterThan(0);
      expect(Number.isInteger(result.x)).toBe(true);
      expect(Number.isInteger(result.y)).toBe(true);
      expect(Number.isInteger(result.width)).toBe(true);
      expect(Number.isInteger(result.height)).toBe(true);
      expect(isCropWithinBounds(result, 1000, 1000, 45)).toBe(true);
    });

    it('缩放系数低于 0.15 时回退为居中裁剪', () => {
      // 跟随 45° 旋转后中心落在画布外(-136),任何缩放都无法回到边界内
      const crop = { unit: 'px' as const, x: 0, y: 0, width: 100, height: 100 };
      const result = calculateAutoCropForRotation(1000, 1000, 0, 1, 0, crop, 45)!;
      expect(result).toEqual(calculateCenteredCrop(1000, 1000, 0, 1, 0));
    });

    it('orientationSteps=1 时使用交换后的中心', () => {
      const crop = { unit: 'px' as const, x: 1300, y: 1800, width: 200, height: 200 };
      const result = calculateAutoCropForRotation(4000, 3000, 1, null, 0, crop, 90)!;
      // 竖图 3000x4000,中心 (1500,2000);原中心 (1400,1900) 旋转 90° → (1600,1900)
      expect(result).toEqual({ unit: 'px', x: 1500, y: 1800, width: 200, height: 200 });
    });
  });

  describe('calculateStraightenAngle', () => {
    it('水平线归零', () => {
      expect(calculateStraightenAngle(1, 0)).toBeCloseTo(0);
      expect(calculateStraightenAngle(-1, 0)).toBeCloseTo(0);
    });

    it('垂直线分别归一化到 0° / ±90° / 180° 的最近方向', () => {
      expect(calculateStraightenAngle(0, 1)).toBeCloseTo(0);
      expect(calculateStraightenAngle(0, -1)).toBeCloseTo(0);
    });

    it('+45° 斜线修正 -45°', () => {
      expect(calculateStraightenAngle(1, 1)).toBeCloseTo(-45);
    });

    it('-45° 边界归入垂直方向,修正 -45°', () => {
      expect(calculateStraightenAngle(1, -1)).toBeCloseTo(-45);
      // 略大于 -45° 时归入水平方向,做正向修正
      expect(calculateStraightenAngle(1, -0.99)).toBeCloseTo(44.7, 0);
    });

    it('135° 与 -135° 斜线均修正到最近轴向', () => {
      expect(calculateStraightenAngle(-1, 1)).toBeCloseTo(-45);
      expect(calculateStraightenAngle(-1, -1)).toBeCloseTo(-45);
    });

    it('接近垂直时做小幅修正', () => {
      expect(calculateStraightenAngle(0.1, 1)).toBeCloseTo(5.71, 1);
    });
  });
});
