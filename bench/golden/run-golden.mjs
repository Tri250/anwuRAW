#!/usr/bin/env node
// Golden render regression runner.
//
// Exports the fixed image/params cases in bench/golden/cases.tsv through the
// headless `export` CLI and compares the results against a recorded baseline:
//   - byte identity (sha256) when the build should not have changed output
//   - perceptual tolerance (mean/max ΔE2000, PSNR, SSIM) otherwise, since a
//     different lavapipe/Mesa build rounds floats differently than the
//     machine the baseline was recorded on
//
// Usage:
//   node bench/golden/run-golden.mjs <binary> [options]
//
// Options:
//   --record          (re)record the baseline from this build's outputs
//   --name <name>     baseline slot (default: derived from the wgpu backend)
//   --backend <name>  force WGPU_BACKEND for the export runs
//   --work <dir>      keep intermediates here (default: fresh temp dir)
//   --keep            do not delete the work dir afterwards
//   --stride <n>      sample every nth pixel for ΔE (default 1)
//   --metrics-bin <p> path to the golden_metrics example binary
//
// Environment:
//   GOLDEN_METRICS_BIN  same as --metrics-bin
//   GOLDEN_NO_XVFB      set to skip the automatic xvfb-run wrapper
//
// Exit codes: 0 all cases pass, 1 a case failed, 2 usage/setup error.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = __dirname; // bench/golden
const REPO_ROOT = path.resolve(GOLDEN_DIR, '..', '..');
const IMAGES_DIR = path.join(GOLDEN_DIR, 'images');
const PARAMS_DIR = path.join(GOLDEN_DIR, 'params');
const BASELINES_DIR = path.join(GOLDEN_DIR, 'baselines');
const CASES_FILE = path.join(GOLDEN_DIR, 'cases.tsv');

// Perceptual gates. A refactor that keeps output identical passes on the
// byte check; these bounds catch drift that survives rounding differences
// between software rasterizers (lavapipe vs llvmpipe vs a real GPU).
const DEFAULT_THRESHOLDS = {
  mean_delta_e: 0.5,
  max_delta_e: 2.0,
  psnr_min: 40,
  ssim_min: 0.995,
};

function fail(message) {
  console.error(`run-golden: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = {
    binary: null,
    record: false,
    name: null,
    backend: null,
    work: null,
    keep: false,
    stride: 1,
    metricsBin: process.env.GOLDEN_METRICS_BIN || null,
  };
  const rest = [...argv];
  while (rest.length > 0) {
    const arg = rest.shift();
    switch (arg) {
      case '--record':
        options.record = true;
        break;
      case '--keep':
        options.keep = true;
        break;
      case '--name':
      case '--backend':
      case '--work':
      case '--stride':
      case '--metrics-bin': {
        const value = rest.shift();
        if (value === undefined) fail(`missing value for ${arg}`);
        const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        options[key] = arg === '--stride' ? Number.parseInt(value, 10) : value;
        break;
      }
      default:
        if (arg.startsWith('-')) fail(`unknown option ${arg}`);
        if (options.binary) fail('only one binary argument is supported');
        options.binary = arg;
    }
  }
  if (!options.binary) {
    console.log('Usage: node bench/golden/run-golden.mjs <binary> [--record] [--name <slot>] [--backend <wgpu>]');
    process.exit(2);
  }
  // Resolve against the caller's cwd so `target/debug/RapidRAW` works whether
  // the script is invoked from the repo root or from src-tauri; a bare
  // `target/...` path also resolves against src-tauri.
  options.binary = path.resolve(options.binary);
  if (!existsSync(options.binary)) {
    const fromSrcTauri = path.join(REPO_ROOT, 'src-tauri', options.binary);
    if (existsSync(fromSrcTauri)) options.binary = fromSrcTauri;
  }
  if (options.metricsBin) options.metricsBin = path.resolve(options.metricsBin);
  if (!existsSync(options.binary)) fail(`binary not found: ${options.binary}`);
  if (!Number.isInteger(options.stride) || options.stride < 1) fail('--stride must be a positive integer');
  return options;
}

function loadCases() {
  if (!existsSync(CASES_FILE)) fail(`missing ${CASES_FILE}`);
  const cases = [];
  for (const [lineNo, raw] of readFileSync(CASES_FILE, 'utf8').split('\n').entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const [image, params, ...description] = line.split('\t');
    if (!image || !params) fail(`malformed case on line ${lineNo + 1}: ${raw}`);
    cases.push({
      id: path.basename(params, '.json'),
      image,
      params,
      description: description.join('\t'),
    });
  }
  if (cases.length === 0) fail(`no cases defined in ${CASES_FILE}`);
  const ids = new Set(cases.map((c) => c.id));
  if (ids.size !== cases.length) fail('case ids (params file stems) must be unique');
  return cases;
}

function findMetricsCommand(options) {
  if (options.metricsBin) {
    return { command: options.metricsBin, args: [], cwd: REPO_ROOT };
  }
  for (const profile of ['debug', 'release']) {
    const candidate = path.join(REPO_ROOT, 'src-tauri', 'target', profile, 'examples', 'golden_metrics');
    if (existsSync(candidate)) {
      return { command: candidate, args: [], cwd: REPO_ROOT };
    }
  }
  // Fall back to cargo; slower per invocation but needs no prior build step.
  return { command: 'cargo', args: ['run', '--quiet', '--example', 'golden_metrics', '--'], cwd: path.join(REPO_ROOT, 'src-tauri') };
}

function wrapForDisplay(binary) {
  // The headless `export` path still builds a tao/GTK event loop (it returns
  // from setup before creating a window), so on Linux without a display the
  // export aborts with "Failed to initialize GTK". Wrap it in xvfb-run when
  // that is the case; the GPU path (lavapipe) is unaffected by the display.
  if (process.platform !== 'linux') return { command: binary, args: [] };
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.env.GOLDEN_NO_XVFB) {
    return { command: binary, args: [] };
  }
  const probe = spawnSync('sh', ['-c', 'command -v xvfb-run'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    fail('no DISPLAY set and xvfb-run not found; install xvfb or set GOLDEN_NO_XVFB=1');
  }
  return { command: 'xvfb-run', args: ['-a', binary] };
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command.command, [...command.args, ...args], {
    cwd: options.cwd || command.cwd || REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: options.env || process.env,
  });
  if (result.error) fail(`failed to spawn ${command.command}: ${result.error.message}`);
  return result;
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function findSingleOutput(dir, extensions) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (extensions.some((ext) => entry.name.toLowerCase().endsWith(ext))) found.push(full);
    }
  };
  walk(dir);
  if (found.length === 0) fail(`no ${extensions.join('/')} output found in ${dir}`);
  return found[0];
}

function exportCase(exportCommand, testCase, options, workDir, metricsCommand) {
  const inputCopy = path.join(workDir, 'inputs', testCase.image);
  mkdirSync(path.dirname(inputCopy), { recursive: true });
  copyFileSync(path.join(IMAGES_DIR, testCase.image), inputCopy);

  const outDir = path.join(workDir, 'out', testCase.id);
  const logDir = path.join(workDir, 'logs');
  mkdirSync(logDir, { recursive: true });

  const env = { ...process.env };
  if (options.backend) env.WGPU_BACKEND = options.backend;

  const result = runCommand(exportCommand, ['export', inputCopy, '--output', outDir, '--format', 'tiff', '--tiff-bit-depth', '16', '--adjustments', path.join(PARAMS_DIR, testCase.params)], { env });
  writeFileSync(path.join(logDir, `${testCase.id}.log`), `${result.stdout || ''}${result.stderr || ''}`);
  if (result.status !== 0) {
    fail(`export failed for ${testCase.id} (exit ${result.status}), see ${path.join(logDir, `${testCase.id}.log`)}`);
  }
  return findSingleOutput(outDir, ['.tif', '.tiff']);
}

function measure(metricsCommand, reference, candidate, stride) {
  const result = runCommand(metricsCommand, [reference, candidate, '--stride', String(stride)]);
  if (result.status !== 0) {
    fail(`golden_metrics failed on ${candidate}: ${(result.stderr || result.stdout || '').trim()}`);
  }
  const line = result.stdout.trim().split('\n').pop();
  try {
    return JSON.parse(line);
  } catch {
    fail(`could not parse golden_metrics output: ${line}`);
  }
}

function checkThresholds(metrics, thresholds) {
  const failures = [];
  if (metrics.mean_delta_e > thresholds.mean_delta_e) {
    failures.push(`mean ΔE ${metrics.mean_delta_e.toFixed(4)} > ${thresholds.mean_delta_e}`);
  }
  if (metrics.max_delta_e > thresholds.max_delta_e) {
    failures.push(`max ΔE ${metrics.max_delta_e.toFixed(4)} > ${thresholds.max_delta_e}`);
  }
  if (metrics.psnr !== null && metrics.psnr < thresholds.psnr_min) {
    failures.push(`PSNR ${metrics.psnr.toFixed(2)} < ${thresholds.psnr_min}`);
  }
  if (metrics.ssim < thresholds.ssim_min) {
    failures.push(`SSIM ${metrics.ssim.toFixed(5)} < ${thresholds.ssim_min}`);
  }
  return failures;
}

function gitRev() {
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (result.status !== 0) return null;
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
  const rev = result.stdout.trim();
  if (dirty.status === 0 && dirty.stdout.trim() !== '') return `${rev} (dirty)`;
  return rev;
}

function baselineName(options) {
  if (options.name) return options.name;
  const backend = (options.backend || process.env.WGPU_BACKEND || 'default').toLowerCase();
  return `${backend}-tiff16`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const cases = loadCases();
  const metricsCommand = findMetricsCommand(options);

  if (!existsSync(IMAGES_DIR) || readdirSync(IMAGES_DIR).length === 0) {
    fail(`golden images missing; generate them first:\n  cd src-tauri && cargo run --example gen_golden_images -- ../bench/golden/images`);
  }

  const baselineDir = path.join(BASELINES_DIR, baselineName(options));
  const baselineFile = path.join(baselineDir, 'baseline.json');
  const mode = options.record ? 'record' : 'verify';
  let baseline = null;
  if (mode === 'verify') {
    if (!existsSync(baselineFile)) {
      fail(`no baseline at ${baselineFile}; record one first with --record`);
    }
    baseline = JSON.parse(readFileSync(baselineFile, 'utf8'));
    if (baseline.backend && options.backend && baseline.backend !== options.backend) {
      console.log(`WARNING: baseline backend '${baseline.backend}' != run backend '${options.backend}'; expect byte differences.`);
    }
  }

  const workDir = options.work || mkdtempSync(path.join(tmpdir(), 'rapidraw-golden-'));
  mkdirSync(workDir, { recursive: true });
  const exportCommand = wrapForDisplay(options.binary);

  const thresholds = { ...DEFAULT_THRESHOLDS, ...(baseline ? baseline.thresholds : {}) };
  const recorded = new Map((baseline ? baseline.cases : []).map((c) => [c.id, c]));
  const rows = [];
  let failures = 0;

  for (const testCase of cases) {
    const output = exportCase(exportCommand, testCase, options, workDir, metricsCommand);
    const digest = sha256(output);
    const sourceImage = path.join(IMAGES_DIR, testCase.image);

    if (mode === 'record') {
      const reference = path.join(baselineDir, `${testCase.id}.png`);
      mkdirSync(baselineDir, { recursive: true });
      const converted = runCommand(metricsCommand, ['convert', output, reference]);
      if (converted.status !== 0) {
        fail(`could not convert ${output} to a baseline PNG: ${(converted.stderr || '').trim()}`);
      }
      // Fingerprint the pipeline's edit magnitude (output vs the untouched
      // source); the verify pass recomputes the same pair for drift display.
      const metrics = measure(metricsCommand, sourceImage, output, options.stride);
      const { width, height } = readPngSize(reference);
      rows.push({
        id: testCase.id,
        image: testCase.image,
        params: testCase.params,
        description: testCase.description,
        sha256: digest,
        reference: path.basename(reference),
        width,
        height,
        metrics,
      });
      console.log(`recorded ${testCase.id}: ${width}x${height}, sha256 ${digest.slice(0, 12)}…`);
      continue;
    }

    const entry = recorded.get(testCase.id);
    if (!entry) {
      console.log(`SKIP ${testCase.id}: not present in the recorded baseline`);
      continue;
    }
    const reference = path.join(baselineDir, entry.reference);
    if (!existsSync(reference)) {
      fail(`baseline reference image missing: ${reference}`);
    }
    // Gate: new output vs the recorded baseline output (tolerance absorbs
    // cross-environment float rounding).
    const metrics = measure(metricsCommand, reference, output, options.stride);
    // Fingerprint: new output vs the untouched source, comparable to the
    // value recorded in the baseline.
    const vsInput = measure(metricsCommand, sourceImage, output, options.stride);
    const byteIdentical = digest === entry.sha256;
    const problems = checkThresholds(metrics, thresholds);
    if (problems.length > 0) failures += 1;
    rows.push({
      id: testCase.id,
      byteIdentical,
      metrics,
      problems,
      drift: {
        mean_delta_e: metrics.mean_delta_e,
        vs_input: vsInput.mean_delta_e - entry.metrics.mean_delta_e,
      },
    });
  }

  if (mode === 'record') {
    const manifest = {
      version: 1,
      name: path.basename(baselineDir),
      backend: options.backend || process.env.WGPU_BACKEND || null,
      format: 'tiff16',
      recorded_at: new Date().toISOString(),
      git_rev: gitRev(),
      thresholds,
      cases: rows,
    };
    writeFileSync(baselineFile, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`\nBaseline written to ${baselineFile} (${rows.length} cases).`);
  } else {
    printReport(rows, thresholds, baselineFile);
    if (failures > 0) {
      console.log(`\n${failures} case(s) exceeded the perceptual tolerance.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll cases within tolerance.');
    }
  }

  if (!options.keep && !options.work) {
    rmSync(workDir, { recursive: true, force: true });
  } else {
    console.log(`Intermediates kept in ${workDir}`);
  }
}

// The 16-bit PNG IHDR carries width/height at bytes 16..24.
function readPngSize(file) {
  const header = readFileSync(file).subarray(16, 24);
  return { width: header.readUInt32BE(0), height: header.readUInt32BE(4) };
}

function printReport(rows, thresholds, baselineFile) {
  const header = ['case', 'bytes', 'mean ΔE', 'p95 ΔE', 'max ΔE', 'PSNR', 'SSIM', 'result'];
  const table = rows.map((row) => {
    const m = row.metrics;
    const drift =
      row.drift && row.drift.vs_input !== null && Math.abs(row.drift.vs_input) > 0.0005
        ? ` (edit Δ ${row.drift.vs_input >= 0 ? '+' : ''}${row.drift.vs_input.toFixed(4)})`
        : '';
    return [
      row.id,
      row.byteIdentical ? 'same' : 'DIFF',
      m.mean_delta_e.toFixed(4),
      m.p95_delta_e.toFixed(4),
      m.max_delta_e.toFixed(4),
      m.psnr === null ? 'inf' : m.psnr.toFixed(2),
      m.ssim.toFixed(5),
      row.problems.length === 0 ? `PASS${drift}` : `FAIL: ${row.problems.join('; ')}`,
    ];
  });
  const widths = header.map((h, i) => Math.max(h.length, ...table.map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(`\nGolden regression vs ${baselineFile}`);
  console.log(`  tolerance: mean ΔE ≤ ${thresholds.mean_delta_e}, max ΔE ≤ ${thresholds.max_delta_e}, PSNR ≥ ${thresholds.psnr_min}, SSIM ≥ ${thresholds.ssim_min}`);
  console.log(line(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of table) console.log(line(row));
  const diffs = rows.filter((r) => !r.byteIdentical).length;
  console.log(`  ${rows.length - diffs}/${rows.length} byte-identical; ${diffs} differ (expected across builds/backends).`);
}

main();
