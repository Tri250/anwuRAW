import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ImageOff, Upload, X, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'framer-motion';
import { useContextMenu } from '../../context/ContextMenuContext';
import { toast } from 'react-toastify';
import Slider from './Slider';
import { useEditorStore } from '../../store/useEditorStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { getLutDisplayName } from '../../utils/lutDisplayNames';
import { useLongPressMenu } from '../../hooks/useLongPressMenu';

interface LutEntry {
  name: string;
  path: string;
  isBuiltIn: boolean;
}

interface LutPreview {
  path: string;
  thumb: string | null;
}

interface LUTControlProps {
  lutPath: string | null;
  lutName: string | null;
  lutIntensity: number;
  onLutSelect: (path: string, isBuiltIn: boolean) => void;
  onLutHover?: (path: string | null, isBuiltIn?: boolean) => void;
  onIntensityChange: (intensity: number) => void;
  onClear: () => void;
  onDragStateChange?: (isDragging: boolean) => void;
}

const PREVIEW_SIZE = 112;
const SUPPORTED_EXTENSIONS = ['cube', '3dl', 'png', 'jpg', 'jpeg', 'tiff'];

interface LutSwatchProps {
  entry: LutEntry;
  thumb: string | null | undefined;
  isSelected: boolean;
  isLoadingPreviews: boolean;
  onSelect(entry: LutEntry): void;
  onHover(path: string | null, isBuiltIn?: boolean): void;
  onContextMenu(event: React.MouseEvent, entry: LutEntry): void;
}

/**
 * 单个 LUT 色板。抽成独立组件才能按色板调用长按 hook。
 * Android 没有鼠标右键，长按 500ms 打开自定义 LUT 的删除/重命名菜单。
 */
function LutSwatch({ entry, thumb, isSelected, isLoadingPreviews, onSelect, onHover, onContextMenu }: LutSwatchProps) {
  const longPress = useLongPressMenu(entry.path, entry.isBuiltIn ? undefined : (e: any) => onContextMenu(e, entry));

  return (
    <button
      onMouseEnter={() => onHover(entry.path, entry.isBuiltIn)}
      onMouseLeave={() => onHover(null)}
      onPointerDown={longPress.onPointerDown}
      onPointerMove={longPress.onPointerMove}
      onPointerUp={longPress.onPointerUp}
      onPointerCancel={longPress.onPointerCancel}
      onClick={() => {
        // 长按已弹出菜单：吞掉这次 click，避免同时选中 LUT
        if (longPress.triggeredRef.current) {
          longPress.triggeredRef.current = false;
          return;
        }
        onSelect(entry);
      }}
      onContextMenu={(e) => {
        longPress.cancel();
        if (longPress.triggeredRef.current) {
          e.preventDefault();
          return;
        }
        if (!entry.isBuiltIn) onContextMenu(e, entry);
      }}
      className={`relative aspect-square rounded-md overflow-hidden bg-bg-tertiary border-2 transition-colors ${
        isSelected ? 'border-accent' : 'border-transparent hover:border-surface'
      }`}
      data-tooltip={getLutDisplayName(entry.name)}
    >
      {isLoadingPreviews && thumb === undefined ? (
        <div className="w-full h-full animate-pulse bg-surface" />
      ) : thumb ? (
        <img src={thumb} alt={getLutDisplayName(entry.name)} className="w-full h-full object-cover" draggable={false} />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-text-secondary">
          <ImageOff size={18} />
        </div>
      )}
      <span className="absolute inset-x-0 bottom-0 px-1 py-0.5 text-[10px] text-white bg-black/60 truncate text-left backdrop-blur-xs">
        {getLutDisplayName(entry.name)}
      </span>
    </button>
  );
}

export default function LUTControl({
  lutPath,
  lutName,
  lutIntensity,
  onLutSelect,
  onLutHover,
  onIntensityChange,
  onClear,
  onDragStateChange,
}: LUTControlProps) {
  const { t } = useTranslation();
  const { showContextMenu } = useContextMenu();
  const selectedImagePath = useEditorStore((state) => state.selectedImage?.path ?? null);
  const isImageReady = useEditorStore((state) => state.selectedImage?.isReady ?? false);

  const [isExpanded, setIsExpanded] = useState(false);
  const [entries, setEntries] = useState<LutEntry[]>([]);
  const [previews, setPreviews] = useState<Record<string, string | null>>({});
  const [isLoadingPreviews, setIsLoadingPreviews] = useState(false);
  const previewCache = useRef<Map<string, Record<string, string | null>>>(new Map());

  const handleContextMenu = (event: React.MouseEvent, entry: LutEntry) => {
    if (entry.isBuiltIn) return;

    event.preventDefault();
    event.stopPropagation();

    showContextMenu(event.clientX, event.clientY, [
      {
        label: t('ui.lut.removeLut'),
        icon: Trash2,
        isDestructive: true,
        onClick: async () => {
          try {
            const updatedList = await invoke<LutEntry[]>('remove_lut', { path: entry.path });
            setEntries(Array.isArray(updatedList) ? updatedList : []);
            setPreviews((prev) => {
              const next = { ...prev };
              delete next[entry.path];
              return next;
            });
            previewCache.current.clear();
            if (entry.path === lutPath) {
              onClear();
            }
          } catch (err) {
            console.error('Failed to remove LUT:', err);
            toast.error(String(err));
          }
        },
      },
    ]);
  };

  const refreshList = useCallback(async () => {
    try {
      const list = await invoke<LutEntry[]>('list_luts');
      // 后端异常返回 null 时兜底为空数组，避免渲染层 entries.filter 崩溃
      setEntries(Array.isArray(list) ? list : []);
    } catch (err) {
      console.error('Failed to list LUTs:', err);
      setEntries([]);
    }
  }, []);

  useEffect(() => {
    refreshList();
  }, [refreshList]);

  useEffect(() => {
    if (!isExpanded || !selectedImagePath || !isImageReady || entries.length === 0) {
      return;
    }
    const cacheKey = `${selectedImagePath}|${entries
      .map((entry) => `${entry.path}:${entry.isBuiltIn ? 1 : 0}`)
      .join(',')}`;
    const cached = previewCache.current.get(cacheKey);
    if (cached) {
      setPreviews(cached);
      return;
    }

    let isActive = true;
    setIsLoadingPreviews(true);
    invoke<LutPreview[]>('generate_lut_previews', {
      luts: entries.map((entry) => ({ path: entry.path, isBuiltIn: entry.isBuiltIn })),
      size: PREVIEW_SIZE,
    })
      .then((results) => {
        if (!isActive) return;
        const map: Record<string, string | null> = {};
        results.forEach((result) => {
          map[result.path] = result.thumb;
        });
        previewCache.current.set(cacheKey, map);
        setPreviews(map);
      })
      .catch((err) => console.error('Failed to generate LUT previews:', err))
      .finally(() => {
        if (isActive) setIsLoadingPreviews(false);
      });
    return () => {
      isActive = false;
    };
  }, [isExpanded, selectedImagePath, isImageReady, entries]);

  const handleImport = async () => {
    try {
      const { osPlatform } = useSettingsStore.getState();
      const isAndroid = osPlatform === 'android';

      const selected = await open({
        multiple: true,
        filters: isAndroid
          ? []
          : [
              {
                name: t('ui.lut.filterLabel'),
                extensions: [...SUPPORTED_EXTENSIONS, ...SUPPORTED_EXTENSIONS.map((ext) => ext.toUpperCase())],
              },
            ],
      });
      const sourcePaths = Array.isArray(selected) ? selected : selected ? [selected] : [];
      if (sourcePaths.length === 0) return;

      let validPaths = sourcePaths;
      if (isAndroid) {
        const resolvedNames = await Promise.all(
          sourcePaths.map(async (path) => {
            try {
              return await invoke<string>('resolve_android_content_uri_name', { uriStr: path });
            } catch (e) {
              console.error('Failed to resolve Android URI:', e);
              return path;
            }
          }),
        );
        const allowedExtensions = new Set(SUPPORTED_EXTENSIONS);
        validPaths = sourcePaths.filter((_, index) => {
          const resolvedName = resolvedNames[index];
          const ext = resolvedName.split('.').pop()?.toLowerCase() || '';
          if (!allowedExtensions.has(ext)) {
            console.warn(`Skipping unsupported file: ${resolvedName}`);
            return false;
          }
          return true;
        });
        if (validPaths.length === 0) {
          toast.error(t('ui.lut.importFailed'));
          return;
        }
      }

      const list = await invoke<LutEntry[]>('import_luts', { sourcePaths: validPaths });
      previewCache.current.clear();
      setEntries(Array.isArray(list) ? list : []);
      setPreviews({});
    } catch (err) {
      console.error('Failed to import LUTs:', err);
      toast.error(t('ui.lut.importFailed'));
    }
  };

  const handleSwatchClick = (entry: LutEntry) => {
    onLutHover?.(null);
    if (entry.path === lutPath) {
      onClear();
    } else {
      onLutSelect(entry.path, entry.isBuiltIn);
    }
  };

  const safeEntries = entries ?? [];
  const builtInLuts = safeEntries.filter((e) => e.isBuiltIn);
  const customLuts = safeEntries.filter((e) => !e.isBuiltIn);

  const renderSwatch = (entry: LutEntry) => (
    <LutSwatch
      key={entry.path}
      entry={entry}
      thumb={previews[entry.path]}
      isSelected={entry.path === lutPath}
      isLoadingPreviews={isLoadingPreviews}
      onSelect={handleSwatchClick}
      onHover={(path, isBuiltIn) => onLutHover?.(path, isBuiltIn)}
      onContextMenu={handleContextMenu}
    />
  );

  return (
    <div className="mb-2">
      <div className="flex justify-between items-center">
        <span className="text-sm font-medium text-text-secondary select-none">{t('ui.lut.label')}</span>
        <div className="flex items-center gap-1">
          {lutName && (
            <button
              onClick={onClear}
              className="flex items-center justify-center p-0.5 rounded-full bg-bg-tertiary hover:bg-surface text-text-secondary hover:text-text-primary transition-colors"
              data-tooltip={t('ui.lut.clearLut')}
            >
              <X size={14} />
            </button>
          )}
          <button
            onClick={() => setIsExpanded((value) => !value)}
            className="flex items-center gap-1 text-sm text-text-secondary select-none cursor-pointer hover:text-accent transition-colors"
            data-tooltip={lutName ? getLutDisplayName(lutName) : t('ui.lut.selectLutFile')}
          >
            <span className="truncate max-w-35 text-right">{getLutDisplayName(lutName) || t('ui.lut.select')}</span>
            <ChevronDown size={16} className={`transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`} />
          </button>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {lutName && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="mt-3">
              <Slider
                label={t('ui.lut.intensity')}
                min={0}
                max={100}
                step={1}
                value={lutIntensity}
                defaultValue={100}
                onChange={(e) => onIntensityChange(Number(e.target.value))}
                onDragStateChange={onDragStateChange}
                fillOrigin="min"
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className={`${lutName ? '' : 'mt-3'} pb-1 space-y-4`}>
              {builtInLuts.length > 0 && (
                <div>
                  <span className="text-sm font-medium text-text-secondary select-none block mb-2">
                    {t('ui.lut.filmEmulations')}
                  </span>
                  <div className="grid grid-cols-3 gap-2">{builtInLuts.map(renderSwatch)}</div>
                </div>
              )}

              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-text-secondary select-none">{t('ui.lut.customLuts')}</span>
                  {customLuts.length > 0 && (
                    <button
                      onClick={handleImport}
                      className="text-xs text-text-secondary hover:text-accent flex items-center gap-1 transition-colors"
                      data-tooltip={t('ui.lut.import')}
                    >
                      <Upload size={12} />
                      {t('ui.lut.import')}
                    </button>
                  )}
                </div>

                {customLuts.length === 0 ? (
                  <button
                    onClick={handleImport}
                    className="w-full flex items-center justify-center gap-1.5 py-4 rounded-md bg-bg-tertiary hover:bg-surface border-2 border-dashed border-text-secondary/20 hover:border-text-secondary/40 text-sm text-text-primary transition-colors cursor-pointer"
                  >
                    <Upload size={16} />
                    {t('ui.lut.import')}
                  </button>
                ) : (
                  <div className="grid grid-cols-3 gap-2">
                    {customLuts.map(renderSwatch)}

                    <button
                      onClick={handleImport}
                      className="aspect-square rounded-md bg-bg-tertiary border-2 border-dashed border-text-secondary/25 hover:border-accent flex items-center justify-center text-text-secondary hover:text-text-primary transition-all duration-150 cursor-pointer"
                      data-tooltip={t('ui.lut.import')}
                    >
                      <Upload size={18} />
                    </button>
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
