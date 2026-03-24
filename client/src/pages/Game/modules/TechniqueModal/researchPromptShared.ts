/**
 * 洞府研修焚诀前端共享模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中处理焚诀输入的前端裁剪、长度统计、请求值转换与提示文案，避免 `TechniqueModal` 和 `ResearchPanel` 各写一套。
 * 2. 做什么：为输入框和任务结果展示提供统一文案入口，让“留空随机、最多 2 个中文字符”的交互语义只维护一次。
 * 3. 不做什么：不直接发请求、不持有 React 状态，也不替代服务端最终校验。
 *
 * 输入/输出：
 * - 输入：玩家在输入框中的原始文本，或任务状态里的已选焚诀。
 * - 输出：裁剪后的输入值、请求值、字符计数与展示文案。
 *
 * 数据流/状态流：
 * Input 原始值 -> 本模块规范化 -> TechniqueModal 状态 / 生成请求 / 研修结果展示。
 *
 * 关键边界条件与坑点：
 * 1. 前端裁剪只负责帮助玩家更顺手地输入，不能替代服务端校验；真正的合法性仍以后端共享规则为准。
 * 2. 输入与任务回显必须共用同一套标签文案，否则玩家会看到“提交时叫焚诀、结果里又换了名字”的语义分叉。
 */

const TECHNIQUE_RESEARCH_BURNING_WORD_CHAR_PATTERN = /^[\p{Script=Han}]$/u;

export const normalizeTechniqueResearchBurningWordInput = (
  raw: string,
  maxLength: number,
): string => {
  if (!raw) return '';
  const hanChars = Array.from(raw.trim()).filter((char) => {
    return TECHNIQUE_RESEARCH_BURNING_WORD_CHAR_PATTERN.test(char);
  });
  return hanChars.slice(0, Math.max(0, maxLength)).join('');
};

export const getTechniqueResearchBurningWordInputLength = (value: string): number => {
  return Array.from(value).length;
};

export const resolveTechniqueResearchBurningWordRequestValue = (
  value: string,
): string | undefined => {
  const normalized = value.trim();
  return normalized || undefined;
};

export const buildTechniqueResearchBurningWordHelperText = (
  maxLength: number,
): string => {
  return `留空则随机；填写后会按该焚诀收束本次功法意象与风格，不会突破原有强度规则，最多 ${maxLength} 个中文字符。`;
};

export const buildTechniqueResearchBurningWordTagText = (
  burningWordPrompt: string,
): string => {
  return `焚诀 ${burningWordPrompt}`;
};
