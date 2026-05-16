/**
 * 物品坊市上架规则静态测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定每日 100 次上架、同时 30 个 active 挂单、72 小时自动下架的服务层接入位置。
 * 2. 做什么：确保自动下架通过 RabbitMQ 延迟队列调度，复用 `marketService` 的取消入口，并移出 cleanup worker 扫描链路。
 * 3. 不做什么：不连接数据库，不执行真实上架/购买/清理流程。
 *
 * 输入/输出：
 * - 输入：规则模块、物品坊市服务、RabbitMQ 队列配置、自动下架服务、cleanup worker 与启动流水线源码文本。
 * - 输出：node:test 静态断言。
 *
 * 数据流/状态流：
 * 源码文件 -> 正则匹配规则常量与关键调用顺序 -> 断言规则没有散落或绕过共享入口。
 *
 * 复用设计说明：
 * - 把坊市规则和自动下架架构约束集中到单一测试，避免后续改列表、购买或队列调度时遗漏同一组上架规则。
 * - 静态测试覆盖 RabbitMQ 调度、启动入口和请求热路径三侧，比在多个路由测试里重复断言更轻。
 *
 * 关键边界条件与坑点：
 * 1. 这里只保护规则接入和复用边界，不能替代数据库并发验证。
 * 2. RabbitMQ 相关断言依赖队列常量与启动函数名稳定；若重命名调度入口，需要同步更新本测试。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readSource = (relativePath: string): string => {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
};

test('物品坊市上架规则常量集中在 marketListingRules', () => {
  const source = readSource('../shared/marketListingRules.ts');

  assert.match(source, /MARKET_LISTING_DAILY_CREATE_LIMIT = 100/u);
  assert.match(source, /MARKET_LISTING_ACTIVE_LIMIT = 30/u);
  assert.match(source, /MARKET_LISTING_AUTO_CANCEL_AFTER_HOURS = 72/u);
  assert.match(source, /buildMarketListingAutoCancelCutoff/u);
  assert.match(source, /isMarketListingExpired/u);
});

test('物品上架链路应在角色互斥锁后统一校验每日与同时上架上限', () => {
  const source = readSource('../marketService.ts');

  assert.match(
    source,
    /await lockCharacterInventoryMutex\(params\.characterId\);[\s\S]*?await validateMarketListingCreateQuota\(params\.characterId, new Date\(\)\);[\s\S]*?loadProjectedCharacterItemInstanceById/u,
  );
  assert.match(source, /dailyListingCount >= MARKET_LISTING_DAILY_CREATE_LIMIT/u);
  assert.match(source, /activeListingCount >= MARKET_LISTING_ACTIVE_LIMIT/u);
});

test('过期物品挂单不应继续出现在公开列表或购买链路', () => {
  const source = readSource('../marketService.ts');

  assert.match(source, /const MARKET_LISTING_VISIBLE_ACTIVE_SQL/u);
  assert.match(
    source,
    /const where: string\[\] = \[`ml\.status = 'active'`, MARKET_LISTING_VISIBLE_ACTIVE_SQL\]/u,
  );
  assert.match(
    source,
    /String\(listing\.status\) !== "active"[\s\S]*?isMarketListingExpired\(toMarketListingDate\(listing\.listed_at as Date \| string\), new Date\(\)\)/u,
  );
});

test('自动下架任务必须使用 RabbitMQ 延迟队列并脱离 cleanup worker 扫描链路', () => {
  const queueSource = readSource('../shared/marketListingAutoCancelQueue.ts');
  const autoCancelServiceSource = readSource('../marketListingAutoCancelService.ts');
  const cleanupWorkerSource = readSource('../../workers/cleanupWorker.ts');
  const startupPipelineSource = readSource('../../bootstrap/startupPipeline.ts');

  assert.match(queueSource, /MARKET_LISTING_AUTO_CANCEL_EXCHANGE/u);
  assert.match(queueSource, /MARKET_LISTING_AUTO_CANCEL_DELAY_QUEUE/u);
  assert.match(queueSource, /MARKET_LISTING_AUTO_CANCEL_DLQ/u);
  assert.match(queueSource, /x-dead-letter-exchange/u);
  assert.match(queueSource, /x-message-ttl/u);
  assert.match(autoCancelServiceSource, /marketService\.cancelExpiredMarketListing/u);
  assert.doesNotMatch(autoCancelServiceSource, /FROM\s+market_listing[\s\S]*?listed_at\s+<=/u);
  assert.doesNotMatch(cleanupWorkerSource, /marketListingAutoCancelService/u);
  assert.match(startupPipelineSource, /startMarketListingAutoCancelWorker/u);
});
