import React, { useCallback, type MouseEvent as ReactMouseEvent } from 'react';
import { RotateCcw, Copy, ClipboardPaste, Aperture, ChartArea } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import { ADJUSTMENT_SECTION_COMPONENTS } from '../../adjustments/sectionRegistry';
import CollapsibleSection from '../../ui/CollapsibleSection';
import Waveform, { type HistogramZone } from '../editor/Waveform';
import Resizer from '../../ui/Resizer';
import { Adjustments, SectionVisibility, INITIAL_ADJUSTMENTS, ADJUSTMENT_SECTIONS } from '../../../utils/adjustments';
import { useContextMenu } from '../../../context/ContextMenuContext';
import { OPTION_SEPARATOR, Orientation, type Option } from '../../ui/AppProperties';
import Text from '../../ui/Text';
import { TextVariants, TextColors, TextWeights } from '../../../types/typography';
import { useShallow } from 'zustand/react/shallow';
import { useEditorStore } from '../../../store/useEditorStore';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { useUIStore, type CollapsibleSectionsState } from '../../../store/useUIStore';
import { useEditorActions } from '../../../hooks/useEditorActions';
import { useWaveformControls } from '../../../hooks/useWaveformControls';

type CollapsibleStateMap = CollapsibleSectionsState & Record<string, boolean>;
type CollapsibleStateUpdater =
  | CollapsibleStateMap
  | ((prev: CollapsibleStateMap) => CollapsibleStateMap);

type CopiedSection = {
  section: string;
  values: Partial<Adjustments>;
};

const HISTOGRAM_ZONE_CONFIG: Record<
  HistogramZone,
  { key: string; min: number; max: number; scale: number; round: number }
> = {
  blacks: { key: 'blacks', min: -100, max: 100, scale: 200, round: 0 },
  shadows: { key: 'shadows', min: -100, max: 100, scale: 200, round: 0 },
  exposure: { key: 'exposure', min: -5, max: 5, scale: 2.5, round: 2 },
  highlights: { key: 'highlights', min: -100, max: 100, scale: 200, round: 0 },
  whites: { key: 'whites', min: -100, max: 100, scale: 200, round: 0 },
};

export default function Controls() {
  const { t } = useTranslation();
  const { showContextMenu } = useContextMenu();
  const { isResizingWaveform, onToggleWaveform, setActiveWaveformChannel, handleWaveformResize } =
    useWaveformControls();
  const { setAdjustments, handleAutoAdjustments, handleLutSelect, setLutPreviewOverride } = useEditorActions();

  const { appSettings, theme, osPlatform } = useSettingsStore(
    useShallow((state) => ({
      appSettings: state.appSettings,
      theme: state.theme,
      osPlatform: state.osPlatform,
    })),
  );

  const isAndroid = osPlatform === 'android';

  const { collapsibleSectionsState, setUI } = useUIStore(
    useShallow((state) => ({
      collapsibleSectionsState: state.collapsibleSectionsState,
      setUI: state.setUI,
    })),
  );

  const {
    adjustments,
    copiedSectionAdjustments,
    histogram,
    selectedImage,
    isWbPickerActive,
    isWaveformVisible,
    waveform,
    activeWaveformChannel,
    waveformHeight,
    setEditor,
  } = useEditorStore(
    useShallow((state) => ({
      adjustments: state.adjustments,
      copiedSectionAdjustments: state.copiedSectionAdjustments,
      histogram: state.histogram,
      selectedImage: state.selectedImage,
      isWbPickerActive: state.isWbPickerActive,
      isWaveformVisible: state.isWaveformVisible,
      waveform: state.waveform,
      activeWaveformChannel: state.activeWaveformChannel,
      waveformHeight: state.waveformHeight,
      setEditor: state.setEditor,
    })),
  );

  const setCopiedSectionAdjustments = useCallback(
    (val: CopiedSection | null) => setEditor({ copiedSectionAdjustments: val }),
    [setEditor],
  );

  const toggleWbPicker = useCallback(
    () => setEditor((state) => ({ isWbPickerActive: !state.isWbPickerActive })),
    [setEditor],
  );

  const onDragStateChange = useCallback(
    (isDragging: boolean) => setEditor({ isSliderDragging: isDragging }),
    [setEditor],
  );

  const handleHistogramZoneAdjust = useCallback(
    (zone: HistogramZone, deltaX: number, containerWidth: number) => {
      const config = HISTOGRAM_ZONE_CONFIG[zone];
      if (!config || containerWidth <= 0) return;

      setAdjustments((prev: Adjustments) => {
        const currentValue = Number(prev[config.key] ?? 0);
        const delta = (deltaX / containerWidth) * config.scale;
        const nextValue = Math.max(
          config.min,
          Math.min(config.max, parseFloat((currentValue + delta).toFixed(config.round))),
        );

        if (nextValue === currentValue) return prev;
        return { ...prev, [config.key]: nextValue };
      });
    },
    [setAdjustments],
  );

  const handleHistogramZoneReset = useCallback(
    (zone: HistogramZone) => {
      const config = HISTOGRAM_ZONE_CONFIG[zone];
      if (!config) return;
      setAdjustments((prev: Adjustments) => ({ ...prev, [config.key]: 0 }));
    },
    [setAdjustments],
  );

  const setCollapsibleState = useCallback(
    (updater: CollapsibleStateUpdater) =>
      setUI((state) => ({
        collapsibleSectionsState:
          typeof updater === 'function'
            ? updater(state.collapsibleSectionsState as CollapsibleStateMap)
            : updater,
      })),
    [setUI],
  );

  const handleToggleVisibility = (sectionName: string) => {
    setAdjustments((prev: Adjustments) => {
      const currentVisibility: SectionVisibility = prev.sectionVisibility || INITIAL_ADJUSTMENTS.sectionVisibility;
      return {
        ...prev,
        sectionVisibility: {
          ...currentVisibility,
          [sectionName]: !currentVisibility[sectionName],
        },
      };
    });
  };

  const handleResetAdjustments = () => {
    setAdjustments((prev: Adjustments) => ({
      ...prev,
      ...Object.keys(ADJUSTMENT_SECTIONS)
        .flatMap((s) => ADJUSTMENT_SECTIONS[s])
        .reduce<Partial<Adjustments>>((acc, key) => {
          (acc as Record<string, unknown>)[key] = INITIAL_ADJUSTMENTS[key as keyof Adjustments];
          return acc;
        }, {}),
      sectionVisibility: { ...INITIAL_ADJUSTMENTS.sectionVisibility },
    }));
  };

  const handleToggleSection = (section: string) => {
    // Android 端取消折叠：分区始终展开，点击标题不再折叠
    if (isAndroid) return;
    setCollapsibleState((prev) => {
      const isOpening = !prev[section];
      if (appSettings?.enableFocusMode && isOpening) {
        const newState = { ...prev };
        Object.keys(newState).forEach((key) => {
          newState[key] = false;
        });
        newState[section] = true;
        return newState;
      }
      return { ...prev, [section]: !prev[section] };
    });
  };

  const handleSectionContextMenu = (event: ReactMouseEvent<HTMLElement>, sectionName: string) => {
    event.preventDefault();
    event.stopPropagation();

    const sectionKeys = ADJUSTMENT_SECTIONS[sectionName];
    if (!sectionKeys) {
      return;
    }

    const handleCopy = () => {
      const adjustmentsToCopy: Partial<Adjustments> = {};
      for (const key of sectionKeys) {
        if (Object.prototype.hasOwnProperty.call(adjustments, key)) {
          (adjustmentsToCopy as Record<string, unknown>)[key] = JSON.parse(
            JSON.stringify(adjustments[key as keyof Adjustments]),
          );
        }
      }
      setCopiedSectionAdjustments({ section: sectionName, values: adjustmentsToCopy });
    };

    const handlePaste = () => {
      if (!copiedSectionAdjustments || copiedSectionAdjustments.section !== sectionName) {
        return;
      }
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        ...copiedSectionAdjustments.values,
        sectionVisibility: {
          ...(prev.sectionVisibility || INITIAL_ADJUSTMENTS.sectionVisibility),
          [sectionName]: true,
        },
      }));
    };

    const handleReset = () => {
      const resetValues: Partial<Adjustments> = {};
      for (const key of sectionKeys) {
        (resetValues as Record<string, unknown>)[key] = JSON.parse(
          JSON.stringify(INITIAL_ADJUSTMENTS[key as keyof Adjustments]),
        );
      }
      setAdjustments((prev: Adjustments) => ({
        ...prev,
        ...resetValues,
        sectionVisibility: {
          ...(prev.sectionVisibility || INITIAL_ADJUSTMENTS.sectionVisibility),
          [sectionName]: true,
        },
      }));
    };

    const isPasteAllowed = copiedSectionAdjustments && copiedSectionAdjustments.section === sectionName;
    const translatedSection = t(`editor.adjustments.sections.${sectionName}`);

    const pasteLabel = copiedSectionAdjustments
      ? t('editor.adjustments.actions.pasteLabel', { section: translatedSection })
      : t('editor.adjustments.actions.pasteSettings');

    const options: Array<Option> = [
      {
        label: t('editor.adjustments.actions.copySectionSettings', { section: translatedSection }),
        icon: Copy,
        onClick: handleCopy,
      },
      { label: pasteLabel, icon: ClipboardPaste, onClick: handlePaste, disabled: !isPasteAllowed },
      { type: OPTION_SEPARATOR },
      {
        label: t('editor.adjustments.actions.resetSectionSettings', { section: translatedSection }),
        icon: RotateCcw,
        onClick: handleReset,
      },
    ];

    showContextMenu(event.clientX, event.clientY, options);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 flex justify-between items-center shrink-0 border-b border-surface">
        <Text variant={TextVariants.title}>{t('editor.adjustments.title')}</Text>
        <div className="flex items-center gap-1">
          <button
            aria-label={t('editor.adjustments.tooltips.autoAdjust')}
            className="p-2 rounded-full hover:bg-surface disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            disabled={!selectedImage}
            onClick={handleAutoAdjustments}
            data-tooltip={t('editor.adjustments.tooltips.autoAdjust')}
          >
            <Aperture size={18} />
          </button>
          <button
            aria-label={t('editor.adjustments.tooltips.toggleAnalytics')}
            aria-pressed={isWaveformVisible}
            className={clsx(
              'p-2 rounded-full transition-colors',
              isWaveformVisible ? 'bg-surface hover:bg-card-active' : 'hover:bg-surface',
            )}
            onClick={onToggleWaveform}
            data-tooltip={t('editor.adjustments.tooltips.toggleAnalytics')}
          >
            <ChartArea size={18} />
          </button>
          <button
            aria-label={t('editor.adjustments.tooltips.resetAdjustments')}
            className="p-2 rounded-full hover:bg-surface disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            disabled={!selectedImage}
            onClick={handleResetAdjustments}
            data-tooltip={t('editor.adjustments.tooltips.resetAdjustments')}
          >
            <RotateCcw size={18} />
          </button>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {isWaveformVisible && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: waveformHeight || 256, opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: isResizingWaveform ? 0 : 0.2, ease: 'easeOut' }}
            className="shrink-0 flex flex-col relative border-b border-surface overflow-hidden"
          >
            <div className="grow w-full h-full p-3 pb-2 min-h-0">
              <Waveform
                waveformData={waveform || null}
                histogram={histogram}
                displayMode={activeWaveformChannel || 'luma'}
                setDisplayMode={setActiveWaveformChannel}
                showClipping={adjustments.showClipping || false}
                onToggleClipping={() => {
                  setAdjustments((prev: Adjustments) => ({
                    ...prev,
                    showClipping: !prev.showClipping,
                  }));
                }}
                onHistogramZoneAdjust={handleHistogramZoneAdjust}
                onHistogramZoneReset={handleHistogramZoneReset}
                onHistogramZoneDragStateChange={onDragStateChange}
                theme={theme}
              />
            </div>
            <Resizer direction={Orientation.Horizontal} onMouseDown={handleWaveformResize} />
          </motion.div>
        )}
      </AnimatePresence>

      <div className="grow overflow-y-auto p-3 flex flex-col gap-2">
        {selectedImage ? (
          Object.keys(ADJUSTMENT_SECTIONS).map((sectionName: string) => {
            const SectionComponent = ADJUSTMENT_SECTION_COMPONENTS[sectionName];

            const title = t(`editor.adjustments.sections.${sectionName}`);
            const sectionVisibility = adjustments.sectionVisibility || INITIAL_ADJUSTMENTS.sectionVisibility;

            return (
              <div className="shrink-0 group" key={sectionName}>
                <CollapsibleSection
                  disableCollapse={isAndroid}
                  isContentVisible={sectionVisibility[sectionName as keyof SectionVisibility]}
                  isOpen={isAndroid ? true : collapsibleSectionsState[sectionName as keyof typeof collapsibleSectionsState]}
                  onContextMenu={(e: ReactMouseEvent<HTMLElement>) =>
                    handleSectionContextMenu(e, sectionName)
                  }
                  onToggle={() => handleToggleSection(sectionName)}
                  onToggleVisibility={() => handleToggleVisibility(sectionName)}
                  title={title}
                >
                  <SectionComponent
                    adjustments={adjustments}
                    setAdjustments={setAdjustments}
                    histogram={histogram}
                    theme={theme}
                    handleLutSelect={handleLutSelect}
                    onLutHover={setLutPreviewOverride}
                    appSettings={appSettings}
                    isWbPickerActive={isWbPickerActive}
                    toggleWbPicker={toggleWbPicker}
                    onDragStateChange={onDragStateChange}
                    onAutoAdjust={handleAutoAdjustments}
                  />
                </CollapsibleSection>
              </div>
            );
          })
        ) : (
          <div className="flex items-center justify-center h-full">
            <Text
              variant={TextVariants.heading}
              color={TextColors.secondary}
              weight={TextWeights.normal}
              className="text-center"
            >
              {t('editor.ai.noImageSelected')}
            </Text>
          </div>
        )}
      </div>
    </div>
  );
}
