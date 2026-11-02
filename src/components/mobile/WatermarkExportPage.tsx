import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import {
  BookmarkPlus,
  ChevronLeft,
  Heart,
  Images,
  Loader2,
  Star,
} from 'lucide-react';
import { toast } from 'react-toastify';
import { useEditorStore } from '../../store/useEditorStore';
import { useProcessStore } from '../../store/useProcessStore';
import { useLibraryStore } from '../../store/useLibraryStore';
import { useShallow } from 'zustand/react/shallow';
import {
  BorderBasis,
  ExportSettings,
  Status,
  WatermarkAnchor,
} from '../ui/ExportImportProperties';
import { Invokes } from '../ui/AppProperties';
import {
  WATERMARK_TEMPLATES,
  WatermarkTemplate,
  summarizeExif,
  useWmPrefs,
  CxSwitch,
} from './crystalShared';

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
          <span className="rounded-[1px]" style={{ width: 8, height: 4, background: '#B4443C' }} />
          <span className="rounded-[1px]" style={{ width: 22, height: 3, background: '#1C1C18', opacity: 0.75 }} />
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
  isExporting: boolean;
}) {
  const { t } = useTranslation();
  const [prefs, updatePrefs] = useWmPrefs();
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(prefs.defaultTemplateId ?? 'pro');
  const [showInfoBarFrame, setShowInfoBarFrame] = useState(true);
  const [format, setFormat] = useState<'jpeg' | 'png'>('jpeg');
  const [quality, setQuality] = useState(100);
  const [signatureDraft, setSignatureDraft] = useState(prefs.signature);

  const { finalPreviewUrl, adjustments } = useEditorStore(
    useShallow((s) => ({ finalPreviewUrl: s.finalPreviewUrl, adjustments: s.adjustments })),
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

  // F9: 导出成功一次性全局 toast（inline 状态条已存在；防止状态滞留重复弹）。
  const successToastShownRef = useRef(false);
  useEffect(() => {
    if (exportState.status === Status.Success) {
      if (!successToastShownRef.current) {
        successToastShownRef.current = true;
        toast.success(t('crystal.export.done'));
      }
    } else {
      successToastShownRef.current = false;
    }
  }, [exportState.status, t]);

  const handleSelectTemplate = (id: string) => {
    setSelectedTemplateId(id);
  };

  const signatureText = (signatureDraft || prefs.signature).trim();
  const sigMargin = imgRect ? Math.round(0.025 * Math.min(imgRect.w, imgRect.h)) : 8;

  const commitSignature = (value: string) => {
    setSignatureDraft(value);
    updatePrefs({ signature: value });
  };

  const handleExport = async () => {
    if (!selectedImage || isExporting) return;

    const signature = (signatureDraft || prefs.signature).trim();
    const exportSettings: CrystalExportSettings = {
      filenameTemplate: '{original_filename}_crystal',
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
      exif_frame:
        showInfoBarFrame && tpl.exifBar
          ? { enabled: true, brand: tpl.brand, showExif: true }
          : null,
      dpi: 300,
    };

    const originalFilename = selectedImage.path.split(/[\\/]/).pop() || '';
    const stem = originalFilename.substring(0, originalFilename.lastIndexOf('.')) || originalFilename;
    const outputFileName = `${stem}_crystal.${format === 'jpeg' ? 'jpg' : 'png'}`;

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
        <button className="cx-back-capsule" onClick={onBackToEdit}>
          <ChevronLeft size={15} />
          {t('crystal.export.backToEdit')}
        </button>
        <button className="cx-back-capsule" onClick={onBackToLibrary}>
          <Images size={15} />
          {t('crystal.export.backToLibrary')}
        </button>
      </div>

      <div className="cx-export-body">
        {/* 预览 + 徽章 + EXIF 白条 */}
        <div className="cx-export-card mt-1">
          <div className="cx-frame-preview">
            {finalPreviewUrl ? (
              <img ref={previewImgRef} src={finalPreviewUrl} alt={t('crystal.previewAlt')} draggable={false} />
            ) : (
              <div className="h-[38vh] w-full flex items-center justify-center text-xs" style={{ color: 'var(--cx-faint)' }}>
                {t('crystal.previewRendering')}
              </div>
            )}
            <span className="cx-preview-badge" style={{ top: 10, left: 10 }}>
              <span className="cx-dot" />
              {t('crystal.export.livePreview')}
            </span>
            <span className="cx-preview-badge" style={{ top: 10, right: 10 }}>
              {t(tpl.nameKey)}
            </span>
            {/* F12: 签名实时叠加（与 Rust 绘制次序一致：信息栏 DOM 在后、覆盖底部签名） */}
            {tpl.signatureAnchor && signatureText && imgRect && (
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
            {showInfoBarFrame && tpl.exifBar && (
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
            <CxSwitch checked={showInfoBarFrame} onChange={setShowInfoBarFrame} label={t('crystal.export.infoFrameLabel')} />
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
              <button className={prefs.fontFamily === 'system' ? '' : 'is-active'} onClick={() => updatePrefs({ fontFamily: 'builtin' })}>
                {t('crystal.export.fontBuiltin')}
              </button>
              <button className={prefs.fontFamily === 'system' ? 'is-active' : ''} onClick={() => updatePrefs({ fontFamily: 'system' })}>
                {t('crystal.export.fontSystem')}
              </button>
            </div>
          </div>
          <div className="mt-3">
            <div className="cx-export-label">{t('crystal.export.fontScale')}</div>
            <div className="cx-quality-row">
              {[3, 4, 6, 8].map((v) => (
                <button key={v} className={`cx-quality-btn ${prefs.fontScale === v ? 'is-active' : ''}`} onClick={() => updatePrefs({ fontScale: v })}>
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
            <button className={format === 'jpeg' ? 'is-active' : ''} onClick={() => setFormat('jpeg')}>
              JPEG
            </button>
            <button className={format === 'png' ? 'is-active' : ''} onClick={() => setFormat('png')}>
              PNG
            </button>
          </div>
        </div>
        <div className="cx-export-section">
          <div className="cx-export-label">{t('crystal.export.quality')}</div>
          <div className="cx-quality-row">
            {QUALITIES.map((q) => (
              <button key={q} className={`cx-quality-btn ${quality === q ? 'is-active' : ''}`} onClick={() => setQuality(q)}>
                {q}
              </button>
            ))}
          </div>
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
        {exportState.status === Status.Error && (
          <div className="cx-export-progress" style={{ color: '#ff8d80' }}>
            {exportState.errorMessage || t('export.status.failed')}
          </div>
        )}
        {exportState.status === Status.Success && (
          <div className="cx-export-progress" style={{ color: 'var(--cx-teal)' }}>
            {t('crystal.export.done')}
          </div>
        )}
      </div>
    </div>
  );
}
