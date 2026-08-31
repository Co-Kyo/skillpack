import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CHAIN_TERMINAL,
  resolveChain,
  deriveChainNext,
  deriveInitStepId,
  derivePhaseIntervals,
  deriveFlowOverview,
  formatInterval,
  validateStepChain,
  validatePhaseCoverage,
} from '../dist/index.js';

// ---------------------------------------------------------------
// 真实数据：sp-skill 的 11 步全序与其 6 个阶段
// ---------------------------------------------------------------

const HEAD = [
  'initialize',
  'intent-anchor',
  'brainstorm',
  'partition',
  'scan',
  'capability-graph',
  'evaluate-pool',
];
const TAIL = ['capability-research', 'briefing-assemble', 'assemble', 'learning-ladder'];
const ORDER = [...HEAD, ...TAIL];

/** 只声明 dependsOn —— 顺序事实的唯一来源 */
const chainOf = ids => ids.map((id, i) => ({ id, dependsOn: i === 0 ? [] : [ids[i - 1]] }));
const steps = chainOf(ORDER);

const phaseDefs = [
  { name: '初始化', stepIds: [HEAD[0]] },
  { name: '意图锚定', stepIds: [HEAD[1]] },
  { name: '头脑风暴', stepIds: [HEAD[2]] },
  { name: '依赖分区', stepIds: [HEAD[3]] },
  { name: '前处理', stepIds: HEAD.slice(4) },
  { name: '后处理', stepIds: [...TAIL] },
];

// ---------------------------------------------------------------
// resolveChain —— 链上一切派生值的共同底座
// ---------------------------------------------------------------

test('resolveChain:真实 11 步链可解析,下标即序号', () => {
  assert.deepEqual(resolveChain(steps), ORDER);
});

test('resolveChain:空步骤表返回空数组而非 null', () => {
  assert.deepEqual(resolveChain([]), []);
});

test('resolveChain:多个起点返回 null(不猜测)', () => {
  assert.equal(
    resolveChain([
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: [] },
      { id: 'c', dependsOn: ['b'] },
    ]),
    null,
  );
});

test('resolveChain:成环返回 null(不猜测)', () => {
  assert.equal(
    resolveChain([
      { id: 'a', dependsOn: ['c'] },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['b'] },
    ]),
    null,
  );
});

test('resolveChain:断链返回 null(不猜测)', () => {
  assert.equal(
    resolveChain([
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: ['a'] },
      { id: 'orphan', dependsOn: ['ghost'] },
    ]),
    null,
  );
});

// ---------------------------------------------------------------
// deriveChainNext —— next 是派生值
// ---------------------------------------------------------------

test('deriveChainNext:全链推导正确,末步落到终止标记', () => {
  const next = deriveChainNext(steps);
  assert.equal(next['initialize'], 'intent-anchor');
  assert.equal(next['evaluate-pool'], 'capability-research'); // 跨阶段边界
  assert.equal(next['learning-ladder'], CHAIN_TERMINAL);
  assert.equal(Object.keys(next).length, 11);
});

test('deriveChainNext:链不成立时返回空对象(不猜测)', () => {
  assert.deepEqual(deriveChainNext([{ id: 'a', dependsOn: [] }, { id: 'b', dependsOn: [] }]), {});
});

// ---------------------------------------------------------------
// deriveInitStepId —— initStepId 是派生值
// ---------------------------------------------------------------

test('deriveInitStepId:链起点即初始化步骤', () => {
  assert.equal(deriveInitStepId(steps), 'initialize');
});

test('deriveInitStepId:链不成立时为 undefined', () => {
  assert.equal(deriveInitStepId([{ id: 'a', dependsOn: [] }, { id: 'b', dependsOn: [] }]), undefined);
  assert.equal(deriveInitStepId([]), undefined);
});

test('deriveInitStepId:与步骤在数组中的书写位置无关', () => {
  // 把起点写在数组最后 —— 推导只看 dependsOn,不看数组顺序
  const shuffled = [
    { id: 'b', dependsOn: ['a'] },
    { id: 'c', dependsOn: ['b'] },
    { id: 'a', dependsOn: [] },
  ];
  assert.equal(deriveInitStepId(shuffled), 'a');
});

// ---------------------------------------------------------------
// derivePhaseIntervals —— 阶段边界是派生值
// ---------------------------------------------------------------

test('formatInterval:单步简写,多步写区间,均两位补零', () => {
  assert.equal(formatInterval(0, 0), '(00)');
  assert.equal(formatInterval(4, 4), '(04)');
  assert.equal(formatInterval(4, 6), '(04-06)');
  assert.equal(formatInterval(7, 10), '(07-10)');
});

test('derivePhaseIntervals:真实阶段定义产出与手写一致的区间标注', () => {
  const labels = derivePhaseIntervals(steps, phaseDefs).map(p => p.label);
  assert.deepEqual(labels, ['(00)', '(01)', '(02)', '(03)', '(04-06)', '(07-10)']);
});

test('derivePhaseIntervals:边界与包含步骤均按链序', () => {
  const [pre, post] = derivePhaseIntervals(steps, phaseDefs).slice(4);
  assert.deepEqual([pre.startSeq, pre.endSeq], [4, 6]);
  assert.deepEqual([post.startSeq, post.endSeq], [7, 10]);
  assert.deepEqual(pre.stepIds, HEAD.slice(4));
  assert.deepEqual(post.stepIds, TAIL);
});

test('derivePhaseIntervals:阶段声明顺序不影响边界计算', () => {
  const reversed = [...phaseDefs].reverse();
  const byName = Object.fromEntries(
    derivePhaseIntervals(steps, reversed).map(p => [p.name, p.label]),
  );
  assert.equal(byName['前处理'], '(04-06)');
  assert.equal(byName['后处理'], '(07-10)');
});

test('derivePhaseIntervals:未声明阶段时返回空数组', () => {
  assert.deepEqual(derivePhaseIntervals(steps, []), []);
});

test('derivePhaseIntervals:阶段引用链外步骤时返回空数组(不猜测)', () => {
  assert.deepEqual(derivePhaseIntervals(steps, [{ name: 'X', stepIds: ['ghost'] }]), []);
});

// ---------------------------------------------------------------
// deriveFlowOverview —— 流程总览是派生值
// ---------------------------------------------------------------

test('deriveFlowOverview:两行输出,第一行为阶段名,第二行为区间标注', () => {
  const [line1, line2] = deriveFlowOverview(steps, phaseDefs).split('\n');
  assert.equal(line1, '初始化 → 意图锚定 → 头脑风暴 → 依赖分区 → 前处理 → 后处理');
  assert.deepEqual(line2.match(/\(\d\d(?:-\d\d)?\)/g), [
    '(00)',
    '(01)',
    '(02)',
    '(03)',
    '(04-06)',
    '(07-10)',
  ]);
});

test('deriveFlowOverview:每个区间标注落在其阶段名下方(按显示宽度对齐)', () => {
  const W = t =>
    [...t].reduce((a, c) => {
      const p = c.codePointAt(0);
      const wide =
        (p >= 0x1100 && p <= 0x115f) || (p >= 0x2e80 && p <= 0x303e) ||
        (p >= 0x3041 && p <= 0x33ff) || (p >= 0x3400 && p <= 0x4dbf) ||
        (p >= 0x4e00 && p <= 0x9fff) || (p >= 0xa000 && p <= 0xa4cf) ||
        (p >= 0xac00 && p <= 0xd7a3) || (p >= 0xf900 && p <= 0xfaff) ||
        (p >= 0xfe30 && p <= 0xfe6f) || (p >= 0xff00 && p <= 0xff60) ||
        (p >= 0xffe0 && p <= 0xffe6) || (p >= 0x20000 && p <= 0x3fffd);
      return a + (wide ? 2 : 1);
    }, 0);
  const colAt = (t, c) => {
    let x = 0;
    for (const ch of t) { if (x >= c) break; x += W(ch); }
    return x;
  };

  const intervals = derivePhaseIntervals(steps, phaseDefs);
  let nameCol = 0;
  const starts = intervals.map(p => {
    const at = nameCol;
    nameCol += W(p.name) + W(' → ');
    return at;
  });

  const line2 = deriveFlowOverview(steps, phaseDefs).split('\n')[1];
  [...line2.matchAll(/\(\d\d(?:-\d\d)?\)/g)].forEach((m, i) => {
    const at = colAt(line2, m.index);
    assert.ok(
      at >= starts[i] - 1 && at + W(m[0]) <= starts[i] + W(intervals[i].name) + 1,
      `标注 ${m[0]} 落在列 ${at},不在阶段「${intervals[i].name}」的列范围 ${starts[i]}-${starts[i] + W(intervals[i].name)} 内`,
    );
  });
});

test('deriveFlowOverview:无法推导时返回 undefined(渲染器回落箭头图)', () => {
  assert.equal(deriveFlowOverview(steps, []), undefined);
  assert.equal(deriveFlowOverview([{ id: 'a', dependsOn: [] }, { id: 'b', dependsOn: [] }], phaseDefs), undefined);
});

// ---------------------------------------------------------------
// validatePhaseCoverage —— 阶段是派生值的输入,不自洽就必须报错
// ---------------------------------------------------------------

test('validatePhaseCoverage:真实阶段定义零错误', () => {
  assert.deepEqual(validatePhaseCoverage(steps, phaseDefs), []);
});

test('validatePhaseCoverage:未声明阶段不校验', () => {
  assert.deepEqual(validatePhaseCoverage(steps, []), []);
});

test('validatePhaseCoverage:漏覆盖报错', () => {
  const errors = validatePhaseCoverage(steps, phaseDefs.slice(0, 5));
  assert.ok(errors.some(e => /uncovered/.test(e.message)), JSON.stringify(errors));
});

test('validatePhaseCoverage:重叠报错', () => {
  const errors = validatePhaseCoverage(steps, [
    { name: 'A', stepIds: ['initialize'] },
    { name: 'B', stepIds: ORDER },
  ]);
  assert.ok(errors.some(e => /more than one phase/.test(e.message)), JSON.stringify(errors));
});

test('validatePhaseCoverage:不连续报错', () => {
  const errors = validatePhaseCoverage(steps, [
    { name: 'A', stepIds: ['initialize', 'brainstorm'] }, // 跳过 intent-anchor
    { name: 'B', stepIds: ORDER.filter(id => !['initialize', 'brainstorm'].includes(id)) },
  ]);
  assert.ok(errors.some(e => /contiguous/.test(e.message)), JSON.stringify(errors));
});

test('validatePhaseCoverage:声明顺序与链序不一致报错', () => {
  const errors = validatePhaseCoverage(steps, [
    { name: '后处理', stepIds: TAIL },
    { name: '前处理', stepIds: HEAD },
  ]);
  assert.ok(errors.some(e => /out of order/.test(e.message)), JSON.stringify(errors));
});

test('validatePhaseCoverage:引用不存在的步骤报错', () => {
  const errors = validatePhaseCoverage(steps, [{ name: 'X', stepIds: ['ghost'] }]);
  assert.ok(errors.some(e => /not defined/.test(e.message)), JSON.stringify(errors));
});

// ---------------------------------------------------------------
// 不猜测原则:派生失败时,诊断责任在 validateStepChain
// ---------------------------------------------------------------

test('不猜测:派生全部落空时,链校验仍能说明原因', () => {
  const broken = [
    { id: 'a', dependsOn: [] },
    { id: 'b', dependsOn: [] },
    { id: 'c', dependsOn: ['b'] },
  ];
  assert.equal(resolveChain(broken), null);
  assert.deepEqual(deriveChainNext(broken), {});
  assert.equal(deriveInitStepId(broken), undefined);
  assert.deepEqual(derivePhaseIntervals(broken, [{ name: 'X', stepIds: ['a', 'b', 'c'] }]), []);
  assert.equal(deriveFlowOverview(broken, [{ name: 'X', stepIds: ['a', 'b', 'c'] }]), undefined);

  const errors = validateStepChain(broken);
  assert.ok(errors.length > 0, '链校验必须报错');
  assert.ok(/root steps/.test(errors[0].message), errors[0].message);
});
