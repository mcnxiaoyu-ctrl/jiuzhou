/**
 * RabbitMQ 连接共享封装
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中创建并缓存 RabbitMQ connection 与 ConfirmChannel，供发布确认、延迟队列和后台消费者复用同一套连接生命周期。
 * 2. 做什么：监听 connection/channel 的 close 与 error 事件，失效后清空缓存，让下一次调用按需重连。
 * 3. 不做什么：不做 DB/Redis 降级，不声明业务队列拓扑，也不吞掉缺失配置或连接失败。
 *
 * 输入 / 输出：
 * - 输入：`process.env.RABBITMQ_URL`，由部署环境提供 RabbitMQ 连接串。
 * - 输出：`getRabbitMqConfirmChannel()` 返回可发布确认的 ConfirmChannel；`closeRabbitMqConnection()` 主动关闭当前缓存连接。
 *
 * 数据流 / 状态流：
 * 调用方请求 ConfirmChannel -> 本模块读取 RABBITMQ_URL -> 创建 connection -> 创建 ConfirmChannel ->
 * 缓存给后续调用复用 -> RabbitMQ close/error 事件触发后清空对应缓存 -> 下次调用重新创建。
 *
 * 复用设计说明：
 * 1. RabbitMQ 连接属于进程级基础设施，集中在这里可避免每个队列模块各自建立连接、重复监听和重复处理重连状态。
 * 2. ConfirmChannel 是发布可靠性的共同入口，后续新增延迟任务或可靠投递场景只需复用本模块，不需要复制连接代码。
 *
 * 关键边界条件与坑点：
 * 1. `RABBITMQ_URL` 未配置时必须立即抛错，避免自动下架任务静默退回到扫描或其他存储。
 * 2. close/error 事件可能来自旧连接；清理缓存时必须确认对象仍是当前缓存，避免误清新连接。
 */
import { connect, type ChannelModel, type ConfirmChannel } from 'amqplib';
import { createScopedLogger } from '../../utils/logger.js';

const logger = createScopedLogger('rabbitmq.connection');

let cachedConnection: ChannelModel | null = null;
let cachedConfirmChannel: ConfirmChannel | null = null;
let openingConfirmChannel: Promise<ConfirmChannel> | null = null;

const readRabbitMqUrl = (): string => {
  const url = process.env.RABBITMQ_URL?.trim();
  if (!url) {
    throw new Error('RabbitMQ 连接串未配置：缺少 RABBITMQ_URL');
  }
  return url;
};

const clearConnectionCache = (connection: ChannelModel): void => {
  if (cachedConnection !== connection) {
    return;
  }

  cachedConnection = null;
  cachedConfirmChannel = null;
};

const clearChannelCache = (channel: ConfirmChannel): void => {
  if (cachedConfirmChannel !== channel) {
    return;
  }

  cachedConfirmChannel = null;
};

const bindConnectionEvents = (connection: ChannelModel): void => {
  connection.on('close', () => {
    logger.warn('RabbitMQ 连接已关闭，已清空连接缓存');
    clearConnectionCache(connection);
  });

  connection.on('error', (error: Error) => {
    logger.error(error, 'RabbitMQ 连接异常，已清空连接缓存');
    clearConnectionCache(connection);
  });
};

const bindChannelEvents = (channel: ConfirmChannel): void => {
  channel.on('close', () => {
    logger.warn('RabbitMQ ConfirmChannel 已关闭，已清空 channel 缓存');
    clearChannelCache(channel);
  });

  channel.on('error', (error: Error) => {
    logger.error(error, 'RabbitMQ ConfirmChannel 异常，已清空 channel 缓存');
    clearChannelCache(channel);
  });
};

const getRabbitMqConnection = async (): Promise<ChannelModel> => {
  if (cachedConnection) {
    return cachedConnection;
  }

  const connection = await connect(readRabbitMqUrl());
  cachedConnection = connection;
  bindConnectionEvents(connection);
  logger.info('RabbitMQ 连接已建立');
  return connection;
};

const openRabbitMqConfirmChannel = async (): Promise<ConfirmChannel> => {
  const connection = await getRabbitMqConnection();
  const channel = await connection.createConfirmChannel();
  cachedConfirmChannel = channel;
  bindChannelEvents(channel);
  logger.info('RabbitMQ ConfirmChannel 已建立');
  return channel;
};

export const getRabbitMqConfirmChannel = async (): Promise<ConfirmChannel> => {
  if (cachedConfirmChannel) {
    return cachedConfirmChannel;
  }

  if (!openingConfirmChannel) {
    openingConfirmChannel = openRabbitMqConfirmChannel();
  }

  try {
    return await openingConfirmChannel;
  } finally {
    openingConfirmChannel = null;
  }
};

export const closeRabbitMqConnection = async (): Promise<void> => {
  const channel = cachedConfirmChannel;
  const connection = cachedConnection;
  cachedConfirmChannel = null;
  cachedConnection = null;
  openingConfirmChannel = null;

  const closeTasks: Array<Promise<void>> = [];
  if (channel) {
    closeTasks.push(channel.close());
  }
  if (connection) {
    closeTasks.push(connection.close());
  }

  await Promise.allSettled(closeTasks);
  logger.info('RabbitMQ 连接关闭流程已完成');
};
