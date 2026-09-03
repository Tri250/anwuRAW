import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Slider from '../ui/Slider';
import CollapsibleSection from '../ui/CollapsibleSection';
import ColorWheel from '../ui/ColorWheel';
import Switch from '../ui/Switch';
import Text from '../ui/Text';
import { TextVariants } from '../../types/typography';
import { Adjustments, SplitToningSettings, HueSatLum } from '../../utils/adjustments';

const defaultSplitToning: SplitToningSettings = {
  shadows_hue: 200,
  shadows_saturation: 20,
  highlights_hue: 40,
  highlights_saturation: 15,
  balance: 0,
  enabled: false,
};

interface SplitToningProps {
  adjustments: Adjustments;
  setAdjustments: (a: Partial<Adjustments>) => void;
  isForMask?: boolean;
  onDragStateChange?: (isDragging: boolean) => void;
}

const SplitToning = ({ adjustments, setAdjustments, isForMask = false, onDragStateChange }: SplitToningProps) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(true);

  const st: SplitToningSettings = adjustments.splitToning || defaultSplitToning;
  const sectionVisible = adjustments.sectionVisibility?.split_toning !== false;
  const contentVisible = st.enabled && sectionVisible;

  const handleToggleEnabled = () => {
    setAdjustments({ splitToning: { ...st, enabled: !st.enabled } });
  };

  const handleHighlightsHueSat = (val: HueSatLum) => {
    setAdjustments({
      splitToning: {
        ...st,
        highlights_hue: val.hue,
        highlights_saturation: val.saturation,
      },
    });
  };

  const handleShadowsHueSat = (val: HueSatLum) => {
    setAdjustments({
      splitToning: {
        ...st,
        shadows_hue: val.hue,
        shadows_saturation: val.saturation,
      },
    });
  };

  const handleBalanceChange = (e: { target: { value: number | string } }) => {
    setAdjustments({ splitToning: { ...st, balance: Number(e.target.value) } });
  };

  // 将 SplitToning 的 hue/saturation 组合成 ColorWheel 需要的 HueSatLum 格式
  const highlightsDefault: HueSatLum = {
    hue: defaultSplitToning.highlights_hue,
    saturation: defaultSplitToning.highlights_saturation,
    luminance: 0,
  };
  const shadowsDefault: HueSatLum = {
    hue: defaultSplitToning.shadows_hue,
    saturation: defaultSplitToning.shadows_saturation,
    luminance: 0,
  };
  const highlightsValue: HueSatLum = {
    hue: st.highlights_hue,
    saturation: st.highlights_saturation,
    luminance: 0,
  };
  const shadowsValue: HueSatLum = {
    hue: st.shadows_hue,
    saturation: st.shadows_saturation,
    luminance: 0,
  };

  return (
    <CollapsibleSection
      title={t('adjustments.splitToning.title', 'Split Toning / 分离色调')}
      isOpen={isOpen}
      onToggle={() => setIsOpen(!isOpen)}
      isContentVisible={contentVisible}
      onToggleVisibility={handleToggleEnabled}
      canToggleVisibility={true}
    >
      {/* enabled Switch */}
      <div className="mb-4">
        <Switch
          checked={st.enabled}
          label={t('adjustments.splitToning.enabled', 'Enable / 启用')}
          onChange={handleToggleEnabled}
        />
      </div>

      <div className={!contentVisible ? 'opacity-50 pointer-events-none' : ''}>
        {/* 高光区域 */}
        <div className="mb-4">
          <Text variant={TextVariants.heading} className="mb-2 block">
            {t('adjustments.splitToning.highlights', 'Highlights / 高光')}
          </Text>
          <div className="flex items-center gap-4">
            <div className="w-20 h-20 shrink-0">
              <ColorWheel
                defaultValue={highlightsDefault}
                label=""
                value={highlightsValue}
                onChange={handleHighlightsHueSat}
                onDragStateChange={onDragStateChange}
              />
            </div>
            <div className="flex-1 min-w-0">
              <Slider
                defaultValue={defaultSplitToning.highlights_saturation}
                label={t('adjustments.splitToning.saturation', 'Saturation')}
                max={100}
                min={0}
                step={1}
                value={st.highlights_saturation}
                onChange={(e: { target: { value: number | string } }) =>
                  setAdjustments({ splitToning: { ...st, highlights_saturation: Number(e.target.value) } })
                }
                onDragStateChange={onDragStateChange}
              />
            </div>
          </div>
        </div>

        {/* 阴影区域 */}
        <div className="mb-4">
          <Text variant={TextVariants.heading} className="mb-2 block">
            {t('adjustments.splitToning.shadows', 'Shadows / 阴影')}
          </Text>
          <div className="flex items-center gap-4">
            <div className="w-20 h-20 shrink-0">
              <ColorWheel
                defaultValue={shadowsDefault}
                label=""
                value={shadowsValue}
                onChange={handleShadowsHueSat}
                onDragStateChange={onDragStateChange}
              />
            </div>
            <div className="flex-1 min-w-0">
              <Slider
                defaultValue={defaultSplitToning.shadows_saturation}
                label={t('adjustments.splitToning.saturation', 'Saturation')}
                max={100}
                min={0}
                step={1}
                value={st.shadows_saturation}
                onChange={(e: { target: { value: number | string } }) =>
                  setAdjustments({ splitToning: { ...st, shadows_saturation: Number(e.target.value) } })
                }
                onDragStateChange={onDragStateChange}
              />
            </div>
          </div>
        </div>

        {/* Balance */}
        <div>
          <Slider
            defaultValue={defaultSplitToning.balance}
            label={t('adjustments.splitToning.balance', 'Balance / 平衡')}
            max={100}
            min={-100}
            step={1}
            value={st.balance}
            onChange={handleBalanceChange}
            onDragStateChange={onDragStateChange}
          />
        </div>
      </div>
    </CollapsibleSection>
  );
};

export default SplitToning;
