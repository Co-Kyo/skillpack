// ============================================================
// skillnomad-validate — Reference integrity checker for skill pipelines
// ============================================================

import type {
  StepDefinition,
  ResolvedPipeline,
  SourcePhase,
} from 'skillnomad-types';
import {
  validateStep,
  validateDependencyRefs,
  validateBarrierContinuity,
  validateStepChain,
  validatePhaseCoverage,
  resolveStepOrder,
} from 'skillnomad-common';

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
 * 3. Linear chain contract (steps form a single chain, parallelism lives inside `flow`)
 * 4. Phase coverage — optional, only checked when phases are supplied
 * 5. Barrier continuity
 * 6. Circular dependency detection
 *
 * `phases` 是可选的：阶段声明是**派生阶段边界与流程总览的输入**，
 * 若提供了就必须自洽（覆盖、不重叠、连续、顺序一致），
 * 否则框架算出来的区间标注不可信。
 */
export function validatePipeline(
  steps: StepDefinition[],
  phases: SourcePhase[] = [],
): ValidationReport {
  const errors: Array<{ stepId: string; field: string; message: string }> = [];
  const warnings: Array<{ stepId: string; field: string; message: string }> = [];

  // Step-level validation
  errors.push(...steps.flatMap(validateStep));

  // Dependency references
  errors.push(...validateDependencyRefs(steps));

  // Linear chain contract
  errors.push(...validateStepChain(steps));

  // Phase coverage（阶段意图是派生值的唯一输入，不自洽就必须报错）
  errors.push(...validatePhaseCoverage(steps, phases));

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
