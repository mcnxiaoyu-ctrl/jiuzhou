/**
 * 股市 AI 新闻生成与语义校验。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：为每个股市行情周期构造 AI prompt，解析结构化新闻，并把可影响股票校验成服务端可执行语义。
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
import {
  normalizeStockMarketAiChangeBps,
  stockMarketPriceUnitsToSpiritStones,
} from './stockMarketRules.js';
import {
  selectStockMarketScenarioGuide,
  type StockMarketScenarioSelectionWeight,
} from './stockMarketScenarioSelector.js';
import {
  selectStockMarketNewsEventContext,
  type StockMarketNewsEventPromptContext,
  type StockMarketNewsEventSelectionWeight,
} from './stockMarketNewsEventContext.js';

export type StockMarketAiQuoteInput = {
  stockId: string;
  currentPriceUnits: bigint;
};

export type StockMarketValidatedImpact = {
  stockId: string;
  changeBps: number;
  reason: string;
};

export type StockMarketAiEventAction = 'new' | 'continue' | 'escalate' | 'resolve';

export type StockMarketValidatedEvent = {
  selectedEventId: string | null;
  action: StockMarketAiEventAction;
  theme: string;
  headline: string;
  summary: string;
  stage: string;
  affectedStockIds: string[];
};

export type StockMarketAiNewsDraft = {
  headline: string;
  summary: string;
  event: StockMarketValidatedEvent;
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
const STOCK_MARKET_AI_EVENT_ACTIONS: readonly StockMarketAiEventAction[] = [
  'new',
  'continue',
  'escalate',
  'resolve',
];

const buildStockMarketNewsResponseSchema = (
  enabledStockIds: readonly string[],
): TechniqueTextModelJsonSchemaObject => ({
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'summary', 'event', 'impacts'],
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
    event: {
      type: 'object',
      additionalProperties: false,
      required: ['action', 'theme', 'headline', 'summary', 'stage', 'affectedStockIds'],
      properties: {
        action: {
          type: 'string',
          enum: [...STOCK_MARKET_AI_EVENT_ACTIONS],
        },
        theme: {
          type: 'string',
          minLength: 2,
          maxLength: 32,
        },
        headline: {
          type: 'string',
          minLength: 4,
          maxLength: 40,
        },
        summary: {
          type: 'string',
          minLength: 12,
          maxLength: 120,
        },
        stage: {
          type: 'string',
          minLength: 2,
          maxLength: 24,
        },
        affectedStockIds: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          items: {
            type: 'string',
            enum: [...enabledStockIds],
          },
        },
      },
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

const readJsonObject = (
  source: TechniqueModelJsonObject,
  key: string,
): TechniqueModelJsonObject | null => {
  const value = source[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value;
};

const readEventAction = (
  source: TechniqueModelJsonObject,
): StockMarketAiEventAction | null => {
  const value = readTrimmedText(source, 'action', 16);
  if (!value) return null;
  return STOCK_MARKET_AI_EVENT_ACTIONS.includes(value as StockMarketAiEventAction)
    ? value as StockMarketAiEventAction
    : null;
};

const readAffectedStockIds = (
  source: TechniqueModelJsonObject,
  enabledStockIdSet: ReadonlySet<string>,
): string[] | null => {
  const value = source.affectedStockIds;
  if (!Array.isArray(value) || value.length <= 0 || value.length > 8) return null;

  const seenStockIds = new Set<string>();
  const stockIds: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return null;
    const stockId = entry.trim();
    if (!stockId || !enabledStockIdSet.has(stockId) || seenStockIds.has(stockId)) return null;
    seenStockIds.add(stockId);
    stockIds.push(stockId);
  }
  return stockIds;
};

const readEventEntry = (
  payload: TechniqueModelJsonObject,
  enabledStockIdSet: ReadonlySet<string>,
  selectedEventId: string | null,
): StockMarketValidatedEvent | null => {
  const rawEvent = readJsonObject(payload, 'event');
  if (!rawEvent) return null;

  const action = readEventAction(rawEvent);
  const theme = readTrimmedText(rawEvent, 'theme', 32);
  const headline = readTrimmedText(rawEvent, 'headline', 40);
  const summary = readTrimmedText(rawEvent, 'summary', 120);
  const stage = readTrimmedText(rawEvent, 'stage', 24);
  const affectedStockIds = readAffectedStockIds(rawEvent, enabledStockIdSet);
  if (!action || !theme || !headline || !summary || !stage || !affectedStockIds) return null;
  if (selectedEventId === null && action !== 'new') return null;
  if (selectedEventId !== null && action === 'new') return null;

  return {
    selectedEventId,
    action,
    theme,
    headline,
    summary,
    stage,
    affectedStockIds,
  };
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
  options?: {
    selectedEventId?: string | null;
  },
): StockMarketAiNewsDraftResult => {
  const headline = readTrimmedText(payload, 'headline', 40);
  const summary = readTrimmedText(payload, 'summary', 160);
  const event = readEventEntry(payload, enabledStockIdSet, options?.selectedEventId ?? null);
  const rawImpacts = payload.impacts;
  if (!headline || !summary) {
    return { success: false, reason: 'AI 新闻标题或摘要无效' };
  }
  if (!event) {
    return { success: false, reason: 'AI 新闻事件上下文无效' };
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
      event,
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
  recentImpactStockIds: readonly string[];
  activeEvents: readonly StockMarketNewsEventPromptContext[];
}): string => {
  const quoteByStockId = new Map(
    params.quotes.map((quote) => [
      quote.stockId,
      stockMarketPriceUnitsToSpiritStones(quote.currentPriceUnits).toFixed(2),
    ] as const),
  );
  const stockIdSet = new Set(params.definitions.map((definition) => definition.id));
  const eventSelection = selectStockMarketNewsEventContext({
    seed: params.scenarioSeed,
    enabledStockIdSet: stockIdSet,
    recentStockIds: params.recentImpactStockIds,
    events: params.activeEvents,
  });
  const selectedEvent = eventSelection.selectedEvent;
  const eventWeights: StockMarketNewsEventSelectionWeight[] = eventSelection.weights;
  const scenarioSelection = selectStockMarketScenarioGuide({
    seed: params.scenarioSeed,
    enabledStockIdSet: stockIdSet,
    recentStockIds: params.recentImpactStockIds,
    eventFocusStockIds: selectedEvent?.affectedStockIds ?? [],
  });
  const scenarioGuide = scenarioSelection.guide;
  const focusStockIds = scenarioGuide.focusStockIds.filter((stockId) => stockIdSet.has(stockId));
  const scenarioWeights: StockMarketScenarioSelectionWeight[] = scenarioSelection.weights;
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
    scenarioSelection: {
      recentImpactStockIds: params.recentImpactStockIds.slice(0, 16),
      weights: scenarioWeights,
    },
    eventContext: {
      activeEvents: params.activeEvents.slice(0, 6),
      selectedEvent,
      eventDirective: eventSelection.directive,
      weights: eventWeights,
    },
    stocks: params.definitions.map((definition) => ({
      stockId: definition.id,
      code: definition.code,
      name: definition.name,
      sector: definition.sector,
      currentPriceSpiritStones: quoteByStockId.get(definition.id) ?? definition.initial_price_spirit_stones.toFixed(2),
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
      'eventContext.selectedEvent 非空时，本轮必须续写该事件，event.action 只能是 continue、escalate 或 resolve',
      'eventContext.selectedEvent 为空时，本轮必须开启新事件，event.action 必须是 new',
      'event.theme、event.headline、event.summary、event.stage 用于内部事件池，不会直接展示给玩家，但必须概括本轮新闻脉络',
      'event.affectedStockIds 只能填写本事件明确关联股票，必须来自 stocks，不能重复',
      'recentImpactStockIds 表示近期已频繁波动的股票，用于降低重复题材；它不是禁用名单，确有强关联时可以少量复用',
      '优先让近期较少出现的 focusStockIds 获得明确影响，避免同一批股票连续多轮占据 impacts',
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
  recentImpactStockIds: readonly string[];
  activeEvents: readonly StockMarketNewsEventPromptContext[];
}): Promise<StockMarketAiNewsDraftResult> => {
  let previousFailureReason: string | null = null;
  const enabledStockIdSet = new Set(params.definitions.map((definition) => definition.id));
  for (let attempt = 1; attempt <= STOCK_MARKET_AI_MAX_ATTEMPTS; attempt += 1) {
    const seed = generateTechniqueTextModelSeed();
    const eventSelection = selectStockMarketNewsEventContext({
      seed,
      enabledStockIdSet,
      recentStockIds: params.recentImpactStockIds,
      events: params.activeEvents,
    });
    let callResult: Awaited<ReturnType<typeof callConfiguredTextModel>> | null = null;
    try {
      const userMessage = buildStockMarketUserMessage({
        ...params,
        attempt,
        previousFailureReason,
        recentImpactStockIds: params.recentImpactStockIds,
        scenarioSeed: seed,
        promptNoiseHash: buildTextModelPromptNoiseHash(`stock-market-news:${attempt}`, seed),
      });
      callResult = await callConfiguredTextModel({
        modelScope: 'stockMarket',
        responseFormat: buildStockMarketResponseFormat(params.definitions),
        systemMessage: buildStockMarketSystemMessage(),
        userMessage,
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
      preferredTopLevelKeys: ['headline', 'summary', 'event', 'impacts'],
    });
    if (!parsed.success) {
      previousFailureReason = `AI 新闻 JSON 解析失败: ${parsed.reason}`;
      continue;
    }

    const validated = validateStockMarketAiNewsPayload(
      parsed.data,
      enabledStockIdSet,
      {
        selectedEventId: eventSelection.selectedEvent?.eventId ?? null,
      },
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
