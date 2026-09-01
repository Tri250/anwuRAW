import { motion } from 'framer-motion';
import clsx from 'clsx';
import Slider from '../ui/Slider';
import { Adjustments, BasicAdjustment } from '../../utils/adjustments';
import { useEffect, useRef, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Text from '../ui/Text';
import { TextColors, TextVariants, TextWeights } from '../../types/typography';

interface BasicAdjustmentsProps {
  adjustments: Adjustments;
  setAdjustments(adjustments: Partial<Adjustments>): any;
  isForMask?: boolean;
  onDragStateChange?: (isDragging: boolean) => void;
  appSettings?: any;
  onAutoAdjust?: () => void;
}

/**
 * 一键场景/风格增强 —— 端侧真实实现。
 * 每个场景是一组经过校准的调整参数，直接经由现有调整管线实时作用于像素。
 * 「自动」复用后端 perform_auto_analysis 直方图自动分析。
 */
interface SceneEnhanceOptions {
  labelKey: string;
  /** 复用的调整参数组合（真实生效） */
  values?: Partial<Adjustments>;
}

const SCENE_ENHANCE: SceneEnhanceOptions[] = [
  {
    labelKey: 'adjustments.basic.scene.prototypePortrait',
    values: {
      exposure: 0,
      contrast: 6,
      highlights: -10,
      shadows: 14,
      whites: 0,
      blacks: 0,
      saturation: -4,
      vibrance: 10,
      clarity: 10,
      temperature: 0,
    },
  },
  {
    labelKey: 'adjustments.basic.scene.prototypeLandscape',
    values: {
      contrast: 12,
      highlights: -8,
      shadows: 12,
      saturation: 20,
      vibrance: 16,
      clarity: 16,
      dehaze: 14,
    },
  },
  {
    labelKey: 'adjustments.basic.scene.prototypeNight',
    values: {
      exposure: 0.5,
      highlights: -22,
      shadows: 28,
      whites: -4,
      blacks: 4,
      saturation: 8,
      vibrance: 8,
      lumaNoiseReduction: 24,
      colorNoiseReduction: 18,
    },
  },
  {
    labelKey: 'adjustments.basic.scene.prototypeWarmSunset',
    values: {
      exposure: 0.12,
      contrast: 5,
      highlights: -12,
      shadows: 10,
      temperature: 16,
      tint: 0,
      vibrance: 18,
      saturation: 8,
    },
  },
];

interface ToneMapperSwitchProps {
  selectedMapper: string;
  onMapperChange: (mapper: string) => void;
  evShiftValue: number;
  onEvShiftChange: (value: number) => void;
  onDragStateChange?: (isDragging: boolean) => void;
}

const ToneMapperSwitch = ({
  selectedMapper,
  onMapperChange,
  evShiftValue,
  onEvShiftChange,
  onDragStateChange,
}: ToneMapperSwitchProps) => {
  const { t } = useTranslation();
  const [bubbleStyle, setBubbleStyle] = useState({});
  const isInitialAnimation = useRef(true);
  const [isLabelHovered, setIsLabelHovered] = useState(false);

  const toneMapperOptions = useMemo(
    () => [
      {
        id: 'basic',
        label: t('adjustments.basic.mappers.basic'),
        title: t('adjustments.basic.mappers.basicDesc'),
      },
      {
        id: 'reinhard',
        label: t('adjustments.basic.mappers.reinhard'),
        title: t('adjustments.basic.mappers.reinhardDesc'),
      },
      {
        id: 'filmic',
        label: t('adjustments.basic.mappers.filmic'),
        title: t('adjustments.basic.mappers.filmicDesc'),
      },
      {
        id: 'agx',
        label: t('adjustments.basic.mappers.agx'),
        title: t('adjustments.basic.mappers.agxDesc'),
      },
      {
        id: 'gamma',
        label: t('adjustments.basic.mappers.gamma'),
        title: t('adjustments.basic.mappers.gammaDesc'),
      },
    ],
    [t],
  );

  const handleReset = () => {
    onMapperChange('basic');
    onEvShiftChange(0);
  };

  useEffect(() => {
    const selectedIndex = toneMapperOptions.findIndex((m) => m.id === selectedMapper);
    const safeIndex = selectedIndex >= 0 ? selectedIndex : 0;

    const widthPercent = 100 / toneMapperOptions.length;
    const targetX = `${safeIndex * 100}%`;
    const targetWidth = `${widthPercent}%`;

    if (isInitialAnimation.current) {
      let initialX;
      if (selectedMapper === 'agx') {
        initialX = `${toneMapperOptions.length * 100}%`;
      } else {
        initialX = '-25%';
      }

      setBubbleStyle({
        x: [initialX, targetX],
        width: targetWidth,
      });
      isInitialAnimation.current = false;
    } else {
      setBubbleStyle({
        x: targetX,
        width: targetWidth,
      });
    }
  }, [selectedMapper, toneMapperOptions]);

  return (
    <div className="group mb-3">
      <div className="flex justify-between items-center mb-2">
        <div
          className="grid cursor-pointer"
          onClick={handleReset}
          onDoubleClick={handleReset}
          onMouseEnter={() => setIsLabelHovered(true)}
          onMouseLeave={() => setIsLabelHovered(false)}
        >
          <span
            aria-hidden={isLabelHovered}
            className={`col-start-1 row-start-1 text-sm font-medium text-text-secondary select-none transition-opacity duration-200 ease-in-out ${
              isLabelHovered ? 'opacity-0' : 'opacity-100'
            }`}
          >
            {t('adjustments.basic.toneMapper')}
          </span>
          <span
            aria-hidden={!isLabelHovered}
            className={`col-start-1 row-start-1 text-sm font-medium text-text-primary select-none transition-opacity duration-200 ease-in-out pointer-events-none ${
              isLabelHovered ? 'opacity-100' : 'opacity-0'
            }`}
          >
            {t('adjustments.basic.reset')}
          </span>
        </div>
      </div>
      <div className="w-full p-2 pb-1 bg-card-active rounded-md">
        <div className="relative flex w-full overflow-x-auto no-scrollbar">
          <motion.div
            className="absolute top-0 bottom-0 z-0 bg-accent"
            style={{ borderRadius: 6 }}
            animate={bubbleStyle}
            transition={{ type: 'spring', bounce: 0.2, duration: 0.6 }}
          />
          {toneMapperOptions.map((mapper) => (
            <button
              key={mapper.id}
              data-tooltip={mapper.title}
              onClick={() => onMapperChange(mapper.id)}
              className={clsx(
                'relative flex-1 flex items-center justify-center gap-2 px-3 p-1.5 text-sm font-medium rounded-md transition-colors whitespace-nowrap',
                {
                  'text-text-primary hover:bg-surface': selectedMapper !== mapper.id,
                  'text-button-text': selectedMapper === mapper.id,
                },
              )}
              style={{ WebkitTapHighlightColor: 'transparent' }}
            >
              <span className="relative z-10 flex items-center">{mapper.label}</span>
            </button>
          ))}
        </div>
        <div className="mt-2.5 px-1">
          <Slider
            label={t('adjustments.basic.evShift')}
            max={5}
            min={-5}
            onChange={(e: any) => onEvShiftChange(parseFloat(e.target.value))}
            step={0.01}
            value={evShiftValue}
            trackClassName="bg-surface"
            onDragStateChange={onDragStateChange}
          />
        </div>
      </div>
    </div>
  );
};

export default function BasicAdjustments({
  adjustments,
  setAdjustments,
  isForMask = false,
  onDragStateChange,
  appSettings,
  onAutoAdjust,
}: BasicAdjustmentsProps) {
  const { t } = useTranslation();

  const handleAdjustmentChange = (key: BasicAdjustment, value: any) => {
    const numericValue = parseFloat(value);
    setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, [key]: numericValue }));
  };

  const handleToneMapperChange = (mapper: string) => {
    setAdjustments((prev: Partial<Adjustments>) => ({
      ...prev,
      toneMapper: mapper as 'basic' | 'agx',
    }));
  };

  const applySceneEnhance = (target: SceneEnhanceOptions) => {
    if (!target.values) return;
    setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, ...target.values }));
  };

  const hideTonemapper = isForMask || appSettings?.tonemapperOverrideEnabled;

  return (
    <div>
      {!isForMask && (
        <div className="p-2 bg-bg-tertiary rounded-md mb-4">
          <Text variant={TextVariants.heading} className="mb-2">
            {t('adjustments.basic.scene.title')}
          </Text>
          <div className="flex flex-wrap items-center gap-1.5">
            {onAutoAdjust && (
              <button
                type="button"
                onClick={onAutoAdjust}
                data-tooltip={t('adjustments.basic.scene.autoDesc')}
                className={clsx(
                  'px-2.5 py-1 text-xs rounded-md transition-colors',
                  'bg-accent text-button-text hover:opacity-90',
                )}
              >
                {t('adjustments.basic.scene.auto')}
              </button>
            )}
            {SCENE_ENHANCE.map((preset) => (
              <button
                key={preset.labelKey}
                type="button"
                onClick={() => applySceneEnhance(preset)}
                className="px-2.5 py-1 text-xs rounded-md bg-surface-secondary text-text-secondary hover:bg-surface hover:text-text-primary transition-colors"
              >
                {t(preset.labelKey)}
              </button>
            ))}
          </div>
        </div>
      )}
      {hideTonemapper ? (
        <Slider
          label={t('adjustments.basic.evShift')}
          max={5}
          min={-5}
          onChange={(e: any) => handleAdjustmentChange(BasicAdjustment.Exposure, e.target.value)}
          step={0.01}
          value={adjustments.exposure}
          onDragStateChange={onDragStateChange}
        />
      ) : (
        <ToneMapperSwitch
          selectedMapper={adjustments.toneMapper || 'agx'}
          onMapperChange={handleToneMapperChange}
          evShiftValue={adjustments.exposure}
          onEvShiftChange={(value) => handleAdjustmentChange(BasicAdjustment.Exposure, value)}
          onDragStateChange={onDragStateChange}
        />
      )}
      <Slider
        label={t('adjustments.basic.exposure')}
        max={5}
        min={-5}
        onChange={(e: any) => handleAdjustmentChange(BasicAdjustment.Brightness, e.target.value)}
        step={0.01}
        value={adjustments.brightness}
        onDragStateChange={onDragStateChange}
      />
      <Slider
        label={t('adjustments.basic.contrast')}
        max={100}
        min={-100}
        onChange={(e: any) => handleAdjustmentChange(BasicAdjustment.Contrast, e.target.value)}
        step={1}
        value={adjustments.contrast}
        onDragStateChange={onDragStateChange}
      />
      <Slider
        label={t('adjustments.basic.highlights')}
        max={100}
        min={-100}
        onChange={(e: any) => handleAdjustmentChange(BasicAdjustment.Highlights, e.target.value)}
        step={1}
        value={adjustments.highlights}
        onDragStateChange={onDragStateChange}
      />
      <Slider
        label={t('adjustments.basic.shadows')}
        max={100}
        min={-100}
        onChange={(e: any) => handleAdjustmentChange(BasicAdjustment.Shadows, e.target.value)}
        step={1}
        value={adjustments.shadows}
        onDragStateChange={onDragStateChange}
      />
      <Slider
        label={t('adjustments.basic.whites')}
        max={100}
        min={-100}
        onChange={(e: any) => handleAdjustmentChange(BasicAdjustment.Whites, e.target.value)}
        step={1}
        value={adjustments.whites}
        onDragStateChange={onDragStateChange}
      />
      <Slider
        label={t('adjustments.basic.blacks')}
        max={100}
        min={-100}
        onChange={(e: any) => handleAdjustmentChange(BasicAdjustment.Blacks, e.target.value)}
        step={1}
        value={adjustments.blacks}
        onDragStateChange={onDragStateChange}
      />
    </div>
  );
}
