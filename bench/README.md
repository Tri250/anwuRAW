# UI Performance Benchmark

Deterministic replay for comparing UI smoothness before/after a change.

## Usage

1. Run the build you want to measure (`npm start`, or a packaged build) and get to the
   library view with at least one image loaded.
2. Open devtools (right-click → Inspect) and switch to the Console tab.
3. Paste the contents of `bench/replay.js` and press Enter.
4. It repeats the same scroll → open-image → drag-two-sliders → back-to-library cycle
   10 times (2 discarded warmup + 8 measured), then prints a JSON result between
   `BENCH_RESULT_JSON_START`/`END` markers (and copies it to your clipboard if the
   console supports `copy()`).
5. Save the result as `bench/out/<name>.json` (gitignored, doesn't need to be committed).
6. Compare two runs:
   ```
   node bench/analyze.mjs bench/out/before.json bench/out/after.json
   ```

## Why it's built this way

- **Self-measuring, not devtools-export-dependent.** `replay.js` times itself with
  `requestAnimationFrame`/`performance.now()` (standard web APIs) rather than relying on
  a devtools Timeline recording. Tauri uses a different webview per OS — WebKitGTK on
  Linux, WKWebView on macOS, WebView2 (Chromium) on Windows — and each one's devtools
  Timeline/Performance export uses a different JSON format. Self-measurement sidesteps
  that entirely, so the same script and analyzer work on all three platforms.
- **Fixed synthetic input.** All interaction timing is scripted (`setTimeout` steps at a
  fixed cadence, fixed pixel deltas), so two runs get identical input instead of
  whatever pacing a human happened to use. Don't hand-drive the interaction and try to
  compare the numbers to a scripted run — only compare scripted run to scripted run.
- **Repeated iterations, not a single sample.** One run of the interaction can't tell you
  whether a difference between "before" and "after" is real or just jitter. `replay.js`
  repeats the full cycle several times (first one discarded as warmup) and
  `analyze.mjs` reports median/p95/stdev per metric so you can judge whether a change
  is bigger than the run-to-run noise.
- **Per-phase frame attribution.** Frame timing is bucketed into the `scroll`, `open`,
  and `edit` windows separately (not just one number for the whole run), so a result
  points at _which_ interaction got slower instead of just "the run as a whole".

## Known limitations

- Numbers are only comparable **on the same machine** (same window size, same display
  scaling). A slider's pixel-delta → value-delta depends on its on-screen width, so
  results aren't meaningful across different maintainers' machines — only before/after
  on one machine. `replay.js` records `viewport` (width/height/devicePixelRatio) in its
  output, and `analyze.mjs` prints a warning if you diff two runs whose viewports don't
  match.
- The thumbnail, back-to-library, undo, and first-frame selectors prefer
  `[data-bench-id="thumbnail"]` / `[data-bench-id="back-to-library"]` /
  `[data-bench-id="undo"]` / `[data-bench-id="editor-first-frame"]` (see
  `src/components/panel/library/LibraryItems.tsx`, `src/components/panel/editor/EditorToolbar.tsx`,
  and `src/components/panel/Editor.tsx`), falling back to Tailwind-class matching where no
  hook exists yet. If you add new interaction steps, prefer adding a `data-bench-id` hook
  over relying on utility classes, which shift on any restyle.
- The `open` phase waits for `[data-bench-id="editor-first-frame"]`, which renders once
  either real render signal fires -- `hasRenderedFirstFrame` (set by the `wgpu-frame-ready`
  event, wgpu path) or `finalPreviewUrl` becoming available (CPU path) -- see `Editor.tsx`.
  Whichever renderer is actually active on your machine, one of the two will fire; if this
  phase still times out, check `document.querySelectorAll('[data-bench-id]')` in the
  console to confirm the build you're testing actually contains the marker.
- This is a general smoothness/regression check, not a profiler. It won't tell you
  _why_ something is slow — use devtools Timeline/Performance recording by hand for
  root-causing, and this script for confirming a fix actually helped.
- Still requires a manual paste-and-save per run (devtools console access, `copy()` to
  clipboard, write `bench/out/<name>.json` by hand). There's no CI/headless runner —
  Tauri's WebDriver story (`tauri-driver`) doesn't cover macOS and would trade away the
  cross-platform self-measurement approach above for a Linux/Windows-only automation
  path. If you need unattended/CI runs, that trade-off is worth revisiting, but it's out
  of scope for this same-machine before/after tool.

# Export Benchmark (headless)

`replay.js` above measures UI smoothness. To compare the image processing pipeline of two
builds without opening the GUI, `compare-renders.sh` exports a folder with each build through
the headless `export` command, as 16-bit TIFF and as JPEG using each image's sidecar edits:

```bash
bench/compare-renders.sh ./rapidraw-before ./rapidraw-after ~/Pictures/test-set /tmp/render-check
```

For each build and format it prints the total export time and the median per-image raw
enhance and GPU times, read from the timing lines the app already logs. It then checks that
both builds wrote byte-identical files and exits with status 1 if any file differs, so it also
confirms that an optimization left rendered output unchanged.

Exports process several images at once, so the per-image GPU time includes waiting for the
shared GPU; use the total time to compare throughput. For a per-function breakdown, run a
single export under a sampling profiler instead, for example
`perf record -g -- rapidraw export photo.ARW --output /tmp/out.jpg` on Linux.

Only compare builds on the same machine. GPU output is deterministic for one GPU and driver,
but can differ slightly between GPUs.

# Golden Render Regression

`compare-renders.sh` compares two builds against each other. `golden/run-golden.mjs` compares
one build against a **recorded baseline**: a fixed set of synthetic images
(`golden/images/`, generated deterministically by
`cargo run --example gen_golden_images -- ../bench/golden/images` from `src-tauri/`) exported
with fixed adjustment snapshots (`golden/params/*.json`, listed in `golden/cases.tsv`):

| case | image | stresses |
|------|-------|----------|
| `colorchecker` / `colorchecker-agx` | 24-patch ColorChecker chart | color accuracy (ΔE2000), basic + AgX tone mappers |
| `gray-ramp` | 14-step + 64-step ramps, smooth gradient | tone curves, 8-bit banding |
| `edge-contrast` | step/diagonal edges, square waves, frequency sweep | sharpening, halos |
| `sky-backlit` | sun disk, sky gradient, dark ridge | highlight compression, dehaze, glow |
| `portrait` | smooth skin gradients + features | denoise, clarity, vignette, grain |
| `iso-noise` | clean + ISO400/1600/6400 flats | denoise strength |

Each case is exported headless as 16-bit TIFF and checked two ways:

- **byte identity** (sha256) — a refactor that must not change output passes here;
- **perceptual tolerance** — mean/max ΔE2000, PSNR, SSIM against the recorded baseline
  image, gated at mean ΔE ≤ 0.5, max ΔE ≤ 2.0, PSNR ≥ 40 dB, SSIM ≥ 0.995. These bounds
  absorb the float-rounding differences between lavapipe, llvmpipe and real GPUs, so a
  baseline recorded on one environment still gates another.

Record a baseline (do this at the start of a stage, before algorithm changes):

```bash
cd src-tauri && cargo build --bins --examples   # once
node bench/golden/run-golden.mjs src-tauri/target/debug/RapidRAW --record --name v1.6.14-baseline
```

Verify a build against it:

```bash
node bench/golden/run-golden.mjs src-tauri/target/debug/RapidRAW --name v1.6.14-baseline
```

Intentional algorithm changes (M2/M3/M4 stages) are expected to move the metrics; re-record
the baseline in the stage PR and attach the before/after table to the PR description, as
required by the v2.0 plan. Unintentional drift shows up as a FAIL without a re-record.

For CI determinism, force the software rasterizer so the baseline and the gate run on the
same backend:

```bash
node bench/golden/run-golden.mjs src-tauri/target/debug/RapidRAW --backend Vulkan --name lavapipe-vulkan
```

(`WGPU_BACKEND=Vulkan` selects lavapipe on Linux CI runners; the baseline name records which
backend produced it.) Intermediates (per-case export logs, outputs) land in a temp dir unless
`--work <dir>`/`--keep` is passed; the metrics CLI is `cargo run --example golden_metrics --`
(`compare <a> <b>` prints the JSON report, `convert <in> <out.png>` re-encodes to 16-bit PNG).

The headless export still initializes a tao/GTK event loop, so on a Linux machine without a
display the runner wraps the export in `xvfb-run` automatically (install `xvfb`; set
`GOLDEN_NO_XVFB=1` to opt out when a display is already available through other means).

## CI gate

`.github/workflows/render-regression.yml` runs on every push/PR that touches `src-tauri/`
or `bench/`:

1. `cargo test --lib` — the objective image-quality metrics (gradient-energy retention,
   MTF50, flat-region residual sigma, ΔE2000, gradient PSNR) and the preview-vs-export
   consistency tests, pinned to `WGPU_BACKEND=Vulkan`;
2. the golden gate against the committed `v1.6.14-baseline`, with `--backend Vulkan` so the
   runner's lavapipe (llvmpipe) adapter matches the backend the baselines are recorded on
   (install `mesa-vulkan-drivers`; `xvfb` for the headless export).

The tolerance bounds are the plan's "容差区间": mean ΔE ≤ 0.5 (± 0.1 of observed
cross-environment spread), max ΔE ≤ 2.0, PSNR ≥ 40 dB, SSIM ≥ 0.995 — roughly an order of
magnitude below a visible change, sized to absorb float-rounding differences between
lavapipe/llvmpipe Mesa versions and real GPUs. If a runner-image Mesa upgrade trips the
gate on an otherwise unchanged build, re-record the baseline on that image and say so in
the PR — same procedure as an intentional algorithm change. A FAIL *without* a re-record
is treated as unintentional drift and blocks.

## Real-device spot checks

CI cannot do this part: GitHub-hosted runners expose no GPU (Linux jobs get the lavapipe
software rasterizer, macOS VMs get no Metal device). The v2.0 plan therefore requires one
manual golden-set run per stage on real hardware — Apple Silicon (Metal) and Android arm64
(Mali/Adreno) — attached to the stage PR as a before/after table like any baseline
re-record.

**Apple Silicon (and any desktop machine with a real GPU):** the CLI harness runs directly,
no flags needed so wgpu picks the native backend:

```bash
cd src-tauri && cargo build --bins --examples
node bench/golden/run-golden.mjs target/debug/RapidRAW --name v1.6.14-baseline
```

Real GPUs round differently than llvmpipe but typically land well inside the tolerance
gates. A case that fails only on real hardware points at a driver-precision-sensitive
stage — investigate before merging. Optionally `--record --name <device>-<backend>` keeps
a per-device baseline for future same-device comparisons.

**Android arm64:** the headless `export` subcommand is desktop-only, so the harness cannot
drive the device directly. Run the same golden set through the app instead: push
`bench/golden/images/` to the device, apply each `bench/golden/params/*.json` as the
image's sidecar edits, export all seven cases as 16-bit TIFF through the export dialog,
then `adb pull` them and compare against the baseline on a desktop machine:

```bash
cargo run --example golden_metrics -- compare bench/golden/baselines/v1.6.14-baseline/sky-backlit.png /tmp/device/sky-backlit.tiff
```

(and the same for the other six cases). Report the per-case table in the stage PR.

# Stage Timing Benchmark (GPU pipeline)

`compare-renders.sh` and the golden harness answer "did the output change". The stage-timing
benchmark answers "did the pipeline get slower or hungrier". It drives the real GPU pipeline
headless over a deterministic synthetic scene and measures, per the v2.0 plan (M0-4):

- **preview 1080p** — 24 frames of the full render path; wall clock mean/P50/P95 (first frame
  is the cold cache state and is reported separately from the steady state), plus per-stage
  GPU time from wgpu timestamp queries;
- **export 45MP** — one full-resolution 16-bit render, wall clock + per-stage GPU time;
- **memory** — peak RSS (VmHWM) growth during the export vs the base image bytes,
  budgeted at ≤ 2.5x.

Per-stage timings come from the `RAPIDRAW_STAGE_TIMING=1` wgpu timestamp probe
(`gpu_processing::StageProbe`): guided-filter coefficients, flare, the four guided blurs
(sharpness/tonal/clarity/structure), and the main compute pass per tile. Stages whose
adjustments are disabled (e.g. no flare in the params) legitimately read 0. Without the env
var the probe is compiled in but inert (one `Option` check per stage), and stage fields
read 0 while wall clock and memory are still measured. The probe needs
`Features::TIMESTAMP_QUERY | TIMESTAMP_QUERY_INSIDE_ENCODERS`; devices without them
(some drivers) fall back to wall clock only.

Record a baseline (before starting a stage that touches the pipeline):

```bash
cd src-tauri
RAPIDRAW_STAGE_TIMING=1 WGPU_BACKEND=Vulkan \
  cargo run --example bench_stages -- --out ../bench/perf/v1.6.14-baseline.json
```

Compare a candidate against it (exit 1 = budget breach, for CI):

```bash
node bench/perf/compare-perf.mjs bench/perf/v1.6.14-baseline.json bench/perf/candidate.json
```

Smaller/faster runs for quick sanity checks: `--iterations N --preview WxH --export WxH`
(e.g. `--iterations 4 --preview 960x540 --export 2048x1152`).

Interpreting the numbers:

- **Wall clock is the honest end-user number** (includes CPU submit + readback); per-stage
  GPU time is for diagnosis — it points at *which* stage moved. Stage timings are not gated:
  timestamp queries on software rasterizers are noisy, and the wall-clock gates already
  cover regressions.
- **Budgets** (enforced by `compare-perf.mjs`, exit 1 = breach): preview steady P95 and
  export wall clock may grow by at most +10%; the memory growth ratio may worsen by at most
  +10% versus the baseline. The v2.0 plan's absolute target of ≤ 2.5x base image bytes is
  reported as a non-blocking warning while recorded baselines sit above it (v1.6.14
  measures 8.4x on llvmpipe — the export working set is a known optimization target, see
  the plan's memory work); once a compliant baseline is recorded, exceeding 2.5x becomes a
  breach automatically. Intentional trade-offs (e.g. a quality feature that costs time)
  re-record the baseline in the stage PR with the before/after table attached, like the
  golden harness.
- **Machine-relative.** Like every benchmark here, absolute numbers are only meaningful on
  the same machine and backend (`llvmpipe`/`lavapipe` software rasterizers are far slower
  than any real GPU and are for regression detection, not UX claims). The commit message or
  PR should state which machine recorded a baseline; `compare-perf.mjs` warns on
  adapter/backend mismatch. The JSON report records adapter, backend and config so runs
  stay self-describing.

In CI, the `perf-gate` job of `render-regression.yml` (workflow_dispatch only) makes the
comparison valid despite this: it benchmarks **both** the dispatched ref and `base_ref` on
the same runner and gates the A/B with `compare-perf.mjs`. It is heavier than the golden
gate (two release builds) and therefore opt-in per run; the blocking habit for day-to-day
work remains a same-machine before/after run as shown above.
