/**
 * 伙伴名字共享规则
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中维护伙伴改名的裁剪、长度与敏感词校验，供伙伴改名服务复用，避免路由和服务各写一遍。
 * 2. 做什么：输出稳定中文错误文案，让前端表单与服务端权威校验保持同一口径。
 * 3. 不做什么：不处理易名符扣除、不校验伙伴归属，也不做伙伴重名限制。
 *
 * 输入/输出：
 * - 输入：原始伙伴名字符串。
 * - 输出：归一化后的合法伙伴名，或统一失败结果。
 *
 * 数据流/状态流：
 * 原始输入 -> 首尾空白裁剪 -> 长度校验 -> 敏感词校验 -> 伙伴改名服务消费。
 *
 * 关键边界条件与坑点：
 * 1. 伙伴改名不做重名校验，因此这里只负责文本合法性，不能偷偷引入全表查重分支。
 * 2. 长度判断必须复用共享 2-12 字符规则，否则角色改名与伙伴改名会出现不同口径。
 */
import { guardSensitiveText } from '../sensitiveWordService.js';
import {
  buildNameLengthMessage,
  getNameLengthError,
  normalizeCharacterNicknameInput,
} from './characterNameRules.js';

export const PARTNER_NAME_REQUIRED_MESSAGE = '伙伴名不能为空';
export const PARTNER_NAME_LENGTH_MESSAGE = buildNameLengthMessage('伙伴名');
export const PARTNER_NAME_SENSITIVE_MESSAGE = '伙伴名包含敏感词，请重新输入';
export const PARTNER_NAME_SENSITIVE_UNAVAILABLE_MESSAGE = '敏感词检测服务暂不可用，请稍后重试';

type PartnerNameValidationResult =
  | {
      success: true;
      nickname: string;
    }
  | {
      success: false;
      message: string;
    };

export const normalizePartnerNameInput = (nickname: string): string => {
  return normalizeCharacterNicknameInput(nickname);
};

export const getPartnerNameLengthError = (nickname: string): string | null => {
  return getNameLengthError(nickname, '伙伴名');
};

export const validatePartnerName = async (
  nickname: string,
): Promise<PartnerNameValidationResult> => {
  const normalizedNickname = normalizePartnerNameInput(nickname);
  if (!normalizedNickname) {
    return { success: false, message: PARTNER_NAME_REQUIRED_MESSAGE };
  }

  const lengthError = getPartnerNameLengthError(normalizedNickname);
  if (lengthError) {
    return { success: false, message: lengthError };
  }

  const sensitiveGuard = await guardSensitiveText(
    normalizedNickname,
    PARTNER_NAME_SENSITIVE_MESSAGE,
    PARTNER_NAME_SENSITIVE_UNAVAILABLE_MESSAGE,
  );
  if (!sensitiveGuard.success) {
    return { success: false, message: sensitiveGuard.message };
  }

  return {
    success: true,
    nickname: normalizedNickname,
  };
};
