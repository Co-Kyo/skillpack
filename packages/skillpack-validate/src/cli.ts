#!/usr/bin/env node

// ============================================================
// skillpack-validate CLI — Entry point for command-line validation
// ============================================================
//
// Usage:
//   skillpack-validate <path-to-pipeline-file>
//
// The pipeline file should export an array of StepDefinitions as default.
// ============================================================

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const filePath = process.argv[2];

if (!filePath) {
  console.error('Usage: skillpack-validate <path-to-pipeline-file>');
  process.exit(1);
}

const absPath = resolve(process.cwd(), filePath);

console.log(`skillpack-validate v0.1.0`);
console.log(`Validating: ${absPath}\n`);

try {
  // Dynamic import of the pipeline file
  const mod = await import(absPath);
  const steps = mod.default || mod.steps;

  if (!steps || !Array.isArray(steps)) {
    console.error('Pipeline file must export an array of StepDefinitions as default or named export `steps`.');
    process.exit(1);
  }

  const { validatePipeline } = await import('./index.js');
  const report = validatePipeline(steps);

  if (report.errors.length > 0) {
    console.error(`❌ ${report.errors.length} error(s):`);
    for (const err of report.errors) {
      console.error(`  [${err.stepId}] ${err.field}: ${err.message}`);
    }
  }

  if (report.warnings.length > 0) {
    console.warn(`\n⚠️  ${report.warnings.length} warning(s):`);
    for (const warn of report.warnings) {
      console.warn(`  [${warn.stepId}] ${warn.field}: ${warn.message}`);
    }
  }

  if (report.pipeline) {
    console.log(`\n✅ Pipeline is valid. Step order:`);
    for (const step of report.pipeline.steps) {
      console.log(`  ${String(step.seq).padStart(2, '0')}: ${step.id} — ${step.title}`);
    }
  }

  process.exit(report.passed ? 0 : 1);

} catch (e) {
  console.error(`\n❌ Failed to load or validate pipeline:`);
  console.error(`  ${(e as Error).message}`);
  process.exit(1);
}
