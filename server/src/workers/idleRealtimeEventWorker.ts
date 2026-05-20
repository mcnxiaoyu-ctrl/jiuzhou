/**
 * 挂机实时事件 API 转发入口
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：API 进程消费 worker 发布的挂机实时事件，并转发到当前进程持有的玩家 Socket。
 * 2. 做什么：把 idle:update、idle:finished、角色刷新三类推送集中到一个入口，保持拆分前的客户端事件语义。
 * 3. 不做什么：不执行战斗、不查询挂机会话、不创建或停止 RabbitMQ 执行命令。
 *
 * 输入 / 输出：
 * - 输入：idleRealtimeEventQueue 中的结构化实时事件。
 * - 输出：GameServer 本地 Socket 推送；启动函数返回后由 startupPipeline 持有生命周期。
 *
 * 数据流 / 状态流：
 * RabbitMQ consumer -> handleIdleRealtimeEvent -> GameServer.emitToUser / pushCharacterUpdate -> 客户端。
 *
 * 复用设计说明：
 * - API 进程是唯一拥有玩家 Socket 映射的角色，因此跨进程推送统一在这里落地，避免 worker 继续调用失效的进程内映射。
 * - 角色刷新与挂机摘要复用同一个 consumer，减少 RabbitMQ channel 和启动步骤重复。
 *
 * 关键边界条件与坑点：
 * 1. 用户离线时 emitToUser 返回 false 属于正常情况，不能让消息进入 DLQ 造成无意义堆积。
 * 2. pushCharacterUpdate 内部已有防抖与增量 diff，这里只做转发，不重复实现角色快照逻辑。
 */
import { getGameServer } from '../game/gameServer.js';
import {
  startIdleRealtimeEventConsumer,
  type IdleRealtimeEvent,
} from '../services/idle/idleRealtimeEventQueue.js';

let stopConsumerFn: (() => Promise<void>) | null = null;
let startingWorker: Promise<void> | null = null;

const handleIdleRealtimeEvent = async (
  event: IdleRealtimeEvent,
): Promise<void> => {
  const gameServer = getGameServer();

  if (event.type === 'character_update') {
    await gameServer.pushCharacterUpdate(event.userId);
    return;
  }

  if (event.type === 'finished') {
    gameServer.emitToUser(event.userId, 'idle:finished', {
      sessionId: event.sessionId,
      reason: event.reason,
    });
    return;
  }

  gameServer.emitToUser(event.userId, 'idle:update', {
    sessionId: event.sessionId,
    batchIndex: event.batchIndex,
    result: event.result,
    expGained: event.expGained,
    silverGained: event.silverGained,
    itemsGained: event.itemsGained,
    roundCount: event.roundCount,
  });
};

export const startIdleRealtimeEventWorker = async (): Promise<void> => {
  if (stopConsumerFn) {
    return;
  }
  if (startingWorker) {
    await startingWorker;
    return;
  }

  startingWorker = (async () => {
    stopConsumerFn = await startIdleRealtimeEventConsumer(handleIdleRealtimeEvent);
  })();

  try {
    await startingWorker;
  } finally {
    startingWorker = null;
  }
};

export const stopIdleRealtimeEventWorker = async (): Promise<void> => {
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
