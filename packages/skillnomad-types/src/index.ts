// ============================================================
// skillnomad-types v2 — Control-flow tree primitives for LLM skill pipelines
//
// 设计哲学:
//   - 递归树替代扁平图+边，表达力更强
//   - 控制流（seq/parallel/map/branch/loop）与执行体类型（agent/script/human/subflow）分离
//   - 叶子节点统一使用 TaskDef + type 鉴别器
// ============================================================

export * from './model.js';
export * from './builder.js';
import type { NextAction, SourceRuntimeTrace } from './model.js';

// ---------------------------------------------------------------
// Schema 引用
// ---------------------------------------------------------------

export interface SchemaRef {
  $ref: string;
}

// ---------------------------------------------------------------
// 重试策略
// ---------------------------------------------------------------

export interface RetryPolicy {
  maxRetries: number;
  backoff: 'fixed' | 'exponential' | 'linear';
  delayMs: number;
}

// ---------------------------------------------------------------
// 任务定义（叶子节点）
// ---------------------------------------------------------------

export interface TaskDef {
  id: string;
  label: string;
  type: 'agent' | 'script' | 'human' | 'subflow';
  /** 收敛动作词，用于规范措辞和 align-report。 */
  verb?: NextAction;
  body: string;
  /** 可选的步骤正文文件路径；构建时优先读取该文件作为完整 body。 */
  bodyFile?: string;
  input?: SchemaRef;
  output?: SchemaRef;
  tools?: string[];
  timeout?: number;
  retry?: RetryPolicy;
}

// ---------------------------------------------------------------
// 控制节点联合类型
// ---------------------------------------------------------------

export type ControlNode = TaskNode | SeqNode | ParallelNode | MapNode | BranchNode | LoopNode;

export interface TaskNode {
  kind: 'task';
  task: TaskDef;
}

export interface SeqNode {
  kind: 'seq';
  id: string;
  label: string;
  nodes: ControlNode[];
}

export interface ParallelNode {
  kind: 'parallel';
  id: string;
  label: string;
  branches: ControlNode[];
  converge?: TaskDef;
  gate?: QualityGate;
}

export interface MapNode {
  kind: 'map';
  id: string;
  label: string;
  items: string;
  worker: ControlNode;
  maxConcurrency: number;
  slotOccupancy?: number;
  reduce?: TaskDef;
}

export interface BranchNode {
  kind: 'branch';
  id: string;
  label: string;
  condition: string;
  then: ControlNode;
  else?: ControlNode;
}

export interface LoopNode {
  kind: 'loop';
  id: string;
  label: string;
  until: string;
  body: ControlNode;
  maxIterations?: number;
}

// ---------------------------------------------------------------
// 质量门
// ---------------------------------------------------------------

export interface QualityGate {
  rule: string;
  onPass: 'converge' | 'skip';
  onFail: 'degrade' | 'halt' | 'userChoice';
  prompt?: string;
}

// ---------------------------------------------------------------
// 文件引用
// ---------------------------------------------------------------

export interface FileRef {
  path: string;
  description: string;
  schema?: string;
  required?: boolean;
}

// ---------------------------------------------------------------
// 检查点
// ---------------------------------------------------------------

export interface BarrierDef {
  checkItems: string[];
  clarifyPrompt: string;
  onConfirm: 'continue' | string;
  onReject: 'rollback' | 'modify';
  recordPath?: string;
}

// ---------------------------------------------------------------
// 生命周期钩子
// ---------------------------------------------------------------

export interface ReuseRule {
  checkFile: string;
  skipDescription: string;
}

export interface DegradeProtocol {
  maxRetries: number;
  onDegrade: 'continue' | 'halt';
  fallbackTask?: string;
}

// ---------------------------------------------------------------
// Source trace
// ---------------------------------------------------------------

export interface SourceTraceEntry {
  section: string;
  sourceField: string;
  sourceFile: string;
  sourceLayer?: 'steps' | 'contracts' | 'assets' | 'plugins' | 'renderer';
  sourceKind?: 'content' | 'schema' | 'path' | 'rule' | 'render';
}

export interface SourceTraceStep {
  stepId: string;
  sourceFile: string;
  entries: SourceTraceEntry[];
}

// ---------------------------------------------------------------
// Step 定义（v2: schedule → graph）
// ---------------------------------------------------------------

export interface StepDefinition {
  id: string;
  title: string;
  description: string;
  dependsOn: string[];
  /** 当该步骤是 pipeline 初始化步骤时，渲染为 SKILL.md 的初始化规则。 */
  initRules?: SkillInitRule[];
  /** 运行时事件埋点协议；渲染器会把它输出为 process 的运行记录章节。 */
  runtimeTrace?: SourceRuntimeTrace;
  /** 可选：由源模型生成的完整步骤正文；存在时构建器直接作为 process 正文。 */
  body?: string;
  /** 可选：复杂 graph 步骤的完整正文源文件；构建时追加到生成文档。 */
  bodyFile?: string;
  /** 生成 section 到源码字段的映射，用于 feedback 定位。 */
  sourceTrace?: SourceTraceEntry[];
  /** 下一步步骤 ID；用于生成文档和 align-report。 */
  next?: string;
  /** 控制流树 — 递归结构替代扁平图 */
  graph: ControlNode;
  reads: FileRef[];
  writes: FileRef[];
  barrier?: BarrierDef;
  decisionSummary?: import('./model.js').SourceDecisionSummary;
  display?: import('./model.js').SourceDecisionDisplay;
  reuse?: ReuseRule[];
  degrade?: DegradeProtocol;
  plugins?: string[];
}

// ---------------------------------------------------------------
// Skill 定义
// ---------------------------------------------------------------

export interface SkillCallExample {
  label: string;
  pattern: string;
}

export interface SkillParam {
  name: string;
  description: string;
}

export interface SkillPhase {
  name: string;
  stepIds: string[];
  description: string;
}

export interface SkillInitRule {
  title: string;
  body: string;
}

export interface SkillApiMetadata {
  /** frontmatter 中的长描述；未设置时使用 SkillDefinition.description。 */
  frontmatterDescription?: string;
  /** 调用方式表下方的补充说明。 */
  usageNote?: string;
  /** 上下文隔离提示；未设置时使用默认文本。 */
  isolationNote?: string;
  /** 是否在 SKILL.md 尾部输出构建 footer；公开输出建议 false。 */
  includeBuildFooter?: boolean;
  /** 流程总览中的 ASCII 流程图；未设置时使用步骤 ID 箭头。 */
  flowOverview?: string;
  callExamples: SkillCallExample[];
  params: SkillParam[];
  phases: SkillPhase[];
  initRules?: SkillInitRule[];
  /** 指定哪个步骤负责 pipeline 初始化；renderer 优先从该步骤读取 initRules。 */
  initStepId?: string;
}

export interface SkillDefinition {
  name: string;
  title: string;
  description: string;
  steps: StepDefinition[];
  api?: SkillApiMetadata;
}

export function createSkill(config: SkillDefinition): SkillDefinition {
  return config;
}

// ---------------------------------------------------------------
// Pipeline 定义
// ---------------------------------------------------------------

export interface PipelineDefinition {
  name: string;
  description: string;
  steps: StepDefinition[];
}

// ---------------------------------------------------------------
// 模板变量
// ---------------------------------------------------------------

export type BuildTimeVar =
  | '{{stepSeq}}'
  | '{{stepId}}'
  | '{{shortName}}'

export type RuntimeVar =
  | '{workDir}'
  | '{topic}'
  | '{seq}'
  | '{shortName}'
  | '{capabilityId}'
  | '{dimension}'
  | '{batchId}'
  | '{agentLabel}'

// ---------------------------------------------------------------
// 解析器产出
// ---------------------------------------------------------------

export interface ResolvedStep extends StepDefinition {
  seq: number;
  resolvedReads: string[];
  resolvedWrites: string[];
}

export interface ResolvedPipeline {
  name: string;
  description: string;
  steps: ResolvedStep[];
  stepOrder: Record<string, number>;
}

// ---------------------------------------------------------------
// v2 构建辅助函数
// ---------------------------------------------------------------

export function task(config: TaskDef): TaskNode {
  return { kind: 'task', task: config };
}

export function seq(id: string, label: string, nodes: ControlNode[]): SeqNode {
  return { kind: 'seq', id, label, nodes };
}

export function parallel(
  id: string,
  label: string,
  branches: ControlNode[],
  config?: { converge?: TaskDef; gate?: QualityGate },
): ParallelNode {
  return {
    kind: 'parallel',
    id,
    label,
    branches,
    converge: config?.converge,
    gate: config?.gate,
  };
}

export function mapNode(
  id: string,
  label: string,
  items: string,
  worker: ControlNode,
  maxConcurrency: number = 5,
  reduce?: TaskDef,
): MapNode {
  return { kind: 'map', id, label, items, worker, maxConcurrency, reduce };
}

export function branch(
  id: string,
  label: string,
  condition: string,
  then: ControlNode,
  elseNode?: ControlNode,
): BranchNode {
  return { kind: 'branch', id, label, condition, then, else: elseNode };
}

export function loop(
  id: string,
  label: string,
  until: string,
  body: ControlNode,
  maxIterations?: number,
): LoopNode {
  return { kind: 'loop', id, label, until, body, maxIterations };
}

// ---------------------------------------------------------------
// Pipeline State — 管道级状态机
// ---------------------------------------------------------------

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface StepState {
  status: StepStatus;
  startedAt?: string;
  completedAt?: string;
  outputs: string[];
  error?: string;
  runAttempt: number;
}

export interface PipelineState {
  pipelineName: string;
  version: string;
  startedAt?: string;
  updatedAt: string;
  steps: Record<string, StepState>;
}

export interface PipelineStateManager {
  load(pipelineName: string): PipelineState | null;
  save(state: PipelineState): void;
  init(pipelineName: string, steps: string[]): PipelineState;
  markStep(state: PipelineState, stepId: string, status: StepStatus, outputs?: string[], error?: string): PipelineState;
  getResumePoint(state: PipelineState): string | null;
}

// ---------------------------------------------------------------
// CheckpointDef — 统一检查点（Phase 3 替换 ReuseRule + BarrierDef）
// ---------------------------------------------------------------

export interface CheckpointDef {
  id?: string;
  check: {
    mode: 'file-exists' | 'step-status' | 'llm-judge' | 'user-confirm';
    path?: string;
    prompt?: string;
    checkItems?: string[];
  };
  onPass: 'continue' | 'skip';
  onFail: 'halt' | 'retry' | 'degrade' | 'userChoice';
  maxRetries?: number;
}

// ---------------------------------------------------------------
// v1 弃用存根 — 提供迁移提示
// ---------------------------------------------------------------

/**
 * @deprecated v2 不再使用扁平边。改用 seq() 或 branch() 表达控制流。
 */
export function edge(_from?: string, _to?: string, _condition?: string): never {
  throw new Error(
    '[skillnomad-types v2] edge() 已移除。使用 seq() 或 branch() 替代扁平边。',
  );
}

/**
 * @deprecated v2 使用 task({ type: "agent", ... }) 替代 agent()。
 */
export function agent(_config?: never): never {
  throw new Error(
    '[skillnomad-types v2] agent() 已移除。使用 task({ type: "agent", ... }) 替代。',
  );
}

/**
 * @deprecated v2 使用 parallel() 替代 batch()。
 */
export function batch(_id?: string, _label?: string, _branches?: never[], _config?: never): never {
  throw new Error(
    '[skillnomad-types v2] batch() 已移除。使用 parallel() 替代。',
  );
}

/**
 * @deprecated v2 使用 mapNode() 替代 mapWork()。
 */
export function mapWork(_id?: string, _label?: string, _itemFrom?: string, _worker?: never, _maxConcurrency?: number): never {
  throw new Error(
    '[skillnomad-types v2] mapWork() 已移除。使用 mapNode() 替代。',
  );
}
