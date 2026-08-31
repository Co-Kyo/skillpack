# skillnomad

LLM 可执行 Markdown Skill 管线的打包工具。

## 安装

```bash
npm install -D skillnomad
```

## 使用

```bash
npx skillnomad build skillnomad.config.ts
```

`skillnomad.config.ts` 默认指向当前目录下的配置文件：

```ts
import { defineConfig } from 'skillnomad';

export default defineConfig({
  skill: './skill.ts',
  outputDir: './dist/skill',
});
```

## 核心契约：步骤之间是线性链

> 这一节是 skillnomad 对使用者的**公开承诺**，不读源码也应当知道。

**顶层 step 是不可并行的执行单位。** 步骤之间的关系是一条**线性链**，不是 DAG：

| 层次 | 能否并行 | 怎么表达 |
| :--- | :--- | :--- |
| 顶层 step 之间 | **不可并行** | 线性链；只声明一个方向即可 |
| step 内部 | 可并行 | `.parallel()` / `.map()`，由 `gate` 收敛、`maxConcurrency` 控制并发度 |

由此得到三条使用规则：

1. **不要把可并行的动作拆成多个顶层步骤。** 需要并行就在一步内部用 `.parallel()` / `.map()` 表达。
2. **`.dependsOn()` 与 `.next()` 互为反函数，只调用其中一个。** 另一个由框架推导；同时声明属冗余，也埋下不一致的风险。
3. **`next` 由框架推导，无需手写。** 框架从链序算出每一步的下一跳（末步为终止标记 `done`），
   不写也能得到正确的「下一步」章节；显式声明可覆盖推导值。
   即 `next` 已从「必须手写的字段」降为「可选覆盖的派生值」。

违反契约（多依赖 / 成环 / 断链 / 悬空引用）会在构建期报错，**不会静默线性化**。
校验由 `validateStepChain()` 实现（`skillnomad-common`），在 `skillnomad build` 与 `skillnomad validate` 两处都会执行；
所有推导函数在链不成立时一律**返回空而不猜测**，交由校验报错说明原因。

末步用终止标记 `done` 结束链；`next` 若指向未定义的步骤会直接报错。

### 阶段（phases）：只声明意图，不声明区间

`phases` 声明每个阶段**包含哪些步骤**——这是事实。
「第几步到第几步」是顺序的副产物，由框架从链序推导，**不要求也不应该手写**。

```ts
// 推荐：只声明阶段包含哪些步骤
phases: [
  { name: '初始化', stepIds: ['initialize'], description: '...' },
  { name: '前处理', stepIds: ['scan', 'capability-graph', 'evaluate-pool'], description: '...' },
]
// → 框架推导出 `(00)` / `(04-06)`，并生成两行流程总览
```

阶段是派生值的**唯一输入**，因此必须自洽。构建期由 `validatePhaseCoverage()` 断言四条：

| 约束 | 不满足的后果 |
| :--- | :--- |
| 引用的步骤必须存在 | 区间无意义 → 报错 |
| 覆盖链上每一步，且互不重叠 | 有步骤不属于任何阶段 → 报错 |
| 每个阶段是链上的**连续**区间 | 区间标注会骗人 → 报错 |
| 声明顺序与链序一致 | 总览图会倒着画 → 报错 |

不满足时框架报错而非猜测——因为此时算出来的区间标注是不可信的。

### 已由框架推导的派生值

| 派生值 | 由什么推导 | 状态 |
| :--- | :--- | :--- |
| 步骤序号（文件名 `NN-id.md`、`{{num:id}}`） | 链序 | 已支持 |
| 散文中的步骤引用 `{{step:id}}` | 链序 | 已支持 |
| 步骤的下一跳 `next` | 链序 | 已支持 |
| 阶段边界与区间标注（`(04-06)`） | 阶段意图 + 链序 | 已支持 |
| 流程总览 `flowOverview` | 阶段意图 + 链序 | 已支持 |
| 初始化步骤 `initStepId` | 链起点（入度为 0） | 已支持 |

以上推导共用同一个底座 `resolveChain()`：走一遍链，返回有序 id 列表（下标即序号）。
集中一处的原因是——每个派生函数各写一遍遍历，就会各漂移一遍。

三者都遵循同一条规则：**显式声明优先，缺省则由框架推导**。
`flowOverview` 覆盖的是**布局**（布局属于表达，框架不垄断），
但一旦手写，其中的区间标注就不再有人校验——手写即意味着自己承担漂移风险。

```ts
// 推荐：只声明前驱，顺序与编号由构建期推导
step('scan', '广域扫描')
  .dependsOn('partition')     // ← 只声明这一个方向
  .parallel(/* 步内并行在这里表达 */);

// 引用其他步骤时用标识符，不要手写序号
.target('收敛出可被 {{step:scan}} 消费的 requirement-web.json')
```

占位符：`{{step:id}}` 渲染为 `Step 04`，`{{num:id}}` 渲染为 `04`（与步骤文件名对齐）。两者都在构建期解析，未解析会直接报错。

## 包结构

```text
packages/
├── skillnomad-types/     # 类型系统 + task/seq/parallel/mapNode 等构建函数
├── skillnomad-common/    # 校验、图遍历与链推导
├── skillnomad-build/     # 打包器 + Markdown 渲染 + CLI
└── skillnomad-validate/  # 管线完整性校验 CLI
```

npm 包名：

- `skillnomad`
- `skillnomad-types`
- `skillnomad-common`
- `skillnomad-validate`

## 开发

```bash
npm install
npm run build
npm run typecheck
npm run demo
```

## Release

推送 `v*` tag，或在 GitHub Actions 中手动运行 `Release skillnomad` 工作流：

- 自动构建并打包四个 npm 包。
- 如果仓库配置了 `NPM_TOKEN` secret，自动发布到 npm。
- 自动生成 `source.zip` 与 npm tarball，并创建 GitHub Release。

## 文档

- `docs/explainer.html`：基于当前 `skillnomad` API 的教学页。

## License

MIT
