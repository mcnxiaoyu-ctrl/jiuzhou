/**
 * 坊市自动下架 RabbitMQ 队列协议
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中声明物品坊市自动下架的 RabbitMQ exchange、delay queue、到期消费队列、DLQ 与消息结构。
 * 2. 做什么：提供发布 72 小时延迟消息与启动到期消费者的基础能力，保证拓扑、routing key 和消息协议只有一个入口。
 * 3. 不做什么：不调用 marketService，不判断挂单是否仍 active，也不执行取消、返还或发信等业务动作。
 *
 * 输入 / 输出：
 * - 输入：发布侧传入 listingId、listedAt 与可选剩余延迟；消费侧传入 handler；运行环境传入启停开关与 prefetch。
 * - 输出：RabbitMQ 中持久化的 JSON 消息，以及消费者 stop 函数。
 *
 * 数据流 / 状态流：
 * create listing / startup reconcile -> publishMarketListingAutoCancelMessage -> delay queue 静态 TTL 或消息级剩余 TTL 到期 ->
 * DLX 投递到 due queue -> startMarketListingAutoCancelConsumer 解析并校验协议 -> handler 执行业务取消 ->
 * 成功 ack；失败 reject(false) 后交给 RabbitMQ DLQ。
 *
 * 复用设计说明：
 * 1. RabbitMQ 拓扑、TTL、DLX 与消息协议是自动下架链路的高频变化点，集中在本模块可避免发布侧、消费侧和启动入口重复声明队列名与参数。
 * 2. 本模块只暴露消息级接口，业务取消逻辑留给 service 集成任务复用现有 marketService 入口，避免基础设施层反向依赖业务服务。
 *
 * 关键边界条件与坑点：
 * 1. delay queue 必须使用 `x-message-ttl` 与 DLX，而不是后台扫描，否则不能按挂单创建时间精确调度。
 * 2. due queue 也必须配置 DLX；handler 抛错时只 reject(false)，由 RabbitMQ 负责把失败消息送入 DLQ，避免业务层重复搬运。
 * 3. 历史挂单补偿会传入剩余 delayMs，必须用消息级 expiration，不能把历史挂单重新延迟完整 72 小时。
 */
import type { ConfirmChannel, ConsumeMessage, Options } from 'amqplib';
import { createScopedLogger } from '../../utils/logger.js';
import { MARKET_LISTING_AUTO_CANCEL_AFTER_HOURS } from './marketListingRules.js';
import { getRabbitMqConfirmChannel } from './rabbitMqConnection.js';

export const MARKET_LISTING_AUTO_CANCEL_EXCHANGE = 'jiuzhou.market_listing_auto_cancel';
export const MARKET_LISTING_AUTO_CANCEL_DELAY_QUEUE =
  'jiuzhou.market_listing_auto_cancel.delay';
export const MARKET_LISTING_AUTO_CANCEL_DUE_QUEUE =
  'jiuzhou.market_listing_auto_cancel.due';
export const MARKET_LISTING_AUTO_CANCEL_DLQ = 'jiuzhou.market_listing_auto_cancel.dlq';

export const MARKET_LISTING_AUTO_CANCEL_DELAY_ROUTING_KEY =
  'market_listing_auto_cancel.delay';
export const MARKET_LISTING_AUTO_CANCEL_DUE_ROUTING_KEY =
  'market_listing_auto_cancel.due';
export const MARKET_LISTING_AUTO_CANCEL_DLQ_ROUTING_KEY =
  'market_listing_auto_cancel.dlq';

const MARKET_LISTING_AUTO_CANCEL_AFTER_MS =
  MARKET_LISTING_AUTO_CANCEL_AFTER_HOURS * 60 * 60 * 1000;
const DEFAULT_MARKET_LISTING_AUTO_CANCEL_PREFETCH = 8;

const logger = createScopedLogger('market.listing.autoCancelQueue');

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
type JsonObject = {
  readonly [key: string]: JsonValue;
};

export type MarketListingAutoCancelMessage = {
  listingId: number;
  listedAt: string;
};

export type MarketListingAutoCancelPublishInput = {
  listingId: number;
  listedAt: Date | string;
  delayMs?: number;
};

export type MarketListingAutoCancelHandler = (
  message: MarketListingAutoCancelMessage,
) => Promise<void> | void;

let topologyReadyChannel: ConfirmChannel | null = null;
let topologyReadyPromise: Promise<void> | null = null;
let topologyReadyPromiseChannel: ConfirmChannel | null = null;

const assertQueueOptions = {
  durable: true,
} satisfies Options.AssertQueue;

const delayQueueOptions = {
  durable: true,
  arguments: {
    'x-dead-letter-exchange': MARKET_LISTING_AUTO_CANCEL_EXCHANGE,
    'x-dead-letter-routing-key': MARKET_LISTING_AUTO_CANCEL_DUE_ROUTING_KEY,
    'x-message-ttl': MARKET_LISTING_AUTO_CANCEL_AFTER_MS,
  },
} satisfies Options.AssertQueue;

const dueQueueOptions = {
  durable: true,
  arguments: {
    'x-dead-letter-exchange': MARKET_LISTING_AUTO_CANCEL_EXCHANGE,
    'x-dead-letter-routing-key': MARKET_LISTING_AUTO_CANCEL_DLQ_ROUTING_KEY,
  },
} satisfies Options.AssertQueue;

const publishOptions = {
  persistent: true,
  contentType: 'application/json',
} satisfies Options.Publish;

const normalizeListedAt = (listedAt: Date | string): string => {
  if (listedAt instanceof Date) {
    return listedAt.toISOString();
  }
  return listedAt;
};

const normalizeDelayMs = (delayMs: number | undefined): number | undefined => {
  if (delayMs === undefined) {
    return undefined;
  }
  if (!Number.isInteger(delayMs) || delayMs <= 0 || delayMs > MARKET_LISTING_AUTO_CANCEL_AFTER_MS) {
    throw new Error('坊市自动下架消息 delayMs 必须是 1 到 72 小时之间的整数毫秒');
  }
  return delayMs;
};

const parsePrefetch = (): number => {
  const rawValue = process.env.MARKET_LISTING_AUTO_CANCEL_PREFETCH?.trim();
  if (!rawValue) {
    return DEFAULT_MARKET_LISTING_AUTO_CANCEL_PREFETCH;
  }

  const value = Number(rawValue);
  if (!Number.isInteger(value) || value <= 0) {
    return DEFAULT_MARKET_LISTING_AUTO_CANCEL_PREFETCH;
  }

  return value;
};

const describeRejectionReason = (reason: {} | null | undefined): string => {
  if (reason instanceof Error) {
    return reason.message;
  }
  return String(reason);
};

export const isMarketListingAutoCancelQueueEnabled = (): boolean => {
  return process.env.MARKET_LISTING_AUTO_CANCEL_QUEUE_ENABLED?.trim().toLowerCase()
    !== 'false';
};

const isJsonObject = (value: JsonValue): value is JsonObject => {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
};

const isMarketListingAutoCancelMessage = (
  value: JsonValue,
): value is MarketListingAutoCancelMessage => {
  if (!isJsonObject(value)) {
    return false;
  }

  const listingId = value.listingId;
  const listedAt = value.listedAt;
  return typeof listingId === 'number'
    && Number.isInteger(listingId)
    && listingId > 0
    && typeof listedAt === 'string';
};

const parseMarketListingAutoCancelMessage = (
  message: ConsumeMessage,
): MarketListingAutoCancelMessage | null => {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(message.content.toString('utf8')) as JsonValue;
  } catch {
    return null;
  }

  if (!isMarketListingAutoCancelMessage(parsed)) {
    return null;
  }

  return parsed;
};

const assertMarketListingAutoCancelTopology = async (
  channel: ConfirmChannel,
): Promise<void> => {
  await channel.assertExchange(MARKET_LISTING_AUTO_CANCEL_EXCHANGE, 'direct', {
    durable: true,
  });

  await channel.assertQueue(MARKET_LISTING_AUTO_CANCEL_DELAY_QUEUE, delayQueueOptions);
  await channel.bindQueue(
    MARKET_LISTING_AUTO_CANCEL_DELAY_QUEUE,
    MARKET_LISTING_AUTO_CANCEL_EXCHANGE,
    MARKET_LISTING_AUTO_CANCEL_DELAY_ROUTING_KEY,
  );

  await channel.assertQueue(MARKET_LISTING_AUTO_CANCEL_DUE_QUEUE, dueQueueOptions);
  await channel.bindQueue(
    MARKET_LISTING_AUTO_CANCEL_DUE_QUEUE,
    MARKET_LISTING_AUTO_CANCEL_EXCHANGE,
    MARKET_LISTING_AUTO_CANCEL_DUE_ROUTING_KEY,
  );

  await channel.assertQueue(MARKET_LISTING_AUTO_CANCEL_DLQ, assertQueueOptions);
  await channel.bindQueue(
    MARKET_LISTING_AUTO_CANCEL_DLQ,
    MARKET_LISTING_AUTO_CANCEL_EXCHANGE,
    MARKET_LISTING_AUTO_CANCEL_DLQ_ROUTING_KEY,
  );
};

const ensureMarketListingAutoCancelTopology = async (
  channel: ConfirmChannel,
): Promise<void> => {
  if (topologyReadyChannel === channel) {
    return;
  }

  let readyPromise = topologyReadyPromise;
  if (!readyPromise || topologyReadyPromiseChannel !== channel) {
    readyPromise = assertMarketListingAutoCancelTopology(channel);
    topologyReadyPromise = readyPromise;
    topologyReadyPromiseChannel = channel;
  }

  try {
    await readyPromise;
    topologyReadyChannel = channel;
  } finally {
    if (topologyReadyPromise === readyPromise) {
      topologyReadyPromise = null;
      topologyReadyPromiseChannel = null;
    }
  }
};

export const publishMarketListingAutoCancelMessage = async (
  input: MarketListingAutoCancelPublishInput,
): Promise<void> => {
  if (!Number.isInteger(input.listingId) || input.listingId <= 0) {
    throw new Error('坊市自动下架消息 listingId 必须是正整数');
  }

  const message: MarketListingAutoCancelMessage = {
    listingId: input.listingId,
    listedAt: normalizeListedAt(input.listedAt),
  };
  const delayMs = normalizeDelayMs(input.delayMs);
  const channel = await getRabbitMqConfirmChannel();
  await ensureMarketListingAutoCancelTopology(channel);
  const options: Options.Publish = delayMs === undefined
    ? {
      ...publishOptions,
      timestamp: Date.now(),
    }
    : {
      ...publishOptions,
      expiration: String(delayMs),
      timestamp: Date.now(),
    };

  channel.publish(
    MARKET_LISTING_AUTO_CANCEL_EXCHANGE,
    MARKET_LISTING_AUTO_CANCEL_DELAY_ROUTING_KEY,
    Buffer.from(JSON.stringify(message)),
    options,
  );
  await channel.waitForConfirms();
};

export const startMarketListingAutoCancelConsumer = async (
  handler: MarketListingAutoCancelHandler,
): Promise<() => Promise<void>> => {
  if (!isMarketListingAutoCancelQueueEnabled()) {
    logger.info('坊市自动下架 RabbitMQ 消费者已按配置跳过启动');
    return async () => {};
  }

  const channel = await getRabbitMqConfirmChannel();
  await ensureMarketListingAutoCancelTopology(channel);
  const prefetch = parsePrefetch();
  await channel.prefetch(prefetch);

  const consumeResult = await channel.consume(
    MARKET_LISTING_AUTO_CANCEL_DUE_QUEUE,
    async (message) => {
      if (message === null) {
        return;
      }

      const payload = parseMarketListingAutoCancelMessage(message);
      if (!payload) {
        logger.warn('坊市自动下架消息协议无效，已拒绝并交由 DLQ');
        channel.reject(message, false);
        return;
      }

      await Promise.resolve(handler(payload)).then(
        () => {
          channel.ack(message);
        },
        (error) => {
          logger.error(
            {
              err: error instanceof Error ? error : undefined,
              reason: describeRejectionReason(error),
              listingId: payload.listingId,
            },
            '坊市自动下架消息处理失败，已拒绝并交由 DLQ',
          );
          channel.reject(message, false);
        },
      );
    },
  );

  logger.info(
    {
      consumerTag: consumeResult.consumerTag,
      prefetch,
    },
    '坊市自动下架 RabbitMQ 消费者已启动',
  );

  return async (): Promise<void> => {
    await channel.cancel(consumeResult.consumerTag);
    logger.info(
      {
        consumerTag: consumeResult.consumerTag,
      },
      '坊市自动下架 RabbitMQ 消费者已停止',
    );
  };
};
