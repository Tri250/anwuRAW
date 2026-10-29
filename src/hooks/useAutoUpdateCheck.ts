import { useEffect, useRef } from 'react';
import { check } from '@tauri-apps/plugin-updater';
import { sharedUpdateCheckResult } from '../components/panel/SettingsPanel';

/**
 * 启动时按用户设置自动检查更新（默认关闭，对齐保守策略）。
 * 结果写入 sharedUpdateCheckResult，打开设置面板即可查看；
 * 有新版本时仅记录日志，不打扰用户。
 */
export function useAutoUpdateCheck(enabled: boolean, skip: boolean) {
  const runningRef = useRef(false);

  useEffect(() => {
    if (!enabled || skip || runningRef.current) return;
    runningRef.current = true;
    check()
      .then((update) => {
        sharedUpdateCheckResult.update = update ?? null;
        sharedUpdateCheckResult.checkedAt = Date.now();
        if (update) {
          console.info(`[updater] New version available: ${update.version}`);
        }
      })
      .catch((err) => {
        sharedUpdateCheckResult.error = err instanceof Error ? err.message : String(err);
        sharedUpdateCheckResult.checkedAt = Date.now();
        console.warn('[updater] Automatic update check failed:', err);
      });
  }, [enabled, skip]);
}
