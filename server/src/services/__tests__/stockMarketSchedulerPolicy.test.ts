/**
 * 股市后台调度策略静态测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定股市 30 分钟调度只能接入 scheduled background services，并通过 tick_hour 幂等。
 * 2. 不做什么：不启动真实定时器、不连接数据库、不调用 AI。
 *
 * 输入 / 输出：
 * - 输入：启动流水线、cleanupWorker、股市调度器与服务源码文本。
 * - 输出：源码结构断言。
 *
 * 数据流 / 状态流：
 * 读取源码 -> 检查启动入口、cleanupWorker 边界、tick_hour 唯一插入和失败不改价路径。
 *
 * 复用设计说明：
 * - 这是进程生命周期策略，静态测试能以最低成本防止未来把股市 tick 塞进 cleanupWorker 或请求路由。
 * - tick 幂等与 AI 失败路径集中锁定，避免多进程 worker 或模型失败时误改价格。
 *
 * 关键边界条件与坑点：
 * 1. 股市 tick 是业务行情，不属于清理任务，不能接入 cleanupWorker。
 * 2. AI 失败只能更新 `stock_market_tick` 状态，不能触碰 quote/history。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import test from 'node:test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const readSource = (relativePath: string): string => {
  return readFileSync(resolve(__dirname, relativePath), 'utf8');
};

test('股市调度器应接入 scheduled background services 且不进入 cleanupWorker', () => {
  const startupSource = readSource('../../bootstrap/startupPipeline.ts');
  const cleanupWorkerSource = readSource('../../workers/cleanupWorker.ts');
  const schedulerSource = readSource('../stockMarket/stockMarketScheduler.ts');
  const rulesSource = readSource('../stockMarket/stockMarketRules.ts');

  assert.match(startupSource, /if \(shouldStartScheduledBackgroundServices\(runtimeRole\)\)[\s\S]*initializeStockMarketScheduler/u);
  assert.match(startupSource, /stopStockMarketScheduler/u);
  assert.match(rulesSource, /STOCK_MARKET_TICK_INTERVAL_MINUTES\s*=\s*30/u);
  assert.match(schedulerSource, /setTimeout/u);
  assert.doesNotMatch(schedulerSource, /setInterval/u);
  assert.doesNotMatch(cleanupWorkerSource, /stockMarket/u);
  assert.doesNotMatch(cleanupWorkerSource, /StockMarket/u);
});

test('股市 tick 应以 tick_hour 幂等，AI 失败不得更新报价', () => {
  const serviceSource = readSource('../stockMarket/stockMarketService.ts');
  const failureBranch = serviceSource.match(/if \(!newsResult\.success\) \{[\s\S]*?return \{ status: 'failed'/u)?.[0] ?? '';
  const failureMethod = serviceSource.match(/private async recordTickFailure[\s\S]*?\n  \}/u)?.[0] ?? '';

  assert.match(serviceSource, /ON CONFLICT \(tick_hour\) DO NOTHING/u);
  assert.match(serviceSource, /recordTickFailure\(tickId, newsResult\.reason\)/u);
  assert.doesNotMatch(failureBranch, /stock_market_quote/u);
  assert.doesNotMatch(failureBranch, /stock_market_price_history/u);
  assert.match(failureMethod, /UPDATE stock_market_tick/u);
  assert.doesNotMatch(failureMethod, /stock_market_quote/u);
});
