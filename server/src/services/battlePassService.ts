import { query, withTransaction } from '../config/database.js';
import { Transactional } from '../decorators/transactional.js';
import { BusinessError } from '../middleware/BusinessError.js';
import {
  getBattlePassStaticConfig,
  type BattlePassRewardEntry,
} from './staticConfigLoader.js';
import { getCharacterIdByUserId as getCharacterIdByUserIdShared } from './shared/characterId.js';
import { enqueueCharacterItemGrant } from './shared/characterItemGrantDeltaService.js';
import { applyCharacterRewardDeltas, createCharacterRewardDelta } from './shared/characterRewardSettlement.js';
import { getCharacterComputedByCharacterId } from './characterComputedService.js';
import { assertServiceSuccess } from './shared/assertServiceSuccess.js';
import {
  getRewardCurrencyDisplayName,
  resolveRewardItemDisplayMeta,
} from './shared/rewardDisplay.js';

export type BattlePassTaskDto = {
  id: string;
  code: string;
  name: string;
  description: string;
  taskType: 'daily' | 'weekly' | 'season';
  condition: unknown;
  targetValue: number;
  rewardExp: number;
  rewardExtra: unknown[];
  enabled: boolean;
  sortWeight: number;
  progressValue: number;
  completed: boolean;
  claimed: boolean;
};

export type BattlePassTasksOverviewDto = {
  seasonId: string;
  daily: BattlePassTaskDto[];
  weekly: BattlePassTaskDto[];
  season: BattlePassTaskDto[];
};

type BattlePassTaskType = BattlePassTaskDto['taskType'];

export type CompleteBattlePassTaskResult = {
  success: boolean;
  message: string;
  data?: {
    taskId: string;
    taskType: BattlePassTaskType;
    gainedExp: number;
    exp: number;
    level: number;
    maxLevel: number;
    expPerLevel: number;
  };
};

export type BattlePassStatusDto = {
  seasonId: string;
  seasonName: string;
  exp: number;
  level: number;
  maxLevel: number;
  expPerLevel: number;
  premiumUnlocked: boolean;
  claimedFreeLevels: number[];
  claimedPremiumLevels: number[];
};

export type BattlePassRewardItemDto =
  | {
      type: 'currency';
      currency: 'spirit_stones' | 'silver';
      amount: number;
      name: string;
      icon: null;
    }
  | {
      type: 'item';
      itemDefId: string;
      qty: number;
      name: string;
      icon: string | null;
    };

export type BattlePassRewardDto = {
  level: number;
  freeRewards: BattlePassRewardItemDto[];
  premiumRewards: BattlePassRewardItemDto[];
};

export type ClaimRewardResult = {
  success: boolean;
  message: string;
  data?: {
    level: number;
    track: 'free' | 'premium';
    rewards: BattlePassRewardItemDto[];
    spiritStones?: number;
    silver?: number;
  };
};

type BattlePassClaimReservationRow = {
  claimed_level: number | string;
};

type BattlePassTaskCompletionTransitionRow = {
  existing_completed: boolean | null;
  existing_completed_at: Date | string | null;
  existing_updated_at: Date | string | null;
  completed_task_id: string | null;
};

// --- 私有辅助函数（模块级） ---

const getTaskTypeOrder = (taskType: BattlePassTaskType): number => {
  if (taskType === 'daily') return 1;
  if (taskType === 'weekly') return 2;
  return 3;
};

const reserveBattlePassRewardClaimTx = async (
  characterId: number,
  seasonId: string,
  level: number,
  track: 'free' | 'premium',
): Promise<boolean> => {
  const res = await query<BattlePassClaimReservationRow>(
    `
      INSERT INTO battle_pass_claim_record (character_id, season_id, level, track, claimed_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (character_id, season_id, level, track) DO NOTHING
      RETURNING level AS claimed_level
    `,
    [characterId, seasonId, level, track],
  );
  return res.rows.length > 0;
};

const toDate = (value: unknown): Date | null => {
  if (value instanceof Date) return value;
  if (typeof value === 'string' && value) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
};

const getBattlePassTaskCycleStart = (taskType: BattlePassTaskType, now: Date): Date | null => {
  if (taskType === 'daily') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return start;
  }
  if (taskType === 'weekly') {
    const start = new Date(now);
    const day = start.getDay();
    const offset = day === 0 ? 6 : day - 1;
    start.setDate(start.getDate() - offset);
    start.setHours(0, 0, 0, 0);
    return start;
  }
  return null;
};

const isInCurrentCycle = (taskType: BattlePassTaskType, timestamp: Date | null, now: Date): boolean => {
  if (!timestamp) return false;
  const cycleStart = getBattlePassTaskCycleStart(taskType, now);
  if (cycleStart) {
    return timestamp.getTime() >= cycleStart.getTime();
  }
  return true;
};

const completeBattlePassTaskProgressTx = async (
  characterId: number,
  seasonId: string,
  taskId: string,
  taskType: BattlePassTaskType,
  targetValue: number,
  cycleStart: Date | null,
): Promise<{
  completed: boolean;
  previousCompleted: boolean;
  previousCompletedAt: Date | null;
  previousUpdatedAt: Date | null;
}> => {
  const res = await query<BattlePassTaskCompletionTransitionRow>(
    `
      WITH current_progress AS (
        SELECT completed, completed_at, updated_at
        FROM battle_pass_task_progress
        WHERE character_id = $1
          AND season_id = $2
          AND task_id = $3
        LIMIT 1
      ),
      completed_progress AS (
        UPDATE battle_pass_task_progress
        SET progress_value = GREATEST(progress_value, $4::bigint),
            completed = true,
            completed_at = NOW(),
            claimed = true,
            claimed_at = NOW(),
            updated_at = NOW()
        WHERE character_id = $1
          AND season_id = $2
          AND task_id = $3
          AND (
            $5::text = 'season'
            OR updated_at >= $6::timestamptz
          )
          AND progress_value >= $4::bigint
          AND NOT (
            completed = true
            AND (
              $5::text = 'season'
              OR completed_at >= $6::timestamptz
            )
          )
        RETURNING task_id
      )
      SELECT
        (SELECT completed FROM current_progress LIMIT 1) AS existing_completed,
        (SELECT completed_at FROM current_progress LIMIT 1) AS existing_completed_at,
        (SELECT updated_at FROM current_progress LIMIT 1) AS existing_updated_at,
        (SELECT task_id FROM completed_progress LIMIT 1) AS completed_task_id
    `,
    [characterId, seasonId, taskId, targetValue, taskType, cycleStart],
  );
  const row = res.rows[0];
  return {
    completed: typeof row?.completed_task_id === 'string' && row.completed_task_id === taskId,
    previousCompleted: row?.existing_completed === true,
    previousCompletedAt: toDate(row?.existing_completed_at),
    previousUpdatedAt: toDate(row?.existing_updated_at),
  };
};

const toBattlePassRewardItemDto = (
  reward: BattlePassRewardEntry,
): BattlePassRewardItemDto | null => {
  if (reward.type === 'currency') {
    if (reward.currency !== 'silver' && reward.currency !== 'spirit_stones') return null;
    const amount = Number.isFinite(Number(reward.amount)) ? Math.max(0, Number(reward.amount)) : 0;
    if (amount <= 0) return null;
    return {
      type: 'currency',
      currency: reward.currency,
      amount,
      name: getRewardCurrencyDisplayName(reward.currency),
      icon: null,
    };
  }

  if (reward.type !== 'item') return null;
  const itemDefId = String(reward.item_def_id || '').trim();
  const qty = Number.isFinite(Number(reward.qty)) ? Math.max(1, Number(reward.qty)) : 1;
  if (!itemDefId) return null;
  const itemMeta = resolveRewardItemDisplayMeta(itemDefId);
  return {
    type: 'item',
    itemDefId,
    qty,
    name: itemMeta.name,
    icon: itemMeta.icon,
  };
};

const toBattlePassRewardItemDtos = (
  rewards: BattlePassRewardEntry[],
): BattlePassRewardItemDto[] => {
  return rewards
    .map((reward) => toBattlePassRewardItemDto(reward))
    .filter((reward): reward is BattlePassRewardItemDto => reward !== null);
};

const getResolvedSeasonFromStaticConfig = (seasonId?: string, now: Date = new Date()) => {
  const config = getBattlePassStaticConfig();
  if (!config || config.season.enabled === false) return null;

  if (typeof seasonId === 'string' && seasonId.trim()) {
    return config.season.id === seasonId.trim() ? config.season : null;
  }

  const startAt = new Date(config.season.start_at);
  const endAt = new Date(config.season.end_at);
  const inActiveRange = !Number.isNaN(startAt.getTime()) && !Number.isNaN(endAt.getTime())
    ? startAt.getTime() <= now.getTime() && endAt.getTime() > now.getTime()
    : false;
  return inActiveRange ? config.season : config.season;
};

const getActiveBattlePassSeasonIdImpl = async (now: Date = new Date()): Promise<string | null> => {
  const season = getResolvedSeasonFromStaticConfig(undefined, now);
  if (!season) return null;
  const startAt = new Date(season.start_at);
  const endAt = new Date(season.end_at);
  if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) return null;
  return startAt.getTime() <= now.getTime() && endAt.getTime() > now.getTime() ? season.id : null;
};

const getFallbackBattlePassSeasonId = async (): Promise<string | null> => {
  return getBattlePassStaticConfig()?.season?.enabled === false ? null : getBattlePassStaticConfig()?.season?.id ?? null;
};

// --- BattlePassService 类 ---
/**
 * 战令服务
 *
 * 作用：战令赛季任务查询、完成、奖励领取等核心逻辑
 * 纯读方法不加 @Transactional，写操作方法加 @Transactional
 *
 * 边界条件：
 * 1) claimBattlePassReward 通过 @Transactional + query 自动复用事务上下文，奖励物品走异步资产 Delta，不再同步占用背包锁
 * 2) completeBattlePassTask 内的 FOR UPDATE 查询依赖事务上下文，由 @Transactional 保证
 */
class BattlePassService {
  // 纯读方法，不加 @Transactional
  async getCharacterIdByUserId(userId: number): Promise<number | null> {
    return getCharacterIdByUserIdShared(userId);
  }

  // 纯读方法，不加 @Transactional
  async getActiveBattlePassSeasonId(now: Date = new Date()): Promise<string | null> {
    return getActiveBattlePassSeasonIdImpl(now);
  }

  // 纯读方法，不加 @Transactional
  async getBattlePassTasksOverview(userId: number, seasonId?: string): Promise<BattlePassTasksOverviewDto> {
    const config = getBattlePassStaticConfig();
    const resolvedSeasonId =
      (typeof seasonId === 'string' && seasonId.trim() ? seasonId.trim() : null) ??
      (await getActiveBattlePassSeasonIdImpl()) ??
      (await getFallbackBattlePassSeasonId()) ??
      '';

    const characterId = await this.getCharacterIdByUserId(userId);
    if (!characterId) {
      return { seasonId: resolvedSeasonId, daily: [], weekly: [], season: [] };
    }

    if (!resolvedSeasonId) {
      return { seasonId: '', daily: [], weekly: [], season: [] };
    }

    const taskRows = (config?.tasks ?? [])
      .filter((task) => task.enabled !== false)
      .filter((task) => resolvedSeasonId === (config?.season.id ?? ''));

    const progressRes = await query(
      `
        SELECT task_id, progress_value, completed, completed_at, claimed, claimed_at, updated_at
        FROM battle_pass_task_progress
        WHERE season_id = $1 AND character_id = $2
      `,
      [resolvedSeasonId, characterId],
    );
    const progressByTaskId = new Map<string, Record<string, unknown>>();
    for (const row of progressRes.rows ?? []) {
      const taskId = String(row.task_id || '');
      if (!taskId) continue;
      progressByTaskId.set(taskId, row as Record<string, unknown>);
    }

    const now = new Date();
    const rows: BattlePassTaskDto[] = taskRows.map((task) => {
      const progress = progressByTaskId.get(task.id);
      const completedAt = toDate(progress?.completed_at);
      const claimedAt = toDate(progress?.claimed_at);
      const updatedAt = toDate(progress?.updated_at);
      const completed = progress?.completed === true && isInCurrentCycle(task.task_type, completedAt, now);
      const claimed = progress?.claimed === true && isInCurrentCycle(task.task_type, claimedAt, now);
      const rawProgressValue = Number(progress?.progress_value ?? 0);
      const normalizedRawProgress = Number.isFinite(rawProgressValue) ? Math.max(0, rawProgressValue) : 0;
      const progressValue = updatedAt && isInCurrentCycle(task.task_type, updatedAt, now) ? normalizedRawProgress : 0;
      return {
        id: task.id,
        code: task.code,
        name: task.name,
        description: String(task.description || ''),
        taskType: task.task_type,
        condition: task.condition ?? {},
        targetValue: Number.isFinite(Number(task.target_value)) ? Number(task.target_value) : 1,
        rewardExp: Number.isFinite(Number(task.reward_exp)) ? Number(task.reward_exp) : 0,
        rewardExtra: Array.isArray(task.reward_extra) ? task.reward_extra : [],
        enabled: task.enabled !== false,
        sortWeight: Number.isFinite(Number(task.sort_weight)) ? Number(task.sort_weight) : 0,
        progressValue: Number.isFinite(progressValue) ? progressValue : 0,
        completed,
        claimed,
      };
    }).sort((left, right) => {
      const typeOrder = getTaskTypeOrder(left.taskType) - getTaskTypeOrder(right.taskType);
      if (typeOrder !== 0) return typeOrder;
      if (left.sortWeight !== right.sortWeight) return right.sortWeight - left.sortWeight;
      return left.id.localeCompare(right.id);
    });

    return {
      seasonId: resolvedSeasonId,
      daily: rows.filter((x) => x.taskType === 'daily'),
      weekly: rows.filter((x) => x.taskType === 'weekly'),
      season: rows.filter((x) => x.taskType === 'season'),
    };
  }

  // 写操作方法，加 @Transactional
  @Transactional
  async completeBattlePassTask(userId: number, taskId: string): Promise<CompleteBattlePassTaskResult> {
    const normalizedTaskId = String(taskId || '').trim();
    if (!normalizedTaskId) return { success: false, message: '任务ID无效' };

    const characterId = await this.getCharacterIdByUserId(userId);
    if (!characterId) return { success: false, message: '角色不存在' };

    const seasonId = (await getActiveBattlePassSeasonIdImpl()) ?? (await getFallbackBattlePassSeasonId());
    if (!seasonId) return { success: false, message: '当前没有进行中的赛季' };

    const config = getBattlePassStaticConfig();
    const season = config?.season?.id === seasonId ? config.season : null;
    if (!season) return { success: false, message: '赛季配置不存在' };

    const task = (config?.tasks ?? []).find((entry) => entry.id === normalizedTaskId && entry.enabled !== false);
    if (!task) return { success: false, message: '任务不存在或未启用' };

    const maxLevel = Number(season.max_level) || 30;
    const expPerLevel = Number(season.exp_per_level) || 1000;
    const maxExp = Math.max(0, maxLevel * expPerLevel);

    const taskType = String(task.task_type || 'daily') as BattlePassTaskType;
    if (taskType !== 'daily' && taskType !== 'weekly' && taskType !== 'season') {
      return { success: false, message: '任务类型不支持' };
    }
    const targetValue = Math.max(1, Number(task.target_value) || 1);
    const rewardExp = Math.max(0, Number(task.reward_exp) || 0);

    const now = new Date();
    const cycleStart = getBattlePassTaskCycleStart(taskType, now);
    const completeTransition = await completeBattlePassTaskProgressTx(
      characterId,
      seasonId,
      normalizedTaskId,
      taskType,
      targetValue,
      cycleStart,
    );
    if (!completeTransition.completed) {
      if (completeTransition.previousCompleted && isInCurrentCycle(taskType, completeTransition.previousCompletedAt, now)) {
        return { success: false, message: '任务已完成' };
      }
      return { success: false, message: '任务目标未达成，无法完成' };
    }

    const bpProgressRes = await query(
      `
        INSERT INTO battle_pass_progress (character_id, season_id, exp, created_at, updated_at)
        VALUES ($1, $2, LEAST($3::bigint, $4::bigint), NOW(), NOW())
        ON CONFLICT (character_id, season_id)
        DO UPDATE SET
          exp = LEAST($4::bigint, battle_pass_progress.exp + $3::bigint),
          updated_at = NOW()
        RETURNING exp
      `,
      [characterId, seasonId, rewardExp, maxExp],
    );

    const exp = Number(bpProgressRes.rows[0]?.exp ?? 0);
    const level = Math.min(Math.floor(exp / expPerLevel) + 1, maxLevel);
    return {
      success: true,
      message: '任务完成',
      data: {
        taskId: normalizedTaskId,
        taskType,
        gainedExp: rewardExp,
        exp,
        level,
        maxLevel,
        expPerLevel,
      },
    };
  }

  // 纯读方法，不加 @Transactional
  async getBattlePassStatus(userId: number): Promise<BattlePassStatusDto | null> {
    const characterId = await this.getCharacterIdByUserId(userId);
    if (!characterId) return null;

    const seasonId = (await getActiveBattlePassSeasonIdImpl()) ?? (await getFallbackBattlePassSeasonId());
    if (!seasonId) return null;

    const season = getBattlePassStaticConfig()?.season;
    if (!season || season.id !== seasonId) return null;
    const maxLevel = Number(season.max_level) || 30;
    const expPerLevel = Number(season.exp_per_level) || 1000;

    const progressRes = await query(
      `SELECT exp, premium_unlocked FROM battle_pass_progress WHERE character_id = $1 AND season_id = $2`,
      [characterId, seasonId],
    );
    const exp = Number(progressRes.rows[0]?.exp ?? 0);
    const premiumUnlocked = progressRes.rows[0]?.premium_unlocked === true;

    const claimRes = await query(
      `SELECT level, track FROM battle_pass_claim_record WHERE character_id = $1 AND season_id = $2`,
      [characterId, seasonId],
    );
    const claimedFreeLevels: number[] = [];
    const claimedPremiumLevels: number[] = [];
    for (const row of claimRes.rows) {
      if (row.track === 'free') claimedFreeLevels.push(Number(row.level));
      else if (row.track === 'premium') claimedPremiumLevels.push(Number(row.level));
    }

    const level = Math.min(Math.floor(exp / expPerLevel) + 1, maxLevel);

    return {
      seasonId,
      seasonName: String(season.name || ''),
      exp,
      level,
      maxLevel,
      expPerLevel,
      premiumUnlocked,
      claimedFreeLevels: claimedFreeLevels.sort((a, b) => a - b),
      claimedPremiumLevels: claimedPremiumLevels.sort((a, b) => a - b),
    };
  }

  // 纯读方法，不加 @Transactional
  async getBattlePassRewards(seasonId?: string): Promise<BattlePassRewardDto[]> {
    const config = getBattlePassStaticConfig();
    const resolvedSeasonId =
      (typeof seasonId === 'string' && seasonId.trim() ? seasonId.trim() : null) ??
      (await getActiveBattlePassSeasonIdImpl()) ??
      (await getFallbackBattlePassSeasonId()) ??
      '';
    if (!resolvedSeasonId) return [];

    if (!config || config.season.id !== resolvedSeasonId) return [];
    return config.rewards.map((row) => ({
      level: Number(row.level),
      freeRewards: toBattlePassRewardItemDtos(Array.isArray(row.free) ? row.free : []),
      premiumRewards: toBattlePassRewardItemDtos(Array.isArray(row.premium) ? row.premium : []),
    }));
  }

  // 写操作方法，加 @Transactional
  async claimBattlePassReward(
    userId: number,
    level: number,
    track: 'free' | 'premium',
  ): Promise<ClaimRewardResult> {
    const characterId = await this.getCharacterIdByUserId(userId);
    if (!characterId) return { success: false, message: '角色不存在' };

    const seasonId = (await getActiveBattlePassSeasonIdImpl()) ?? (await getFallbackBattlePassSeasonId());
    if (!seasonId) return { success: false, message: '当前没有进行中的赛季' };

    const config = getBattlePassStaticConfig();
    const season = config?.season?.id === seasonId ? config.season : null;
    if (!season) return { success: false, message: '赛季配置不存在' };

    // 获取赛季配置
    const maxLevel = Number(season.max_level) || 30;
    const expPerLevel = Number(season.exp_per_level) || 1000;
    const rewardRow = (config?.rewards ?? []).find((entry) => Number(entry.level) === level);

    if (level < 1 || level > maxLevel) {
      return { success: false, message: '等级无效' };
    }
    if (!rewardRow) {
      return { success: false, message: '奖励配置不存在' };
    }

    const rewardEntries: BattlePassRewardEntry[] =
      track === 'free'
        ? (Array.isArray(rewardRow.free) ? rewardRow.free : [])
        : (Array.isArray(rewardRow.premium) ? rewardRow.premium : []);
    const rewards = toBattlePassRewardItemDtos(rewardEntries);

    try {
      return await withTransaction(async () => {
        const progressRes = await query(
          `SELECT exp, premium_unlocked FROM battle_pass_progress WHERE character_id = $1 AND season_id = $2 FOR UPDATE`,
          [characterId, seasonId],
        );
        const exp = Number(progressRes.rows[0]?.exp ?? 0);
        const premiumUnlocked = progressRes.rows[0]?.premium_unlocked === true;
        const currentLevel = Math.min(Math.floor(exp / expPerLevel) + 1, maxLevel);

        if (level > currentLevel) {
          return { success: false, message: '等级未解锁' };
        }

        if (track === 'premium' && !premiumUnlocked) {
          return { success: false, message: '未解锁特权通行证' };
        }

        const claimed = await reserveBattlePassRewardClaimTx(characterId, seasonId, level, track);
        if (!claimed) {
          return { success: false, message: '该等级奖励已领取' };
        }

        const rewardDelta = createCharacterRewardDelta();

        for (const reward of rewardEntries) {
          if (reward.type === 'currency') {
            const amount = Number(reward.amount) || 0;
            if (reward.currency === 'spirit_stones' && amount > 0) {
              rewardDelta.spiritStones += amount;
            } else if (reward.currency === 'silver' && amount > 0) {
              rewardDelta.silver += amount;
            }
          } else if (reward.type === 'item') {
            const itemDefId = reward.item_def_id;
            const qty = Number(reward.qty) || 1;
            if (itemDefId && qty > 0) {
              const addResult = await enqueueCharacterItemGrant({
                characterId,
                userId,
                itemDefId,
                qty,
                obtainedFrom: 'battle_pass',
              });
              assertServiceSuccess({
                success: addResult.success,
                message: addResult.message || '添加物品失败',
              });
            }
          }
        }

        if (rewardDelta.exp !== 0 || rewardDelta.silver !== 0 || rewardDelta.spiritStones !== 0) {
          await applyCharacterRewardDeltas(new Map([[characterId, rewardDelta]]));
        }

        const characterComputed = await getCharacterComputedByCharacterId(characterId);
        return {
          success: true,
          message: '领取成功',
          data: {
            level,
            track,
            rewards,
            spiritStones: Number(characterComputed?.spirit_stones ?? 0),
            silver: Number(characterComputed?.silver ?? 0),
          },
        };
      });
    } catch (error) {
      if (error instanceof BusinessError) {
        return { success: false, message: error.message };
      }
      throw error;
    }
  }
}

export const battlePassService = new BattlePassService();
