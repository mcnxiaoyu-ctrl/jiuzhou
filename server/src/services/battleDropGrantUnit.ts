/**
 * 战斗掉落发放单元构建器
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把战斗掉落列表聚合成更少的发放单元，降低事务内 createItem 调用次数。
 * 2. 做什么：只合并普通非装备且无品质权重的掉落，装备保持逐件发放以保留随机性。
 * 3. 不做什么：不读取静态配置，不调用数据库，不决定自动分解规则。
 *
 * 输入 / 输出：
 * - 输入：带静态 category 的掉落条目。
 * - 输出：发放单元数组，保持首次出现顺序，并带 sourceDropCount 表示来源掉落条数。
 *
 * 数据流 / 状态流：
 * battle reward plan drops -> battleDropService 先解析 item meta -> 本模块聚合 -> 发奖事务逐单元处理。
 *
 * 复用设计说明：
 * - 聚合规则集中在单文件，避免 battleDropService 主事务继续膨胀。
 * - sourceDropCount 进入慢日志后可对比“原始掉落数”和“发放单元数”，后续同类结算链路可复用同一入口。
 * - category 与 qualityWeights 是高频业务变化点，统一放在这里判断，避免多处维护“哪些掉落可合并”。
 *
 * 关键边界条件与坑点：
 * 1. 只有非 equipment 且无 qualityWeights 的掉落可合并。
 * 2. 合并 key 必须包含 receiverCharacterId、receiverUserId、itemDefId、bindType，不能跨角色或跨绑定状态合并。
 */

export type BattleDropGrantInput = {
  receiverCharacterId: number;
  receiverUserId: number;
  receiverFuyuan: number;
  itemDefId: string;
  quantity: number;
  bindType: string;
  category: string;
  qualityWeights?: Record<string, number>;
};

export type BattleDropGrantUnit = BattleDropGrantInput & {
  sourceDropCount: number;
};

const buildAggregatableDropKey = (drop: BattleDropGrantInput): string | null => {
  if (drop.category === 'equipment') return null;
  if (drop.qualityWeights) return null;
  return `${drop.receiverCharacterId}|${drop.receiverUserId}|${drop.itemDefId}|${drop.bindType}`;
};

export const buildBattleDropGrantUnits = (
  drops: readonly BattleDropGrantInput[],
): BattleDropGrantUnit[] => {
  const units: BattleDropGrantUnit[] = [];
  const unitByKey = new Map<string, BattleDropGrantUnit>();

  for (const drop of drops) {
    const key = buildAggregatableDropKey(drop);
    if (key === null) {
      units.push({ ...drop, sourceDropCount: 1 });
      continue;
    }

    const existingUnit = unitByKey.get(key);
    if (existingUnit) {
      existingUnit.quantity += drop.quantity;
      existingUnit.sourceDropCount += 1;
      continue;
    }

    const unit = { ...drop, sourceDropCount: 1 };
    unitByKey.set(key, unit);
    units.push(unit);
  }

  return units;
};
