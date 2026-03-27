import {
  getOnlineBattleCharacterSnapshotsByCharacterIds,
  getArenaProjection,
  listArenaProjections,
  canArenaChallengeTodayProjection,
} from './onlineBattleProjectionService.js';
import { DEFAULT_ARENA_DAILY_LIMIT } from './shared/arenaProjection.js';
import { computeRankPower } from './shared/rankPower.js';

export type ArenaStatus = {
  score: number;
  winCount: number;
  loseCount: number;
  todayUsed: number;
  todayLimit: number;
  todayRemaining: number;
};

export const getArenaStatus = async (
  characterId: number,
): Promise<{ success: boolean; message: string; data?: ArenaStatus }> => {
  const projection = await getArenaProjection(characterId);
  if (!projection) return { success: false, message: '竞技场投影不存在' };

  return {
    success: true,
    message: 'ok',
    data: {
      score: projection.score,
      winCount: projection.winCount,
      loseCount: projection.loseCount,
      todayUsed: projection.todayUsed,
      todayLimit: projection.todayLimit || DEFAULT_ARENA_DAILY_LIMIT,
      todayRemaining: projection.todayRemaining,
    },
  };
};

export type ArenaOpponent = {
  id: number;
  name: string;
  realm: string;
  power: number;
  score: number;
};

export const getArenaOpponents = async (
  characterId: number,
  limit: number = 10,
): Promise<{ success: boolean; message: string; data?: ArenaOpponent[] }> => {
  const selfProjection = await getArenaProjection(characterId);
  if (!selfProjection) return { success: false, message: '竞技场投影不存在' };

  const normalizedLimit = Math.max(1, Math.min(50, Math.floor(Number(limit) || 10)));
  const allProjections = listArenaProjections()
    .filter((projection) => projection.characterId !== characterId)
    .sort((left, right) => Math.abs(left.score - selfProjection.score) - Math.abs(right.score - selfProjection.score))
    .slice(0, normalizedLimit);

  if (allProjections.length <= 0) {
    return { success: true, message: 'ok', data: [] };
  }

  const snapshots = await getOnlineBattleCharacterSnapshotsByCharacterIds(
    allProjections.map((projection) => projection.characterId),
  );

  const opponents: ArenaOpponent[] = [];
  for (const projection of allProjections) {
    const snapshot = snapshots.get(projection.characterId);
    if (!snapshot) continue;
    opponents.push({
      id: snapshot.characterId,
      name: snapshot.computed.nickname,
      realm: snapshot.computed.realm,
      power: Math.max(0, computeRankPower(snapshot.computed)),
      score: projection.score,
    });
  }

  return { success: true, message: 'ok', data: opponents };
};

export type ArenaRecord = {
  id: string;
  ts: number;
  opponentName: string;
  opponentRealm: string;
  opponentPower: number;
  result: 'win' | 'lose' | 'draw';
  deltaScore: number;
  scoreAfter: number;
};

export const getArenaRecords = async (
  characterId: number,
  limit: number = 50,
): Promise<{ success: boolean; message: string; data?: ArenaRecord[] }> => {
  const projection = await getArenaProjection(characterId);
  if (!projection) return { success: false, message: '竞技场投影不存在' };
  const normalizedLimit = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)));
  return {
    success: true,
    message: 'ok',
    data: projection.records.slice(0, normalizedLimit),
  };
};

export const canChallengeToday = async (
  characterId: number,
): Promise<{ allowed: boolean; remaining: number }> => {
  return canArenaChallengeTodayProjection(characterId);
};

export { DEFAULT_ARENA_SCORE as DEFAULT_ARENA_RATING_VALUE } from './shared/arenaProjection.js';
