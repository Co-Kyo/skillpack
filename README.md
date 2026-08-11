# skillpack

LLM 可执行 Markdown Skill 管线的打包工具。

## 安装

```bash
npm install -D @co-kyo/skillpack
```

## 使用

```bash
npx skillpack build skillpack.config.ts
```

`skillpack.config.ts` 默认指向当前目录下的配置文件：

```ts
import { defineConfig } from '@co-kyo/skillpack';

export default defineConfig({
  skill: './skill.ts',
  outputDir: './dist/skill',
});
```

## 包结构

```text
packages/
├── skillpack-types/     # 类型系统 + task/seq/parallel/mapNode 等构建函数
├── skillpack-common/    # 校验、拓扑排序、图遍历
├── skillpack-build/     # 打包器 + Markdown 渲染 + CLI
└── skillpack-validate/  # 管线完整性校验 CLI
```

npm 包名：

- `@co-kyo/skillpack`
- `@co-kyo/skillpack-types`
- `@co-kyo/skillpack-common`
- `@co-kyo/skillpack-validate`

## 开发

```bash
npm install
npm run build
npm run typecheck
npm run demo
```

## Release

推送 `v*` tag，或在 GitHub Actions 中手动运行 `Release skillpack` 工作流：

- 自动构建并打包四个 npm 包。
- 如果仓库配置了 `NPM_TOKEN` secret，自动发布到 npm。
- 自动生成 `source.zip` 与 npm tarball，并创建 GitHub Release。

## License

MIT
