import { useTranslation } from 'react-i18next';
import { Info, Loader2, Pipette, X } from 'lucide-react';
import {
  haptic,
  summarizeExif,
  useHslProbeStore,
} from './crystalShared';
import { useEditorStore } from '../../store/useEditorStore';
import type { CrystalCategory } from './CrystalMobileApp';

/**
 * P2-3: 移动检视套件 —— 收敛为单一入口的底部检视抽屉：
 * 文件/EXIF 信息 + HSL 取样结果（复用 P1-3 探针）+ 常用分类快捷跳转。
 * 从顶栏 Info 按钮进入，不占用底部拇指区。
 */
export default function CrystalInspectSheet({
  open,
  onClose,
  onJumpTo,
}: {
  open: boolean;
  onClose: () => void;
  onJumpTo?: (id: CrystalCategory) => void;
}) {
  const { t } = useTranslation();
  const selected = useEditorStore((s) => s.selectedImage);
  const probeArmed = useHslProbeStore((s) => s.armed);
  const probeSampling = useHslProbeStore((s) => s.sampling);
  const probeResult = useHslProbeStore((s) => s.result);

  if (!open) return null;

  const exif = summarizeExif((selected?.exif ?? null) as Record<string, unknown> | null);
  const dims =
    selected?.width && selected?.height ? `${selected.width}×${selected.height}` : '';
  const fileName = selected?.path.split(/[\\/]/).pop() ?? '';

  const rows: Array<{ label: string; value: string }> = [
    { label: t('crystal.inspect.file'), value: fileName },
    ...(dims ? [{ label: t('crystal.inspect.dimensions'), value: dims }] : []),
    ...(exif.camera ? [{ label: t('crystal.inspect.camera'), value: exif.camera }] : []),
    ...(exif.lens ? [{ label: t('crystal.inspect.lens'), value: exif.lens }] : []),
  ];

  return (
    <div className="cx-sheet-backdrop" onClick={onClose} role="presentation">
      <div
        className="cx-sheet"
        role="dialog"
        aria-label={t('crystal.inspect.title')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cx-sheet-handle" aria-hidden />
        <div className="cx-sheet-header">
          <Info size={16} />
          <span>{t('crystal.inspect.title')}</span>
          <button className="cx-sheet-close" onClick={onClose} aria-label={t('modals.confirm.cancel')}>
            <X size={16} />
          </button>
        </div>

        <div className="cx-inspect-rows">
          {rows.map((row) => (
            <div key={row.label} className="cx-inspect-row">
              <span className="cx-inspect-label">{row.label}</span>
              <span className="cx-inspect-value">{row.value}</span>
            </div>
          ))}
        </div>

        <div className="cx-inspect-section">
          <div className="cx-inspect-section-title">{t('crystal.tone.hslTitle')}</div>
          <div className="cx-inspect-probe">
            <button
              className={`cx-probe-btn${probeArmed ? ' is-armed' : ''}`}
              onClick={() => {
                haptic(6);
                const store = useHslProbeStore.getState();
                if (probeArmed) store.disarm();
                else store.arm();
              }}
              disabled={probeSampling}
              aria-pressed={probeArmed}
            >
              {probeSampling ? <Loader2 size={13} className="animate-spin" /> : <Pipette size={13} />}
              {probeArmed ? t('crystal.tone.probeArmed') : t('crystal.tone.probe')}
            </button>
            {probeResult && (
              <div className="cx-probe-result">
                <span
                  className="cx-probe-swatch"
                  style={{
                    background: `rgb(${probeResult.r}, ${probeResult.g}, ${probeResult.b})`,
                  }}
                />
                <span className="cx-probe-nums">
                  {`${Math.round(probeResult.hue)}° · ${Math.round(probeResult.saturation)}% · ${Math.round(probeResult.lightness)}%`}
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="cx-inspect-section">
          <div className="cx-inspect-section-title">{t('crystal.inspect.shortcuts')}</div>
          <div className="cx-inspect-jumps">
            {(['tone', 'compose', 'fx'] as CrystalCategory[]).map((id) => (
              <button
                key={id}
                className="cx-inspect-jump"
                onClick={() => {
                  haptic(6);
                  onJumpTo?.(id);
                  onClose();
                }}
              >
                {t(`crystal.categories.${id}`)}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
