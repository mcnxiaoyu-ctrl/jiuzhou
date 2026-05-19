/**
 * 股市 AI 新闻语义校验测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定 AI 输出只能影响启用股票、不能重复股票、不限制固定影响数量，且涨跌数值必须合法。
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
 * 2. 0% 或超过两位小数的涨跌不能进入 impacts，否则会在前端形成无意义或不稳定的行情影响。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { validateStockMarketAiNewsPayload } from '../stockMarket/stockMarketAi.js';
import {
  buildStockMarketNewsEventSelectionWeights,
  selectStockMarketNewsEventContext,
  type StockMarketNewsEventPromptContext,
} from '../stockMarket/stockMarketNewsEventContext.js';
import {
  buildStockMarketScenarioSelectionWeights,
  selectStockMarketScenarioGuide,
} from '../stockMarket/stockMarketScenarioSelector.js';

const enabledStockIds = new Set(['stock-a', 'stock-b', 'stock-c', 'stock-d']);
const enabledScenarioStockIds = new Set([
  'stock-qingyun-danfang',
  'stock-xuantie-mining',
  'stock-lingzhou-shipyard',
  'stock-tiangong-armory',
  'stock-wanjuan-academy',
  'stock-yunmeng-herb',
  'stock-xinghe-auction',
  'stock-chixiao-sword',
  'stock-qiankun-array',
  'stock-beizhou-treasure',
]);

const buildValidEventPayload = () => ({
  action: 'new',
  theme: '丹药供应',
  headline: '丹坊供需事件',
  summary: '青云丹坊供需波动延续，相关商号同步调整预期。',
  stage: '起势',
  affectedStockIds: ['stock-a', 'stock-b'],
});

const buildPromptEvent = (
  eventId: string,
  affectedStockIds: readonly string[],
  status: StockMarketNewsEventPromptContext['status'] = 'active',
): StockMarketNewsEventPromptContext => ({
  eventId,
  status,
  theme: `事件${eventId}`,
  headline: `事件${eventId}标题`,
  summary: `事件${eventId}摘要`,
  stage: '发酵',
  affectedStockIds,
});

test('validateStockMarketAiNewsPayload: 合法 AI 新闻应输出可执行影响', () => {
  const result = validateStockMarketAiNewsPayload({
    headline: '丹坊新炉成丹',
    summary: '青云丹坊宣布新炉丹药成色稳定，坊间采购情绪升温。',
    event: buildValidEventPayload(),
    impacts: [
      {
        stockId: 'stock-a',
        changePercent: 4.25,
        reason: '新炉成丹提升丹药供给预期',
      },
      {
        stockId: 'stock-b',
        changePercent: -1.5,
        reason: '丹药走强挤压矿材题材热度',
      },
    ],
  }, enabledStockIds);

  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.draft.impacts.length, 2);
    assert.equal(result.draft.impacts[0]?.changeBps, 425);
    assert.equal(result.draft.impacts[1]?.changeBps, -150);
  }
});

test('validateStockMarketAiNewsPayload: 不应限制可影响股票数量', () => {
  const result = validateStockMarketAiNewsPayload({
    headline: '坊间大市齐动',
    summary: '多家商号同时受拍卖、矿脉与宗门订单影响，行情同步波动。',
    event: buildValidEventPayload(),
    impacts: [
      {
        stockId: 'stock-a',
        changePercent: 1.11,
        reason: '丹药采购增加',
      },
      {
        stockId: 'stock-b',
        changePercent: -2.22,
        reason: '矿材运输受阻',
      },
      {
        stockId: 'stock-c',
        changePercent: 3.33,
        reason: '拍卖热度扩散',
      },
      {
        stockId: 'stock-d',
        changePercent: -4.44,
        reason: '宗门订单延后',
      },
    ],
  }, enabledStockIds);

  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.draft.impacts.length, 4);
    assert.deepEqual(
      result.draft.impacts.map((impact) => impact.changeBps),
      [111, -222, 333, -444],
    );
  }
});

test('validateStockMarketAiNewsPayload: 0% 影响不应进入可见行情', () => {
  const result = validateStockMarketAiNewsPayload({
    headline: '矿脉消息传开',
    summary: '北境矿脉消息只影响矿材与炼器，没有明确关联的股票不应输出。',
    event: buildValidEventPayload(),
    impacts: [
      {
        stockId: 'stock-c',
        changePercent: 0,
        reason: '消息与该股票关联较弱',
      },
    ],
  }, enabledStockIds);

  assert.equal(result.success, false);
});

test('validateStockMarketAiNewsPayload: 未知股票或重复股票应整条失败', () => {
  const unknownResult = validateStockMarketAiNewsPayload({
    headline: '宝楼传出新消息',
    summary: '坊间消息称有珍宝入库，但股票 ID 并不在白名单内。',
    event: buildValidEventPayload(),
    impacts: [
      {
        stockId: 'stock-missing',
        changePercent: 2.5,
        reason: '未知股票不允许落价',
      },
    ],
  }, enabledStockIds);

  const duplicatedResult = validateStockMarketAiNewsPayload({
    headline: '灵舟订单波动',
    summary: '同一股票被重复输出两条影响，必须拒绝整条新闻。',
    event: buildValidEventPayload(),
    impacts: [
      {
        stockId: 'stock-a',
        changePercent: 1.25,
        reason: '订单增加',
      },
      {
        stockId: 'stock-a',
        changePercent: -2,
        reason: '成本上升',
      },
    ],
  }, enabledStockIds);

  assert.equal(unknownResult.success, false);
  assert.equal(duplicatedResult.success, false);
});

test('validateStockMarketAiNewsPayload: 涨跌超过两位小数或超过上下限应整条失败', () => {
  const precisionResult = validateStockMarketAiNewsPayload({
    headline: '拍卖热度升温',
    summary: '星河拍卖场成交活跃，但模型给出的涨跌精度超过两位小数。',
    event: buildValidEventPayload(),
    impacts: [
      {
        stockId: 'stock-a',
        changePercent: 1.234,
        reason: '成交活跃推高热度',
      },
    ],
  }, enabledStockIds);

  const limitResult = validateStockMarketAiNewsPayload({
    headline: '矿业订单激增',
    summary: '玄铁矿业订单激增，但模型给出的涨跌超过服务端硬上限。',
    event: buildValidEventPayload(),
    impacts: [
      {
        stockId: 'stock-b',
        changePercent: 8.01,
        reason: '订单激增推高预期',
      },
    ],
  }, enabledStockIds);

  assert.equal(precisionResult.success, false);
  assert.equal(limitResult.success, false);
});

test('validateStockMarketAiNewsPayload: 事件动作和事件股票必须合法', () => {
  const badActionResult = validateStockMarketAiNewsPayload({
    headline: '丹坊事件变动',
    summary: '丹坊供需事件继续发酵，但模型返回了未知事件动作。',
    event: {
      ...buildValidEventPayload(),
      action: 'pause',
    },
    impacts: [
      {
        stockId: 'stock-a',
        changePercent: 1.25,
        reason: '供需事件推高预期',
      },
    ],
  }, enabledStockIds);

  const badStockResult = validateStockMarketAiNewsPayload({
    headline: '矿业事件变动',
    summary: '矿业事件继续发酵，但事件股票不在启用股票白名单内。',
    event: {
      ...buildValidEventPayload(),
      affectedStockIds: ['stock-missing'],
    },
    impacts: [
      {
        stockId: 'stock-a',
        changePercent: 1.25,
        reason: '供需事件推高预期',
      },
    ],
  }, enabledStockIds);

  assert.equal(badActionResult.success, false);
  assert.equal(badStockResult.success, false);
});

test('validateStockMarketAiNewsPayload: 选中旧事件时不能输出新事件动作', () => {
  const result = validateStockMarketAiNewsPayload({
    headline: '丹坊事件延续',
    summary: '青云丹坊供需事件继续发酵，相关商号同步调整预期。',
    event: {
      ...buildValidEventPayload(),
      action: 'new',
    },
    impacts: [
      {
        stockId: 'stock-a',
        changePercent: 1.25,
        reason: '供需事件推高预期',
      },
    ],
  }, enabledStockIds, { selectedEventId: '101' });

  assert.equal(result.success, false);
});

test('selectStockMarketScenarioGuide: 近期高频股票应降低对应场景权重但不固定轮换', () => {
  const weights = buildStockMarketScenarioSelectionWeights({
    seed: 1001,
    enabledStockIdSet: enabledScenarioStockIds,
    recentStockIds: [
      'stock-qingyun-danfang',
      'stock-yunmeng-herb',
      'stock-xinghe-auction',
      'stock-qingyun-danfang',
      'stock-yunmeng-herb',
      'stock-xinghe-auction',
    ],
  });
  const alchemyWeight = weights.find((row) => row.scenarioId === 'alchemy-supply');
  const sectWeight = weights.find((row) => row.scenarioId === 'sect-defense');

  assert.ok(alchemyWeight);
  assert.ok(sectWeight);
  assert.ok(alchemyWeight.weight > 0);
  assert.ok(sectWeight.weight > alchemyWeight.weight);
});

test('selectStockMarketScenarioGuide: 活跃事件应提高相关题材权重但不固定轮换', () => {
  const baseWeights = buildStockMarketScenarioSelectionWeights({
    seed: 1001,
    enabledStockIdSet: enabledScenarioStockIds,
    recentStockIds: [],
  });
  const eventWeights = buildStockMarketScenarioSelectionWeights({
    seed: 1001,
    enabledStockIdSet: enabledScenarioStockIds,
    recentStockIds: [],
    eventFocusStockIds: ['stock-xuantie-mining', 'stock-tiangong-armory'],
  });

  const baseMiningWeight = baseWeights.find((row) => row.scenarioId === 'mining-armory');
  const eventMiningWeight = eventWeights.find((row) => row.scenarioId === 'mining-armory');
  assert.ok(baseMiningWeight);
  assert.ok(eventMiningWeight);
  assert.ok(eventMiningWeight.weight > baseMiningWeight.weight);

  const selectedScenarioIds = new Set<string>();
  for (let seed = 1; seed <= 24; seed += 1) {
    selectedScenarioIds.add(selectStockMarketScenarioGuide({
      seed,
      enabledStockIdSet: enabledScenarioStockIds,
      recentStockIds: [],
      eventFocusStockIds: ['stock-xuantie-mining', 'stock-tiangong-armory'],
    }).guide.id);
  }
  assert.ok(selectedScenarioIds.size > 1);
});

test('selectStockMarketScenarioGuide: 相同近期状态下不同 seed 仍允许选择不同场景', () => {
  const recentStockIds = [
    'stock-qingyun-danfang',
    'stock-yunmeng-herb',
    'stock-xinghe-auction',
    'stock-beizhou-treasure',
  ];
  const selectedScenarioIds = new Set<string>();
  for (let seed = 1; seed <= 24; seed += 1) {
    selectedScenarioIds.add(selectStockMarketScenarioGuide({
      seed,
      enabledStockIdSet: enabledScenarioStockIds,
      recentStockIds,
    }).guide.id);
  }

  assert.ok(selectedScenarioIds.size > 1);
});

test('selectStockMarketNewsEventContext: 高频股票会降低事件权重但不禁止延续', () => {
  const weights = buildStockMarketNewsEventSelectionWeights({
    seed: 1001,
    enabledStockIdSet: enabledStockIds,
    recentStockIds: ['stock-a', 'stock-a', 'stock-a', 'stock-b'],
    events: [
      buildPromptEvent('1', ['stock-a', 'stock-b']),
      buildPromptEvent('2', ['stock-c', 'stock-d']),
    ],
  });

  const hotEvent = weights.find((row) => row.eventId === '1');
  const coldEvent = weights.find((row) => row.eventId === '2');
  assert.ok(hotEvent);
  assert.ok(coldEvent);
  assert.ok(hotEvent.weight > 0);
  assert.ok(coldEvent.weight > hotEvent.weight);
});

test('selectStockMarketNewsEventContext: resolved 事件不进入候选池且保留新事件选择', () => {
  const selection = selectStockMarketNewsEventContext({
    seed: 7,
    enabledStockIdSet: enabledStockIds,
    recentStockIds: [],
    events: [
      buildPromptEvent('1', ['stock-a'], 'resolved'),
    ],
  });

  assert.equal(selection.selectedEvent, null);
  assert.equal(selection.directive, 'new');
  assert.deepEqual(selection.weights.map((row) => row.eventId), ['new']);
});
