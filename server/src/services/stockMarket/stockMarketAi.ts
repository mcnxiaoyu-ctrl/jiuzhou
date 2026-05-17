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

const STOCK_MARKET_NEWS_RESPONSE_SCHEMA: TechniqueTextModelJsonSchemaObject = {
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
};

const STOCK_MARKET_RESPONSE_FORMAT = buildTechniqueTextModelJsonSchemaResponseFormat({
  name: 'stock_market_news',
  schema: STOCK_MARKET_NEWS_RESPONSE_SCHEMA,
});

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
    '必须只输出合法 JSON 对象，JSON 字段必须严格符合 response_format schema。',
    'impacts 可包含所有受新闻明确影响的股票，stockId 必须来自用户提供的股票列表，禁止虚构股票，changePercent 必须在 -8 到 8 之间且最多两位小数。',
  ].join('\n');
};

const buildStockMarketUserMessage = (params: {
  definitions: readonly StockMarketDefinition[];
  quotes: readonly StockMarketAiQuoteInput[];
  tickHour: Date;
  promptNoiseHash: string;
}): string => {
  const quoteByStockId = new Map(
    params.quotes.map((quote) => [quote.stockId, quote.currentPriceSpiritStones.toString()] as const),
  );
  return JSON.stringify({
    tickHour: params.tickHour.toISOString(),
    promptNoiseHash: params.promptNoiseHash,
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
  const seed = generateTechniqueTextModelSeed();
  let callResult: Awaited<ReturnType<typeof callConfiguredTextModel>> | null = null;
  try {
    callResult = await callConfiguredTextModel({
      modelScope: 'stockMarket',
      responseFormat: STOCK_MARKET_RESPONSE_FORMAT,
      systemMessage: buildStockMarketSystemMessage(),
      userMessage: buildStockMarketUserMessage({
        ...params,
        promptNoiseHash: buildTextModelPromptNoiseHash('stock-market-news', seed),
      }),
      seed,
      temperature: STOCK_MARKET_AI_TEMPERATURE,
      timeoutMs: AI_GENERATION_TIMEOUT_MS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, reason: `股市 AI 文本模型调用失败: ${message}` };
  }
  if (!callResult) {
    return { success: false, reason: '股市 AI 文本模型未配置' };
  }

  const parsed = parseTechniqueTextModelJsonObject(callResult.content, {
    preferredTopLevelKeys: ['headline', 'summary', 'impacts'],
  });
  if (!parsed.success) {
    return { success: false, reason: `AI 新闻 JSON 解析失败: ${parsed.reason}` };
  }

  const validated = validateStockMarketAiNewsPayload(
    parsed.data,
    new Set(params.definitions.map((definition) => definition.id)),
  );
  if (!validated.success) return validated;

  return {
    success: true,
    draft: {
      ...validated.draft,
      modelName: callResult.modelName,
      promptSnapshot: callResult.promptSnapshot,
    },
  };
};
