// ============================================================
// skillpack-validate — Reference integrity checker for skill pipelines
// ============================================================

import type { StepDefinition, ResolvedPipeline } from '@co-kyo/skillpack-types';
import {
  validateStep,
  validateDependencyRefs,
  validateBarrierContinuity,
  resolveStepOrder,
} from '@co-kyo/skillpack-common';

export interface ValidationReport {
  passed: boolean;
  errors: Array<{ stepId: string; field: string; message: string }>;
  warnings: Array<{ stepId: string; field: string; message: string }>;
  pipeline: ResolvedPipeline | null;
}

/**
 * Full validation of a step definition array:
 * 1. Individual step validation
 * 2. Dependency reference integrity
 * 3. Barrier continuity
 * 4. Circular dependency detection
 */
export function validatePipeline(steps: StepDefinition[]): ValidationReport {
  const errors: Array<{ stepId: string; field: string; message: string }> = [];
  const warnings: Array<{ stepId: string; field: string; message: string }> = [];

  // Step-level validation
  errors.push(...steps.flatMap(validateStep));

  // Dependency references
  errors.push(...validateDependencyRefs(steps));

  // Barrier continuity
  const barrierErrors = validateBarrierContinuity(steps);
  errors.push(...barrierErrors);

  // Check for duplicate step IDs
  const ids = steps.map(s => s.id);
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      errors.push({ stepId: id, field: 'id', message: `Duplicate step id: ${id}` });
    }
    seen.add(id);
  }

  // Warn if a step has no dependsOn and is not the first step
  const hasRoot = steps.some(s => s.dependsOn.length === 0);
  if (!hasRoot) {
    warnings.push({
      stepId: '(pipeline)',
      field: 'dependsOn',
      message: 'No root step found (all steps have dependsOn). At least one step should be a root.',
    });
  }

  // Try to resolve the dependency order
  let pipeline: ResolvedPipeline | null = null;
  if (errors.length === 0) {
    try {
      pipeline = resolveStepOrder(steps);
    } catch (e) {
      errors.push({
        stepId: '(pipeline)',
        field: 'topology',
        message: (e as Error).message,
      });
    }
  }

  return {
    passed: errors.length === 0,
    errors,
    warnings,
    pipeline,
  };
}
