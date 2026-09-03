import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Slider from '../ui/Slider';
import CollapsibleSection from '../ui/CollapsibleSection';
import Text from '../ui/Text';
import { Adjustments, ChannelMixerSettings } from '../../utils/adjustments';
import { TextVariants } from '../../types/typography';

interface ChannelMixerProps {
  adjustments: Adjustments;
  setAdjustments: (a: Partial<Adjustments>) => void;
  isForMask?: boolean;
  onDragStateChange?: (isDragging: boolean) => void;
}

const defaultIdentity: ChannelMixerSettings = {
  red_from_red: 100,
  red_from_green: 0,
  red_from_blue: 0,
  green_from_red: 0,
  green_from_green: 100,
  green_from_blue: 0,
  blue_from_red: 0,
  blue_from_green: 0,
  blue_from_blue: 100,
};

interface ChannelRow {
  labelKey: string;
  color: string;
  outputs: Array<{ key: keyof ChannelMixerSettings; label: string }>;
}

const CHANNEL_ROWS: ChannelRow[] = [
  {
    labelKey: 'adjustments.channelMixer.red',
    color: '#ef4444',
    outputs: [
      { key: 'red_from_red', label: 'R' },
      { key: 'red_from_green', label: 'G' },
      { key: 'red_from_blue', label: 'B' },
    ],
  },
  {
    labelKey: 'adjustments.channelMixer.green',
    color: '#22c55e',
    outputs: [
      { key: 'green_from_red', label: 'R' },
      { key: 'green_from_green', label: 'G' },
      { key: 'green_from_blue', label: 'B' },
    ],
  },
  {
    labelKey: 'adjustments.channelMixer.blue',
    color: '#3b82f6',
    outputs: [
      { key: 'blue_from_red', label: 'R' },
      { key: 'blue_from_green', label: 'G' },
      { key: 'blue_from_blue', label: 'B' },
    ],
  },
];

export default function ChannelMixer({
  adjustments,
  setAdjustments,
  isForMask = false,
  onDragStateChange,
}: ChannelMixerProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(true);

  const current: ChannelMixerSettings = adjustments.channelMixer || defaultIdentity;
  const sectionVisible = adjustments.sectionVisibility?.channel !== false;

  const handleSliderChange =
    (key: keyof ChannelMixerSettings) => (e: { target: { value: string | number } }) => {
      setAdjustments({
        channelMixer: {
          ...current,
          [key]: Number(e.target.value),
        },
      });
    };

  const handleReset = () => {
    setAdjustments({
      channelMixer: { ...defaultIdentity },
    });
  };

  // 与 SplitToning 保持一致：将 reset 按钮直接放在内容区顶部，不使用可切换可见性
  const handleToggleVisibility = () => {
    // sectionVisibility.channel 由父组件维护时可在此触发
  };

  return (
    <CollapsibleSection
      title={t('adjustments.channelMixer.title', 'Channel Mixer / 通道混合器')}
      isOpen={isOpen}
      onToggle={() => setIsOpen(!isOpen)}
      isContentVisible={sectionVisible}
      onToggleVisibility={handleToggleVisibility}
      canToggleVisibility={false}
    >
      <div className="flex items-center justify-between mb-3">
        <Text variant={TextVariants.heading}>{t('adjustments.channelMixer.outputs', 'Output Channels / 输出通道')}</Text>
        <button
          type="button"
          onClick={handleReset}
          className="px-2.5 py-1 text-xs rounded-md bg-surface-secondary text-text-secondary hover:bg-surface hover:text-text-primary transition-colors"
          title={t('adjustments.channelMixer.reset', 'Reset / 重置')}
        >
          {t('adjustments.channelMixer.reset', 'Reset')}
        </button>
      </div>

      {/* 表头行：输入通道标签 */}
      <div className="grid grid-cols-[2.5rem_1fr_1fr_1fr] items-center gap-1 mb-2 px-1">
        <div />
        <div className="text-center">
          <div className="inline-flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-full bg-red-500" />
            <span className="text-xs text-text-secondary">R</span>
          </div>
        </div>
        <div className="text-center">
          <div className="inline-flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-full bg-green-500" />
            <span className="text-xs text-text-secondary">G</span>
          </div>
        </div>
        <div className="text-center">
          <div className="inline-flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-full bg-blue-500" />
            <span className="text-xs text-text-secondary">B</span>
          </div>
        </div>
      </div>

      {/* 3 行 × 3 列 滑块网格 */}
      <div className="space-y-2">
        {CHANNEL_ROWS.map((row) => (
          <div
            key={row.labelKey}
            className="grid grid-cols-[2.5rem_1fr_1fr_1fr] items-start gap-1"
          >
            {/* 输出通道彩色圆点标签 */}
            <div className="flex items-center justify-center pt-1">
              <span
                className="w-3 h-3 rounded-full"
                style={{ backgroundColor: row.color }}
                title={t(row.labelKey)}
              />
            </div>
            {row.outputs.map((output) => (
              <div key={output.key} className="min-w-0">
                <Slider
                  label={output.label}
                  min={-200}
                  max={200}
                  step={1}
                  defaultValue={defaultIdentity[output.key]}
                  value={current[output.key]}
                  onChange={handleSliderChange(output.key)}
                  onDragStateChange={onDragStateChange}
                />
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* 辅助说明 */}
      <div className="mt-3 text-[11px] text-text-secondary/70 leading-tight px-1">
        <p>{t('adjustments.channelMixer.hint', 'Adjust the percentage of each input color channel that contributes to the output channel.')}</p>
      </div>
    </CollapsibleSection>
  );
}
