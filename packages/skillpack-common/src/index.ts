// ============================================================
// skillpack-common — Runtime helpers: graph walker, validation, template resolution
// ============================================================

import type {
  ControlNode,
  TaskNode,
  SeqNode,
  ParallelNode,
  MapNode,
  BranchNode,
  LoopNode,
  TaskDef,
  BarrierDef,
  StepDefinition,
  FileRef,
  ResolvedStep,
  ResolvedPipeline,
  PipelineState,
  PipelineStateManager,
  StepState,
  StepStatus,
} from '@co-kyo/skillpack-types';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------
// Template resolution
// ---------------------------------------------------------------

export function resolveBuildTimeVars(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (vars[key] !== undefined) return vars[key];
    throw new Error(`Unresolved build-time variable: {{${key}}}`);
  });
}

export function resolveRuntimeVars(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    if (vars[key] !== undefined) return vars[key];
    return `{${key}}`;
  });
}

export function resolveFileRef(
  ref: FileRef,
  buildVars: Record<string, string>,
): string {
  return resolveBuildTimeVars(ref.path, buildVars);
}

// ---------------------------------------------------------------
// Validation
// ---------------------------------------------------------------

export interface ValidationError {
  stepId: string;
  field: string;
  message: string;
}

/** Recursively validate a ControlNode tree */
function validateControlNode(
  node: ControlNode,
  path: string,
  errors: ValidationError[],
  stepId: string,
): void {
  if (!node || typeof node !== 'object') {
    errors.push({ stepId, field: path, message: 'Invalid node: must be an object' });
    return;
  }
  if (!node.kind || !['task', 'seq', 'parallel', 'map', 'branch', 'loop'].includes(node.kind)) {
    errors.push({ stepId, field: `${path}.kind`, message: `Invalid or missing kind: "${(node as any).kind}"` });
    return;
  }

  switch (node.kind) {
    case 'task':
      if (!node.task) {
        errors.push({ stepId, field: `${path}.task`, message: 'Task node must have a task property' });
      } else {
        if (!node.task.id) errors.push({ stepId, field: `${path}.task.id`, message: 'TaskDef id is required' });
        if (!node.task.label) errors.push({ stepId, field: `${path}.task.label`, message: 'TaskDef label is required' });
        if (!node.task.type) errors.push({ stepId, field: `${path}.task.type`, message: 'TaskDef type is required' });
        if (!node.task.body) errors.push({ stepId, field: `${path}.task.body`, message: 'TaskDef body is required' });
      }
      break;
    case 'seq':
      if (!node.id) errors.push({ stepId, field: `${path}.id`, message: 'SeqNode id is required' });
      if (!node.nodes || !Array.isArray(node.nodes)) {
        errors.push({ stepId, field: `${path}.nodes`, message: 'SeqNode must have a nodes array' });
      } else {
        node.nodes.forEach((child, i) => validateControlNode(child, `${path}.nodes[${i}]`, errors, stepId));
      }
      break;
    case 'parallel':
      if (!node.id) errors.push({ stepId, field: `${path}.id`, message: 'ParallelNode id is required' });
      if (!node.branches || !Array.isArray(node.branches)) {
        errors.push({ stepId, field: `${path}.branches`, message: 'ParallelNode must have a branches array' });
      } else {
        node.branches.forEach((child, i) => validateControlNode(child, `${path}.branches[${i}]`, errors, stepId));
      }
      break;
    case 'map':
      if (!node.id) errors.push({ stepId, field: `${path}.id`, message: 'MapNode id is required' });
      if (!node.worker) {
        errors.push({ stepId, field: `${path}.worker`, message: 'MapNode must have a worker node' });
      } else {
        validateControlNode(node.worker, `${path}.worker`, errors, stepId);
      }
      break;
    case 'branch':
      if (!node.id) errors.push({ stepId, field: `${path}.id`, message: 'BranchNode id is required' });
      if (!node.condition) errors.push({ stepId, field: `${path}.condition`, message: 'BranchNode must have a condition' });
      if (!node.then) {
        errors.push({ stepId, field: `${path}.then`, message: 'BranchNode must have a then node' });
      } else {
        validateControlNode(node.then, `${path}.then`, errors, stepId);
      }
      if (node.else) validateControlNode(node.else, `${path}.else`, errors, stepId);
      break;
    case 'loop':
      if (!node.id) errors.push({ stepId, field: `${path}.id`, message: 'LoopNode id is required' });
      if (!node.until) errors.push({ stepId, field: `${path}.until`, message: 'LoopNode must have an until condition' });
      if (!node.body) {
        errors.push({ stepId, field: `${path}.body`, message: 'LoopNode must have a body node' });
      } else {
        validateControlNode(node.body, `${path}.body`, errors, stepId);
      }
      break;
  }
}

export function validateStep(step: StepDefinition): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!step.id) {
    errors.push({ stepId: '(unknown)', field: 'id', message: 'Step id is required' });
  }
  if (!step.title) {
    errors.push({ stepId: step.id, field: 'title', message: 'Title is required' });
  }
  if (!step.description) {
    errors.push({ stepId: step.id, field: 'description', message: 'Description is required' });
  }

  if (!step.graph) {
    errors.push({ stepId: step.id, field: 'graph', message: 'Control tree graph is required' });
  } else {
    validateControlNode(step.graph, 'graph', errors, step.id);
  }

  if (!step.writes || step.writes.length === 0) {
    errors.push({ stepId: step.id, field: 'writes', message: 'At least one output file required' });
  }

  if (step.barrier) {
    if (!step.barrier.clarifyPrompt) {
      errors.push({ stepId: step.id, field: 'barrier.clarifyPrompt', message: 'Barrier must have a clarify prompt' });
    }
    if (!step.barrier.checkItems || step.barrier.checkItems.length === 0) {
      errors.push({ stepId: step.id, field: 'barrier.checkItems', message: 'Barrier must have at least one check item' });
    }
  }

  return errors;
}

export function validateBarrierContinuity(steps: StepDefinition[]): ValidationError[] {
  const errors: ValidationError[] = [];
  let lastBarrierIndex = -1;
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].barrier) lastBarrierIndex = i;
  }
  for (let i = 0; i <= lastBarrierIndex; i++) {
    if (!steps[i].barrier) {
      errors.push({
        stepId: steps[i].id,
        field: 'barrier',
        message: `Step "${steps[i].id}" at index ${i} is before the last barrier (index ${lastBarrierIndex}) but has no barrier defined`,
      });
    }
  }
  return errors;
}

export function validateDependencyRefs(steps: StepDefinition[]): ValidationError[] {
  const errors: ValidationError[] = [];
  const ids = new Set(steps.map(s => s.id));
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (!ids.has(dep)) {
        errors.push({
          stepId: step.id,
          field: 'dependsOn',
          message: `Depends on "${dep}" which is not a defined step`,
        });
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------
// Dependency resolver (topological sort)
// ---------------------------------------------------------------

export function resolveStepOrder(steps: StepDefinition[]): ResolvedPipeline {
  const idToStep = new Map(steps.map(s => [s.id, s]));
  const adj = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const step of steps) {
    adj.set(step.id, []);
    inDegree.set(step.id, 0);
  }
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      adj.get(dep)?.push(step.id);
      inDegree.set(step.id, (inDegree.get(step.id) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const step of steps) {
    if ((inDegree.get(step.id) ?? 0) === 0) queue.push(step.id);
  }

  const order: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    order.push(node);
    for (const neighbor of adj.get(node) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) queue.push(neighbor);
    }
  }

  if (order.length !== steps.length) {
    const missing = steps.filter(s => !order.includes(s.id)).map(s => s.id);
    throw new Error(`Circular dependency detected among steps: ${missing.join(', ')}`);
  }

  const stepOrder: Record<string, number> = {};
  const resolvedSteps: ResolvedStep[] = [];

  for (let seq = 0; seq < order.length; seq++) {
    const id = order[seq];
    stepOrder[id] = seq;
    const step = idToStep.get(id)!;
    const buildVars = { stepSeq: String(seq).padStart(2, '0'), stepId: id };

    resolvedSteps.push({
      ...step,
      seq,
      resolvedReads: step.reads.map(r => resolveFileRef(r, buildVars)),
      resolvedWrites: step.writes.map(r => resolveFileRef(r, buildVars)),
    });
  }

  return { name: 'untitled', description: '', steps: resolvedSteps, stepOrder };
}

// ---------------------------------------------------------------
// ControlNode tree walker（替代旧的扁平 graph + edges 遍历）
// ---------------------------------------------------------------

/** 递归遍历 ControlNode 树，对每个节点执行回调 */
export function walkGraph(
  graph: ControlNode,
  visit: (node: ControlNode, depth: number) => void,
): void {
  function recurse(node: ControlNode, depth: number): void {
    switch (node.kind) {
      case 'task':
        visit(node, depth);
        break;
      case 'seq':
        visit(node, depth);
        for (const child of node.nodes) {
          recurse(child, depth + 1);
        }
        break;
      case 'parallel':
        visit(node, depth);
        for (const branch of node.branches) {
          recurse(branch, depth + 1);
        }
        if (node.converge) {
          visit({ kind: 'task', task: node.converge }, depth + 1);
        }
        break;
      case 'map':
        visit(node, depth);
        recurse(node.worker, depth + 1);
        if (node.reduce) {
          visit({ kind: 'task', task: node.reduce }, depth + 1);
        }
        break;
      case 'branch':
        visit(node, depth);
        recurse(node.then, depth + 1);
        if (node.else) recurse(node.else, depth + 1);
        break;
      case 'loop':
        visit(node, depth);
        recurse(node.body, depth + 1);
        break;
    }
  }
  recurse(graph, 0);
}

/** 获取 ControlNode 树中所有叶子任务的扁平列表 */
export function collectTasks(graph: ControlNode): TaskDef[] {
  const tasks: TaskDef[] = [];
  walkGraph(graph, (node) => {
    if (node.kind === 'task') {
      tasks.push(node.task);
    }
  });
  return tasks;
}

/** 描述 ControlNode 树的拓扑结构（用于预览） */
export function describeControlTree(graph: ControlNode): string {
  const lines: string[] = [];
  walkGraph(graph, (node, depth) => {
    const indent = '  '.repeat(depth);
    switch (node.kind) {
      case 'task':
        lines.push(`${indent}▪ ${node.task.label} [${node.task.type}]`);
        break;
      case 'seq':
        lines.push(`${indent}▸ ${node.label} [seq: ${node.nodes.length} nodes]`);
        break;
      case 'parallel':
        lines.push(`${indent}▤ ${node.label} [parallel: ${node.branches.length} branches]`);
        if (node.converge) lines.push(`${indent}  ↳ converge: ${node.converge.label}`);
        break;
      case 'map':
        lines.push(`${indent}▦ ${node.label} [map: max ${node.maxConcurrency} concurrent]`);
        if (node.reduce) lines.push(`${indent}  ↳ reduce: ${node.reduce.label}`);
        break;
      case 'branch':
        lines.push(`${indent}◇ ${node.label} [branch: ${node.condition}]`);
        break;
      case 'loop':
        lines.push(`${indent}↻ ${node.label} [loop: until ${node.until}]`);
        break;
    }
  });
  return lines.join('\n');
}

// ---------------------------------------------------------------
// 运行时执行函数（stub — 平台适配时实现）
// ---------------------------------------------------------------

export async function executeControlTree(
  graph: ControlNode,
  context: { workDir: string; topic: string },
  state?: { pipelineState?: PipelineState; stepId?: string; manager?: PipelineStateManager },
): Promise<void> {
  if (state?.manager && state?.stepId && state?.pipelineState) {
    const updated = state.manager.markStep(state.pipelineState, state.stepId, 'running');
    state.manager.save(updated);
  }
  async function exec(node: ControlNode, depth: number): Promise<void> {
    const indent = '  '.repeat(depth);
    switch (node.kind) {
      case 'task':
        console.log(`${indent}▶ ${node.task.label} [${node.task.type}]`);
        console.log(`${indent}   body: ${node.task.body.substring(0, 80)}...`);
        break;
      case 'seq':
        console.log(`${indent}▸ Sequence: ${node.label}`);
        for (const child of node.nodes) {
          await exec(child, depth + 1);
        }
        break;
      case 'parallel':
        console.log(`${indent}▤ Parallel: ${node.label} (${node.branches.length} branches)`);
        for (const branch of node.branches) {
          await exec(branch, depth + 1);
        }
        if (node.converge) {
          console.log(`${indent}  ↳ converge: ${node.converge.label}`);
        }
        break;
      case 'map':
        console.log(`${indent}▦ Map: ${node.label} (maxConcurrency: ${node.maxConcurrency}, items: ${node.items})`);
        await exec(node.worker, depth + 1);
        if (node.reduce) {
          console.log(`${indent}  ↳ reduce: ${node.reduce.label}`);
        }
        break;
      case 'branch':
        console.log(`${indent}◇ Branch: ${node.label} (condition: ${node.condition})`);
        await exec(node.then, depth + 1);
        if (node.else) await exec(node.else, depth + 1);
        break;
      case 'loop':
        console.log(`${indent}↻ Loop: ${node.label} (until: ${node.until})`);
        await exec(node.body, depth + 1);
        break;
    }
  }
  await exec(graph, 0);

  if (state?.manager && state?.stepId && state?.pipelineState) {
    const updated = state.manager.markStep(state.pipelineState, state.stepId, 'completed');
    state.manager.save(updated);
  }
}

export async function executeBarrier(
  barrier: BarrierDef,
): Promise<'continue' | 'rollback' | 'modify'> {
  console.log(`\n=== Barrier ===`);
  for (const item of barrier.checkItems) {
    console.log(`  📋 ${item}`);
  }
  console.log(`Prompt: ${barrier.clarifyPrompt}`);
  console.log(`(non-interactive mode → continuing)\n`);
  return 'continue';
}

// ---------------------------------------------------------------
// Default PipelineStateManager implementation
// ---------------------------------------------------------------

export const defaultStateManager: PipelineStateManager = {
  load(pipelineName: string): PipelineState | null {
    try {
      const statePath = path.join(process.cwd(), '.skillpack-state.json');
      if (fs.existsSync(statePath)) {
        return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      }
    } catch {}
    return null;
  },

  save(state: PipelineState): void {
    const statePath = path.join(process.cwd(), '.skillpack-state.json');
    state.updatedAt = new Date().toISOString();
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
  },

  init(pipelineName: string, steps: string[]): PipelineState {
    const state: PipelineState = {
      pipelineName,
      version: '1.0',
      updatedAt: new Date().toISOString(),
      steps: {},
    };
    for (const stepId of steps) {
      state.steps[stepId] = { status: 'pending', outputs: [], runAttempt: 0 };
    }
    return state;
  },

  markStep(state: PipelineState, stepId: string, status: StepStatus, outputs?: string[], error?: string): PipelineState {
    if (!state.steps[stepId]) {
      state.steps[stepId] = { status, outputs: outputs || [], runAttempt: 0 };
    }
    state.steps[stepId].status = status;
    state.steps[stepId].runAttempt++;
    if (outputs) state.steps[stepId].outputs = outputs;
    if (error) state.steps[stepId].error = error;
    if (status === 'running') state.steps[stepId].startedAt = new Date().toISOString();
    if (status === 'completed' || status === 'failed') state.steps[stepId].completedAt = new Date().toISOString();
    return state;
  },

  getResumePoint(state: PipelineState): string | null {
    for (const [stepId, stepState] of Object.entries(state.steps)) {
      if (stepState.status !== 'completed') return stepId;
    }
    return null;
  },
};
