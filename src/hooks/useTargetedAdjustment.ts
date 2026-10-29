import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { Adjustments, Coord } from '../utils/adjustments';
import { Invokes } from '../components/ui/AppProperties';
import { useEditorStore } from '../store/useEditorStore';

/**
 * G2 目标调整（HSL 取色拖动）：
 * 进入目标模式后，在画布上按下取样颜色 → 按色相匹配 8 个 HSL 通道之一 →
 * 拖动 X/Y 分别驱动该通道的 hue/saturation 增量 → 松开提交（经 setAdjustments
 * 的去抖 pushHistory，undo 一步还原）；Esc 拖动中取消恢复冻结值，空闲时退出模式。
 */

// 通道色相区间（度），与 HSL 混色器 8 色板一致；reds 跨 0° 环绕。
export type HslChannelKey = 'reds' | 'oranges' | 'yellows' | 'greens' | 'aquas' | 'blues' | 'purples' | 'magentas';

export const HSL_CHANNEL_RANGES: Array<{ key: HslChannelKey; min: number; max: number }> = [
  { key: 'reds', min: 345, max: 360 },
  { key: 'reds', min: 0, max: 15 },
  { key: 'oranges', min: 15, max: 45 },
  { key: 'yellows', min: 45, max: 70 },
  { key: 'greens', min: 70, max: 150 },
  { key: 'aquas', min: 150, max: 200 },
  { key: 'blues', min: 200, max: 260 },
  { key: 'purples', min: 260, max: 300 },
  { key: 'magentas', min: 300, max: 345 },
];

export const matchHslChannel = (hue: number): HslChannelKey => {
  const h = ((hue % 360) + 360) % 360;
  return HSL_CHANNEL_RANGES.find((range) => h >= range.min && h < range.max)?.key ?? 'reds';
};

// 线性 RGB（后端取样返回值）→ sRGB → HSV 色相。纯黑/无色返回 null。
export const linearRgbToHue = (r: number, g: number, b: number): number | null => {
  const toSrgb = (value: number) => {
    const c = Math.max(0, Math.min(1, value));
    return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  };
  const R = toSrgb(r);
  const G = toSrgb(g);
  const B = toSrgb(b);
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const delta = max - min;
  if (delta < 1e-6 || max < 1e-6) return null;

  let h: number;
  if (max === R) h = 60 * (((G - B) / delta) % 6);
  else if (max === G) h = 60 * ((B - R) / delta + 2);
  else h = 60 * ((R - G) / delta + 4);
  return ((h % 360) + 360) % 360;
};

const clampChannelDelta = (value: number) => Math.max(-100, Math.min(100, Math.round(value)));

// 拖动灵敏度：200px 拖满 ±100（与 HSL 滑杆范围一致）。
const DRAG_SENSITIVITY = 0.5;

interface WbSample {
  r: number;
  g: number;
  b: number;
}

export interface TargetedDragState {
  channelKey: HslChannelKey;
  hueDelta: number;
  satDelta: number;
  isDragging: boolean;
}

interface TargetedDragRef {
  startPos: Coord;
  channelKey: HslChannelKey;
  startHue: number;
  startSaturation: number;
  hueDelta: number;
  satDelta: number;
}

interface UseTargetedAdjustmentParams {
  isActive: boolean;
  adjustments: Adjustments;
  setAdjustments: (fn: (prev: Adjustments) => Adjustments) => void;
  getCanvasPointer: (stage: any) => Coord | null;
  isInsideImage: (pos: Coord) => boolean;
  getSampleCorners: (center: Coord) => Array<Coord>;
  getSampleAdjustments: () => any;
}

export function useTargetedAdjustment({
  isActive,
  adjustments,
  setAdjustments,
  getCanvasPointer,
  isInsideImage,
  getSampleCorners,
  getSampleAdjustments,
}: UseTargetedAdjustmentParams) {
  const { t } = useTranslation();
  const setEditor = useEditorStore((s) => s.setEditor);
  const dragRef = useRef<TargetedDragRef | null>(null);
  const pendingSampleRef = useRef<{ startPos: Coord; generation: number } | null>(null);
  const generationRef = useRef(0);
  const [dragState, setDragState] = useState<TargetedDragState | null>(null);

  const applyChannelDelta = useCallback(
    (ref: TargetedDragRef) => {
      setAdjustments((prev: Adjustments) => {
        const channel = prev.hsl?.[ref.channelKey] || { hue: 0, saturation: 0, luminance: 0 };
        return {
          ...prev,
          hsl: {
            ...prev.hsl,
            [ref.channelKey]: {
              ...channel,
              hue: clampChannelDelta(ref.startHue + ref.hueDelta),
              saturation: clampChannelDelta(ref.startSaturation + ref.satDelta),
            },
          },
        };
      });
    },
    [setAdjustments],
  );

  const handleTargetedStart = useCallback(
    (e: any): boolean => {
      if (!isActive || dragRef.current || pendingSampleRef.current) return isActive;
      const stage = e?.target?.getStage?.();
      const pos = stage ? getCanvasPointer(stage) : null;
      if (!pos) return isActive;
      if (!isInsideImage(pos)) return true;

      const generation = ++generationRef.current;
      pendingSampleRef.current = { startPos: pos, generation };
      const corners = getSampleCorners(pos);
      const sampleAdjustments = getSampleAdjustments();

      (async () => {
        try {
          const sample = await invoke<WbSample>(Invokes.SampleWhiteBalance, {
            corners,
            jsAdjustments: sampleAdjustments,
          });
          const pending = pendingSampleRef.current;
          if (!pending || pending.generation !== generation) return;
          pendingSampleRef.current = null;

          const hue = linearRgbToHue(sample.r, sample.g, sample.b);
          if (hue === null) {
            toast.info(t('editor.targeted.sampleFailed'));
            return;
          }
          const channelKey = matchHslChannel(hue);
          const channel = adjustments.hsl?.[channelKey] || { hue: 0, saturation: 0, luminance: 0 };
          const ref: TargetedDragRef = {
            startPos: pending.startPos,
            channelKey,
            startHue: channel.hue || 0,
            startSaturation: channel.saturation || 0,
            hueDelta: 0,
            satDelta: 0,
          };
          dragRef.current = ref;
          setDragState({ channelKey, hueDelta: 0, satDelta: 0, isDragging: true });
          setEditor({ isSliderDragging: true });
        } catch (err) {
          if (pendingSampleRef.current?.generation === generation) pendingSampleRef.current = null;
          console.error('Failed to sample color for targeted adjustment:', err);
          toast.error(t('editor.targeted.sampleFailed'));
        }
      })();

      return true;
    },
    [isActive, getCanvasPointer, isInsideImage, getSampleCorners, getSampleAdjustments, adjustments, setEditor, t],
  );

  const handleTargetedMove = useCallback(
    (e: any): boolean => {
      const ref = dragRef.current;
      if (!ref) return false;
      const stage = e?.target?.getStage?.();
      const pos = stage ? getCanvasPointer(stage) : null;
      if (!pos) return true;

      ref.hueDelta = clampChannelDelta((pos.x - ref.startPos.x) * DRAG_SENSITIVITY);
      ref.satDelta = clampChannelDelta(-(pos.y - ref.startPos.y) * DRAG_SENSITIVITY);
      applyChannelDelta(ref);
      setDragState({
        channelKey: ref.channelKey,
        hueDelta: clampChannelDelta(ref.startHue + ref.hueDelta),
        satDelta: clampChannelDelta(ref.startSaturation + ref.satDelta),
        isDragging: true,
      });
      return true;
    },
    [getCanvasPointer, applyChannelDelta],
  );

  const handleTargetedEnd = useCallback((): boolean => {
    const ref = dragRef.current;
    if (!ref) return false;
    dragRef.current = null;
    setEditor({ isSliderDragging: false });
    setDragState((prev) => (prev ? { ...prev, isDragging: false } : null));
    return true;
  }, [setEditor]);

  // Esc：拖动中取消并恢复冻结值；空闲时退出目标模式。
  useEffect(() => {
    if (!isActive) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const ref = dragRef.current;
      if (ref) {
        dragRef.current = null;
        setEditor({ isSliderDragging: false });
        setAdjustments((prev: Adjustments) => {
          const channel = prev.hsl?.[ref.channelKey] || { hue: 0, saturation: 0, luminance: 0 };
          return {
            ...prev,
            hsl: {
              ...prev.hsl,
              [ref.channelKey]: {
                ...channel,
                hue: clampChannelDelta(ref.startHue),
                saturation: clampChannelDelta(ref.startSaturation),
              },
            },
          };
        });
        setDragState(null);
      } else {
        setEditor({ isTargetedAdjustmentActive: false });
        setDragState(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isActive, setEditor, setAdjustments]);

  // 模式退出或图片切换时清理瞬态状态。
  useEffect(() => {
    if (!isActive) {
      dragRef.current = null;
      pendingSampleRef.current = null;
      setDragState(null);
    }
  }, [isActive]);

  return { dragState, handleTargetedStart, handleTargetedMove, handleTargetedEnd };
}
