/**
 * 挂机实时事件 RabbitMQ 转发队列
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把 worker 进程产生的挂机实时事件转发给 API 进程，由 API 进程向本地 Socket 连接发送。
 * 2. 做什么：集中声明 exchange、queue、DLQ、消息协议与 ack/reject 规则，避免执行器和启动流水线各自拼 RabbitMQ 细节。
 * 3. 不做什么：不执行挂机战斗、不读写 idle_sessions、不改变 HTTP 接口响应结构。
 *
 * 输入 / 输出：
 * - 输入：worker 侧发布 idle:update、idle:finished、character_update 三类事件。
 * - 输出：API 侧 consumer 收到结构化事件；处理成功 ack，处理失败 reject(false) 进入 DLQ。
 *
 * 数据流 / 状态流：
 * IdleBattleExecutor(worker) -> publishIdleRealtimeEvent -> RabbitMQ ->
 * startIdleRealtimeEventConsumer(api) -> idleRealtimeEventWorker -> GameServer Socket。
 *
 * 复用设计说明：
 * - “跨进程 Socket 转发”是挂机拆分后的公共边界，集中在这里可以让 update、finished、角色刷新复用同一套拓扑。
 * - 事件协议独立于执行命令队列，避免 start/stop 控制流和高频 UI 通知互相影响。
 *
 * 关键边界条件与坑点：
 * 1. 实时事件不能阻塞挂机战斗热路径；发布方可选择 best-effort，DB 30 秒 flush 仍是最终一致来源。
 * 2. API 消费失败必须进入 DLQ，不能 ack 掉，否则跨进程推送断点会再次变成静默失败。
 */
import type { ConfirmChannel, ConsumeMessage, Options } from 'amqplib';
import { hostname } from 'os';
import { createScopedLogger } from '../../utils/logger.js';
import { getRabbitMqConfirmChannel } from '../shared/rabbitMqConnection.js';
import type { RewardItemEntry } from './types.js';

export const IDLE_REALTIME_EXCHANGE = 'jiuzhou.idle_realtime';
export const IDLE_REALTIME_EVENT_QUEUE_PREFIX = 'jiuzhou.idle_realtime.events';
export const IDLE_REALTIME_DLQ = 'jiuzhou.idle_realtime.dlq';

export const IDLE_REALTIME_EVENT_ROUTING_KEY = 'idle_realtime.event';
export const IDLE_REALTIME_DLQ_ROUTING_KEY = 'idle_realtime.dlq';

const DEFAULT_IDLE_REALTIME_PREFETCH = 256;

const logger = createScopedLogger('idle.realtime.queue');

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
type JsonObject = {
  readonly [key: string]: JsonValue;
};

export type IdleRealtimeUpdateEvent = {
  type: 'update';
  userId: number;
  sessionId: string;
  batchIndex: number;
  result: 'attacker_win' | 'defender_win' | 'draw';
  expGained: number;
  silverGained: number;
  itemsGained: RewardItemEntry[];
  roundCount: number;
};

export type IdleRealtimeFinishedEvent = {
  type: 'finished';
  userId: number;
  sessionId: string;
  reason: string;
};

export type IdleRealtimeCharacterUpdateEvent = {
  type: 'character_update';
  userId: number;
};

export type IdleRealtimeEvent =
  | IdleRealtimeUpdateEvent
  | IdleRealtimeFinishedEvent
  | IdleRealtimeCharacterUpdateEvent;

export type IdleRealtimeEventHandler = (
  event: IdleRealtimeEvent,
) => Promise<void> | void;

let publishTopologyReadyChannel: ConfirmChannel | null = null;
let publishTopologyReadyPromise: Promise<void> | null = null;
let publishTopologyReadyPromiseChannel: ConfirmChannel | null = null;
let consumerTopologyReadyChannel: ConfirmChannel | null = null;
let consumerTopologyReadyPromise: Promise<string> | null = null;
let consumerTopologyReadyPromiseChannel: ConfirmChannel | null = null;

const eventQueueOptions = {
  durable: false,
  exclusive: true,
  autoDelete: true,
  arguments: {
    'x-dead-letter-exchange': IDLE_REALTIME_EXCHANGE,
    'x-dead-letter-routing-key': IDLE_REALTIME_DLQ_ROUTING_KEY,
  },
} satisfies Options.AssertQueue;

const dlqOptions = {
  durable: true,
} satisfies Options.AssertQueue;

const publishOptions = {
  persistent: false,
  contentType: 'application/json',
  appId: `jiuzhou:${hostname()}`,
} satisfies Options.Publish;

const resolveEventQueueName = (): string => {
  return `${IDLE_REALTIME_EVENT_QUEUE_PREFIX}.${hostname()}.${process.pid}`;
};

const parsePrefetch = (): number => {
  const rawValue = process.env.IDLE_REALTIME_EVENT_PREFETCH?.trim();
  if (!rawValue) {
    return DEFAULT_IDLE_REALTIME_PREFETCH;
  }

  const value = Number(rawValue);
  if (!Number.isInteger(value) || value <= 0) {
    return DEFAULT_IDLE_REALTIME_PREFETCH;
  }
  return value;
};

const isJsonObject = (value: JsonValue): value is JsonObject => {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
};

const isPositiveInteger = (value: JsonValue): value is number => {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
};

const isNonNegativeInteger = (value: JsonValue): value is number => {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
};

const isNonEmptyString = (value: JsonValue): value is string => {
  return typeof value === 'string' && value.trim().length > 0;
};

const isBattleResult = (
  value: JsonValue,
): value is IdleRealtimeUpdateEvent['result'] => {
  return value === 'attacker_win' || value === 'defender_win' || value === 'draw';
};

const toRewardItemEntry = (value: JsonValue): RewardItemEntry | null => {
  if (!isJsonObject(value)) {
    return null;
  }
  if (
    !isNonEmptyString(value.itemDefId)
    || !isNonEmptyString(value.itemName)
    || !isPositiveInteger(value.quantity)
  ) {
    return null;
  }

  return {
    itemDefId: value.itemDefId,
    itemName: value.itemName,
    quantity: value.quantity,
  };
};

const toRewardItemEntries = (value: JsonValue): RewardItemEntry[] | null => {
  if (!Array.isArray(value)) {
    return null;
  }

  const entries: RewardItemEntry[] = [];
  for (const item of value) {
    const entry = toRewardItemEntry(item);
    if (!entry) {
      return null;
    }
    entries.push(entry);
  }
  return entries;
};

const toIdleRealtimeEvent = (value: JsonValue): IdleRealtimeEvent | null => {
  if (!isJsonObject(value)) {
    return null;
  }

  if (value.type === 'update') {
    const itemsGained = toRewardItemEntries(value.itemsGained);
    if (
      !isPositiveInteger(value.userId)
      || !isNonEmptyString(value.sessionId)
      || !isPositiveInteger(value.batchIndex)
      || !isBattleResult(value.result)
      || !isNonNegativeInteger(value.expGained)
      || !isNonNegativeInteger(value.silverGained)
      || !itemsGained
      || !isPositiveInteger(value.roundCount)
    ) {
      return null;
    }

    return {
      type: 'update',
      userId: value.userId,
      sessionId: value.sessionId,
      batchIndex: value.batchIndex,
      result: value.result,
      expGained: value.expGained,
      silverGained: value.silverGained,
      itemsGained,
      roundCount: value.roundCount,
    };
  }

  if (value.type === 'finished') {
    if (
      !isPositiveInteger(value.userId)
      || !isNonEmptyString(value.sessionId)
      || !isNonEmptyString(value.reason)
    ) {
      return null;
    }

    return {
      type: 'finished',
      userId: value.userId,
      sessionId: value.sessionId,
      reason: value.reason,
    };
  }

  if (value.type === 'character_update') {
    if (!isPositiveInteger(value.userId)) {
      return null;
    }

    return {
      type: 'character_update',
      userId: value.userId,
    };
  }

  return null;
};

const parseIdleRealtimeEvent = (
  message: ConsumeMessage,
): IdleRealtimeEvent | null => {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(message.content.toString('utf8')) as JsonValue;
  } catch {
    return null;
  }

  return toIdleRealtimeEvent(parsed);
};

const describeRejectionReason = (
  reason: Error | string | number | boolean | null | undefined,
): string => {
  if (reason instanceof Error) {
    return reason.message;
  }
  return String(reason);
};

const assertIdleRealtimePublishTopology = async (
  channel: ConfirmChannel,
): Promise<void> => {
  await channel.assertExchange(IDLE_REALTIME_EXCHANGE, 'direct', {
    durable: true,
  });

  await channel.assertQueue(IDLE_REALTIME_DLQ, dlqOptions);
  await channel.bindQueue(
    IDLE_REALTIME_DLQ,
    IDLE_REALTIME_EXCHANGE,
    IDLE_REALTIME_DLQ_ROUTING_KEY,
  );
};

const assertIdleRealtimeConsumerTopology = async (
  channel: ConfirmChannel,
): Promise<string> => {
  await assertIdleRealtimePublishTopology(channel);
  const queueName = resolveEventQueueName();
  await channel.assertQueue(queueName, eventQueueOptions);
  await channel.bindQueue(
    queueName,
    IDLE_REALTIME_EXCHANGE,
    IDLE_REALTIME_EVENT_ROUTING_KEY,
  );
  return queueName;
};

const ensureIdleRealtimePublishTopology = async (
  channel: ConfirmChannel,
): Promise<void> => {
  if (publishTopologyReadyChannel === channel) {
    return;
  }

  let readyPromise = publishTopologyReadyPromise;
  if (!readyPromise || publishTopologyReadyPromiseChannel !== channel) {
    readyPromise = assertIdleRealtimePublishTopology(channel);
    publishTopologyReadyPromise = readyPromise;
    publishTopologyReadyPromiseChannel = channel;
  }

  try {
    await readyPromise;
    publishTopologyReadyChannel = channel;
  } finally {
    if (publishTopologyReadyPromise === readyPromise) {
      publishTopologyReadyPromise = null;
      publishTopologyReadyPromiseChannel = null;
    }
  }
};

const ensureIdleRealtimeConsumerTopology = async (
  channel: ConfirmChannel,
): Promise<string> => {
  if (consumerTopologyReadyChannel === channel) {
    return resolveEventQueueName();
  }

  let readyPromise = consumerTopologyReadyPromise;
  if (!readyPromise || consumerTopologyReadyPromiseChannel !== channel) {
    readyPromise = assertIdleRealtimeConsumerTopology(channel);
    consumerTopologyReadyPromise = readyPromise;
    consumerTopologyReadyPromiseChannel = channel;
  }

  try {
    const queueName = await readyPromise;
    consumerTopologyReadyChannel = channel;
    publishTopologyReadyChannel = channel;
    return queueName;
  } finally {
    if (consumerTopologyReadyPromise === readyPromise) {
      consumerTopologyReadyPromise = null;
      consumerTopologyReadyPromiseChannel = null;
    }
  }
};

export const publishIdleRealtimeEvent = async (
  event: IdleRealtimeEvent,
): Promise<void> => {
  const channel = await getRabbitMqConfirmChannel();
  await ensureIdleRealtimePublishTopology(channel);
  channel.publish(
    IDLE_REALTIME_EXCHANGE,
    IDLE_REALTIME_EVENT_ROUTING_KEY,
    Buffer.from(JSON.stringify(event)),
    {
      ...publishOptions,
      timestamp: Date.now(),
    },
  );
};

export const startIdleRealtimeEventConsumer = async (
  handler: IdleRealtimeEventHandler,
): Promise<() => Promise<void>> => {
  const channel = await getRabbitMqConfirmChannel();
  const queueName = await ensureIdleRealtimeConsumerTopology(channel);
  const prefetch = parsePrefetch();
  await channel.prefetch(prefetch);

  const consumeResult = await channel.consume(
    queueName,
    async (message) => {
      if (message === null) {
        return;
      }

      const event = parseIdleRealtimeEvent(message);
      if (!event) {
        logger.warn('挂机实时事件协议无效，已拒绝并交由 DLQ');
        channel.reject(message, false);
        return;
      }

      await Promise.resolve(handler(event)).then(
        () => {
          channel.ack(message);
        },
        (error: Error | string | number | boolean | null | undefined) => {
          logger.error(
            {
              err: error instanceof Error ? error : undefined,
              reason: describeRejectionReason(error),
              eventType: event.type,
            },
            '挂机实时事件处理失败，已拒绝并交由 DLQ',
          );
          channel.reject(message, false);
        },
      );
    },
  );

  logger.info(
    {
      consumerTag: consumeResult.consumerTag,
      queueName,
      prefetch,
    },
    '挂机实时事件 RabbitMQ 消费者已启动',
  );

  return async (): Promise<void> => {
    await channel.cancel(consumeResult.consumerTag);
    logger.info(
      {
        consumerTag: consumeResult.consumerTag,
        queueName,
      },
      '挂机实时事件 RabbitMQ 消费者已停止',
    );
  };
};
