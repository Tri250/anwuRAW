import { describe, expect, it } from 'vitest';
import {
  ADJUSTMENT_GROUPS,
  ADJUSTMENT_SECTIONS,
  COPYABLE_ADJUSTMENT_KEYS,
  DEFAULT_PARAMETRIC_CURVE_SETTINGS,
  INITIAL_ADJUSTMENTS,
  INITIAL_MASK_ADJUSTMENTS,
  INITIAL_MASK_CONTAINER,
  createRelightLight,
  getDefaultCurves,
  getRelightLightColor,
  normalizeLoadedAdjustments,
} from '../../src/utils/adjustments';
import { SubMaskMode } from '../../src/components/panel/right/Masks';
import type { Adjustments } from '../../src/utils/adjustments';

const asAdjustments = (value: any) => value as Adjustments;

describe('调整模块数据层', () => {
  describe('默认调整值', () => {
    it('包含六模块所需的全部默认字段', () => {
      expect(INITIAL_ADJUSTMENTS.exposure).toBe(0);
      expect(INITIAL_ADJUSTMENTS.sharpnessThreshold).toBe(15);
      expect(INITIAL_ADJUSTMENTS.aiDenoiseAmount).toBe(100);
      expect(INITIAL_ADJUSTMENTS.grainRoughness).toBe(50);
      expect(INITIAL_ADJUSTMENTS.grainSize).toBe(25);
      expect(INITIAL_ADJUSTMENTS.transformScale).toBe(100);
      expect(INITIAL_ADJUSTMENTS.toneMapper).toBe('basic');
      expect(INITIAL_ADJUSTMENTS.lensDistortionEnabled).toBe(true);
      expect(INITIAL_ADJUSTMENTS.lensTcaEnabled).toBe(true);
      expect(INITIAL_ADJUSTMENTS.lensVignetteEnabled).toBe(true);
      expect(INITIAL_ADJUSTMENTS.lutIntensity).toBe(100);
      expect(INITIAL_ADJUSTMENTS.vignetteCenterX).toBe(0.5);
      expect(INITIAL_ADJUSTMENTS.centréX).toBe(0.5);
      expect(INITIAL_ADJUSTMENTS.guidedPerspective).toEqual({ enabled: false, lines: [], autoCrop: true });
    });

    it('默认曲线为四通道对角线', () => {
      const curves = getDefaultCurves();
      expect(Object.keys(curves).sort()).toEqual(['blue', 'green', 'luma', 'red']);
      for (const channel of Object.values(curves)) {
        expect(channel).toEqual([
          { x: 0, y: 0 },
          { x: 255, y: 255 },
        ]);
      }
    });

    it('默认参数曲线三段分割点为 25/50/75', () => {
      expect(DEFAULT_PARAMETRIC_CURVE_SETTINGS.split1).toBe(25);
      expect(DEFAULT_PARAMETRIC_CURVE_SETTINGS.split2).toBe(50);
      expect(DEFAULT_PARAMETRIC_CURVE_SETTINGS.split3).toBe(75);
      expect(INITIAL_ADJUSTMENTS.parametricCurve?.luma).toEqual(DEFAULT_PARAMETRIC_CURVE_SETTINGS);
    });

    it('蒙版容器默认值完整', () => {
      expect(INITIAL_MASK_CONTAINER).toMatchObject({
        invert: false,
        name: 'New Mask',
        opacity: 100,
        visible: true,
        subMasks: [],
      });
      expect(INITIAL_MASK_ADJUSTMENTS.curveMode).toBe('point');
      expect(INITIAL_MASK_ADJUSTMENTS.sectionVisibility.basic).toBe(true);
      expect(INITIAL_MASK_ADJUSTMENTS.channelMixer?.red_from_red).toBe(100);
    });
  });

  describe('relight 灯光工具', () => {
    it('createRelightLight 生成唯一 id 与默认参数', () => {
      const a = createRelightLight(10, 20);
      const b = createRelightLight(10, 20);
      expect(a.id).not.toBe(b.id);
      expect(a).toMatchObject({
        type: 'point',
        x: 10,
        y: 20,
        depth: 0,
        intensity: 60,
        radius: 30,
        angle: 135,
        elevation: 60,
        cone: 40,
        feather: 50,
        temperature: 0,
        tint: 0,
        color: '#ffffff',
      });
    });

    it('中性白光返回纯白', () => {
      expect(getRelightLightColor(createRelightLight(0, 0))).toBe('rgb(255, 255, 255)');
    });

    it('正色温偏暖(红多蓝少)', () => {
      const light = { ...createRelightLight(0, 0), temperature: 100 };
      expect(getRelightLightColor(light)).toBe('rgb(255, 176, 97)');
    });

    it('负色温偏冷(蓝多红少)', () => {
      const light = { ...createRelightLight(0, 0), temperature: -100 };
      expect(getRelightLightColor(light)).toBe('rgb(97, 176, 255)');
    });

    it('正 tint 偏洋红', () => {
      const light = { ...createRelightLight(0, 0), tint: 100 };
      expect(getRelightLightColor(light)).toBe('rgb(255, 144, 255)');
    });

    it('基础颜色参与计算,黑色保持黑色', () => {
      expect(getRelightLightColor({ ...createRelightLight(0, 0), color: '#ff0000' })).toBe('rgb(255, 0, 0)');
      expect(getRelightLightColor({ ...createRelightLight(0, 0), color: '#000000' })).toBe('rgb(0, 0, 0)');
    });

    it('缺少颜色时按白色兜底', () => {
      const light = { ...createRelightLight(0, 0), color: undefined as unknown as string };
      expect(getRelightLightColor(light)).toBe('rgb(255, 255, 255)');
    });
  });

  describe('normalizeLoadedAdjustments', () => {
    it('空值返回完整默认调整', () => {
      expect(normalizeLoadedAdjustments(null as any)).toBe(INITIAL_ADJUSTMENTS);
    });

    it('空对象补齐所有默认字段', () => {
      const result = normalizeLoadedAdjustments(asAdjustments({}));
      expect(result.exposure).toBe(0);
      expect(result.aiDenoiseAmount).toBe(100);
      expect(result.sharpnessThreshold).toBe(15);
      expect(result.lutIsSceneReferred).toBe(false);
      expect(result.relightLights).toEqual([]);
      expect(result.masks).toEqual([]);
      expect(result.aiPatches).toEqual([]);
      expect(result.curves).toEqual(getDefaultCurves());
      expect(result.curves).not.toBe(getDefaultCurves());
      expect(result.guidedPerspective).toEqual({ enabled: false, lines: [], autoCrop: true });
    });

    it('保留已有标量并补齐缺失字段', () => {
      const result = normalizeLoadedAdjustments(
        asAdjustments({ exposure: 1.25, sharpnessThreshold: 40, lensCorrectionMode: 'auto' }),
      );
      expect(result.exposure).toBe(1.25);
      expect(result.sharpnessThreshold).toBe(40);
      expect(result.lensCorrectionMode).toBe('auto');
      expect(result.tint).toBe(0);
    });

    it('非法镜头模式回退为 manual', () => {
      expect(normalizeLoadedAdjustments(asAdjustments({ lensCorrectionMode: 'bad' })).lensCorrectionMode).toBe(
        'manual',
      );
    });

    it('嵌套对象与默认值深合并', () => {
      const result = normalizeLoadedAdjustments(
        asAdjustments({
          colorCalibration: { shadowsTint: 12 },
          colorGrading: { balance: 30 },
          hsl: { reds: { hue: 20 } },
          sectionVisibility: { effects: false, custom: true },
        }),
      );
      expect(result.colorCalibration.shadowsTint).toBe(12);
      expect(result.colorCalibration.redHue).toBe(0);
      expect(result.colorGrading.balance).toBe(30);
      expect(result.colorGrading.blending).toBe(50);
      expect(result.hsl.reds.hue).toBe(20);
      expect(result.hsl.blues).toEqual({ hue: 0, saturation: 0, luminance: 0 });
      expect(result.sectionVisibility.effects).toBe(false);
      expect(result.sectionVisibility.basic).toBe(true);
      expect(result.sectionVisibility.custom).toBe(true);
    });

    it('曲线深拷贝,后续修改源数据不影响归一化结果', () => {
      const source = {
        curves: {
          luma: [{ x: 0, y: 10 }, { x: 255, y: 250 }],
          red: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
          green: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
          blue: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
        },
        pointCurves: {
          luma: [{ x: 0, y: 20 }, { x: 255, y: 240 }],
          red: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
          green: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
          blue: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
        },
      };
      const result = normalizeLoadedAdjustments(asAdjustments(source));
      expect(result.curves).not.toBe(source.curves);
      expect(result.curves.luma).not.toBe(source.curves.luma);
      expect(result.pointCurves.luma[0]).not.toBe(source.pointCurves.luma[0]);
      source.curves.luma[0].y = 99;
      expect(result.curves.luma[0].y).toBe(10);
      expect(result.pointCurves.luma[0].y).toBe(20);
    });

    it('缺失曲线时补默认对角线', () => {
      const result = normalizeLoadedAdjustments(asAdjustments({ curves: undefined, pointCurves: undefined }));
      expect(result.curves).toEqual(getDefaultCurves());
      expect(result.pointCurves).toEqual(getDefaultCurves());
      expect(result.parametricCurve.luma).toEqual(DEFAULT_PARAMETRIC_CURVE_SETTINGS);
    });

    it('蒙版补齐默认值、id、子蒙版属性', () => {
      const result = normalizeLoadedAdjustments(
        asAdjustments({
          masks: [
            {
              name: 'Mask A',
              opacity: 50,
              adjustments: { exposure: 0.7 },
              subMasks: [{ type: 'radial' }],
            },
          ],
        }),
      );
      const mask = result.masks[0];
      expect(mask.id).toBeTruthy();
      expect(mask.visible).toBe(true);
      expect(mask.invert).toBe(false);
      expect(mask.opacity).toBe(50);
      expect(mask.adjustments.exposure).toBe(0.7);
      expect(mask.adjustments.sharpnessThreshold).toBe(15);
      expect(mask.adjustments.flareAmount).toBe(0);
      expect(mask.adjustments.hue).toBe(0);
      expect(mask.adjustments.curves).toEqual(getDefaultCurves());
      expect(mask.subMasks[0]).toMatchObject({
        type: 'radial',
        visible: true,
        mode: SubMaskMode.Additive,
        invert: false,
        opacity: 100,
      });
    });

    it('保留已有蒙版 id,已有子蒙版属性不被覆盖', () => {
      const result = normalizeLoadedAdjustments(
        asAdjustments({
          masks: [
            {
              id: 'mask-1',
              adjustments: { curves: undefined },
              subMasks: [{ id: 'sub', visible: false, mode: SubMaskMode.Subtractive, opacity: 30 }],
            },
          ],
        }),
      );
      expect(result.masks[0].id).toBe('mask-1');
      expect(result.masks[0].subMasks[0]).toMatchObject({
        id: 'sub',
        visible: false,
        mode: SubMaskMode.Subtractive,
        invert: false,
        opacity: 30,
      });
    });

    it('AI 补丁补齐 visible 与子蒙版默认值', () => {
      const result = normalizeLoadedAdjustments(
        asAdjustments({ aiPatches: [{ id: 'p1', prompt: 'remove tree', subMasks: [{}] }] }),
      );
      expect(result.aiPatches[0]).toMatchObject({ id: 'p1', prompt: 'remove tree', visible: true });
      expect(result.aiPatches[0].subMasks[0]).toMatchObject({
        visible: true,
        mode: SubMaskMode.Additive,
        invert: false,
        opacity: 100,
      });
    });

    it('引导透视:坐标钳制、类型纠正、限制 2 竖 2 横并补 id', () => {
      const result = normalizeLoadedAdjustments(
        asAdjustments({
          guidedPerspective: {
            enabled: true,
            lines: [
              { type: 'vertical', p1: { x: -1, y: 0.2 }, p2: { x: 2, y: 1.2 } },
              { type: 'vertical', p1: { x: 0.5, y: 0.5 } },
              { type: 'vertical', p1: { x: 0.1, y: 0.1 } },
              { type: 'horizontal', p1: { x: 0.3, y: 0.4 } },
              { type: 'bogus', p1: { x: 0.6, y: 0.7 } },
              { type: 'horizontal', p1: { x: 0.8, y: 0.9 } },
              { type: 'horizontal', p1: { x: 0.2, y: 0.3 } },
            ],
            autoCrop: false,
          },
        }),
      );
      const gp = result.guidedPerspective;
      expect(gp.enabled).toBe(true);
      expect(gp.autoCrop).toBe(false);
      expect(gp.lines).toHaveLength(4);
      expect(gp.lines.filter((l: any) => l.type === 'vertical')).toHaveLength(2);
      expect(gp.lines.filter((l: any) => l.type === 'horizontal')).toHaveLength(2);
      expect(gp.lines[0]).toMatchObject({ p1: { x: 0, y: 0.2 }, p2: { x: 1, y: 1 } });
      expect(gp.lines[1].p2).toEqual({ x: 1, y: 1 });
      expect(gp.lines.every((l: any) => typeof l.id === 'string' && l.id.length > 0)).toBe(true);
    });

    it('relight 灯光补齐默认字段并保留已有值', () => {
      const result = normalizeLoadedAdjustments(
        asAdjustments({ relightLights: [{ id: 'l1', x: 12, y: 34, intensity: 5 }] }),
      );
      expect(result.relightLights[0]).toMatchObject({
        id: 'l1',
        x: 12,
        y: 34,
        intensity: 5,
        type: 'point',
        color: '#ffffff',
      });
    });

    it('已有 null 值不被默认值覆盖(仅 undefined 回退)', () => {
      const result = normalizeLoadedAdjustments(
        asAdjustments({ lutName: null, lutPath: null, relightNormalMap: null }),
      );
      expect(result.lutName).toBeNull();
      expect(result.lutPath).toBeNull();
      expect(result.relightNormalMap).toBeNull();
    });
  });

  describe('拷贝/分区元数据', () => {
    it('所有分组都有非空 i18n 标签与键', () => {
      for (const groups of Object.values(ADJUSTMENT_GROUPS)) {
        expect(groups.length).toBeGreaterThan(0);
        for (const group of groups) {
          expect(group.label.length).toBeGreaterThan(0);
          expect(group.keys.length).toBeGreaterThan(0);
        }
      }
    });

    it('可复制键包含几何、蒙版、效果与细节关键项', () => {
      const keys = new Set(COPYABLE_ADJUSTMENT_KEYS);
      for (const key of [
        'exposure',
        'toneMapper',
        'curves',
        'whiteBalance',
        'colorGrading',
        'colorCalibration',
        'sharpness',
        'sharpnessThreshold',
        'aiDenoiseEnabled',
        'vignetteAmount',
        'lutPath',
        'crop',
        'aspectRatio',
        'rotation',
        'orientationSteps',
        'transformScale',
        'lensDistortionAmount',
        'guidedPerspective',
        'masks',
      ]) {
        expect(keys.has(key)).toBe(true);
      }
    });

    it('可复制键无重复', () => {
      expect(new Set(COPYABLE_ADJUSTMENT_KEYS).size).toBe(COPYABLE_ADJUSTMENT_KEYS.length);
    });

    it('调整分区包含基础、曲线、颜色、细节、效果、通道混合器', () => {
      expect(Object.keys(ADJUSTMENT_SECTIONS).sort()).toEqual([
        'basic',
        'channel_mixer',
        'color',
        'curves',
        'details',
        'effects',
      ]);
      expect(ADJUSTMENT_SECTIONS.basic).toContain('toneMapper');
      expect(ADJUSTMENT_SECTIONS.details).toContain('centré');
      expect(ADJUSTMENT_SECTIONS.effects).toContain('lensBlurEnabled');
      expect(ADJUSTMENT_SECTIONS.color).toContain('whiteBalance');
    });
  });
});
