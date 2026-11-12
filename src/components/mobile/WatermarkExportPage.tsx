import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { BookmarkPlus, ChevronLeft, Heart, Images, Loader2, Star, X } from 'lucide-react';
import { toast } from 'react-toastify';
import { useEditorStore } from '../../store/useEditorStore';
import { useProcessStore } from '../../store/useProcessStore';
import { useLibraryStore } from '../../store/useLibraryStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useShallow } from 'zustand/react/shallow';
import { BorderBasis, ExportSettings, Status, WatermarkAnchor } from '../ui/ExportImportProperties';
import { Invokes } from '../ui/AppProperties';
import {
  WATERMARK_TEMPLATES,
  WatermarkTemplate,
  CrystalWatermarkPrefs,
  haptic,
  summarizeExif,
  useWmPrefs,
  CxSwitch,
} from './crystalShared';
import { getOriginalAdjustments } from '../../hooks/useEditorActions';
import { pushExitLayer, removeExitLayer } from '../../utils/androidBackRegistry';

/* ---------------------------------------------------------------------------
 * Crystal 水印导出域（青绿主题，图4）。
 * 模板 → 真实导出参数映射：textWatermark（签名）+ border（相框）+
 * exif_frame（白底 EXIF 信息栏，后端增量；旧后端 serde 会忽略该字段）。
 * 导出调用与桌面 ExportPanel Android 单图路径同源（SAF/MediaStore 落盘）。
 * ------------------------------------------------------------------------- */

type CrystalExportSettings = ExportSettings & {
  /** 白底 EXIF 信息栏（Rust export_processing 增量字段；旧后端忽略） */
  exif_frame?: { enabled: boolean; brand: string; showExif: boolean } | null;
};

/* G18: 画质三档映射到真实 JPEG 质量 100/80/60。 */
const QUALITIES = [100, 80, 60];

function TemplateDemo({ tpl }: { tpl: WatermarkTemplate }) {
  return (
    <span className="cx-tpl-demo relative">
      {tpl.frame && (
        <span
          className="absolute inset-[3px] rounded-[4px] pointer-events-none"
          style={{ border: '1.5px solid rgba(255,255,255,0.85)' }}
        />
      )}
      {tpl.exifBar && (
        <span className="block h-[14px] w-full bg-white flex items-center gap-1 px-1">
          <span className="rounded-[1px]" style={{ width: 8, height: 4, background: 'var(--cx-exif-brand)' }} />
          <span
            className="rounded-[1px]"
            style={{ width: 22, height: 3, background: 'var(--cx-exif-text)', opacity: 0.75 }}
          />
        </span>
      )}
      {tpl.signatureAnchor && (
        <span
          className="absolute rounded-full bg-white/80"
          style={{
            width: 4,
            height: 4,
            bottom: tpl.exifBar ? 18 : 5,
            right: tpl.signatureAnchor === 'bottomRight' ? 6 : tpl.signatureAnchor === 'bottomLeft' ? undefined : '50%',
            left: tpl.signatureAnchor === 'bottomLeft' ? 6 : undefined,
          }}
        />
      )}
    </span>
  );
}

export default function WatermarkExportPage({
  onBackToEdit,
  onBackToLibrary,
}: {
  onBackToEdit: () => void;
  onBackToLibrary: () => void;
}) {
  const { t } = useTranslation();
  const [prefs, updatePrefs] = useWmPrefs();
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(prefs.defaultTemplateId ?? 'pro');
  // E-5（v2.1.22 审计）：信息栏描边 / 导出格式 / 画质此前是纯内存态，重进导出页
  // 即丢——现随 CrystalWatermarkPrefs 持久化（settings.json + localStorage 镜像）。
  const [showInfoBarFrame, setShowInfoBarFrame] = useState(prefs.showInfoBarFrame ?? true);
  const [format, setFormat] = useState<'jpeg' | 'png'>(prefs.exportFormat ?? 'jpeg');
  const [quality, setQuality] = useState(prefs.exportQuality ?? 100);
  const [signatureDraft, setSignatureDraft] = useState(prefs.signature);

  const { finalPreviewUrl, originalPreview, adjustments } = useEditorStore(
    useShallow((s) => ({
      finalPreviewUrl: s.finalPreviewUrl,
      originalPreview: s.originalPreview?.url,
      adjustments: s.adjustments,
    })),
  );
  const selectedImage = useEditorStore((s) => s.selectedImage);
  const setExportState = useProcessStore((s) => s.setExportState);
  const exportState = useProcessStore((s) => s.exportState);

  const tpl = WATERMARK_TEMPLATES.find((w) => w.id === selectedTemplateId) ?? WATERMARK_TEMPLATES[0];
  const exif = useMemo(
    () => summarizeExif((selectedImage?.exif ?? null) as Record<string, unknown> | null),
    [selectedImage?.exif],
  );
  const exifParams = [exif.focal, exif.aperture, exif.shutter, exif.iso ? `ISO ${exif.iso}` : '']
    .filter(Boolean)
    .join(' ');
  const isExporting = [Status.Exporting, Status.Cancelling].includes(exportState.status);

  // F12: 测量预览图实际显示区域（object-fit contain 时元素盒与图像区可能不一致），
  // 用于签名叠加的字号（fontScale 为图像高度百分比，与 Rust font_size 语义一致）
  // 与锚点边距（Rust 为短边 2.5%）。
  const previewImgRef = useRef<HTMLImageElement | null>(null);
  const [imgRect, setImgRect] = useState<{ left: number; top: number; w: number; h: number } | null>(null);
  useEffect(() => {
    const el = previewImgRef.current;
    if (!el) {
      setImgRect(null);
      return;
    }
    const measure = () => {
      const nw = el.naturalWidth;
      const nh = el.naturalHeight;
      const ew = el.clientWidth;
      const eh = el.clientHeight;
      if (!nw || !nh || !ew || !eh) {
        setImgRect(null);
        return;
      }
      const scale = Math.min(ew / nw, eh / nh);
      const w = nw * scale;
      const h = nh * scale;
      setImgRect({ left: (ew - w) / 2, top: (eh - h) / 2, w, h });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    el.addEventListener('load', measure);
    return () => {
      ro.disconnect();
      el.removeEventListener('load', measure);
    };
  }, [finalPreviewUrl]);

  // F9: 导出成功全局 toast —— 仅对「非 Success → Success」的状态迁移弹一次；
  // 重挂载时（如成功后 5 秒窗口内重进导出页，store 仍滞留 Success）不会误判为新成功。
  const prevExportStatusRef = useRef<Status | null>(null);
  useEffect(() => {
    const prev = prevExportStatusRef.current;
    prevExportStatusRef.current = exportState.status;
    if (exportState.status === Status.Success && prev !== null && prev !== Status.Success) {
      haptic([10, 40, 10]);
      toast.success(t('crystal.export.done'));
    }
  }, [exportState.status, t]);

  // 审计自检（导出闭环）：页面内返回胶囊在导出中已禁用，但 Android 硬件/
  // 手势系统返回不走胶囊——注册退出层消费返回事件并提示导出进行中，
  // 防止中途离开丢失进度反馈（与胶囊禁用同一产品策略）。导出结束
  // （完成/取消/失败）自动注销，恢复正常返回行为。
  useEffect(() => {
    if (!isExporting) return;
    const handler = () => toast.info(t('crystal.export.exporting'));
    pushExitLayer(handler);
    return () => removeExitLayer(handler);
  }, [isExporting, t]);

  // OC-2: 按住预览图对照原图（松开恢复效果图）。
  // 审计修复：此前仅翻本地 holdOriginal，而 originalPreview 在移动端恒为 null
  // （renderOriginal 依赖 compareView!=='off'），按住时徽章变「原图」但画面仍是
  // 效果图。现与底栏原图键同机制：按住写 previewOverride=getOriginalAdjustments，
  // 主管线把原图参数渲染进 finalPreviewUrl；松手清除并恢复效果图渲染。
  const [holdOriginal, setHoldOriginal] = useState(false);
  const setEditor = useEditorStore((s) => s.setEditor);

  const startHoldOriginal = () => {
    if (!finalPreviewUrl) return;
    setHoldOriginal(true);
    setEditor({
      showOriginal: true,
      previewOverride: getOriginalAdjustments(useEditorStore.getState().adjustments),
    });
  };
  const endHoldOriginal = () => {
    if (!holdOriginal) return;
    setHoldOriginal(false);
    setEditor({ showOriginal: false, previewOverride: null });
  };
  // 卸载兜底：防止多点触控切换流程导致 store 残留 previewOverride
  useEffect(
    () => () => {
      useEditorStore.getState().setEditor({ showOriginal: false, previewOverride: null });
    },
    [],
  );

  const handleSelectTemplate = (id: string) => {
    setSelectedTemplateId(id);
  };

  const signatureText = (signatureDraft || prefs.signature).trim();
  const sigMargin = imgRect ? Math.round(0.025 * Math.min(imgRect.w, imgRect.h)) : 8;

  // E-4（v2.1.22 审计）：签名/后缀输入此前每个按键都同步写偏好（localStorage，
  // 现为 settings.json 落盘），长文本输入会造成密集 IPC/序列化，低端机输入卡顿。
  // 改为：输入态即时回显，落盘防抖 400ms，卸载时冲刷最后值。
  const pendingPrefsRef = useRef<Partial<CrystalWatermarkPrefs> | null>(null);
  const prefsSaveTimerRef = useRef<number | null>(null);
  const flushPendingPrefs = useCallback(() => {
    if (prefsSaveTimerRef.current !== null) {
      window.clearTimeout(prefsSaveTimerRef.current);
      prefsSaveTimerRef.current = null;
    }
    if (pendingPrefsRef.current) {
      updatePrefs(pendingPrefsRef.current);
      pendingPrefsRef.current = null;
    }
  }, [updatePrefs]);
  useEffect(
    () => () => {
      if (prefsSaveTimerRef.current !== null) window.clearTimeout(prefsSaveTimerRef.current);
      if (pendingPrefsRef.current) {
        const { appSettings, handleSettingsChange } = useSettingsStore.getState();
        if (appSettings && handleSettingsChange) {
          // 卸载冲刷：直接走 settings 管线，避免闭包里的 updatePrefs 已失效
          const next = { ...appSettings.crystalWatermarkPrefs, ...pendingPrefsRef.current } as Record<string, unknown>;
          void handleSettingsChange({ ...appSettings, crystalWatermarkPrefs: next }).catch(() => {});
        }
      }
    },
    // 仅卸载时执行
    [],
  );
  const queuePrefsWrite = useCallback(
    (patch: Partial<CrystalWatermarkPrefs>) => {
      pendingPrefsRef.current = { ...(pendingPrefsRef.current ?? {}), ...patch };
      if (prefsSaveTimerRef.current !== null) window.clearTimeout(prefsSaveTimerRef.current);
      prefsSaveTimerRef.current = window.setTimeout(flushPendingPrefs, 400);
    },
    [flushPendingPrefs],
  );

  const commitSignature = (value: string) => {
    setSignatureDraft(value);
    queuePrefsWrite({ signature: value });
  };
  // 后缀输入为受控（value=prefs.filenameSuffix），同样需要本地草稿即时回显，
  // 落盘走 400ms 防抖（与签名同一队列）。
  const [suffixDraft, setSuffixDraft] = useState(prefs.filenameSuffix);
  const commitSuffix = (value: string) => {
    setSuffixDraft(value);
    queuePrefsWrite({ filenameSuffix: value });
  };

  // E-2（v2.1.22 审计）：成功/失败/取消横幅只在「本次挂载内发起过导出」时显示。
  // store 的结果状态会跨页面滞留（导出成功后回编辑域再进导出页，旧实现仍显示
  // "已完成"），与用户当下状态矛盾。
  const didExportThisMountRef = useRef(false);

  const handleExport = async () => {
    if (!selectedImage || isExporting) return;
    flushPendingPrefs();
    didExportThisMountRef.current = true;

    const signature = (signatureDraft || prefs.signature).trim();
    // FD-6: 后缀可编辑（清洗文件名非法字符；允许为空 = 保持原名导出到相册目录，不覆盖源文件）
    const suffix = (suffixDraft || prefs.filenameSuffix || '_crystal').replace(/[\\/:*?"<>|]/g, '');
    const exportSettings: CrystalExportSettings = {
      filenameTemplate: `{original_filename}${suffix}`,
      jpegQuality: quality,
      tiffBitDepth: 16,
      keepMetadata: true,
      preserveTimestamps: false,
      preserveFolders: false,
      destinationType: 'customFolder',
      subfolder: '',
      resize: null,
      pad: null,
      stripGps: true,
      exportMasks: false,
      colorSpace: 'srgb',
      watermark: null,
      border:
        showInfoBarFrame && tpl.frame
          ? { basis: BorderBasis.LongEdge, horizontalPercent: 2.5, verticalPercent: 5, color: '#FFFFFF' }
          : null,
      textWatermark:
        tpl.signatureAnchor && signature
          ? {
              content: signature,
              anchor: tpl.signatureAnchor as WatermarkAnchor,
              fontSize: prefs.fontScale,
              opacity: 85,
              color: '#FFFFFF',
              fontFamily: prefs.fontFamily,
            }
          : null,
      exif_frame: showInfoBarFrame && tpl.exifBar ? { enabled: true, brand: tpl.brand, showExif: true } : null,
      dpi: 300,
    };

    // E-1（v2.1.22 审计）：Android SAF 导入的图片 path 是 content:// URI，
    // 直接 split(/[\\/]/) 会拿到一串无扩展名的 URI 尾段，导出文件名成乱码。
    // 与分享/另存等 5 处入口同口径：经 resolve_android_content_uri_name 解析
    // 真实显示名（含扩展名）后再取词干；解析失败回落尾段并告警。
    let originalFilename = selectedImage.path.split(/[\\/]/).pop() || '';
    if (selectedImage.path.startsWith('content://')) {
      try {
        originalFilename =
          (await invoke<string>('resolve_android_content_uri_name', { uriStr: selectedImage.path })) ||
          originalFilename;
      } catch (e) {
        console.warn('[crystal] resolve content uri display name failed, fallback to uri tail:', e);
      }
    }
    const stem = originalFilename.substring(0, originalFilename.lastIndexOf('.')) || originalFilename;
    const outputFileName = `${stem}${suffix}.${format === 'jpeg' ? 'jpg' : 'png'}`;

    try {
      setExportState({
        destination: null,
        errorMessage: '',
        progress: { current: 0, total: 1 },
        status: Status.Exporting,
      });
      await invoke(Invokes.ExportImages, {
        paths: [selectedImage.path],
        outputFolderOrFile: outputFileName,
        isExplicitFilePath: true,
        baseOriginFolders: useLibraryStore.getState().rootPaths,
        exportSettings,
        outputFormat: format === 'jpeg' ? 'jpg' : 'png',
        currentEditPath: selectedImage.path,
        currentEditAdjustments: adjustments || null,
      });
    } catch (error) {
      setExportState({
        errorMessage: typeof error === 'string' ? error : t('export.status.failed'),
        status: Status.Error,
      });
      toast.error(t('export.status.failed'));
    }
  };

  return (
    <div className="cx-app" data-flow="export">
      <div className="cx-back-capsules">
        {/* UX：导出进行中禁用返回，避免离开导出页丢失进度反馈（进度条在页内） */}
        <button className="cx-back-capsule" onClick={onBackToEdit} disabled={isExporting}>
          <ChevronLeft size={15} />
          {t('crystal.export.backToEdit')}
        </button>
        <button className="cx-back-capsule" onClick={onBackToLibrary} disabled={isExporting}>
          <Images size={15} />
          {t('crystal.export.backToLibrary')}
        </button>
      </div>

      <div className="cx-export-body">
        {/* 预览 + 徽章 + EXIF 白条 */}
        <div className="cx-export-card mt-1">
          <div
            className="cx-frame-preview"
            onPointerDown={(e) => {
              if ((e.target as HTMLElement).closest('button')) return;
              startHoldOriginal();
            }}
            onPointerUp={endHoldOriginal}
            onPointerLeave={endHoldOriginal}
            onPointerCancel={endHoldOriginal}
          >
            {finalPreviewUrl ? (
              <img
                ref={previewImgRef}
                src={holdOriginal ? (originalPreview ?? finalPreviewUrl) : finalPreviewUrl}
                alt={t('crystal.previewAlt')}
                draggable={false}
              />
            ) : (
              <div
                className="h-[38vh] w-full flex items-center justify-center text-xs"
                style={{ color: 'var(--cx-faint)' }}
              >
                {t('crystal.previewRendering')}
              </div>
            )}
            <span className="cx-preview-badge" style={{ top: 10, left: 10 }}>
              <span className="cx-dot" />
              {holdOriginal ? t('crystal.originalBadge') : t('crystal.export.livePreview')}
            </span>
            {/* E-3（v2.1.22 审计）：已删除旧「叠加原图对照层」——移动端
                originalPreview 恒为 null（该层永不渲染的死代码），且若未来开启
                renderOriginal 会与主管线原图渲染形成双图同显、内存翻倍。
                按住对照由主管线 previewOverride 机制独立完成。 */}
            <span className="cx-preview-badge" style={{ top: 10, right: 10 }}>
              {t(tpl.nameKey)}
            </span>
            {/* F12: 签名实时叠加（与 Rust 绘制次序一致：信息栏 DOM 在后、覆盖底部签名） */}
            {tpl.signatureAnchor && signatureText && imgRect && !holdOriginal && (
              <span
                className="cx-wm-signature"
                style={{
                  left: imgRect.left,
                  top: imgRect.top,
                  width: imgRect.w,
                  height: imgRect.h,
                  fontSize: Math.max(9, (prefs.fontScale / 100) * imgRect.h),
                }}
              >
                <span
                  style={
                    tpl.signatureAnchor === 'topLeft'
                      ? { top: sigMargin, left: sigMargin }
                      : tpl.signatureAnchor === 'bottomLeft'
                        ? { bottom: sigMargin, left: sigMargin }
                        : tpl.signatureAnchor === 'bottomCenter'
                          ? { bottom: sigMargin, left: '50%', transform: 'translateX(-50%)' }
                          : { bottom: sigMargin, right: sigMargin }
                  }
                >
                  {signatureText}
                </span>
              </span>
            )}
            {showInfoBarFrame && tpl.exifBar && !holdOriginal && (
              <div className="cx-exif-bar" style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}>
                <span className="truncate">{exif.camera || exif.taken || t('crystal.export.noExif')}</span>
                <span className="cx-exif-sep" />
                <span className="cx-exif-brand">{tpl.brand}</span>
                {exifParams && (
                  <>
                    <span className="cx-exif-sep" />
                    <span className="truncate">{exifParams}</span>
                  </>
                )}
              </div>
            )}
          </div>
          <div className="cx-frame-switch-row">
            <span>
              <span className="cx-frame-label block">{t('crystal.export.infoFrameLabel')}</span>
              <span className="cx-frame-hint block">{t('crystal.export.infoFrameHint')}</span>
            </span>
            <CxSwitch
              checked={showInfoBarFrame}
              onChange={(v) => {
                // E-5：随偏好持久化
                setShowInfoBarFrame(v);
                queuePrefsWrite({ showInfoBarFrame: v });
              }}
              label={t('crystal.export.infoFrameLabel')}
              labelHidden
            />
          </div>
        </div>

        {/* 模板横滑 */}
        <div className="cx-export-section">
          <div className="cx-export-label">{t('crystal.export.templates')}</div>
          <div className="cx-hstrip">
            {WATERMARK_TEMPLATES.map((w) => (
              <button
                key={w.id}
                className={`cx-template-card ${selectedTemplateId === w.id ? 'is-active' : ''}`}
                onClick={() => handleSelectTemplate(w.id)}
              >
                <TemplateDemo tpl={w} />
                <span className="cx-tpl-name">{t(w.nameKey)}</span>
                <span className="cx-tpl-sub">{t(w.subKey)}</span>
              </button>
            ))}
          </div>
          <div className="cx-tpl-meta-row mt-2">
            <button
              className={`cx-tpl-meta-btn ${prefs.favoriteTemplateId === tpl.id ? 'is-on' : ''}`}
              onClick={() => updatePrefs({ favoriteTemplateId: prefs.favoriteTemplateId === tpl.id ? null : tpl.id })}
            >
              <Heart size={12} />
              {t('crystal.export.favorite')}
            </button>
            <button
              className={`cx-tpl-meta-btn ${prefs.defaultTemplateId === tpl.id ? 'is-on' : ''}`}
              onClick={() => updatePrefs({ defaultTemplateId: tpl.id })}
            >
              <Star size={12} />
              {t('crystal.export.setDefault')}
            </button>
            <button
              className={`cx-tpl-meta-btn ${prefs.savedTemplateId === tpl.id ? 'is-on' : ''}`}
              onClick={() => updatePrefs({ savedTemplateId: tpl.id })}
            >
              <BookmarkPlus size={12} />
              {t('crystal.export.saveTemplate')}
            </button>
          </div>
        </div>

        {/* 签名 + 字体 */}
        <div className="cx-export-section">
          <div className="cx-export-label">{t('crystal.export.signature')}</div>
          <div className="cx-export-card">
            <input
              className="cx-input"
              value={signatureDraft}
              onChange={(e) => commitSignature(e.target.value)}
              placeholder={t('crystal.export.signaturePlaceholder')}
              maxLength={40}
            />
          </div>
          <div className="mt-3">
            <div className="cx-export-label">{t('crystal.export.fontFamily')}</div>
            <div className="cx-seg">
              <button
                className={prefs.fontFamily === 'system' ? '' : 'is-active'}
                onClick={() => updatePrefs({ fontFamily: 'builtin' })}
              >
                {t('crystal.export.fontBuiltin')}
              </button>
              <button
                className={prefs.fontFamily === 'system' ? 'is-active' : ''}
                onClick={() => updatePrefs({ fontFamily: 'system' })}
              >
                {t('crystal.export.fontSystem')}
              </button>
            </div>
          </div>
          <div className="mt-3">
            <div className="cx-export-label">{t('crystal.export.fontScale')}</div>
            <div className="cx-quality-row">
              {[3, 4, 6, 8].map((v) => (
                <button
                  key={v}
                  className={`cx-quality-btn ${prefs.fontScale === v ? 'is-active' : ''}`}
                  onClick={() => updatePrefs({ fontScale: v })}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* 格式 + 画质 */}
        <div className="cx-export-section">
          <div className="cx-export-label">{t('crystal.export.format')}</div>
          <div className="cx-seg">
            <button
              className={format === 'jpeg' ? 'is-active' : ''}
              onClick={() => {
                setFormat('jpeg');
                queuePrefsWrite({ exportFormat: 'jpeg' });
              }}
            >
              JPEG
            </button>
            <button
              className={format === 'png' ? 'is-active' : ''}
              onClick={() => {
                setFormat('png');
                queuePrefsWrite({ exportFormat: 'png' });
              }}
            >
              PNG
            </button>
          </div>
          <div className="mt-2">
            <div className="cx-export-label">{t('crystal.export.filenameSuffix')}</div>
            <input
              className="cx-input mt-1"
              value={suffixDraft}
              onChange={(e) => commitSuffix(e.target.value)}
              onBlur={flushPendingPrefs}
              placeholder="_crystal"
              maxLength={24}
              aria-label={t('crystal.export.filenameSuffix')}
            />
          </div>
        </div>
        <div className="cx-export-section">
          <div className="cx-export-label">{t('crystal.export.quality')}</div>
          {/* FD-6: PNG 为无损格式，画质档不参与压缩 —— 视觉降禁用 + 说明 */}
          <div className={`cx-quality-row ${format === 'png' ? 'is-disabled' : ''}`}>
            {QUALITIES.map((q) => (
              <button
                key={q}
                className={`cx-quality-btn ${quality === q ? 'is-active' : ''}`}
                onClick={() => {
                  // E-5：画质随偏好持久化
                  setQuality(q);
                  queuePrefsWrite({ exportQuality: q });
                }}
                aria-disabled={format === 'png'}
              >
                {q}
              </button>
            ))}
          </div>
          {format === 'png' && <div className="cx-frame-hint mt-1">{t('crystal.export.pngLossless')}</div>}
        </div>

        {/* 导出 CTA */}
        <button className="cx-export-cta" onClick={handleExport} disabled={isExporting || !selectedImage}>
          {isExporting ? <Loader2 size={18} className="animate-spin" /> : null}
          {isExporting ? t('crystal.export.exporting') : t('crystal.export.cta')}
        </button>
        {isExporting && (
          <div className="cx-export-progress">
            {t('crystal.export.progress', {
              current: exportState.progress.current,
              total: exportState.progress.total || 1,
            })}
          </div>
        )}
        {/* 审计自检（导出闭环）：移动端导出期间返回被消费（防丢进度），若无取消出口，
            大图/低端机上导出一旦卡住用户将被锁死。对齐桌面 StudioPage：提供
            CancelExport 出口，取消后后端以 cancelled 状态收敛，CTA 与导航自动恢复。 */}
        {isExporting && (
          <button
            className="cx-mask-remove"
            style={{ display: 'flex', margin: '8px auto 0' }}
            onClick={() => {
              haptic(8);
              void invoke(Invokes.CancelExport).catch((e) => console.error('Cancel export failed:', e));
            }}
          >
            <X size={11} />
            {t('export.status.cancelExport')}
          </button>
        )}
        {/* E-2（v2.1.22 审计）：结果横幅仅在本挂载内发起过导出后才显示——
            Success/Error/Cancelled 状态会滞留在 store 里跨页面存活。 */}
        {exportState.status === Status.Error && didExportThisMountRef.current && (
          <div className="cx-export-progress" style={{ color: 'var(--cx-danger)' }}>
            {exportState.errorMessage || t('export.status.failed')}
          </div>
        )}
        {exportState.status === Status.Cancelled && didExportThisMountRef.current && (
          <div className="cx-export-progress" style={{ color: 'var(--cx-muted)' }}>
            {t('export.status.cancelled')}
          </div>
        )}
        {exportState.status === Status.Success && didExportThisMountRef.current && (
          <div className="cx-export-progress" style={{ color: 'var(--cx-teal)' }}>
            {t('crystal.export.done')}
          </div>
        )}
      </div>
    </div>
  );
}
