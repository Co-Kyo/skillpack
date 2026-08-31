// ============================================================
// skillnomad — Resolver + Markdown generator
//
// renderSchedule 不再 switch(mode)，
// 而是遍历 ScheduleGraph，按节点 kind 逐个渲染
// ============================================================

import type {
  SkillDefinition,
  StepDefinition,
  ResolvedStep,
  ResolvedPipeline,
  ControlNode,
  TaskNode,
  SeqNode,
  ParallelNode,
  MapNode,
  BranchNode,
  LoopNode,
  TaskDef,
  PipelineDefinition,
  PipelineState,
  PipelineStateManager,
  SkillApiMetadata,
  SkillSourceModel,
  SourceAction,
  SourceFlow,
  SourceInstruction,
  SourceRef,
  SourceStep,
  SourceCheckpoint,
  SourceReuseRule,
  SourceDegrade,
  SourceTraceEntry,
  FileRef,
  ReuseRule,
  BarrierDef,
  DegradeProtocol,
} from 'skillnomad-types';
import {
  task,
  seq,
  parallel,
  mapNode,
  branch,
  loop,
} from 'skillnomad-types';
import {
  CHAIN_TERMINAL,
  resolveStepOrder,
  validateStep,
  validateBarrierContinuity,
  validateDependencyRefs,
  validateStepChain,
  validatePhaseCoverage,
  resolveChain,
  deriveChainNext,
  deriveInitStepId,
  deriveFlowOverview,
  derivePhaseIntervals,
  formatInterval,
} from 'skillnomad-common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

export { resolveStepOrder };
export {
  CHAIN_TERMINAL,
  validateStep,
  validateBarrierContinuity,
  validateDependencyRefs,
  validateStepChain,
  validatePhaseCoverage,
  resolveChain,
  deriveChainNext,
  deriveInitStepId,
  deriveFlowOverview,
  derivePhaseIntervals,
  formatInterval,
};

export interface SkillMeta {
  name: string;
  title?: string;
  description: string;
  api?: SkillApiMetadata;
}

function sourceRef(ref: SourceRef): FileRef {
  return {
    path: ref.path,
    description: ref.description ?? ref.path,
    schema: ref.schema,
    required: ref.required,
  };
}

function sourceAction(action: SourceAction): TaskDef {
  return {
    id: action.id,
    label: action.label,
    type: action.actor,
    verb: action.verb,
    body: action.content,
    timeout: action.timeout,
    retry: action.retry
      ? {
          maxRetries: action.retry.max,
          backoff: action.retry.backoff,
          delayMs: 1000,
        }
      : undefined,
  };
}

function convertSourceFlow(flow: SourceFlow): ControlNode {
  switch (flow.kind) {
    case 'do':
      return task(sourceAction(flow.task));
    case 'seq':
      return seq(flow.id, flow.label, flow.steps.map(convertSourceFlow));
    case 'parallel':
      return parallel(
        flow.id,
        flow.label,
        flow.branches.map(convertSourceFlow),
        {
          gate: flow.gate,
          converge: flow.converge ? sourceAction(flow.converge) : undefined,
        },
      );
    case 'map':
      return mapNode(
        flow.id,
        flow.label,
        flow.over.path,
        convertSourceFlow(flow.worker),
        flow.maxConcurrency,
      );
    case 'branch':
      return branch(
        flow.id,
        flow.label,
        flow.when,
        convertSourceFlow(flow.then),
        flow.else ? convertSourceFlow(flow.else) : undefined,
      );
    case 'loop':
      return loop(
        flow.id,
        flow.label,
        flow.until,
        convertSourceFlow(flow.body),
        flow.maxIterations,
      );
  }
}

function convertCheckpoint(checkpoint?: SourceCheckpoint): BarrierDef | undefined {
  if (!checkpoint) return undefined;
  return {
    checkItems: checkpoint.checkItems,
    clarifyPrompt: checkpoint.clarifyPrompt,
    onConfirm: checkpoint.onConfirm,
    onReject: checkpoint.onReject,
  };
}

function convertReuse(rules?: SourceReuseRule[]): ReuseRule[] | undefined {
  return rules?.map(rule => ({
    checkFile: rule.ifExists,
    skipDescription: rule.skipDescription,
  }));
}

function convertDegrade(degrade?: SourceDegrade): DegradeProtocol | undefined {
  if (!degrade) return undefined;
  return {
    maxRetries: degrade.maxRetries,
    onDegrade: degrade.onDegrade,
    fallbackTask: degrade.fallback,
  };
}

/**
 * 渲染步骤正文。
 *
 * `derivedNext` 是框架由链序推导出的下一跳（见 `deriveChainNext`）。
 * 只有当开发者既没写 `instruction.next`、框架也推导不出来时，才回落到「最终结束」。
 * 这样 `next` 就从「必须手写的字段」变成了「可选覆盖的派生值」。
 */
function renderInstruction(step: SourceStep, derivedNext?: string): string {
  const instruction = step.instruction;
  const nextLabel = instruction.next ?? derivedNext ?? '最终结束';
  let md = `# ${step.title}\n\n`;
  md += `## 目标\n\n${instruction.target}\n\n`;

  if (instruction.purpose) {
    md += `> ${instruction.purpose}\n\n`;
  }

  if (instruction.inputs.length > 0) {
    md += `## 输入\n\n`;
    for (const input of instruction.inputs) {
      md += `- ${input}\n`;
    }
    md += '\n';
  }

  if (instruction.actions.length > 0) {
    md += `## 执行动作\n\n`;
    instruction.actions.forEach((action, index) => {
      md += `${index + 1}. ${action}\n`;
    });
    md += '\n';
  }

  if (instruction.outputs.length > 0) {
    md += `## 输出\n\n`;
    for (const output of instruction.outputs) {
      md += `- ${output}\n`;
    }
    md += '\n';
  }

  if (instruction.validation.length > 0) {
    md += `## 校验清单\n\n`;
    for (const item of instruction.validation) {
      const ref = item.ref ? ` ${item.ref}` : '';
      md += `- [ ] [${item.type}]${ref}: ${item.description}\n`;
    }
    md += '\n';
  }

  if (instruction.exceptions.length > 0) {
    md += `## 失败处理\n\n`;
    md += `| 触发 | 行为 | 处理 |\n`;
    md += `|------|------|------|\n`;
    for (const exception of instruction.exceptions) {
      md += `| ${exception.on} | ${exception.behavior} | ${exception.then} |\n`;
    }
    md += '\n';
  }

  if (instruction.checkpointNote) {
    md += `## 检查点\n\n${instruction.checkpointNote}\n\n`;
  }

  md += `## 下一步\n\n${nextLabel}\n`;

  if (instruction.contractRefs && instruction.contractRefs.length > 0) {
    md += `\n## 契约引用\n\n`;
    for (const ref of instruction.contractRefs) {
      md += `- \`${ref.path}\`${ref.description ? `：${ref.description}` : ''}\n`;
    }
  }

  if (instruction.detail) {
    md += `\n## 详细说明\n\n${instruction.detail}\n`;
  }

  if (instruction.sections) {
    for (const [name, content] of Object.entries(instruction.sections)) {
      md += `\n## ${name}\n\n${content}\n`;
    }
  }

  if (instruction.taskTemplates) {
    md += `\n## 任务模板\n\n`;
    for (const [name, template] of Object.entries(instruction.taskTemplates)) {
      md += `### ${name}\n\n\`\`\`text\n${template}\n\`\`\`\n`;
    }
  }

  return md;
}

function sourceTraceForStep(step: SourceStep): SourceTraceEntry[] {
  const instruction = step.instruction;
  const sourceFile = 'skill.ts';
  const trace = (
    section: string,
    sourceField: string,
    sourceLayer: SourceTraceEntry['sourceLayer'],
    sourceKind: SourceTraceEntry['sourceKind'],
  ): SourceTraceEntry => ({ section, sourceField, sourceFile, sourceLayer, sourceKind });
  const entries: SourceTraceEntry[] = [
    trace('目标', 'instruction.target', 'steps', 'content'),
  ];

  if (instruction.purpose) {
    entries.push(trace('目的', 'instruction.purpose', 'steps', 'content'));
  }
  if (instruction.inputs.length > 0) {
    entries.push(trace('输入', 'instruction.inputs', 'steps', 'content'));
  }
  if (instruction.actions.length > 0) {
    entries.push(trace('执行动作', 'instruction.actions', 'steps', 'content'));
  }
  if (instruction.outputs.length > 0) {
    entries.push(trace('输出', 'instruction.outputs', 'steps', 'content'));
  }
  if (instruction.validation.length > 0) {
    entries.push(trace('校验清单', 'instruction.validation', 'steps', 'rule'));
  }
  if (instruction.exceptions.length > 0) {
    entries.push(trace('失败处理', 'instruction.exceptions', 'steps', 'rule'));
  }
  if (instruction.checkpointNote) {
    entries.push(trace('检查点', 'instruction.checkpointNote', 'steps', 'content'));
  }
  entries.push(trace('下一步', 'instruction.next', 'steps', 'path'));
  if (instruction.contractRefs && instruction.contractRefs.length > 0) {
    entries.push(trace('契约引用', 'instruction.contractRefs', 'contracts', 'schema'));
  }
  if (instruction.detail) {
    entries.push(trace('详细说明', 'instruction.detail', 'steps', 'content'));
  }
  if (instruction.sections) {
    for (const name of Object.keys(instruction.sections)) {
      entries.push(trace(name, `instruction.sections['${name}']`, 'steps', 'content'));
    }
  }
  if (instruction.taskTemplates) {
    for (const name of Object.keys(instruction.taskTemplates)) {
      entries.push(trace(name, `instruction.taskTemplates['${name}']`, 'steps', 'content'));
    }
  }
  entries.push(trace('文件引用', 'reads/writes', 'contracts', 'path'));
  entries.push(trace('调度策略', 'flow', 'steps', 'render'));
  if (step.checkpoint) {
    entries.push(trace('Barrier', 'checkpoint', 'steps', 'rule'));
  }
  return entries;
}

export function resolveStepRefs(
  text: string,
  stepOrder: Record<string, number>,
): string {
  // 0.2.0:新增 {{num:id}}(两位补零序号,与 processes 文件名一致);
  // {{step:id}} 行为保持不变。
  return text.replace(
    /\{\{(step|num):([A-Za-z0-9_-]+)\}\}/g,
    (_match: string, kind: string, id: string) => {
      const seq = stepOrder[id];
      if (seq === undefined) {
        throw new Error(`Unresolved step reference: {{${kind}:${id}}}`);
      }
      const nn = String(seq).padStart(2, '0');
      return kind === 'step' ? `Step ${nn}` : nn;
    },
  );
}

export function createSkillFromModel(model: SkillSourceModel): SkillDefinition {
  // 线性链契约：顺序的副产物一律由框架推导，不要求开发者手写。
  // 在渲染步骤正文之前算好，renderInstruction 会把推导值作为回落。
  const chainNext = deriveChainNext(model.steps);

  // initStepId 是派生值：链已经声明了谁没有前驱。
  // 开发者仍可显式指定（他更清楚哪一步承载初始化规则），但不是必须。
  const initStepId = model.meta.initStepId ?? deriveInitStepId(model.steps);

  // flowOverview 是派生值：阶段意图 + 链序即可算出区间标注。
  // 开发者可用 meta.flowOverview 覆盖布局，但不是必须。
  const flowOverview =
    model.meta.flowOverview ?? deriveFlowOverview(model.steps, model.meta.phases ?? []);

  return {
    name: model.meta.name,
    title: model.meta.title,
    description: model.meta.description,
    api: {
      frontmatterDescription: model.meta.frontmatterDescription,
      callExamples: model.meta.callExamples,
      usageNote: model.meta.usageNote,
      isolationNote: model.meta.isolationNote,
      includeBuildFooter: model.meta.includeBuildFooter,
      params: model.meta.params,
      phases: model.meta.phases,
      initRules: model.meta.initRules,
      initStepId,
      flowOverview,
    },
    steps: model.steps.map(step => ({
      id: step.id,
      title: step.title,
      description: step.summary ?? step.purpose ?? step.instruction.target,
      dependsOn: step.dependsOn,
      initRules: step.initRules,
      runtimeTrace: model.policies.runtimeTrace,
      body: renderInstruction(step, chainNext[step.id]),
      sourceTrace: sourceTraceForStep(step),
      next: step.next ?? chainNext[step.id],
      graph: convertSourceFlow(step.flow),
      reads: step.reads.map(sourceRef),
      writes: step.writes.map(sourceRef),
      barrier: convertCheckpoint(step.checkpoint),
      decisionSummary: step.decision,
      display: step.display,
      reuse: convertReuse(step.reuse),
      degrade: convertDegrade(step.degrade),
      plugins: step.plugins,
    })),
  };
}

// ---------------------------------------------------------------
// Config: skillnomad.config.ts 的类型 + 辅助函数
// ---------------------------------------------------------------

export interface SkillnomadConfig {
  /** 链接到 skill 定义文件的路径（如 ./skill.ts） */
  skill: string;
  /** 输出目录（相对于 cwd） */
  outputDir: string;
  /** 可选的 meta 覆盖项 */
  meta?: Partial<SkillMeta>;
}

/** 创建 skillnomad 配置（纯类型辅助，返回传入的对象） */
export function defineConfig(config: SkillnomadConfig): SkillnomadConfig {
  return config;
}

// ---------------------------------------------------------------
// Graph-based Markdown renderer
// ---------------------------------------------------------------

function resolveBodyFile(bodyFile: string): string {
  const absPath = path.resolve(process.cwd(), bodyFile);
  if (!fs.existsSync(absPath)) {
    throw new Error(`bodyFile not found: ${bodyFile} (resolved ${absPath})`);
  }
  return fs.readFileSync(absPath, 'utf-8');
}

function resolveTaskBody(task: TaskDef): string {
  return task.bodyFile ? resolveBodyFile(task.bodyFile) : task.body;
}

/** 递归渲染 ControlNode 树 */
function renderControlTree(node: ControlNode, depth: number): string {
  const indent = '  '.repeat(depth);

  switch (node.kind) {
    case 'task': {
      const t = node.task;
      const body = resolveTaskBody(t);
      let md = `${indent}- Task：\`${t.label}\` [${t.type}]\n`;
      if (t.timeout) md += `${indent}  超时：${t.timeout} min\n`;
      if (t.tools && t.tools.length > 0) {
        md += `${indent}  工具：${t.tools.join(', ')}\n`;
      }
      md += `${indent}  Body：\n\`\`\`\n${body}\n\`\`\`\n`;
      return md;
    }
    case 'seq': {
      let md = `${indent}▸ 顺序执行：${node.label}（${node.nodes.length} 步）\n\n`;
      for (let i = 0; i < node.nodes.length; i++) {
        md += `${indent}  第 ${i + 1} 步：\n`;
        md += renderControlTree(node.nodes[i], depth + 2);
        md += '\n';
      }
      return md;
    }
    case 'parallel': {
      let md = `${indent}▤ 并行分支：${node.label}（${node.branches.length} 条分支）\n\n`;
      for (let i = 0; i < node.branches.length; i++) {
        md += `${indent}  分支 ${i + 1}：\n`;
        md += renderControlTree(node.branches[i], depth + 2);
        md += '\n';
      }
      if (node.gate) {
        const failText = node.gate.onFail === 'halt'
          ? '停止'
          : node.gate.onFail === 'userChoice'
            ? '用户决策'
            : '降级继续';
        md += `${indent}  🛑 质量门禁\n`;
        md += `${indent}    - 规则：${node.gate.rule}\n`;
        md += `${indent}    - 通过 → ${node.gate.onPass === 'converge' ? '启动收敛者' : '跳过'}\n`;
        md += `${indent}    - 失败 → ${failText}\n`;
      }
      if (node.converge) {
        const convergeBody = resolveTaskBody(node.converge);
        md += `${indent}  收敛者：\`${node.converge.label}\` [${node.converge.type}]\n`;
        md += `${indent}    超时：${node.converge.timeout ?? 5} min\n`;
        md += `${indent}    Body：\n\`\`\`\n${convergeBody}\n\`\`\`\n`;
      }
      return md;
    }
    case 'map': {
      const slotNote = node.slotOccupancy && node.slotOccupancy > 1
        ? `（每个条目占 ${node.slotOccupancy} 个槽位）`
        : '';
      let md = `${indent}▦ 滚动窗口：${node.label}\n`;
      md += `${indent}  - 最大并发：${node.maxConcurrency} ${slotNote}\n`;
      md += `${indent}  - 数据来源：${node.items}\n\n`;
      md += `${indent}  Worker：\n`;
      md += renderControlTree(node.worker, depth + 2);
      md += '\n';
      if (node.reduce) {
        const reduceBody = resolveTaskBody(node.reduce);
        md += `${indent}  Reduce：\`${node.reduce.label}\` [${node.reduce.type}]\n`;
        md += `${indent}    超时：${node.reduce.timeout ?? 5} min\n`;
        md += `${indent}    Body：\n\`\`\`\n${reduceBody}\n\`\`\`\n`;
      }
      return md;
    }
    case 'branch': {
      let md = `${indent}◇ 条件分支：${node.label}\n`;
      md += `${indent}  条件：${node.condition}\n\n`;
      md += `${indent}  Then：\n`;
      md += renderControlTree(node.then, depth + 2);
      md += '\n';
      if (node.else) {
        md += `${indent}  Else：\n`;
        md += renderControlTree(node.else, depth + 2);
        md += '\n';
      }
      return md;
    }
    case 'loop': {
      let md = `${indent}↻ 循环：${node.label}\n`;
      md += `${indent}  终止条件：${node.until}\n`;
      if (node.maxIterations) md += `${indent}  最大迭代：${node.maxIterations}\n`;
      md += `\n${indent}  循环体：\n`;
      md += renderControlTree(node.body, depth + 2);
      return md;
    }
  }
}

// ---------------------------------------------------------------
// Barrier render
// ---------------------------------------------------------------

function renderBarrier(step: ResolvedStep): string {
  if (!step.barrier) return '';
  let md = `\n## Barrier ${step.id}\n\n`;
  md += `**检查项：**\n`;
  for (const item of step.barrier.checkItems) {
    md += `- ${item}\n`;
  }
  md += '\n**`clarify` 提示：**\n> ' + step.barrier.clarifyPrompt + '\n\n';
  md += `| 决策 | 行为 |\n`;
  md += `|------|------|\n`;
  md += `| 确认 | ${step.barrier.onConfirm} |\n`;
  md += `| 拒绝 | ${step.barrier.onReject} |\n`;
  const decision = step.decisionSummary;
  if (decision) {
    md += `\n### Decision Summary\n\n`;
    md += `- gate_type: \`${decision.gateType}\`\n`;
    if (decision.confirm) md += `- confirm: ${decision.confirm}\n`;
    if (decision.metrics && decision.metrics.length > 0) {
      md += `- metrics: ${decision.metrics.map(metric => `${metric.label}=${metric.value}`).join('; ')}\n`;
    }
    if (decision.selection) md += `- selection: ${decision.selection.summary}\n`;
    if (decision.execution) md += `- execution: ${decision.execution.current} -> ${decision.execution.next}\n`;
    if (decision.barrier_summary) md += `\n> ${decision.barrier_summary}\n`;
  }
  return md;
}

function renderFileRefs(step: ResolvedStep): string {
  let md = `## 文件引用\n\n`;
  md += `| 类型 | 文件 | 说明 |\n`;
  md += `|------|------|------|\n`;
  for (const ref of step.reads) {
    md += `| 读取 | \`${ref.path}\` | ${ref.description ?? ''} |\n`;
  }
  for (const ref of step.writes) {
    md += `| 产出 | \`${ref.path}\` | ${ref.description ?? ''} |\n`;
  }
  return md;
}

function renderRuntimeTrace(step: ResolvedStep): string {
  if (!step.runtimeTrace?.enabled) return '';
  const logDir = step.runtimeTrace.logDir;
  const stageDir = `${logDir}/stages/${step.id}`;
  let md = `\n## 运行记录\n\n`;
  md += `进入本步骤后的第一件事：\n\n`;
  md += `1. 用 date -u +%Y-%m-%dT%H:%M:%SZ 获取真实时间，追加 ${logDir}/events.jsonl 的 step_start。\n`;
  md += `2. 创建 ${stageDir}/usage.json、timeline.json、stage-budget.json，写入当前真实时间。\n`;
  md += `禁止阶段结束后统一回填时间；禁止使用合成或猜测时间戳。\n\n`;
  md += `先读取 ${logDir}/run.json 获取 run_id；若不存在，由 initialize 创建。\n\n`;
  md += `事件类型：\n\n`;
  for (const eventType of step.runtimeTrace.eventTypes) {
    md += `- \`${eventType}\`\n`;
  }
  md += `\n事件格式：\n\n\`\`\`json\n`;
  md += `{ "ts": "...", "run_id": "...", "step_id": "${step.id}", "event": "event-type", "ref": "...", "detail": "...", "before_hash": "...", "after_hash": "..." }\n`;
  md += `\`\`\`\n`;
  md += `\n每次 subagent spawn 后，向 ${logDir}/subagent-window.jsonl 追加窗口记录，包含 batch_id、window_count、input_tokens_estimate、read_paths。\n`;
  md += `\nbarrier 相关事件（barrier_confirmed / barrier_rejected）的 ref 必须使用 {workDir}/.meta/checkpoints/${step.id}-barrier.md。\n`;
  md += `\n### 阶段 Telemetry\n\n`;
  md += `本步骤开始和完成时分别更新：\n\n`;
  md += `- \`${stageDir}/usage.json\`：本阶段 token / cost / cacheRead 汇总\n`;
  md += `- \`${stageDir}/timeline.json\`：本阶段 step_start / step_end / barrier / retry / timeout 事件时间线\n`;
  md += `- \`${stageDir}/stage-budget.json\`：本阶段 wall time、子 agent 等待、重试次数、预算占用\n`;
  md += `\n完成本步骤时追加 step_end，并更新根级 \`${logDir}/usage.json\`、\`${logDir}/timeline.json\`、\`${logDir}/stage-budget.json\`。\n`;
  md += `\n事件必须实时追加，不能阶段结束后后补；时间戳必须使用真实执行时间。\n`;
  return md;
}

// ---------------------------------------------------------------
// Full step render
// ---------------------------------------------------------------

/** Render a single resolved step to a complete Markdown process file */
export function renderStep(
  step: ResolvedStep,
  stepOrder: Record<string, number>,
): string {
  const withRefs = (text: string): string => resolveStepRefs(text, stepOrder);
  if (step.graph.kind === 'task' && step.graph.task.bodyFile && !step.body) {
    return withRefs(resolveTaskBody(step.graph.task));
  }

  const stepBody = step.body ?? (step.bodyFile ? withRefs(resolveBodyFile(step.bodyFile)) : '');
  if (stepBody) {
    return `${withRefs(stepBody)}\n\n---\n\n${renderFileRefs(step)}\n## 调度策略\n\n${renderControlTree(step.graph, 0)}\n${renderBarrier(step)}${renderRuntimeTrace(step)}`;
  }

  const seqStr = String(step.seq).padStart(2, '0');

  let md = `# Step ${seqStr}: ${step.title}\n\n`;
  md += `${step.description}\n\n`;
  md += `**关键产出**：${step.writes.map(w => `\`${w.path}\``).join(', ')}\n\n`;
  md += `---\n\n`;

  // File references
  md += `## 文件引用\n\n`;
  md += `| 变量 | 文件 | 说明 |\n`;
  md += `|------|------|------|\n`;
  for (const ref of step.reads) {
    md += `| \`${path.basename(ref.path)}\` | \`${ref.path}\` | ${ref.description} |\n`;
  }
  for (const ref of step.writes) {
    md += `| \`${path.basename(ref.path)}\` | \`${ref.path}\` | ${ref.description} |\n`;
  }

  // Dependencies
  md += `\n## 依赖\n\n`;
  md += `前置步骤：${step.dependsOn.length > 0 ? step.dependsOn.map(d => `\`${d}\``).join(', ') : '无'}\n`;

  // 调度策略（ControlNode tree）
  md += `\n## 调度策略\n\n`;
  md += renderControlTree(step.graph, 0);

  // Incremental reuse
  if (step.reuse && step.reuse.length > 0) {
    md += `\n## 增量复用\n\n`;
    md += `| 检查项 | 条件 | 行为 |\n`;
    md += `|--------|------|------|\n`;
    for (const rule of step.reuse) {
      md += `| ${rule.skipDescription} | \`${rule.checkFile}\` 存在 | 跳过该任务 |\n`;
    }
  }

  // Degrade
  if (step.degrade) {
    md += `\n## 降级协议\n\n`;
    md += `- 最大重试次数：${step.degrade.maxRetries}\n`;
    md += `- 降级后行为：${step.degrade.onDegrade === 'continue' ? '继续' : '停止'}\n`;
    if (step.degrade.fallbackTask) {
      md += `- 降级 Task：\n\`\`\`\n${step.degrade.fallbackTask}\n\`\`\`\n`;
    }
  }

  // Barrier
  md += renderBarrier(step);

  // Plugins
  if (step.plugins && step.plugins.length > 0) {
    md += `\n## 插件加载\n\n`;
    for (const plugin of step.plugins) {
      md += `- \`${plugin}\`：条件性加载\n`;
    }
  }

  md += renderRuntimeTrace(step);

  md += `\n---\n`;
  md += `*Generated by skillnomad v0.1.0-beta.1 | Step ${seqStr} — ${step.id}*`;

  return md;
}

// ---------------------------------------------------------------
// SKILL.md render
// ---------------------------------------------------------------

/** 从 pipeline 生成 SKILL.md */
export function renderSkillMd(
  pipeline: ResolvedPipeline,
  meta: SkillMeta,
): string {
  const steps = pipeline.steps;
  const api = meta.api;
  const title = meta.title || meta.name;
  const frontmatterDescription = api?.frontmatterDescription ?? meta.description;

  let md = `---\n`;
  md += `name: ${meta.name}\n`;
  md += `description: "${frontmatterDescription}"\n`;
  md += `---\n\n`;
  md += `# ${title}\n\n`;
  md += `${meta.description}\n\n`;

  // 调用方式
  md += `## 调用方式\n\n`;
  md += `使用自然语言显式调用，推荐以下句式：\n\n`;
  md += `| 场景 | 推荐句式 |\n`;
  md += `|------|----------|\n`;
  if (api?.callExamples && api.callExamples.length > 0) {
    for (const example of api.callExamples) {
      md += `| ${example.label} | "${example.pattern}" |\n`;
    }
  } else {
    md += `| 完整流程 | "使用 ${meta.name}，对 <场景描述> 进行完整处理" |\n`;
    md += `| 指定步骤 | "使用 ${meta.name}，从 ${steps[Math.min(1, steps.length - 1)].id} 开始处理 <场景>" |\n`;
  }
  md += '\n';

  if (api?.usageNote) {
    md += `${api.usageNote}\n\n`;
  }

  if (api?.params && api.params.length > 0) {
    md += `## 参数\n\n`;
    md += `| 参数 | 说明 |\n`;
    md += `|------|------|\n`;
    for (const param of api.params) {
      md += `| \`${param.name}\` | ${param.description} |\n`;
    }
    md += '\n';
  }

  // 流程总览
  md += `## 流程总览\n\n`;
  md += `> ⚠️ ${api?.isolationNote ?? '每步只读该步文件，严禁提前加载后续步骤。'}\n\n`;

  // 流程箭头图
  const flowArrows = steps.map(s => `${s.id}`).join(' → ');
  if (api?.flowOverview) {
    md += `### 完整流程\n\n`;
    md += `\`\`\`\n${resolveStepRefs(api.flowOverview, pipeline.stepOrder)}\n\`\`\`\n\n`;
  } else {
    md += `\`\`\`\n${flowArrows}\n\`\`\`\n\n`;
  }

  // 步骤详情表
  md += `### 步骤详情\n\n`;
  md += `| # | 步骤 | 核心目的 | 关键产出 |\n`;
  md += `|---|------|----------|----------|\n`;
  for (const step of steps) {
    const seq = String(step.seq).padStart(2, '0');
    const outputs = step.writes.map(w => {
      const short = w.path.replace('{workDir}/', '');
      return `\`${short || w.path}\``;
    }).join(', ');
    md += `| ${seq} | ${step.title} | ${step.description} | ${outputs} |\n`;
  }

  if (api?.phases && api.phases.length > 0) {
    md += `\n### 阶段划分\n\n`;
    md += `| 阶段 | 步骤 | 说明 |\n`;
    md += `|------|------|------|\n`;
    for (const phase of api.phases) {
      md += `| **${phase.name}** | ${phase.stepIds.join(' → ')} | ${phase.description} |\n`;
    }
    md += '\n';
  }

  const initStep = api?.initStepId
    ? steps.find(step => step.id === api.initStepId)
    : undefined;
  const initRules = initStep?.initRules ?? api?.initRules;

  if (initRules && initRules.length > 0) {
    md += `### 初始化规则\n\n`;
    md += `执行任何步骤前，必须先完成初始化：\n\n`;
    initRules.forEach((rule, index) => {
      md += `${index + 1}. **${rule.title}**：${rule.body}\n`;
    });
    md += '\n';
  }

  // 执行协议
  md += `\n## 执行\n\n`;
  md += `执行 Step N 时引用 Step N+1 文件内容即为违规。\n`;
  md += `每步只读 processes/ 中对应文件 + assets/ 中该步声明的文件。\n`;

  if (api?.includeBuildFooter !== false) {
    md += `\n---\n`;
    md += `*Generated by skillnomad v0.1.0-beta.1*`;
  }

  return md;
}

export function renderPipelineState(state: PipelineState): string {
  let md = '## 管道状态\n\n';
  md += '| 步骤 | 状态 | 重试次数 |\n';
  md += '|------|------|---------|\n';
  for (const [stepId, stepState] of Object.entries(state.steps)) {
    const icon = stepState.status === 'completed' ? '✅' : stepState.status === 'failed' ? '❌' : stepState.status === 'running' ? '🔄' : '⏳';
    md += '| ' + stepId + ' | ' + icon + ' ' + stepState.status + ' | ' + stepState.runAttempt + ' |\n';
  }
  return md;
}

// ---------------------------------------------------------------
// Pipeline render
// ---------------------------------------------------------------

export function renderPipeline(
  pipeline: ResolvedPipeline,
  outputDir: string,
  meta: SkillMeta,
): string[] {
  const filePaths: string[] = [];
  const processesDir = path.join(outputDir, 'processes');

  if (!fs.existsSync(processesDir)) {
    fs.mkdirSync(processesDir, { recursive: true });
  }

  const staleFiles = new Set(
    fs.readdirSync(processesDir).filter(name => name.endsWith('.md')),
  );

  // Render step files → processes/
  for (const step of pipeline.steps) {
    const seqStr = String(step.seq).padStart(2, '0');
    const fileName = `${seqStr}-${step.id}.md`;
    const filePath = path.join(processesDir, fileName);
    const content = renderStep(step, pipeline.stepOrder);
    fs.writeFileSync(filePath, content, 'utf-8');
    staleFiles.delete(fileName);
    filePaths.push(filePath);
    console.log(`  ✓ processes/${fileName}`);
  }

  for (const stale of staleFiles) {
    fs.unlinkSync(path.join(processesDir, stale));
    console.log(`  - removed stale processes/${stale}`);
  }

  // Render SKILL.md
  const skillContent = renderSkillMd(pipeline, meta);
  const skillPath = path.join(outputDir, 'SKILL.md');
  fs.writeFileSync(skillPath, skillContent, 'utf-8');
  filePaths.push(skillPath);
  console.log(`  ✓ SKILL.md`);

  return filePaths;
}

function fileHash(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function writeOutputManifest(
  pipeline: ResolvedPipeline,
  outputDir: string,
): string {
  const outputs = pipeline.steps.flatMap(step =>
    step.writes.map(ref => ({
      path: ref.path,
      stepId: step.id,
      processFile: `${String(step.seq).padStart(2, '0')}-${step.id}.md`,
      section: '输出',
      sourceField: 'writes',
      sourceFile: step.sourceTrace?.[0]?.sourceFile ?? 'skill.ts',
      description: ref.description,
    })),
  );
  const filePath = path.join(outputDir, 'output-manifest.json');
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        kind: 'business-output-manifest',
        outputs,
      },
      null,
      2,
    ),
    'utf-8',
  );
  return filePath;
}

function writeArtifactManifest(
  pipeline: ResolvedPipeline,
  outputDir: string,
  files: string[],
): string {
  const filePath = path.join(outputDir, 'artifact-manifest.json');
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        skillnomad_version: '0.2.0',
        output_version: process.env.SP_SKILL_OUTPUT_VERSION ?? 'unversioned',
        source_commit: process.env.SKILLNOMAD_SOURCE_COMMIT ?? null,
        step_count: pipeline.steps.length,
        files: files.map(file => ({
          file: path.relative(outputDir, file),
          hash: fileHash(file),
        })),
      },
      null,
      2,
    ),
    'utf-8',
  );
  return filePath;
}

export function writeAlignReport(
  pipeline: ResolvedPipeline,
  outputDir: string,
  files: string[],
): {
  generated_at: string;
  dependencyGraph: Record<string, string[]>;
  nextMap: Record<string, string | undefined>;
  sourceTrace: Array<{
    stepId: string;
    sourceFile: string;
    entries: SourceTraceEntry[];
  }>;
  checks: Array<{
    stepId: string;
    hasBody: boolean;
    hasBarrier: boolean;
    readCount: number;
    writeCount: number;
    ok: boolean;
  }>;
  errors: Array<{ stepId: string; message: string }>;
  files: Array<{ file: string; status: 'added' | 'changed' | 'same'; hash: string }>;
  summary: { total: number; added: number; changed: number; same: number };
} {
  const alignDir = path.join(outputDir, '.align');
  fs.mkdirSync(alignDir, { recursive: true });

  const snapshotPath = path.join(alignDir, 'snapshot.json');
  let previous: Record<string, string> = {};
  if (fs.existsSync(snapshotPath)) {
    try {
      previous = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
    } catch {
      previous = {};
    }
  }

  const current: Record<string, string> = {};
  const fileReports = files.map(file => {
    const rel = path.relative(outputDir, file);
    const hash = fileHash(file);
    current[rel] = hash;
    const prevHash = previous[rel];
    const status: 'added' | 'changed' | 'same' = prevHash
      ? (prevHash === hash ? 'same' : 'changed')
      : 'added';
    return {
      file: rel,
      status,
      hash,
    };
  });

  const dependencyGraph = Object.fromEntries(
    pipeline.steps.map(step => [step.id, step.dependsOn]),
  );
  const nextMap = Object.fromEntries(
    pipeline.steps.map(step => [step.id, step.next]),
  );
  const sourceTrace = pipeline.steps.map(step => ({
    stepId: step.id,
    sourceFile: step.sourceTrace?.[0]?.sourceFile ?? 'skill.ts',
    entries: step.sourceTrace ?? [],
  }));
  const checks = pipeline.steps.map(step => {
    const hasBody = Boolean(step.body || step.bodyFile);
    const hasBarrier = Boolean(step.barrier);
    const writeCount = step.writes.length;
    return {
      stepId: step.id,
      hasBody,
      hasBarrier,
      readCount: step.reads.length,
      writeCount,
      ok: hasBody && hasBarrier && writeCount > 0,
    };
  });

  const errors = checks
    .filter(check => !check.ok)
    .map(check => ({
      stepId: check.stepId,
      message: [
        !check.hasBody ? 'missing body' : '',
        !check.hasBarrier ? 'missing barrier' : '',
        check.writeCount === 0 ? 'missing writes' : '',
      ].filter(Boolean).join('; '),
    }));

  const summary = {
    total: fileReports.length,
    added: fileReports.filter(file => file.status === 'added').length,
    changed: fileReports.filter(file => file.status === 'changed').length,
    same: fileReports.filter(file => file.status === 'same').length,
  };

  const report = {
    generated_at: new Date().toISOString(),
    dependencyGraph,
    nextMap,
    sourceTrace,
    checks,
    errors,
    files: fileReports,
    summary,
  };

  fs.writeFileSync(
    path.join(outputDir, 'align-report.json'),
    JSON.stringify(report, null, 2),
    'utf-8',
  );

  let md = `# Align Report\n\n`;
  md += `- Generated: ${report.generated_at}\n`;
  md += `- Files: ${summary.total} (${summary.added} added, ${summary.changed} changed, ${summary.same} same)\n`;
  md += `- Errors: ${errors.length}\n\n`;
  md += `## Dependency Graph\n\n`;
  for (const step of pipeline.steps) {
    md += `- ${step.id}: ${step.dependsOn.join(', ') || 'root'}\n`;
  }
  md += `\n## Checks\n\n`;
  md += `| Step | Body | Barrier | Reads | Writes | OK |\n`;
  md += `|------|------|---------|-------|--------|----|\n`;
  for (const check of checks) {
    md += `| ${check.stepId} | ${check.hasBody ? 'yes' : 'no'} | ${check.hasBarrier ? 'yes' : 'no'} | ${check.readCount} | ${check.writeCount} | ${check.ok ? 'yes' : 'no'} |\n`;
  }
  md += `\n## Source Trace\n\n`;
  for (const step of sourceTrace) {
    md += `- ${step.stepId} (${step.sourceFile})\n`;
    for (const entry of step.entries) {
      const layer = entry.sourceLayer ?? 'unknown';
      const kind = entry.sourceKind ?? 'unknown';
      md += `  - ${entry.section} [${layer}/${kind}] -> ${entry.sourceField}\n`;
    }
  }
  md += `\n## Files\n\n`;
  for (const file of fileReports) {
    md += `- ${file.status}: ${file.file}\n`;
  }

  fs.writeFileSync(
    path.join(outputDir, 'align-report.md'),
    md,
    'utf-8',
  );
  fs.writeFileSync(snapshotPath, JSON.stringify(current, null, 2), 'utf-8');

  return report;
}

// ---------------------------------------------------------------
// Build
// ---------------------------------------------------------------

function writeDecisionSummaryManifest(pipeline: ResolvedPipeline, outputDir: string): string {
  const payload = {
    schema_version: '0.1.0',
    steps: pipeline.steps.map(step => {
      const decision = step.decisionSummary;
      const inferredMetrics = (step.barrier?.checkItems ?? []).map((label, index) => ({
        id: `metric-${index}`,
        label,
        value: '',
        detail: '',
      }));
      return {
        step_id: step.id,
        title: step.title,
        gate_type: decision?.gateType ?? (step.barrier ? 'human_gate' : 'auto_segment'),
        confirm: decision?.confirm ?? step.barrier?.clarifyPrompt,
        metrics: decision?.metrics ?? inferredMetrics,
        selection: decision?.selection,
        execution: decision?.execution,
        secondary: decision?.secondary,
        risks: decision?.risks,
        actions: decision?.actions,
        barrier_summary: decision?.barrier_summary ?? '',
        display: decision?.display ?? step.display,
      };
    }),
  };
  const filePath = path.join(outputDir, 'decision-summary.json');
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  return filePath;
}

export function buildPipeline(
  steps: StepDefinition[],
  outputDir: string,
  meta?: SkillMeta,
): { pipeline: ResolvedPipeline; files: string[] } {
  const errors = [
    ...steps.flatMap(validateStep),
    ...validateDependencyRefs(steps),
    ...validateStepChain(steps),
    ...validatePhaseCoverage(steps, meta?.api?.phases ?? []),
    ...validateBarrierContinuity(steps),
  ];

  if (errors.length > 0) {
    console.error('Validation errors:');
    for (const err of errors) {
      console.error(`  ❌ [${err.stepId}] ${err.field}: ${err.message}`);
    }
    throw new Error(`Validation failed with ${errors.length} error(s)`);
  }

  console.log('Validation passed ✓');

  const pipeline = resolveStepOrder(steps);
  for (const step of pipeline.steps) {
    if (step.body) {
      step.body = resolveStepRefs(step.body, pipeline.stepOrder);
    }
  }
  const effectiveMeta = meta ?? { name: pipeline.name || 'untitled', description: '' };

  console.log(`\nStep order resolved:`);
  for (const step of pipeline.steps) {
    console.log(`  ${String(step.seq).padStart(2, '0')}: ${step.id} — ${step.title}`);
  }

  console.log(`\nRendering to ${outputDir}:`);
  const files = renderPipeline(pipeline, outputDir, effectiveMeta);
  files.push(writeOutputManifest(pipeline, outputDir));
  files.push(writeArtifactManifest(pipeline, outputDir, files));
  files.push(writeDecisionSummaryManifest(pipeline, outputDir));
  const alignReport = writeAlignReport(pipeline, outputDir, files);

  if (alignReport.errors.length > 0) {
    console.error('Align report errors:');
    for (const error of alignReport.errors) {
      console.error(`  ❌ [${error.stepId}] ${error.message}`);
    }
    throw new Error(`Align report failed with ${alignReport.errors.length} error(s)`);
  }

  console.log(`\nDone. ${files.length} files written.`);
  return { pipeline, files };
}
