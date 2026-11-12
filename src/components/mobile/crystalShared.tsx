import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ParseKeys } from 'i18next';
import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import {
  Adjustments,
  getActiveTools,
  getToolOwnersForKeys,
  INITIAL_ADJUSTMENTS,
  INITIAL_MASK_CONTAINER,
} from '../../utils/adjustments';
import type { MaskContainer } from '../../utils/adjustments';
import { createSubMask } from '../../utils/maskUtils';
import { Mask } from '../panel/right/Masks';
import type { SubMask } from '../panel/right/Masks';
import { useAiMasking } from '../../hooks/useAiMasking';
import { useEditorStore } from '../../store/useEditorStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useEditorActions, getOriginalAdjustments } from '../../hooks/useEditorActions';

/** 长按阈值（G10：原图按下即看 / 对比稍延迟区分两种手势） */
export const CRYSTAL_LONG_PRESS_MS = 450;

/* --------------------------------------------------------------------------
 * D-CP-01/P0 沉浸式裁剪共享态（构图面板入口 ↔ 编辑壳全屏响应 的固定契约）。
 * 调用方契约：{ active, enter, exit } ——
 *   enter(): 进入沉浸态，记录进入前快照（所选图路径标识 + 完整 adjustments，
 *            含 crop/aspectRatio），供「取消」整体回滚；
 *   exit():  退出沉浸态（仅清除 active/快照，不回滚——回滚是取消动作的职责）。
 * snapshot 为壳层（CrystalMobileApp）内部消费字段，构图面板无需感知。
 * ------------------------------------------------------------------------ */
export interface ImmersiveCropSnapshot {
  /** 进入时快照标识（所选图路径）：切图后取消不回写他图参数 */
  imagePath: string | null;
  /** 进入前完整 adjustments，取消时整体还原 */
  adjustments: Adjustments;
}

interface ImmersiveCropState {
  active: boolean;
  snapshot: ImmersiveCropSnapshot | null;
  enter: () => void;
  exit: () => void;
}

export const useImmersiveCropStore = create<ImmersiveCropState>()((set, get) => ({
  active: false,
  snapshot: null,
  enter: () => {
    if (get().active) return;
    const { selectedImage, adjustments } = useEditorStore.getState();
    set({ active: true, snapshot: { imagePath: selectedImage?.path ?? null, adjustments } });
  },
  exit: () => set({ active: false, snapshot: null }),
}));

/* --------------------------------------------------------------------------
 * 持久化偏好（水印模板收藏/默认/文案/字体/画质/导出格式）。
 * G-5（v2.1.22 审计）：v2.1.22 只写 WebView localStorage，系统清理缓存即丢。
 * 现升级为随桌面 settings.json（appSettings.crystalWatermarkPrefs）持久化：
 *  - 首次运行把旧 localStorage 数据一次性迁移进 settings；
 *  - settings 未就绪/缺失时回退读 localStorage（保证冷启动即时可用）；
 *  - 仍镜像写 localStorage，便于回滚与旧版本兼容。
 * ------------------------------------------------------------------------ */
export type CrystalWatermarkPrefs = {
  favoriteTemplateId: string | null;
  defaultTemplateId: string | null;
  signature: string;
  fontScale: number;
  /** G19 字体族：builtin = 内嵌 DejaVu；system = 系统字体（后端加载失败回落 builtin） */
  fontFamily: 'builtin' | 'system';
  savedTemplateId: string | null;
  /** 导出文件名后缀（默认 _crystal，可编辑；非法字符在导出时清洗） */
  filenameSuffix: string;
  /** E-5：导出格式/画质与信息栏描边随偏好持久化 */
  exportFormat?: 'jpeg' | 'png';
  exportQuality?: number;
  showInfoBarFrame?: boolean;
}

const PREFS_KEY = 'crystal.watermark.prefs.v1';

export const DEFAULT_WM_PREFS: CrystalWatermarkPrefs = {
  favoriteTemplateId: null,
  defaultTemplateId: null,
  signature: 'CRYSTAL · 专业摄影',
  fontScale: 4,
  fontFamily: 'builtin',
  savedTemplateId: null,
  filenameSuffix: '_crystal',
  exportFormat: 'jpeg',
  exportQuality: 100,
  showInfoBarFrame: true,
};

/** 轻量触觉反馈（Android WebView 支持 navigator.vibrate；其余平台静默忽略） */
export const haptic = (pattern: number | number[] = 8) => {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* 不支持触觉的设备：静默 */
  }
};

/** 旧版（v2.1.22-）数据源：localStorage。仅作迁移源与回退读取。 */
export function loadWmPrefs(): CrystalWatermarkPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_WM_PREFS };
    return { ...DEFAULT_WM_PREFS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_WM_PREFS };
  }
}

/** 写穿 localStorage（镜像，兼容旧版回滚），失败静默。 */
function mirrorWmPrefsToStorage(prefs: CrystalWatermarkPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* storage full / disabled: keep in settings.json only */
  }
}

export function useWmPrefs(): [CrystalWatermarkPrefs, (patch: Partial<CrystalWatermarkPrefs>) => void] {
  const appSettings = useSettingsStore((s) => s.appSettings);
  const stored = appSettings?.crystalWatermarkPrefs as CrystalWatermarkPrefs | undefined;

  // settings 未就绪时以 localStorage 快照兜底；该快照在首帧同步读取一次。
  const fallbackRef = useRef<CrystalWatermarkPrefs | null>(null);
  if (fallbackRef.current === null) fallbackRef.current = loadWmPrefs();
  const migratedRef = useRef(false);

  // 一次性迁移：settings 就绪且尚无水印偏好时，把 localStorage 旧值写入 settings。
  useEffect(() => {
    if (!appSettings || stored || migratedRef.current) return;
    migratedRef.current = true;
    const legacy = fallbackRef.current;
    if (legacy && JSON.stringify(legacy) !== JSON.stringify(DEFAULT_WM_PREFS)) {
      mirrorWmPrefsToSettings(legacy);
    }
  }, [appSettings, stored]);

  const latestRef = useRef<CrystalWatermarkPrefs>(stored ? { ...DEFAULT_WM_PREFS, ...stored } : fallbackRef.current!);
  latestRef.current = stored ? { ...DEFAULT_WM_PREFS, ...stored } : fallbackRef.current!;

  const update = useCallback((patch: Partial<CrystalWatermarkPrefs>) => {
    const next = { ...latestRef.current, ...patch };
    mirrorWmPrefsToStorage(next);
    mirrorWmPrefsToSettings(next);
  }, []);

  return [latestRef.current, update];
}

/** 写入 appSettings.crystalWatermarkPrefs 并走既有 SaveSettings 管线落盘。 */
function mirrorWmPrefsToSettings(prefs: CrystalWatermarkPrefs): void {
  const { appSettings, handleSettingsChange } = useSettingsStore.getState();
  if (!appSettings) return; // settings 未加载（启动早期）：仅 localStorage 镜像生效
  void handleSettingsChange({ ...appSettings, crystalWatermarkPrefs: prefs });
}

/* --------------------------------------------------------------------------
 * 六款水印模板：名称/副题 + 可映射到真实导出参数的组合
 * （textWatermark + border 相框 + 签名锚点）。导出时 buildExportSettings
 * 将模板转译为 ExportSettings；EXIF 信息栏烧录走 exif_frame（后端）。
 * ------------------------------------------------------------------------ */
export interface WatermarkTemplate {
  id: string;
  nameKey: ParseKeys;
  subKey: ParseKeys;
  /** 信息栏白条（相机参数） */
  exifBar: boolean;
  /** 底部相框 */
  frame: boolean;
  /** 签名水印锚点（null = 不加签名） */
  signatureAnchor: 'bottomRight' | 'bottomCenter' | 'bottomLeft' | 'topLeft' | null;
  /** 白条内品牌名 */
  brand: string;
}

export const WATERMARK_TEMPLATES: Array<WatermarkTemplate> = [
  {
    id: 'pro',
    nameKey: 'crystal.templates.pro.name',
    subKey: 'crystal.templates.pro.sub',
    exifBar: true,
    frame: true,
    signatureAnchor: 'bottomRight',
    brand: 'CRYSTAL',
  },
  {
    id: 'minimal',
    nameKey: 'crystal.templates.minimal.name',
    subKey: 'crystal.templates.minimal.sub',
    exifBar: false,
    frame: false,
    signatureAnchor: 'bottomRight',
    brand: 'CRYSTAL',
  },
  {
    id: 'cinema',
    nameKey: 'crystal.templates.cinema.name',
    subKey: 'crystal.templates.cinema.sub',
    exifBar: true,
    frame: true,
    signatureAnchor: 'bottomCenter',
    brand: 'CRYSTAL',
  },
  {
    id: 'landscape',
    nameKey: 'crystal.templates.landscape.name',
    subKey: 'crystal.templates.landscape.sub',
    exifBar: false,
    frame: true,
    signatureAnchor: 'bottomLeft',
    brand: 'CRYSTAL',
  },
  {
    id: 'street',
    nameKey: 'crystal.templates.street.name',
    subKey: 'crystal.templates.street.sub',
    exifBar: false,
    frame: false,
    signatureAnchor: 'bottomLeft',
    brand: 'CRYSTAL',
  },
  {
    id: 'mono',
    nameKey: 'crystal.templates.mono.name',
    subKey: 'crystal.templates.mono.sub',
    exifBar: true,
    frame: true,
    signatureAnchor: 'bottomRight',
    brand: 'CRYSTAL',
  },
];

/* --------------------------------------------------------------------------
 * EXIF 单行摘要：机型 | 品牌 | 焦距 光圈 快门 ISO
 * 与设计稿「E-M10MarkIV │ CRYSTAL │ 38mm f/5.6 1/200s ISO 200」同构。
 * 数据源：selectedImage.exif（后端 kamadak-exif 真实读取）。
 * ------------------------------------------------------------------------ */
const EXIF_STR = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

export interface ExifSummary {
  camera: string;
  lens: string;
  focal: string;
  aperture: string;
  shutter: string;
  iso: string;
  /** 拍摄时间（G14/W4-2：无机型时的信息栏兜底文案） */
  taken: string;
}

export function summarizeExif(exif: Record<string, unknown> | null | undefined): ExifSummary {
  const e = exif || {};
  const model = EXIF_STR(e.Model) || EXIF_STR(e.CameraModel) || '';
  const make = EXIF_STR(e.Make) || EXIF_STR(e.CameraMake) || '';
  const camera = [make && !model.includes(make) ? make : '', model].filter(Boolean).join(' ').trim();
  return {
    camera,
    lens: EXIF_STR(e.LensModel) || EXIF_STR(e.LensMake) || '',
    // EX-1（v2.1.22 审计）：与后端烧录格式对齐（export_processing::apply_exif_frame），
    // 保证「所见即所得」——焦距补 mm、快门去掉 "1/200 s" 中的空格。
    focal: formatFocal(EXIF_STR(e.FocalLength) || EXIF_STR(e.FocalLengthIn35mmFilm)),
    aperture: EXIF_STR(e.FNumber) || EXIF_STR(e.ApertureValue) || '',
    shutter: formatShutter(EXIF_STR(e.ExposureTime)),
    iso: EXIF_STR(e.PhotographicSensitivity) || EXIF_STR(e.ISOSpeedRatings) || EXIF_STR(e.ISO) || '',
    taken: EXIF_STR(e.DateTimeOriginal) || EXIF_STR(e.CreateDate) || EXIF_STR(e.DateTime) || '',
  };
}

/** "38" / "38.5" → "38mm" / "38.5mm"；已带单位或非数值原样返回（与后端一致）。 */
function formatFocal(v: string): string {
  if (!v) return '';
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return v;
  return `${n % 1 === 0 ? n.toFixed(0) : n.toFixed(1)}mm`;
}

/** "1/200 s" → "1/200s"；后端烧录时会替换掉 " s"，预览需同步。 */
function formatShutter(v: string): string {
  return v ? v.replace(/\s*s$/i, 's') : '';
}

/* --------------------------------------------------------------------------
 * C-1（v2.1.22 审计）：构图比例芯片高亮匹配。
 * rotate90 会把 aspectRatio 取倒数（4:3 → 3:4），而芯片表只登记正向值，
 * 高亮判断必须先精确匹配、再按倒数匹配（1:1 是自倒数，需排除避免歧义）。
 * 修正此前「先扫倒数」导致 9:16 竖构图高亮跳到 16:9 的错误。
 * ------------------------------------------------------------------------ */
export function matchAspectChip(
  chips: { value: number | null }[],
  ratio: number | null | undefined,
): number | null | undefined {
  if (!ratio) return ratio === null ? null : undefined;
  const exact = chips.find((c) => c.value != null && Math.abs(c.value - ratio) < 0.01);
  if (exact) return exact.value;
  const inverse = chips.find(
    (c) => c.value != null && Math.abs(c.value - 1) > 0.01 && Math.abs(1 / c.value - ratio) < 0.01,
  );
  return inverse ? inverse.value : ratio;
}

/* --------------------------------------------------------------------------
 * 等待后端图片加载完成（isReady）：ai_auto_enhance / calculate_auto_adjustments
 * 均以 state.original_image 为输入，未就绪时调用会抛 "No image loaded"
 * （或由 hook 内 isReady 守卫静默 return）。与 useEditorActions.waitForImageReady
 * 同模式（subscribe 等待），补 10s 超时防加载失败时 busy 蒙层永久挂起。
 * ------------------------------------------------------------------------ */
export const awaitImageReady = (path: string, timeoutMs = 10_000) =>
  new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const unsubscribe = useEditorStore.subscribe((state) => {
      if (state.selectedImage?.path !== path) {
        finish(false);
      } else if (state.selectedImage.isReady) {
        finish(true);
      }
    });
  });

/* --------------------------------------------------------------------------
 * 调整写入工具：所有移动面板统一走这里，保证 pushHistory（50步撤销栈）
 * 与 owning tools 激活语义与桌面面板一致。
 * ------------------------------------------------------------------------ */
export function useCrystalAdjust() {
  const { setAdjustments } = useEditorActions();

  const applyPatch = useCallback(
    (patch: Partial<Adjustments>, opts?: { enableTools?: boolean }) => {
      const prev = useEditorStore.getState().adjustments;
      const keys = Object.keys(patch).filter(
        (key) =>
          JSON.stringify((patch as Record<string, unknown>)[key]) !==
          JSON.stringify((INITIAL_ADJUSTMENTS as Record<string, unknown>)[key]),
      );
      const tools = opts?.enableTools === false ? [] : getToolOwnersForKeys(keys);
      setAdjustments({
        ...prev,
        ...patch,
        ...(tools.length
          ? { activeTools: { ...getActiveTools(prev), ...Object.fromEntries(tools.map((id) => [id, true])) } }
          : {}),
      } as Adjustments);
    },
    [setAdjustments],
  );

  const applyPresetObject = useCallback(
    (presetAdjustments: Record<string, unknown>) => {
      const prev = useEditorStore.getState().adjustments;
      const keys = Object.keys(presetAdjustments).filter((key) => {
        if (key === 'masks') return false;
        return (
          JSON.stringify(presetAdjustments[key]) !==
          JSON.stringify((INITIAL_ADJUSTMENTS as Record<string, unknown>)[key])
        );
      });
      const tools = getToolOwnersForKeys(keys);
      setAdjustments({
        ...prev,
        ...presetAdjustments,
        ...(tools.length
          ? { activeTools: { ...getActiveTools(prev), ...Object.fromEntries(tools.map((id) => [id, true])) } }
          : {}),
      } as Adjustments);
    },
    [setAdjustments],
  );

  return { applyPatch, applyPresetObject, setAdjustments };
}

/* --------------------------------------------------------------------------
 * 按住看原图手势（G10/G11）：底栏原图/对比键与预览浮层共用。
 * showDelayMs=0 立即显示（原图键），>0 用于区分点击与按住（对比键）。
 *
 * 审计修复（底栏-原图）：仅置 showOriginal=true 时 CrystalPreview 依赖的
 * originalPreview 恒为 null（renderOriginal 仅在 compareView!=='off' 时产出），
 * 长按只会得到空 url + 加载动画。此处与桌面 toggle 对比一致：同时写入
 * previewOverride=getOriginalAdjustments，让主管线把"原图参数"渲染进
 * finalPreviewUrl（保留裁剪/旋转几何以对齐取景），松手即还原。
 * ------------------------------------------------------------------------ */
export function useShowOriginalHold(showDelayMs = 0) {
  const setEditor = useEditorStore((s) => s.setEditor);
  const holdTimer = useRef<number | null>(null);
  const holdActive = useRef(false);

  const start = useCallback(() => {
    // P-3（v2.1.22 审计）：多点触控时 start 会被再次调用，旧计时器若不清理，
    // 其引用被覆盖后永远无法取消——第一根手指的计时器仍会触发，把预览
    // 永久钉在原图态。进入新按压前先取消任何在途计时器。
    if (holdTimer.current !== null) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    holdTimer.current = window.setTimeout(() => {
      holdActive.current = true;
      haptic(5);
      setEditor({
        showOriginal: true,
        previewOverride: getOriginalAdjustments(useEditorStore.getState().adjustments),
      });
    }, showDelayMs);
  }, [setEditor, showDelayMs]);

  const end = useCallback(() => {
    if (holdTimer.current !== null) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    if (holdActive.current) {
      holdActive.current = false;
      setEditor({ showOriginal: false, previewOverride: null });
    }
  }, [setEditor]);

  useEffect(
    () => () => {
      if (holdTimer.current !== null) clearTimeout(holdTimer.current);
      // 卸载时若长按已生效（如多点触控切换流程导致卸载），需复位 showOriginal，
      // 避免 store 残留 true 使预览误显原图。
      if (holdActive.current) {
        holdActive.current = false;
        useEditorStore.getState().setEditor({ showOriginal: false, previewOverride: null });
      }
    },
    [],
  );

  return {
    onPointerDown: start,
    onPointerUp: end,
    onPointerLeave: end,
    onPointerCancel: end,
  };
}

/* --------------------------------------------------------------------------
 * 移动端开关（青绿/金色随 data-flow）
 * ------------------------------------------------------------------------ */
export function CxSwitch({
  checked,
  onChange,
  label,
  hint,
  disabled,
  labelHidden,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
  /** 行容器已自带 label/hint 时隐藏开关内部文案（aria-label 仍保留），避免重复 */
  labelHidden?: boolean;
}) {
  return (
    <button
      type="button"
      className={`w-full flex items-center justify-between gap-3 bg-transparent border-none p-0${disabled ? ' opacity-50' : ''}`}
      onClick={() => {
        haptic(6);
        onChange(!checked);
      }}
      disabled={disabled}
    >
      {!labelHidden && (
        <span className="text-left">
          <span className="cx-frame-label block">{label}</span>
          {hint && <span className="cx-frame-hint block">{hint}</span>}
        </span>
      )}
      <span className={`cx-switch ${checked ? 'is-on' : ''}`} role="switch" aria-checked={checked} aria-label={label}>
        <span className="cx-switch-knob" />
      </span>
    </button>
  );
}

/* --------------------------------------------------------------------------
 * 移动端子分区标题（特效等面板内的分组）
 * ------------------------------------------------------------------------ */
export function CxSubSection({ labelKey, children }: { labelKey: ParseKeys; children: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="cx-subsection">
      <div className="cx-subsection-title">{t(labelKey)}</div>
      {children}
    </div>
  );
}

/* --------------------------------------------------------------------------
 * 移动端滑杆行：label + 当前值/默认值双标记，点数值输入（复用全局 Slider）
 * ------------------------------------------------------------------------ */
export function CxSliderRow({
  label,
  min,
  max,
  step,
  value,
  defaultValue = 0,
  suffix,
  onChange,
  onCommit,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  defaultValue?: number;
  suffix?: string;
  onChange: (v: number) => void;
  onCommit?: () => void;
}) {
  const changed = Math.abs(value - defaultValue) > 1e-9;
  return (
    <div className="crystal-slider-row" data-dirty={changed ? '1' : '0'}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[12.5px] font-medium" style={{ color: 'var(--cx-muted)' }}>
          {label}
        </span>
        <span
          className="text-[12.5px] font-semibold flex items-center gap-1.5"
          style={{ color: changed ? 'var(--cx-accent)' : 'var(--cx-ink)' }}
        >
          {/* 审计 C-精度：小数位随步进收敛——0.5 步进显示 3.5 而非 3.50，0.05 步进保留 2 位 */}
          {Number(value).toFixed(step >= 1 ? 0 : step >= 0.1 ? 1 : 2)}
          {suffix ? (
            <i className="not-italic text-[9px]" style={{ color: 'var(--cx-faint)' }}>
              {suffix}
            </i>
          ) : null}
        </span>
      </div>
      <CrystalRangeSlider
        min={min}
        max={max}
        step={step}
        value={value}
        defaultValue={defaultValue}
        onChange={onChange}
        onCommit={onCommit}
      />
    </div>
  );
}

/**
 * 轻量 range 滑杆（触屏优先，thumb 44px 触达）。
 * 独立实现而非复用全局 Slider：移动皮肤需要金色填充 + 大触点 + 拖动即改。
 */
function CrystalRangeSlider({
  min,
  max,
  step,
  value,
  defaultValue,
  onChange,
  onCommit,
}: {
  min: number;
  max: number;
  step: number;
  value: number;
  defaultValue?: number;
  onChange: (v: number) => void;
  onCommit?: () => void;
}) {
  const { t } = useTranslation();
  const frac = max !== min ? (value - min) / (max - min) : 0;
  // SL-2（v2.1.22 审计）：零点分式须覆盖三种区间——
  //   全负区间（max<=0）：零点在右端之外，取 1（填充条贴右端）；
  //   跨零区间（min<0<max）：-min/(max-min)；
  //   全正区间（min>=0）：0。
  // 旧写法在全负区间恒取 0，负值滑杆的填充条起点错位。
  const zeroFrac = max !== min ? (min < 0 && max > 0 ? -min / (max - min) : max <= 0 ? 1 : 0) : 0;
  const left = Math.min(frac, zeroFrac) * 100;
  const width = Math.abs(frac - zeroFrac) * 100;
  /* 触摸滚动修复（调色-上滑阻力）：滑杆输入层此前 touchAction:'none'，
   * 而 36px 高的全宽隐形 input 几乎铺满调色/特效/人像等面板——纵向滑动
   * 落在滑杆上时被完全吞掉（还会误拖数值），面板"很难向上滑"。
   * 改为 pan-y：浏览器轴向仲裁——横向拖动调值、纵向滑动滚动面板，
   * 与桌面 Slider 空闲态（pan-y）语义一致。配套：轴向判定前几像素的
   * 斜向漂移可能误改值，pointercancel（浏览器接管滚动）时恢复按下时的值。 */
  const dragStartValue = useRef<number | null>(null);
  return (
    /* 自检修复（预设-强度滑杆）：双击复位此前硬编码归 0——强度滑杆（默认
     * 100）、AI 蒙版强度（50）、深度远近（20/80）、AI 降噪量（100）等非零
     * 默认值滑杆双击会瞬间打到 0 而非复位默认值。改为复位到 defaultValue
     * （未传时回落 0，与既有调整量滑杆行为一致）。
     * SL-1（v2.1.22 审计）：容器层补 touch-action: manipulation——
     * 关闭 300ms 双击缩放仲裁后，移动端双击才能稳定产生 dblclick 事件，
     * 且不会与页面级双击缩放互相冲突（输入层 pan-y 只管轴向仲裁）。 */
    <div
      className="relative h-9 flex items-center"
      style={{ touchAction: 'manipulation' }}
      onDoubleClick={() => onChange(defaultValue ?? 0)}
    >
      <div className="absolute left-0 right-0 h-1.5 rounded-full" style={{ background: 'var(--cx-card2)' }} />
      <div
        className="absolute h-1.5 rounded-full"
        style={{ left: `${left}%`, width: `${width}%`, background: 'var(--cx-accent)' }}
      />
      <div
        className="absolute rounded-full pointer-events-none"
        style={{
          left: `calc(${frac * 100}% - 9px)`,
          width: 18,
          height: 18,
          background: 'var(--cx-accent)',
          boxShadow: '0 0 0 3px rgba(0,0,0,0.55)',
        }}
      />
      <input
        type="range"
        aria-label={t('ui.slider.clickToEdit')}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerDown={() => {
          dragStartValue.current = value;
        }}
        onPointerUp={() => {
          dragStartValue.current = null;
          onCommit?.();
        }}
        onPointerCancel={() => {
          if (dragStartValue.current !== null && Number(value) !== dragStartValue.current) {
            onChange(dragStartValue.current);
          }
          dragStartValue.current = null;
        }}
        className="absolute inset-0 w-full opacity-0 cursor-pointer"
        style={{ height: 36, touchAction: 'pan-y' }}
      />
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * 边界计划 P1/P2：移动端复用桌面 AI 蒙版链路的最小封装。
 * 数据流与桌面 MasksPanel 同源：ensure 容器（Mask.AiFace/AiSky/AiForeground）
 * → useAiMasking 生成蒙版参数 → updateSubMask 合并 → 容器级 MaskAdjustments
 * 提供局部调整（clarity/exposure 等），全链路真实管线，无伪造。
 * ------------------------------------------------------------------------- */
type AiContainer = MaskContainer & { subMasks: Array<SubMask> };

export function useCrystalAiMasks() {
  const { handleGenerateAiFaceMask, handleGenerateAiSkyMask, handleGenerateAiForegroundMask } = useAiMasking();
  const { setAdjustments } = useEditorActions();

  const findContainer = useCallback((type: Mask): AiContainer | null => {
    const { adjustments } = useEditorStore.getState();
    return (
      (adjustments.masks || []).find((c: MaskContainer) => c.subMasks.some((sm: SubMask) => sm.type === type)) || null
    );
  }, []);

  const ensureContainer = useCallback(
    (type: Mask, parameters?: Record<string, unknown>): AiContainer | null => {
      const existing = findContainer(type);
      if (existing) return existing;
      const { selectedImage } = useEditorStore.getState();
      // PT-3（v2.1.22 审计）：图片尺寸缺失时绝不以 1000×1000 兜底创建容器——
      // 蒙版坐标空间会与真实图像错位，后续生成/应用全部失真。调用方
      // （CrystalAiToolsPanel / 液化入口）对 null 做提示并中止流程。
      if (!selectedImage?.width || !selectedImage?.height) return null;
      const subMask = createSubMask(type, {
        width: selectedImage.width,
        height: selectedImage.height,
      });
      if (parameters) subMask.parameters = { ...subMask.parameters, ...parameters };
      const container: AiContainer = {
        ...INITIAL_MASK_CONTAINER,
        id: uuidv4(),
        name: subMask.name || type,
        subMasks: [subMask],
      };
      setAdjustments((prev) => ({ ...prev, masks: [...(prev.masks || []), container] }));
      return container;
    },
    [findContainer, setAdjustments],
  );

  // 局部调整写入容器级 MaskAdjustments（与桌面滑杆写法一致）
  const setMaskAdjustments = useCallback(
    (containerId: string, patch: Record<string, unknown>) => {
      setAdjustments((prev) => ({
        ...prev,
        masks: (prev.masks || []).map((c: MaskContainer) =>
          c.id === containerId ? { ...c, adjustments: { ...c.adjustments, ...patch } } : c,
        ),
      }));
    },
    [setAdjustments],
  );

  // 按精修算子 kind 查找容器（与桌面 parameters.retouchKind 约定同源），
  // 使磨皮/牙齿/眼部多个 AiFace 容器可并存互不覆盖。
  const findContainerByKind = useCallback((kind: string): AiContainer | null => {
    const { adjustments } = useEditorStore.getState();
    return (
      (adjustments.masks || []).find((c: MaskContainer) => c.subMasks[0]?.parameters?.retouchKind === kind) || null
    );
  }, []);

  const removeContainerByKind = useCallback(
    (kind: string) => {
      const container = findContainerByKind(kind);
      if (!container) return;
      setAdjustments((prev) => ({ ...prev, masks: (prev.masks || []).filter((c) => c.id !== container.id) }));
    },
    [findContainerByKind, setAdjustments],
  );

  // 写入 subMask.parameters（retouch 强度 / liquify 美型值等），与桌面存储位置一致
  const updateSubMaskParameters = useCallback(
    (containerId: string, subMaskId: string, patch: Record<string, unknown>) => {
      setAdjustments((prev) => ({
        ...prev,
        masks: (prev.masks || []).map((c: MaskContainer) =>
          c.id === containerId
            ? {
                ...c,
                subMasks: c.subMasks.map((sm: SubMask) =>
                  sm.id === subMaskId ? { ...sm, parameters: { ...sm.parameters, ...patch } } : sm,
                ),
              }
            : c,
        ),
      }));
    },
    [setAdjustments],
  );

  // 蒙版生成成功的判定：后端已把 maskDataBase64 写入 subMask 参数。
  // PT-1（v2.1.22 审计）：findContainer 用 .some 匹配任意子蒙版，这里却只看
  // subMasks[0]——多子蒙版容器（如桌面导入数据）会误报未就绪。统一按
  // 「匹配类型且带位图」的子蒙版判定，与 findContainer 口径一致。
  const maskReady = useCallback(
    (type: Mask) => {
      const container = findContainer(type);
      return Boolean(
        container?.subMasks.some((sm: SubMask) => sm.type === type && sm.parameters?.maskDataBase64),
      );
    },
    [findContainer],
  );

  // 移除整个蒙版容器：蒙版类功能「可识别 → 可调 → 可移除」闭环
  const removeContainer = useCallback(
    (type: Mask) => {
      const container = findContainer(type);
      if (!container) return;
      setAdjustments((prev) => ({ ...prev, masks: (prev.masks || []).filter((c) => c.id !== container.id) }));
    },
    [findContainer, setAdjustments],
  );

  /* 美型（liquify）专用宿主：与磨皮/牙齿/眼部算子容器隔离。
   * 若挂在算子容器上，移除该算子会连带清掉美型值与补丁（滑杆静默归零、效果消失）。
   * 选取顺序（PT-2，v2.1.22 审计）：显式 isLiquifyHost 标记的容器（新数据，
   * 精确复用宿主，避免「美型调回 0 后再次拖动又新建宿主」的堆积）→
   * 已承载 liquify 值的 AiFace 容器（兼容旧数据）→ 无 retouchKind 的
   * AiFace 容器 → null（由 createLiquifyHost 新建独立容器并打标记）。 */
  const findLiquifyHost = useCallback((): AiContainer | null => {
    const { adjustments } = useEditorStore.getState();
    const aiFaces = (adjustments.masks || []).filter((c: MaskContainer) =>
      c.subMasks.some((sm: SubMask) => sm.type === Mask.AiFace),
    );
    const marked = aiFaces.find((c: MaskContainer) => c.subMasks[0]?.parameters?.isLiquifyHost === true);
    if (marked) return marked;
    const holder = aiFaces.find((c: MaskContainer) => {
      const liq = c.subMasks[0]?.parameters?.liquify as { slimFace?: number; jawline?: number } | undefined;
      return Boolean(liq && ((liq.slimFace ?? 0) > 0 || (liq.jawline ?? 0) > 0));
    });
    if (holder) return holder;
    return aiFaces.find((c: MaskContainer) => !c.subMasks[0]?.parameters?.retouchKind) ?? null;
  }, []);

  /* 新建独立美型宿主：parts=faceSkin，不参与任何算子开关，也不触发表情识别
   * （人脸液化补丁由后端 generate_face_liquify_patch 自行定位人脸，不依赖蒙版数据）。
   * PT-3（v2.1.22 审计）：图片尺寸缺失时返回 null，绝不以 1000×1000 兜底。 */
  const createLiquifyHost = useCallback((): AiContainer | null => {
    const { selectedImage } = useEditorStore.getState();
    if (!selectedImage?.width || !selectedImage?.height) return null;
    const subMask = createSubMask(Mask.AiFace, {
      width: selectedImage.width,
      height: selectedImage.height,
    });
    // PT-2：显式宿主标记，供 findLiquifyHost 精确复用（值归零后仍认领同一容器）。
    subMask.parameters = { ...subMask.parameters, parts: ['faceSkin'], isLiquifyHost: true };
    const container: AiContainer = {
      ...INITIAL_MASK_CONTAINER,
      id: uuidv4(),
      name: subMask.name || Mask.AiFace,
      subMasks: [subMask],
    };
    setAdjustments((prev) => ({ ...prev, masks: [...(prev.masks || []), container] }));
    return container;
  }, [setAdjustments]);

  return {
    handleGenerateAiFaceMask,
    handleGenerateAiSkyMask,
    handleGenerateAiForegroundMask,
    findContainer,
    ensureContainer,
    findContainerByKind,
    removeContainerByKind,
    updateSubMaskParameters,
    setMaskAdjustments,
    maskReady,
    removeContainer,
    findLiquifyHost,
    createLiquifyHost,
  };
}
