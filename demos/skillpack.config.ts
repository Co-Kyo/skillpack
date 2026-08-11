// ============================================================
// skillpack.config.ts — 构建配置（类比 vite.config.ts）
//
// 职责：声明 skill 链接、输出路径、meta 覆盖
// 由 skillpack CLI 读取并执行构建
// ============================================================

import { defineConfig } from '@co-kyo/skillpack';

export default defineConfig({
  // 参数链接到 skill 定义文件
  skill: './skill.ts',
  outputDir: '../dist',
});
