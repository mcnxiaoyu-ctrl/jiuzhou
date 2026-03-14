/**
 * Buff 结构化配置工具
 *
 * 作用：
 * 1) 统一解析与归一化 buffKind / attrKey / applyType / buffKey；
 * 2) 提供跨模块复用的默认规则（属性别名、默认百分比属性集合）。
 *
 * 不做什么：
 * 1) 不执行具体 Buff 结算；
 * 2) 不依赖战斗状态，不读写 BattleUnit。
 *
 * 输入/输出：
 * - 输入：配置层字段（unknown/string）与最小 effect 元信息。
 * - 输出：归一化后的结构化值（BuffKind、attrKey、applyType、buffKey）。
 *
 * 数据流：
 * - 静态配置/动态技能效果 -> 本模块归一化 -> 战斗执行层按 kind 分发处理。
 *
 * 边界条件与坑点：
 * 1) buffKind 使用可扩展字符串联合，未知 kind 不报错但由上层决定是否忽略。
 * 2) attrKey 会做别名映射与连字符归一，避免配置同义词导致运行时键不一致。
 */

export const STRUCTURED_BUFF_KIND_LIST = [
  'attr',
  'dot',
  'hot',
  'dodge_next',
  'reflect_damage',
  'heal_forbid',
  'next_skill_bonus',
  'aura',
] as const;
export type SupportedBuffKind = typeof STRUCTURED_BUFF_KIND_LIST[number];
export type BuffKind = SupportedBuffKind | (string & {});

export const BUFF_APPLY_TYPE_LIST = ['flat', 'percent'] as const;
export type BuffApplyType = typeof BUFF_APPLY_TYPE_LIST[number];

export const DEFAULT_PERCENT_BUFF_ATTR_SET: ReadonlySet<string> = new Set([
  'wugong',
  'fagong',
  'wufang',
  'fafang',
]);

const BUFF_ATTR_ALIAS: Record<string, string> = {
  'max-lingqi': 'max_lingqi',
  'max-qixue': 'max_qixue',
  'qixue-huifu': 'qixue_huifu',
  'lingqi-huifu': 'lingqi_huifu',
  'kongzhi-kangxing': 'kongzhi_kangxing',
  'jin-kangxing': 'jin_kangxing',
  'mu-kangxing': 'mu_kangxing',
  'shui-kangxing': 'shui_kangxing',
  'huo-kangxing': 'huo_kangxing',
  'tu-kangxing': 'tu_kangxing',
};

const toNonEmptyLowerText = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const text = value.trim().toLowerCase();
  return text.length > 0 ? text : '';
};

export function normalizeBuffKind(raw: unknown): BuffKind | null {
  const kind = toNonEmptyLowerText(raw);
  return kind ? (kind as BuffKind) : null;
}

export function normalizeBuffAttrKey(raw: unknown): string {
  const lowered = toNonEmptyLowerText(raw);
  if (!lowered) return '';
  const aliased = BUFF_ATTR_ALIAS[lowered] ?? lowered;
  return aliased.replace(/-/g, '_');
}

export function normalizeBuffApplyType(raw: unknown): BuffApplyType | null {
  const applyType = toNonEmptyLowerText(raw);
  if (applyType === 'flat') return 'flat';
  if (applyType === 'percent') return 'percent';
  return null;
}

export function resolveBuffEffectKey(effect: {
  type: 'buff' | 'debuff';
  buffKey?: unknown;
  buffKind?: unknown;
  attrKey?: unknown;
}): string {
  const explicitKey = toNonEmptyLowerText(effect.buffKey);
  if (explicitKey) return explicitKey;

  const kind = normalizeBuffKind(effect.buffKind);
  if (!kind) return '';

  if (kind === 'attr') {
    const attrKey = normalizeBuffAttrKey(effect.attrKey);
    return attrKey ? `${effect.type}-${attrKey}` : `${effect.type}-attr`;
  }

  return `${effect.type}-${kind}`;
}

export function resolveSignedAttrValue(effectType: 'buff' | 'debuff', rawValue: unknown): number {
  const value = typeof rawValue === 'number' && Number.isFinite(rawValue)
    ? rawValue
    : typeof rawValue === 'string'
      ? Number(rawValue)
      : 0;
  const absValue = Number.isFinite(value) ? Math.abs(value) : 0;
  if (absValue <= 0) return 0;
  return effectType === 'debuff' ? -absValue : absValue;
}
