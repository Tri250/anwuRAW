import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import {
  Brush,
  CircleDotDashed,
  Check,
  Eraser,
  Eye,
  EyeOff,
  FlipHorizontal2,
  Feather,
  Trash2,
  Wrench,
} from 'lucide-react';
import clsx from 'clsx';
import { Mask, SubMask, ToolType, getSubMaskName } from '../right/Masks';
import { BrushSettings } from '../../ui/AppProperties';

/** 画布上进入"蒙版/修复编辑工具条"会话的类型 */
const TOOLBAR_VISIBLE_TYPES: Mask[] = [
  Mask.Brush,
  Mask.Flow,
  Mask.QuickEraser,
  Mask.Linear,
  Mask.Radial,
  Mask.Color,
  Mask.Luminance,
  Mask.Clone,
  Mask.Heal,
  Mask.AutoErase,
  Mask.Liquify,
  Mask.Retouch,
];

/** 这些类型支持画笔 / 橡皮切换 */
const BRUSH_TOOL_TYPES: Mask[] = [
  Mask.Brush,
  Mask.Flow,
  Mask.QuickEraser,
  Mask.Clone,
  Mask.Heal,
  Mask.AutoErase,
  Mask.Liquify,
  Mask.Retouch,
];

/** 独立修复/修饰类型（无"反选/清除蒙版"语义，但可用强度滑杆） */
const STANDALONE_REPAIR: Mask[] = [Mask.Clone, Mask.Heal, Mask.AutoErase, Mask.Liquify, Mask.Retouch];

/** 有强度/压力/灵敏度滑杆的类型 → 参数键 */
const STRENGTH_PARAM_KEY = (type: Mask) =>
  type === Mask.Liquify
    ? 'pressure'
    : type === Mask.Retouch
      ? 'intensity'
      : type === Mask.AutoErase
        ? 'sensitivity'
        : null;

/** 这些类型支持"清除蒙版"（会清空其可编辑内容） */
const CLEAR_TYPES: Mask[] = [
  Mask.Brush,
  Mask.Flow,
  Mask.QuickEraser,
  Mask.Color,
  Mask.Luminance,
  Mask.AiSubject,
  Mask.AiForeground,
];

interface MaskEditingToolbarProps {
  subMask: SubMask;
  brushSettings: BrushSettings | null;
  maskOverlayVisible: boolean;
  onBrushToolChange: (tool: ToolType) => void;
  onBrushSettingsChange: (settings: Partial<BrushSettings>) => void;
  onStrengthChange: (value: number) => void;
  onToggleOverlay: () => void;
  onInvert: () => void;
  onClear: () => void;
  onDone: () => void;
}

export function showMaskEditingToolbar(subMask: SubMask | null | undefined): boolean {
  return !!subMask && TOOLBAR_VISIBLE_TYPES.includes(subMask.type);
}

export default function MaskEditingToolbar({
  subMask,
  brushSettings,
  maskOverlayVisible,
  onBrushToolChange,
  onBrushSettingsChange,
  onStrengthChange,
  onToggleOverlay,
  onInvert,
  onClear,
  onDone,
}: MaskEditingToolbarProps) {
  const { t } = useTranslation();
  const showBrushTool = BRUSH_TOOL_TYPES.includes(subMask.type);
  const isStandalone = STANDALONE_REPAIR.includes(subMask.type);
  const activeTool = brushSettings?.tool ?? ToolType.Brush;

  const brushSize = brushSettings?.size ?? 50;
  const brushFeather = brushSettings?.feather ?? 50;

  const strengthKey = STRENGTH_PARAM_KEY(subMask.type);
  const strengthValue = strengthKey
    ? Number((subMask.parameters as Record<string, unknown>)?.[strengthKey] ?? 40) || 0
    : null;

  const buttonBase =
    'flex h-9 min-w-9 items-center justify-center gap-1.5 rounded-lg px-2.5 text-sm font-medium transition-colors';

  const iconButton = (active = false) =>
    clsx(
      buttonBase,
      active ? 'bg-accent text-white' : 'text-text-secondary hover:bg-card-active hover:text-text-primary',
    );

  /** 紧凑的滑杆控件（笔刷大小 / 柔软度 / 强度） */
  const rangeControl = (
    icon: React.ReactNode,
    label: string,
    value: number,
    onChange: (v: number) => void,
    max = 100,
  ) => (
    <label className="flex items-center gap-2 rounded-lg px-2 text-sm font-medium text-text-secondary" title={label}>
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">{icon}</span>
      <input
        className="h-1 w-20 accent-accent slider-input"
        type="range"
        min={1}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="w-7 min-w-7 shrink-0 text-right tabular-nums text-text-primary">{value}</span>
    </label>
  );

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 12, scale: 0.96 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
        className="pointer-events-auto mx-auto flex max-w-[calc(100vw-2rem)] items-center gap-1 overflow-x-auto rounded-xl border border-border-color bg-bg-secondary/90 p-1.5 shadow-[0_8px_30px_rgba(0,0,0,0.35)] backdrop-blur-md no-scrollbar"
      >
        <span className="px-2 text-xs font-semibold uppercase tracking-wider text-text-secondary">
          {t('editor.masks.toolbar.title')}
          <span className="ml-1.5 normal-case text-text-primary">{getSubMaskName(subMask)}</span>
        </span>

        <div className="mx-1 h-5 w-px bg-border-color" />

        {showBrushTool ? (
          <>
            <button
              className={iconButton(activeTool === ToolType.Brush)}
              onClick={() => onBrushToolChange(ToolType.Brush)}
              title={t('editor.masks.brush.brush')}
            >
              <Brush size={16} />
              <span className="hidden sm:inline">{t('editor.masks.brush.brush')}</span>
            </button>
            <button
              className={iconButton(activeTool === ToolType.Eraser)}
              onClick={() => onBrushToolChange(ToolType.Eraser)}
              title={t('editor.masks.brush.eraser')}
            >
              <Eraser size={16} />
              <span className="hidden sm:inline">{t('editor.masks.brush.eraser')}</span>
            </button>
            <div className="mx-1 h-5 w-px bg-border-color" />
          </>
        ) : null}

        {showBrushTool ? (
          <>
            {rangeControl(
              <CircleDotDashed size={15} />,
              t('editor.masks.toolbar.brushSize'),
              brushSize,
              (v) => onBrushSettingsChange({ size: v }),
              400,
            )}
            {rangeControl(
              <Feather size={14} />,
              t('editor.masks.toolbar.brushFeather'),
              brushFeather,
              (v) => onBrushSettingsChange({ feather: v }),
              100,
            )}
            <div className="mx-1 h-5 w-px bg-border-color" />
          </>
        ) : null}

        {strengthKey !== null ? (
          <label className="flex items-center gap-2 rounded-lg px-2.5 text-sm font-medium text-text-secondary">
            <span className="flex h-4 w-4 items-center justify-center">
              <Wrench size={15} />
            </span>
            <input
              className="h-1 w-24 accent-accent slider-input"
              type="range"
              min={1}
              max={100}
              step={1}
              value={strengthValue ?? 40}
              onChange={(e) => onStrengthChange(Number(e.target.value))}
              title={t('editor.masks.toolbar.strength')}
            />
            <span className="w-7 min-w-7 text-right tabular-nums text-text-primary">{strengthValue}</span>
          </label>
        ) : null}

        {!isStandalone ? (
          <button className={iconButton(subMask.invert)} onClick={onInvert} title={t('editor.masks.toolbar.invert')}>
            <FlipHorizontal2 size={16} />
            <span className="hidden sm:inline">{t('editor.masks.toolbar.invert')}</span>
          </button>
        ) : null}

        {!isStandalone && CLEAR_TYPES.includes(subMask.type) ? (
          <button className={iconButton()} onClick={onClear} title={t('editor.masks.toolbar.clearMask')}>
            <Trash2 size={16} />
            <span className="hidden sm:inline">{t('editor.masks.toolbar.clearMask')}</span>
          </button>
        ) : null}

        <button
          className={iconButton()}
          onClick={onToggleOverlay}
          title={maskOverlayVisible ? t('editor.masks.toolbar.overlayOff') : t('editor.masks.toolbar.overlayOn')}
        >
          {maskOverlayVisible ? <Eye size={16} /> : <EyeOff size={16} />}
        </button>

        <div className="mx-1 h-5 w-px bg-border-color" />

        <button className={clsx(buttonBase, 'bg-accent text-white hover:opacity-90')} onClick={onDone}>
          <Check size={16} />
          <span>{t('editor.masks.toolbar.done')}</span>
        </button>
      </motion.div>
    </AnimatePresence>
  );
}
