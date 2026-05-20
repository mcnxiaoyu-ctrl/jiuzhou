/**
 * 挂机执行 RabbitMQ Worker 入口
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：在独立 worker 角色中恢复历史挂机会话，并消费 API 进程投递的 start/stop 命令。
 * 2. 做什么：把跨进程命令转换为现有 IdleBattleExecutor 的 startExecutionLoop/requestImmediateStop 调用。
 * 3. 不做什么：不暴露 HTTP 端口，不创建会话，不修改客户端接口，也不重新实现挂机战斗计算。
 *
 * 输入 / 输出：
 * - 输入：RabbitMQ 命令队列中的 start/stop 消息，以及启动时数据库中的 active/stopping 会话。
 * - 输出：本进程内的挂机执行循环；停止时取消 RabbitMQ consumer。
 *
 * 数据流 / 状态流：
 * startupPipeline(worker) -> startIdleExecutionWorker -> recoverActiveIdleSessions ->
 * startIdleExecutionConsumer -> handleCommand -> idleSessionService / IdleBattleExecutor。
 *
 * 复用设计说明：
 * - 恢复、启动、停止都复用现有 idleBattleExecutorWorker，保留纯计算 WorkerPool、30 秒批量 flush 和房间怪物缓存路径。
 * - 命令状态判断复用 idleExecutionCommandPolicy，避免 RabbitMQ 重投幂等规则散落在消费回调里。
 *
 * 关键边界条件与坑点：
 * 1. start 命令按 sessionId 重查数据库，不信任消息里的状态，避免 API 投递后用户立即停止导致过期启动。
 * 2. stop 命令只唤醒本地循环；若当前 worker 尚未注册该会话，DB 中 stopping 状态仍会被低频检查或恢复链路收敛。
 */
import { createScopedLogger } from '../utils/logger.js';
import {
  recoverActiveIdleSessions,
  requestImmediateStop,
  startExecutionLoop,
} from '../services/idle/idleBattleExecutorWorker.js';
import { idleSessionService } from '../services/idle/idleSessionService.js';
import { hasRegisteredIdleExecutionLoop } from '../services/idle/idleExecutionRegistry.js';
import {
  resolveIdleExecutionStartAction,
  type IdleExecutionStartSessionSnapshot,
} from '../services/idle/idleExecutionCommandPolicy.js';
import {
  startIdleExecutionConsumer,
  type IdleExecutionCommand,
  type IdleExecutionStartCommand,
} from '../services/idle/idleExecutionQueue.js';

const logger = createScopedLogger('idle.execution.worker');

let stopConsumerFn: (() => Promise<void>) | null = null;
let startingWorker: Promise<void> | null = null;

const toStartSessionSnapshot = (
  session: Awaited<ReturnType<typeof idleSessionService.getIdleSessionById>>,
): IdleExecutionStartSessionSnapshot | null => {
  if (!session) {
    return null;
  }

  return {
    id: session.id,
    status: session.status,
  };
};

const handleStartCommand = async (
  command: IdleExecutionStartCommand,
): Promise<void> => {
  const session = await idleSessionService.getIdleSessionById(command.sessionId);
  const action = resolveIdleExecutionStartAction(
    toStartSessionSnapshot(session),
    hasRegisteredIdleExecutionLoop(command.sessionId),
  );

  if (action !== 'start') {
    logger.info(
      {
        action,
        sessionId: command.sessionId,
        characterId: command.characterId,
      },
      '挂机 start 命令已跳过',
    );
    return;
  }

  if (!session) {
    return;
  }

  startExecutionLoop(session, command.userId);
};

const handleCommand = async (command: IdleExecutionCommand): Promise<void> => {
  if (command.type === 'start') {
    await handleStartCommand(command);
    return;
  }

  requestImmediateStop(command.sessionId);
};

export const startIdleExecutionWorker = async (): Promise<void> => {
  if (stopConsumerFn) {
    return;
  }
  if (startingWorker) {
    await startingWorker;
    return;
  }

  startingWorker = (async () => {
    await recoverActiveIdleSessions();
    stopConsumerFn = await startIdleExecutionConsumer(handleCommand);
  })();

  try {
    await startingWorker;
  } finally {
    startingWorker = null;
  }
};

export const stopIdleExecutionWorker = async (): Promise<void> => {
  if (startingWorker) {
    await startingWorker;
  }

  const stop = stopConsumerFn;
  if (!stop) {
    return;
  }

  stopConsumerFn = null;
  await stop();
};
