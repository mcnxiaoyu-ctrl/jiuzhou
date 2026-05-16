/**
 * 物品坊市自动下架启动补偿策略静态测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定 worker 启动时必须补偿历史 active 挂单，避免部署前已上架数据没有 RabbitMQ 延迟消息。
 * 2. 做什么：锁定补偿只能是启动时一次性 reconcile，不能重新变成 cleanupWorker 常驻扫描。
 * 3. 不做什么：不连接数据库，不连接 RabbitMQ，不执行真实补偿。
 *
 * 输入/输出：
 * - 输入：队列模块、启动补偿服务、worker 入口和 cleanupWorker 源码文本。
 * - 输出：node:test 静态断言。
 *
 * 数据流/状态流：
 * 源码文本 -> 匹配 advisory lock、keyset 批量读取、过期立即取消、未过期补发 delayMs 消息、worker 启动顺序。
 *
 * 复用设计说明：
 * - 历史挂单补偿与实时消费的架构边界集中在本测试，避免后续维护时把补偿逻辑重新塞回 cleanupWorker。
 * - 队列剩余延迟能力由同一 RabbitMQ publish 入口复用，避免启动补偿另写一套发布协议。
 *
 * 关键边界条件与坑点：
 * 1. 静态测试不能证明真实 broker TTL 生效，只能保护代码结构和启动顺序。
 * 2. 如果补偿服务重命名，必须同步更新本测试，避免误删启动补偿入口。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readSource = (relativePath: string): string => {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
};

test('RabbitMQ 发布入口应支持历史挂单剩余延迟', () => {
  const source = readSource('../shared/marketListingAutoCancelQueue.ts');

  assert.match(source, /delayMs\?: number/u);
  assert.match(source, /expiration: String\(delayMs\)/u);
});

test('启动补偿应批量补偿 active 历史挂单且不使用常驻定时器', () => {
  const source = readSource('../marketListingAutoCancelReconcileService.ts');

  assert.match(source, /withSessionAdvisoryLock/u);
  assert.match(source, /FROM market_listing/u);
  assert.match(source, /WHERE status = 'active'/u);
  assert.match(source, /listed_at <= \$3::timestamptz/u);
  assert.match(source, /ORDER BY listed_at ASC, id ASC/u);
  assert.match(source, /LIMIT \$4/u);
  assert.match(source, /marketService\.cancelExpiredMarketListing/u);
  assert.match(source, /publishMarketListingAutoCancelMessage/u);
  assert.match(source, /delayMs/u);
  assert.match(source, /resolveStartupReconcileDelayMs/u);
  assert.match(source, /Math\.min\(MARKET_LISTING_AUTO_CANCEL_AFTER_MS,\s*Math\.max\(1,\s*remainingMs\)\)/u);
  assert.doesNotMatch(source, /setInterval/u);
});

test('worker 启动时应先执行补偿再启动消费者，cleanupWorker 不得接入补偿', () => {
  const workerSource = readSource('../../workers/marketListingAutoCancelWorker.ts');
  const cleanupWorkerSource = readSource('../../workers/cleanupWorker.ts');

  assert.match(
    workerSource,
    /runStartupReconcileOnce[\s\S]*?marketListingAutoCancelService\.startConsumer/u,
  );
  assert.doesNotMatch(cleanupWorkerSource, /marketListingAutoCancelReconcileService/u);
  assert.doesNotMatch(cleanupWorkerSource, /runStartupReconcileOnce/u);
});
