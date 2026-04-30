/**
 * BattleArea 日志驱动的气血补丁。
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：用本次新增战斗日志里的实际伤害/治疗量，局部修正即将渲染的 BattleStateDto.qixue。
 * - 不做什么：不替代服务端快照、不处理灵气/护盾/Buff，也不根据文案猜测资源正负。
 *
 * 输入 / 输出：
 * - 输入：即将渲染的 nextState、当前已显示的 currentState、本次新增 BattleLogEntryDto 列表。
 * - 输出：若日志能推导出 qixue 变化，返回共享大部分引用的新 BattleStateDto；否则原样返回 nextState。
 *
 * 数据流 / 状态流：
 * - battle:update 完整日志流 -> BattleArea 根据 lastLogIndex 切出新增日志
 * - 当前 UI 状态 + 新增日志实际数值 -> 本模块计算 touched unit 的期望 qixue
 * - 期望 qixue 覆盖 nextState 中同 ID 单位，随后进入 BattleUnitCard 渲染。
 *
 * 复用设计说明：
 * - 日志浮字与血条修正都消费同一批新增日志，避免“浮字显示治疗、血条不动”的两套状态口径。
 * - 纯函数集中处理 action/dot/hot/aura 的 qixue 变化，后续新增日志类型只改这里一处。
 * - 高频变化点是单位气血展示，按 ID 索引一次命中单位，避免在组件渲染中重复扫描与临时计算。
 *
 * 关键边界条件与坑点：
 * 1. 必须以 currentState 为基准应用新增日志，不能直接在 nextState 上加治疗，否则服务端快照已更新时会双加。
 * 2. resource 日志当前丢失正负号，本模块不使用 resources 修正 qixue，避免把扣血误当回血。
 */

import type { BattleLogEntryDto, BattleStateDto, BattleUnitDto } from '../../../../services/api/combat-realm';

type BattleTeamDto = BattleStateDto['teams']['attacker'];

const clampQixue = (value: number, unit: BattleUnitDto): number => {
  const maxQixue = Math.max(0, Math.floor(unit.currentAttrs.max_qixue));
  return Math.min(maxQixue, Math.max(0, Math.floor(value)));
};

const addDelta = (
  qixueDeltaByUnitId: Map<string, number>,
  unitId: string,
  delta: number,
): void => {
  if (delta === 0) return;
  qixueDeltaByUnitId.set(unitId, (qixueDeltaByUnitId.get(unitId) ?? 0) + delta);
};

const collectActionTargetDelta = (
  qixueDeltaByUnitId: Map<string, number>,
  target: Extract<BattleLogEntryDto, { type: 'action' }>['targets'][number],
): void => {
  let damage = 0;
  if (target.hits.length > 0) {
    for (const hit of target.hits) {
      damage += Math.max(0, Math.floor(hit.damage));
    }
  } else {
    damage = Math.max(0, Math.floor(target.damage ?? 0));
  }
  addDelta(qixueDeltaByUnitId, target.targetId, -damage);

  const heal = Math.max(0, Math.floor(target.heal ?? 0));
  addDelta(qixueDeltaByUnitId, target.targetId, heal);
};

const collectLogDeltas = (
  logs: BattleLogEntryDto[],
): Map<string, number> => {
  const qixueDeltaByUnitId = new Map<string, number>();

  for (const log of logs) {
    if (log.type === 'action') {
      for (const target of log.targets) {
        collectActionTargetDelta(qixueDeltaByUnitId, target);
      }
      continue;
    }

    if (log.type === 'dot') {
      addDelta(qixueDeltaByUnitId, log.unitId, -Math.max(0, Math.floor(log.damage)));
      continue;
    }

    if (log.type === 'hot') {
      addDelta(qixueDeltaByUnitId, log.unitId, Math.max(0, Math.floor(log.heal)));
      continue;
    }

    if (log.type === 'aura') {
      for (const subResult of log.subResults) {
        addDelta(qixueDeltaByUnitId, subResult.targetId, -Math.max(0, Math.floor(subResult.damage ?? 0)));
        addDelta(qixueDeltaByUnitId, subResult.targetId, Math.max(0, Math.floor(subResult.heal ?? 0)));
      }
    }
  }

  return qixueDeltaByUnitId;
};

const buildCurrentUnitById = (
  currentState: BattleStateDto,
): Map<string, BattleUnitDto> => {
  const unitById = new Map<string, BattleUnitDto>();
  for (const unit of currentState.teams.attacker.units) {
    unitById.set(unit.id, unit);
  }
  for (const unit of currentState.teams.defender.units) {
    unitById.set(unit.id, unit);
  }
  return unitById;
};

const patchTeamQixue = (
  nextTeam: BattleTeamDto,
  currentUnitById: Map<string, BattleUnitDto>,
  qixueDeltaByUnitId: Map<string, number>,
): { team: BattleTeamDto; changed: boolean } => {
  let changed = false;
  const units = nextTeam.units.map((unit) => {
    const delta = qixueDeltaByUnitId.get(unit.id);
    if (delta === undefined) return unit;
    const currentUnit = currentUnitById.get(unit.id);
    if (!currentUnit) return unit;
    const patchedQixue = clampQixue(currentUnit.qixue + delta, unit);
    if (patchedQixue === unit.qixue) return unit;
    changed = true;
    return {
      ...unit,
      qixue: patchedQixue,
    };
  });

  return changed
    ? { team: { ...nextTeam, units }, changed }
    : { team: nextTeam, changed };
};

export const applyBattleLogQixuePatch = (
  nextState: BattleStateDto,
  currentState: BattleStateDto | null,
  newLogs: BattleLogEntryDto[],
): BattleStateDto => {
  if (!currentState || newLogs.length <= 0) return nextState;
  if (nextState.battleId !== currentState.battleId) return nextState;

  const qixueDeltaByUnitId = collectLogDeltas(newLogs);
  if (qixueDeltaByUnitId.size <= 0) return nextState;

  const currentUnitById = buildCurrentUnitById(currentState);
  const attackerResult = patchTeamQixue(nextState.teams.attacker, currentUnitById, qixueDeltaByUnitId);
  const defenderResult = patchTeamQixue(nextState.teams.defender, currentUnitById, qixueDeltaByUnitId);

  if (!attackerResult.changed && !defenderResult.changed) return nextState;

  return {
    ...nextState,
    teams: {
      attacker: attackerResult.team,
      defender: defenderResult.team,
    },
  };
};
