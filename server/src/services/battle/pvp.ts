/**
 * PVP 战斗发起与竞技场结算
 *
 * 作用：
 * - startPVPBattle: 创建 PVP 战斗（普通 / 竞技场）
 * - settleArenaBattleIfNeeded: 竞技场评分结算
 *
 * 复用点：路由层 / arenaRoutes 调用 startPVPBattle；settlement.ts / action.ts 调用 settleArenaBattleIfNeeded。
 *
 * 边界条件：
 * 1) 竞技场战斗时 defender 为 NPC 类型，不推送给对手
 * 2) 竞技场评分初始化使用 INSERT ... ON CONFLICT DO NOTHING
 */

import {
  createPVPBattle,
} from "../../battle/battleFactory.js";
import { BattleEngine } from "../../battle/battleEngine.js";
import type { BattleState } from "../../battle/types.js";
import {
  applyArenaBattleResultProjection,
  getArenaProjection,
  getOnlineBattleCharacterSnapshotByCharacterId,
  getOnlineBattleCharacterSnapshotByUserId,
  upsertArenaProjection,
} from "../onlineBattleProjectionService.js";
import type {
  BattleSessionSnapshot,
  PvpBattleSessionContext,
} from "../battleSession/types.js";
import {
  calculateArenaRatingDelta,
  DEFAULT_ARENA_RATING,
  type ArenaBattleOutcome,
} from "../shared/arenaRatingDelta.js";
import { buildArenaProjectionRecord } from '../shared/arenaProjection.js';
import type { BattleResult } from "./battleTypes.js";
import {
  BATTLE_START_COOLDOWN_MS,
  buildCharacterInBattleResult,
  registerStartedBattle,
  validateBattleStartCooldown,
  buildBattleStartCooldownResult,
} from "./runtime/state.js";
import {
  rejectIfIdling,
  isCharacterIdling,
  withBattleStartResources,
  scheduleBattleStartResourcesSyncForUsers,
} from "./shared/preparation.js";
import { buildBattleSnapshotState } from "./runtime/realtime.js";
import { computeRankPower } from "../shared/rankPower.js";

export type ArenaBattleSettlementContext = {
  challengerCharacterId: number;
  opponentCharacterId: number;
};

/**
 * 从权威战斗状态与会话上下文解析竞技场结算对象。
 *
 * 作用：
 * - 统一用 `BattleState + BattleSession` 解析竞技场结算所需的挑战者 / 对手角色 ID。
 * - 明确只对 `mode=arena` 的 PVP 会话放行，避免普通切磋误入竞技场积分链路。
 *
 * 输入 / 输出：
 * - 输入：当前战斗状态 `state` 与绑定会话 `session`。
 * - 输出：可结算时返回竞技场双方角色 ID，否则返回 `null`。
 *
 * 数据流 / 状态流：
 * battle runtime state + attached session -> 本函数校验 arena 模式 -> 返回结算上下文 -> settlement/action 复用。
 *
 * 复用设计说明：
 * - 把“竞技场才结算积分”的规则收敛到单一入口，避免 `settlement.ts` 与 `action.ts` 各自手写一套 mode/ID 判定。
 * - 把脆弱的 `battleId` 字符串拆解移除，后续若 battleId 生成规则调整，只需维护这一处。
 *
 * 关键边界条件与坑点：
 * - 会话缺失或不是 PVP arena 时必须直接返回 `null`，不能让普通 PVP 误扣竞技场次数。
 * - 角色 sourceId / opponentCharacterId 非正整数时必须拒绝结算，避免脏会话把错误角色写进投影。
 */
export const resolveArenaBattleSettlementContext = (params: {
  state: BattleState;
  session: BattleSessionSnapshot | null | undefined;
}): ArenaBattleSettlementContext | null => {
  const { state, session } = params;
  if (state.battleType !== "pvp" || !session || session.type !== "pvp") {
    return null;
  }

  const sessionContext = session.context as PvpBattleSessionContext;
  if (sessionContext.mode !== "arena") {
    return null;
  }

  const challengerCharacterId = Math.floor(
    Number(state.teams.attacker.units[0]?.sourceId ?? 0),
  );
  const opponentCharacterId = Math.floor(
    Number(sessionContext.opponentCharacterId),
  );
  if (!Number.isFinite(challengerCharacterId) || challengerCharacterId <= 0) {
    return null;
  }
  if (!Number.isFinite(opponentCharacterId) || opponentCharacterId <= 0) {
    return null;
  }

  return {
    challengerCharacterId,
    opponentCharacterId,
  };
};

export async function startPVPBattle(
  userId: number,
  opponentCharacterId: number,
  battleId?: string,
): Promise<BattleResult> {
  try {
    const challengerSnapshot = await getOnlineBattleCharacterSnapshotByUserId(userId);
    if (!challengerSnapshot) {
      return { success: false, message: "角色不存在" };
    }
    const challengerBase = challengerSnapshot.computed;

    const challengerCharacterId = Number(challengerBase.id);
    if (!Number.isFinite(challengerCharacterId) || challengerCharacterId <= 0) {
      return { success: false, message: "角色数据异常" };
    }

    const idleReject = await rejectIfIdling(challengerCharacterId);
    if (idleReject) return idleReject;

    const oppId = Number(opponentCharacterId);
    if (!Number.isFinite(oppId) || oppId <= 0) {
      return { success: false, message: "对手参数错误" };
    }

    const opponentSnapshot = await getOnlineBattleCharacterSnapshotByCharacterId(oppId);
    if (!opponentSnapshot) {
      return { success: false, message: "对手不存在" };
    }
    const opponentBase = opponentSnapshot.computed;

    const opponentUserId = Number(opponentBase.user_id);
    if (!Number.isFinite(opponentUserId) || opponentUserId <= 0) {
      return { success: false, message: "对手数据异常" };
    }

    const requestedBattleId =
      typeof battleId === "string" ? battleId.trim() : "";
    const isArenaBattle = requestedBattleId.startsWith("arena-battle-");
    if (!isArenaBattle) {
      const opponentIdling = await isCharacterIdling(oppId);
      if (opponentIdling) {
        return { success: false, message: "对手离线挂机中，无法发起挑战" };
      }
    }

    const challengerInBattleResult = buildCharacterInBattleResult(
      challengerCharacterId,
      "character_in_battle",
      "角色正在战斗中",
    );
    if (challengerInBattleResult) return challengerInBattleResult;
    if (!isArenaBattle) {
      const opponentInBattleResult = buildCharacterInBattleResult(
        oppId,
        "opponent_in_battle",
        "对手正在战斗中",
      );
      if (opponentInBattleResult) return opponentInBattleResult;
    }
    const challengerCooldown = validateBattleStartCooldown(
      challengerCharacterId,
    );
    if (challengerCooldown) {
      return buildBattleStartCooldownResult(
        challengerCooldown,
        "battle_start_cooldown",
      );
    }
    if (!isArenaBattle) {
      const opponentCooldown = validateBattleStartCooldown(oppId);
      if (opponentCooldown) {
        return buildBattleStartCooldownResult(
          opponentCooldown,
          "opponent_battle_start_cooldown",
          "对手刚结束战斗，暂时无法发起挑战",
        );
      }
    }

    const challengerLoadout = challengerSnapshot.loadout;
    const opponentLoadout = opponentSnapshot.loadout;
    if (!challengerLoadout) {
      return { success: false, message: "角色战斗资料不存在" };
    }
    if (!opponentLoadout) {
      return { success: false, message: "对手战斗资料不存在" };
    }
    const challenger = {
      ...challengerBase,
      setBonusEffects: challengerLoadout.setBonusEffects,
    };
    const opponent = {
      ...opponentBase,
      setBonusEffects: opponentLoadout.setBonusEffects,
    };
    const recoveredChallenger = withBattleStartResources(challenger);
    const recoveredOpponent = withBattleStartResources(opponent);

    scheduleBattleStartResourcesSyncForUsers(
      isArenaBattle ? [userId] : [userId, opponentUserId],
      { context: "同步战前资源（PVP战斗）" },
    );

    const finalBattleId = requestedBattleId
      ? requestedBattleId
      : `pvp-battle-${userId}-${Date.now()}`;
    const battleState = createPVPBattle(
      finalBattleId,
      recoveredChallenger,
      challengerLoadout.skills,
      recoveredOpponent,
      opponentLoadout.skills,
      isArenaBattle ? { defenderUnitType: "npc" } : undefined,
    );

    const engine = new BattleEngine(battleState);
    registerStartedBattle(
      finalBattleId,
      engine,
      isArenaBattle ? [userId] : [userId, opponentUserId],
    );

    return {
      success: true,
      message: "战斗开始",
      data: {
        battleId: finalBattleId,
        state: buildBattleSnapshotState(engine.getState()),
        battleStartCooldownMs: BATTLE_START_COOLDOWN_MS,
      },
    };
  } catch (error) {
    console.error("发起PVP战斗失败:", error);
    return { success: false, message: "发起PVP战斗失败" };
  }
}

export async function settleArenaBattleIfNeeded(
  params: {
    battleId: string;
    battleResult: "attacker_win" | "defender_win" | "draw";
    challengerCharacterId: number;
    opponentCharacterId: number;
  },
): Promise<void> {
  const battleId = String(params.battleId);
  const battleResult = params.battleResult;
  const challengerCharacterId = Math.floor(Number(params.challengerCharacterId));
  const opponentCharacterId = Math.floor(Number(params.opponentCharacterId));
  if (!Number.isFinite(challengerCharacterId) || challengerCharacterId <= 0)
    return;
  if (!Number.isFinite(opponentCharacterId) || opponentCharacterId <= 0) return;

  const challengerProjection = await getArenaProjection(challengerCharacterId);
  const opponentProjection = await getArenaProjection(opponentCharacterId);
  const challengerBefore = challengerProjection?.score ?? DEFAULT_ARENA_RATING;
  const opponentBefore = opponentProjection?.score ?? DEFAULT_ARENA_RATING;

  const challengerOutcome: ArenaBattleOutcome =
    battleResult === "attacker_win"
      ? "win"
      : battleResult === "defender_win"
        ? "lose"
        : "draw";
  const challengerDelta = calculateArenaRatingDelta({
    selfRating: challengerBefore,
    opponentRating: opponentBefore,
    outcome: challengerOutcome,
  });
  const challengerAfter = Math.max(0, challengerBefore + challengerDelta);

  const opponentOutcome: ArenaBattleOutcome =
    challengerOutcome === "win"
      ? "lose"
      : challengerOutcome === "lose"
        ? "win"
        : "draw";
  const opponentDelta = calculateArenaRatingDelta({
    selfRating: opponentBefore,
    opponentRating: challengerBefore,
    outcome: opponentOutcome,
  });
  const opponentAfter = Math.max(0, opponentBefore + opponentDelta);

  const opponentSnapshot = await getOnlineBattleCharacterSnapshotByCharacterId(opponentCharacterId);
  await upsertArenaProjection(buildArenaProjectionRecord({
    characterId: opponentCharacterId,
    score: opponentAfter,
    winCount: (opponentProjection?.winCount ?? 0) + (opponentOutcome === 'win' ? 1 : 0),
    loseCount: (opponentProjection?.loseCount ?? 0) + (opponentOutcome === 'lose' ? 1 : 0),
    todayUsed: opponentProjection?.todayUsed ?? 0,
    todayLimit: opponentProjection?.todayLimit ?? 20,
    lastDailyReset: opponentProjection?.lastDailyReset,
    records: opponentProjection?.records ?? [],
  }));
  await applyArenaBattleResultProjection({
    battleId,
    challengerCharacterId,
    opponentCharacterId,
    challengerOutcome,
    challengerScoreDelta: challengerDelta,
    challengerScoreAfter: challengerAfter,
    opponentName: opponentSnapshot?.computed.nickname ?? `修士${opponentCharacterId}`,
    opponentRealm: opponentSnapshot?.computed.realm ?? '凡人',
    opponentPower: opponentSnapshot ? Math.max(0, computeRankPower(opponentSnapshot.computed)) : 0,
  });
}
