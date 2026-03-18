/**
 * 组队相关战斗钩子
 *
 * 作用：
 * - onUserJoinTeam: 加入队伍时自动退出单人 PVE 战斗
 * - onUserLeaveTeam: 离开队伍时同步移除参战资格与攻击方玩家单位
 * - syncBattleStateOnReconnect: 重连时推送活跃战斗状态
 *
 * 复用点：teamService.ts / gameServer.ts 调用。
 *
 * 边界条件：
 * 1) onUserJoinTeam 仅退出单人 PVE 战斗（多人战斗不处理）
 * 2) onUserLeaveTeam 不终止整场多人战斗，但必须同步修正 attacker.units 与当前行动指针
 */

import { getGameServer } from "../../game/gameServer.js";
import {
  activeBattles,
  battleParticipants,
  getAttackerPlayerCount,
  getUserIdByCharacterId,
  listActiveBattleIdsByUserId,
  setBattleParticipantsForBattle,
  syncBattleCharacterIndex,
} from "./runtime/state.js";
import { abandonBattle } from "./action.js";

/**
 * 同步移除离队玩家的参战资格与攻击方玩家单位，避免 participants 与 battle state 脱节。
 */
async function removeUserFromTeamBattle(
  userId: number,
  battleId: string,
): Promise<void> {
  const engine = activeBattles.get(battleId);
  if (!engine) return;

  const state = engine.getState();
  const ownedAttackerUnitIds: string[] = [];
  for (const unit of state.teams.attacker.units) {
    if (unit.type !== "player") continue;
    const characterId = Math.floor(Number(unit.sourceId));
    if (!Number.isFinite(characterId) || characterId <= 0) continue;
    const ownerUserId = await getUserIdByCharacterId(characterId);
    if (ownerUserId !== userId) continue;
    ownedAttackerUnitIds.push(unit.id);
  }

  engine.removeAttackerUnits(ownedAttackerUnitIds);
  syncBattleCharacterIndex(battleId, engine.getState());

  const participants = battleParticipants.get(battleId) || [];
  const nextParticipants = participants.filter((id) => id !== userId);
  setBattleParticipantsForBattle(battleId, nextParticipants);
}

export async function onUserJoinTeam(userId: number): Promise<void> {
  const battleIds = listActiveBattleIdsByUserId(userId);
  if (battleIds.length === 0) return;
  for (const battleId of battleIds) {
    const engine = activeBattles.get(battleId);
    if (!engine) continue;
    const state = engine.getState();
    const playerCount = getAttackerPlayerCount(state);
    if (state.battleType !== "pve") continue;
    if (playerCount > 1) continue;
    try {
      await abandonBattle(userId, battleId);
    } catch (error) {
      console.warn(`[battle] onUserJoinTeam 自动退出战斗失败: ${battleId}`, error);
    }
  }
}

export async function onUserLeaveTeam(userId: number): Promise<void> {
  const battleIds = listActiveBattleIdsByUserId(userId);
  if (battleIds.length === 0) return;
  for (const battleId of battleIds) {
    const engine = activeBattles.get(battleId);
    if (!engine) continue;
    const state = engine.getState();
    const playerCount = getAttackerPlayerCount(state);
    if (state.battleType !== "pve") continue;
    if (playerCount <= 1) continue;
    await removeUserFromTeamBattle(userId, battleId);
    try {
      const gameServer = getGameServer();
      gameServer.emitToUser(userId, "battle:update", {
        kind: "battle_abandoned",
        battleId,
        success: true,
        message: "已离开队伍，退出队伍战斗",
      });
    } catch (error) {
      console.warn(`[battle] onUserLeaveTeam 推送退出战斗失败: ${battleId}`, error);
    }
  }
}

export async function syncBattleStateOnReconnect(
  userId: number,
): Promise<void> {
  const battleIds = listActiveBattleIdsByUserId(userId);
  if (battleIds.length === 0) return;

  const gameServer = getGameServer();
  if (!gameServer) return;

  for (const battleId of battleIds) {
    const engine = activeBattles.get(battleId);
    if (!engine) continue;

    const state = engine.getState();

    if (state.phase === "finished") continue;

    gameServer.emitToUser(userId, "battle:update", {
      kind: "battle_started",
      battleId,
      state,
    });
  }
}
