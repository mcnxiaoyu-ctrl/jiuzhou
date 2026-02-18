/**
 * 作用：统一生成装备词条展示文本，避免各弹窗各写一套拼接逻辑。
 * 输入：词条对象（名称、属性键、类型、数值、阶数）和展示选项（前缀、翻译映射、数值格式化函数）。
 * 输出：用于 UI 的标题文本、数值文本、整行文本；当无法得到可展示名称时返回 null。
 * 注意：这里仅处理“展示文案”，不负责词条解析、排序、鉴定状态判断。
 */

export type EquipmentAffixTextInput = {
  modifiers?: Array<{
    attr_key?: string;
    value?: number;
  }>;
  key?: string;
  name?: string;
  apply_type?: string;
  tier?: number;
  value?: number;
  roll_ratio?: number;
  roll_percent?: number;
  value_type?: 'raw' | 'rating' | string;
  rating_attr_key?: string;
  is_legendary?: boolean;
  description?: string;
};

export type PickEquipmentAffixLabelOptions = {
  keyLabelMap?: Readonly<Record<string, string>>;
  keyTranslator?: (key: string) => string | null | undefined;
  fallbackLabel?: string;
  rejectLatinLabel?: boolean;
};

export type BuildEquipmentAffixDisplayTextOptions =
  PickEquipmentAffixLabelOptions & {
    normalPrefix: string;
    legendaryPrefix: string;
    percentKeys: ReadonlySet<string>;
    formatSignedNumber: (value: number) => string;
    formatSignedPercent: (value: number) => string;
  };

export type EquipmentAffixDisplayText = {
  label: string;
  prefixText: string;
  tierText: string;
  titleText: string;
  valueText: string;
  fullText: string;
};

const hasLatinLetters = (value: string): boolean => /[A-Za-z]/.test(value);
const RATING_SUFFIX = '_rating';

const normalizeText = (value: string | undefined): string => {
  if (typeof value !== 'string') return '';
  return value.trim();
};

const pickPrimaryModifierAttrKey = (affix: EquipmentAffixTextInput): string => {
  const rows = Array.isArray(affix.modifiers) ? affix.modifiers : [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const key = normalizeText(typeof row.attr_key === 'string' ? row.attr_key : undefined);
    if (key) return key;
  }
  return '';
};

const splitRatingKey = (attrKey: string): { isRating: boolean; baseKey: string } => {
  if (!attrKey.endsWith(RATING_SUFFIX)) {
    return { isRating: false, baseKey: attrKey };
  }
  const baseKey = attrKey.slice(0, -RATING_SUFFIX.length).trim();
  if (!baseKey) return { isRating: false, baseKey: attrKey };
  return { isRating: true, baseKey };
};

const tryPickLabel = (raw: string, rejectLatinLabel: boolean): string => {
  const text = raw.trim();
  if (!text) return '';
  if (rejectLatinLabel && hasLatinLetters(text)) return '';
  return text;
};

export const pickEquipmentAffixLabel = (
  affix: EquipmentAffixTextInput,
  options: PickEquipmentAffixLabelOptions = {},
): string => {
  const rejectLatinLabel = options.rejectLatinLabel === true;
  const attrKey = pickPrimaryModifierAttrKey(affix);
  const { isRating, baseKey } = splitRatingKey(attrKey);
  const candidateKeys = isRating ? [attrKey, baseKey] : [attrKey];

  for (const candidateKey of candidateKeys) {
    if (!candidateKey) continue;
    const mapped = options.keyLabelMap?.[candidateKey];
    if (typeof mapped === 'string') {
      const text = tryPickLabel(mapped, rejectLatinLabel);
      if (text) return isRating && candidateKey === baseKey ? `${text}等级` : text;
    }
  }

  for (const candidateKey of candidateKeys) {
    if (!candidateKey || !options.keyTranslator) continue;
    const translated = options.keyTranslator(candidateKey);
    if (typeof translated === 'string') {
      const text = tryPickLabel(translated, rejectLatinLabel);
      if (text) return isRating && candidateKey === baseKey ? `${text}等级` : text;
    }
  }

  const nameText = tryPickLabel(normalizeText(affix.name), rejectLatinLabel);
  if (nameText) return nameText;

  const keyText = tryPickLabel(attrKey, rejectLatinLabel);
  if (keyText) return keyText;

  return normalizeText(options.fallbackLabel);
};

export const buildEquipmentAffixDisplayText = (
  affix: EquipmentAffixTextInput,
  options: BuildEquipmentAffixDisplayTextOptions,
): EquipmentAffixDisplayText | null => {
  const label = pickEquipmentAffixLabel(affix, options);
  if (!label) return null;

  const tierText = affix.tier ? `T${affix.tier}` : 'T-';
  const prefixText = affix.is_legendary
    ? options.legendaryPrefix
    : options.normalPrefix;
  const titleText = `${prefixText} ${tierText}：${label}`;

  let valueText = '';
  const attrKey = pickPrimaryModifierAttrKey(affix);
  const { isRating } = splitRatingKey(attrKey);
  if (affix.apply_type !== 'special' && typeof affix.value === 'number') {
    const isPercent =
      (!isRating && affix.apply_type === 'percent') ||
      (attrKey ? options.percentKeys.has(attrKey) : false);
    valueText = isPercent
      ? options.formatSignedPercent(affix.value)
      : options.formatSignedNumber(affix.value);
  }

  const fullText = valueText ? `${titleText} ${valueText}` : titleText;
  return {
    label,
    prefixText,
    tierText,
    titleText,
    valueText,
    fullText,
  };
};
