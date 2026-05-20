/**
 * 服务运行角色启动策略测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定 API 角色启动请求型 AI worker，不启动挂机计算池、定时后台调度和在线战斗延迟结算。
 * 2. 做什么：锁定 worker 角色不监听 HTTP 端口、不承接请求型内存队列，只运行可独立调度的后台服务和挂机执行 worker。
 * 3. 不做什么：不启动真实服务，不修改 Docker Swarm。
 *
 * 输入 / 输出：
 * - 输入：runtimeRole helper 的真实导入，以及 startupPipeline.ts 源码文本。
 * - 输出：行为矩阵断言和轻量静态 guard 断言。
 *
 * 数据流 / 状态流：
 * JIUZHOU_RUNTIME_ROLE -> runtimeRole helpers -> startupPipeline 按角色启动 HTTP、请求型 Worker、挂机执行 Worker、恢复任务或后台调度。
 *
 * 复用设计说明：
 * - 用单一 runtimeRole 模块集中解释环境变量，避免 startupPipeline 各处直接解析字符串。
 *
 * 关键边界条件与坑点：
 * 1. 默认 all 保持当前单服务行为，降低部署切换风险。
 * 2. worker 角色仍需数据库、Redis、事件循环监控和必要静态配置预热，但不能接受 HTTP 流量，也不能承接 API 请求型 AI 内存队列。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  resolveJiuzhouRuntimeRole,
  shouldRecoverHttpBattleState,
  shouldRecoverIdleSessions,
  shouldStartHttpServer,
  shouldStartIdleExecutionWorker,
  shouldStartOnlineSettlementRunner,
  shouldStartRequestBoundJobWorkers,
  shouldStartScheduledBackgroundServices,
  shouldStartWorkerPool,
  type JiuzhouRuntimeRole,
} from '../../config/runtimeRole.js';

interface RuntimeRolePolicySnapshot {
  httpServer: boolean;
  onlineSettlementRunner: boolean;
  requestBoundJobWorkers: boolean;
  workerPool: boolean;
  idleExecutionWorker: boolean;
  scheduledBackgroundServices: boolean;
  httpBattleStateRecovery: boolean;
  idleSessionsRecovery: boolean;
}

interface RuntimeRolePolicyCase {
  role: JiuzhouRuntimeRole;
  expected: RuntimeRolePolicySnapshot;
}

const readRuntimeRolePolicy = (role: JiuzhouRuntimeRole): RuntimeRolePolicySnapshot => {
  return {
    httpServer: shouldStartHttpServer(role),
    onlineSettlementRunner: shouldStartOnlineSettlementRunner(role),
    requestBoundJobWorkers: shouldStartRequestBoundJobWorkers(role),
    workerPool: shouldStartWorkerPool(role),
    idleExecutionWorker: shouldStartIdleExecutionWorker(role),
    scheduledBackgroundServices: shouldStartScheduledBackgroundServices(role),
    httpBattleStateRecovery: shouldRecoverHttpBattleState(role),
    idleSessionsRecovery: shouldRecoverIdleSessions(role),
  };
};

const withRuntimeRoleEnv = (value: string | undefined, action: () => void): void => {
  const originalValue = process.env.JIUZHOU_RUNTIME_ROLE;

  try {
    if (value === undefined) {
      delete process.env.JIUZHOU_RUNTIME_ROLE;
    } else {
      process.env.JIUZHOU_RUNTIME_ROLE = value;
    }
    action();
  } finally {
    if (originalValue === undefined) {
      delete process.env.JIUZHOU_RUNTIME_ROLE;
    } else {
      process.env.JIUZHOU_RUNTIME_ROLE = originalValue;
    }
  }
};

const assertStartupSourceContains = (source: string, token: string): void => {
  assert.ok(source.includes(token), `startupPipeline 应包含 ${token}`);
};

const assertGuardNearStartupEffect = (
  source: string,
  guardCall: string,
  effectName: string,
): void => {
  const pipelineStartIndex = source.indexOf('export const startServerWithPipeline');
  assert.notEqual(pipelineStartIndex, -1, 'startupPipeline 应包含 startServerWithPipeline');

  const effectIndex = source.indexOf(effectName, pipelineStartIndex);
  assert.notEqual(effectIndex, -1, `startupPipeline 应包含 ${effectName}`);

  const guardIndex = source.lastIndexOf(guardCall, effectIndex);
  assert.notEqual(guardIndex, -1, `${effectName} 应位于 ${guardCall} 之后`);
  assert.ok(effectIndex - guardIndex <= 1_800, `${effectName} 应靠近 ${guardCall}`);
};

test('runtimeRole 应按 all/api/worker 返回启动策略矩阵', () => {
  const cases: readonly RuntimeRolePolicyCase[] = [
    {
      role: 'all',
      expected: {
        httpServer: true,
        onlineSettlementRunner: true,
        requestBoundJobWorkers: true,
        workerPool: true,
        idleExecutionWorker: true,
        scheduledBackgroundServices: true,
        httpBattleStateRecovery: true,
        idleSessionsRecovery: true,
      },
    },
    {
      role: 'api',
      expected: {
        httpServer: true,
        onlineSettlementRunner: false,
        requestBoundJobWorkers: true,
        workerPool: false,
        idleExecutionWorker: false,
        scheduledBackgroundServices: false,
        httpBattleStateRecovery: true,
        idleSessionsRecovery: false,
      },
    },
    {
      role: 'worker',
      expected: {
        httpServer: false,
        onlineSettlementRunner: true,
        requestBoundJobWorkers: false,
        workerPool: true,
        idleExecutionWorker: true,
        scheduledBackgroundServices: true,
        httpBattleStateRecovery: false,
        idleSessionsRecovery: true,
      },
    },
  ];

  for (const policyCase of cases) {
    assert.deepEqual(readRuntimeRolePolicy(policyCase.role), policyCase.expected, policyCase.role);
  }
});

test('resolveJiuzhouRuntimeRole 应在非法值或空值时回落 all', () => {
  withRuntimeRoleEnv(undefined, () => {
    assert.equal(resolveJiuzhouRuntimeRole(), 'all');
  });

  withRuntimeRoleEnv('', () => {
    assert.equal(resolveJiuzhouRuntimeRole(), 'all');
  });

  withRuntimeRoleEnv('invalid-role', () => {
    assert.equal(resolveJiuzhouRuntimeRole(), 'all');
  });
});

test('startupPipeline 应导入运行角色 guard helper', () => {
  const source = readFileSync(new URL('../../bootstrap/startupPipeline.ts', import.meta.url), 'utf8');
  const runtimeRoleImportBlock = source.match(/import \{[\s\S]*?\} from "\.\.\/config\/runtimeRole\.js";/u)?.[0] ?? '';

  assert.notEqual(runtimeRoleImportBlock, '', 'startupPipeline 应从 runtimeRole 导入 helper');
  assertStartupSourceContains(runtimeRoleImportBlock, 'resolveJiuzhouRuntimeRole');
  assertStartupSourceContains(runtimeRoleImportBlock, 'shouldStartHttpServer');
  assertStartupSourceContains(runtimeRoleImportBlock, 'shouldStartIdleExecutionWorker');
  assertStartupSourceContains(runtimeRoleImportBlock, 'shouldStartOnlineSettlementRunner');
  assertStartupSourceContains(runtimeRoleImportBlock, 'shouldStartRequestBoundJobWorkers');
  assertStartupSourceContains(runtimeRoleImportBlock, 'shouldStartWorkerPool');
  assertStartupSourceContains(runtimeRoleImportBlock, 'shouldStartScheduledBackgroundServices');
  assertStartupSourceContains(runtimeRoleImportBlock, 'shouldRecoverHttpBattleState');
});

test('startupPipeline 应保留关键启动副作用的角色 guard', () => {
  const source = readFileSync(new URL('../../bootstrap/startupPipeline.ts', import.meta.url), 'utf8');
  assertStartupSourceContains(source, 'const runtimeRole = resolveJiuzhouRuntimeRole();');
  assertStartupSourceContains(source, 'if (shouldStartOnlineSettlementRunner(runtimeRole))');
  assertStartupSourceContains(source, 'if (shouldStartRequestBoundJobWorkers(runtimeRole))');
  assertStartupSourceContains(source, 'if (shouldStartIdleExecutionWorker(runtimeRole))');
  assertStartupSourceContains(source, 'if (shouldStartHttpServer(runtimeRole))');

  assertGuardNearStartupEffect(source, 'if (shouldStartWorkerPool(runtimeRole))', 'initializeWorkerPool');
  assertGuardNearStartupEffect(source, 'if (shouldStartIdleExecutionWorker(runtimeRole))', 'startIdleExecutionWorker');
  assertGuardNearStartupEffect(source, 'if (shouldStartOnlineSettlementRunner(runtimeRole))', 'initializeOnlineBattleSettlementRunner');
  assertGuardNearStartupEffect(source, 'if (shouldStartRequestBoundJobWorkers(runtimeRole))', 'initializeTechniqueGenerationJobRunner');
  assertGuardNearStartupEffect(source, 'if (shouldStartRequestBoundJobWorkers(runtimeRole))', 'initializePartnerRecruitJobRunner');
  assertGuardNearStartupEffect(source, 'if (shouldStartRequestBoundJobWorkers(runtimeRole))', 'initializePartnerFusionJobRunner');
  assertGuardNearStartupEffect(source, 'if (shouldStartRequestBoundJobWorkers(runtimeRole))', 'initializePartnerReboneJobRunner');
  assertGuardNearStartupEffect(source, 'if (shouldStartRequestBoundJobWorkers(runtimeRole))', 'initializeWanderJobRunner');
  assertGuardNearStartupEffect(source, 'if (shouldStartScheduledBackgroundServices(runtimeRole))', 'initializeAfdianMessageRetryService');
  assertGuardNearStartupEffect(source, 'if (shouldStartScheduledBackgroundServices(runtimeRole))', 'initializeCharacterSettlementResourceDeltaService');
  assertGuardNearStartupEffect(source, 'if (shouldStartScheduledBackgroundServices(runtimeRole))', 'initializeCharacterItemGrantDeltaService');
  assertGuardNearStartupEffect(source, 'if (shouldStartScheduledBackgroundServices(runtimeRole))', 'initializeCharacterItemInstanceMutationService');
  assertGuardNearStartupEffect(source, 'if (shouldStartScheduledBackgroundServices(runtimeRole))', 'initializeTaskProgressDeltaFlushService');
  assertGuardNearStartupEffect(source, 'if (shouldStartScheduledBackgroundServices(runtimeRole))', 'initializeRankSnapshotNightlyRefreshScheduler');
  assertGuardNearStartupEffect(source, 'if (shouldStartScheduledBackgroundServices(runtimeRole))', 'initGameTimeService');
  assertGuardNearStartupEffect(source, 'if (shouldStartScheduledBackgroundServices(runtimeRole))', 'initArenaWeeklySettlementService');
  assertGuardNearStartupEffect(source, 'if (shouldStartScheduledBackgroundServices(runtimeRole))', 'startCleanupWorker');
  assertGuardNearStartupEffect(source, 'if (shouldStartScheduledBackgroundServices(runtimeRole))', 'startMarketListingAutoCancelWorker');
  assertGuardNearStartupEffect(source, 'if (shouldRecoverHttpBattleState(runtimeRole) && redisConnected)', 'recoverBattlesFromRedis');
  assertGuardNearStartupEffect(source, 'if (shouldRecoverHttpBattleState(runtimeRole) && redisConnected)', 'recoverBattleSessionsFromProjection');
  assertStartupSourceContains(source, 'stopIdleExecutionWorker');
  assertGuardNearStartupEffect(source, 'if (shouldStartHttpServer(runtimeRole))', 'options.httpServer.listen');
});
