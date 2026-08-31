// ============================================================
// SkillSourceModel
//
// Skill 源码模型：不直接编写 Markdown，而是用类型化数据描述
// “如何做一件事”。最终由 skillnomad-build 渲染成标准 Markdown。
// ============================================================

export type ActorKind = 'agent' | 'human' | 'script' | 'subflow';

export type NextAction =
  | 'parse'
  | 'infer'
  | 'search'
  | 'extract'
  | 'merge'
  | 'score'
  | 'assemble'
  | 'generate'
  | 'validate'
  | 'wait'
  | 'checkpoint';

export type VerifyKind =
  | 'file-exists'
  | 'json-parse'
  | 'schema'
  | 'field'
  | 'count'
  | 'command';

export type FailBehavior =
  | 'retry'
  | 'degrade'
  | 'skip'
  | 'halt'
  | 'checkpoint';

export interface SourceRef {
  path: string;
  schema?: string;
  required?: boolean;
  dynamic?: boolean;
  description?: string;
}

export interface SourceAction {
  id: string;
  label: string;
  verb: NextAction;
  actor: ActorKind;
  content: string;
  timeout?: number;
  retry?: {
    max: number;
    backoff: 'fixed' | 'linear' | 'exponential';
  };
  reads?: SourceRef[];
  writes?: SourceRef[];
}

export type SourceFlow =
  | { kind: 'do'; task: SourceAction }
  | { kind: 'seq'; id: string; label: string; steps: SourceFlow[] }
  | {
      kind: 'parallel';
      id: string;
      label: string;
      branches: SourceFlow[];
      gate?: {
        rule: string;
        onPass: 'converge' | 'skip';
        onFail: 'degrade' | 'halt' | 'userChoice';
      };
      converge?: SourceAction;
    }
  | {
      kind: 'map';
      id: string;
      label: string;
      over: SourceRef;
      worker: SourceFlow;
      maxConcurrency: number;
    }
  | {
      kind: 'branch';
      id: string;
      label: string;
      when: string;
      then: SourceFlow;
      else?: SourceFlow;
    }
  | {
      kind: 'loop';
      id: string;
      label: string;
      until: string;
      body: SourceFlow;
      maxIterations?: number;
    };

export interface SourceException {
  on: string;
  behavior: FailBehavior;
  then: string;
}

export type SourceFailRule = SourceException;

export interface SourceVerifyRule {
  type: VerifyKind;
  ref?: string;
  description: string;
}

export interface SourceInstruction {
  target: string;
  purpose?: string;
  inputs: string[];
  actions: string[];
  outputs: string[];
  validation: SourceVerifyRule[];
  exceptions: SourceFailRule[];
  checkpointNote?: string;
  next?: string;
  detail?: string;
  sections?: Record<string, string>;
  contractRefs?: SourceRef[];
  taskTemplates?: Record<string, string>;
}

export interface SourceCheckpoint {
  checkItems: string[];
  clarifyPrompt: string;
  onConfirm: 'continue';
  onReject: 'rollback' | 'modify';
}

export type SourceGateType = 'human_gate' | 'agent_checkpoint' | 'auto_segment';

export interface SourceDecisionMetric {
  id?: string;
  label: string;
  value: string;
  detail?: string;
  tone?: 'normal' | 'warning' | 'danger';
}

export interface SourceDecisionAlternative {
  name: string;
  cost: string;
}

export interface SourceDecisionTradeoff {
  title: string;
  decision: string;
  reason?: string;
  alternatives: SourceDecisionAlternative[];
  evidence?: string;
}

export interface SourceDecisionSectionItem {
  id: string;
  name: string;
  meta?: string;
}

export interface SourceDecisionSection {
  id: string;
  title: string;
  collapsed: boolean;
  summary: string;
  view_all_after?: number;
  items?: SourceDecisionSectionItem[];
}

export interface SourceDecisionEvidence {
  path: string;
  label?: string;
  detail?: string;
  kind?: string;
  hash?: string;
}

export interface SourceDecisionSelection {
  unit: string;
  summary: string;
  total: number;
  selected: number;
  groups?: Array<{
    id: string;
    label: string;
    summary?: string;
    total: number;
    selected: number;
    items?: SourceDecisionSectionItem[];
  }>;
}

export interface SourceDecisionExecutionStage {
  id: string;
  label: string;
  batch?: string;
  status: 'pending' | 'running' | 'done' | 'partial' | 'failed';
  progress?: number;
  output?: string;
  validation?: string;
  risks?: string[];
}

export interface SourceDecisionExecution {
  current: string;
  next: string;
  outputs: string[];
  stages: SourceDecisionExecutionStage[];
  override_actions?: string[];
}

export interface SourceDecisionRisk {
  code: 'source' | 'extraction' | 'model' | 'validation' | 'orchestration' | 'quality';
  label: string;
  severity: 'info' | 'warning' | 'critical';
  count?: number;
  detail?: string;
}

export interface SourceDecisionAction {
  id: string;
  label: string;
  verb?: string;
  primary: boolean;
  disabled?: boolean;
}

export type SourceDecisionDisplayPattern =
  | 'generic'
  | 'title_fold'
  | 'partition_cards'
  | 'coverage_cards'
  | 'threshold_table'
  | 'auto_timeline'
  | 'delivery_checklist';

export interface SourceDecisionDisplay {
  pattern: SourceDecisionDisplayPattern;
  primary_unit?: string;
  max_visible?: number;
  badge?: string;
  legend?: boolean;
  selection?: 'none' | 'single' | 'multi' | 'confirm';
}

export interface SourceDecisionSummary {
  schema_version?: string;
  stage_id?: string;
  gateType: SourceGateType;
  title?: string;
  subtitle?: string;
  confirm?: string;
  context?: {
    current: string;
    question: string;
    next: string;
    architecture_preview?: string;
  };
  metrics: SourceDecisionMetric[];
  selection?: SourceDecisionSelection;
  execution?: SourceDecisionExecution;
  secondary?: {
    sections: SourceDecisionSection[];
    evidence: SourceDecisionEvidence[];
  };
  risks?: SourceDecisionRisk[];
  actions?: SourceDecisionAction[];
  barrier_summary?: string;
  display?: SourceDecisionDisplay;
}

export interface SourceReuseRule {
  ifExists: string;
  skipDescription: string;
}

export interface SourceDegrade {
  maxRetries: number;
  onDegrade: 'continue' | 'halt';
  fallback?: string;
}

export interface SourceStep {
  id: string;
  title: string;
  purpose: string;
  /** SKILL 步骤表中的核心目的；与 instruction.target 分离。 */
  summary?: string;
  /** 当该步骤是 pipeline 初始化步骤时，渲染为 SKILL.md 的初始化规则。 */
  initRules?: SourceInitRule[];

  /**
   * **步骤间的直接前驱（线性链契约）**
   *
   * 步骤之间的关系是**线性链**，不是 DAG：
   * - 每个步骤最多一个前驱、一个后继；
   * - 需要并行或分支，请在 `flow` 内部表达（`parallel` / `map`），
   *   **不要把可并行的动作拆成多个顶层步骤**——顶层 step 是不可并行的执行单位；
   * - `dependsOn` 与 `next` 互为反函数，
   *   **只需声明其中一个**，另一个由框架推导。二者同时声明属冗余。
   *
   * 违反契约（多依赖 / 成环 / 断链 / 悬空引用）将在构建期报错，
   * **不会静默线性化**。
   */
  dependsOn: string[];

  reads: SourceRef[];
  writes: SourceRef[];

  /**
   * **步骤内的控制流**——并行与分支只在这一层表达。
   * 支持 `do` / `seq` / `parallel` / `map` / `branch` / `loop`，
   * 其中 `parallel` 用 `gate` 收敛、`map` 用 `maxConcurrency` 控制并发度。
   */
  flow: SourceFlow;

  instruction: SourceInstruction;
  checkpoint?: SourceCheckpoint;
  decision?: SourceDecisionSummary;
  display?: SourceDecisionDisplay;
  reuse?: SourceReuseRule[];
  degrade?: SourceDegrade;
  plugins?: string[];

  /**
   * **步骤的直接后继（派生字段）**
   *
   * 可由 `dependsOn` 或链顺序推导。框架仅将其渲染为步骤文件的「下一步」章节，
   * **不参与任何校验**——因此单独声明它不构成额外保障。
   *
   * 若已声明 `dependsOn`，此字段可省略，由框架补出。
   */
  next?: string;
}

export interface SourceContract {
  id: string;
  kind: 'schema' | 'method' | 'policy' | 'source';
  path: string;
  description: string;
}

export interface SourceRuntimeTrace {
  enabled: boolean;
  logDir: string;
  eventTypes: string[];
}

export interface SourcePolicies {
  contextIsolation: boolean;
  reuseByFileExistence: boolean;
  checkpointRequired: boolean;
  traceFields: string[];
  runtimeTrace: SourceRuntimeTrace;
}

export interface SourceParam {
  name: string;
  description: string;
}

/**
 * 一个阶段 = 一段**意图**：这个阶段想达成什么，以及它包含哪些步骤。
 *
 * 只声明「包含哪些步骤」（`stepIds`），**不声明下标、不声明区间**。
 * 「第几步到第几步」（如 `(04-06)`）是顺序的副产物，由框架从链序推导
 * （`derivePhaseIntervals` / `deriveFlowOverview`）。
 *
 * 约束（构建期由 `validatePhaseCoverage` 断言）：
 * 阶段必须覆盖链上每一步、互不重叠、各自连续、且声明顺序与链序一致。
 * 不满足就无法安全推导区间标注，因此框架报错而非猜测。
 */
export interface SourcePhase {
  name: string;
  stepIds: string[];
  description: string;
}

export interface SourceInitRule {
  title: string;
  body: string;
}

export interface SourceCallExample {
  label: string;
  pattern: string;
}

export interface SourceMeta {
  name: string;
  title: string;
  description: string;
  frontmatterDescription: string;
  callExamples: SourceCallExample[];
  usageNote?: string;
  isolationNote?: string;
  includeBuildFooter?: boolean;
  params: SourceParam[];
  /**
   * 阶段**意图**声明：每个阶段包含哪些步骤。
   * 阶段边界与区间标注由框架从此 + 链序推导，不要求手写。
   */
  phases: SourcePhase[];
  initRules?: SourceInitRule[];
  /**
   * 哪个步骤负责 pipeline 初始化；renderer 优先从该步骤读取 initRules。
   *
   * **派生字段**：链已经声明了谁没有前驱，默认值由 `deriveInitStepId()` 算出。
   * 可省略；显式提供时用于覆盖（例如初始化规则挂在链起点之外的步骤上）。
   */
  initStepId?: string;
  /**
   * 流程总览的 ASCII 图。
   *
   * **派生字段**：阶段名 + 区间标注均可由 `deriveFlowOverview()` 从
   * `phases` + 链序算出，因此可省略。
   * 显式提供时用于覆盖**布局**（布局属于表达，框架不垄断），
   * 但其中的区间标注不再有人校验——手写即意味着自己承担漂移风险。
   */
  flowOverview?: string;
}

export interface SkillSourceModel {
  meta: SourceMeta;
  steps: SourceStep[];
  contracts: SourceContract[];
  policies: SourcePolicies;
}
