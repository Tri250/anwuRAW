import { useState, useMemo, useCallback, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { ArrowLeft, CheckCircle2, Download, FileImage, Loader2, Sparkles, Wand2, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Button from '../ui/Button';
import Text from '../ui/Text';
import { TextColors, TextVariants, TextWeights } from '../../types/typography';
import Dropdown from '../ui/Dropdown';
import clsx from 'clsx';
import { Invokes, ImageFile, Preset } from '../ui/AppProperties';
import { ExportSettings, Status, FILE_FORMATS, FileFormats } from '../ui/ExportImportProperties';
import { COPYABLE_ADJUSTMENT_KEYS, INITIAL_ADJUSTMENTS } from '../../utils/adjustments';
import { useProcessStore } from '../../store/useProcessStore';
import { useSettingsStore } from '../../store/useSettingsStore';

interface StudioPageProps {
  onBackToLibrary: () => void;
  imageList: ImageFile[];
  currentFolderPath: string | null;
  rootPaths: Array<string>;
}

type Phase = 'idle' | 'loadingSample' | 'applying' | 'choosingFolder' | 'exporting' | 'done' | 'error';

const fileBasename = (path: string) => path.split(/[\\/]/).pop() || path;

const StudioPage = ({ onBackToLibrary, imageList, currentFolderPath, rootPaths }: StudioPageProps) => {
  const { t } = useTranslation();
  const thumbnails = useProcessStore((s) => s.thumbnails);
  const exportState = useProcessStore((s) => s.exportState);
  const appSettings = useSettingsStore((s) => s.appSettings);

  const [samplePath, setSamplePath] = useState<string | null>(null);
  const [sampleAdjustments, setSampleAdjustments] = useState<Record<string, any> | null>(null);
  const [presets, setPresets] = useState<Array<Preset>>([]);
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [clientPaths, setClientPaths] = useState<Array<string>>([]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [appliedCount, setAppliedCount] = useState(0);

  const localImages = useMemo(() => imageList.filter((img) => !img.is_cloud_placeholder), [imageList]);

  const loadPresets = useCallback(async () => {
    try {
      const loaded: Array<{ preset?: Preset }> = await invoke(Invokes.LoadPresets);
      setPresets(
        loaded
          .map((entry) => entry.preset)
          .filter((p): p is Preset => !!p && p.presetType !== 'tool' && !!p.adjustments),
      );
    } catch (error) {
      console.error('Failed to load presets:', error);
    }
  }, []);

  useEffect(() => {
    loadPresets();
  }, [loadPresets]);

  const handlePickSample = async (path: string) => {
    if (phase !== 'idle' && phase !== 'done' && phase !== 'error') return;
    setSamplePath(path);
    setSampleAdjustments(null);
    setPhase('loadingSample');
    try {
      const meta: any = await invoke(Invokes.LoadMetadata, { path });
      setSampleAdjustments(meta?.adjustments && typeof meta.adjustments === 'object' ? meta.adjustments : {});
      setPhase('idle');
    } catch (error) {
      console.error('Failed to load sample metadata:', error);
      setSampleAdjustments({});
      setPhase('idle');
    }
  };

  const selectedPreset = useMemo(
    () => presets.find((p) => p.id === selectedPresetId) || null,
    [presets, selectedPresetId],
  );
  const presetOptions = useMemo(
    () => [{ value: '', label: t('library.studio.noPreset') }, ...presets.map((p) => ({ value: p.id, label: p.name }))],
    [presets, t],
  );

  // 批量补丁：样片调整（叠加可选预设）按「可复制调整键」过滤，
  // 跳过与默认值相同的项 —— 与复制/粘贴调整语义一致（非空间类，不含蒙版/几何）。
  const batchPatch = useMemo(() => {
    if (!sampleAdjustments) return null;
    const merged = { ...INITIAL_ADJUSTMENTS, ...sampleAdjustments, ...(selectedPreset?.adjustments || {}) };
    const patch: Record<string, any> = {};
    for (const key of COPYABLE_ADJUSTMENT_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(merged, key)) continue;
      const value = merged[key];
      if (JSON.stringify(value) !== JSON.stringify((INITIAL_ADJUSTMENTS as any)[key])) {
        patch[key] = value;
      }
    }
    return patch;
  }, [sampleAdjustments, selectedPreset]);

  const batchPatchKeys = useMemo(() => Object.keys(batchPatch || {}), [batchPatch]);

  const toggleClient = (path: string) => {
    setClientPaths((prev) => (prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path]));
  };

  const buildExportSettings = (): ExportSettings => {
    const lastUsed = appSettings?.exportPresets?.find((p: any) => p.id === '__last_used__');
    return {
      filenameTemplate: lastUsed?.filenameTemplate || '{original_filename}',
      jpegQuality: lastUsed?.jpegQuality ?? 90,
      tiffBitDepth: (lastUsed?.tiffBitDepth as 8 | 16) ?? 16,
      keepMetadata: lastUsed?.keepMetadata ?? true,
      preserveTimestamps: lastUsed?.preserveTimestamps ?? true,
      preserveFolders: false,
      destinationType: 'customFolder',
      subfolder: 'studio',
      resize: null,
      border: null,
      pad: null,
      watermark: null,
      stripGps: lastUsed?.stripGps ?? false,
      exportMasks: false,
      dpi: lastUsed?.dpi ?? 300,
      colorSpace: lastUsed?.colorSpace || 'srgb',
    };
  };

  const handleApplyAndExport = async () => {
    if (!batchPatch || clientPaths.length === 0 || !samplePath) return;
    setErrorMessage('');
    setPhase('applying');
    try {
      await invoke(Invokes.ApplyAdjustmentsToPaths, { paths: clientPaths, adjustments: batchPatch });
      setAppliedCount(clientPaths.length);
    } catch (error) {
      console.error('Failed to apply adjustments:', error);
      setErrorMessage(String(error));
      setPhase('error');
      return;
    }

    setPhase('choosingFolder');
    let outputFolder: string | null = null;
    try {
      outputFolder = (await open({
        title: t('library.studio.chooseOutputFolder'),
        directory: true,
      })) as string | null;
    } catch {
      outputFolder = null;
    }
    if (!outputFolder) {
      setPhase('idle');
      return;
    }

    const lastUsed = appSettings?.exportPresets?.find((p: any) => p.id === '__last_used__');
    const format =
      FILE_FORMATS.find((f) => f.id === lastUsed?.fileFormat && f.id !== FileFormats.Cube) || FILE_FORMATS[0];

    setPhase('exporting');
    try {
      await invoke(Invokes.ExportImages, {
        paths: clientPaths,
        outputFolderOrFile: outputFolder,
        isExplicitFilePath: false,
        baseOriginFolders: rootPaths,
        exportSettings: buildExportSettings(),
        outputFormat: format.extensions[0],
        currentEditPath: null,
        currentEditAdjustments: null,
      });
      setPhase('done');
    } catch (error) {
      console.error('Failed to export images:', error);
      setErrorMessage(typeof error === 'string' ? error : String(error));
      setPhase('error');
    }
  };

  const handleCancelExport = async () => {
    try {
      await invoke(Invokes.CancelExport);
    } catch (error) {
      console.error('Failed to cancel export:', error);
    }
  };

  const isBusy = phase === 'applying' || phase === 'exporting';
  const exportRunning = exportState.status === Status.Exporting || exportState.status === Status.Cancelling;

  const renderGrid = (selected: Array<string>, onToggle: (path: string) => void, singleSelect: boolean) => (
    <div className="grid grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2">
      {localImages.map((img) => {
        const isSelected = selected.includes(img.path);
        const thumb = thumbnails[img.path];
        return (
          <button
            key={img.path}
            onClick={() => (singleSelect ? handlePickSample(img.path) : onToggle(img.path))}
            disabled={isBusy}
            className={clsx(
              'relative aspect-square rounded-md overflow-hidden border-2 transition-colors bg-bg-primary',
              isSelected ? 'border-accent' : 'border-transparent hover:border-border-color',
            )}
            title={fileBasename(img.path)}
          >
            {thumb ? (
              <img src={thumb} alt={fileBasename(img.path)} className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <FileImage className="h-5 w-5 text-text-secondary" />
              </div>
            )}
            {isSelected && (
              <div className="absolute top-1 right-1 bg-accent rounded-full p-0.5">
                <CheckCircle2 className="h-3.5 w-3.5 text-button-text" />
              </div>
            )}
          </button>
        );
      })}
    </div>
  );

  const renderStepHeader = (index: number, title: string, desc: string) => (
    <div className="flex items-start gap-2 mb-2">
      <div
        className={clsx(
          'shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold',
          'bg-accent text-button-text',
        )}
      >
        {index}
      </div>
      <div>
        <Text variant={TextVariants.heading} weight={TextWeights.medium}>
          {title}
        </Text>
        <Text variant={TextVariants.small} color={TextColors.secondary}>
          {desc}
        </Text>
      </div>
    </div>
  );

  return (
    <div className="flex-1 flex flex-col h-full min-w-0 bg-bg-secondary rounded-lg overflow-hidden p-4">
      <header className="shrink-0 flex items-center justify-between mb-4 flex-wrap gap-4">
        <div className="flex items-center">
          <Button
            className="mr-4 hover:bg-surface text-text-primary rounded-full"
            onClick={onBackToLibrary}
            size="icon"
            variant="ghost"
          >
            <ArrowLeft />
          </Button>
          <div>
            <Text variant={TextVariants.headline} className="flex items-center gap-2">
              <Sparkles /> {t('library.studio.headerTitle')}
            </Text>
            <Text>{t('library.studio.headerDesc')}</Text>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto custom-scrollbar pr-2 -mr-2 space-y-6">
        {localImages.length === 0 ? (
          <Text variant={TextVariants.heading} color={TextColors.secondary} className="text-center py-10">
            {t('library.studio.noImages')}
          </Text>
        ) : (
          <>
            <section className="bg-surface rounded-lg border border-border-color p-4">
              {renderStepHeader(1, t('library.studio.step1'), t('library.studio.step1Desc'))}
              {samplePath ? (
                <div className="flex items-center gap-3 mb-3">
                  {thumbnails[samplePath] ? (
                    <img src={thumbnails[samplePath]} className="w-14 h-14 rounded-md object-cover" alt="" />
                  ) : (
                    <div className="w-14 h-14 rounded-md bg-bg-primary flex items-center justify-center">
                      <FileImage className="h-5 w-5 text-text-secondary" />
                    </div>
                  )}
                  <div className="min-w-0">
                    <Text variant={TextVariants.small} className="truncate">
                      {t('library.studio.sampleSelected')}: {fileBasename(samplePath)}
                    </Text>
                    {phase === 'loadingSample' && (
                      <Text variant={TextVariants.small} color={TextColors.secondary}>
                        <Loader2 className="inline h-3 w-3 animate-spin mr-1" />
                        {t('library.studio.loadingMetadata')}
                      </Text>
                    )}
                    {sampleAdjustments && (
                      <Text variant={TextVariants.small} color={TextColors.secondary}>
                        {t('library.studio.willCopy')}:{' '}
                        {batchPatchKeys.length > 0
                          ? batchPatchKeys
                              .slice(0, 8)
                              .map((k) => k)
                              .join(', ')
                          : t('library.studio.noAdjustments')}
                      </Text>
                    )}
                  </div>
                </div>
              ) : (
                <Text variant={TextVariants.small} color={TextColors.secondary} className="mb-3">
                  {t('library.studio.needSample')}
                </Text>
              )}
              {renderGrid(samplePath ? [samplePath] : [], () => {}, true)}
            </section>

            <section className="bg-surface rounded-lg border border-border-color p-4">
              {renderStepHeader(2, t('library.studio.step2'), t('library.studio.step2Desc'))}
              <div className="flex items-center gap-3 flex-wrap">
                <Text variant={TextVariants.label}>{t('library.studio.presetLabel')}</Text>
                <Dropdown
                  options={presetOptions}
                  value={selectedPresetId || ''}
                  onChange={(value) => setSelectedPresetId(value || null)}
                />
              </div>
            </section>

            <section className="bg-surface rounded-lg border border-border-color p-4">
              {renderStepHeader(3, t('library.studio.step3'), t('library.studio.step3Desc'))}
              <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                <Text variant={TextVariants.small} color={TextColors.secondary}>
                  {t('library.studio.selectedCount', { n: clientPaths.length })}
                </Text>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={isBusy}
                    onClick={() => setClientPaths(localImages.map((img) => img.path))}
                  >
                    {t('library.studio.selectAll')}
                  </Button>
                  <Button size="sm" variant="secondary" disabled={isBusy} onClick={() => setClientPaths([])}>
                    {t('library.studio.clearAll')}
                  </Button>
                  <Button
                    size="sm"
                    disabled={isBusy || !batchPatch || clientPaths.length === 0}
                    onClick={handleApplyAndExport}
                  >
                    {phase === 'applying' ? (
                      <>
                        <Loader2 size={14} className="mr-2 animate-spin" />
                        {t('library.studio.applying')}
                      </>
                    ) : phase === 'exporting' ? (
                      <>
                        <Loader2 size={14} className="mr-2 animate-spin" />
                        {t('library.studio.exporting')}
                      </>
                    ) : phase === 'choosingFolder' ? (
                      <>
                        <Loader2 size={14} className="mr-2 animate-spin" />
                        {t('library.studio.chooseOutputFolder')}
                      </>
                    ) : (
                      <>
                        <Wand2 size={14} className="mr-2" />
                        {t('library.studio.applyAndExport')}
                      </>
                    )}
                  </Button>
                </div>
              </div>
              {renderGrid(clientPaths, toggleClient, false)}
            </section>

            {(isBusy ||
              exportRunning ||
              phase === 'done' ||
              phase === 'error' ||
              exportState.status === Status.Success) && (
              <section className="bg-surface rounded-lg border border-border-color p-4">
                <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                  <Text variant={TextVariants.heading} weight={TextWeights.medium} className="flex items-center gap-2">
                    <Download /> {t('library.studio.progressTitle')}
                  </Text>
                  {exportRunning && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={handleCancelExport}
                      disabled={exportState.status === Status.Cancelling}
                    >
                      <XCircle size={14} className="mr-2" />
                      {t('library.studio.cancelExport')}
                    </Button>
                  )}
                </div>
                {(exportRunning || exportState.progress.total > 0) && (
                  <div>
                    <div className="w-full h-2 bg-bg-primary rounded-full overflow-hidden mb-1">
                      <div
                        className="h-full bg-accent transition-all"
                        style={{
                          width: `${
                            exportState.progress.total > 0
                              ? Math.min(100, ((exportState.progress.current ?? 0) / exportState.progress.total) * 100)
                              : 0
                          }%`,
                        }}
                      />
                    </div>
                    <Text variant={TextVariants.small} color={TextColors.secondary}>
                      {exportState.progress.current ?? 0}/{exportState.progress.total}
                      {(exportState.progress as any).path
                        ? ` — ${fileBasename((exportState.progress as any).path)}`
                        : ''}
                    </Text>
                  </div>
                )}
                {phase === 'applying' && (
                  <Text variant={TextVariants.small} color={TextColors.secondary}>
                    {t('library.studio.applying')}
                  </Text>
                )}
                {exportState.status === Status.Success && phase === 'done' && (
                  <Text variant={TextVariants.small} className="flex items-center gap-1">
                    <CheckCircle2 size={14} className="text-green-500" />
                    {t('library.studio.done', { n: appliedCount })}
                  </Text>
                )}
                {exportState.status === Status.Cancelled && (
                  <Text variant={TextVariants.small} color={TextColors.secondary}>
                    {t('library.studio.exportCancelled')}
                  </Text>
                )}
                {(phase === 'error' || exportState.status === Status.Error) && (
                  <Text variant={TextVariants.small} className="text-red-400 break-all">
                    {t('library.studio.failed')}
                    {errorMessage ? `: ${errorMessage}` : ''}
                  </Text>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default StudioPage;
