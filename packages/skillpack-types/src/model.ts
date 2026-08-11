// ============================================================
// SkillSourceModel
//
// Skill 源码模型：不直接编写 Markdown，而是用类型化数据描述
// “如何做一件事”。最终由 skillpack-build 渲染成标准 Markdown。
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
  dependsOn: string[];
  reads: SourceRef[];
  writes: SourceRef[];
  instruction: SourceInstruction;
  flow: SourceFlow;
  checkpoint?: SourceCheckpoint;
  decision?: SourceDecisionSummary;
  display?: SourceDecisionDisplay;
  reuse?: SourceReuseRule[];
  degrade?: SourceDegrade;
  plugins?: string[];
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
  phases: SourcePhase[];
  initRules?: SourceInitRule[];
  /** 指定哪个步骤负责 pipeline 初始化；renderer 优先从该步骤读取 initRules。 */
  initStepId?: string;
  flowOverview?: string;
}

export interface SkillSourceModel {
  meta: SourceMeta;
  steps: SourceStep[];
  contracts: SourceContract[];
  policies: SourcePolicies;
}
