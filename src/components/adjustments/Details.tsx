import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import Slider from '../ui/Slider';
import Switch from '../ui/Switch';
import { Adjustments, DetailsAdjustment } from '../../utils/adjustments';
import { AppSettings } from '../ui/AppProperties';
import Text from '../ui/Text';
import { TextVariants } from '../../types/typography';
import { useEditorStore } from '../../store/useEditorStore';
import { useProcessStore } from '../../store/useProcessStore';

interface DetailsPanelProps {
  adjustments: Adjustments;
  setAdjustments(adjustments: Partial<Adjustments>): any;
  appSettings: AppSettings | null;
  isForMask?: boolean;
  onDragStateChange?: (isDragging: boolean) => void;
}

export default function DetailsPanel({
  adjustments,
  setAdjustments,
  appSettings,
  isForMask = false,
  onDragStateChange,
}: DetailsPanelProps) {
  const { t } = useTranslation();
  const aiDenoiseProgress = useEditorStore((state) =>
    state.selectedImage ? state.aiDenoiseProgress[state.selectedImage.path] : undefined,
  );
  const aiModelDownloadStatus = useProcessStore((state) => state.aiModelDownloadStatus);
  const setEditor = useEditorStore((state) => state.setEditor);

  const handleAdjustmentChange = (key: string, value: string) => {
    const numericValue = parseInt(value, 10);
    setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, [key]: numericValue }));
  };

  const adjustmentVisibility = appSettings?.adjustmentVisibility || {};

  return (
    <div className="space-y-4">
      {adjustmentVisibility.sharpening !== false && (
        <div className="p-2 bg-bg-tertiary rounded-md">
          <Text variant={TextVariants.heading} className="mb-2">
            {t('adjustments.details.sharpening')}
          </Text>
          <Slider
            label={t('adjustments.details.sharpness')}
            max={100}
            min={-100}
            onChange={(e: any) => handleAdjustmentChange(DetailsAdjustment.Sharpness, e.target.value)}
            step={1}
            value={adjustments.sharpness}
            onDragStateChange={onDragStateChange}
          />
          <Slider
            label={t('adjustments.details.threshold')}
            max={80}
            min={0}
            onChange={(e: any) => handleAdjustmentChange(DetailsAdjustment.SharpnessThreshold, e.target.value)}
            step={1}
            value={adjustments.sharpnessThreshold ?? 15}
            onDragStateChange={onDragStateChange}
            defaultValue={15}
            fillOrigin="min"
          />
        </div>
      )}

      {adjustmentVisibility.presence !== false && (
        <div className="p-2 bg-bg-tertiary rounded-md">
          <Text variant={TextVariants.heading} className="mb-2">
            {t('adjustments.details.presence')}
          </Text>
          <Slider
            label={t('adjustments.details.clarity')}
            max={100}
            min={-100}
            onChange={(e: any) => handleAdjustmentChange(DetailsAdjustment.Clarity, e.target.value)}
            step={1}
            value={adjustments.clarity}
            onDragStateChange={onDragStateChange}
          />
          <Slider
            label={t('adjustments.details.dehaze')}
            max={100}
            min={-100}
            onChange={(e: any) => handleAdjustmentChange(DetailsAdjustment.Dehaze, e.target.value)}
            step={1}
            value={adjustments.dehaze}
            onDragStateChange={onDragStateChange}
          />
          <Slider
            label={t('adjustments.details.structure')}
            max={100}
            min={-100}
            onChange={(e: any) => handleAdjustmentChange(DetailsAdjustment.Structure, e.target.value)}
            step={1}
            value={adjustments.structure}
            onDragStateChange={onDragStateChange}
          />
          {!isForMask && (
            <div data-center-marker-controls="centre" onPointerDown={() => setEditor({ activeCenterMarker: 'centre' })}>
              <Slider
                label={t('adjustments.details.centre')}
                max={100}
                min={-100}
                onChange={(e: any) => handleAdjustmentChange(DetailsAdjustment.Centré, e.target.value)}
                step={1}
                value={adjustments.centré}
                onDragStateChange={onDragStateChange}
              />
            </div>
          )}
        </div>
      )}

      {adjustmentVisibility.noiseReduction !== false && (
        <div className="p-2 bg-bg-tertiary rounded-md">
          <Text variant={TextVariants.heading} className="mb-2">
            {t('adjustments.details.noiseReduction')}
          </Text>
          <Slider
            label={t('adjustments.details.luminance')}
            max={100}
            min={isForMask ? -100 : 0}
            onChange={(e: any) => handleAdjustmentChange(DetailsAdjustment.LumaNoiseReduction, e.target.value)}
            step={1}
            value={adjustments.lumaNoiseReduction}
            onDragStateChange={onDragStateChange}
          />
          <Slider
            label={t('adjustments.details.color')}
            max={100}
            min={isForMask ? -100 : 0}
            onChange={(e: any) => handleAdjustmentChange(DetailsAdjustment.ColorNoiseReduction, e.target.value)}
            step={1}
            value={adjustments.colorNoiseReduction}
            onDragStateChange={onDragStateChange}
          />

          {/* 非破坏性 AI 降噪（NIND）：开关 + 强度/细节滑块，后台生成期间显示进度 */}
          {!isForMask && (
            <div className="mt-2">
              <Switch
                label={t('adjustments.details.aiDenoise')}
                checked={!!adjustments.aiDenoiseEnabled}
                onChange={(enabled: boolean) =>
                  setAdjustments((prev: Partial<Adjustments>) => ({ ...prev, aiDenoiseEnabled: enabled }))
                }
              />

              <div
                className={`grid transition-all duration-300 ease-in-out ${
                  adjustments.aiDenoiseEnabled ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
                }`}
              >
                <div className="overflow-hidden">
                  <div className="space-y-4 pt-4 pb-1">
                    {aiDenoiseProgress !== undefined ? (
                      <div
                        className="flex flex-col items-center justify-center gap-1 p-4 text-text-secondary text-center"
                        data-tooltip={aiModelDownloadStatus ? undefined : t('modals.denoise.gpuWarningTooltip')}
                      >
                        <div className="flex items-center gap-2">
                          <Loader2 size={16} className="animate-spin shrink-0" />
                          <Text variant={TextVariants.label}>
                            {aiModelDownloadStatus
                              ? t('editor.masks.settings.aiModelDownloading')
                              : t('editor.ai.denoising')}
                          </Text>
                        </div>
                        <Text variant={TextVariants.small} className="text-accent">
                          {aiModelDownloadStatus || `${Math.round(aiDenoiseProgress * 100)}%`}
                        </Text>
                      </div>
                    ) : (
                      <>
                        <Slider
                          label={t('adjustments.effects.amount')}
                          max={100}
                          min={0}
                          defaultValue={100}
                          onChange={(e: any) =>
                            handleAdjustmentChange(DetailsAdjustment.AiDenoiseAmount, e.target.value)
                          }
                          step={1}
                          value={adjustments.aiDenoiseAmount ?? 100}
                          onDragStateChange={onDragStateChange}
                          fillOrigin="min"
                        />
                        <Slider
                          label={t('adjustments.details.aiDenoiseDetail')}
                          max={100}
                          min={0}
                          defaultValue={0}
                          onChange={(e: any) =>
                            handleAdjustmentChange(DetailsAdjustment.AiDenoiseDetail, e.target.value)
                          }
                          step={1}
                          value={adjustments.aiDenoiseDetail ?? 0}
                          onDragStateChange={onDragStateChange}
                        />
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {!isForMask && adjustmentVisibility.chromaticAberration !== false && (
        <div className="p-2 bg-bg-tertiary rounded-md">
          <Text variant={TextVariants.heading} className="mb-2">
            {t('adjustments.details.chromaticAberration')}
          </Text>
          <Slider
            label={t('adjustments.details.redCyan')}
            max={100}
            min={-100}
            onChange={(e: any) => handleAdjustmentChange(DetailsAdjustment.ChromaticAberrationRedCyan, e.target.value)}
            step={1}
            value={adjustments.chromaticAberrationRedCyan}
            onDragStateChange={onDragStateChange}
          />
          <Slider
            label={t('adjustments.details.blueYellow')}
            max={100}
            min={-100}
            onChange={(e: any) =>
              handleAdjustmentChange(DetailsAdjustment.ChromaticAberrationBlueYellow, e.target.value)
            }
            step={1}
            value={adjustments.chromaticAberrationBlueYellow}
            onDragStateChange={onDragStateChange}
          />
        </div>
      )}
    </div>
  );
}
