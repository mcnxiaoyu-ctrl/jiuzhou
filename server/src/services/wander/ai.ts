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
  mainQuestName: string;
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
const WANDER_AI_TIMEOUT_MS = 20_000;
const WANDER_ENDING_TYPE_VALUES: WanderEndingType[] = ['none', 'good', 'neutral', 'tragic', 'bizarre'];

const WANDER_AI_SYSTEM_MESSAGE = [
  '你是《九州修仙录》的云游奇遇导演。',
  '你必须输出严格 JSON，不得输出 markdown、解释、额外注释。',
  '剧情必须是东方修仙语境，禁止现代梗、科幻设定、英文名、阿拉伯数字名。',
  '每次只写一幕剧情，正文需要留有抉择空间，但不能替玩家做选择。',
  '若本幕未完结，endingType 必须为 none，rewardTitleName 与 rewardTitleDesc 必须为空字符串。',
  '若本幕完结，必须给出一个 2 到 8 字的中文正式称号名，以及 8 到 40 字的中文称号描述。',
  '三条选项都必须可执行、方向明确、互相有差异，不能只换措辞。',
].join('\n');

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

const parseWanderAiDraft = (data: TechniqueModelJsonObject): WanderAiEpisodeDraft | null => {
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
    !assertLengthRange(storyTheme, 2, 24) ||
    !assertLengthRange(storyPremise, 8, 120) ||
    !assertLengthRange(episodeTitle, 2, 24) ||
    !assertLengthRange(opening, 80, 420) ||
    !assertLengthRange(summary, 20, 160) ||
    optionTexts === null ||
    endingType === null
  ) {
    return null;
  }

  if (!isEnding) {
    if (endingType !== 'none' || rewardTitleName || rewardTitleDesc) {
      return null;
    }
  } else {
    if (
      endingType === 'none' ||
      !assertLengthRange(rewardTitleName, 2, 8) ||
      !assertLengthRange(rewardTitleDesc, 8, 40)
    ) {
      return null;
    }
  }

  return {
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
  };
};

const buildWanderAiUserMessage = (input: WanderAiGenerationInput, seed: number): string => {
  const promptNoiseHash = buildTextModelPromptNoiseHash('wander-story', seed);
  return JSON.stringify({
    promptNoiseHash,
    player: {
      nickname: input.nickname,
      realm: input.realm,
      mapName: input.mapName,
      mainQuestName: input.mainQuestName,
      hasTeam: input.hasTeam,
    },
    story: {
      activeTheme: input.activeTheme,
      activePremise: input.activePremise,
      storySummary: input.storySummary,
      nextEpisodeIndex: input.nextEpisodeIndex,
      maxEpisodeIndex: input.maxEpisodeIndex,
      canEndThisEpisode: input.canEndThisEpisode,
      previousEpisodes: input.previousEpisodes,
    },
    outputRules: {
      optionCount: WANDER_OPTION_COUNT,
      openingLengthRange: '80-420',
      summaryLengthRange: '20-160',
      rewardTitleNameLengthRange: '2-8',
      rewardTitleDescLengthRange: '8-40',
      endingTypeValues: WANDER_ENDING_TYPE_VALUES,
    },
  });
};

export const isWanderAiAvailable = (): boolean => {
  return readTextModelConfig() !== null;
};

export const generateWanderAiEpisodeDraft = async (
  input: WanderAiGenerationInput,
): Promise<WanderAiEpisodeDraft> => {
  const seed = generateTechniqueTextModelSeed();
  const callResult = await callConfiguredTextModel({
    responseFormat: buildTechniqueTextModelJsonSchemaResponseFormat({
      name: 'wander_story_episode',
      schema: {
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
      },
    }),
    systemMessage: WANDER_AI_SYSTEM_MESSAGE,
    userMessage: buildWanderAiUserMessage(input, seed),
    seed,
    timeoutMs: WANDER_AI_TIMEOUT_MS,
  });

  if (!callResult) {
    throw new Error('未配置 AI 文本模型，无法生成云游奇遇');
  }

  const parsed = parseTechniqueTextModelJsonObject(callResult.content);
  if (!parsed.success || !isJsonObjectRecord(parsed.data)) {
    throw new Error('云游奇遇模型未返回合法 JSON');
  }

  const draft = parseWanderAiDraft(parsed.data);
  if (!draft) {
    throw new Error('云游奇遇模型返回字段不符合业务约束');
  }

  return draft;
};
