/**
 * 物品使用期间的在线战斗资源同步
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：当角色处于活跃战斗时，把消耗品带来的气血/灵气变化同步到战斗引擎里的玩家单位。
 * 2. 做什么：同步在线战斗角色快照并推送一帧 battle_state，让客户端战斗界面立即收到权威资源变化。
 * 3. 不做什么：不校验物品效果、不扣除物品、不处理非玩家单位和永久属性变化。
 *
 * 输入 / 输出：
 * - 输入：characterId，以及本次物品使用结算出的 qixue / lingqi 增量。
 * - 输出：是否命中活跃战斗，以及命中时战斗单位同步后的当前资源值。
 *
 * 数据流 / 状态流：
 * itemService.useItem 已完成效果聚合 -> 本模块查 activeBattleIdByCharacterId
 * -> 直接更新 activeBattles 中的 player BattleUnit -> setOnlineBattleCharacterResources 更新运行时快照
 * -> emitBattleUpdate 推送增量状态 -> saveBattleToRedis 排队持久化最新战斗现场。
 *
 * 复用设计说明：
 * - 气血丹、回气丹等简单资源消耗品共用这一条同步链路，避免每个 item effect 分支各自查战斗、改单位、推消息。
 * - “角色资源缓存”和“战斗运行时资源”是高频变化点，战斗侧同步集中到这里后，itemService 只负责决定有没有资源增量。
 * - 后续若新增战斗中可用的资源消耗品，只需要复用本函数，不需要再复制 battle_state 推送逻辑。
 *
 * 关键边界条件与坑点：
 * 1. 战斗中的当前灵气以 BattleUnit 为权威，不能只改角色 computed 缓存，否则下一帧战斗推送会把页面资源覆盖回旧值。
 * 2. 死亡单位不能被普通恢复气血道具从战斗死亡态复活；这里保持 qixue=0 和 isAlive=false，只同步灵气等非复活资源。
 */
import type { BattleUnit } from '../../battle/types.js';
import {
  activeBattleIdByCharacterId,
  activeBattles,
  battleParticipants,
} from '../battle/runtime/state.js';
import { emitBattleUpdate } from '../battle/runtime/ticker.js';
import { saveBattleToRedis } from '../battle/runtime/persistence.js';
import { setOnlineBattleCharacterResources } from '../onlineBattleProjectionService.js';

export type ActiveBattleResourceSyncResult =
  | {
      synced: false;
    }
  | {
      synced: true;
      qixue: number;
      lingqi: number;
    };

type BattleResourceDelta = {
  qixue: number;
  lingqi: number;
};

const toDeltaInteger = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.floor(value);
};

const clampInteger = (value: number, min: number, max: number): number => {
  return Math.min(max, Math.max(min, Math.floor(value)));
};

const findPlayerBattleUnit = (
  units: readonly BattleUnit[],
  characterId: number,
): BattleUnit | null => {
  const expectedUnitId = `player-${characterId}`;
  for (const unit of units) {
    if (unit.id === expectedUnitId) return unit;
  }
  return null;
};

export const applyItemUseResourceDeltaToActiveBattle = async (
  characterId: number,
  delta: BattleResourceDelta,
): Promise<ActiveBattleResourceSyncResult> => {
  const normalizedCharacterId = Math.floor(Number(characterId));
  if (!Number.isFinite(normalizedCharacterId) || normalizedCharacterId <= 0) {
    return { synced: false };
  }

  const battleId = activeBattleIdByCharacterId.get(normalizedCharacterId);
  if (!battleId) return { synced: false };

  const engine = activeBattles.get(battleId);
  if (!engine) return { synced: false };

  const state = engine.getState();
  if (state.phase === 'finished') return { synced: false };

  const unit =
    findPlayerBattleUnit(state.teams.attacker.units, normalizedCharacterId)
    ?? findPlayerBattleUnit(state.teams.defender.units, normalizedCharacterId);
  if (!unit) return { synced: false };

  const maxQixue = Math.max(1, Math.floor(unit.currentAttrs.max_qixue));
  const maxLingqi = Math.max(0, Math.floor(unit.currentAttrs.max_lingqi));
  const qixueDelta = toDeltaInteger(delta.qixue);
  const lingqiDelta = toDeltaInteger(delta.lingqi);

  if (unit.isAlive) {
    unit.qixue = clampInteger(unit.qixue + qixueDelta, 1, maxQixue);
  } else {
    unit.qixue = 0;
  }
  unit.lingqi = clampInteger(unit.lingqi + lingqiDelta, 0, maxLingqi);

  await setOnlineBattleCharacterResources(normalizedCharacterId, {
    qixue: unit.qixue,
    lingqi: unit.lingqi,
  });

  emitBattleUpdate(battleId, {
    kind: 'battle_state',
    battleId,
    state,
  });
  saveBattleToRedis(battleId, engine, battleParticipants.get(battleId) ?? []);

  return {
    synced: true,
    qixue: unit.qixue,
    lingqi: unit.lingqi,
  };
};
