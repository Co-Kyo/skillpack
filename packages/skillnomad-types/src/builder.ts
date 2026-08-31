import type {
  SourceAction,
  SourceCheckpoint,
  SourceDegrade,
  SourceFailRule,
  SourceFlow,
  SourceInstruction,
  SourceRef,
  SourceReuseRule,
  SourceStep,
  SourceVerifyRule,
  SourceDecisionSummary,
  SourceDecisionDisplay,
  NextAction,
  SourceInitRule,
} from './model.js';

export interface StepBuilder {
  target(value: string): StepBuilder;
  summary(value: string): StepBuilder;

  /**
   * 声明步骤间的直接前驱。**步骤之间是线性链，不是 DAG。**
   *
   * - 请只传一个前驱；需要并行/分支时在 `.parallel()` / `.map()` 内部表达，
   *   不要把可并行动作拆成多个顶层步骤。
   * - 与 `.next()` 互为反函数，**只调用其中一个即可**，另一个由框架推导。
   */
  dependsOn(...ids: string[]): StepBuilder;
  reads(...refs: SourceRef[]): StepBuilder;
  writes(...refs: SourceRef[]): StepBuilder;
  inputs(...values: string[]): StepBuilder;
  action(
    verb: NextAction,
    id: string,
    label: string,
    content: string,
    timeout?: number,
  ): StepBuilder;
  outputs(...values: string[]): StepBuilder;
  detail(value: string): StepBuilder;
  section(name: string, content: string): StepBuilder;
  contractRefs(...refs: SourceRef[]): StepBuilder;
  taskTemplate(name: string, template: string): StepBuilder;
  verify(...rules: SourceVerifyRule[]): StepBuilder;
  onFail(...rules: SourceFailRule[]): StepBuilder;
  checkpoint(checkpoint: SourceCheckpoint): StepBuilder;
  decision(decision: SourceDecisionSummary): StepBuilder;
  display(display: SourceDecisionDisplay): StepBuilder;
  /**
   * 声明步骤的直接后继。**这是派生字段，通常不必手写。**
   *
   * 该值仅被渲染为步骤文件的「下一步」章节，**不参与任何校验**；
   * 若已调用 `.dependsOn()`，此处可省略，由框架推导补出。
   */
  next(id: string): StepBuilder;

  initRules(...rules: SourceInitRule[]): StepBuilder;
  plugins(...plugins: string[]): StepBuilder;
  reuse(...rules: SourceReuseRule[]): StepBuilder;
  degrade(degrade: SourceDegrade): StepBuilder;
  seq(id: string, label: string, steps: SourceFlow[]): StepBuilder;
  parallel(
    id: string,
    label: string,
    branches: SourceFlow[],
    config?: {
      gate?: {
        rule: string;
        onPass: 'converge' | 'skip';
        onFail: 'degrade' | 'halt' | 'userChoice';
      };
      converge?: SourceAction;
    },
  ): StepBuilder;
  map(
    id: string,
    label: string,
    over: SourceRef,
    worker: SourceFlow,
    maxConcurrency: number,
  ): StepBuilder;
  branch(
    id: string,
    label: string,
    when: string,
    then: SourceFlow,
    elseFlow?: SourceFlow,
  ): StepBuilder;
  loop(
    id: string,
    label: string,
    until: string,
    body: SourceFlow,
    maxIterations?: number,
  ): StepBuilder;
  build(): SourceStep;
}

export function step(id: string, title: string): StepBuilder {
  return new StepBuilderImpl(id, title);
}

class StepBuilderImpl implements StepBuilder {
  private readonly id: string;
  private readonly title: string;
  private readonly instruction: SourceInstruction;
  private readonly step: SourceStep;
  private readonly tasks: SourceAction[] = [];
  private explicitFlow?: SourceFlow;

  constructor(id: string, title: string) {
    this.id = id;
    this.title = title;
    this.instruction = {
      target: '',
      inputs: [],
      actions: [],
      outputs: [],
      validation: [],
      exceptions: [],
    };
    this.step = {
      id,
      title,
      purpose: '',
      dependsOn: [],
      reads: [],
      writes: [],
      instruction: this.instruction,
      flow: {
        kind: 'do',
        task: {
          id: `${id}-task`,
          label: title,
          verb: 'parse',
          actor: 'agent',
          content: '',
        },
      },
    };
  }

  target(value: string): StepBuilder {
    this.instruction.target = value;
    this.step.purpose = value;
    return this;
  }

  summary(value: string): StepBuilder {
    this.step.summary = value;
    return this;
  }

  dependsOn(...ids: string[]): StepBuilder {
    this.step.dependsOn = ids;
    return this;
  }

  reads(...refs: SourceRef[]): StepBuilder {
    this.step.reads = refs;
    return this;
  }

  writes(...refs: SourceRef[]): StepBuilder {
    this.step.writes = refs;
    return this;
  }

  inputs(...values: string[]): StepBuilder {
    this.instruction.inputs = values;
    return this;
  }

  action(
    verb: NextAction,
    id: string,
    label: string,
    content: string,
    timeout?: number,
  ): StepBuilder {
    this.tasks.push({
      id,
      label,
      verb,
      actor: 'agent',
      content,
      timeout,
    });
    this.instruction.actions.push(label);
    return this;
  }

  outputs(...values: string[]): StepBuilder {
    this.instruction.outputs = values;
    return this;
  }

  detail(value: string): StepBuilder {
    this.instruction.detail = value;
    return this;
  }

  section(name: string, content: string): StepBuilder {
    if (!this.instruction.sections) {
      this.instruction.sections = {};
    }
    this.instruction.sections[name] = content;
    return this;
  }

  contractRefs(...refs: SourceRef[]): StepBuilder {
    this.instruction.contractRefs = refs;
    return this;
  }

  taskTemplate(name: string, template: string): StepBuilder {
    if (!this.instruction.taskTemplates) {
      this.instruction.taskTemplates = {};
    }
    this.instruction.taskTemplates[name] = template;
    return this;
  }

  verify(...rules: SourceVerifyRule[]): StepBuilder {
    this.instruction.validation = rules;
    return this;
  }

  onFail(...rules: SourceFailRule[]): StepBuilder {
    this.instruction.exceptions = rules;
    return this;
  }

  checkpoint(checkpoint: SourceCheckpoint): StepBuilder {
    this.step.checkpoint = checkpoint;
    return this;
  }

  decision(decision: SourceDecisionSummary): StepBuilder {
    this.step.decision = decision;
    return this;
  }

  display(display: SourceDecisionDisplay): StepBuilder {
    this.step.display = display;
    return this;
  }

  next(id: string): StepBuilder {
    this.step.next = id;
    this.instruction.next = id;
    return this;
  }

  initRules(...rules: SourceInitRule[]): StepBuilder {
    this.step.initRules = rules;
    return this;
  }

  plugins(...plugins: string[]): StepBuilder {
    this.step.plugins = plugins;
    return this;
  }

  reuse(...rules: SourceReuseRule[]): StepBuilder {
    this.step.reuse = rules;
    return this;
  }

  degrade(degrade: SourceDegrade): StepBuilder {
    this.step.degrade = degrade;
    return this;
  }

  seq(id: string, label: string, steps: SourceFlow[]): StepBuilder {
    this.explicitFlow = { kind: 'seq', id, label, steps };
    return this;
  }

  parallel(
    id: string,
    label: string,
    branches: SourceFlow[],
    config?: {
      gate?: {
        rule: string;
        onPass: 'converge' | 'skip';
        onFail: 'degrade' | 'halt' | 'userChoice';
      };
      converge?: SourceAction;
    },
  ): StepBuilder {
    this.explicitFlow = {
      kind: 'parallel',
      id,
      label,
      branches,
      gate: config?.gate,
      converge: config?.converge,
    };
    return this;
  }

  map(
    id: string,
    label: string,
    over: SourceRef,
    worker: SourceFlow,
    maxConcurrency: number,
  ): StepBuilder {
    this.explicitFlow = {
      kind: 'map',
      id,
      label,
      over,
      worker,
      maxConcurrency,
    };
    return this;
  }

  branch(
    id: string,
    label: string,
    when: string,
    then: SourceFlow,
    elseFlow?: SourceFlow,
  ): StepBuilder {
    this.explicitFlow = {
      kind: 'branch',
      id,
      label,
      when,
      then,
      else: elseFlow,
    };
    return this;
  }

  loop(
    id: string,
    label: string,
    until: string,
    body: SourceFlow,
    maxIterations?: number,
  ): StepBuilder {
    this.explicitFlow = {
      kind: 'loop',
      id,
      label,
      until,
      body,
      maxIterations,
    };
    return this;
  }

  build(): SourceStep {
    if (this.explicitFlow) {
      this.step.flow = this.explicitFlow;
    } else if (this.tasks.length === 1) {
      this.step.flow = { kind: 'do', task: this.tasks[0] };
    } else if (this.tasks.length > 1) {
      this.step.flow = {
        kind: 'seq',
        id: `${this.id}-chain`,
        label: this.title,
        steps: this.tasks.map(task => ({ kind: 'do', task })),
      };
    }
    return this.step;
  }
}
