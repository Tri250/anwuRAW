const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const i18next = require('eslint-plugin-i18next');

const tsFiles = ['**/*.{ts,tsx}'];

const jsRecommendedForTs = {
  ...js.configs.recommended,
  files: tsFiles,
};

const tsRecommended = tseslint.configs.recommended.map((config) =>
  config.files ? config : { ...config, files: tsFiles },
);

module.exports = [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'src-tauri/target/**',
      'src-tauri/gen/**',
      'src-tauri/rawler/**',
      'data/**',
    ],
  },
  jsRecommendedForTs,
  ...tsRecommended,
  {
    files: tsFiles,
    plugins: {
      i18next,
    },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    rules: {
      'no-unused-vars': 'off',
      // The codebase uses `any` at the Tauri IPC boundary in ~80 files; keep the
      // rule visible as a warning instead of failing lint for pre-existing debt.
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-useless-assignment': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // JSX markup only. Full-mode enforcement of user-facing strings in
      // logic code (E9 gate) lives in `npm run lint:e9`
      // (scripts/e9-check.mjs, ratcheted via scripts/e9-baseline.json).
      'i18next/no-literal-string': [
        'warn',
        {
          markupOnly: true,
          ignoreAttribute: [
            'className',
            'style',
            'data-tooltip',
            'variant',
            'size',
            'color',
            'weight',
            'fillOrigin',
            'id',
            'name',
            'type',
            'value',
            'label',
            'placeholder',
            'stroke',
            'fill',
            'viewBox',
          ],
        },
      ],
    },
  },
];
