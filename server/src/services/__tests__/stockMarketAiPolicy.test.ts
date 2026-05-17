/**
 * 股市 AI 新闻语义校验测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定 AI 输出只能影响启用股票、不能重复股票、最多 3 条影响。
 * 2. 不做什么：不请求真实模型、不验证 prompt 文风、不写行情价格。
 *
 * 输入 / 输出：
 * - 输入：模拟的模型 JSON 对象和启用股票 ID 集合。
 * - 输出：校验成功或失败原因。
 *
 * 数据流 / 状态流：
 * 模型 JSON -> `validateStockMarketAiNewsPayload` -> 调度服务决定是否改价。
 *
 * 复用设计说明：
 * - AI 校验是行情是否允许落价的唯一入口，测试这里比在调度链路里重复 mock 模型更直接。
 * - 该测试阻止“部分接受坏输出”的回退，保证失败 tick 不会误改某些股票价格。
 *
 * 关键边界条件与坑点：
 * 1. 只要出现未知或重复 stockId，整条新闻必须失败，不能部分落价。
 * 2. neutral 影响允许通过，但最终涨跌幅由规则模块映射为 0。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { validateStockMarketAiNewsPayload } from '../stockMarket/stockMarketAi.js';

const enabledStockIds = new Set(['stock-a', 'stock-b', 'stock-c']);

test('validateStockMarketAiNewsPayload: 合法 AI 新闻应输出可执行影响', () => {
  const result = validateStockMarketAiNewsPayload({
    headline: '丹坊新炉成丹',
    summary: '青云丹坊宣布新炉丹药成色稳定，坊间采购情绪升温。',
    impacts: [
      {
        stockId: 'stock-a',
        direction: 'bullish',
        impactLevel: 'normal',
        reason: '新炉成丹提升丹药供给预期',
      },
      {
        stockId: 'stock-b',
        direction: 'neutral',
        impactLevel: 'minor',
        reason: '消息与矿材需求关联较弱',
      },
    ],
  }, enabledStockIds);

  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.draft.impacts.length, 2);
    assert.equal(result.draft.impacts[0]?.direction, 'bullish');
  }
});

test('validateStockMarketAiNewsPayload: 未知股票或重复股票应整条失败', () => {
  const unknownResult = validateStockMarketAiNewsPayload({
    headline: '宝楼传出新消息',
    summary: '坊间消息称有珍宝入库，但股票 ID 并不在白名单内。',
    impacts: [
      {
        stockId: 'stock-missing',
        direction: 'bullish',
        impactLevel: 'minor',
        reason: '未知股票不允许落价',
      },
    ],
  }, enabledStockIds);

  const duplicatedResult = validateStockMarketAiNewsPayload({
    headline: '灵舟订单波动',
    summary: '同一股票被重复输出两条影响，必须拒绝整条新闻。',
    impacts: [
      {
        stockId: 'stock-a',
        direction: 'bullish',
        impactLevel: 'minor',
        reason: '订单增加',
      },
      {
        stockId: 'stock-a',
        direction: 'bearish',
        impactLevel: 'minor',
        reason: '成本上升',
      },
    ],
  }, enabledStockIds);

  assert.equal(unknownResult.success, false);
  assert.equal(duplicatedResult.success, false);
});
