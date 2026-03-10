import { query, withTransaction } from '../config/database.js';
import {
  getEnabledMainQuestChapterById,
  getEnabledMainQuestSectionById,
} from './mainQuest/shared/questConfig.js';
import { asArray } from './shared/typeCoercion.js';
import type { PartnerRewardDto } from './partnerService.js';

export const PARTNER_SYSTEM_FEATURE_CODE = 'partner_system';

export interface FeatureUnlockGrantResult {
  featureCode: string;
  newlyUnlocked: boolean;
}

export interface FeatureUnlockApplyResult {
  unlockResults: FeatureUnlockGrantResult[];
  starterPartners: PartnerRewardDto[];
}

export type CharacterRowWithId = {
  id: number;
} & Record<string, unknown>;

interface FeatureUnlockRow {
  feature_code: string;
}

interface MainQuestProgressUnlockRow {
  completed_chapters: string[] | null;
  completed_sections: string[] | null;
}

/**
 * 功能解锁服务
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：集中读写角色功能解锁状态，并在读取前按主线已完成进度补齐漏写的解锁记录。
 * 2) 做什么：统一处理解锁后的副作用，避免主线奖励、角色同步、伙伴入口各写一套补发逻辑。
 * 3) 不做什么：不负责前端展示文案，不兜底旧字段兼容。
 *
 * 输入/输出：
 * - 输入：characterId、功能编码列表、来源信息、可选的角色行。
 * - 输出：已解锁功能列表、逐项解锁结果，或包含副作用结果的聚合结构。
 *
 * 数据流/状态流：
 * 主线奖励/角色同步/伙伴入口 -> 本服务补齐应有解锁 -> character_feature_unlocks -> 调用方读取稳定状态。
 *
 * 关键边界条件与坑点：
 * 1) “新解锁”只看本次插入结果，不能把历史已存在记录误报成新解锁，否则会重复发放初始伙伴。
 * 2) 主线补解锁必须只依赖 `completed_sections/completed_chapters`，不能把“正在做但未提交”的任务节误判成已解锁。
 */

const normalizeFeatureCode = (featureCode: string): string => {
  return String(featureCode || '').trim();
};

const normalizeFeatureCodes = (featureCodes: readonly string[]): string[] => {
  return [...new Set(featureCodes.map((featureCode) => normalizeFeatureCode(featureCode)).filter(Boolean))];
};

const extractUnlockFeatures = (
  config: { unlock_features?: string[] | null } | null | undefined,
): string[] => {
  return normalizeFeatureCodes(asArray<string>(config?.unlock_features ?? []));
};

const collectMainQuestProgressFeatureCodes = async (
  characterId: number,
): Promise<string[]> => {
  const result = await query(
    `
      SELECT completed_chapters, completed_sections
      FROM character_main_quest_progress
      WHERE character_id = $1
      LIMIT 1
    `,
    [characterId],
  );
  const progress = result.rows[0] as MainQuestProgressUnlockRow | undefined;
  if (!progress) {
    return [];
  }

  const featureCodeSet = new Set<string>();

  for (const sectionId of asArray<string>(progress.completed_sections)) {
    const section = getEnabledMainQuestSectionById(sectionId);
    if (!section) continue;
    for (const featureCode of extractUnlockFeatures(
      section.rewards as { unlock_features?: string[] | null } | null,
    )) {
      featureCodeSet.add(featureCode);
    }
  }

  for (const chapterId of asArray<string>(progress.completed_chapters)) {
    const chapter = getEnabledMainQuestChapterById(chapterId);
    if (!chapter) continue;
    for (const featureCode of extractUnlockFeatures(chapter)) {
      featureCodeSet.add(featureCode);
    }
    for (const featureCode of extractUnlockFeatures(
      chapter.chapter_rewards as { unlock_features?: string[] | null } | null,
    )) {
      featureCodeSet.add(featureCode);
    }
  }

  return [...featureCodeSet];
};

const applyFeatureUnlockSideEffects = async (params: {
  characterId: number;
  unlockResults: FeatureUnlockGrantResult[];
  obtainedFrom: string;
  obtainedRefId?: string;
}): Promise<PartnerRewardDto[]> => {
  const starterPartners: PartnerRewardDto[] = [];
  const needsStarterPartner = params.unlockResults.some(
    (unlockResult) =>
      unlockResult.newlyUnlocked && unlockResult.featureCode === PARTNER_SYSTEM_FEATURE_CODE,
  );
  if (!needsStarterPartner) {
    return starterPartners;
  }

  const { partnerService } = await import('./partnerService.js');
  for (const unlockResult of params.unlockResults) {
    if (!unlockResult.newlyUnlocked) continue;
    if (unlockResult.featureCode !== PARTNER_SYSTEM_FEATURE_CODE) continue;
    starterPartners.push(await partnerService.grantStarterPartner({
      characterId: params.characterId,
      obtainedFrom: params.obtainedFrom,
      obtainedRefId: params.obtainedRefId,
    }));
  }

  return starterPartners;
};

export const grantFeatureUnlocksWithSideEffects = async (
  characterId: number,
  featureCodes: string[],
  obtainedFrom: string,
  obtainedRefId?: string,
): Promise<FeatureUnlockApplyResult> => {
  const cid = Math.floor(Number(characterId));
  const normalizedFeatureCodes = normalizeFeatureCodes(featureCodes);
  if (!Number.isFinite(cid) || cid <= 0 || normalizedFeatureCodes.length === 0) {
    return {
      unlockResults: [],
      starterPartners: [],
    };
  }

  return withTransaction(async () => {
    const unlockResults = await grantFeatureUnlocks(
      cid,
      normalizedFeatureCodes,
      obtainedFrom,
      obtainedRefId,
    );
    const starterPartners = await applyFeatureUnlockSideEffects({
      characterId: cid,
      unlockResults,
      obtainedFrom,
      obtainedRefId,
    });
    return {
      unlockResults,
      starterPartners,
    };
  });
};

export const ensureFeatureUnlocksFromMainQuestProgress = async (
  characterId: number,
): Promise<FeatureUnlockApplyResult> => {
  const cid = Math.floor(Number(characterId));
  if (!Number.isFinite(cid) || cid <= 0) {
    return {
      unlockResults: [],
      starterPartners: [],
    };
  }

  return withTransaction(async () => {
    const featureCodes = await collectMainQuestProgressFeatureCodes(cid);
    if (featureCodes.length === 0) {
      return {
        unlockResults: [],
        starterPartners: [],
      };
    }
    return grantFeatureUnlocksWithSideEffects(
      cid,
      featureCodes,
      'main_quest_progress_sync',
    );
  });
};

export const getUnlockedFeatureCodes = async (
  characterId: number,
): Promise<string[]> => {
  const cid = Math.floor(Number(characterId));
  if (!Number.isFinite(cid) || cid <= 0) return [];
  await ensureFeatureUnlocksFromMainQuestProgress(cid);

  const result = await query(
    `
      SELECT feature_code
      FROM character_feature_unlocks
      WHERE character_id = $1
      ORDER BY unlocked_at ASC, id ASC
    `,
    [cid],
  );

  return (result.rows as FeatureUnlockRow[])
    .map((row) => normalizeFeatureCode(row.feature_code))
    .filter((featureCode) => featureCode.length > 0);
};

export const isFeatureUnlocked = async (
  characterId: number,
  featureCode: string,
): Promise<boolean> => {
  const normalizedFeatureCode = normalizeFeatureCode(featureCode);
  const cid = Math.floor(Number(characterId));
  if (!Number.isFinite(cid) || cid <= 0 || !normalizedFeatureCode) return false;
  await ensureFeatureUnlocksFromMainQuestProgress(cid);

  const result = await query(
    `
      SELECT 1
      FROM character_feature_unlocks
      WHERE character_id = $1 AND feature_code = $2
      LIMIT 1
    `,
    [cid, normalizedFeatureCode],
  );
  return result.rows.length > 0;
};

export const grantFeatureUnlocks = async (
  characterId: number,
  featureCodes: string[],
  obtainedFrom: string,
  obtainedRefId?: string,
): Promise<FeatureUnlockGrantResult[]> => {
  const cid = Math.floor(Number(characterId));
  const normalizedFeatureCodes = normalizeFeatureCodes(featureCodes);
  if (!Number.isFinite(cid) || cid <= 0 || normalizedFeatureCodes.length === 0) {
    return [];
  }

  const results: FeatureUnlockGrantResult[] = [];
  for (const featureCode of normalizedFeatureCodes) {
    const insertResult = await query(
      `
        INSERT INTO character_feature_unlocks (
          character_id,
          feature_code,
          obtained_from,
          obtained_ref_id,
          unlocked_at
        )
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (character_id, feature_code) DO NOTHING
        RETURNING feature_code
      `,
      [cid, featureCode, obtainedFrom, obtainedRefId ?? null],
    );

    results.push({
      featureCode,
      newlyUnlocked: insertResult.rows.length > 0,
    });
  }

  return results;
};

export const withUnlockedFeatures = async <TRow extends CharacterRowWithId>(
  row: TRow,
): Promise<TRow & { feature_unlocks: string[] }> => {
  return {
    ...row,
    feature_unlocks: await getUnlockedFeatureCodes(row.id),
  };
};
