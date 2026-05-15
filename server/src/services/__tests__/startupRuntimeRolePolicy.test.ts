/**
 * 服务运行角色启动策略测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定 API 角色不启动在线战斗延迟结算 runner。
 * 2. 做什么：锁定 worker 角色不监听 HTTP 端口。
 * 3. 不做什么：不启动真实服务，不修改 Docker Swarm。
 *
 * 输入 / 输出：
 * - 输入：runtimeRole.ts 和 startupPipeline.ts 源码文本。
 * - 输出：静态断言。
 *
 * 数据流 / 状态流：
 * JIUZHOU_RUNTIME_ROLE -> runtimeRole helpers -> startupPipeline 按角色启动 HTTP 或后台任务。
 *
 * 复用设计说明：
 * - 用单一 runtimeRole 模块集中解释环境变量，避免 startupPipeline 各处直接解析字符串。
 *
 * 关键边界条件与坑点：
 * 1. 默认 all 保持当前单服务行为，降低部署切换风险。
 * 2. worker 角色仍需数据库、Redis、事件循环监控和必要静态配置预热，但不能接受 HTTP 流量。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('runtimeRole 应定义 all/api/worker 三种运行角色', () => {
  const source = readFileSync(new URL('../../config/runtimeRole.ts', import.meta.url), 'utf8');
  assert.match(source, /export type JiuzhouRuntimeRole = 'all' \| 'api' \| 'worker';/u);
  assert.match(source, /export const shouldStartHttpServer/u);
  assert.match(source, /export const shouldStartOnlineSettlementRunner/u);
  assert.match(source, /export const shouldStartGeneralBackgroundWorkers/u);
});

test('startupPipeline 应按运行角色控制 HTTP 与在线结算 runner', () => {
  const source = readFileSync(new URL('../../bootstrap/startupPipeline.ts', import.meta.url), 'utf8');
  assert.match(source, /const runtimeRole = resolveJiuzhouRuntimeRole\(\);/u);
  assert.match(source, /if \(shouldStartOnlineSettlementRunner\(runtimeRole\)\) \{/u);
  assert.match(source, /if \(shouldStartGeneralBackgroundWorkers\(runtimeRole\)\) \{/u);
  assert.match(source, /if \(shouldStartHttpServer\(runtimeRole\)\) \{/u);
});
