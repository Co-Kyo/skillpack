// ============================================================
// skillnomad-common — Runtime helpers: graph walker, validation, template resolution
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
} from 'skillnomad-types';
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
// Linear chain contract
// ---------------------------------------------------------------

/**
 * 链的终止标记。末步的 `next` 可显式指向它，表示「链到此结束」。
 */
export const CHAIN_TERMINAL = 'done';

/**
 * **线性链契约校验**
 *
 * 步骤（顶层 step）之间的关系是一条链，不是 DAG：顶层 step 是不可并行的执行单位，
 * 需要并行或分支时应在 `flow` 内部用 `parallel` / `map` 表达，
 * 而不是拆成多个顶层步骤。
 *
 * 本函数把该契约变成可执行约束，检查四类违规：
 * 1. **多依赖** —— 一个步骤声明了多于一个前驱；
 * 2. **多后继** —— 一个步骤被多于一个步骤指定为 `next`；
 * 3. **断链** —— 存在多个起点，或有步骤从起点不可达；
 * 4. **成环** —— 链首尾相接，无法终止。
 *
 * 悬空的 `dependsOn` 引用由 `validateDependencyRefs` 负责；此处额外校验 `next` 的指向。
 *
 * 违反契约会在构建期报错，**不会静默线性化**。
 */
export function validateStepChain(steps: StepDefinition[]): ValidationError[] {
  const errors: ValidationError[] = [];
  if (steps.length === 0) return errors;

  const ids = new Set(steps.map(s => s.id));

  // 1) 每个步骤最多一个前驱
  for (const step of steps) {
    if (step.dependsOn.length > 1) {
      errors.push({
        stepId: step.id,
        field: 'dependsOn',
        message:
          `Linear chain contract: step "${step.id}" declares ${step.dependsOn.length} ` +
          `dependencies (${step.dependsOn.join(', ')}); a top-level step may have at most one ` +
          `predecessor. Express parallelism inside the step via \`flow: parallel\` / \`map\` ` +
          `instead of splitting it into multiple top-level steps.`,
      });
    }
  }

  // 2) 每个步骤最多一个后继（next 是派生字段，仅在显式声明时校验）
  const predecessors = new Map<string, string[]>();
  for (const step of steps) {
    const nx = step.next;
    if (!nx || nx === CHAIN_TERMINAL || !ids.has(nx)) continue;
    predecessors.set(nx, [...(predecessors.get(nx) ?? []), step.id]);
  }
  for (const [target, sources] of predecessors) {
    if (sources.length > 1) {
      errors.push({
        stepId: target,
        field: 'next',
        message:
          `Linear chain contract: step "${target}" is targeted as next by ${sources.length} ` +
          `steps (${sources.join(', ')}); a top-level step may have at most one successor.`,
      });
    }
  }

  // 3) next 必须指向真实步骤，或使用终止标记
  for (const step of steps) {
    const nx = step.next;
    if (nx && nx !== CHAIN_TERMINAL && !ids.has(nx)) {
      errors.push({
        stepId: step.id,
        field: 'next',
        message:
          `Linear chain contract: step "${step.id}" declares next "${nx}" which is not a ` +
          `defined step. Use the terminal marker "${CHAIN_TERMINAL}" to end the chain.`,
      });
    }
  }

  // 4) 断链与成环：由 dependsOn 反推链，从唯一起点遍历
  // 入度 = 该步骤声明了几个前驱（只计指向真实步骤的那些）
  const indegree = new Map<string, number>(steps.map(s => [s.id, 0]));
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (ids.has(dep)) indegree.set(step.id, (indegree.get(step.id) ?? 0) + 1);
    }
  }
  // 入度为 0 即链起点
  const roots = steps.filter(s => (indegree.get(s.id) ?? 0) === 0).map(s => s.id);

  if (roots.length === 0) {
    errors.push({
      stepId: '(pipeline)',
      field: 'dependsOn',
      message:
        'Linear chain contract: no root step found — every step has a predecessor, ' +
        'so the chain is circular.',
    });
    return errors;
  }

  if (roots.length > 1) {
    errors.push({
      stepId: '(pipeline)',
      field: 'dependsOn',
      message:
        `Linear chain contract: ${roots.length} root steps found (${roots.join(', ')}). ` +
        `Steps must form a single connected chain; a second root means the chain is broken.`,
    });
  }

  const successorOf = new Map<string, string>();
  for (const step of steps) {
    for (const dep of step.dependsOn) successorOf.set(dep, step.id);
  }

  const visited = new Set<string>();
  let cursor: string | undefined = roots[0];
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    cursor = successorOf.get(cursor);
  }

  if (cursor) {
    errors.push({
      stepId: cursor,
      field: 'dependsOn',
      message: `Linear chain contract: loop detected — step "${cursor}" is revisited while walking the chain.`,
    });
  } else if (visited.size !== steps.length) {
    const orphans = steps.filter(s => !visited.has(s.id)).map(s => s.id);
    errors.push({
      stepId: '(pipeline)',
      field: 'dependsOn',
      message:
        `Linear chain contract: chain is disconnected — ${orphans.length} step(s) unreachable ` +
        `from the root (${orphans.join(', ')}).`,
    });
  }

  return errors;
}

// ---------------------------------------------------------------
// Linear chain derivation（派生：顺序的副产物由框架算，不要求手写）
// ---------------------------------------------------------------

/**
 * 走一遍线性链，返回**自起点起的有序 id 列表**——数组下标即步骤序号。
 *
 * 这是链上一切派生值的共同底座：`next`、`initStepId`、
 * 阶段区间标注都从它算起。集中一处的原因很直接：
 * 每个派生函数各写一遍遍历，就会各漂移一遍。
 *
 * 返回 `null` 表示链不成立（多个起点 / 成环 / 断链）——此时**不猜测**，
 * 诊断交给 `validateStepChain()`，派生函数一律回落为「不产出」。
 */
export function resolveChain(
  steps: Array<{ id: string; dependsOn: string[] }>,
): string[] | null {
  if (steps.length === 0) return [];

  const ids = new Set(steps.map(s => s.id));

  // 入度 = 声明了几个真实存在的前驱
  const indegree = new Map<string, number>(steps.map(s => [s.id, 0]));
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (ids.has(dep)) indegree.set(step.id, (indegree.get(step.id) ?? 0) + 1);
    }
  }
  const roots = steps.filter(s => (indegree.get(s.id) ?? 0) === 0).map(s => s.id);
  if (roots.length !== 1) return null; // 链不唯一 → 不猜测

  // 前驱 → 后继
  const successorOf = new Map<string, string>();
  for (const step of steps) {
    for (const dep of step.dependsOn) successorOf.set(dep, step.id);
  }

  const chain: string[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = roots[0];
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    chain.push(cursor);
    cursor = successorOf.get(cursor);
  }

  // 未走完说明有环或断链 —— 同样不猜测
  return chain.length === steps.length ? chain : null;
}

/**
 * 由步骤声明推导线性链的**下一跳映射**。
 *
 * `next` 是派生值：开发者声明了 `dependsOn`（或什么都不声明而由链序决定）之后，
 * 下一步是谁应该由框架算出来，而不是让人再抄一遍。
 *
 * 只需 `id` 与 `dependsOn`，不依赖完整模型，
 * 因此可以在渲染步骤正文之前调用。
 *
 * - 末步的下一跳为终止标记 `CHAIN_TERMINAL`；
 * - 若链不唯一（多个起点）或不成链，返回空对象——此时不猜测，
 *   交由 `validateStepChain()` 报错说明原因。
 */
export function deriveChainNext(
  steps: Array<{ id: string; dependsOn: string[] }>,
): Record<string, string> {
  const nextOf: Record<string, string> = {};
  const chain = resolveChain(steps);
  if (!chain) return nextOf;

  for (let i = 0; i < chain.length; i++) {
    nextOf[chain[i]] = chain[i + 1] ?? CHAIN_TERMINAL;
  }
  return nextOf;
}

/**
 * 由步骤声明推导**链起点**，即负责 pipeline 初始化的步骤。
 *
 * `initStepId` 是派生值：链已经声明了谁没有前驱，
 * 「第一步是谁」不该再由人抄一遍字面量。
 *
 * 链不成立时返回 `undefined`——不猜测，交由 `validateStepChain()` 说明原因。
 */
export function deriveInitStepId(
  steps: Array<{ id: string; dependsOn: string[] }>,
): string | undefined {
  const chain = resolveChain(steps);
  return chain && chain.length > 0 ? chain[0] : undefined;
}

// ---------------------------------------------------------------
// Phase intervals（派生：阶段边界与流程总览由框架算，不要求手写）
// ---------------------------------------------------------------

/** 一个阶段在链上的边界——全部由「阶段意图 + 链序」推导，无一手写。 */
export interface PhaseInterval {
  /** 阶段名（开发者声明的事实） */
  name: string;
  /** 该阶段在链上的起止序号（派生） */
  startSeq: number;
  endSeq: number;
  /** 该阶段包含的步骤 id，按链序排列（派生） */
  stepIds: string[];
  /** 区间标注，如 `(00)` / `(04-06)`（派生，可直接渲染） */
  label: string;
}

/** `(04-06)`；单步阶段简写为 `(04)`。序号两位补零，与 processes 文件名一致。 */
export function formatInterval(startSeq: number, endSeq: number): string {
  const nn = (n: number) => String(n).padStart(2, '0');
  return startSeq === endSeq ? `(${nn(startSeq)})` : `(${nn(startSeq)}-${nn(endSeq)})`;
}

/**
 * 由「阶段包含哪些步骤」+ 链序，推导每个阶段的**边界与区间标注**。
 *
 * 开发者只声明意图（`phases[].stepIds`），不声明下标；
 * 「第几步到第几步」是顺序的副产物，属于框架。
 *
 * 链不成立、或某个阶段引用了链外的步骤时返回 `[]`——不猜测，
 * 诊断交给 `validatePhaseCoverage()`。
 */
export function derivePhaseIntervals(
  steps: Array<{ id: string; dependsOn: string[] }>,
  phases: Array<{ name: string; stepIds: string[] }>,
): PhaseInterval[] {
  if (phases.length === 0) return [];
  const chain = resolveChain(steps);
  if (!chain) return [];

  const seqOf = new Map(chain.map((id, i) => [id, i]));

  const intervals: PhaseInterval[] = [];
  for (const phase of phases) {
    // 只要声明里有一步不在链上，整段边界都不可信 → 不产出
    if (phase.stepIds.some(id => !seqOf.has(id))) return [];

    const seqs = phase.stepIds.map(id => seqOf.get(id)!).sort((a, b) => a - b);
    const startSeq = seqs[0];
    const endSeq = seqs[seqs.length - 1];
    intervals.push({
      name: phase.name,
      startSeq,
      endSeq,
      stepIds: seqs.map(seq => chain[seq]),
      label: formatInterval(startSeq, endSeq),
    });
  }
  return intervals;
}

/** 阶段之间的连接符，同时用于总览图与列宽计算。 */
const PHASE_ARROW = ' → ';

/**
 * 按东亚宽度规则计算显示宽度：CJK 与全角占两列，其余占一列。
 * 对齐必须按显示宽度算，否则中文阶段名下方的标注会整体偏移。
 */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0x303e) ||
      (cp >= 0x3041 && cp <= 0x33ff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xa000 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd);
    width += wide ? 2 : 1;
  }
  return width;
}

/**
 * 由阶段区间推导**流程总览**（两行：阶段名一行，区间标注一行）。
 *
 * `flowOverview` 是派生值：开发者声明了阶段意图之后，
 * 「第几步到第几步」应该由框架算出来，而不是让人再抄一遍并对齐空格。
 *
 * 开发者仍可用 `meta.flowOverview` 覆盖——布局属于表达，框架不垄断，
 * 只是不再**要求**手写。
 *
 * 无法推导时返回 `undefined`（此时渲染器回落到纯箭头图）。
 */
export function deriveFlowOverview(
  steps: Array<{ id: string; dependsOn: string[] }>,
  phases: Array<{ name: string; stepIds: string[] }>,
): string | undefined {
  const intervals = derivePhaseIntervals(steps, phases);
  if (intervals.length === 0) return undefined;

  const line1 = intervals.map(p => p.name).join(PHASE_ARROW);
  const arrowWidth = displayWidth(PHASE_ARROW);

  // 第二行：把每个区间标注居中排在其阶段名下方。
  // 标注比阶段名宽时（常见于多步阶段）会自然向左溢出，
  // 再用 `minCol` 保证相邻标注之间至少留一列，避免粘连。
  const placed: Array<{ at: number; label: string }> = [];
  let nameCol = 0;
  let minCol = 0;
  for (const p of intervals) {
    const nameWidth = displayWidth(p.name);
    const labelWidth = displayWidth(p.label);
    const centered = nameCol + Math.max(0, Math.floor((nameWidth - labelWidth) / 2));
    const at = Math.max(centered, minCol);
    placed.push({ at, label: p.label });
    minCol = at + labelWidth + 1;
    nameCol += nameWidth + arrowWidth;
  }

  let line2 = '';
  for (const { at, label } of placed) {
    if (at > line2.length) line2 += ' '.repeat(at - line2.length);
    line2 += label;
  }

  return `${line1}\n${line2}`;
}

/**
 * 校验「阶段意图」是否能安全地作为派生来源。
 *
 * 阶段是派生阶段边界与流程总览的唯一输入，因此它必须满足：
 * 引用的步骤存在、覆盖链上每一步且不重叠、每段连续、声明顺序与链序一致。
 * 任一条件不满足就报错——因为此时框架算出来的区间标注是不可信的。
 */
export function validatePhaseCoverage(
  steps: Array<{ id: string; dependsOn: string[] }>,
  phases: Array<{ name: string; stepIds: string[] }>,
): ValidationError[] {
  const errors: ValidationError[] = [];
  if (phases.length === 0) return errors;

  const ids = new Set(steps.map(s => s.id));
  const chain = resolveChain(steps);

  // 1) 阶段引用的步骤必须存在
  const ownerOf = new Map<string, string>();
  for (const phase of phases) {
    for (const id of phase.stepIds) {
      if (!ids.has(id)) {
        errors.push({
          stepId: id,
          field: 'phases',
          message: `Phase "${phase.name}" references step "${id}" which is not defined.`,
        });
        continue;
      }
      const owner = ownerOf.get(id);
      if (owner !== undefined) {
        errors.push({
          stepId: id,
          field: 'phases',
          message:
            `Step "${id}" is claimed by more than one phase ` +
            `("${owner}" and "${phase.name}"); phases must partition the chain.`,
        });
        continue;
      }
      ownerOf.set(id, phase.name);
    }
  }

  // 2) 覆盖：链上每一步都必须恰好属于一个阶段
  if (chain) {
    const uncovered = chain.filter(id => !ownerOf.has(id));
    if (uncovered.length > 0) {
      errors.push({
        stepId: '(pipeline)',
        field: 'phases',
        message:
          `Phases declare ${ownerOf.size} of ${chain.length} steps; ` +
          `${uncovered.length} step(s) uncovered: ${uncovered.join(', ')}.`,
      });
    }
  }

  if (!chain) return errors;
  const seqOf = new Map(chain.map((id, i) => [id, i]));

  // 3) 连续：一个阶段必须是链上的一段连续区间
  for (const phase of phases) {
    if (phase.stepIds.some(id => !ids.has(id))) continue; // 已在上一步报错，跳过
    if (phase.stepIds.length === 0) continue;
    const seqs = phase.stepIds.map(id => seqOf.get(id)!).sort((a, b) => a - b);
    const span = seqs[seqs.length - 1] - seqs[0] + 1;
    if (span !== seqs.length) {
      errors.push({
        stepId: '(pipeline)',
        field: 'phases',
        message:
          `Phase "${phase.name}" spans ${formatInterval(seqs[0], seqs[seqs.length - 1])} ` +
          `but claims only ${seqs.length} step(s); a phase must be a contiguous run ` +
          `on the chain.`,
      });
    }
  }

  // 4) 顺序：阶段声明顺序必须与链序一致
  for (let i = 1; i < phases.length; i++) {
    const prev = phases[i - 1];
    const curr = phases[i];
    if (prev.stepIds.length === 0 || curr.stepIds.length === 0) continue;
    if (prev.stepIds.some(id => !ids.has(id)) || curr.stepIds.some(id => !ids.has(id))) continue;
    const prevEnd = Math.max(...prev.stepIds.map(id => seqOf.get(id)!));
    const currStart = Math.min(...curr.stepIds.map(id => seqOf.get(id)!));
    if (currStart <= prevEnd) {
      errors.push({
        stepId: '(pipeline)',
        field: 'phases',
        message:
          `Phases are declared out of order: "${prev.name}" ends at step ` +
          `${String(prevEnd).padStart(2, '0')} but "${curr.name}" starts at step ` +
          `${String(currStart).padStart(2, '0')}.`,
      });
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
      const statePath = path.join(process.cwd(), '.skillnomad-state.json');
      if (fs.existsSync(statePath)) {
        return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      }
    } catch {}
    return null;
  },

  save(state: PipelineState): void {
    const statePath = path.join(process.cwd(), '.skillnomad-state.json');
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
