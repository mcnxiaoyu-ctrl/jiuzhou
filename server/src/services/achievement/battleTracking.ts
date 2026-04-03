/**
 * 战斗成就状态追踪模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一维护“战斗连胜状态 + 低血胜利判定”的成就追踪逻辑，避免 battle settlement 各分支重复写判定和持久化。
 * 2. 做什么：为同一 battleId 提供幂等保护，防止战斗终态重复结算时把连胜与低血成就重复记入。
 * 3. 不做什么：不处理掉落、任务、秘境通关奖励，也不替代通用 `updateAchievementProgress` 的定义匹配能力。
 *
 * 输入/输出：
 * - 输入：`battleId`、`battleResult`、本次战斗中攻击方玩家的终态快照
 * - 输出：无；副作用是更新战斗成就状态表，并在命中条件时推进成就进度
 *
 * 数据流/状态流：
 * 战斗结算终态 -> 本模块锁定角色战斗成就状态 -> 内存归并连胜与低血命中 -> 批量更新 battle 状态表 -> 批量推进成就进度。
 *
 * 关键边界条件与坑点：
 * 1. 连胜是强顺序状态，必须按 battleId 做幂等；同一战斗重复进入结算链时只能处理一次。
 * 2. 低血胜利必须基于战斗终态快照判断，且要求角色存活并满足剩余气血比例 `<= 10%`，不能用战前或过程态替代。
 */

import { afterTransactionCommit, query } from '../../config/database.js';
import { Transactional } from '../../decorators/transactional.js';
import { notifyAchievementUpdate } from '../achievementPush.js';
import { getAchievementDefinitions } from '../staticConfigLoader.js';
import {
  parseAchievementDefRow,
  parseCharacterAchievementRow,
} from './shared.js';
import type { AchievementStatus } from './types.js';

export type AchievementBattleParticipantSnapshot = {
  characterId: number;
  finalQixue: number;
  finalMaxQixue: number;
};

type AchievementBattleStateRow = {
  character_id: number;
  current_win_streak: number;
  last_processed_battle_id: string | null;
};

type AchievementBattleStateMutationRow = {
  character_id: number;
  current_win_streak: number;
  last_processed_battle_id: string;
};

type BattleAchievementProgressDefinition = {
  achievementId: string;
  points: number;
  targetValue: number;
  trackType: 'flag' | 'counter';
};

type BattleAchievementProgressInput = {
  characterId: number;
  achievementId: string;
  increment: number;
  points: number;
  targetValue: number;
  trackType: 'flag' | 'counter';
};

type BattleAchievementProgressSeedRow = {
  character_id: number;
  achievement_id: string;
};

type BattleAchievementProgressMutationRow = {
  character_id: number;
  achievement_id: string;
  status: AchievementStatus;
  progress: number;
  progress_data: Record<string, number | boolean | string>;
  completed_now: boolean;
};

type BattleAchievementPointsDeltaRow = {
  character_id: number;
  total_points: number;
  combat_points: number;
};

type ParsedCharacterAchievementRow = NonNullable<ReturnType<typeof parseCharacterAchievementRow>>;

const LOW_HP_VICTORY_RATIO = 0.1;
const WIN_STREAK_TARGET = 10;
const BATTLE_WIN_STREAK_TRACK_KEY = 'battle:win:streak:10';
const BATTLE_LOW_HP_WIN_TRACK_KEY = 'battle:win:low_hp';
const REQUIRED_BATTLE_ACHIEVEMENT_TRACK_KEYS = [
  BATTLE_WIN_STREAK_TRACK_KEY,
  BATTLE_LOW_HP_WIN_TRACK_KEY,
] as const;

let battleAchievementDefinitionCache: ReadonlyMap<string, BattleAchievementProgressDefinition> | null = null;

const normalizePositiveInt = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : 0;
};

export const isLowHpVictorySnapshot = (
  snapshot: AchievementBattleParticipantSnapshot,
): boolean => {
  const finalMaxQixue = normalizePositiveInt(snapshot.finalMaxQixue);
  const finalQixue = normalizePositiveInt(snapshot.finalQixue);
  if (finalMaxQixue <= 0 || finalQixue <= 0) return false;
  return finalQixue / finalMaxQixue <= LOW_HP_VICTORY_RATIO;
};

const buildAchievementPairKey = (characterId: number, achievementId: string): string => {
  return `${characterId}:${achievementId}`;
};

const loadBattleAchievementDefinitions = (): ReadonlyMap<string, BattleAchievementProgressDefinition> => {
  if (battleAchievementDefinitionCache) {
    return battleAchievementDefinitionCache;
  }

  const definitions = new Map<string, BattleAchievementProgressDefinition>();
  for (const definition of getAchievementDefinitions()) {
    const parsed = parseAchievementDefRow(definition as Record<string, unknown>);
    if (!parsed || parsed.enabled === false) continue;
    if (!REQUIRED_BATTLE_ACHIEVEMENT_TRACK_KEYS.includes(parsed.track_key as typeof REQUIRED_BATTLE_ACHIEVEMENT_TRACK_KEYS[number])) {
      continue;
    }
    if (parsed.track_type !== 'flag' && parsed.track_type !== 'counter') {
      throw new Error(`战斗成就定义类型非法: trackKey=${parsed.track_key}, trackType=${parsed.track_type}`);
    }

    definitions.set(parsed.track_key, {
      achievementId: parsed.id,
      points: parsed.points,
      targetValue: parsed.target_value,
      trackType: parsed.track_type,
    });
  }

  const missingTrackKeys = REQUIRED_BATTLE_ACHIEVEMENT_TRACK_KEYS.filter((trackKey) => !definitions.has(trackKey));
  if (missingTrackKeys.length > 0) {
    throw new Error(`缺少战斗成就定义: ${missingTrackKeys.join(', ')}`);
  }

  battleAchievementDefinitionCache = definitions;
  return definitions;
};

class AchievementBattleTrackingService {
  private normalizeSnapshots(
    snapshots: AchievementBattleParticipantSnapshot[],
  ): AchievementBattleParticipantSnapshot[] {
    const snapshotByCharacterId = new Map<number, AchievementBattleParticipantSnapshot>();

    for (const snapshot of snapshots) {
      const characterId = normalizePositiveInt(snapshot.characterId);
      if (characterId <= 0) continue;

      snapshotByCharacterId.set(characterId, {
        characterId,
        finalQixue: normalizePositiveInt(snapshot.finalQixue),
        finalMaxQixue: normalizePositiveInt(snapshot.finalMaxQixue),
      });
    }

    return [...snapshotByCharacterId.values()];
  }

  private async loadBattleStatesForUpdate(
    characterIds: number[],
  ): Promise<Map<number, AchievementBattleStateRow>> {
    const stateResult = await query<AchievementBattleStateRow>(
      `
        WITH seeded AS (
          INSERT INTO character_achievement_battle_state (character_id)
          SELECT DISTINCT x.character_id
          FROM unnest($1::int[]) AS x(character_id)
          ON CONFLICT (character_id) DO NOTHING
          RETURNING character_id
        )
        SELECT state.character_id, state.current_win_streak, state.last_processed_battle_id
        FROM character_achievement_battle_state state
        WHERE state.character_id = ANY($1::int[])
        FOR UPDATE
      `,
      [characterIds],
    );

    const stateByCharacterId = new Map<number, AchievementBattleStateRow>();
    for (const row of stateResult.rows) {
      stateByCharacterId.set(row.character_id, row);
    }
    return stateByCharacterId;
  }

  private async applyBattleAchievementProgress(
    progressInputs: BattleAchievementProgressInput[],
  ): Promise<void> {
    if (progressInputs.length <= 0) return;

    const aggregatedInputs = new Map<string, BattleAchievementProgressInput>();
    for (const input of progressInputs) {
      const pairKey = buildAchievementPairKey(input.characterId, input.achievementId);
      const existing = aggregatedInputs.get(pairKey);
      if (existing) {
        existing.increment += input.increment;
        continue;
      }
      aggregatedInputs.set(pairKey, { ...input });
    }

    const progressSeedRows: BattleAchievementProgressSeedRow[] = [];
    for (const input of aggregatedInputs.values()) {
      progressSeedRows.push({
        character_id: input.characterId,
        achievement_id: input.achievementId,
      });
    }

    const progressResult = await query(
      `
        WITH target_rows AS (
          SELECT DISTINCT x.character_id, x.achievement_id
          FROM jsonb_to_recordset($1::jsonb)
            AS x(character_id int, achievement_id varchar(64))
        ),
        seeded_points AS (
          INSERT INTO character_achievement_points (character_id)
          SELECT DISTINCT tr.character_id
          FROM target_rows tr
          ON CONFLICT (character_id) DO NOTHING
          RETURNING character_id
        ),
        seeded_progress AS (
          INSERT INTO character_achievement (character_id, achievement_id, status, progress, progress_data)
          SELECT tr.character_id, tr.achievement_id, 'in_progress', 0, '{}'::jsonb
          FROM target_rows tr
          ON CONFLICT (character_id, achievement_id) DO NOTHING
          RETURNING character_id, achievement_id
        )
        SELECT
          ca.*,
          (SELECT COUNT(*) FROM seeded_points) AS seeded_points_count,
          (SELECT COUNT(*) FROM seeded_progress) AS seeded_progress_count
        FROM character_achievement ca
        INNER JOIN target_rows tr
          ON tr.character_id = ca.character_id
         AND tr.achievement_id = ca.achievement_id
        FOR UPDATE OF ca
      `,
      [JSON.stringify(progressSeedRows)],
    );

    const progressByPair = new Map<string, ParsedCharacterAchievementRow>();
    for (const row of progressResult.rows as Array<Record<string, unknown>>) {
      const parsed = parseCharacterAchievementRow(row);
      if (!parsed) continue;
      progressByPair.set(buildAchievementPairKey(parsed.character_id, parsed.achievement_id), parsed);
    }

    const progressMutationRows: BattleAchievementProgressMutationRow[] = [];
    const pointDeltaByCharacterId = new Map<number, BattleAchievementPointsDeltaRow>();
    const changedCharacterIds = new Set<number>();

    for (const input of aggregatedInputs.values()) {
      const pairKey = buildAchievementPairKey(input.characterId, input.achievementId);
      const currentRow = progressByPair.get(pairKey);
      if (!currentRow) continue;
      if (currentRow.status === 'completed' || currentRow.status === 'claimed') continue;

      const currentProgress = Math.max(0, currentRow.progress);
      const nextProgress =
        input.trackType === 'flag'
          ? currentProgress >= input.targetValue ? currentProgress : input.targetValue
          : Math.min(input.targetValue, currentProgress + input.increment);
      if (nextProgress === currentProgress) continue;

      const nextStatus: AchievementStatus =
        nextProgress >= input.targetValue ? 'completed' : 'in_progress';
      const completedNow = nextStatus === 'completed';

      progressMutationRows.push({
        character_id: input.characterId,
        achievement_id: input.achievementId,
        status: nextStatus,
        progress: nextProgress,
        progress_data: currentRow.progress_data,
        completed_now: completedNow,
      });
      changedCharacterIds.add(input.characterId);

      if (!completedNow || input.points <= 0) continue;

      const existingPointDelta = pointDeltaByCharacterId.get(input.characterId);
      if (existingPointDelta) {
        existingPointDelta.total_points += input.points;
        existingPointDelta.combat_points += input.points;
        continue;
      }

      pointDeltaByCharacterId.set(input.characterId, {
        character_id: input.characterId,
        total_points: input.points,
        combat_points: input.points,
      });
    }

    if (progressMutationRows.length <= 0) return;

    await query(
      `
        WITH updates AS (
          SELECT *
          FROM jsonb_to_recordset($1::jsonb)
            AS x(
              character_id int,
              achievement_id varchar(64),
              status varchar(32),
              progress int,
              progress_data jsonb,
              completed_now boolean
            )
        )
        UPDATE character_achievement ca
        SET status = updates.status,
            progress = updates.progress,
            progress_data = updates.progress_data,
            completed_at = CASE
              WHEN updates.completed_now THEN COALESCE(ca.completed_at, NOW())
              ELSE ca.completed_at
            END,
            updated_at = NOW()
        FROM updates
        WHERE ca.character_id = updates.character_id
          AND ca.achievement_id = updates.achievement_id
      `,
      [JSON.stringify(progressMutationRows)],
    );

    const pointDeltaRows = Array.from(pointDeltaByCharacterId.values()).filter((row) => row.total_points > 0);
    if (pointDeltaRows.length > 0) {
      await query(
        `
          WITH deltas AS (
            SELECT *
            FROM jsonb_to_recordset($1::jsonb)
              AS x(
                character_id int,
                total_points int,
                combat_points int
              )
          )
          UPDATE character_achievement_points cap
          SET total_points = cap.total_points + deltas.total_points,
              combat_points = cap.combat_points + deltas.combat_points,
              updated_at = NOW()
          FROM deltas
          WHERE cap.character_id = deltas.character_id
        `,
        [JSON.stringify(pointDeltaRows)],
      );
    }

    const changedCharacterIdList = Array.from(changedCharacterIds);
    if (changedCharacterIdList.length <= 0) return;

    await afterTransactionCommit(async () => {
      await Promise.all(changedCharacterIdList.map((characterId) => notifyAchievementUpdate(characterId)));
    });
  }

  @Transactional
  async recordBattleOutcomeAchievements(
    battleId: string,
    battleResult: 'attacker_win' | 'defender_win' | 'draw',
    snapshots: AchievementBattleParticipantSnapshot[],
  ): Promise<void> {
    const normalizedBattleId = battleId.trim();
    if (!normalizedBattleId) return;

    const normalizedSnapshots = this.normalizeSnapshots(snapshots);
    if (normalizedSnapshots.length <= 0) return;

    const characterIds = normalizedSnapshots.map((snapshot) => snapshot.characterId);
    const stateByCharacterId = await this.loadBattleStatesForUpdate(characterIds);
    const battleAchievementDefinitions = loadBattleAchievementDefinitions();
    const winStreakAchievement = battleAchievementDefinitions.get(BATTLE_WIN_STREAK_TRACK_KEY)!;
    const lowHpAchievement = battleAchievementDefinitions.get(BATTLE_LOW_HP_WIN_TRACK_KEY)!;

    const isVictory = battleResult === 'attacker_win';
    const battleStateMutationRows: AchievementBattleStateMutationRow[] = [];
    const achievementProgressInputs: BattleAchievementProgressInput[] = [];

    for (const snapshot of normalizedSnapshots) {
      const state = stateByCharacterId.get(snapshot.characterId);
      if (!state) continue;
      if (state.last_processed_battle_id === normalizedBattleId) continue;

      const previousWinStreak = normalizePositiveInt(state.current_win_streak);
      const nextWinStreak = isVictory ? previousWinStreak + 1 : 0;

      battleStateMutationRows.push({
        character_id: snapshot.characterId,
        current_win_streak: nextWinStreak,
        last_processed_battle_id: normalizedBattleId,
      });

      if (isVictory && previousWinStreak < WIN_STREAK_TARGET && nextWinStreak >= WIN_STREAK_TARGET) {
        achievementProgressInputs.push({
          characterId: snapshot.characterId,
          achievementId: winStreakAchievement.achievementId,
          increment: 1,
          points: winStreakAchievement.points,
          targetValue: winStreakAchievement.targetValue,
          trackType: winStreakAchievement.trackType,
        });
      }

      if (isVictory && isLowHpVictorySnapshot(snapshot)) {
        achievementProgressInputs.push({
          characterId: snapshot.characterId,
          achievementId: lowHpAchievement.achievementId,
          increment: 1,
          points: lowHpAchievement.points,
          targetValue: lowHpAchievement.targetValue,
          trackType: lowHpAchievement.trackType,
        });
      }
    }

    if (battleStateMutationRows.length > 0) {
      await query(
        `
          WITH updates AS (
            SELECT *
            FROM jsonb_to_recordset($1::jsonb)
              AS x(
                character_id int,
                current_win_streak int,
                last_processed_battle_id varchar(128)
              )
          )
          UPDATE character_achievement_battle_state state
          SET current_win_streak = updates.current_win_streak,
              last_processed_battle_id = updates.last_processed_battle_id,
              updated_at = NOW()
          FROM updates
          WHERE state.character_id = updates.character_id
        `,
        [JSON.stringify(battleStateMutationRows)],
      );
    }

    if (achievementProgressInputs.length > 0) {
      await this.applyBattleAchievementProgress(achievementProgressInputs);
    }
  }
}

export const achievementBattleTrackingService = new AchievementBattleTrackingService();

export const recordBattleOutcomeAchievements =
  achievementBattleTrackingService.recordBattleOutcomeAchievements.bind(achievementBattleTrackingService);
