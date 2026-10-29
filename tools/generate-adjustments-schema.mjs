#!/usr/bin/env node
/**
 * Build-time generator for src-tauri/resources/adjustments-schema.json.
 *
 * Sources of truth:
 *   - src/utils/adjustmentsSchema.ts  (sections, param ranges, enums, nested specs, masks, formats)
 *   - src/utils/defaultAdjustments.json (default values)
 *
 * The generated JSON is embedded into the binary via include_str! and powers the
 * CLI `capabilities` / `validate` subcommands (see docs/agent-cli.md). Re-run after
 * changing adjustment definitions: `npm run schema:generate`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import esbuild from 'esbuild';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemaModulePath = path.join(repoRoot, 'src/utils/adjustmentsSchema.ts');
const defaultsPath = path.join(repoRoot, 'src/utils/defaultAdjustments.json');
const targetPath = path.join(repoRoot, 'src-tauri/resources/adjustments-schema.json');

// Bundle the dependency-free schema module to CJS and execute it in-process.
const bundle = await esbuild.build({
  entryPoints: [schemaModulePath],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  write: false,
  logLevel: 'warning',
});
const js = bundle.outputFiles[0].text;
const module = { exports: {} };
new Function('module', 'exports', js)(module, module.exports);

const {
  ADJUSTMENT_SECTIONS,
  ADJUSTMENT_PARAM_RANGES,
  ADJUSTMENT_ENUM_VALUES,
  OBJECT_PARAM_SPECS,
  ANY_CHECK_PARAMS,
  MASK_TYPES,
  SUB_MASK_MODES,
  EXPORT_FORMATS,
  TIFF_BIT_DEPTHS,
} = module.exports;

if (!ADJUSTMENT_SECTIONS || !ADJUSTMENT_PARAM_RANGES || !OBJECT_PARAM_SPECS) {
  console.error('Failed to evaluate adjustmentsSchema.ts bundle.');
  process.exit(1);
}

const defaults = JSON.parse(readFileSync(defaultsPath, 'utf8'));

const buildSpec = (name, defaultValue) => {
  const range = ADJUSTMENT_PARAM_RANGES[name];
  if (range) {
    return { type: 'number', min: range.min, max: range.max, step: range.step, default: defaultValue };
  }
  const enumValues = ADJUSTMENT_ENUM_VALUES[name];
  if (enumValues) {
    return { type: 'enum', values: enumValues, default: defaultValue };
  }
  const objectSpec = OBJECT_PARAM_SPECS[name];
  if (objectSpec) {
    return { ...objectSpec, default: defaultValue };
  }
  if (typeof defaultValue === 'boolean') {
    return { type: 'boolean', default: defaultValue };
  }
  return { type: 'any', default: defaultValue };
};

const params = {};
for (const [name, defaultValue] of Object.entries(defaults)) {
  params[name] = buildSpec(name, defaultValue);
}
// Bookkeeping/complex keys that may exist in recipes without a default entry.
for (const name of ANY_CHECK_PARAMS) {
  if (!(name in params)) {
    params[name] = { type: 'any' };
  }
}

const schema = {
  schemaVersion: 1,
  generator: 'tools/generate-adjustments-schema.mjs',
  sections: ADJUSTMENT_SECTIONS,
  params,
  maskTypes: MASK_TYPES,
  subMaskModes: SUB_MASK_MODES,
  exportFormats: EXPORT_FORMATS,
  tiffBitDepths: TIFF_BIT_DEPTHS,
};

writeFileSync(targetPath, `${JSON.stringify(schema, null, 2)}\n`);
console.log(
  `adjustments-schema.json generated: ${Object.keys(params).length} params, ` +
    `${Object.keys(ADJUSTMENT_SECTIONS).length} sections`,
);
