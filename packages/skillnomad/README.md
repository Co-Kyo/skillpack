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

## 包结构

```text
packages/
├── skillnomad-types/     # 类型系统 + task/seq/parallel/mapNode 等构建函数
├── skillnomad-common/    # 校验、拓扑排序、图遍历
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

## License

MIT
