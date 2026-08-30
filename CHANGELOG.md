# Changelog

## v0.2.0

- 新增 `{{num:stepId}}` 占位符:渲染为两位补零步骤序号(与 processes 文件名一致);`{{step:stepId}}` 行为不变。
- 插值盲区补全:bodyFile 内容、任务级 bodyFile、SKILL.md flowOverview 现在也经 `resolveStepRefs` 解析。
- `renderStep` 新增 `stepOrder` 参数(渲染期可解析任意文本中的步骤引用)。
- 首批单元测试(node --test,5 项)。

## v0.1.0

- 首次开源发布。
