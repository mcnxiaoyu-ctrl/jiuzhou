/**
 * BattleArea 战斗浮字事件收敛工具。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把服务端新增战斗日志转换成单位维度的浮字事件，并在同一帧内按单位聚合伤害与治疗。
 * 2. 做什么：让 BattleArea 只处理批量后的轻量事件，避免每个命中点都触发一次 React state 写入。
 * 3. 不做什么：不创建 DOM、不维护计时器，也不改变战况文字日志的明细展示。
 *
 * 输入 / 输出：
 * - 输入：BattleArea 已切出的新增 BattleLogEntryDto 列表。
 * - 输出：BattleFloatEvent[]，每项只包含目标单位 ID 与本帧聚合后的正负数值。
 *
 * 数据流 / 状态流：
 * - socket 日志增量 -> BattleArea 根据 lastLogIndex 切出新增日志 -> 本模块聚合成浮字事件 -> BattleArea 批量写入 floats state。
 *
 * 复用设计说明：
 * - 日志解析规则集中在这里，BattleArea 主组件不再散落 action / dot / hot 的遍历细节。
 * - 浮字展示是战斗 UI 高频变化点，单独抽成纯函数后可以用静态测试锁住聚合策略，也方便后续省电模式继续复用。
 * - 当前被 BattleArea 与对应回归测试复用；战况文本仍继续走 logFormatterFast，避免展示文案与动画事件互相耦合。
 *
 * 关键边界条件与坑点：
 * 1. 多段命中必须在同一单位上合并为一个伤害浮字，否则高层多怪、多段攻击会制造大量短生命周期 DOM。
 * 2. 伤害与治疗保留正负两类事件，不互相抵消，避免吸血、反伤等同帧效果在视觉上丢失方向。
 */

import type { BattleLogEntryDto } from '../../../../services/api/combat-realm';

export interface BattleFloatEvent {
  unitId: string;
  value: number;
}

type BattleFloatAccumulator = {
  damage: number;
  heal: number;
};

const toPositiveInt = (value: number | null | undefined): number => {
  const next = Math.floor(Number(value) || 0);
  return next > 0 ? next : 0;
};

const ensureAccumulator = (
  eventByUnitId: Map<string, BattleFloatAccumulator>,
  unitId: string,
): BattleFloatAccumulator | null => {
  const normalizedUnitId = String(unitId ?? '').trim();
  if (!normalizedUnitId) return null;
  const current = eventByUnitId.get(normalizedUnitId);
  if (current) return current;
  const next: BattleFloatAccumulator = { damage: 0, heal: 0 };
  eventByUnitId.set(normalizedUnitId, next);
  return next;
};

const addDamage = (
  eventByUnitId: Map<string, BattleFloatAccumulator>,
  unitId: string,
  damage: number | null | undefined,
): void => {
  const value = toPositiveInt(damage);
  if (value <= 0) return;
  const event = ensureAccumulator(eventByUnitId, unitId);
  if (!event) return;
  event.damage += value;
};

const addHeal = (
  eventByUnitId: Map<string, BattleFloatAccumulator>,
  unitId: string,
  heal: number | null | undefined,
): void => {
  const value = toPositiveInt(heal);
  if (value <= 0) return;
  const event = ensureAccumulator(eventByUnitId, unitId);
  if (!event) return;
  event.heal += value;
};

const collectActionTargetFloatEvent = (
  eventByUnitId: Map<string, BattleFloatAccumulator>,
  target: Extract<BattleLogEntryDto, { type: 'action' }>['targets'][number],
): void => {
  const damage = target.hits.length > 0
    ? target.hits.reduce((sum, hit) => sum + toPositiveInt(hit.damage), 0)
    : toPositiveInt(target.damage);

  addDamage(eventByUnitId, target.targetId, damage);
  addHeal(eventByUnitId, target.targetId, target.heal);
};

export const collectBattleFloatEventsFromLogs = (
  logs: readonly BattleLogEntryDto[],
): BattleFloatEvent[] => {
  const eventByUnitId = new Map<string, BattleFloatAccumulator>();

  for (const log of logs) {
    if (log.type === 'action') {
      for (const target of log.targets) {
        collectActionTargetFloatEvent(eventByUnitId, target);
      }
      continue;
    }

    if (log.type === 'dot') {
      addDamage(eventByUnitId, log.unitId, log.damage);
      continue;
    }

    if (log.type === 'hot') {
      addHeal(eventByUnitId, log.unitId, log.heal);
    }
  }

  const events: BattleFloatEvent[] = [];
  for (const [unitId, event] of eventByUnitId.entries()) {
    if (event.damage > 0) {
      events.push({ unitId, value: -event.damage });
    }
    if (event.heal > 0) {
      events.push({ unitId, value: event.heal });
    }
  }
  return events;
};
