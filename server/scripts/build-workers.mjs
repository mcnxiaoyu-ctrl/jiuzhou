#!/usr/bin/env node
import './shared/installConsoleLogger.mjs';
/**
 * Worker 构建脚本 - 开发环境专用
 *
 * 作用：
 *   在开发环境启动前，快速编译 worker 文件到 dist 目录
 *   解决 tsx 在 worker_threads 中无法正确处理 TypeScript 的问题
 *
 * 为什么需要这个脚本：
 *   tsx 的 --import 加载器在 worker 线程中无法正确解析 .js 到 .ts 的映射
 *   预编译 worker 文件是最简单可靠的解决方案
 *
 * 使用场景：
 *   仅在开发环境使用，生产环境通过正常的 tsc 构建流程处理
 */

import { execSync } from 'child_process';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const workerBuildEntries = [
  'src/workers/idleBattleWorker.ts',
  'src/workers/techniqueGenerationWorker.ts',
  'src/workers/techniqueGenerationWorkerShared.ts',
  'src/workers/wanderWorker.ts',
  'src/workers/wanderWorkerShared.ts',
  'src/workers/partnerRecruitWorker.ts',
  'src/workers/partnerRecruitWorkerShared.ts',
  'src/workers/partnerFusionWorker.ts',
  'src/workers/partnerFusionWorkerShared.ts',
  'src/workers/partnerFusionWorkerExecution.ts',
  // 挂机 worker 依赖的纯计算模块在开发环境也要一起输出到 dist。
  'src/services/idle/idleBattleSimulationCore.ts',
  'src/services/idle/types.ts',
  // 功法生成 worker 会间接依赖该共享执行模块，显式纳入避免开发态 dist 缺文件。
  'src/services/shared/techniqueGenerationExecution.ts',
];

console.log('[build-workers] 正在编译 worker 文件...');

try {
  // 编译所有开发环境下会被 worker_threads 直接加载的入口与关键依赖到 dist 目录。
  execSync(
    [
      'npx tsc',
      ...workerBuildEntries,
      '--outDir dist',
      '--module esnext',
      '--target es2022',
      '--moduleResolution node',
      '--esModuleInterop',
      '--skipLibCheck',
      '--noCheck',
    ].join(' '),
    {
      cwd: dirname(__dirname),
      stdio: 'inherit'
    }
  );

  console.log('[build-workers] ✓ Worker 文件编译完成');
} catch (error) {
  console.error('[build-workers] ✗ 编译失败:', error.message);
  process.exit(1);
}
