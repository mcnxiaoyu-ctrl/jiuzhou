/**
 * 战斗 tick 驱动与更新推送
 *
 * 作用：
 * - 驱动每场战斗的 tick 循环（AI 行动、回合推进）
 * - 推送战斗状态更新到参与者客户端
 * - 处理离线玩家代操、自动跳过等逻辑
 *
 * 不做什么：不管理战斗创建/结算、不操作数据库。
 *
 * 数据流：
 * setInterval -> tickBattle -> engine.aiAction / 推送 -> emitBattleUpdate -> WS + Redis
 *
 * 复用点：
 * - state.ts 的 registerStartedBattle 通过延迟 import 调用 startBattleTicker / emitBattleUpdate
 *
 * 边界条件：
 * 1) battleTickLocks 防止同一战斗并发 tick
 * 2) patchBattleUpdatePayload 剥离静态字段、使用日志增量减少传输量
 */

import { BattleEngine } from "../../../battle/battleEngine.js";
import type { BattleSkill, BattleState, BattleUnit } from "../../../battle/types.js";
import {
  clearBattleLogStream,
  consumeBattleLogDelta,
  discardBattleLogDelta,
} from "../../../battle/logStream.js";
import { runWithDatabaseAccessAllowed } from "../../../config/database.js";
import { canUseSkill, isFeared, isStunned } from "../../../battle/modules/control.js";
import { getNormalAttack } from "../../../battle/modules/skill.js";
import { getSkillCooldownRemainingRounds } from "../../../battle/utils/cooldown.js";
import { resolveSingleAllyTargetId } from "../../../battle/utils/allyTargeting.js";
import { getGameServer } from "../../../game/gameServer.js";
import { createSlowOperationLogger } from "../../../utils/slowOperationLogger.js";
import {
  activeBattles,
  battleParticipants,
  battleTickLocks,
  battleTickers,
  battleLastRedisSavedAt,
  BATTLE_TICK_MS,
  getAttackerPlayerCount,
  getUserIdByCharacterId,
} from "./state.js";
import { saveBattleToRedis, shouldPersistBattleToRedis } from "./persistence.js";
import { getAttachedBattleSessionSnapshot } from "../../battleSession/index.js";
import {
  buildBattleDeltaState,
  buildBattleRealtimePayload,
  buildBattleSnapshotState,
} from "./realtime.js";

// ------ 常量 ------

const BATTLE_REDIS_SAVE_INTERVAL_MS = 2000;
const PLAYER_ACTION_TIMEOUT_MS = 30_000;
const BATTLE_EMIT_UPDATE_SLOW_THRESHOLD_MS = 40;
const BATTLE_TICK_SLOW_THRESHOLD_MS = 80;
const lastWaitingPlayerTurnKeyByBattleId = new Map<string, string>();
let battleTickerScheduler: ReturnType<typeof setInterval> | null = null;

type PlayerTurnTimeoutState = {
  turnKey: string;
  deadlineAt: number;
};

const playerTurnTimeoutStateByBattleId = new Map<string, PlayerTurnTimeoutState>();

// ------ 推送优化 ------

const hasOnlineBattleUpdateRecipient = (
  userIds: readonly number[],
  gameServer: ReturnType<typeof getGameServer>,
): boolean => {
  for (const userId of userIds) {
    if (!Number.isFinite(userId)) continue;
    if (gameServer.isUserOnline(userId)) return true;
  }
  return false;
};

const isSkippableRealtimeUpdateKind = (kind: string): boolean =>
  kind !== "battle_finished" &&
  kind !== "battle_abandoned" &&
  kind === "battle_state";

type BattleRedisSaveDecision = {
  shouldPersist: boolean;
  queued: boolean;
};

const queueBattleRedisSaveIfNeeded = (
  battleId: string,
  engine: BattleEngine | undefined,
  participants: number[],
  kind: string,
): BattleRedisSaveDecision => {
  const shouldPersist = engine !== undefined && shouldPersistBattleToRedis(battleId);
  if (!shouldPersist || !engine) {
    return {
      shouldPersist: false,
      queued: false,
    };
  }

  const now = Date.now();
  const lastSavedAt = battleLastRedisSavedAt.get(battleId) ?? 0;
  const shouldSave =
    kind === "battle_started" ||
    kind === "battle_finished" ||
    kind === "battle_abandoned" ||
    now - lastSavedAt >= BATTLE_REDIS_SAVE_INTERVAL_MS;
  if (!shouldSave) {
    return {
      shouldPersist: true,
      queued: false,
    };
  }

  battleLastRedisSavedAt.set(battleId, now);
  saveBattleToRedis(battleId, engine, participants);
  return {
    shouldPersist: true,
    queued: true,
  };
};

function patchBattleUpdatePayload(battleId: string, payload: Record<string, unknown>): Record<string, unknown> {
  if (!payload || typeof payload !== "object") return payload;
  const kind = String(payload.kind || "");

  if (kind === "battle_started") {
    const state = payload.state as unknown as BattleState | undefined;
    if (!state) return payload;
    const logSnapshot = consumeBattleLogDelta(battleId);
    return buildBattleRealtimePayload({
      kind: "battle_started",
      battleId,
      state: buildBattleSnapshotState(state),
      logs: logSnapshot.logs,
      extras: {
        logStart: logSnapshot.logStart,
        logDelta: logSnapshot.logDelta,
      },
    });
  }

  if (kind === "battle_finished" || kind === "battle_abandoned") {
    return payload;
  }

  if (kind !== "battle_state") return payload;

  const state = payload.state as BattleState | undefined;
  if (!state || typeof state !== "object") return payload;
  const logSnapshot = consumeBattleLogDelta(battleId);

  return buildBattleRealtimePayload({
    kind: "battle_state",
    battleId,
    state: buildBattleDeltaState(state),
    logs: logSnapshot.logs,
    extras: {
      ...(payload.session ? { session: payload.session as Record<string, unknown> } : {}),
      logStart: logSnapshot.logStart,
      logDelta: logSnapshot.logDelta,
      unitsDelta: true,
    },
  });
}

// ------ 推送更新 ------

export function emitBattleUpdate(battleId: string, payload: Record<string, unknown>): void {
  const kind = typeof payload?.kind === "string" ? payload.kind : "";
  const slowLogger = createSlowOperationLogger({
    label: "battle.emitBattleUpdate",
    thresholdMs: BATTLE_EMIT_UPDATE_SLOW_THRESHOLD_MS,
    fields: {
      battleId,
      kind,
    },
  });

  try {
    const participants = battleParticipants.get(battleId) || [];
    if (participants.length === 0) {
      slowLogger.flush({
        participantCount: 0,
        outcome: "no_participants",
      });
      return;
    }
    const gameServer = getGameServer();
    const engine = activeBattles.get(battleId);
    if (
      isSkippableRealtimeUpdateKind(kind) &&
      !hasOnlineBattleUpdateRecipient(participants, gameServer)
    ) {
      const discardedLogCount = discardBattleLogDelta(battleId);
      const redisSave = queueBattleRedisSaveIfNeeded(
        battleId,
        engine,
        participants,
        kind,
      );
      if (redisSave.queued) {
        slowLogger.mark("queueBattleRedisSave", {
          shouldSave: true,
        });
      }
      if (discardedLogCount > 0) {
        slowLogger.mark("discardBattleLogDelta", {
          discardedLogCount,
        });
      }
      slowLogger.flush({
        participantCount: participants.length,
        battleLogDiscarded: discardedLogCount,
        redisPersistEligible: redisSave.shouldPersist,
        redisSaveQueued: redisSave.queued,
        outcome: "no_online_recipient",
      });
      return;
    }
    const patched = patchBattleUpdatePayload(battleId, payload);
    slowLogger.mark("patchBattleUpdatePayload", {
      participantCount: participants.length,
    });
    const session = getAttachedBattleSessionSnapshot(battleId);
    const payloadWithSession = session
      ? { ...patched, session }
      : patched;
    slowLogger.mark("attachBattleSession", {
      hasSession: Boolean(session),
    });
    for (const userId of participants) {
      if (!Number.isFinite(userId)) continue;
      gameServer.emitToUser(userId, "battle:update", payloadWithSession);
    }
    slowLogger.mark("emitToParticipants");
    const redisSave = queueBattleRedisSaveIfNeeded(
      battleId,
      engine,
      participants,
      kind,
    );
    if (redisSave.queued) {
      slowLogger.mark("queueBattleRedisSave", {
        shouldSave: true,
      });
    }
    slowLogger.flush({
      participantCount: participants.length,
      redisPersistEligible: redisSave.shouldPersist,
      redisSaveQueued: redisSave.queued,
      outcome: "emitted",
    });
  } catch (error) {
    slowLogger.flush({
      failed: true,
      outcome: "exception",
    });
    console.warn(`[battle] 推送战斗更新失败: ${battleId}`, error);
  }
}

/**
 * 统一派发一次“战斗推进后的实时消息”。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把“继续推送 battle_state”与“战斗已结束则立即结算并推送 battle_finished”收口到单一入口，避免 ticker 与玩家行动各写一套终态判断。
 * 2. 做什么：确保终态只走 `finishBattle -> battle_finished` 单一路径，不再先额外发一帧 `battle_state(phase=finished)`。
 * 3. 不做什么：不决定本次推进是玩家出手还是 AI 行动；调用方只负责先改引擎状态，再调用本函数。
 *
 * 输入/输出：
 * - 输入：battleId 与已推进后的 BattleEngine。
 * - 输出：Promise<void>，内部按当前 state 决定发 battle_state 还是触发结算。
 *
 * 数据流/状态流：
 * playerAction / tickBattle 推进引擎
 * -> 本函数读取最新 state
 * -> 未结束则 emit battle_state
 * -> 已结束则 finishBattle 并由结算路径统一发 battle_finished。
 *
 * 关键边界条件与坑点：
 * 1. 终态不能先发 `battle_state` 再发 `battle_finished`，否则前端会先进入“已结束但缺少冷却/session”的半成品状态。
 * 2. 本函数只读当前 engine 最新 state；调用方若在推进前缓存旧 state，再传进来会重新引入竞态。
 */
export async function emitBattleProgressUpdate(
  battleId: string,
  engine: BattleEngine,
): Promise<void> {
  const nextState = engine.getState();
  if (nextState.phase !== "finished") {
    emitBattleUpdate(battleId, {
      kind: "battle_state",
      battleId,
      state: nextState,
    });
    return;
  }

  clearPlayerTurnTimeoutState(battleId);
  clearWaitingPlayerTurnState(battleId);
  await runWithDatabaseAccessAllowed(async () => {
    const { finishBattle, getBattleMonsters } = await import("../settlement.js");
    const monsters = await getBattleMonsters(engine);
    await finishBattle(battleId, engine, monsters);
  });
  stopBattleTicker(battleId);
}

/**
 * 以“终态可重试”的口径派发一次战斗推进结果。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一兜住 `emitBattleProgressUpdate` 在 finished 状态下的异步结算异常，避免一次临时失败就把 ticker 整体停掉。
 * 2. 做什么：把“继续抛错”与“记录日志并等待下个 tick 重试”收敛到单一入口，避免 ticker / 玩家行动各写一套终态异常分支。
 * 3. 不做什么：不吞掉进行中状态的异常；若 battle_state 推送前出现真正的逻辑错误，仍交给上层按原语义处理。
 *
 * 输入/输出：
 * - 输入：battleId、BattleEngine。
 * - 输出：`true` 表示本次推进已正常派发；`false` 表示 finished 结算暂时失败，已保留现场等待后续重试。
 *
 * 数据流/状态流：
 * tick / playerAction -> 本函数 -> emitBattleProgressUpdate
 * -> 成功：正常推送/结算
 * -> 终态失败：仅记录日志，保留 active battle 与 ticker，等待下次重试。
 *
 * 关键边界条件与坑点：
 * 1. 只允许 finished 状态走“失败后重试”；进行中状态吞错会掩盖真正的战斗逻辑 bug。
 * 2. 这里必须复用 BattleEngine 的实时状态判断，而不能信调用前缓存的旧 phase，否则会把已结束战斗误当成进行中错误处理。
 */
export async function emitBattleProgressUpdateSafely(
  battleId: string,
  engine: BattleEngine,
): Promise<boolean> {
  try {
    await emitBattleProgressUpdate(battleId, engine);
    return true;
  } catch (error) {
    if (engine.getState().phase !== "finished") {
      throw error;
    }

    console.error(
      `[battle] 终态结算失败，保留 ticker 等待后续重试: ${battleId}`,
      error,
    );
    return false;
  }
}

// ------ 自动操作 ------

const resolveAutoSkipTargetIds = (
  state: BattleState,
  unit: BattleUnit,
  skill: BattleSkill,
): string[] => {
  const isAttacker = state.teams.attacker.units.some((u) => u.id === unit.id);
  const allies = isAttacker ? state.teams.attacker.units : state.teams.defender.units;
  const enemies = isAttacker ? state.teams.defender.units : state.teams.attacker.units;
  const aliveAllies = allies.filter((u) => u.isAlive);
  const aliveEnemies = enemies.filter((u) => u.isAlive);

  if (skill.targetType === "self") {
    return [unit.id];
  }
  if (skill.targetType === "single_enemy") {
    return aliveEnemies[0] ? [aliveEnemies[0].id] : [];
  }
  if (skill.targetType === "single_ally") {
    const targetId = resolveSingleAllyTargetId(unit, skill, aliveAllies);
    return targetId ? [targetId] : [];
  }
  return [];
};

const canCastSkillForAutoSkip = (
  state: BattleState,
  unit: BattleUnit,
  skill: BattleSkill,
): boolean => {
  if (skill.triggerType !== "active") return false;
  if (!canUseSkill(unit, skill.damageType)) return false;
  if (getSkillCooldownRemainingRounds(unit, skill.id) > 0) return false;
  if (skill.cost.lingqi && unit.lingqi < skill.cost.lingqi) return false;
  if (skill.cost.qixue && unit.qixue <= skill.cost.qixue) return false;

  if (
    skill.targetType === "self" ||
    skill.targetType === "single_enemy" ||
    skill.targetType === "single_ally"
  ) {
    return resolveAutoSkipTargetIds(state, unit, skill).length > 0;
  }
  return true;
};

export const canPlayerUseAnySkillThisTurn = (
  state: BattleState,
  currentUnit: BattleUnit,
): boolean => {
  const activeSkills = currentUnit.skills.filter(
    (skill) => skill.triggerType === "active",
  );
  const normalAttack = getNormalAttack(currentUnit);
  const candidateSkills = [...activeSkills, normalAttack];
  const seenSkillIds = new Set<string>();

  for (const skill of candidateSkills) {
    if (seenSkillIds.has(skill.id)) continue;
    seenSkillIds.add(skill.id);
    if (canCastSkillForAutoSkip(state, currentUnit, skill)) return true;
  }
  return false;
};

function hasAnyOnlineUser(
  userIds: number[],
  gameServer: ReturnType<typeof getGameServer>,
): boolean {
  for (const userId of userIds) {
    if (!Number.isFinite(userId) || userId <= 0) continue;
    if (gameServer.isUserOnline(userId)) return true;
  }
  return false;
}

async function shouldServerTakeoverDisconnectedPlayerTurn(
  battleId: string,
  state: BattleState,
  currentUnit: BattleUnit,
): Promise<boolean> {
  if (state.currentTeam !== "attacker") return false;
  if (currentUnit.type !== "player") return false;
  if (getAttackerPlayerCount(state) <= 1) return false;

  const gameServer = getGameServer();
  const participants = battleParticipants.get(battleId) || [];
  if (!hasAnyOnlineUser(participants, gameServer)) return false;

  const characterId = Math.floor(Number(currentUnit.sourceId));
  if (!Number.isFinite(characterId) || characterId <= 0) return true;

  const ownerUserId = await getUserIdByCharacterId(characterId);
  if (!ownerUserId) return true;
  return !gameServer.isUserOnline(ownerUserId);
}

function clearPlayerTurnTimeoutState(battleId: string): void {
  playerTurnTimeoutStateByBattleId.delete(battleId);
}

function clearWaitingPlayerTurnState(battleId: string): void {
  lastWaitingPlayerTurnKeyByBattleId.delete(battleId);
}

function buildPlayerTurnKey(state: BattleState, currentUnit: BattleUnit): string {
  return [
    String(state.roundCount ?? ""),
    String(state.currentTeam ?? ""),
    String(state.currentUnitId ?? ""),
    currentUnit.id,
  ].join("|");
}

function shouldTakeoverPlayerTurnByTimeout(
  battleId: string,
  state: BattleState,
  currentUnit: BattleUnit,
  now: number = Date.now(),
): boolean {
  const turnKey = buildPlayerTurnKey(state, currentUnit);
  const current = playerTurnTimeoutStateByBattleId.get(battleId);

  if (!current || current.turnKey !== turnKey) {
    playerTurnTimeoutStateByBattleId.set(battleId, {
      turnKey,
      deadlineAt: now + PLAYER_ACTION_TIMEOUT_MS,
    });
    return false;
  }

  if (now < current.deadlineAt) return false;
  clearPlayerTurnTimeoutState(battleId);
  return true;
}

function shouldEmitWaitingPlayerTurnState(
  battleId: string,
  state: BattleState,
  currentUnit: BattleUnit,
): boolean {
  const turnKey = buildPlayerTurnKey(state, currentUnit);
  const previousTurnKey = lastWaitingPlayerTurnKeyByBattleId.get(battleId);
  if (previousTurnKey === turnKey) {
    return false;
  }
  lastWaitingPlayerTurnKeyByBattleId.set(battleId, turnKey);
  return true;
}

// ------ tick 驱动 ------

/**
 * 核心 tick 逻辑：推进一步战斗
 *
 * 注意：finishBattle 通过延迟 import 从 settlement.ts 获取，避免循环依赖。
 */
async function tickBattle(battleId: string): Promise<void> {
  if (battleTickLocks.has(battleId)) return;
  battleTickLocks.add(battleId);
  const slowLogger = createSlowOperationLogger({
    label: "battle.tickBattle",
    thresholdMs: BATTLE_TICK_SLOW_THRESHOLD_MS,
    fields: {
      battleId,
    },
  });
  try {
    const engine = activeBattles.get(battleId);
    if (!engine) {
      slowLogger.flush({
        outcome: "engine_missing",
      });
      clearPlayerTurnTimeoutState(battleId);
      clearWaitingPlayerTurnState(battleId);
      stopBattleTicker(battleId);
      return;
    }

    const state = engine.getState();
    if (state.phase === "finished") {
      await emitBattleProgressUpdateSafely(battleId, engine);
      slowLogger.mark("emitBattleProgressUpdateSafely", {
        phase: "finished",
      });
      slowLogger.flush({
        outcome: "finished",
      });
      return;
    }

    if (!engine.getCurrentUnit()) {
      engine.ensureActionableUnit();
      slowLogger.mark("ensureActionableUnit");
    }

    const currentUnit = engine.getCurrentUnit();
    if (!currentUnit) {
      clearPlayerTurnTimeoutState(battleId);
      clearWaitingPlayerTurnState(battleId);
      if (engine.getState().phase === "finished") {
        await emitBattleProgressUpdateSafely(battleId, engine);
        slowLogger.mark("emitBattleProgressUpdateSafely", {
          phase: "finished_after_repair",
        });
      }
      slowLogger.flush({
        outcome: "no_current_unit",
      });
      return;
    }

    if (currentUnit.type === "player") {
      if (state.currentTeam !== "attacker") {
        engine.aiAction(true);
        slowLogger.mark("engine.aiAction", {
          reason: "defender_player_turn",
        });
        await emitBattleProgressUpdateSafely(battleId, engine);
        slowLogger.mark("emitBattleProgressUpdateSafely");
        slowLogger.flush({
          outcome: "auto_player_action",
        });
        return;
      }
      if (isStunned(currentUnit) || isFeared(currentUnit)) {
        engine.aiAction(true);
        slowLogger.mark("engine.aiAction", {
          reason: "controlled_player_turn",
        });
        await emitBattleProgressUpdateSafely(battleId, engine);
        slowLogger.mark("emitBattleProgressUpdateSafely");
        slowLogger.flush({
          outcome: "controlled_player_action",
        });
        return;
      }
      if (
        await shouldServerTakeoverDisconnectedPlayerTurn(
          battleId,
          state,
          currentUnit,
        )
      ) {
        engine.aiAction(true);
        slowLogger.mark("engine.aiAction", {
          reason: "offline_takeover",
        });
        await emitBattleProgressUpdateSafely(battleId, engine);
        slowLogger.mark("emitBattleProgressUpdateSafely");
        slowLogger.flush({
          outcome: "offline_takeover",
        });
        return;
      }
      if (!canPlayerUseAnySkillThisTurn(state, currentUnit)) {
        engine.aiAction(true);
        slowLogger.mark("engine.aiAction", {
          reason: "no_available_skill",
        });
        await emitBattleProgressUpdateSafely(battleId, engine);
        slowLogger.mark("emitBattleProgressUpdateSafely");
        slowLogger.flush({
          outcome: "no_available_skill",
        });
        return;
      }
      if (shouldTakeoverPlayerTurnByTimeout(battleId, state, currentUnit)) {
        clearWaitingPlayerTurnState(battleId);
        engine.aiAction(true);
        slowLogger.mark("engine.aiAction", {
          reason: "timeout_takeover",
        });
        await emitBattleProgressUpdateSafely(battleId, engine);
        slowLogger.mark("emitBattleProgressUpdateSafely");
        slowLogger.flush({
          outcome: "timeout_takeover",
        });
        return;
      }
      if (!shouldEmitWaitingPlayerTurnState(battleId, state, currentUnit)) {
        slowLogger.flush({
          outcome: "wait_player_silent",
        });
        return;
      }
      emitBattleUpdate(battleId, {
        kind: "battle_state",
        battleId,
        state: engine.getState(),
      });
      slowLogger.mark("emitBattleUpdate", {
        waitingPlayer: true,
      });
      slowLogger.flush({
        outcome: "wait_player_emit",
      });
      return;
    }

    clearPlayerTurnTimeoutState(battleId);
    clearWaitingPlayerTurnState(battleId);
    engine.aiAction();
    slowLogger.mark("engine.aiAction", {
      unitType: currentUnit.type,
    });
    await emitBattleProgressUpdateSafely(battleId, engine);
    slowLogger.mark("emitBattleProgressUpdateSafely");
    slowLogger.flush({
      outcome: "ai_action",
    });
  } catch (error) {
    slowLogger.flush({
      failed: true,
      outcome: "exception",
    });
    console.error(
      `[battle] tickBattle 发生未处理异常，已停止 ticker: ${battleId}`,
      error,
    );
    stopBattleTicker(battleId);
  } finally {
    battleTickLocks.delete(battleId);
  }
}

function ensureBattleTickerScheduler(): void {
  if (battleTickerScheduler) {
    return;
  }

  battleTickerScheduler = setInterval(() => {
    const battleIds = Array.from(battleTickers.keys());
    for (const battleId of battleIds) {
      void tickBattle(battleId);
    }
  }, BATTLE_TICK_MS);
}

function stopBattleTickerSchedulerIfIdle(): void {
  if (battleTickers.size > 0) {
    return;
  }
  if (!battleTickerScheduler) {
    return;
  }
  clearInterval(battleTickerScheduler);
  battleTickerScheduler = null;
}

export function startBattleTicker(battleId: string): void {
  if (battleTickers.has(battleId)) return;
  battleTickers.set(battleId, true);
  ensureBattleTickerScheduler();
  void tickBattle(battleId);
}

export function stopBattleTicker(battleId: string): void {
  clearPlayerTurnTimeoutState(battleId);
  clearWaitingPlayerTurnState(battleId);
  battleTickers.delete(battleId);
  stopBattleTickerSchedulerIfIdle();
  battleTickLocks.delete(battleId);
  clearBattleLogStream(battleId);
  battleLastRedisSavedAt.delete(battleId);
}

export function stopAllBattleTickers(): void {
  battleTickers.clear();
  if (battleTickerScheduler) {
    clearInterval(battleTickerScheduler);
    battleTickerScheduler = null;
  }
}
