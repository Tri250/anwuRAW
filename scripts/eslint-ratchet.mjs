// ESLint 基线棘轮：存量错误冻结，新增即失败，改进时自动下调基线（只紧不松）。
// 存量债务清偿后应逐步把基线降到 0，最终由 `eslint --max-warnings 0` 直接门禁取代。
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const baselinePath = path.join(scriptDir, 'eslint-baseline.json');

let raw;
try {
  raw = execSync('npx eslint . --format json', {
    cwd: path.resolve(scriptDir, '..'),
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'utf8',
  });
} catch (error) {
  // eslint 在有错误时以非零码退出，但 JSON 报告仍输出到 stdout
  raw = error.stdout;
  if (!raw) {
    console.error('eslint produced no JSON output:', error.message);
    process.exit(1);
  }
}

const reports = JSON.parse(raw);
const current = reports.reduce(
  (acc, file) => ({
    errors: acc.errors + file.errorCount,
    warnings: acc.warnings + file.warningCount,
  }),
  { errors: 0, warnings: 0 },
);

if (!fs.existsSync(baselinePath)) {
  fs.writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`eslint baseline created: ${JSON.stringify(current)}`);
  process.exit(0);
}

const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const grew =
  current.errors > baseline.errors
    ? ['errors', current.errors, baseline.errors]
    : current.warnings > baseline.warnings
      ? ['warnings', current.warnings, baseline.warnings]
      : null;

if (grew) {
  const [kind, now, before] = grew;
  console.error(`eslint ${kind} grew: ${before} -> ${now} (baseline ratchet)`);
  const offenders = reports
    .filter((file) => (kind === 'errors' ? file.errorCount : file.warningCount) > 0)
    .sort((a, b) => b[`${kind.slice(0, -1)}Count`] - a[`${kind.slice(0, -1)}Count`])
    .slice(0, 15);
  offenders.forEach((file) => console.error(`- ${file.filePath}: ${file.errorCount}e/${file.warningCount}w`));
  process.exit(1);
}

if (current.errors < baseline.errors || current.warnings < baseline.warnings) {
  fs.writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`eslint improved, baseline tightened: ${JSON.stringify(baseline)} -> ${JSON.stringify(current)}`);
  process.exit(0);
}

console.log(`eslint within baseline: ${current.errors} errors / ${current.warnings} warnings`);
