/**
 * 自动分解筛选项（前端共享）
 *
 * 作用：
 * - 统一“一级分类/子分类”的中文显示，避免各页面重复维护导致英文直出。
 * - 统一筛选值归一化，确保提交给服务端的 value 始终是稳定英文编码。
 * - 分类值完全跟随后端 taxonomy，不做别名映射与语义转换。
 *
 * 输入：
 * - 原始值列表（可能包含空值、大小写不一致、重复项）。
 *
 * 输出：
 * - 去重、转小写后的稳定数组；
 * - 用于 Select 的 options（label 中文、value 英文编码）。
 */
import {
  ITEM_CATEGORY_OPTIONS,
  ITEM_SUB_CATEGORY_LABELS,
  ITEM_SUB_CATEGORY_OPTIONS,
  ITEM_SUB_CATEGORY_VALUES_BY_CATEGORY,
  type GameItemCategory,
  type LabeledOption,
} from './itemTaxonomy';

export type AutoDisassembleBagCategory = GameItemCategory;

export const AUTO_DISASSEMBLE_CATEGORY_OPTIONS: LabeledOption[] = ITEM_CATEGORY_OPTIONS;
export const AUTO_DISASSEMBLE_SUB_CATEGORY_OPTIONS: LabeledOption[] = ITEM_SUB_CATEGORY_OPTIONS;

const getCategoryValueSet = (): Set<string> => {
  return new Set(AUTO_DISASSEMBLE_CATEGORY_OPTIONS.map((option) => option.value));
};

const getSubCategoryValueSet = (): Set<string> => {
  return new Set(AUTO_DISASSEMBLE_SUB_CATEGORY_OPTIONS.map((option) => option.value));
};

const getSubCategoryLabelMap = (): Map<string, string> => {
  return new Map(AUTO_DISASSEMBLE_SUB_CATEGORY_OPTIONS.map((option) => [option.value, option.label] as const));
};

const normalizeStringList = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of raw) {
    const value = String(row ?? '').trim().toLowerCase();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
};

export const normalizeAutoDisassembleCategoryList = (raw: unknown): string[] => {
  const categoryValueSet = getCategoryValueSet();
  return normalizeStringList(raw).filter((value) => categoryValueSet.has(value));
};

export const normalizeAutoDisassembleSubCategoryList = (raw: unknown): string[] => {
  const subCategoryValueSet = getSubCategoryValueSet();
  return normalizeStringList(raw).filter((value) => subCategoryValueSet.has(value));
};

export const getAutoDisassembleSubCategoryLabel = (subCategoryValue: string): string => {
  const normalized = String(subCategoryValue || '').trim().toLowerCase();
  if (!normalized) return '未分类';
  return ITEM_SUB_CATEGORY_LABELS[normalized] ?? getSubCategoryLabelMap().get(normalized) ?? normalized;
};

export const buildAutoDisassembleSubCategoryOptions = (rawValues: string[]): LabeledOption[] => {
  const values = normalizeStringList(rawValues);
  const options = values.map((value) => ({
    value,
    label: getAutoDisassembleSubCategoryLabel(value),
  }));
  options.sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN') || a.value.localeCompare(b.value));
  return options;
};

/**
 * 按一级分类构建“完整子类型”选项（可附加动态子类型）
 *
 * 输入：
 * - category：当前一级分类
 * - extraRawValues：额外子类型（通常来自背包实时数据，用于兜住未来新增值）
 *
 * 输出：
 * - 适配 Select 的 options（value 稳定英文编码，label 中文）
 */
export const buildAutoDisassembleSubCategoryOptionsByCategory = (
  category: AutoDisassembleBagCategory,
  extraRawValues: string[] = [],
): LabeledOption[] => {
  const defaults = ITEM_SUB_CATEGORY_VALUES_BY_CATEGORY[category] ?? ITEM_SUB_CATEGORY_VALUES_BY_CATEGORY.all;
  return buildAutoDisassembleSubCategoryOptions([...defaults, ...extraRawValues]);
};
