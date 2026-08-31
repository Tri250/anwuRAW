import 'i18next';
import en from '../i18n/locales/en.json';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    // Use a permissive type to allow dynamic / template-string keys (MasksPanel,
    // MetadataPanel, useAppContextMenus, etc.). Correctness is still enforced at
    // runtime via `npm run i18n:check` (i18next-cli extract + plural runtime check).
    resources: {
      translation: Record<string, unknown>;
    };
  }
}
