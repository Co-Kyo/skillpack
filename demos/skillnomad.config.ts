// ============================================================
// skillnomad.config.ts — 构建配置（类比 vite.config.ts）
//
// 职责：声明 skill 链接、输出路径、meta 覆盖
// 由 skillnomad CLI 读取并执行构建
// ============================================================

import { defineConfig } from 'skillnomad';

export default defineConfig({
  // 参数链接到 skill 定义文件
  skill: './skill.ts',
  outputDir: '../dist',
});
