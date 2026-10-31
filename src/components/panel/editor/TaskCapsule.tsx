import { useState, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronDown, Loader2, TriangleAlert, X } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import { Job, JobStatus, isJobActive, useProcessStore } from '../../../store/useProcessStore';
import Text from '../../ui/Text';
import { TextColors, TextVariants } from '../../../types/typography';

const formatProgress = (job: Job) => {
  const { current, total } = job.progress;
  if (!total || total <= 0) return null;
  return `${Math.round((Math.min(current ?? 0, total) / total) * 100)}%`;
};

const statusStyles: Partial<Record<JobStatus, string>> = {
  [JobStatus.Success]: 'text-green-400',
  [JobStatus.Error]: 'text-red-400',
  [JobStatus.Cancelled]: 'text-text-secondary',
  [JobStatus.Cancelling]: 'text-text-secondary',
};

/**
 * E7: floating task capsule for the editor view. Collapsed, it is a small pill
 * showing how many jobs are running; expanded it lists active and recently
 * finished jobs (import/export/copy/move/AI) with progress, errors and a
 * clear-history action. Jobs live in the shared useProcessStore so they are
 * the same instances the library's JobsMenu renders.
 */
export default function TaskCapsule() {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(false);
  const jobs = useProcessStore((s) => s.jobs);
  const clearFinishedJobs = useProcessStore((s) => s.clearFinishedJobs);

  const activeJobs = useMemo(() => Object.values(jobs).filter((job) => isJobActive(job.status)), [jobs]);
  const finishedJobs = useMemo(
    () =>
      Object.values(jobs)
        .filter((job) => !isJobActive(job.status))
        .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0)),
    [jobs],
  );

  if (activeJobs.length === 0 && finishedJobs.length === 0) return null;

  const renderJob = (job: Job) => {
    const isActive = isJobActive(job.status);
    const percent = formatProgress(job);
    const isIndeterminate = isActive && !percent;

    return (
      <div key={job.id} className="px-3 py-2 rounded-md bg-bg-primary/60 border border-border-color/40">
        <div className="flex items-center gap-2 min-w-0">
          {isActive ? (
            <Loader2 size={14} className="animate-spin text-accent shrink-0" />
          ) : job.status === JobStatus.Success ? (
            <Check size={14} className="text-green-400 shrink-0" />
          ) : job.status === JobStatus.Error ? (
            <TriangleAlert size={14} className="text-red-400 shrink-0" />
          ) : (
            <X size={14} className="text-text-secondary shrink-0" />
          )}
          <Text variant={TextVariants.small} className="truncate">
            {t(`library.jobs.kinds.${job.kind}`)}
          </Text>
          <Text
            variant={TextVariants.small}
            color={TextColors.secondary}
            className={clsx('ml-auto shrink-0 tabular-nums', statusStyles[job.status])}
          >
            {t(`library.jobs.statuses.${job.status}`)}
          </Text>
        </div>
        {job.detail && (
          <Text variant={TextVariants.small} color={TextColors.secondary} className="truncate mt-0.5 pl-6">
            {job.detail}
          </Text>
        )}
        {(percent || isIndeterminate) && (
          <div className="mt-1.5 h-1 rounded-full bg-surface overflow-hidden ml-6 mr-1">
            {percent ? (
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-300"
                style={{ width: percent }}
              />
            ) : (
              <div className="h-full w-1/3 rounded-full bg-accent/60 animate-pulse" />
            )}
          </div>
        )}
        {job.error && (
          <Text variant={TextVariants.small} color={TextColors.secondary} className="mt-1 pl-6 break-words line-clamp-2 text-red-400/90">
            {job.error}
          </Text>
        )}
      </div>
    );
  };

  return (
    <div className="absolute bottom-3 right-3 z-40 flex flex-col items-end gap-2">
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.97 }}
            transition={{ duration: 0.15 }}
            className="w-80 max-h-96 overflow-y-auto custom-scrollbar bg-surface/95 backdrop-blur-md rounded-lg shadow-2xl border border-border-color/50 p-2"
          >
            <div className="flex items-center justify-between px-1 pb-1">
              <Text variant={TextVariants.label}>{t('library.jobs.title')}</Text>
              {finishedJobs.length > 0 && (
                <button
                  className="text-xs text-text-secondary hover:text-text-primary transition-colors"
                  onClick={clearFinishedJobs}
                >
                  {t('library.jobs.clear')}
                </button>
              )}
            </div>
            {activeJobs.length > 0 ? (
              <div className="flex flex-col gap-1.5">{activeJobs.map(renderJob)}</div>
            ) : (
              <Text variant={TextVariants.small} color={TextColors.secondary} className="px-1 py-2">
                {t('library.jobs.noActive')}
              </Text>
            )}
            {finishedJobs.length > 0 && (
              <>
                <Text variant={TextVariants.small} color={TextColors.secondary} className="px-1 pt-2 pb-1">
                  {t('library.jobs.recent')}
                </Text>
                <div className="flex flex-col gap-1.5">{finishedJobs.map(renderJob)}</div>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
      <button
        className={clsx(
          'flex items-center gap-2 h-10 px-3.5 rounded-full bg-surface/95 backdrop-blur-md shadow-2xl border border-border-color/50 text-text-primary transition-colors hover:bg-card-active',
          activeJobs.length > 0 && 'border-accent/60',
        )}
        data-tooltip={t('library.jobs.title')}
        onClick={() => setIsExpanded((prev) => !prev)}
      >
        {activeJobs.length > 0 ? (
          <Loader2 size={16} className="animate-spin text-accent shrink-0" />
        ) : (
          <Check size={16} className="text-green-400 shrink-0" />
        )}
        <span className="text-xs font-medium tabular-nums">
          {activeJobs.length > 0
            ? t('library.jobs.activeCount', { count: activeJobs.length })
            : t('library.jobs.allDone', { count: finishedJobs.length })}
        </span>
        <ChevronDown size={14} className={clsx('text-text-secondary transition-transform', isExpanded && 'rotate-180')} />
      </button>
    </div>
  );
}
