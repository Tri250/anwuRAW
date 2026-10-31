#!/usr/bin/env node
/**
 * E9 lint gate (v2.0 plan): hardcoded user-facing English strings.
 *
 * The repo-wide `i18next/no-literal-string` rule runs in markup-only mode
 * (JSX text/attributes only), which misses literals assigned to variables —
 * the exact pattern behind E9 (e.g. confirm-modal titles/messages built in
 * hooks). This gate runs the same rule in *full* mode over `src/` by
 * injecting it as an extra flat-config block, so the shared eslint.config.js
 * and the normal `npm run lint` stay untouched.
 *
 * Enforcement is a committed ratchet baseline (`scripts/e9-baseline.json`):
 *   - The total violation count and every per-file count must not grow.
 *   - `node scripts/e9-check.mjs --update-baseline` rewrites the baseline
 *     after a deliberate cleanup (ratchet down) or a reviewed new violation.
 *
 * Fix a file, re-run with --update-baseline, and commit both together.
 */

import { ESLint } from 'eslint';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = path.join(repoRoot, 'scripts', 'e9-baseline.json');
const updateBaseline = process.argv.includes('--update-baseline');

const require = createRequire(import.meta.url);
const baseConfig = require(path.join(repoRoot, 'eslint.config.js'));

// Full-mode E9 rule: flag every string literal, but keep translations and
// common non-UI strings out of the count.
const e9Config = {
  files: ['src/**/*.{ts,tsx}'],
  rules: {
    'i18next/no-literal-string': [
      'error',
      {
        ignoreCallees: ['t'],
        ignore: ['^\\s+$', '^[\\p{P}\\p{S}\\p{N}\\s]*$'],
      },
    ],
  },
};

const eslint = new ESLint({
  cwd: repoRoot,
  overrideConfigFile: true,
  overrideConfig: [...baseConfig, e9Config],
});

const results = await eslint.lintFiles(['src/**/*.ts', 'src/**/*.tsx']);

const perFile = {};
let total = 0;
for (const result of results) {
  const count = result.messages.filter((message) => message.ruleId === 'i18next/no-literal-string').length;
  if (count > 0) {
    const rel = path.relative(repoRoot, result.filePath).replace(/\\/g, '/');
    perFile[rel] = count;
    total += count;
  }
}

if (updateBaseline) {
  const baseline = { version: 1, total, files: Object.fromEntries(Object.entries(perFile).sort()) };
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n');
  console.log(`E9 baseline updated: ${total} violation(s) across ${Object.keys(perFile).length} file(s).`);
  process.exit(0);
}

const baseline = existsSync(baselinePath)
  ? JSON.parse(readFileSync(baselinePath, 'utf8'))
  : { version: 1, total: 0, files: {} };

console.log(`E9 gate: ${total} hardcoded-string violation(s) in src/ (baseline: ${baseline.total}).`);

const failures = [];
if (total > baseline.total) {
  failures.push(`total violation count grew: ${baseline.total} → ${total}`);
}
for (const [file, count] of Object.entries(perFile).sort()) {
  const allowed = baseline.files[file] ?? 0;
  if (count > allowed) {
    failures.push(`${file}: ${allowed} → ${count} (extract user-facing strings through i18n t())`);
  } else if (count < allowed) {
    console.log(`  improved: ${file}: ${allowed} → ${count} (ratchet down with --update-baseline)`);
  }
}

if (failures.length > 0) {
  console.error('\nE9 gate failed — new hardcoded user-facing strings:');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  console.error('\nFix by routing the strings through i18n t(), or re-baseline deliberately:');
  console.error('  node scripts/e9-check.mjs --update-baseline');
  process.exit(1);
}
