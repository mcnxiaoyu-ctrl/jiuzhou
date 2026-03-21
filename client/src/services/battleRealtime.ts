import type { BattleSessionSnapshotDto } from './api/battleSession';
import type {
  BattleCooldownMetaDto,
  BattleLogEntryDto,
  BattleRewardsDto,
  BattleUnitDto,
  BattleStateDto,
} from './api/combat-realm';

/**
 * 战斗实时消息归一化与缓存合并。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一解析 socket `battle:update` 的完整快照、状态增量、结束、放弃消息，避免 `Game`、`BattleArea`、`SkillFloatButton` 各写一套字段兜转。
 * 2. 做什么：把服务端的日志增量 `logs/logStart/logDelta` 合并成前端稳定可回放的完整日志流，供晚订阅组件直接拿到首帧。
 * 3. 不做什么：不决定视图接管策略，不直接操作 React state，也不发起任何 HTTP/socket 请求。
 *
 * 输入/输出：
 * - 输入：原始战斗 socket 消息，以及同一 battleId 的上一份完整快照。
 * - 输出：归一化后的战斗实时消息；若消息字段不足以构成可消费结果，则返回 null。
 *
 * 数据流/状态流：
 * - socket 原始 battle:update -> 本模块归一化/合并日志 -> gameSocket 缓存完整快照 -> 页面订阅者消费。
 *
 * 关键边界条件与坑点：
 * 1. `battle_state` 允许只带日志增量，因此必须基于上一份完整日志快照合并，不能把增量直接当全量使用。
 * 2. 刷新/重挂载后的首帧恢复依赖缓存回放，所以本模块输出必须始终是“可直接渲染的完整状态”，不能把半成品再甩给页面兜底。
 */

export type BattleRealtimeKind =
  | 'battle_started'
  | 'battle_state'
  | 'battle_finished'
  | 'battle_abandoned';

type BattleResultDto = 'attacker_win' | 'defender_win' | 'draw';

type BattleRealtimeDataEnvelope = {
  state?: BattleStateDto;
  logs?: BattleLogEntryDto[];
  rewards?: BattleRewardsDto | null;
  result?: BattleResultDto;
  session?: BattleSessionSnapshotDto | null;
  authoritative?: boolean;
} & BattleCooldownMetaDto;

export type BattleRealtimeWirePayload = {
  kind?: string;
  battleId?: string;
  state?: BattleStateDto;
  logs?: BattleLogEntryDto[];
  logStart?: number;
  logDelta?: boolean;
  session?: BattleSessionSnapshotDto | null;
  rewards?: BattleRewardsDto | null;
  result?: BattleResultDto;
  authoritative?: boolean;
  success?: boolean;
  message?: string;
  unitsDelta?: boolean;
  data?: BattleRealtimeDataEnvelope | null;
} & BattleCooldownMetaDto;

export type BattleRealtimeStatePayload = {
  kind: 'battle_started' | 'battle_state' | 'battle_finished';
  battleId: string;
  state: BattleStateDto;
  logs: BattleLogEntryDto[];
  logStart: number;
  logDelta: boolean;
  session?: BattleSessionSnapshotDto | null;
  rewards?: BattleRewardsDto | null;
  result?: BattleResultDto;
  authoritative?: boolean;
  success?: boolean;
  message?: string;
  unitsDelta?: boolean;
} & BattleCooldownMetaDto;

export type BattleRealtimeAbandonedPayload = {
  kind: 'battle_abandoned';
  battleId: string;
  session?: BattleSessionSnapshotDto | null;
  authoritative?: boolean;
  success?: boolean;
  message?: string;
} & BattleCooldownMetaDto;

export type BattleRealtimePayload =
  | BattleRealtimeStatePayload
  | BattleRealtimeAbandonedPayload;

const normalizeLogStart = (value: number | undefined, logDelta: boolean): number => {
  if (!logDelta) return 0;
  if (!Number.isFinite(value)) return 0;
  const next = Math.floor(Number(value));
  return next >= 0 ? next : 0;
};

const mergeBattleLogs = (
  previousLogs: BattleLogEntryDto[],
  incomingLogs: BattleLogEntryDto[],
  logStart: number,
  logDelta: boolean,
): BattleLogEntryDto[] => {
  if (!logDelta) return incomingLogs;
  const baseLogs =
    previousLogs.length >= logStart ? previousLogs.slice(0, logStart) : previousLogs;
  return baseLogs.concat(incomingLogs);
};

type BattleTeamStateDto = BattleStateDto['teams']['attacker'];

const mergeBattleUnits = (
  previousUnits: BattleUnitDto[],
  incomingUnits: BattleUnitDto[],
): BattleUnitDto[] => {
  const previousUnitById = new Map(previousUnits.map((unit) => [unit.id, unit]));
  return incomingUnits.map((unit) => {
    const previousUnit = previousUnitById.get(unit.id);
    if (!previousUnit) return unit;
    return {
      ...previousUnit,
      ...unit,
      currentAttrs: {
        ...previousUnit.currentAttrs,
        ...unit.currentAttrs,
      },
      buffs: unit.buffs,
    };
  });
};

const mergeBattleTeamState = (
  previousTeam: BattleTeamStateDto,
  incomingTeam: BattleTeamStateDto,
): BattleTeamStateDto => {
  return {
    ...previousTeam,
    ...incomingTeam,
    units: mergeBattleUnits(previousTeam.units, incomingTeam.units),
  };
};

const mergeBattleStateDelta = (
  previousState: BattleStateDto | null,
  incomingState: BattleStateDto,
  unitsDelta: boolean,
): BattleStateDto => {
  if (!unitsDelta || !previousState) return incomingState;
  if (previousState.battleId !== incomingState.battleId) return incomingState;
  return {
    ...previousState,
    ...incomingState,
    teams: {
      attacker: mergeBattleTeamState(
        previousState.teams.attacker,
        incomingState.teams.attacker,
      ),
      defender: mergeBattleTeamState(
        previousState.teams.defender,
        incomingState.teams.defender,
      ),
    },
  };
};

export const normalizeBattleRealtimePayload = (
  raw: BattleRealtimeWirePayload,
  previous: BattleRealtimeStatePayload | null,
): BattleRealtimePayload | null => {
  const kind = String(raw.kind ?? '').trim() as BattleRealtimeKind;
  const battleId = String(raw.battleId ?? '').trim();
  if (!battleId) return null;

  const envelope = raw.data ?? null;
  const session = raw.session ?? envelope?.session ?? undefined;
  const authoritative =
    raw.authoritative === true || envelope?.authoritative === true;
  const success = typeof raw.success === 'boolean' ? raw.success : undefined;
  const message = typeof raw.message === 'string' ? raw.message : undefined;
  const battleStartCooldownMs = raw.battleStartCooldownMs ?? envelope?.battleStartCooldownMs;
  const retryAfterMs = raw.retryAfterMs ?? envelope?.retryAfterMs;
  const nextBattleAvailableAt =
    raw.nextBattleAvailableAt ?? envelope?.nextBattleAvailableAt;

  if (kind === 'battle_abandoned') {
    return {
      kind,
      battleId,
      session,
      authoritative,
      success,
      message,
      battleStartCooldownMs,
      retryAfterMs,
      nextBattleAvailableAt,
    };
  }

  const state = raw.state ?? envelope?.state;
  if (!state) return null;
  const unitsDelta = Boolean(raw.unitsDelta);
  const nextState = mergeBattleStateDelta(previous?.state ?? null, state, unitsDelta);

  const incomingLogs = raw.logs ?? envelope?.logs ?? [];
  const logDelta = Boolean(raw.logDelta);
  const logStart = normalizeLogStart(raw.logStart, logDelta);
  const nextLogs = mergeBattleLogs(previous?.logs ?? [], incomingLogs, logStart, logDelta);
  const rewards = raw.rewards ?? envelope?.rewards ?? undefined;
  const result = raw.result ?? envelope?.result ?? state.result ?? undefined;

  return {
    kind:
      kind === 'battle_started' || kind === 'battle_finished'
        ? kind
        : 'battle_state',
    battleId,
    state: nextState,
    logs: nextLogs,
    logStart,
    logDelta,
    session,
    rewards,
    result,
    authoritative,
    success,
    message,
    unitsDelta,
    battleStartCooldownMs,
    retryAfterMs,
    nextBattleAvailableAt,
  };
};

export const isBattleRealtimeStatePayload = (
  payload: BattleRealtimePayload | null,
): payload is BattleRealtimeStatePayload => {
  return Boolean(payload && payload.kind !== 'battle_abandoned');
};
