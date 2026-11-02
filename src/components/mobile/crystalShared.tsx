import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ParseKeys } from 'i18next';
import { Adjustments, getActiveTools, getToolOwnersForKeys, INITIAL_ADJUSTMENTS } from '../../utils/adjustments';
import { useEditorStore } from '../../store/useEditorStore';
import { useEditorActions } from '../../hooks/useEditorActions';

/* --------------------------------------------------------------------------
 * 持久化偏好（水印模板收藏/默认/文案/字体/画质），localStorage 即可，
 * 与桌面 appSettings 解耦，避免 Android 端大对象写入。
 * ------------------------------------------------------------------------ */
export interface CrystalWatermarkPrefs {
  favoriteTemplateId: string | null;
  defaultTemplateId: string | null;
  signature: string;
  fontScale: number;
  savedTemplateId: string | null;
}

const PREFS_KEY = 'crystal.watermark.prefs.v1';

export const DEFAULT_WM_PREFS: CrystalWatermarkPrefs = {
  favoriteTemplateId: null,
  defaultTemplateId: null,
  signature: 'CRYSTAL · 专业摄影',
  fontScale: 4,
  savedTemplateId: null,
};

export function loadWmPrefs(): CrystalWatermarkPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_WM_PREFS };
    return { ...DEFAULT_WM_PREFS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_WM_PREFS };
  }
}

export function useWmPrefs(): [CrystalWatermarkPrefs, (patch: Partial<CrystalWatermarkPrefs>) => void] {
  const [prefs, setPrefs] = useState<CrystalWatermarkPrefs>(() => loadWmPrefs());
  const update = useCallback((patch: Partial<CrystalWatermarkPrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        /* storage full / disabled: keep in-memory */
      }
      return next;
    });
  }, []);
  return [prefs, update];
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
  { id: 'pro', nameKey: 'crystal.templates.pro.name', subKey: 'crystal.templates.pro.sub', exifBar: true, frame: true, signatureAnchor: 'bottomRight', brand: 'CRYSTAL' },
  { id: 'minimal', nameKey: 'crystal.templates.minimal.name', subKey: 'crystal.templates.minimal.sub', exifBar: false, frame: false, signatureAnchor: 'bottomRight', brand: 'CRYSTAL' },
  { id: 'cinema', nameKey: 'crystal.templates.cinema.name', subKey: 'crystal.templates.cinema.sub', exifBar: true, frame: true, signatureAnchor: 'bottomCenter', brand: 'CRYSTAL' },
  { id: 'landscape', nameKey: 'crystal.templates.landscape.name', subKey: 'crystal.templates.landscape.sub', exifBar: false, frame: true, signatureAnchor: 'bottomLeft', brand: 'CRYSTAL' },
  { id: 'street', nameKey: 'crystal.templates.street.name', subKey: 'crystal.templates.street.sub', exifBar: false, frame: false, signatureAnchor: 'bottomLeft', brand: 'CRYSTAL' },
  { id: 'mono', nameKey: 'crystal.templates.mono.name', subKey: 'crystal.templates.mono.sub', exifBar: true, frame: true, signatureAnchor: 'bottomRight', brand: 'CRYSTAL' },
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
}

export function summarizeExif(exif: Record<string, unknown> | null | undefined): ExifSummary {
  const e = exif || {};
  const model = EXIF_STR(e.Model) || EXIF_STR(e.CameraModel) || '';
  const make = EXIF_STR(e.Make) || EXIF_STR(e.CameraMake) || '';
  const camera = [make && !model.includes(make) ? make : '', model].filter(Boolean).join(' ').trim();
  return {
    camera,
    lens: EXIF_STR(e.LensModel) || EXIF_STR(e.LensMake) || '',
    focal: EXIF_STR(e.FocalLength) || EXIF_STR(e.FocalLengthIn35mmFilm) || '',
    aperture: EXIF_STR(e.FNumber) || EXIF_STR(e.ApertureValue) || '',
    shutter: EXIF_STR(e.ExposureTime) || '',
    iso: EXIF_STR(e.PhotographicSensitivity) || EXIF_STR(e.ISOSpeedRatings) || EXIF_STR(e.ISO) || '',
  };
}

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
 * 移动端开关（青绿/金色随 data-flow）
 * ------------------------------------------------------------------------ */
export function CxSwitch({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <button type="button" className="w-full flex items-center justify-between gap-3 bg-transparent border-none p-0" onClick={() => onChange(!checked)}>
      <span className="text-left">
        <span className="cx-frame-label block">{label}</span>
        {hint && <span className="cx-frame-hint block">{hint}</span>}
      </span>
      <span className={`cx-switch ${checked ? 'is-on' : ''}`} role="switch" aria-checked={checked} aria-label={label}>
        <span className="cx-switch-knob" />
      </span>
    </button>
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
        <span className="text-[12.5px] font-semibold flex items-center gap-1.5" style={{ color: changed ? 'var(--cx-accent)' : 'var(--cx-ink)' }}>
          {Number(value).toFixed(step < 1 ? 2 : 0)}
          {suffix ? <i className="not-italic text-[9px]" style={{ color: 'var(--cx-faint)' }}>{suffix}</i> : null}
        </span>
      </div>
      <CrystalRangeSlider min={min} max={max} step={step} value={value} onChange={onChange} onCommit={onCommit} />
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
  onChange,
  onCommit,
}: {
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  onCommit?: () => void;
}) {
  const { t } = useTranslation();
  const frac = max !== min ? (value - min) / (max - min) : 0;
  const zeroFrac = max !== min && min < 0 && max > 0 ? -min / (max - min) : 0;
  const left = Math.min(frac, zeroFrac) * 100;
  const width = Math.abs(frac - zeroFrac) * 100;
  return (
    <div className="relative h-9 flex items-center" onDoubleClick={() => onChange(0)}>
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
        onPointerUp={onCommit}
        className="absolute inset-0 w-full opacity-0 cursor-pointer"
        style={{ height: 36, touchAction: 'none' }}
      />
    </div>
  );
}
