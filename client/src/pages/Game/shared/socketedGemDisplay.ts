/**
 * 作用：
 * - 统一解析装备 `socketed_gems` 原始结构，并产出可直接用于详情面板/Tooltip 的宝石展示分组。
 * - 不做什么：不负责业务校验、不决定孔位合法性、不改写后端数据语义，只做前端展示层结构化。
 *
 * 输入/输出：
 * - 输入：`socketed_gems` 原始值（JSON 字符串、unknown 数组或已解析对象）与属性格式化配置。
 * - 输出：稳定按孔位排序的 `SocketedGemEntry[]` 与 `SocketedGemDisplayGroup[]`。
 *
 * 数据流/状态流：
 * - 仓库/坊市/背包详情把各自 DTO 中的 `socketed_gems` 传入本模块。
 * - 本模块统一解析 -> 生成宝石分组 -> 由上层组件决定渲染到卡片、Tooltip 或属性面板。
 *
 * 边界条件与坑点：
 * 1. 历史数据可能是 JSON 字符串，也可能已经是对象数组；这里必须同时兼容，但不额外兜底脏字段。
 * 2. 无效孔位、缺失 `itemDefId`、没有有效效果的宝石一律过滤，避免展示层出现“空宝石”噪声。
 */

export type SocketedGemEffect = {
  attrKey: string;
  value: number;
  applyType: "flat" | "percent" | "special";
};

export type SocketedGemEntry = {
  slot: number;
  itemDefId: string;
  gemType: string;
  effects: SocketedGemEffect[];
  name?: string;
  icon?: string;
};

export type SocketedGemDisplayEffect = {
  label: string;
  valueText: string;
  text: string;
};

export type SocketedGemDisplayGroup = {
  slot: number;
  slotText: string;
  gemName: string;
  effects: SocketedGemDisplayEffect[];
};

type BuildSocketedGemDisplayGroupOptions = {
  labelResolver?: (attrKey: string) => string;
  formatSignedNumber: (value: number) => string;
  formatSignedPercent: (value: number) => string;
};

const resolveApplyType = (value: unknown): SocketedGemEffect["applyType"] => {
  const normalized = String(value ?? "flat").trim().toLowerCase();
  if (normalized === "percent") return "percent";
  if (normalized === "special") return "special";
  return "flat";
};

export const parseSocketedGems = (raw: unknown): SocketedGemEntry[] => {
  let list: unknown = raw;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];

  const output: SocketedGemEntry[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const slot = Number(row.slot);
    const itemDefId = String(row.itemDefId ?? row.item_def_id ?? "").trim();
    const gemType = String(row.gemType ?? row.gem_type ?? "all").trim() || "all";
    const effectsRaw = Array.isArray(row.effects) ? row.effects : [];
    const effects: SocketedGemEffect[] = [];

    for (const effect of effectsRaw) {
      if (!effect || typeof effect !== "object") continue;
      const effectRow = effect as Record<string, unknown>;
      const attrKey = String(effectRow.attrKey ?? effectRow.attr_key ?? effectRow.attr ?? "").trim();
      const value = Number(effectRow.value);
      if (!attrKey || !Number.isFinite(value)) continue;
      effects.push({
        attrKey,
        value,
        applyType: resolveApplyType(effectRow.applyType ?? effectRow.apply_type),
      });
    }

    if (!Number.isInteger(slot) || slot < 0) continue;
    if (!itemDefId || effects.length === 0) continue;

    output.push({
      slot,
      itemDefId,
      gemType,
      effects,
      name: typeof row.name === "string" ? row.name : undefined,
      icon: typeof row.icon === "string" ? row.icon : undefined,
    });
  }

  return output.sort((left, right) => left.slot - right.slot);
};

export const buildSocketedGemDisplayGroups = (
  raw: unknown,
  options: BuildSocketedGemDisplayGroupOptions,
): SocketedGemDisplayGroup[] => {
  const gems = parseSocketedGems(raw);
  return gems.map((gem) => {
    const gemName = gem.name || gem.itemDefId;
    const slotText = `宝石[${gem.slot + 1}]`;
    const effects = gem.effects.map((effect) => {
      const label = options.labelResolver?.(effect.attrKey) ?? effect.attrKey;
      const valueText =
        effect.applyType === "percent"
          ? options.formatSignedPercent(effect.value)
          : options.formatSignedNumber(effect.value);
      return {
        label,
        valueText,
        text: `${label} ${valueText}`,
      };
    });

    return {
      slot: gem.slot,
      slotText,
      gemName,
      effects,
    };
  });
};
