import type { EquipmentAffixTextInput } from './equipmentAffixText';

/**
 * 物品元信息格式化工具。
 * 作用：统一物品描述中的文本清洗、行数截断、属性百分比键与词条解析逻辑。
 * 输入：后端返回的任意结构化数据（对象、数组、JSON 字符串等）。
 * 输出：可直接给 UI 展示层消费的标准化结果。
 * 关键约束：不改业务语义，只做“展示层可复用”的纯函数抽取。
 */

const hasLatinLetters = (value: string): boolean => /[A-Za-z]/.test(value);

/**
 * 统一字符串清洗：仅接受字符串并做 trim。
 */
export const normalizeText = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value.trim();
};

/**
 * 统一单值展示文本：
 * 1) null/undefined => "-"
 * 2) 英文串默认不直接展示（返回空字符串）
 * 3) number/boolean/bigint => 转字符串
 */
export const formatScalar = (value: unknown): string => {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return '';
    if (hasLatinLetters(text)) return '';
    return text;
  }
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value);
  }
  return '';
};

/**
 * 百分比属性键集合。
 * 说明：这些键在展示时应走 `formatSignedPercent` 而不是 `formatSignedNumber`。
 */
export const PERCENT_ATTR_KEYS: ReadonlySet<string> = new Set<string>([
  'shuxing_shuzhi',
  'mingzhong',
  'shanbi',
  'zhaojia',
  'baoji',
  'baoshang',
  'kangbao',
  'zengshang',
  'zhiliao',
  'jianliao',
  'xixue',
  'lengque',
  'kongzhi_kangxing',
  'jin_kangxing',
  'mu_kangxing',
  'shui_kangxing',
  'huo_kangxing',
  'tu_kangxing',
]);

/**
 * 截断文本行数，超出上限时追加省略号。
 */
export const limitLines = (lines: string[], maxLines: number): string[] => {
  const max = Math.max(0, Math.floor(maxLines || 0));
  if (max <= 0) return [];
  if (lines.length <= max) return lines;
  return [...lines.slice(0, max), '…'];
};

/**
 * 将后端词条数据标准化为 EquipmentAffixTextInput[]。
 * 支持输入 JSON 字符串或数组；无法解析时返回空数组。
 */
export const coerceAffixes = (value: unknown): EquipmentAffixTextInput[] => {
  if (!value) return [];

  let rows: unknown = value;
  if (typeof rows === 'string') {
    try {
      rows = JSON.parse(rows) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(rows)) return [];

  return rows
    .map<EquipmentAffixTextInput | null>((row) => {
      if (!row || typeof row !== 'object') return null;
      const raw = row as Record<string, unknown>;

      const tier =
        typeof raw.tier === 'number'
          ? raw.tier
          : typeof raw.tier === 'string'
          ? Number(raw.tier)
          : undefined;
      const parsedValue =
        typeof raw.value === 'number'
          ? raw.value
          : typeof raw.value === 'string'
          ? Number(raw.value)
          : undefined;
      const parsedRollRatio =
        typeof raw.roll_ratio === 'number'
          ? raw.roll_ratio
          : typeof raw.roll_ratio === 'string'
          ? Number(raw.roll_ratio)
          : undefined;
      const parsedRollPercent =
        typeof raw.roll_percent === 'number'
          ? raw.roll_percent
          : typeof raw.roll_percent === 'string'
          ? Number(raw.roll_percent)
          : undefined;

      const modifiersRaw = Array.isArray(raw.modifiers) ? raw.modifiers : [];
      const modifierKeys = new Set<string>();
      const modifiers: Array<{ attr_key: string; value: number }> = [];
      for (const modifierRow of modifiersRaw) {
        if (!modifierRow || typeof modifierRow !== 'object') continue;
        const modifier = modifierRow as Record<string, unknown>;
        const attrKey =
          typeof modifier.attr_key === 'string' ? modifier.attr_key.trim() : '';
        const modifierValue =
          typeof modifier.value === 'number'
            ? modifier.value
            : typeof modifier.value === 'string'
            ? Number(modifier.value)
            : NaN;
        if (!attrKey || modifierKeys.has(attrKey)) continue;
        if (!Number.isFinite(modifierValue)) continue;
        modifierKeys.add(attrKey);
        modifiers.push({ attr_key: attrKey, value: modifierValue });
      }

      return {
        key: typeof raw.key === 'string' ? raw.key : undefined,
        name: typeof raw.name === 'string' ? raw.name : undefined,
        modifiers: modifiers.length > 0 ? modifiers : undefined,
        apply_type:
          typeof raw.apply_type === 'string' ? raw.apply_type : undefined,
        tier: Number.isFinite(tier ?? NaN) ? tier : undefined,
        value: Number.isFinite(parsedValue ?? NaN) ? parsedValue : undefined,
        roll_ratio: Number.isFinite(parsedRollRatio ?? NaN)
          ? Math.max(0, Math.min(1, parsedRollRatio ?? 0))
          : undefined,
        roll_percent: Number.isFinite(parsedRollPercent ?? NaN)
          ? Math.max(0, Math.min(100, parsedRollPercent ?? 0))
          : undefined,
        value_type:
          typeof raw.value_type === 'string' ? raw.value_type : undefined,
        rating_attr_key:
          typeof raw.rating_attr_key === 'string'
            ? raw.rating_attr_key
            : undefined,
        is_legendary:
          typeof raw.is_legendary === 'boolean' ? raw.is_legendary : undefined,
        description:
          typeof raw.description === 'string' ? raw.description : undefined,
      };
    })
    .filter((item): item is EquipmentAffixTextInput => Boolean(item));
};
