/**
 * 悟道系统服务
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：提供悟道总览查询与经验注入写操作；校验解锁条件、计算可注入结果、扣减经验并更新进度。
 * 2) 不做什么：不负责 HTTP 参数解析，不负责客户端提示文案渲染。
 *
 * 输入/输出：
 * - 输入：userId、本次注入经验预算（exp）。
 * - 输出：统一的 `{ success, message, data }` 业务结果。
 *
 * 数据流/状态流：
 * route -> insightService.getOverview/injectExp -> query(character + insight_progress) ->
 *   规则计算 -> 更新数据库 -> 失效角色属性缓存。
 *
 * 关键边界条件与坑点：
 * 1) injectExp 必须在事务中执行，且对角色与悟道进度行加锁，避免并发双花经验。
 * 2) 本服务不做“经验保底”兼容逻辑，允许经验被扣减到 0（符合产品要求）。
 */
import { query } from '../config/database.js';
import { Transactional } from '../decorators/transactional.js';
import { invalidateCharacterComputedCache } from './characterComputedService.js';
import { getInsightGrowthConfig } from './staticConfigLoader.js';
import {
  buildInsightPctBonusByLevel,
  calcInsightCostByLevel,
} from './shared/insightRules.js';
import { getRealmRankZeroBased, normalizeRealmKeepingUnknown } from './shared/realmRules.js';

export interface InsightOverviewDto {
  unlocked: boolean;
  unlockRealm: string;
  currentLevel: number;
  currentProgressExp: number;
  currentBonusPct: number;
  nextLevelCostExp: number;
  characterExp: number;
  costStageLevels: number;
  costStageBaseExp: number;
  bonusPctPerLevel: number;
}

export interface InsightInjectRequest {
  exp: number;
}

export interface InsightInjectResultDto {
  beforeLevel: number;
  afterLevel: number;
  afterProgressExp: number;
  actualInjectedLevels: number;
  spentExp: number;
  remainingExp: number;
  gainedBonusPct: number;
  currentBonusPct: number;
}

export interface InsightResult<T = undefined> {
  success: boolean;
  message: string;
  data?: T;
}

interface CharacterInsightRow {
  characterId: number;
  realm: string;
  subRealm: string | null;
  exp: number;
}

export interface InsightInjectResolution {
  actualInjectedLevels: number;
  spentExp: number;
  remainingExp: number;
  afterLevel: number;
  afterProgressExp: number;
  beforeBonusPct: number;
  afterBonusPct: number;
}

const normalizeInteger = (value: unknown): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
};

const loadCharacterInsightRow = async (userId: number, forUpdate: boolean): Promise<CharacterInsightRow | null> => {
  const lockSql = forUpdate ? 'FOR UPDATE' : '';
  const result = await query(
    `
      SELECT id, realm, sub_realm, exp
      FROM characters
      WHERE user_id = $1
      LIMIT 1
      ${lockSql}
    `,
    [userId],
  );
  if (result.rows.length <= 0) return null;

  const row = result.rows[0] as Record<string, unknown>;
  return {
    characterId: normalizeInteger(row.id),
    realm: typeof row.realm === 'string' ? row.realm : '凡人',
    subRealm: typeof row.sub_realm === 'string' ? row.sub_realm : null,
    exp: normalizeInteger(row.exp),
  };
};

interface InsightProgressRow {
  level: number;
  progressExp: number;
}

const loadInsightProgress = async (characterId: number, forUpdate: boolean): Promise<InsightProgressRow> => {
  if (forUpdate) {
    await query(
      `
        INSERT INTO character_insight_progress (character_id, level, progress_exp, total_exp_spent, created_at, updated_at)
        VALUES ($1, 0, 0, 0, NOW(), NOW())
        ON CONFLICT (character_id) DO NOTHING
      `,
      [characterId],
    );
  }

  const lockSql = forUpdate ? 'FOR UPDATE' : '';
  const progressRes = await query(
    `
      SELECT level, progress_exp
      FROM character_insight_progress
      WHERE character_id = $1
      LIMIT 1
      ${lockSql}
    `,
    [characterId],
  );
  if (progressRes.rows.length <= 0) {
    return { level: 0, progressExp: 0 };
  }
  const row = progressRes.rows[0] as Record<string, unknown>;
  return {
    level: normalizeInteger(row.level),
    progressExp: normalizeInteger(row.progress_exp),
  };
};

export const isInsightUnlocked = (realm: string, subRealm: string | null, unlockRealm: string): boolean => {
  const currentRealm = normalizeRealmKeepingUnknown(realm, subRealm);
  const currentRank = getRealmRankZeroBased(currentRealm);
  const unlockRank = getRealmRankZeroBased(unlockRealm);
  return currentRank >= unlockRank;
};

export const resolveInsightInjectPlan = (params: {
  beforeLevel: number;
  beforeProgressExp: number;
  characterExp: number;
  injectExpBudget: number;
  config: ReturnType<typeof getInsightGrowthConfig>;
}): InsightInjectResolution => {
  const { beforeLevel, beforeProgressExp, characterExp, injectExpBudget, config } = params;
  const safeBeforeLevel = normalizeInteger(beforeLevel);
  const safeCharacterExp = normalizeInteger(characterExp);
  const safeInjectExpBudget = Math.min(safeCharacterExp, normalizeInteger(injectExpBudget));
  let remainingBudgetExp = safeInjectExpBudget;
  let currentLevel = safeBeforeLevel;
  let currentProgressExp = normalizeInteger(beforeProgressExp);
  let gainedLevels = 0;

  /**
   * 数据一致性校验：当前等级内进度不能大于等于该等级升级所需经验。
   * 若出现异常，直接抛错阻断写入，避免写出更脏数据。
   */
  const beforeLevelCost = calcInsightCostByLevel(safeBeforeLevel + 1, config);
  if (currentProgressExp >= beforeLevelCost) {
    throw new Error('悟道进度异常：当前等级进度已超过升级需求');
  }

  /**
   * 可部分注入结算：
   * 1) 优先把经验注入当前等级剩余缺口；
   * 2) 若填满则自动升 1 级并继续；
   * 3) 不足以升级时也会累积到 progress_exp（允许 1 点经验注入）。
   */
  while (remainingBudgetExp > 0) {
    const nextLevelCost = calcInsightCostByLevel(currentLevel + 1, config);
    const requiredExp = Math.max(0, nextLevelCost - currentProgressExp);
    if (requiredExp <= 0) {
      currentLevel += 1;
      currentProgressExp = 0;
      gainedLevels += 1;
      continue;
    }

    if (remainingBudgetExp >= requiredExp) {
      remainingBudgetExp -= requiredExp;
      currentLevel += 1;
      currentProgressExp = 0;
      gainedLevels += 1;
      continue;
    }

    currentProgressExp += remainingBudgetExp;
    remainingBudgetExp = 0;
  }

  const afterLevel = currentLevel;
  const beforeBonusPct = buildInsightPctBonusByLevel(safeBeforeLevel, config);
  const afterBonusPct = buildInsightPctBonusByLevel(afterLevel, config);
  const spentExp = safeInjectExpBudget - remainingBudgetExp;
  return {
    actualInjectedLevels: gainedLevels,
    spentExp,
    remainingExp: Math.max(0, safeCharacterExp - spentExp),
    afterLevel,
    afterProgressExp: currentProgressExp,
    beforeBonusPct,
    afterBonusPct,
  };
};

class InsightService {
  /**
   * 获取悟道总览（读操作）
   */
  async getOverview(userId: number): Promise<InsightResult<InsightOverviewDto>> {
    try {
      const config = getInsightGrowthConfig();
      const character = await loadCharacterInsightRow(userId, false);
      if (!character || character.characterId <= 0) {
        return { success: false, message: '角色不存在' };
      }

      const progress = await loadInsightProgress(character.characterId, false);
      const unlocked = isInsightUnlocked(character.realm, character.subRealm, config.unlock_realm);

      return {
        success: true,
        message: 'ok',
        data: {
          unlocked,
          unlockRealm: config.unlock_realm,
          currentLevel: progress.level,
          currentProgressExp: progress.progressExp,
          currentBonusPct: buildInsightPctBonusByLevel(progress.level, config),
          nextLevelCostExp: calcInsightCostByLevel(progress.level + 1, config),
          characterExp: character.exp,
          costStageLevels: config.cost_stage_levels,
          costStageBaseExp: config.cost_stage_base_exp,
          bonusPctPerLevel: config.bonus_pct_per_level,
        },
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : '未知错误';
      return { success: false, message: `悟道配置异常：${reason}` };
    }
  }

  /**
   * 注入经验进行悟道升级（写操作，事务）
   */
  @Transactional
  async injectExp(userId: number, request: InsightInjectRequest): Promise<InsightResult<InsightInjectResultDto>> {
    try {
      const config = getInsightGrowthConfig();
      const injectExpBudget = normalizeInteger(request.exp);
      if (injectExpBudget <= 0) {
        return {
          success: false,
          message: '注入经验无效，需大于 0',
        };
      }

      const character = await loadCharacterInsightRow(userId, true);
      if (!character || character.characterId <= 0) {
        return { success: false, message: '角色不存在' };
      }

      const unlocked = isInsightUnlocked(character.realm, character.subRealm, config.unlock_realm);
      if (!unlocked) {
        return { success: false, message: `未达到${config.unlock_realm}，无法悟道` };
      }

      const beforeProgress = await loadInsightProgress(character.characterId, true);
      const beforeLevel = beforeProgress.level;
      const injectPlan = resolveInsightInjectPlan({
        beforeLevel,
        beforeProgressExp: beforeProgress.progressExp,
        characterExp: character.exp,
        injectExpBudget,
        config,
      });
      if (injectPlan.spentExp <= 0) {
        return { success: false, message: '经验不足，无法悟道' };
      }

      const currentBonusPct = injectPlan.afterBonusPct;

      await query(
        `
          UPDATE characters
          SET exp = $2,
              updated_at = NOW()
          WHERE id = $1
        `,
        [character.characterId, injectPlan.remainingExp],
      );

      await query(
        `
          UPDATE character_insight_progress
          SET level = $2,
              progress_exp = $3,
              total_exp_spent = total_exp_spent + $4,
              updated_at = NOW()
          WHERE character_id = $1
        `,
        [character.characterId, injectPlan.afterLevel, injectPlan.afterProgressExp, injectPlan.spentExp],
      );

      await invalidateCharacterComputedCache(character.characterId);

      return {
        success: true,
        message: '悟道成功',
        data: {
          beforeLevel,
          afterLevel: injectPlan.afterLevel,
          afterProgressExp: injectPlan.afterProgressExp,
          actualInjectedLevels: injectPlan.actualInjectedLevels,
          spentExp: injectPlan.spentExp,
          remainingExp: injectPlan.remainingExp,
          gainedBonusPct: injectPlan.afterBonusPct - injectPlan.beforeBonusPct,
          currentBonusPct,
        },
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : '未知错误';
      return { success: false, message: `悟道失败：${reason}` };
    }
  }
}

export const insightService = new InsightService();
export default insightService;
