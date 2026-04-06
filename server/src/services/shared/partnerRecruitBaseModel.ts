/**
 * 伙伴招募基础类型共享模块
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：集中读取 `partner_base_models.txt`，并基于固定 seed 或玩家自定义输入解析本次伙伴招募应使用的基础类型。
 * 2) 做什么：把自定义底模的规范化、格式校验与敏感词校验收口到单一入口，避免路由、service、worker 各写一套文本规则。
 * 3) 不做什么：不调用 AI、不拼接业务 prompt，也不把基础类型写入数据库。
 *
 * 输入/输出：
 * - 输入：数值 seed，或玩家输入的自定义底模文本。
 * - 输出：`partner_base_models.txt` 中按 seed 映射出的单个基础类型文本，或通过格式与敏感词校验的自定义底模文本。
 *
 * 数据流/状态流：
 * partner_base_models.txt / 玩家输入 -> 本模块规范化、格式校验、敏感词校验 -> resolvePartnerRecruitBaseModel -> 伙伴招募 prompt 构造。
 *
 * 关键边界条件与坑点：
 * 1) 种子文件允许重复项；这里按原始行保留重复，避免意外改变已有权重分布。
 * 2) 缺文件或空文件必须直接抛错，不能偷偷兜底成人类或其他默认类型，否则会把配置问题伪装成正常生成。
 * 3) 自定义底模会进入模型提示词，必须限制为短中文名词，并在落库前完成敏感词拦截，禁止把违规文本带进 prompt 或任务记录。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardSensitiveText } from '../sensitiveWordService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PARTNER_BASE_MODEL_FILENAME = 'partner_base_models.txt';
const PARTNER_BASE_MODEL_SEED_DIR = [
  path.join(process.cwd(), 'server', 'src', 'data', 'seeds'),
  path.join(process.cwd(), 'src', 'data', 'seeds'),
  path.join(process.cwd(), 'dist', 'data', 'seeds'),
  path.join(__dirname, '../../data/seeds'),
].find((candidatePath) => fs.existsSync(candidatePath));

let cachedPartnerRecruitBaseModels: string[] | null = null;

export const PARTNER_RECRUIT_CUSTOM_BASE_MODEL_MAX_LENGTH = 12;
export const PARTNER_RECRUIT_CUSTOM_BASE_MODEL_SENSITIVE_MESSAGE = '自定义底模包含敏感词，请重新输入';
export const PARTNER_RECRUIT_CUSTOM_BASE_MODEL_SENSITIVE_UNAVAILABLE_MESSAGE = '敏感词检测服务暂不可用，请稍后重试';
export const PARTNER_RECRUIT_CUSTOM_BASE_MODEL_TOKEN_ITEM_DEF_ID = 'token-004';
export const PARTNER_RECRUIT_CUSTOM_BASE_MODEL_TOKEN_COST = 1;
export const PARTNER_RECRUIT_CUSTOM_BASE_MODEL_BYPASSES_COOLDOWN = true;

const PARTNER_RECRUIT_CUSTOM_BASE_MODEL_PATTERN = /^[\p{Script=Han}]+$/u;

export type PartnerRecruitRequestedBaseModelValidationResult =
  | { success: true; value: string | null }
  | { success: false; message: string };

export type PartnerRecruitResolvedBaseModel = {
  requestedBaseModel: string | null;
  baseModel: string;
  isCustom: boolean;
};

const getTextLength = (value: string): number => {
  return Array.from(value).length;
};

export const hasPartnerRecruitCustomBaseModel = (
  requestedBaseModel: string | null | undefined,
): boolean => {
  return typeof requestedBaseModel === 'string' && requestedBaseModel.trim().length > 0;
};

export const shouldPartnerRecruitUseCustomBaseModelToken = (
  customBaseModelEnabled: boolean,
): boolean => {
  return customBaseModelEnabled;
};

export const shouldPartnerRecruitBypassCooldownWithCustomBaseModel = (
  customBaseModelEnabled: boolean,
): boolean => {
  return PARTNER_RECRUIT_CUSTOM_BASE_MODEL_BYPASSES_COOLDOWN
    && shouldPartnerRecruitUseCustomBaseModelToken(customBaseModelEnabled);
};

const resolvePartnerRecruitBaseModelPath = (): string => {
  if (!PARTNER_BASE_MODEL_SEED_DIR) {
    throw new Error(`${PARTNER_BASE_MODEL_FILENAME} 目录不存在`);
  }
  return path.join(PARTNER_BASE_MODEL_SEED_DIR, PARTNER_BASE_MODEL_FILENAME);
};

export const loadPartnerRecruitBaseModels = (): string[] => {
  if (cachedPartnerRecruitBaseModels) {
    return cachedPartnerRecruitBaseModels;
  }

  const filePath = resolvePartnerRecruitBaseModelPath();
  if (!fs.existsSync(filePath)) {
    throw new Error(`${PARTNER_BASE_MODEL_FILENAME} 不存在`);
  }

  const baseModels = fs.readFileSync(filePath, 'utf-8')
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (baseModels.length <= 0) {
    throw new Error(`${PARTNER_BASE_MODEL_FILENAME} 不能为空`);
  }

  cachedPartnerRecruitBaseModels = baseModels;
  return cachedPartnerRecruitBaseModels;
};

export const resolvePartnerRecruitBaseModelBySeed = (seed: number): string => {
  if (!Number.isFinite(seed)) {
    throw new Error('伙伴招募基础类型 seed 非法');
  }

  const baseModels = loadPartnerRecruitBaseModels();
  const normalizedSeed = Math.trunc(seed);
  const index = ((normalizedSeed % baseModels.length) + baseModels.length) % baseModels.length;
  const baseModel = baseModels[index];
  if (!baseModel) {
    throw new Error('伙伴招募基础类型索引越界');
  }
  return baseModel;
};

export const validatePartnerRecruitRequestedBaseModel = (
  raw: string | null | undefined,
): PartnerRecruitRequestedBaseModelValidationResult => {
  if (typeof raw !== 'string') {
    return {
      success: true,
      value: null,
    };
  }

  const value = raw.trim();
  if (!value) {
    return {
      success: true,
      value: null,
    };
  }

  if (getTextLength(value) > PARTNER_RECRUIT_CUSTOM_BASE_MODEL_MAX_LENGTH) {
    return {
      success: false,
      message: `自定义底模最多 ${PARTNER_RECRUIT_CUSTOM_BASE_MODEL_MAX_LENGTH} 个中文字符`,
    };
  }

  if (!PARTNER_RECRUIT_CUSTOM_BASE_MODEL_PATTERN.test(value)) {
    return {
      success: false,
      message: '自定义底模只能包含中文字符',
    };
  }

  return {
    success: true,
    value,
  };
};

export const guardPartnerRecruitRequestedBaseModel = async (
  raw: string | null | undefined,
): Promise<PartnerRecruitRequestedBaseModelValidationResult> => {
  const validation = validatePartnerRecruitRequestedBaseModel(raw);
  if (!validation.success || !validation.value) {
    return validation;
  }

  const sensitiveGuard = await guardSensitiveText(
    validation.value,
    PARTNER_RECRUIT_CUSTOM_BASE_MODEL_SENSITIVE_MESSAGE,
    PARTNER_RECRUIT_CUSTOM_BASE_MODEL_SENSITIVE_UNAVAILABLE_MESSAGE,
  );
  if (!sensitiveGuard.success) {
    return {
      success: false,
      message: sensitiveGuard.message,
    };
  }

  return validation;
};

export const validatePartnerRecruitRequestedBaseModelSelection = async (
  requestedBaseModel: string | null | undefined,
): Promise<PartnerRecruitRequestedBaseModelValidationResult> => {
  return guardPartnerRecruitRequestedBaseModel(requestedBaseModel);
};

export const resolvePartnerRecruitBaseModel = (params: {
  seed: number;
  requestedBaseModel?: string | null;
}): PartnerRecruitResolvedBaseModel => {
  const validation = validatePartnerRecruitRequestedBaseModel(params.requestedBaseModel);
  if (!validation.success) {
    throw new Error(validation.message);
  }

  if (validation.value) {
    return {
      requestedBaseModel: validation.value,
      baseModel: validation.value,
      isCustom: true,
    };
  }

  return {
    requestedBaseModel: null,
    baseModel: resolvePartnerRecruitBaseModelBySeed(params.seed),
    isCustom: false,
  };
};
