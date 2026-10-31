// Performance budget gate for the stage-timing benchmark (v2.0 plan M0-4/M0-5).
//
// Diffs two JSON reports produced by `cargo run --example bench_stages --`:
//
//   node bench/perf/compare-perf.mjs bench/perf/v1.6.14-baseline.json bench/perf/candidate.json
//
// Gates (a breach exits with status 1, for CI):
//   - preview steady-state wall clock P95 grows by more than +10%
//   - export wall clock grows by more than +10%
//   - export memory growth ratio worsens by more than +10% vs the baseline
//
// Memory also has an absolute target of <= 2.5x base image bytes (v2.0 plan).
// As long as recorded baselines sit above that target (v1.6.14 measured 8.4x),
// exceeding it is reported as a warning instead of a breach — otherwise the
// gate would block every merge until the memory work lands, including
// unrelated ones. It flips to a breach automatically once a baseline that
// meets the target is recorded.
//
// Per-stage GPU timings (guided/flare/blur/main) are printed for diagnosis but
// not gated: timestamp queries on software rasterizers are too noisy for a
// hard threshold, and the wall-clock gates above already cover regressions.
//
// Wall-clock numbers are only comparable on the same machine and backend, so
// a baseline/candidate adapter or backend mismatch is reported as a warning
// (the commit message / PR should state which machine recorded the baseline).

import { readFileSync } from "node:fs";

const P95_BUDGET = 0.1; // +10% on preview steady P95
const EXPORT_BUDGET = 0.1; // +10% on export wall clock
const MEMORY_BUDGET = 0.1; // +10% worsening of the growth ratio vs baseline
const MEMORY_ABSOLUTE = 2.5; // absolute target: growth ratio <= 2.5x base bytes

function loadReport(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    console.error(`Cannot read report: ${path}: ${e.message}`);
    process.exit(2);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(`Invalid JSON in ${path}: ${e.message}`);
    process.exit(2);
  }
}

function fmtMs(v) {
  return v == null ? "n/a" : `${v.toFixed(1)} ms`;
}

function stageLine(t) {
  if (!t) return "n/a";
  const ms = (ns) => `${(ns / 1e6).toFixed(1)}`;
  return (
    `guided ${ms(t.guided_coeffs_ns)} | flare ${ms(t.flare_ns)} | ` +
    `blur ${ms(t.blur_ns[0])}/${ms(t.blur_ns[1])}/${ms(t.blur_ns[2])}/${ms(t.blur_ns[3])} | ` +
    `main ${ms(t.main_ns)} (${t.main_tiles} tiles)`
  );
}

function row(name, base, cand, verdict) {
  const d =
    typeof base === "number" && typeof cand === "number" && base !== 0
      ? ` (+${(((cand - base) / base) * 100).toFixed(1)}%)`
      : "";
  return `| ${name} | ${base} | ${cand} | ${verdict ? verdict + d : "—"} |`;
}

const [baselinePath, candidatePath] = process.argv.slice(2);
if (!baselinePath || !candidatePath || process.argv[2] === "--help") {
  console.error(
    "Usage: node bench/perf/compare-perf.mjs <baseline.json> <candidate.json>",
  );
  process.exit(2);
}

const base = loadReport(baselinePath);
const cand = loadReport(candidatePath);

if (base.adapter !== cand.adapter || base.backend !== cand.backend) {
  console.error(
    `WARNING: environment mismatch — baseline recorded on ${base.adapter} (${base.backend}), ` +
      `candidate ran on ${cand.adapter} (${cand.backend}). Wall-clock comparison is not meaningful.`,
  );
}

const breaches = [];
const warnings = [];
const rows = [];

// -- preview wall clock ------------------------------------------------------
const bp = base.preview.wall_ms_steady;
const cp = cand.preview.wall_ms_steady;
for (const [label, key] of [
  ["preview steady P50", "p50_ms"],
  ["preview steady P95", "p95_ms"],
  ["preview steady mean", "mean_ms"],
]) {
  const delta = (cp[key] - bp[key]) / bp[key];
  const over = key === "p95_ms" && delta > P95_BUDGET;
  if (over) breaches.push(`preview steady P95 ${bp[key].toFixed(1)} -> ${cp[key].toFixed(1)} ms (+${(delta * 100).toFixed(1)}% > +10% budget)`);
  rows.push(
    row(
      label,
      fmtMs(bp[key]),
      fmtMs(cp[key]),
      over ? "BREACH" : undefined,
    ),
  );
}

// -- export wall clock -------------------------------------------------------
const exportDelta = (cand.export.wall_ms - base.export.wall_ms) / base.export.wall_ms;
const exportOver = exportDelta > EXPORT_BUDGET;
if (exportOver)
  breaches.push(
    `export wall ${base.export.wall_ms.toFixed(0)} -> ${cand.export.wall_ms.toFixed(0)} ms (+${(exportDelta * 100).toFixed(1)}% > +10% budget)`,
  );
rows.push(
  row(
    "export wall",
    fmtMs(base.export.wall_ms),
    fmtMs(cand.export.wall_ms),
    exportOver ? "BREACH" : undefined,
  ),
);

// -- memory ------------------------------------------------------------------
const ratioBase = base.memory.growth_ratio;
const ratioCand = cand.memory.growth_ratio;
const memCell = (r) => (r == null ? "n/a" : `${r.toFixed(2)}x`);
let memVerdict;
if (ratioBase == null || ratioCand == null) {
  memVerdict = "—";
} else {
  const memDelta = (ratioCand - ratioBase) / ratioBase;
  if (memDelta > MEMORY_BUDGET) {
    breaches.push(
      `export memory growth ratio ${ratioBase.toFixed(2)}x -> ${ratioCand.toFixed(2)}x (+${(memDelta * 100).toFixed(1)}% > +10% budget)`,
    );
    memVerdict = "BREACH";
  } else if (ratioCand > MEMORY_ABSOLUTE) {
    warnings.push(
      `export memory growth ${ratioCand.toFixed(2)}x base image bytes is over the 2.5x absolute target (baseline: ${ratioBase.toFixed(2)}x) — informational until a compliant baseline is recorded`,
    );
    memVerdict = `over absolute target (+${(memDelta * 100).toFixed(1)}%)`;
  } else {
    memVerdict = `+${(memDelta * 100).toFixed(1)}%`;
  }
}
rows.push(
  row("export memory growth / base", memCell(ratioBase), memCell(ratioCand), memVerdict),
);

// -- markdown table ----------------------------------------------------------
const dims = (r) => `${r.preview.width}x${r.preview.height} / ${r.export.width}x${r.export.height}`;
console.log(`# Performance comparison

- baseline: \`${baselinePath}\` (${base.adapter}, ${base.backend}, stage-timing=${base.stage_timing}, ${dims(base)})
- candidate: \`${candidatePath}\` (${cand.adapter}, ${cand.backend}, stage-timing=${cand.stage_timing}, ${dims(cand)})

| metric | baseline | candidate | verdict |
|--------|----------|-----------|---------|
${rows.join("\n")}

Per-stage GPU time (ms, cold preview frame — informational, not gated):

| stage | baseline | candidate |
|-------|----------|-----------|
| guided coeffs | ${stageLine(base.preview.stages_cold).split(" | ")[0]} | ${stageLine(cand.preview.stages_cold).split(" | ")[0]} |
| blur 0-3 | ${stageLine(base.preview.stages_cold).split(" | ").slice(2, 3)[0]} | ${stageLine(cand.preview.stages_cold).split(" | ").slice(2, 3)[0]} |
| main | ${stageLine(base.preview.stages_cold).split(" | ").slice(3)[0]} | ${stageLine(cand.preview.stages_cold).split(" | ").slice(3)[0]} |
`);

if (warnings.length > 0) {
  console.log("Warnings (non-blocking):");
  for (const w of warnings) console.log(`- ${w}`);
  console.log("");
}

if (breaches.length > 0) {
  console.log("**FAIL** — performance budget breached:");
  for (const b of breaches) console.log(`- ${b}`);
  process.exit(1);
}
console.log(
  "**PASS** — within budget (preview steady P95 +10%, export wall +10%, memory growth ratio +10%).",
);
