import 'i18next';
import en from '../i18n/locales/en.json';

type NestedKeys<T, Prefix = ''> = T extends object
  ? {
      [K in keyof T]: K extends string
        ? Prefix extends ''
          ? K | NestedKeys<T[K], K>
          : `${Prefix & string}.${K}` | NestedKeys<T[K], `${Prefix & string}.${K}`>
        : never;
    }[keyof T]
  : never;

type TranslationKeys = NestedKeys<typeof en>;

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: {
      translation: typeof en;
    };
  }

  interface TFunction {
    (key: TranslationKeys | (string & Record<never, never>), options?: object): string;
    (key: TranslationKeys | (string & Record<never, never>), defaultValue?: string, options?: object): string;
  }
}
