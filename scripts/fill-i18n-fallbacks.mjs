// 用 en.json 兜底回填其他语言中的空串翻译。
// 策略：精确键 → 复数键回退（base_other → base_one → 任意 base_*）→ 去复数后缀的基础键。
// 无法解析的键会被列出并以非零码退出（需人工补 en 或该语言值）。
// 用途：i18n:extract 新增键后执行一次，保证 `npm run i18n:check` 硬门禁可通过。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const localeDir = path.resolve(scriptDir, '../src/i18n/locales');
const pluralSuffix = /_(zero|one|two|few|many|other)$/;

const flatten = (object, prefix = '', leaves = new Map()) => {
  for (const [key, value] of Object.entries(object)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      flatten(value, fullKey, leaves);
    } else {
      leaves.set(fullKey, value);
    }
  }
  return leaves;
};

const setLeaf = (object, keyPath, value) => {
  const parts = keyPath.split('.');
  let node = object;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!node[parts[i]] || typeof node[parts[i]] !== 'object') return false;
    node = node[parts[i]];
  }
  if (typeof node[parts.at(-1)] !== 'string') return false;
  node[parts.at(-1)] = value;
  return true;
};

const en = JSON.parse(fs.readFileSync(path.join(localeDir, 'en.json'), 'utf8'));
const enLeaves = flatten(en);

const lookup = (key) => {
  const exact = enLeaves.get(key);
  if (typeof exact === 'string' && exact.trim() !== '') return exact;

  const base = key.replace(pluralSuffix, '');
  const suffixMatch = key.match(pluralSuffix);
  if (suffixMatch) {
    for (const fallbackSuffix of ['other', 'one']) {
      const candidate = enLeaves.get(`${base}_${fallbackSuffix}`);
      if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
    }
  }
  const baseValue = enLeaves.get(base);
  if (typeof baseValue === 'string' && baseValue.trim() !== '') return baseValue;
  return undefined;
};

const localeFiles = fs
  .readdirSync(localeDir)
  .filter((filename) => filename.endsWith('.json') && filename !== 'en.json')
  .sort();

let filled = 0;
const unresolved = [];

for (const filename of localeFiles) {
  const filePath = path.join(localeDir, filename);
  const translations = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const leaves = flatten(translations);

  for (const [key, value] of leaves) {
    if (value !== '') continue;
    const fallback = lookup(key);
    if (fallback === undefined) {
      unresolved.push(`${filename}:${key}`);
      continue;
    }
    if (setLeaf(translations, key, fallback)) filled += 1;
  }

  fs.writeFileSync(filePath, `${JSON.stringify(translations, null, 2)}\n`);
}

console.log(`Filled ${filled} empty translation(s) with en fallback across ${localeFiles.length} locale(s).`);
if (unresolved.length > 0) {
  console.error(`Unresolved keys (${unresolved.length}) — author en values first:`);
  unresolved.forEach((entry) => console.error(`- ${entry}`));
  process.exitCode = 1;
}
