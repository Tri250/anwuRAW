import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowLeft, ArrowRight, Check, FolderInput, Keyboard, Sparkles } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import type { ParseKeys } from 'i18next';
import Text from '../ui/Text';
import { TextColors, TextVariants } from '../../types/typography';

interface OnboardingModalProps {
  isOpen: boolean;
  onClose(): void;
}

const TOTAL_STEPS = 3;

/** localStorage flag (via libraryUserData) marking that onboarding was shown. */
export const ONBOARDING_SEEN_KEY = 'onboarding.v1';

const CORE_SHORTCUTS: Array<{ labelKey: ParseKeys; keys: string }> = [
  { labelKey: 'onboarding.shortcuts.openImage', keys: 'Enter' },
  { labelKey: 'onboarding.shortcuts.toggleAdjustments', keys: 'D' },
  { labelKey: 'onboarding.shortcuts.toggleCrop', keys: 'R' },
  { labelKey: 'onboarding.shortcuts.toggleExport', keys: 'E' },
  { labelKey: 'onboarding.shortcuts.backToLibrary', keys: 'Esc' },
];

/**
 * E10: first-run onboarding. A three-step intro (choose a folder, try a
 * preset, learn five core shortcuts) shown once per installation; the
 * "already seen" flag lives in localStorage via libraryUserData.
 */
export default function OnboardingModal({ isOpen, onClose }: OnboardingModalProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState(0);

  if (!isOpen) return null;

  const stepIcons = [FolderInput, Sparkles, Keyboard];
  const StepIcon = stepIcons[step] ?? FolderInput;
  const isLastStep = step === TOTAL_STEPS - 1;

  const goNext = () => (isLastStep ? onClose() : setStep((prev) => Math.min(prev + 1, TOTAL_STEPS - 1)));
  const goBack = () => setStep((prev) => Math.max(prev - 1, 0));

  return (
    <AnimatePresence>
      <motion.div
        aria-modal="true"
        role="dialog"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-xs p-4"
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 12 }}
          transition={{ duration: 0.2 }}
          className="w-full max-w-md bg-surface rounded-xl shadow-2xl border border-border-color/50 p-6"
        >
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-lg bg-accent/15 text-accent flex items-center justify-center shrink-0">
              <StepIcon size={20} />
            </div>
            <div className="min-w-0">
              <Text variant={TextVariants.title}>{t('onboarding.title')}</Text>
              <Text variant={TextVariants.small} color={TextColors.secondary}>
                {t('onboarding.stepOf', { current: step + 1, total: TOTAL_STEPS })}
              </Text>
            </div>
          </div>

          <div className="min-h-[120px]">
            {step === 0 && (
              <div>
                <Text variant={TextVariants.heading} className="mb-1.5">
                  {t('onboarding.steps.folder.title')}
                </Text>
                <Text variant={TextVariants.small} color={TextColors.secondary}>
                  {t('onboarding.steps.folder.description')}
                </Text>
              </div>
            )}
            {step === 1 && (
              <div>
                <Text variant={TextVariants.heading} className="mb-1.5">
                  {t('onboarding.steps.preset.title')}
                </Text>
                <Text variant={TextVariants.small} color={TextColors.secondary}>
                  {t('onboarding.steps.preset.description')}
                </Text>
              </div>
            )}
            {step === 2 && (
              <div>
                <Text variant={TextVariants.heading} className="mb-2">
                  {t('onboarding.steps.shortcuts.title')}
                </Text>
                <div className="divide-y divide-border-color/60 rounded-md border border-border-color/60 overflow-hidden">
                  {CORE_SHORTCUTS.map(({ labelKey, keys }) => (
                    <div key={labelKey} className="flex items-center justify-between gap-3 px-3 py-2 bg-bg-primary/40">
                      <Text variant={TextVariants.small}>{t(labelKey)}</Text>
                      <span className="shrink-0 px-2 py-0.5 rounded bg-surface border border-border-color text-xs font-semibold text-text-primary">
                        {keys}
                      </span>
                    </div>
                  ))}
                </div>
                <Text variant={TextVariants.small} color={TextColors.secondary} className="mt-2">
                  {t('onboarding.steps.shortcuts.description')}
                </Text>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between mt-6">
            <div className="flex items-center gap-1.5">
              {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
                <button
                  key={i}
                  aria-label={t('onboarding.goToStep', { step: i + 1 })}
                  className={clsx(
                    'w-2 h-2 rounded-full transition-colors',
                    i === step ? 'bg-accent' : 'bg-border-color hover:bg-text-tertiary',
                  )}
                  onClick={() => setStep(i)}
                />
              ))}
            </div>
            <div className="flex items-center gap-2">
              <button
                className="px-3 py-2 rounded-md text-sm text-text-secondary hover:text-text-primary hover:bg-bg-primary transition-colors"
                onClick={onClose}
              >
                {t('onboarding.skip')}
              </button>
              {step > 0 && (
                <button
                  className="flex items-center gap-1.5 px-3 py-2 rounded-md text-sm bg-bg-primary text-text-primary hover:bg-card-active transition-colors"
                  onClick={goBack}
                >
                  <ArrowLeft size={15} />
                  {t('onboarding.back')}
                </button>
              )}
              <button
                className={clsx(
                  'flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-semibold transition-colors',
                  'bg-accent text-button-text hover:bg-accent-hover',
                )}
                onClick={goNext}
              >
                {isLastStep ? (
                  <>
                    <Check size={15} />
                    {t('onboarding.finish')}
                  </>
                ) : (
                  <>
                    {t('onboarding.next')}
                    <ArrowRight size={15} />
                  </>
                )}
              </button>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
