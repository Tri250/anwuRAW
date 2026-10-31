import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Ban, ChevronLeft, ChevronRight, Columns2, Expand, Flag, Star, X } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../../store/useUIStore';
import { useLibraryStore } from '../../../store/useLibraryStore';
import { useProcessStore } from '../../../store/useProcessStore';
import { pushExitLayer, removeExitLayer } from '../../../utils/androidBackRegistry';
import { ImageFlag } from '../../ui/AppProperties';
import Text from '../../ui/Text';
import { TextColors, TextVariants } from '../../../types/typography';

interface SurveyViewProps {
  requestThumbnails: (paths: string[]) => void;
  onImageSelect: (path: string) => void;
  onSetFlag: (flag: ImageFlag | null, paths?: string[]) => void;
  onRate: (rating: number, paths?: string[]) => void;
}

const basename = (path: string) => path.split('?vc=')[0].split(/[\\/]/).pop() || path;

/**
 * Full-screen survey (rapid cull) mode: fly through the current view one image
 * at a time and pick/reject/rate without leaving the view. `C` toggles a
 * two-up compare layout for picking between a pair.
 */
export default function SurveyView({ requestThumbnails, onImageSelect, onSetFlag, onRate }: SurveyViewProps) {
  const { t } = useTranslation();
  const isOpen = useUIStore((s) => s.surveyMode.isOpen);
  const paths = useUIStore((s) => s.surveyMode.paths);
  const title = useUIStore((s) => s.surveyMode.title);
  const startInCompare = useUIStore((s) => s.surveyMode.startInCompare);
  const setUI = useUIStore((s) => s.setUI);

  const imageRatings = useLibraryStore((s) => s.imageRatings);
  const imageList = useLibraryStore((s) => s.imageList);
  const mediumThumbnails = useProcessStore((s) => s.mediumThumbnails);
  const thumbnails = useProcessStore((s) => s.thumbnails);

  const [index, setIndex] = useState(0);
  const [isCompare, setIsCompare] = useState(false);
  const [challengerIndex, setChallengerIndex] = useState(1);
  const [activePane, setActivePane] = useState<'anchor' | 'challenger'>('anchor');

  const requestedRef = useRef(new Set<string>());
  const containerRef = useRef<HTMLDivElement>(null);

  const flagsByPath = useMemo(() => {
    const map: Record<string, string | null> = {};
    imageList.forEach((img) => {
      map[img.path] = img.flag ?? null;
    });
    return map;
  }, [imageList]);

  const close = useCallback(() => {
    setUI({ surveyMode: { isOpen: false, paths: [], title: null, startInCompare: false } });
  }, [setUI]);

  // E18: while open, the Android back button pops this overlay first.
  useEffect(() => {
    if (!isOpen) return;
    pushExitLayer(close);
    return () => removeExitLayer(close);
  }, [isOpen, close]);

  useEffect(() => {
    if (isOpen) {
      setIndex(0);
      // Dual-window compare entry (library header): open straight into the
      // two-up layout when there is something to compare against.
      setIsCompare(!!startInCompare && paths.length > 1);
      setChallengerIndex(Math.min(1, Math.max(0, paths.length - 1)));
      setActivePane('anchor');
      requestedRef.current = new Set();
      const timer = setTimeout(() => containerRef.current?.focus(), 0);
      return () => clearTimeout(timer);
    }
  }, [isOpen, paths.length, startInCompare]);

  const getUrl = useCallback(
    (path: string) => mediumThumbnails[path] || thumbnails[path],
    [mediumThumbnails, thumbnails],
  );

  useEffect(() => {
    if (!isOpen || paths.length === 0) return;
    const wanted: string[] = [];
    const push = (path: string) => {
      if (path && !getUrl(path) && !requestedRef.current.has(path)) {
        requestedRef.current.add(path);
        wanted.push(path);
      }
    };
    for (let offset = -1; offset <= 6; offset++) {
      push(paths[(index + offset + paths.length) % paths.length]);
    }
    if (isCompare) push(paths[challengerIndex]);
    if (wanted.length > 0) requestThumbnails(wanted);
  }, [isOpen, paths, index, challengerIndex, isCompare, getUrl, requestThumbnails]);

  const goNext = useCallback(() => {
    if (paths.length === 0) return;
    if (isCompare) {
      setChallengerIndex((prev) => (prev + 1) % paths.length);
    } else {
      setIndex((prev) => (prev + 1) % paths.length);
    }
  }, [isCompare, paths.length]);

  const goPrev = useCallback(() => {
    if (paths.length === 0) return;
    if (isCompare) {
      setChallengerIndex((prev) => (prev - 1 + paths.length) % paths.length);
    } else {
      setIndex((prev) => (prev - 1 + paths.length) % paths.length);
    }
  }, [isCompare, paths.length]);

  const promoteChallenger = useCallback(() => {
    if (!isCompare) return;
    setIndex(challengerIndex);
    setChallengerIndex((prev) => {
      const next = (prev + 1) % paths.length;
      return next === challengerIndex ? (next + 1) % paths.length : next;
    });
    setActivePane('anchor');
  }, [challengerIndex, isCompare, paths.length]);

  const activePath = isCompare && activePane === 'challenger' ? paths[challengerIndex] : paths[index];

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = activePath ? [activePath] : undefined;

      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          e.stopPropagation();
          if (isCompare) setIsCompare(false);
          else close();
          break;
        case 'ArrowRight':
        case 'd':
        case 'D':
          e.preventDefault();
          e.stopPropagation();
          goNext();
          break;
        case 'ArrowLeft':
        case 'a':
        case 'A':
          e.preventDefault();
          e.stopPropagation();
          goPrev();
          break;
        case 'p':
        case 'P':
          if (target) onSetFlag(ImageFlag.Pick, target);
          break;
        case 'x':
        case 'X':
          if (target) onSetFlag(ImageFlag.Reject, target);
          break;
        case 'u':
        case 'U':
          if (target) onSetFlag(null, target);
          break;
        case 'Tab':
          if (isCompare) {
            e.preventDefault();
            e.stopPropagation();
            setActivePane((prev) => (prev === 'anchor' ? 'challenger' : 'anchor'));
          }
          break;
        case 'c':
        case 'C':
          e.preventDefault();
          e.stopPropagation();
          setIsCompare((prev) => !prev);
          break;
        case 's':
        case 'S':
          e.preventDefault();
          e.stopPropagation();
          promoteChallenger();
          break;
        case 'Enter':
          e.preventDefault();
          e.stopPropagation();
          if (activePath) {
            close();
            onImageSelect(activePath);
          }
          break;
        default:
          if (/^[0-5]$/.test(e.key)) {
            e.preventDefault();
            e.stopPropagation();
            if (target) onRate(parseInt(e.key, 10), target);
          }
          break;
      }
    },
    [activePath, close, goNext, goPrev, isCompare, onImageSelect, onRate, onSetFlag, promoteChallenger],
  );

  if (!isOpen) return null;

  const anchorPath = paths[index];
  const challengerPath = paths[challengerIndex];

  const renderPane = (path: string | undefined, paneRole: 'anchor' | 'challenger', position: number) => {
    const isActive = !isCompare || activePane === paneRole;
    const flag = path ? flagsByPath[path] : null;
    const rating = path ? imageRatings[path] || 0 : 0;
    const url = path ? getUrl(path) : undefined;

    return (
      <div
        className={clsx(
          'relative flex-1 min-w-0 flex items-center justify-center overflow-hidden rounded-lg bg-bg-primary/60',
          isCompare && (isActive ? 'ring-2 ring-accent' : 'ring-1 ring-border-color opacity-80'),
        )}
        onClick={() => isCompare && setActivePane(paneRole)}
      >
        {url ? (
          <img
            alt={path ? basename(path) : ''}
            className="max-w-full max-h-full object-contain select-none"
            draggable={false}
            src={url}
          />
        ) : (
          <div className="w-full h-full max-h-[60vh] flex items-center justify-center">
            <span className="w-10 h-10 rounded-full border-2 border-border-color border-t-accent animate-spin" />
          </div>
        )}
        {path && (
          <div className="absolute top-3 left-3 flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-black/55 backdrop-blur-xs max-w-[70%]">
            {flag === ImageFlag.Pick && <Flag size={13} className="text-green-400 shrink-0" />}
            {flag === ImageFlag.Reject && <Ban size={13} className="text-red-400 shrink-0" />}
            {rating > 0 && (
              <span className="flex items-center gap-0.5 shrink-0">
                {Array.from({ length: rating }).map((_, i) => (
                  <Star key={i} size={12} className="text-yellow-400 fill-yellow-400" />
                ))}
              </span>
            )}
            <span className="text-xs text-white/90 truncate">{basename(path)}</span>
          </div>
        )}
        {isCompare && (
          <div className="absolute top-3 right-3 px-2 py-1 rounded bg-black/55 text-[10px] font-semibold uppercase tracking-wider text-white/90">
            {position + 1}
          </div>
        )}
      </div>
    );
  };

  return (
    <AnimatePresence>
      <motion.div
        ref={containerRef}
        autoFocus
        tabIndex={-1}
        animate={{ opacity: 1 }}
        className="fixed inset-0 z-50 flex flex-col bg-bg-primary/97 backdrop-blur-md outline-none"
        exit={{ opacity: 0 }}
        initial={{ opacity: 0 }}
        onKeyDown={handleKeyDown}
        transition={{ duration: 0.15 }}
      >
        <div className="flex items-center gap-3 px-4 h-14 shrink-0 border-b border-border-color/40">
          <Expand size={18} className="text-text-secondary shrink-0" />
          <div className="min-w-0 flex-1">
            <Text variant={TextVariants.label} className="truncate">
              {title || t('survey.title')}
            </Text>
          </div>
          <Text variant={TextVariants.small} color={TextColors.secondary} className="tabular-nums shrink-0">
            {isCompare ? `${index + 1} · ${challengerIndex + 1}` : index + 1} / {paths.length}
          </Text>
          <button
            className={clsx(
              'p-2 rounded-md transition-colors text-text-secondary hover:bg-surface hover:text-text-primary',
              isCompare && 'bg-card-active text-text-primary',
            )}
            data-tooltip={t('survey.compareToggle')}
            onClick={() => setIsCompare((prev) => !prev)}
          >
            <Columns2 size={18} />
          </button>
          <button
            className="p-2 rounded-md transition-colors text-text-secondary hover:bg-surface hover:text-text-primary"
            data-tooltip={t('survey.close')}
            onClick={close}
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 min-h-0 flex gap-2 p-3">
          {renderPane(anchorPath, 'anchor', index)}
          {isCompare && renderPane(challengerPath, 'challenger', challengerIndex)}
        </div>

        <div className="shrink-0 px-4 pb-3 flex items-center justify-center gap-2">
          <button
            className="p-2 rounded-md text-text-secondary hover:bg-surface hover:text-text-primary transition-colors"
            data-tooltip={t('survey.prev')}
            onClick={goPrev}
          >
            <ChevronLeft size={20} />
          </button>
          <button
            className={clsx(
              'flex items-center gap-1.5 px-3 py-2 rounded-md text-sm transition-colors',
              flagsByPath[activePath ?? ''] === ImageFlag.Pick
                ? 'bg-green-500/20 text-green-400'
                : 'text-text-secondary hover:bg-surface hover:text-text-primary',
            )}
            data-tooltip={t('survey.actions.pick')}
            onClick={() => activePath && onSetFlag(ImageFlag.Pick, [activePath])}
          >
            <Flag size={15} />
            P
          </button>
          <button
            className={clsx(
              'flex items-center gap-1.5 px-3 py-2 rounded-md text-sm transition-colors',
              flagsByPath[activePath ?? ''] === ImageFlag.Reject
                ? 'bg-red-500/20 text-red-400'
                : 'text-text-secondary hover:bg-surface hover:text-text-primary',
            )}
            data-tooltip={t('survey.actions.reject')}
            onClick={() => activePath && onSetFlag(ImageFlag.Reject, [activePath])}
          >
            <Ban size={15} />
            X
          </button>
          <button
            className="px-3 py-2 rounded-md text-sm text-text-secondary hover:bg-surface hover:text-text-primary transition-colors"
            data-tooltip={t('survey.actions.unflag')}
            onClick={() => activePath && onSetFlag(null, [activePath])}
          >
            U
          </button>
          <div className="flex items-center gap-0.5 px-2">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                className={clsx('p-1 transition-colors', (imageRatings[activePath ?? ''] || 0) >= n ? 'text-yellow-400' : 'text-text-secondary/50 hover:text-yellow-400')}
                data-tooltip={t('survey.actions.rate', { rating: n })}
                onClick={() => activePath && onRate(n, [activePath])}
              >
                <Star size={15} className={clsx((imageRatings[activePath ?? ''] || 0) >= n && 'fill-yellow-400')} />
              </button>
            ))}
          </div>
          <button
            className="p-2 rounded-md text-text-secondary hover:bg-surface hover:text-text-primary transition-colors"
            data-tooltip={t('survey.next')}
            onClick={goNext}
          >
            <ChevronRight size={20} />
          </button>
        </div>

        <div className="shrink-0 px-4 pb-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
          {([
            ['survey.hints.navigate', '←/→'],
            ['survey.hints.pick', 'P'],
            ['survey.hints.reject', 'X'],
            ['survey.hints.unflag', 'U'],
            ['survey.hints.rate', '0–5'],
            ['survey.hints.compare', 'C'],
            ['survey.hints.open', 'Enter'],
            ['survey.hints.exit', 'Esc'],
          ] as const).map(([key, keys]) => (
            <Text key={key} variant={TextVariants.small} color={TextColors.secondary} className="whitespace-nowrap">
              <span className="font-semibold text-text-primary/80">{keys}</span> {t(key)}
            </Text>
          ))}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
