import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Brush, Check, Eraser, Eye, EyeOff, FlipHorizontal2, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { Mask, SubMask, ToolType, getSubMaskName } from '../right/Masks';
import { BrushSettings } from '../../ui/AppProperties';

/** 哪些蒙版类型会在画布上进入"蒙版编辑工具条"会话 */
const TOOLBAR_VISIBLE_TYPES: Mask[] = [
  Mask.Brush,
  Mask.Flow,
  Mask.QuickEraser,
  Mask.Linear,
  Mask.Radial,
  Mask.Color,
  Mask.Luminance,
];

/** 这些类型支持画笔 / 橡皮切换 */
const BRUSH_TOOL_TYPES: Mask[] = [Mask.Brush, Mask.Flow, Mask.QuickEraser];

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
  onToggleOverlay,
  onInvert,
  onClear,
  onDone,
}: MaskEditingToolbarProps) {
  const { t } = useTranslation();
  const showBrushTool = BRUSH_TOOL_TYPES.includes(subMask.type);
  const activeTool = brushSettings?.tool ?? ToolType.Brush;

  const buttonBase =
    'flex h-9 min-w-9 items-center justify-center gap-1.5 rounded-lg px-2.5 text-sm font-medium transition-colors';

  const iconButton = (active = false) =>
    clsx(
      buttonBase,
      active
        ? 'bg-accent text-white'
        : 'text-text-secondary hover:bg-card-active hover:text-text-primary',
    );

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 12, scale: 0.96 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
        className="pointer-events-auto flex items-center gap-1 rounded-xl border border-border-color bg-bg-secondary/90 p-1.5 shadow-[0_8px_30px_rgba(0,0,0,0.35)] backdrop-blur-md"
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

        <button
          className={iconButton(subMask.invert)}
          onClick={onInvert}
          title={t('editor.masks.toolbar.invert')}
        >
          <FlipHorizontal2 size={16} />
          <span className="hidden sm:inline">{t('editor.masks.toolbar.invert')}</span>
        </button>

        {CLEAR_TYPES.includes(subMask.type) ? (
          <button
            className={iconButton()}
            onClick={onClear}
            title={t('editor.masks.toolbar.clearMask')}
          >
            <Trash2 size={16} />
            <span className="hidden sm:inline">{t('editor.masks.toolbar.clearMask')}</span>
          </button>
        ) : null}

        <button
          className={iconButton()}
          onClick={onToggleOverlay}
          title={
            maskOverlayVisible
              ? t('editor.masks.toolbar.overlayOff')
              : t('editor.masks.toolbar.overlayOn')
          }
        >
          {maskOverlayVisible ? <Eye size={16} /> : <EyeOff size={16} />}
        </button>

        <div className="mx-1 h-5 w-px bg-border-color" />

        <button
          className={clsx(buttonBase, 'bg-accent text-white hover:opacity-90')}
          onClick={onDone}
        >
          <Check size={16} />
          <span>{t('editor.masks.toolbar.done')}</span>
        </button>
      </motion.div>
    </AnimatePresence>
  );
}