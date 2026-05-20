/**
 * 挂机执行 RabbitMQ 命令队列
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中声明挂机执行 start/stop 命令的 RabbitMQ exchange、commands queue、DLQ 与消息协议。
 * 2. 做什么：提供 confirm publish 和单消费者入口，让 API 进程只投递命令，worker 进程承接执行循环。
 * 3. 不做什么：不启动挂机战斗，不查询 idle_sessions，不修改会话状态，也不处理 Socket 推送。
 *
 * 输入 / 输出：
 * - 输入：API 侧传入 sessionId、characterId、userId 或 sessionId；worker 侧传入命令 handler。
 * - 输出：持久化 RabbitMQ 消息；消费者 stop 函数用于启动流水线优雅关闭。
 *
 * 数据流 / 状态流：
 * idleRoutes -> publishIdleExecutionStartCommand / publishIdleExecutionStopCommand ->
 * commands queue -> startIdleExecutionConsumer -> idleExecutionWorker handler ->
 * 成功 ack；异常 reject(false) 进入 DLQ。
 *
 * 复用设计说明：
 * - 队列名、routing key、消息结构和 ack/reject 规则是跨进程拆分的公共契约，集中在本模块避免 API、worker、测试各写一套。
 * - confirm publish 作为唯一发布入口，后续新增挂机命令只需扩展这里的协议，不需要散改 RabbitMQ 拓扑。
 *
 * 关键边界条件与坑点：
 * 1. 发布必须等待 `waitForConfirms`，否则 API 可能返回成功但 worker 永远收不到启动命令。
 * 2. 协议非法消息必须 reject(false) 进入 DLQ，不能 ack 掉导致问题不可见。
 * 3. stop 命令可能早于 worker 本地恢复完成，consumer handler 必须保持幂等，队列层不做业务兜底。
 */
import type { ConfirmChannel, ConsumeMessage, Options } from 'amqplib';
import { createScopedLogger } from '../../utils/logger.js';
import { getRabbitMqConfirmChannel } from '../shared/rabbitMqConnection.js';

export const IDLE_EXECUTION_EXCHANGE = 'jiuzhou.idle_execution';
export const IDLE_EXECUTION_COMMAND_QUEUE = 'jiuzhou.idle_execution.commands';
export const IDLE_EXECUTION_DLQ = 'jiuzhou.idle_execution.dlq';

export const IDLE_EXECUTION_COMMAND_ROUTING_KEY = 'idle_execution.command';
export const IDLE_EXECUTION_DLQ_ROUTING_KEY = 'idle_execution.dlq';

const DEFAULT_IDLE_EXECUTION_PREFETCH = 64;

const logger = createScopedLogger('idle.execution.queue');

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
type JsonObject = {
  readonly [key: string]: JsonValue;
};

export type IdleExecutionStartCommand = {
  type: 'start';
  sessionId: string;
  characterId: number;
  userId: number;
};

export type IdleExecutionStopCommand = {
  type: 'stop';
  sessionId: string;
};

export type IdleExecutionCommand =
  | IdleExecutionStartCommand
  | IdleExecutionStopCommand;

export type IdleExecutionCommandHandler = (
  command: IdleExecutionCommand,
) => Promise<void> | void;

let topologyReadyChannel: ConfirmChannel | null = null;
let topologyReadyPromise: Promise<void> | null = null;
let topologyReadyPromiseChannel: ConfirmChannel | null = null;

const commandQueueOptions = {
  durable: true,
  arguments: {
    'x-dead-letter-exchange': IDLE_EXECUTION_EXCHANGE,
    'x-dead-letter-routing-key': IDLE_EXECUTION_DLQ_ROUTING_KEY,
  },
} satisfies Options.AssertQueue;

const dlqOptions = {
  durable: true,
} satisfies Options.AssertQueue;

const publishOptions = {
  persistent: true,
  contentType: 'application/json',
} satisfies Options.Publish;

const parsePrefetch = (): number => {
  const rawValue = process.env.IDLE_EXECUTION_COMMAND_PREFETCH?.trim();
  if (!rawValue) {
    return DEFAULT_IDLE_EXECUTION_PREFETCH;
  }

  const value = Number(rawValue);
  if (!Number.isInteger(value) || value <= 0) {
    return DEFAULT_IDLE_EXECUTION_PREFETCH;
  }
  return value;
};

const isJsonObject = (value: JsonValue): value is JsonObject => {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
};

const isPositiveInteger = (value: JsonValue): value is number => {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
};

const isNonEmptyString = (value: JsonValue): value is string => {
  return typeof value === 'string' && value.trim().length > 0;
};

const isIdleExecutionCommand = (
  value: JsonValue,
): value is IdleExecutionCommand => {
  if (!isJsonObject(value)) {
    return false;
  }

  if (value.type === 'start') {
    return isNonEmptyString(value.sessionId)
      && isPositiveInteger(value.characterId)
      && isPositiveInteger(value.userId);
  }

  if (value.type === 'stop') {
    return isNonEmptyString(value.sessionId);
  }

  return false;
};

const parseIdleExecutionCommand = (
  message: ConsumeMessage,
): IdleExecutionCommand | null => {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(message.content.toString('utf8')) as JsonValue;
  } catch {
    return null;
  }

  if (!isIdleExecutionCommand(parsed)) {
    return null;
  }

  return parsed;
};

const describeRejectionReason = (
  reason: Error | string | number | boolean | null | undefined,
): string => {
  if (reason instanceof Error) {
    return reason.message;
  }
  return String(reason);
};

const assertIdleExecutionTopology = async (
  channel: ConfirmChannel,
): Promise<void> => {
  await channel.assertExchange(IDLE_EXECUTION_EXCHANGE, 'direct', {
    durable: true,
  });

  await channel.assertQueue(IDLE_EXECUTION_COMMAND_QUEUE, commandQueueOptions);
  await channel.bindQueue(
    IDLE_EXECUTION_COMMAND_QUEUE,
    IDLE_EXECUTION_EXCHANGE,
    IDLE_EXECUTION_COMMAND_ROUTING_KEY,
  );

  await channel.assertQueue(IDLE_EXECUTION_DLQ, dlqOptions);
  await channel.bindQueue(
    IDLE_EXECUTION_DLQ,
    IDLE_EXECUTION_EXCHANGE,
    IDLE_EXECUTION_DLQ_ROUTING_KEY,
  );
};

const ensureIdleExecutionTopology = async (
  channel: ConfirmChannel,
): Promise<void> => {
  if (topologyReadyChannel === channel) {
    return;
  }

  let readyPromise = topologyReadyPromise;
  if (!readyPromise || topologyReadyPromiseChannel !== channel) {
    readyPromise = assertIdleExecutionTopology(channel);
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

const publishIdleExecutionCommand = async (
  command: IdleExecutionCommand,
): Promise<void> => {
  const channel = await getRabbitMqConfirmChannel();
  await ensureIdleExecutionTopology(channel);
  channel.publish(
    IDLE_EXECUTION_EXCHANGE,
    IDLE_EXECUTION_COMMAND_ROUTING_KEY,
    Buffer.from(JSON.stringify(command)),
    {
      ...publishOptions,
      timestamp: Date.now(),
    },
  );
  await channel.waitForConfirms();
};

export const publishIdleExecutionStartCommand = async (
  command: Omit<IdleExecutionStartCommand, 'type'>,
): Promise<void> => {
  await publishIdleExecutionCommand({
    type: 'start',
    sessionId: command.sessionId,
    characterId: command.characterId,
    userId: command.userId,
  });
};

export const publishIdleExecutionStopCommand = async (
  command: Omit<IdleExecutionStopCommand, 'type'>,
): Promise<void> => {
  await publishIdleExecutionCommand({
    type: 'stop',
    sessionId: command.sessionId,
  });
};

export const startIdleExecutionConsumer = async (
  handler: IdleExecutionCommandHandler,
): Promise<() => Promise<void>> => {
  const channel = await getRabbitMqConfirmChannel();
  await ensureIdleExecutionTopology(channel);
  const prefetch = parsePrefetch();
  await channel.prefetch(prefetch);

  const consumeResult = await channel.consume(
    IDLE_EXECUTION_COMMAND_QUEUE,
    async (message) => {
      if (message === null) {
        return;
      }

      const command = parseIdleExecutionCommand(message);
      if (!command) {
        logger.warn('挂机执行命令协议无效，已拒绝并交由 DLQ');
        channel.reject(message, false);
        return;
      }

      await Promise.resolve(handler(command)).then(
        () => {
          channel.ack(message);
        },
        (error) => {
          logger.error(
            {
              err: error instanceof Error ? error : undefined,
              reason: describeRejectionReason(
                error instanceof Error ? error : String(error),
              ),
              commandType: command.type,
              sessionId: command.sessionId,
            },
            '挂机执行命令处理失败，已拒绝并交由 DLQ',
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
    '挂机执行 RabbitMQ 消费者已启动',
  );

  return async (): Promise<void> => {
    await channel.cancel(consumeResult.consumerTag);
    logger.info(
      {
        consumerTag: consumeResult.consumerTag,
      },
      '挂机执行 RabbitMQ 消费者已停止',
    );
  };
};
