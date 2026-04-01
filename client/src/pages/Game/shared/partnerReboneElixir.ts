/**
 * 归元洗髓露前端共享语义模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中识别一个物品定义是否具备“动态伙伴基础属性重生成”语义，供背包限制提示与伙伴页入口共用。
 * 2. 做什么：统一维护归元洗髓露物品定义 ID，避免伙伴页、背包页和测试各写一份硬编码。
 * 3. 不做什么：不发请求、不决定伙伴是否可用，也不处理具体的伙伴详情弹窗交互。
 *
 * 输入 / 输出：
 * - 输入：轻量物品定义。
 * - 输出：是否为归元洗髓露语义物品。
 *
 * 数据流 / 状态流：
 * 背包 / 伙伴页拿到 item definition -> 本模块识别 `reroll_partner_base_attrs` 效果 -> UI 决定限制提示或伙伴页按钮。
 *
 * 复用设计说明：
 * - 归元洗髓露识别口径只维护这一份，避免桌面端、移动端和伙伴详情页各自扫描 `effect_defs`。
 * - 物品定义 ID 作为伙伴页取用专属道具的键值，也统一由这里导出，避免多个模块散落硬编码。
 *
 * 关键边界条件与坑点：
 * 1. 只认显式 `effect_type = reroll_partner_base_attrs` 且 `target = partner`，不能只看名称。
 * 2. 这里不判断伙伴是否为动态伙伴，目标合法性必须继续由伙伴页与后端服务共同把关。
 */
import type { ItemDefLite } from '../../../services/api';

type EffectDef = Record<string, unknown>;

export const PARTNER_REBONE_ELIXIR_ITEM_DEF_ID = 'cons-partner-rebone-001';

const coerceEffectDefs = (value: unknown): EffectDef[] => {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is EffectDef =>
      Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry),
  );
};

export const isPartnerReboneElixirItemDefinitionLike = (
  def: Pick<ItemDefLite, 'effect_defs'> | null | undefined,
): boolean => {
  if (!def) return false;

  for (const effect of coerceEffectDefs(def.effect_defs)) {
    if (String(effect.trigger || '').trim() !== 'use') continue;
    if (String(effect.target || '').trim() !== 'partner') continue;
    if (String(effect.effect_type || '').trim() !== 'reroll_partner_base_attrs') continue;
    return true;
  }

  return false;
};
