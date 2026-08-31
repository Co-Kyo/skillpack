#!/usr/bin/env node

import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { buildPipeline } from '../index.js';
import type { SkillnomadConfig } from '../index.js';

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command !== 'build') {
    console.error('Usage: skillnomad build [config-file]');
    console.error('  Config file defaults to skillnomad.config.ts in cwd');
    process.exit(1);
  }

  const cwd = process.cwd();
  const configFile = resolve(cwd, args[1] || 'skillnomad.config.ts');

  if (!existsSync(configFile)) {
    console.error(`Config file not found: ${configFile}`);
    process.exit(1);
  }

  // Import config (use file:// URL for Windows compat)
  const configUrl = pathToFileURL(configFile).href;
  const config: SkillnomadConfig = (await import(configUrl)).default;

  // Resolve skill path relative to config file's directory
  const skillPath = resolve(dirname(configFile), config.skill);

  if (!existsSync(skillPath)) {
    console.error(`Skill file not found: ${skillPath} (from config.skill: "${config.skill}")`);
    process.exit(1);
  }

  // Import skill definition (must export `skill` from createSkill())
  const skillUrl = pathToFileURL(skillPath).href;
  const mod = await import(skillUrl);

  if (!mod.skill || !mod.skill.steps) {
    console.error(`Skill file must export \`skill\` via createSkill()`);
    process.exit(1);
  }

  const { name, title, description, api, steps } = mod.skill;

  // Merge meta: skill's defaults + config overrides
  const meta = {
    name,
    title,
    description,
    api,
    ...(config.meta || {}),
  };

  buildPipeline(steps, config.outputDir, meta);
}

main().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
