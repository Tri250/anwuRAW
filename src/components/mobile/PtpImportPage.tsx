import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import {
  Camera,
  ChevronLeft,
  Download,
  Folder,
  ImageIcon,
  Loader2,
  RefreshCw,
  Wifi,
  X,
} from 'lucide-react';
import { toast } from 'react-toastify';

interface PtpCameraInfo {
  manufacturer: string;
  model: string;
  deviceVersion: string;
  host: string;
}

interface PtpObject {
  handle: number;
  parent: number;
  name: string;
  formatCode: number;
  isFolder: boolean;
  size: number;
  width: number;
  height: number;
}

const IMAGE_FORMAT_BASE = 0x3800;

function isImageLike(obj: PtpObject): boolean {
  return (
    !obj.isFolder &&
    /\.(jpe?g|tiff?|heic|heif|avif|jxl|webp|dng|cr2|cr3|nef|arw|orf|raf|rw2|erf|srw|pef)$/i.test(obj.name)
  );
}

function formatSize(bytes: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * P0-3: PTP/IP（Wi-Fi，TCP 15740）无线相机导入页。
 * Android 图库悬浮按钮进入：连接相机 → 浏览（含文件夹下钻）→ 下载原图到
 * 应用内部图库根目录（后端 temp+rename 原子落盘），完成后刷新图库即可看到。
 */
export default function PtpImportPage({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [host, setHost] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [camera, setCamera] = useState<PtpCameraInfo | null>(null);
  const [objects, setObjects] = useState<PtpObject[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [folderStack, setFolderStack] = useState<number[]>([]);
  const [downloadingHandle, setDownloadingHandle] = useState<number | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleError = useCallback(
    (message: unknown) => {
      toast.error(t('ptp.failed', { message: String(message) }));
    },
    [t],
  );

  const handleConnect = useCallback(async () => {
    const target = host.trim();
    if (!target) return;
    setConnecting(true);
    try {
      const info = await invoke<PtpCameraInfo>('ptp_ip_connect', { host: target });
      if (!mountedRef.current) return;
      setCamera(info);
      const roots = await invoke<PtpObject[]>('ptp_ip_list_objects', { parent: null });
      if (!mountedRef.current) return;
      setObjects(roots);
      setFolderStack([]);
    } catch (err) {
      handleError(err);
    } finally {
      if (mountedRef.current) setConnecting(false);
    }
  }, [handleError, host]);

  const handleDisconnect = useCallback(async () => {
    try {
      await invoke('ptp_ip_disconnect');
    } catch {
      /* session already gone */
    }
    setCamera(null);
    setObjects([]);
    setFolderStack([]);
  }, []);

  const refreshList = useCallback(
    async (parent: number | null) => {
      setLoadingList(true);
      try {
        const list = await invoke<PtpObject[]>('ptp_ip_list_objects', { parent });
        if (!mountedRef.current) return;
        setObjects(list);
      } catch (err) {
        handleError(err);
        // Session likely dead after a failed listing — reset to the connect screen.
        setCamera(null);
        setObjects([]);
        setFolderStack([]);
      } finally {
        if (mountedRef.current) setLoadingList(false);
      }
    },
    [handleError],
  );

  const enterFolder = useCallback(
    (obj: PtpObject) => {
      setFolderStack((stack) => [...stack, obj.handle]);
      void refreshList(obj.handle);
    },
    [refreshList],
  );

  const goUpFolder = useCallback(() => {
    setFolderStack((stack) => {
      const next = stack.slice(0, -1);
      void refreshList(next.length ? next[next.length - 1] : null);
      return next;
    });
  }, [refreshList]);

  const download = useCallback(
    async (obj: PtpObject) => {
      setDownloadingHandle(obj.handle);
      try {
        const result = await invoke<{ path: string; size: number }>('ptp_ip_download_object', {
          handle: obj.handle,
          filename: obj.name,
        });
        toast.success(t('ptp.downloaded', { name: obj.name }));
        return result;
      } catch (err) {
        handleError(err);
        return null;
      } finally {
        if (mountedRef.current) setDownloadingHandle(null);
      }
    },
    [handleError, t],
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex flex-col bg-bg-primary text-text-primary" role="dialog">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border-color px-3 py-2">
        {camera && folderStack.length > 0 ? (
          <button
            className="rounded-lg p-2 hover:bg-bg-secondary"
            onClick={goUpFolder}
            aria-label={t('ptp.back')}
          >
            <ChevronLeft size={20} />
          </button>
        ) : (
          <span className="p-2">
            <Camera size={20} />
          </span>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold">
            {camera ? camera.model || t('ptp.openCamera') : t('ptp.openCamera')}
          </span>
          {camera && <span className="truncate text-xs text-text-secondary">{camera.host}</span>}
        </div>
        {camera && (
          <>
            <button
              className="rounded-lg p-2 hover:bg-bg-secondary disabled:opacity-50"
              onClick={() => void refreshList(folderStack.length ? folderStack[folderStack.length - 1] : null)}
              disabled={loadingList}
              aria-label={t('ptp.refresh')}
            >
              {loadingList ? <Loader2 size={18} className="animate-spin" /> : <RefreshCw size={18} />}
            </button>
            <button
              className="rounded-lg p-2 hover:bg-bg-secondary"
              onClick={() => void handleDisconnect()}
              aria-label={t('ptp.disconnect')}
            >
              <Wifi size={18} />
            </button>
          </>
        )}
        <button className="rounded-lg p-2 hover:bg-bg-secondary" onClick={onClose} aria-label={t('modals.confirm.cancel')}>
          <X size={20} />
        </button>
      </div>

      {/* Connect form */}
      {!camera && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8">
          <Camera size={44} className="text-accent" />
          <div className="w-full max-w-sm">
            <label className="mb-1 block text-xs text-text-secondary" htmlFor="ptp-host">
              {t('ptp.hostLabel')}
            </label>
            <div className="flex gap-2">
              <input
                id="ptp-host"
                className="h-10 flex-1 rounded-lg border border-border-color bg-bg-secondary px-3 text-sm outline-none focus:border-accent"
                inputMode="url"
                placeholder={t('ptp.hostPlaceholder')}
                value={host}
                onChange={(e) => setHost(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleConnect();
                }}
              />
              <button
                className="flex h-10 items-center gap-1.5 rounded-lg bg-accent px-4 text-sm font-medium text-button-text disabled:opacity-50"
                onClick={() => void handleConnect()}
                disabled={connecting || !host.trim()}
              >
                {connecting ? <Loader2 size={15} className="animate-spin" /> : <Wifi size={15} />}
                {connecting ? t('ptp.connecting') : t('ptp.connect')}
              </button>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-text-secondary">{t('ptp.help')}</p>
          </div>
        </div>
      )}

      {/* Object browser */}
      {camera && (
        <div className="flex-1 overflow-y-auto">
          {objects.length === 0 && !loadingList && (
            <div className="flex h-full items-center justify-center text-sm text-text-secondary">
              {t('ptp.empty')}
            </div>
          )}
          <ul className="divide-y divide-border-color/60">
            {objects.map((obj) => (
              <li key={obj.handle} className="flex items-center gap-3 px-4 py-2.5">
                <span className="shrink-0 text-text-secondary">
                  {obj.isFolder ? (
                    <Folder size={18} />
                  ) : isImageLike(obj) ? (
                    <ImageIcon size={18} />
                  ) : (
                    <ImageIcon size={18} className="opacity-40" />
                  )}
                </span>
                <button
                  className="flex min-w-0 flex-1 flex-col items-start text-left"
                  onClick={() => obj.isFolder && enterFolder(obj)}
                >
                  <span className="w-full truncate text-sm">{obj.name}</span>
                  <span className="text-xs text-text-secondary">
                    {obj.isFolder
                      ? t('ptp.folder')
                      : [formatSize(obj.size), obj.width > 0 ? `${obj.width}×${obj.height}` : '']
                          .filter(Boolean)
                          .join(' · ')}
                  </span>
                </button>
                {!obj.isFolder && isImageLike(obj) && (
                  <button
                    className="shrink-0 rounded-lg p-2 text-accent hover:bg-bg-secondary disabled:opacity-50"
                    onClick={() => void download(obj)}
                    disabled={downloadingHandle !== null}
                    aria-label={t('ptp.download')}
                  >
                    {downloadingHandle === obj.handle ? (
                      <Loader2 size={17} className="animate-spin" />
                    ) : (
                      <Download size={17} />
                    )}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
