/**
 * 角色道号共享规则
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中维护角色道号的长度、裁剪、敏感词、重名校验，供创角与改名共用，避免同一规则散落在路由和服务里。
 * 2. 做什么：输出稳定的中文错误文案，确保前后端在“长度非法 / 敏感词 / 已重名”时口径一致。
 * 3. 不做什么：不负责性别、物品实例等与道号无关的业务校验，也不推送角色更新。
 *
 * 输入/输出：
 * - 输入：原始道号字符串，以及可选的“排除自身角色 ID”参数。
 * - 输出：归一化后的合法道号，或统一的失败结果。
 *
 * 数据流/状态流：
 * 原始输入 -> 首尾空白裁剪 -> 长度校验 -> 敏感词校验 -> 重名校验 -> 创角/改名服务消费。
 *
 * 关键边界条件与坑点：
 * 1. 所有长度判断都必须基于裁剪后的值，否则创角表单、创角服务、改名服务会各算各的。
 * 2. 改名时必须排除当前角色自身，否则“改成当前名字”会被误判为重名。
 */
import { query } from '../../config/database.js';
import { guardSensitiveText } from '../sensitiveWordService.js';

export const NAME_MIN_LENGTH = 2;
export const NAME_MAX_LENGTH = 12;
export const CHARACTER_NICKNAME_REQUIRED_MESSAGE = '道号不能为空';
export const buildNameLengthMessage = (label: string): string => {
  return `${label}需${NAME_MIN_LENGTH}-${NAME_MAX_LENGTH}个字符`;
};

export const CHARACTER_NICKNAME_MIN_LENGTH = NAME_MIN_LENGTH;
export const CHARACTER_NICKNAME_MAX_LENGTH = NAME_MAX_LENGTH;
export const CHARACTER_NICKNAME_LENGTH_MESSAGE = buildNameLengthMessage('道号');
export const CHARACTER_NICKNAME_DUPLICATE_MESSAGE = '该道号已被使用';
export const CHARACTER_NICKNAME_SENSITIVE_MESSAGE = '道号包含敏感词，请重新输入';
export const CHARACTER_NICKNAME_SENSITIVE_UNAVAILABLE_MESSAGE = '敏感词检测服务暂不可用，请稍后重试';

type CharacterNicknameValidationResult =
  | {
      success: true;
      nickname: string;
    }
  | {
      success: false;
      message: string;
    };

export const normalizeCharacterNicknameInput = (nickname: string): string => {
  return String(nickname || '').trim();
};

export const getNameLengthError = (nickname: string, label: string): string | null => {
  const normalizedNickname = normalizeCharacterNicknameInput(nickname);
  const nicknameLength = normalizedNickname.length;
  if (
    nicknameLength < NAME_MIN_LENGTH ||
    nicknameLength > NAME_MAX_LENGTH
  ) {
    return buildNameLengthMessage(label);
  }
  return null;
};

export const getCharacterNicknameLengthError = (nickname: string): string | null => {
  return getNameLengthError(nickname, '道号');
};

export const validateCharacterNickname = async (
  nickname: string,
  options?: { excludeCharacterId?: number },
): Promise<CharacterNicknameValidationResult> => {
  const normalizedNickname = normalizeCharacterNicknameInput(nickname);
  if (!normalizedNickname) {
    return { success: false, message: CHARACTER_NICKNAME_REQUIRED_MESSAGE };
  }

  const lengthError = getCharacterNicknameLengthError(normalizedNickname);
  if (lengthError) {
    return { success: false, message: lengthError };
  }

  const sensitiveGuard = await guardSensitiveText(
    normalizedNickname,
    CHARACTER_NICKNAME_SENSITIVE_MESSAGE,
    CHARACTER_NICKNAME_SENSITIVE_UNAVAILABLE_MESSAGE,
  );
  if (!sensitiveGuard.success) {
    return { success: false, message: sensitiveGuard.message };
  }

  const excludeCharacterId = Number(options?.excludeCharacterId);
  const hasExcludedCharacterId = Number.isInteger(excludeCharacterId) && excludeCharacterId > 0;
  const duplicateResult = hasExcludedCharacterId
    ? await query(
        'SELECT id FROM characters WHERE nickname = $1 AND id <> $2 LIMIT 1',
        [normalizedNickname, excludeCharacterId],
      )
    : await query('SELECT id FROM characters WHERE nickname = $1 LIMIT 1', [normalizedNickname]);

  if (duplicateResult.rows.length > 0) {
    return { success: false, message: CHARACTER_NICKNAME_DUPLICATE_MESSAGE };
  }

  return {
    success: true,
    nickname: normalizedNickname,
  };
};
