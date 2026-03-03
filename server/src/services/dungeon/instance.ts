/**
 * 秘境实例管理（创建/加入/查询）
 *
 * 作用：处理秘境实例的生命周期管理（不含战斗和结算）。
 * 不做什么：不处理战斗开启、推进、奖励发放。
 *
 * 输入：userId / instanceId / dungeonId / difficultyRank。
 * 输出：实例创建结果 / 加入结果 / 查询结果。
 *
 * 复用点：通过 service.ts 暴露给路由层。
 *
 * 边界条件：
 * 1) createDungeonInstance 组队时只有队长可创建。
 * 2) joinDungeonInstance 依赖事务 + 行锁，确保“检查状态 + 写入 participants”原子执行。
 */

import crypto from 'crypto';
import { query } from '../../config/database.js';
import { getDungeonAndDifficulty } from './shared/stageData.js';
import {
  parseParticipants,
  getUserAndCharacter,
  getTeamParticipants,
} from './shared/participants.js';
import { asObject, asNumber } from './shared/typeUtils.js';
import type {
  DungeonInstanceStatus,
  DungeonInstanceParticipant,
  DungeonInstanceRow,
} from './types.js';

/** 创建秘境实例 */
export const createDungeonInstance = async (
  userId: number,
  dungeonId: string,
  difficultyRank: number
): Promise<
  | { success: true; data: { instanceId: string; status: DungeonInstanceStatus; participants: DungeonInstanceParticipant[] } }
  | { success: false; message: string }
> => {
  try {
    const user = await getUserAndCharacter(userId);
    if (!user.ok) return { success: false, message: user.message };

    const dd = await getDungeonAndDifficulty(dungeonId, difficultyRank);
    if (!dd.ok) return { success: false, message: dd.message };

    if (user.teamId && !user.isLeader) {
      return { success: false, message: '组队中只有队长可以创建秘境' };
    }

    const participants: DungeonInstanceParticipant[] = user.teamId
      ? await getTeamParticipants(user.teamId)
      : [{ userId, characterId: user.characterId, role: 'leader' as const }];

    if (participants.length < dd.dungeon.min_players) {
      return { success: false, message: `人数不足，需要至少${dd.dungeon.min_players}人` };
    }
    if (participants.length > dd.dungeon.max_players) {
      return { success: false, message: `人数超限，最多${dd.dungeon.max_players}人` };
    }

    const instanceId = crypto.randomUUID();
    await query(
      `
        INSERT INTO dungeon_instance (id, dungeon_id, difficulty_id, creator_id, team_id, status, current_stage, current_wave, participants, instance_data)
        VALUES ($1, $2, $3, $4, $5, 'preparing', 1, 1, $6::jsonb, '{}'::jsonb)
      `,
      [instanceId, dungeonId, dd.difficulty.id, user.characterId, user.teamId, JSON.stringify(participants)]
    );

    return { success: true, data: { instanceId, status: 'preparing', participants } };
  } catch (error) {
    console.error('创建秘境实例失败:', error);
    return { success: false, message: '创建秘境实例失败' };
  }
};

/** 加入秘境实例 */
export const joinDungeonInstance = async (
  userId: number,
  instanceId: string
): Promise<
  | { success: true; data: { instanceId: string; status: DungeonInstanceStatus; participants: DungeonInstanceParticipant[] } }
  | { success: false; message: string }
> => {
  try {
    const user = await getUserAndCharacter(userId);
    if (!user.ok) return { success: false, message: user.message };
    if (!user.teamId) return { success: false, message: '未加入队伍，无法加入秘境' };

    const instRes = await query(`SELECT * FROM dungeon_instance WHERE id = $1 LIMIT 1 FOR UPDATE`, [instanceId]);
    if (instRes.rows.length === 0) return { success: false, message: '秘境实例不存在' };
    const inst = instRes.rows[0] as DungeonInstanceRow;
    if (inst.status !== 'preparing') return { success: false, message: '该秘境已开始或已结束' };
    if (!inst.team_id || inst.team_id !== user.teamId) return { success: false, message: '不是同一队伍，无法加入' };

    const curParticipants = parseParticipants(inst.participants);
    if (curParticipants.some((p) => p.userId === userId)) {
      return { success: true, data: { instanceId, status: inst.status, participants: curParticipants } };
    }

    const dd = await getDungeonAndDifficulty(inst.dungeon_id, 1);
    if (!dd.ok) return { success: false, message: dd.message };

    const nextParticipants = [...curParticipants, { userId, characterId: user.characterId, role: 'member' as const }];
    if (nextParticipants.length > dd.dungeon.max_players) {
      return { success: false, message: `人数超限，最多${dd.dungeon.max_players}人` };
    }

    const updateRes = await query(
      `UPDATE dungeon_instance SET participants = $1::jsonb WHERE id = $2 AND status = 'preparing'`,
      [JSON.stringify(nextParticipants), instanceId],
    );
    if ((updateRes.rowCount ?? 0) === 0) {
      return { success: false, message: '该秘境已开始或已结束' };
    }
    return { success: true, data: { instanceId, status: inst.status, participants: nextParticipants } };
  } catch (error) {
    console.error('加入秘境实例失败:', error);
    return { success: false, message: '加入秘境实例失败' };
  }
};

/** 获取秘境实例状态 */
export const getDungeonInstance = async (
  userId: number,
  instanceId: string
): Promise<
  | {
    success: true;
    data: {
      instance: {
        id: string;
        dungeonId: string;
        difficultyId: string;
        status: DungeonInstanceStatus;
        currentStage: number;
        currentWave: number;
        participants: DungeonInstanceParticipant[];
        currentBattleId: string | null;
        startTime: string | null;
        endTime: string | null;
      };
    };
  }
  | { success: false; message: string }
> => {
  try {
    const instRes = await query(`SELECT * FROM dungeon_instance WHERE id = $1 LIMIT 1`, [instanceId]);
    if (instRes.rows.length === 0) return { success: false, message: '秘境实例不存在' };
    const inst = instRes.rows[0] as DungeonInstanceRow;
    const participants = parseParticipants(inst.participants);
    if (!participants.some((p) => p.userId === userId)) return { success: false, message: '无权访问该秘境' };

    const dataObj = asObject(inst.instance_data) ?? {};
    const currentBattleId = typeof dataObj.currentBattleId === 'string' ? dataObj.currentBattleId : null;

    return {
      success: true,
      data: {
        instance: {
          id: inst.id,
          dungeonId: inst.dungeon_id,
          difficultyId: inst.difficulty_id,
          status: inst.status,
          currentStage: asNumber(inst.current_stage, 1),
          currentWave: asNumber(inst.current_wave, 1),
          participants,
          currentBattleId,
          startTime: inst.start_time ?? null,
          endTime: inst.end_time ?? null,
        },
      },
    };
  } catch (error) {
    console.error('获取秘境实例失败:', error);
    return { success: false, message: '获取秘境实例失败' };
  }
};
