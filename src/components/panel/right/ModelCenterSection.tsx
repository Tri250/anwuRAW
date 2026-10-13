// W9-I4 模型状态中心：装 / 下载 / 更新全程 UI（AIPanel 常驻段）。
// 数据源：model_status_list（manifest × 本地三态 sha256 扫描，W7-G1 diff_local_models）。
// 下载：download_optional_model（与能力惰性下载同链路，幂等、断点续传、哈希校验）。
// 事件：ai-model-download-start/finish/error 驱动进行中与失败态（离线文案，端侧零云依赖）。
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  HardDriveDownload,
  Loader2,
  RefreshCw,
  WifiOff,
} from 'lucide-react';

import CollapsibleSection from '../../ui/CollapsibleSection';
import Text from '../../ui/Text';
import { TextColors, TextVariants, TextWeights } from '../../../types/typography';
import { Invokes } from '../../ui/AppProperties';

export interface ModelStatusEntry {
  modelId: string;
  displayName: string;
  purpose: string;
  filename: string;
  sizeBytes: number | null;
  optional: boolean;
  state: 'missing' | 'intact' | 'corrupted';
}

export function formatModelSize(bytes: number | null): string {
  if (!bytes || bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB`;
}

export default function ModelCenterSection() {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [entries, setEntries] = useState<ModelStatusEntry[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [downloadingIds, setDownloadingIds] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, 'offline' | 'failed'>>({});

  const loadList = useCallback(async () => {
    setIsLoading(true);
    setLoadFailed(false);
    try {
      const list = await invoke<ModelStatusEntry[]>(Invokes.ModelStatusList);
      setEntries(list);
    } catch {
      setLoadFailed(true);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const handleToggle = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      if (next && entries === null && !loadFailed) {
        loadList();
      }
      return next;
    });
  }, [entries, loadFailed, loadList]);

  useEffect(() => {
    if (!expanded) return;
    const unlisteners = [
      listen('ai-model-download-finish', () => {
        loadList();
      }),
      listen('ai-model-download-error', (event: any) => {
        const payload = event?.payload ?? {};
        const modelId = typeof payload.model === 'string' ? payload.model : '';
        const reason = payload.reason === 'offline' ? 'offline' : 'failed';
        setDownloadingIds((prev) => {
          if (prev.size === 0) return prev;
          const next = new Set(prev);
          next.clear();
          return next;
        });
        setErrors((prev) => ({ ...prev, [modelId]: reason }));
      }),
    ];
    return () => {
      unlisteners.forEach((p) => p.then((fn) => fn()));
    };
  }, [expanded, loadList]);

  const handleDownload = useCallback(async (modelId: string) => {
    setErrors((prev) => {
      if (!(modelId in prev)) return prev;
      const next = { ...prev };
      delete next[modelId];
      return next;
    });
    setDownloadingIds((prev) => new Set(prev).add(modelId));
    try {
      await invoke(Invokes.DownloadOptionalModel, { id: modelId });
      setEntries(await invoke<ModelStatusEntry[]>(Invokes.ModelStatusList));
    } catch {
      setErrors((prev) => ({ ...prev, [modelId]: 'failed' }));
    } finally {
      setDownloadingIds((prev) => {
        const next = new Set(prev);
        next.delete(modelId);
        return next;
      });
    }
  }, []);

  return (
    <CollapsibleSection
      title={t('editor.ai.modelCenter.title')}
      isOpen={expanded}
      onToggle={handleToggle}
      canToggleVisibility={false}
      isContentVisible={true}
    >
      {expanded && (
        <div className="space-y-2" data-testid="model-center">
          <div className="flex items-center justify-between">
            <Text variant={TextVariants.small} color={TextColors.secondary}>
              {t('editor.ai.modelCenter.description')}
            </Text>
            <button
              type="button"
              className="p-1.5 rounded-md hover:bg-card-active transition-colors"
              onClick={loadList}
              data-tooltip={t('editor.ai.modelCenter.refresh')}
              aria-label={t('editor.ai.modelCenter.refresh')}
            >
              <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
            </button>
          </div>

          {loadFailed && (
            <Text variant={TextVariants.small} color={TextColors.secondary} className="p-2">
              {t('editor.ai.modelCenter.loadFailed')}
            </Text>
          )}

          {(entries ?? []).map((entry) => {
            const isDownloading = downloadingIds.has(entry.modelId);
            const error = errors[entry.modelId];
            return (
              <div
                key={entry.modelId}
                className="flex items-center gap-2 p-2 rounded-md bg-card-active/60 border border-surface"
                data-testid={`model-row-${entry.modelId}`}
              >
                <div className="shrink-0">
                  {isDownloading ? (
                    <Loader2 size={16} className="animate-spin text-accent" />
                  ) : entry.state === 'intact' ? (
                    <CheckCircle2 size={16} className="text-green-500" />
                  ) : entry.state === 'corrupted' ? (
                    <AlertTriangle size={16} className="text-amber-500" />
                  ) : (
                    <HardDriveDownload size={16} className="text-text-secondary" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <Text variant={TextVariants.small} weight={TextWeights.medium} className="truncate">
                      {entry.displayName}
                    </Text>
                    {entry.optional && (
                      <Text
                        as="span"
                        variant={TextVariants.small}
                        color={TextColors.secondary}
                        className="shrink-0 px-1 rounded-sm bg-surface text-[9px]"
                      >
                        {t('editor.ai.modelCenter.optionalBadge')}
                      </Text>
                    )}
                  </div>
                  <Text variant={TextVariants.small} color={TextColors.secondary} className="truncate text-[10px]">
                    {[
                      formatModelSize(entry.sizeBytes),
                      isDownloading
                        ? t('editor.ai.modelCenter.state.downloading')
                        : entry.state === 'intact'
                          ? t('editor.ai.modelCenter.state.installed')
                          : entry.state === 'corrupted'
                            ? t('editor.ai.modelCenter.state.corrupted')
                            : t('editor.ai.modelCenter.state.missing'),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                  {error && (
                    <Text
                      variant={TextVariants.small}
                      color={TextColors.secondary}
                      className="flex items-center gap-1 text-amber-500"
                      data-testid={`model-error-${entry.modelId}`}
                    >
                      <WifiOff size={10} />
                      {error === 'offline'
                        ? t('editor.ai.modelCenter.offlineError')
                        : t('editor.ai.modelCenter.failedError')}
                    </Text>
                  )}
                </div>
                {entry.state !== 'intact' && (
                  <button
                    type="button"
                    className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-md text-xs bg-accent/15 hover:bg-accent/25 text-accent transition-colors disabled:opacity-50"
                    disabled={isDownloading}
                    onClick={() => handleDownload(entry.modelId)}
                    aria-label={t(
                      entry.state === 'corrupted'
                        ? 'editor.ai.modelCenter.redownload'
                        : 'editor.ai.modelCenter.download',
                    )}
                  >
                    <Download size={12} />
                    {t(
                      entry.state === 'corrupted'
                        ? 'editor.ai.modelCenter.redownload'
                        : 'editor.ai.modelCenter.download',
                    )}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </CollapsibleSection>
  );
}
