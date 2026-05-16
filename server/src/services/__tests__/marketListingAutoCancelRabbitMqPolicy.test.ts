/**
 * 物品坊市 RabbitMQ 自动下架策略静态测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定自动下架必须使用 RabbitMQ 延迟队列和 DLQ，而不是 DB 扫描或数据库死信表。
 * 2. 做什么：锁定上架事务内发布延迟消息，避免 RabbitMQ 发布失败后仍留下不会自动下架的挂单。
 * 3. 不做什么：不连接 RabbitMQ，不执行真实消费，不验证 broker 运维配置。
 *
 * 输入/输出：
 * - 输入：队列模块、坊市服务、消费服务、worker 入口、启动管线源码文本。
 * - 输出：node:test 静态断言。
 *
 * 数据流/状态流：
 * 源码文本 -> 匹配 RabbitMQ 拓扑、发布时机、消费结果判定和启动入口 -> 断言主路径实时队列化。
 *
 * 复用设计说明：
 * - 把“不能退回 DB 扫描”的架构规则集中在一个测试文件，避免后续清理任务改动时重新引入轮询主路径。
 * - 发布、消费、worker 启动和 shutdown 分开断言，便于后续重构时精确定位破坏点。
 *
 * 关键边界条件与坑点：
 * 1. 静态测试不能证明 RabbitMQ broker 已安装，只能保护代码结构。
 * 2. 若队列名或启动函数重命名，必须同步更新本测试。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readSource = (relativePath: string): string => {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
};

const sliceBetweenRequiredTokens = (
  source: string,
  startToken: string,
  endToken: string,
): string => {
  const startIndex = source.indexOf(startToken);
  const endIndex = source.indexOf(endToken, startIndex);
  assert.notEqual(startIndex, -1, `源码应包含 ${startToken}`);
  assert.notEqual(endIndex, -1, `源码应包含 ${endToken}`);
  return source.slice(startIndex, endIndex);
};

test('RabbitMQ 拓扑应包含延迟队列、到期队列和 DLQ', () => {
  const source = readSource('../shared/marketListingAutoCancelQueue.ts');

  assert.match(source, /MARKET_LISTING_AUTO_CANCEL_EXCHANGE/u);
  assert.match(source, /MARKET_LISTING_AUTO_CANCEL_DELAY_QUEUE/u);
  assert.match(source, /MARKET_LISTING_AUTO_CANCEL_DUE_QUEUE/u);
  assert.match(source, /MARKET_LISTING_AUTO_CANCEL_DLQ/u);
  assert.match(source, /'x-dead-letter-exchange'/u);
  assert.match(source, /'x-message-ttl': MARKET_LISTING_AUTO_CANCEL_AFTER_MS/u);
  assert.match(source, /waitForConfirms/u);
  assert.match(source, /channel\.reject\(message, false\)/u);
});

test('物品上架事务内必须发布自动下架延迟消息', () => {
  const source = readSource('../marketService.ts');

  assert.match(source, /publishMarketListingAutoCancelMessage/u);
  assert.match(
    source,
    /RETURNING id, listed_at[\s\S]*?const listingId = Number\(listingRow\.id\);[\s\S]*?await publishMarketListingAutoCancelMessage/u,
  );
  const createListingBeforePublish = sliceBetweenRequiredTokens(
    source,
    'async createMarketListing',
    'await publishMarketListingAutoCancelMessage',
  );
  assert.doesNotMatch(createListingBeforePublish, /afterTransactionCommit/u);
});

test('自动下架消费者不应扫描 DB，应复用队列 ack/reject 与坊市取消入口', () => {
  const source = readSource('../marketListingAutoCancelService.ts');

  assert.match(source, /startConsumer/u);
  assert.match(source, /startMarketListingAutoCancelConsumer/u);
  assert.match(source, /marketService\.cancelExpiredMarketListing/u);
  assert.match(source, /scheduleSafeCharacterUpdate/u);
  assert.match(source, /IDEMPOTENT_SUCCESS_MESSAGES/u);
  assert.doesNotMatch(source, /SELECT[\s\S]*FROM market_listing[\s\S]*listed_at/u);
  assert.doesNotMatch(source, /listed_at\s+<=/u);
});

test('自动下架消费者只能通过 worker 启动管线接入', () => {
  const startupSource = readSource('../../bootstrap/startupPipeline.ts');
  const cleanupWorkerSource = readSource('../../workers/cleanupWorker.ts');
  const workerSource = readSource('../../workers/marketListingAutoCancelWorker.ts');

  assert.match(workerSource, /startMarketListingAutoCancelWorker/u);
  assert.match(workerSource, /stopMarketListingAutoCancelWorker/u);
  assert.match(startupSource, /if \(shouldStartScheduledBackgroundServices\(runtimeRole\)\)/u);
  assert.match(startupSource, /startMarketListingAutoCancelWorker/u);
  assert.match(startupSource, /stopMarketListingAutoCancelWorker/u);
  assert.match(startupSource, /closeRabbitMqConnection/u);
  assert.doesNotMatch(cleanupWorkerSource, /marketListingAutoCancelService/u);
  assert.doesNotMatch(cleanupWorkerSource, /market-listing-auto-cancel/u);
});
