/**
 * 股市 AI 新闻生成与语义校验。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：为每小时股市行情构造 AI prompt，解析结构化新闻，并把可影响股票校验成服务端可执行语义。
 * 2. 不做什么：不直接改价格、不写交易表、不决定最终涨跌幅。
 *
 * 输入 / 输出：
 * - 输入：当前启用股票、当前价格快照、生成 tick 时间。
 * - 输出：校验后的新闻标题、摘要、模型快照与包含具体涨跌的股票影响。
 *
 * 数据流 / 状态流：
 * 股票静态定义 + 当前价格 -> prompt -> `callConfiguredTextModel` -> JSON 解析 -> 影响去重、白名单和涨跌数值校验 -> 调度服务消费。
 *
 * 复用设计说明：
 * - AI 决定具体涨跌百分比，服务端规则模块统一做两位小数与 ±8% 边界校验，避免规则散落。
 * - prompt、schema 和校验集中在这里，后续更换模型或扩展股票数量时不会影响交易服务。
 *
 * 关键边界条件与坑点：
 * 1. 模型返回未知股票 ID、重复股票 ID 或越界涨跌都视为失败，不允许部分落价。
 * 2. 模型未配置或返回非 JSON 对象时只记录失败 tick，不使用本地模板兜底改价。
 */
import { AI_GENERATION_TIMEOUT_MS } from '../shared/aiGenerationTimeout.js';
import { callConfiguredTextModel } from '../ai/openAITextClient.js';
import {
  buildTechniqueTextModelJsonSchemaResponseFormat,
  buildTextModelPromptNoiseHash,
  generateTechniqueTextModelSeed,
  parseTechniqueTextModelJsonObject,
  type TechniqueModelJsonObject,
  type TechniqueTextModelJsonSchemaObject,
} from '../shared/techniqueTextModelShared.js';
import type { StockMarketDefinition } from './stockMarketDefinitions.js';
import { normalizeStockMarketAiChangeBps } from './stockMarketRules.js';

export type StockMarketAiQuoteInput = {
  stockId: string;
  currentPriceSpiritStones: bigint;
};

export type StockMarketValidatedImpact = {
  stockId: string;
  changeBps: number;
  reason: string;
};

export type StockMarketAiNewsDraft = {
  headline: string;
  summary: string;
  impacts: StockMarketValidatedImpact[];
  modelName: string;
  promptSnapshot: string;
};

export type StockMarketAiNewsDraftResult =
  | {
    success: true;
    draft: StockMarketAiNewsDraft;
  }
  | {
    success: false;
    reason: string;
  };

const STOCK_MARKET_AI_TEMPERATURE = 0.8;
const STOCK_MARKET_AI_MAX_ATTEMPTS = 3;

const buildStockMarketNewsResponseSchema = (
  enabledStockIds: readonly string[],
): TechniqueTextModelJsonSchemaObject => ({
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'summary', 'impacts'],
  properties: {
    headline: {
      type: 'string',
      minLength: 4,
      maxLength: 40,
    },
    summary: {
      type: 'string',
      minLength: 12,
      maxLength: 160,
    },
    impacts: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['stockId', 'changePercent', 'reason'],
        properties: {
          stockId: {
            type: 'string',
            enum: [...enabledStockIds],
          },
          changePercent: {
            type: 'number',
            minimum: -8,
            maximum: 8,
          },
          reason: {
            type: 'string',
            minLength: 4,
            maxLength: 80,
          },
        },
      },
    },
  },
});

const buildStockMarketResponseFormat = (definitions: readonly StockMarketDefinition[]) => {
  return buildTechniqueTextModelJsonSchemaResponseFormat({
    name: 'stock_market_news',
    schema: buildStockMarketNewsResponseSchema(definitions.map((definition) => definition.id)),
  });
};

type StockMarketScenarioGuide = {
  id: string;
  title: string;
  focusStockIds: readonly string[];
  guide: string;
};

const STOCK_MARKET_SCENARIO_GUIDES: readonly StockMarketScenarioGuide[] = [
  {
    id: 'alchemy-supply',
    title: '丹药与灵植供需轮动',
    focusStockIds: ['stock-qingyun-danfang', 'stock-yunmeng-herb', 'stock-xinghe-auction'],
    guide: '围绕丹药需求、药材收成、拍卖流转写作，至少一只受益、一只承压，不要重复写丹方突破大涨。',
  },
  {
    id: 'mining-armory',
    title: '矿材与炼器成本博弈',
    focusStockIds: ['stock-xuantie-mining', 'stock-tiangong-armory', 'stock-beizhou-treasure'],
    guide: '围绕矿脉产量、矿价、炼器订单和商贸囤货写作，矿材与炼器或商贸之间形成多空对冲。',
  },
  {
    id: 'transport-array',
    title: '交通与阵法替代竞争',
    focusStockIds: ['stock-lingzhou-shipyard', 'stock-qiankun-array', 'stock-beizhou-treasure'],
    guide: '围绕灵舟航线、传送阵、商路安全写作，可以让交通与阵法互相替代，但不要连续只利好乾坤阵台。',
  },
  {
    id: 'academy-sect',
    title: '功法与宗门声望变化',
    focusStockIds: ['stock-wanjuan-academy', 'stock-chixiao-sword', 'stock-xinghe-auction'],
    guide: '围绕秘卷、论剑、讲经会和宗门委托写作，让功法、宗门、拍卖之间有正负分化。',
  },
  {
    id: 'auction-commerce',
    title: '拍卖与商贸资金分流',
    focusStockIds: ['stock-xinghe-auction', 'stock-beizhou-treasure', 'stock-wanjuan-academy'],
    guide: '围绕压轴拍品、宝楼交易、人气分流写作，拍卖热度和商贸成交之间形成平衡。',
  },
  {
    id: 'sect-defense',
    title: '边境战事与防务委托',
    focusStockIds: ['stock-chixiao-sword', 'stock-tiangong-armory', 'stock-qiankun-array', 'stock-lingzhou-shipyard'],
    guide: '围绕边境战事、护宗委托、法器与阵法需求写作，至少包含一个受益方和一个成本或风险承压方。',
  },
  {
    id: 'weather-harvest',
    title: '节气收成与材料价格',
    focusStockIds: ['stock-yunmeng-herb', 'stock-qingyun-danfang', 'stock-xuantie-mining', 'stock-tiangong-armory'],
    guide: '围绕节气、虫害、灵草收成和材料价格写作，供应端与加工端涨跌互相抵消。',
  },
  {
    id: 'market-rotation',
    title: '市场风险偏好切换',
    focusStockIds: [
      'stock-qingyun-danfang',
      'stock-wanjuan-academy',
      'stock-xinghe-auction',
      'stock-beizhou-treasure',
    ],
    guide: '围绕修士资金在消耗品、功法、拍卖和商贸之间切换写作，不要让同一行业连续独占利好。',
  },
];

const selectStockMarketScenarioGuide = (seed: number): StockMarketScenarioGuide => {
  const normalizedSeed = Number.isSafeInteger(seed) ? seed : 0;
  const normalizedIndex = ((normalizedSeed % STOCK_MARKET_SCENARIO_GUIDES.length) + STOCK_MARKET_SCENARIO_GUIDES.length)
    % STOCK_MARKET_SCENARIO_GUIDES.length;
  return STOCK_MARKET_SCENARIO_GUIDES[normalizedIndex]!;
};

const readTrimmedText = (
  source: TechniqueModelJsonObject,
  key: string,
  maxLength: number,
): string | null => {
  const value = source[key];
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) return null;
  return normalized;
};

const readChangeBps = (source: TechniqueModelJsonObject): number | null => {
  const value = source.changePercent;
  if (typeof value !== 'number') return null;
  return normalizeStockMarketAiChangeBps(value);
};

const readImpactEntry = (
  source: TechniqueModelJsonObject,
  enabledStockIdSet: ReadonlySet<string>,
): StockMarketValidatedImpact | null => {
  const stockId = readTrimmedText(source, 'stockId', 96);
  const changeBps = readChangeBps(source);
  const reason = readTrimmedText(source, 'reason', 80);
  if (!stockId || !enabledStockIdSet.has(stockId)) return null;
  if (changeBps === null) return null;
  if (!reason) return null;

  return {
    stockId,
    changeBps,
    reason,
  };
};

export const validateStockMarketAiNewsPayload = (
  payload: TechniqueModelJsonObject,
  enabledStockIdSet: ReadonlySet<string>,
): StockMarketAiNewsDraftResult => {
  const headline = readTrimmedText(payload, 'headline', 40);
  const summary = readTrimmedText(payload, 'summary', 160);
  const rawImpacts = payload.impacts;
  if (!headline || !summary) {
    return { success: false, reason: 'AI 新闻标题或摘要无效' };
  }
  if (!Array.isArray(rawImpacts) || rawImpacts.length <= 0) {
    return { success: false, reason: 'AI 新闻影响列表无效' };
  }

  const seenStockIds = new Set<string>();
  const impacts: StockMarketValidatedImpact[] = [];
  for (const rawImpact of rawImpacts) {
    if (typeof rawImpact !== 'object' || rawImpact === null || Array.isArray(rawImpact)) {
      return { success: false, reason: 'AI 新闻影响项结构无效' };
    }
    const impact = readImpactEntry(rawImpact, enabledStockIdSet);
    if (!impact || seenStockIds.has(impact.stockId)) {
      return { success: false, reason: 'AI 新闻影响股票无效或重复' };
    }
    seenStockIds.add(impact.stockId);
    impacts.push(impact);
  }

  return {
    success: true,
    draft: {
      headline,
      summary,
      impacts,
      modelName: '',
      promptSnapshot: '',
    },
  };
};

const buildStockMarketSystemMessage = (): string => {
  return [
    '你是九州修仙录世界中的坊间财经新闻撰稿人。',
    '每次只生成一条中文股市新闻，新闻必须贴合修仙商业、宗门、丹药、炼器、阵法、拍卖等题材。',
    '你需要判断新闻对股票的具体涨跌百分比，不输出价格、投资建议或现实金融内容。',
    '大盘目标是长期基本横盘：单条新闻应体现多空平衡，不要持续生成单边利好或单边利空。',
    '同一条新闻内若有明显受益股票，应尽量给出同事件中受损或承压的股票进行对冲；若只有单只股票受影响，涨跌幅应保持温和。',
    '不要默认偏向丹药、青云丹坊或任何单一题材；应在矿材、交通、炼器、功法、灵植、拍卖、宗门、阵法、商贸之间自然轮换。',
    '必须只输出合法 JSON 对象，JSON 字段必须严格符合 response_format schema。',
    'impacts 可包含所有受新闻明确影响的股票，stockId 必须来自用户提供的股票列表，禁止虚构股票，changePercent 必须在 -8 到 8 之间且最多两位小数。',
    '同一条 impacts 内每个 stockId 只能出现一次，stockId 必须逐字复制用户 stocks 列表中的 stockId。',
  ].join('\n');
};

const buildStockMarketUserMessage = (params: {
  definitions: readonly StockMarketDefinition[];
  quotes: readonly StockMarketAiQuoteInput[];
  tickHour: Date;
  promptNoiseHash: string;
  attempt: number;
  previousFailureReason: string | null;
  scenarioSeed: number;
}): string => {
  const quoteByStockId = new Map(
    params.quotes.map((quote) => [quote.stockId, quote.currentPriceSpiritStones.toString()] as const),
  );
  const stockIdSet = new Set(params.definitions.map((definition) => definition.id));
  const scenarioGuide = selectStockMarketScenarioGuide(params.scenarioSeed);
  const focusStockIds = scenarioGuide.focusStockIds.filter((stockId) => stockIdSet.has(stockId));
  return JSON.stringify({
    tickHour: params.tickHour.toISOString(),
    promptNoiseHash: params.promptNoiseHash,
    attempt: params.attempt,
    previousFailureReason: params.previousFailureReason,
    marketScenario: {
      id: scenarioGuide.id,
      title: scenarioGuide.title,
      focusStockIds,
      guide: scenarioGuide.guide,
    },
    stocks: params.definitions.map((definition) => ({
      stockId: definition.id,
      code: definition.code,
      name: definition.name,
      sector: definition.sector,
      currentPriceSpiritStones: quoteByStockId.get(definition.id) ?? String(definition.initial_price_spirit_stones),
      description: definition.description ?? '',
    })),
    outputRules: [
      '必须只输出合法 JSON 对象，不要输出 Markdown、解释文字或代码块',
      'headline 使用 4 到 40 个中文字符',
      'summary 使用 12 到 160 个中文字符',
      'changePercent 表示本次涨跌百分比，正数上涨、负数下跌，范围 -8 到 8，最多两位小数，不能为 0',
      '单轮 impacts 的 changePercent 简单合计应尽量接近 0，目标区间为 -1.00 到 1.00',
      '常规单股波动优先控制在 -3.00 到 3.00；超过 4.00 或低于 -4.00 只用于重大突发事件',
      '优先输出 2 到 4 个相互关联的受影响股票，形成一涨一跌或多空配对',
      '本轮新闻题材必须优先围绕 marketScenario，impacts 优先从 marketScenario.focusStockIds 中选择',
      '不要连续使用丹方突破、筑基丹热销、青云丹坊大利好作为默认新闻题材',
      '同一个 stockId 只能出现一次，禁止用股票名称、code 或 shortName 代替 stockId',
      '输出前必须自检 impacts：stockId 全部来自 stocks，且没有任何重复 stockId',
      '如果 previousFailureReason 非空，本次必须修正该错误后再输出',
      '没有明确涨跌影响的股票不要放入 impacts',
      'reason 只解释新闻如何影响该股票，不重复填写涨跌数值',
    ],
  });
};

export const generateStockMarketAiNewsDraft = async (params: {
  definitions: readonly StockMarketDefinition[];
  quotes: readonly StockMarketAiQuoteInput[];
  tickHour: Date;
}): Promise<StockMarketAiNewsDraftResult> => {
  let previousFailureReason: string | null = null;
  for (let attempt = 1; attempt <= STOCK_MARKET_AI_MAX_ATTEMPTS; attempt += 1) {
    const seed = generateTechniqueTextModelSeed();
    let callResult: Awaited<ReturnType<typeof callConfiguredTextModel>> | null = null;
    try {
      callResult = await callConfiguredTextModel({
        modelScope: 'stockMarket',
        responseFormat: buildStockMarketResponseFormat(params.definitions),
        systemMessage: buildStockMarketSystemMessage(),
        userMessage: buildStockMarketUserMessage({
          ...params,
          attempt,
          previousFailureReason,
          scenarioSeed: seed,
          promptNoiseHash: buildTextModelPromptNoiseHash(`stock-market-news:${attempt}`, seed),
        }),
        seed,
        temperature: STOCK_MARKET_AI_TEMPERATURE,
        timeoutMs: AI_GENERATION_TIMEOUT_MS,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      previousFailureReason = `股市 AI 文本模型调用失败: ${message}`;
      continue;
    }
    if (!callResult) {
      return { success: false, reason: '股市 AI 文本模型未配置' };
    }

    const parsed = parseTechniqueTextModelJsonObject(callResult.content, {
      preferredTopLevelKeys: ['headline', 'summary', 'impacts'],
    });
    if (!parsed.success) {
      previousFailureReason = `AI 新闻 JSON 解析失败: ${parsed.reason}`;
      continue;
    }

    const validated = validateStockMarketAiNewsPayload(
      parsed.data,
      new Set(params.definitions.map((definition) => definition.id)),
    );
    if (!validated.success) {
      previousFailureReason = validated.reason;
      continue;
    }

    return {
      success: true,
      draft: {
        ...validated.draft,
        modelName: callResult.modelName,
        promptSnapshot: callResult.promptSnapshot,
      },
    };
  }

  return { success: false, reason: previousFailureReason ?? '股市 AI 新闻生成失败' };
};
