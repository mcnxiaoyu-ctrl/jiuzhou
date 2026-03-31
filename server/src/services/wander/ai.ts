/**
 * 云游奇遇 AI 编排模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一构造云游奇遇 prompt、调用文本模型，并把模型返回校验成固定剧情结构。
 * 2. 做什么：把“世界观约束、输出字段、长度限制、结局条件”集中在单一入口，避免业务服务里散落 prompt 与校验代码。
 * 3. 不做什么：不写数据库，不决定每日次数，也不发放称号归属。
 *
 * 输入/输出：
 * - 输入：玩家上下文、最近剧情摘要、今日待推进幕次。
 * - 输出：校验通过的 AI 奇遇草稿。
 *
 * 数据流/状态流：
 * 云游服务组织上下文 -> 本模块构造 JSON prompt -> 文本模型返回结构化内容 -> 本模块校验并返回草稿给服务层落库。
 *
 * 关键边界条件与坑点：
 * 1. 本模块不信任模型输出；即便使用结构化 response_format，也必须继续执行长度、枚举、选项数量等业务校验。
 * 2. 结局称号名与描述虽然由 AI 生成，但数值加成不由 AI 决定，避免线上平衡漂移。
 */
import { callConfiguredTextModel } from '../ai/openAITextClient.js';
import { readTextModelConfig } from '../ai/modelConfig.js';
import {
  buildTechniqueTextModelJsonSchemaResponseFormat,
  buildTextModelPromptNoiseHash,
  generateTechniqueTextModelSeed,
  parseTechniqueTextModelJsonObject,
  type TechniqueModelJsonObject,
  type TechniqueTextModelJsonSchemaObject,
  type TechniqueTextModelResponseFormat,
} from '../shared/techniqueTextModelShared.js';
import type { WanderAiEpisodeDraft, WanderEndingType } from './types.js';

type WanderAiJsonValue =
  | string
  | number
  | boolean
  | null
  | TechniqueModelJsonObject
  | WanderAiJsonValue[];

export interface WanderAiPreviousEpisodeContext {
  dayIndex: number;
  title: string;
  choice: string;
  summary: string;
}

export interface WanderAiGenerationInput {
  nickname: string;
  realm: string;
  mapName: string;
  hasTeam: boolean;
  activeTheme: string | null;
  activePremise: string | null;
  storySummary: string | null;
  nextEpisodeIndex: number;
  maxEpisodeIndex: number;
  canEndThisEpisode: boolean;
  previousEpisodes: WanderAiPreviousEpisodeContext[];
}

const WANDER_OPTION_COUNT = 3;
const WANDER_AI_TIMEOUT_MS = 600_000;
const WANDER_AI_MAX_ATTEMPTS = 3;
const WANDER_ENDING_TYPE_VALUES: WanderEndingType[] = ['none', 'good', 'neutral', 'tragic', 'bizarre'];
const WANDER_NON_ENDING_TYPE_VALUES: WanderEndingType[] = ['none'];
const WANDER_COMPLETED_ENDING_TYPE_VALUES: WanderEndingType[] = ['good', 'neutral', 'tragic', 'bizarre'];

type WanderAiEndingMode = 'must_continue' | 'can_continue_or_end' | 'must_end';

type WanderAiDraftParseResult =
  | {
    success: true;
    data: WanderAiEpisodeDraft;
  }
  | {
    success: false;
    reason: string;
  };

type WanderAiContentValidationResult =
  | {
      success: true;
    data: WanderAiEpisodeDraft;
  }
  | {
    success: false;
    reason: string;
    };

type WanderAiPromptRuleSet = {
  systemRules: string[];
  outputRules: {
    storyThemeLengthRange: string;
    storyThemeStyleRule: string;
    storyThemeExample: string;
    optionCount: number;
    optionStyleRule: string;
    optionExample: [string, string, string];
    episodeTitleLengthRange: string;
    episodeTitleStyleRule: string;
    openingLengthRange: string;
    openingStyleRule: string;
    openingExample: string;
    summaryLengthRange: string;
    rewardTitleNameLengthRange: string;
    rewardTitleDescLengthRange: string;
    endingTypeValues: WanderEndingType[];
    endingRule: string;
  };
};

const resolveWanderAiEndingMode = (input: WanderAiGenerationInput): WanderAiEndingMode => {
  if (!input.canEndThisEpisode) {
    return 'must_continue';
  }
  if (input.nextEpisodeIndex >= input.maxEpisodeIndex) {
    return 'must_end';
  }
  return 'can_continue_or_end';
};

const WANDER_OPTION_EXAMPLE: [string, string, string] = [
  '先借檐避雨，再试探来意',
  '绕到桥下暗查灵息',
  '收敛气机，静观其变',
];
const WANDER_STORY_THEME_EXAMPLE = '雨夜借灯';
const WANDER_STORY_THEME_STYLE_RULE = 'storyTheme 必须是 24 字内主题短词，只概括这一幕或这条故事线的意象母题，像“雨夜借灯”“荒祠问卜”，禁止把剧情摘要直接写进 storyTheme，也不要写完整事件经过或长句解释。';
const WANDER_OPTION_STYLE_RULE = 'optionTexts 必须是长度恰好为 3 的字符串数组，每个元素都必须是非空短句，禁止返回空字符串、null、对象、嵌套数组或把三个选项拼成一个字符串。';
const WANDER_EPISODE_TITLE_STYLE_RULE = 'episodeTitle 必须是 24字内中文短标题，像“雨夜借灯”“断桥问剑”，禁止句子式长标题、标点堆砌和副标题。';
const WANDER_OPENING_STYLE_RULE = 'opening 必须是一段 80 到 420 字的完整正文，要交代当下场景、人物动作与异样征兆，禁止只写一句过短摘要、提纲句或纯背景说明。';
const WANDER_OPENING_EXAMPLE = '夜雨压桥，河雾顺着石栏缓缓爬起，你才在破庙檐下收住衣角，便见对岸灯影摇成一线。那人披着旧蓑衣，手里提灯不前不后，只隔着雨幕望来，像是在等谁认出他的来意；桥下水声却忽然沉了一拍，仿佛另有什么东西正贴着桥墩缓缓游过。';

const buildWanderAiEndingRuleText = (endingMode: WanderAiEndingMode): string => {
  if (endingMode === 'must_continue') {
    return '本幕禁止结束剧情：isEnding 必须为 false，endingType 必须为 none，rewardTitleName 与 rewardTitleDesc 必须为空字符串。';
  }
  if (endingMode === 'must_end') {
    return `本幕必须收束为结局：isEnding 必须为 true，endingType 只能是 ${WANDER_COMPLETED_ENDING_TYPE_VALUES.join(' / ')}，rewardTitleName 必须是 2 到 8 字中文正式称号名，rewardTitleDesc 必须是 8 到 40 字中文称号描述。`;
  }
  return '若本幕未完结，endingType 必须为 none，rewardTitleName 与 rewardTitleDesc 必须为空字符串；若本幕完结，必须给出 2 到 8 字中文正式称号名与 8 到 40 字中文称号描述。';
};

export const buildWanderAiPromptRuleSet = (endingMode: WanderAiEndingMode): WanderAiPromptRuleSet => {
  return {
    systemRules: [
      '你是《九州修仙录》的云游奇遇导演。',
      '你必须输出严格 JSON，不得输出 markdown、解释、额外注释。',
      '剧情必须是东方修仙语境，禁止现代梗、科幻设定、英文名、阿拉伯数字名。',
      '每次只写一幕剧情，正文需要留有抉择空间，但不能替玩家做选择。',
      WANDER_STORY_THEME_STYLE_RULE,
      `storyTheme 示例：${WANDER_STORY_THEME_EXAMPLE}`,
      WANDER_OPTION_STYLE_RULE,
      `optionTexts 示例：${JSON.stringify(WANDER_OPTION_EXAMPLE)}`,
      WANDER_EPISODE_TITLE_STYLE_RULE,
      WANDER_OPENING_STYLE_RULE,
      `opening 示例：${WANDER_OPENING_EXAMPLE}`,
      buildWanderAiEndingRuleText(endingMode),
      '三条选项都必须可执行、方向明确、互相有差异，不能只换措辞。',
    ],
    outputRules: {
      storyThemeLengthRange: '2-24',
      storyThemeStyleRule: WANDER_STORY_THEME_STYLE_RULE,
      storyThemeExample: WANDER_STORY_THEME_EXAMPLE,
      optionCount: WANDER_OPTION_COUNT,
      optionStyleRule: WANDER_OPTION_STYLE_RULE,
      optionExample: WANDER_OPTION_EXAMPLE,
      episodeTitleLengthRange: '2-24',
      episodeTitleStyleRule: WANDER_EPISODE_TITLE_STYLE_RULE,
      openingLengthRange: '80-420',
      openingStyleRule: WANDER_OPENING_STYLE_RULE,
      openingExample: WANDER_OPENING_EXAMPLE,
      summaryLengthRange: '20-160',
      rewardTitleNameLengthRange: '2-8',
      rewardTitleDescLengthRange: '8-40',
      endingTypeValues: WANDER_ENDING_TYPE_VALUES,
      endingRule: buildWanderAiEndingRuleText(endingMode),
    },
  };
};

export const buildWanderAiSystemMessage = (endingMode: WanderAiEndingMode): string => {
  const ruleSet = buildWanderAiPromptRuleSet(endingMode);
  return [
    ...ruleSet.systemRules,
  ].join('\n');
};

const buildWanderAiRepairSystemMessage = (endingMode: WanderAiEndingMode): string => {
  return [
    buildWanderAiSystemMessage(endingMode),
    '如果用户消息指出上一轮 JSON 的具体错误，你必须严格按该错误修正，并完整重写整个 JSON 对象。',
  ].join('\n');
};

const readString = (value: WanderAiJsonValue): string => (typeof value === 'string' ? value.trim() : '');

const readBoolean = (value: WanderAiJsonValue): boolean => value === true;

const readStringTuple3 = (value: WanderAiJsonValue): [string, string, string] | null => {
  if (!Array.isArray(value) || value.length !== WANDER_OPTION_COUNT) return null;
  const normalized = value.map((entry) => readString(entry));
  if (normalized.some((entry) => entry.length <= 0)) return null;
  return [normalized[0], normalized[1], normalized[2]];
};

const isJsonObjectRecord = (value: WanderAiJsonValue): value is TechniqueModelJsonObject => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const readEndingType = (value: WanderAiJsonValue): WanderEndingType | null => {
  const endingType = readString(value) as WanderEndingType;
  return WANDER_ENDING_TYPE_VALUES.includes(endingType) ? endingType : null;
};

const assertLengthRange = (value: string, min: number, max: number): boolean => {
  return value.length >= min && value.length <= max;
};

const parseWanderAiDraft = (data: TechniqueModelJsonObject): WanderAiDraftParseResult => {
  const storyTheme = readString(data.storyTheme ?? '');
  const storyPremise = readString(data.storyPremise ?? '');
  const episodeTitle = readString(data.episodeTitle ?? '');
  const opening = readString(data.opening ?? '');
  const summary = readString(data.summary ?? '');
  const optionTexts = readStringTuple3(data.optionTexts ?? []);
  const isEnding = readBoolean(data.isEnding ?? false);
  const endingType = readEndingType(data.endingType ?? '');
  const rewardTitleName = readString(data.rewardTitleName ?? '');
  const rewardTitleDesc = readString(data.rewardTitleDesc ?? '');

  if (
    !assertLengthRange(storyTheme, 2, 24)
  ) {
    return { success: false, reason: 'storyTheme 长度必须在 2 到 24 之间' };
  }
  if (!assertLengthRange(storyPremise, 8, 120)) {
    return { success: false, reason: 'storyPremise 长度必须在 8 到 120 之间' };
  }
  if (!assertLengthRange(episodeTitle, 2, 24)) {
    return { success: false, reason: 'episodeTitle 长度必须在 2 到 24 之间' };
  }
  if (!assertLengthRange(opening, 80, 420)) {
    return { success: false, reason: 'opening 长度必须在 80 到 420 之间' };
  }
  if (!assertLengthRange(summary, 20, 160)) {
    return { success: false, reason: 'summary 长度必须在 20 到 160 之间' };
  }
  if (optionTexts === null) {
    return { success: false, reason: `optionTexts 必须是 ${WANDER_OPTION_COUNT} 个非空字符串` };
  }
  if (endingType === null) {
    return { success: false, reason: `endingType 必须属于 ${WANDER_ENDING_TYPE_VALUES.join(' / ')}` };
  }

  if (!isEnding) {
    if (endingType !== 'none' || rewardTitleName || rewardTitleDesc) {
      return { success: false, reason: '非结局幕必须返回 endingType=none 且称号字段为空字符串' };
    }
  } else {
    if (
      endingType === 'none' ||
      !assertLengthRange(rewardTitleName, 2, 8) ||
      !assertLengthRange(rewardTitleDesc, 8, 40)
    ) {
      return { success: false, reason: '结局幕必须返回有效 endingType，并提供合法长度的称号名与称号描述' };
    }
  }

  return {
    success: true,
    data: {
      storyTheme,
      storyPremise,
      episodeTitle,
      opening,
      summary,
      optionTexts,
      isEnding,
      endingType,
      rewardTitleName,
      rewardTitleDesc,
    },
  };
};

const validateWanderAiContent = (content: string): WanderAiContentValidationResult => {
  const parsed = parseTechniqueTextModelJsonObject(content);
  if (!parsed.success || !isJsonObjectRecord(parsed.data)) {
    return { success: false, reason: '模型未返回合法 JSON 对象' };
  }

  const draft = parseWanderAiDraft(parsed.data);
  if (!draft.success) {
    return draft;
  }

  return draft;
};

const buildWanderAiResponseSchema = (endingMode: WanderAiEndingMode): TechniqueTextModelJsonSchemaObject => {
  const schema: TechniqueTextModelJsonSchemaObject = {
    type: 'object',
    additionalProperties: false,
    required: [
      'storyTheme',
      'storyPremise',
      'episodeTitle',
      'opening',
      'summary',
      'optionTexts',
      'isEnding',
      'endingType',
      'rewardTitleName',
      'rewardTitleDesc',
    ],
    properties: {
      storyTheme: { type: 'string', minLength: 2, maxLength: 24 },
      storyPremise: { type: 'string', minLength: 8, maxLength: 120 },
      episodeTitle: { type: 'string', minLength: 2, maxLength: 24 },
      opening: { type: 'string', minLength: 80, maxLength: 420 },
      summary: { type: 'string', minLength: 20, maxLength: 160 },
      optionTexts: {
        type: 'array',
        minItems: WANDER_OPTION_COUNT,
        maxItems: WANDER_OPTION_COUNT,
        items: { type: 'string', minLength: 4, maxLength: 32 },
      },
      isEnding: { type: 'boolean' },
      endingType: { type: 'string', enum: WANDER_ENDING_TYPE_VALUES },
      rewardTitleName: { type: 'string', minLength: 0, maxLength: 8 },
      rewardTitleDesc: { type: 'string', minLength: 0, maxLength: 40 },
    },
  };

  if (endingMode === 'must_continue') {
    return {
      ...schema,
      properties: {
        ...schema.properties,
        isEnding: { type: 'boolean', const: false },
        endingType: { type: 'string', enum: WANDER_NON_ENDING_TYPE_VALUES, const: 'none' },
        rewardTitleName: { type: 'string', minLength: 0, maxLength: 0 },
        rewardTitleDesc: { type: 'string', minLength: 0, maxLength: 0 },
      },
    };
  }

  if (endingMode === 'must_end') {
    return {
      ...schema,
      properties: {
        ...schema.properties,
        isEnding: { type: 'boolean', const: true },
        endingType: { type: 'string', enum: WANDER_COMPLETED_ENDING_TYPE_VALUES },
        rewardTitleName: { type: 'string', minLength: 2, maxLength: 8 },
        rewardTitleDesc: { type: 'string', minLength: 8, maxLength: 40 },
      },
    };
  }

  return schema;
};

export const buildWanderAiUserPayload = (input: WanderAiGenerationInput, seed: number): {
  promptNoiseHash: string;
  player: {
    nickname: string;
    realm: string;
    mapName: string;
    hasTeam: boolean;
  };
  story: {
    activeTheme: string | null;
    activePremise: string | null;
    storySummary: string | null;
    nextEpisodeIndex: number;
    maxEpisodeIndex: number;
    canEndThisEpisode: boolean;
    endingMode: WanderAiEndingMode;
    previousEpisodes: WanderAiPreviousEpisodeContext[];
  };
  outputRules: WanderAiPromptRuleSet['outputRules'];
} => {
  const promptNoiseHash = buildTextModelPromptNoiseHash('wander-story', seed);
  const endingMode = resolveWanderAiEndingMode(input);
  const ruleSet = buildWanderAiPromptRuleSet(endingMode);
  return {
    promptNoiseHash,
    player: {
      nickname: input.nickname,
      realm: input.realm,
      mapName: input.mapName,
      hasTeam: input.hasTeam,
    },
    story: {
      activeTheme: input.activeTheme,
      activePremise: input.activePremise,
      storySummary: input.storySummary,
      nextEpisodeIndex: input.nextEpisodeIndex,
      maxEpisodeIndex: input.maxEpisodeIndex,
      canEndThisEpisode: input.canEndThisEpisode,
      endingMode,
      previousEpisodes: input.previousEpisodes,
    },
    outputRules: ruleSet.outputRules,
  };
};

const buildWanderAiUserMessage = (input: WanderAiGenerationInput, seed: number): string => {
  return JSON.stringify(buildWanderAiUserPayload(input, seed));
};

const buildWanderAiRepairUserMessage = (
  input: WanderAiGenerationInput,
  seed: number,
  previousContent: string,
  validationReason: string,
): string => {
  const endingMode = resolveWanderAiEndingMode(input);
  const ruleSet = buildWanderAiPromptRuleSet(endingMode);
  return JSON.stringify({
    task: '你上一轮输出的 JSON 未通过校验，请基于同一幕剧情进行修正，并完整重写整个 JSON 对象。',
    validationReason,
    outputRules: ruleSet.outputRules,
    originalTask: JSON.parse(buildWanderAiUserMessage(input, seed)),
    previousOutput: previousContent,
  });
};

const buildWanderAiResponseFormat = (
  endingMode: WanderAiEndingMode,
  useStructuredSchema: boolean,
): TechniqueTextModelResponseFormat => {
  if (!useStructuredSchema) {
    return { type: 'json_object' };
  }

  return buildTechniqueTextModelJsonSchemaResponseFormat({
    name: 'wander_story_episode',
    schema: buildWanderAiResponseSchema(endingMode),
  });
};

const isUnsupportedStructuredSchemaError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  return error.message.includes('invalid_json_schema')
    || error.message.includes("'allOf' is not permitted")
    || error.message.includes('Invalid schema for response_format');
};

const requestWanderAiContent = async (params: {
  responseFormat: TechniqueTextModelResponseFormat;
  systemMessage: string;
  userMessage: string;
  seed: number;
}): Promise<string> => {
  const callResult = await callConfiguredTextModel({
    modelScope: 'wander',
    responseFormat: params.responseFormat,
    systemMessage: params.systemMessage,
    userMessage: params.userMessage,
    seed: params.seed,
    timeoutMs: WANDER_AI_TIMEOUT_MS,
  });

  if (!callResult) {
    throw new Error('未配置 AI 文本模型，无法生成云游奇遇');
  }

  return callResult.content;
};

export const isWanderAiAvailable = (): boolean => {
  return readTextModelConfig('wander') !== null;
};

export const generateWanderAiEpisodeDraft = async (
  input: WanderAiGenerationInput,
): Promise<WanderAiEpisodeDraft> => {
  const seed = generateTechniqueTextModelSeed();
  const endingMode = resolveWanderAiEndingMode(input);
  let useStructuredSchema = true;
  let latestContent = '';
  let latestFailureReason = '模型未返回合法 JSON 对象';

  for (let attempt = 1; attempt <= WANDER_AI_MAX_ATTEMPTS; attempt += 1) {
    const systemMessage = attempt === 1
      ? buildWanderAiSystemMessage(endingMode)
      : buildWanderAiRepairSystemMessage(endingMode);
    const userMessage = attempt === 1
      ? buildWanderAiUserMessage(input, seed)
      : buildWanderAiRepairUserMessage(input, seed, latestContent, latestFailureReason);

    try {
      latestContent = await requestWanderAiContent({
        responseFormat: buildWanderAiResponseFormat(endingMode, useStructuredSchema),
        systemMessage,
        userMessage,
        seed,
      });
    } catch (error) {
      if (useStructuredSchema && isUnsupportedStructuredSchemaError(error)) {
        useStructuredSchema = false;
        latestFailureReason = '当前模型端不支持本次结构化 schema，已改为普通 JSON 输出，请严格按规则完整重写 JSON。';
        latestContent = '';
        attempt -= 1;
        continue;
      }
      throw error;
    }

    const validation = validateWanderAiContent(latestContent);
    if (validation.success) {
      return validation.data;
    }

    latestFailureReason = validation.reason;
  }

  throw new Error(`云游奇遇模型返回字段不符合业务约束：${latestFailureReason}`);
};
