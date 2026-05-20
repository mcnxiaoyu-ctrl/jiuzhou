/**
 * 挂机执行 RabbitMQ 拆分策略测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定挂机执行命令必须通过 RabbitMQ confirm publish 投递到独立 worker，不再由 HTTP API 进程本地启动循环。
 * 2. 做什么：锁定 worker 消费端先恢复历史 active/stopping 会话，再处理 start/stop 命令，并用 ack/reject 表达消费结果。
 * 3. 不做什么：不连接 RabbitMQ，不启动 HTTP 服务，不执行真实挂机战斗。
 *
 * 输入 / 输出：
 * - 输入：队列模块、worker 入口、idleRoutes 和 startupPipeline 源码文本，以及命令决策纯函数。
 * - 输出：node:test 静态与纯函数断言，防止后续改动把挂机执行重新塞回 API 主线程。
 *
 * 数据流 / 状态流：
 * idleRoutes -> publishIdleExecutionStartCommand / publishIdleExecutionStopCommand ->
 * RabbitMQ commands queue -> idleExecutionWorker -> resolveIdleExecutionStartAction / requestImmediateStop。
 *
 * 复用设计说明：
 * - RabbitMQ 拓扑、消息协议、路由投递和 worker 生命周期集中在本测试文件约束，避免拆分策略散落在多个测试里遗漏。
 * - start 去重和状态过滤由纯函数承接，worker 与测试复用同一入口，避免在消费回调里重复判断。
 *
 * 关键边界条件与坑点：
 * 1. API 路由不能导入 startExecutionLoop/requestImmediateStop，否则 286 个线上挂机会话会继续压在 API 事件循环上。
 * 2. start 命令必须幂等，RabbitMQ 重投或 API 重试不能创建重复执行循环。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  resolveIdleExecutionStartAction,
  type IdleExecutionStartSessionSnapshot,
} from '../idle/idleExecutionCommandPolicy.js';

const readSource = (relativePath: string): string => {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
};

test('挂机执行队列应使用 RabbitMQ confirm publish、持久队列和 DLQ', () => {
  const source = readSource('../idle/idleExecutionQueue.ts');

  assert.match(source, /IDLE_EXECUTION_EXCHANGE = 'jiuzhou\.idle_execution'/u);
  assert.match(source, /IDLE_EXECUTION_COMMAND_QUEUE = 'jiuzhou\.idle_execution\.commands'/u);
  assert.match(source, /IDLE_EXECUTION_DLQ = 'jiuzhou\.idle_execution\.dlq'/u);
  assert.match(source, /getRabbitMqConfirmChannel/u);
  assert.match(source, /waitForConfirms/u);
  assert.match(source, /persistent: true/u);
  assert.match(source, /channel\.ack\(message\)/u);
  assert.match(source, /channel\.reject\(message, false\)/u);
  assert.match(source, /publishIdleExecutionStartCommand/u);
  assert.match(source, /publishIdleExecutionStopCommand/u);
});

test('idleRoutes 只能发布挂机命令，不能本地启动或唤醒执行循环', () => {
  const source = readSource('../../routes/idleRoutes.ts');

  assert.match(source, /publishIdleExecutionStartCommand/u);
  assert.match(source, /publishIdleExecutionStopCommand/u);
  assert.doesNotMatch(source, /startExecutionLoop/u);
  assert.doesNotMatch(source, /requestImmediateStop/u);
});

test('挂机执行 worker 应由 startupPipeline 接入并先恢复历史会话', () => {
  const workerSource = readSource('../../workers/idleExecutionWorker.ts');
  const startupSource = readSource('../../bootstrap/startupPipeline.ts');

  assert.match(workerSource, /startIdleExecutionWorker/u);
  assert.match(workerSource, /stopIdleExecutionWorker/u);
  assert.match(workerSource, /recoverActiveIdleSessions/u);
  assert.match(workerSource, /startIdleExecutionConsumer/u);
  assert.match(workerSource, /resolveIdleExecutionStartAction/u);
  assert.match(workerSource, /requestImmediateStop/u);
  assert.match(startupSource, /if \(shouldStartIdleExecutionWorker\(runtimeRole\)\)/u);
  assert.match(startupSource, /startIdleExecutionWorker/u);
  assert.match(startupSource, /stopIdleExecutionWorker/u);
});

test('start 命令只应启动 active/stopping 且未注册本地循环的会话', () => {
  const activeSession: IdleExecutionStartSessionSnapshot = {
    id: 'session-active',
    status: 'active',
  };
  const stoppingSession: IdleExecutionStartSessionSnapshot = {
    id: 'session-stopping',
    status: 'stopping',
  };
  const completedSession: IdleExecutionStartSessionSnapshot = {
    id: 'session-completed',
    status: 'completed',
  };

  assert.equal(resolveIdleExecutionStartAction(activeSession, false), 'start');
  assert.equal(resolveIdleExecutionStartAction(stoppingSession, false), 'start');
  assert.equal(resolveIdleExecutionStartAction(activeSession, true), 'skip_registered');
  assert.equal(resolveIdleExecutionStartAction(completedSession, false), 'skip_inactive');
  assert.equal(resolveIdleExecutionStartAction(null, false), 'skip_missing');
});
