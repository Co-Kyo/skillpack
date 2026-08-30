import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveStepRefs } from '../dist/index.js';

const order = {
  initialize: 0,
  'intent-anchor': 1,
  brainstorm: 2,
  partition: 3,
  scan: 4,
  'capability-graph': 5,
  'evaluate-pool': 6,
  'capability-research': 7,
  'briefing-assemble': 8,
  assemble: 9,
  'learning-ladder': 10,
};

test('{{step:id}} → Step NN(0.1.x 行为保持)', () => {
  assert.equal(resolveStepRefs('由 {{step:scan}} 消费', order), '由 Step 04 消费');
});

test('{{num:id}} → 两位补零序号(0.2.0 新增)', () => {
  assert.equal(resolveStepRefs('步骤 {{num:scan}}', order), '步骤 04');
  assert.equal(resolveStepRefs('{{num:learning-ladder}}', order), '10');
});

test('区间组合:Step NN 与 NN 混用', () => {
  assert.equal(
    resolveStepRefs('前处理循环(Step {{num:scan}} → {{num:evaluate-pool}})', order),
    '前处理循环(Step 04 → 06)',
  );
});

test('未知 id 抛错(带语法种类)', () => {
  assert.throws(() => resolveStepRefs('{{step:nope}}', order), /Unresolved step reference: \{\{step:nope\}\}/);
  assert.throws(() => resolveStepRefs('{{num:nope}}', order), /Unresolved step reference: \{\{num:nope\}\}/);
});

test('无占位符文本原样返回', () => {
  assert.equal(resolveStepRefs('普通文本 15s 轮询', order), '普通文本 15s 轮询');
});
