/**
 * 动态伙伴归元洗髓执行模块
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：集中封装动态伙伴洗髓的目标校验、AI 基础属性重生成、落库与可选详情回读。
 * 2) 做什么：让同步入口与异步 worker 复用同一份执行逻辑，避免“动态伙伴判定 / 原始描述来源 / 主攻属性生成规则”各写一套。
 * 3) 不做什么：不创建任务、不消费或退回道具，也不负责 Socket 推送。
 *
 * 输入/输出：
 * - 输入：`characterId`、`partnerId`，以及是否刷新动态快照、是否回读伙伴详情。
 * - 输出：统一结果对象；成功时可选返回刷新后的伙伴详情。
 *
 * 数据流/状态流：
 * item / worker -> 本模块校验目标 -> AI 生成基础属性 -> 更新 generated_partner_def -> 刷新战斗快照 -> 可选构建伙伴详情。
 *
 * 复用设计说明：
 * - 异步任务与旧同步入口共用本模块，确保“正常 AI 生成规则”只有一份实现。
 * - 目标伙伴的动态判定、原始描述来源、基础属性回写位置都收口在这里，避免服务层重复维护。
 *
 * 关键边界条件与坑点：
 * 1) 必须读取伙伴定义里的原始 `description`，不能用实例当前描述，否则会把玩家改写过的描述带回生成链路。
 * 2) worker 线程内刷新的是本线程快照；是否同步刷新当前线程缓存由调用方显式决定，不能在这里偷偷假设主线程状态。
 */
import { query } from '../../config/database.js';
import {
  PARTNER_SYSTEM_FEATURE_CODE,
  isFeatureUnlocked,
} from '../featureUnlockService.js';
import {
  getPartnerDefinitionById,
  refreshGeneratedPartnerSnapshots,
  type PartnerDefConfig,
} from '../staticConfigLoader.js';
import {
  scheduleActivePartnerBattleCacheRefreshByCharacterId,
} from '../battle/shared/profileCache.js';
import { scheduleOnlineBattleCharacterSnapshotRefreshByCharacterId } from '../onlineBattleProjectionService.js';
import { schedulePartnerRankSnapshotRefreshByCharacterId } from '../partnerRankSnapshotService.js';
import { tryGenerateGeneratedPartnerBaseAttrs } from './partnerGeneratedPreview.js';
import {
  attachPartnerTradeState,
  buildPartnerDisplay,
  loadSinglePartnerRow,
  loadPartnerTechniqueRows,
  normalizeInteger,
  normalizeText,
  type PartnerDetailDto,
  type PartnerRow,
  type PartnerTechniqueRow,
} from './partnerView.js';
import { loadActivePartnerMarketListing, loadPartnerMarketTradeStateMap } from './partnerMarketState.js';
import {
  loadActivePartnerFusionMaterial,
  loadPartnerFusionLockStateMap,
} from './partnerFusionState.js';
import type { PartnerOwnerRealmContext } from './partnerLevelLimit.js';

type CharacterRealmRow = {
  id: number;
  realm: string;
  sub_realm: string | null;
};

type GeneratedPartnerReboneExecutionParams = {
  characterId: number;
  partnerId: number;
  refreshGeneratedSnapshots: boolean;
  includePartnerDetail: boolean;
};

type GeneratedPartnerReboneTargetContext = {
  character: CharacterRealmRow;
  partnerRow: PartnerRow;
  definition: PartnerDefConfig;
  originalDescription: string;
  requestedBaseModel: string | null;
};

export type GeneratedPartnerReboneExecutionResult<T = undefined> = {
  success: boolean;
  message: string;
  data?: T;
};

const loadCharacterRealmRow = async (
  characterId: number,
  forUpdate: boolean,
): Promise<CharacterRealmRow | null> => {
  const lockSql = forUpdate ? 'FOR UPDATE' : '';
  const result = await query(
    `
      SELECT id, realm, sub_realm
      FROM characters
      WHERE id = $1
      LIMIT 1
      ${lockSql}
    `,
    [characterId],
  );
  if (result.rows.length <= 0) return null;
  return result.rows[0] as CharacterRealmRow;
};

const loadSingleOwnedPartnerRow = async (
  characterId: number,
  partnerId: number,
  forUpdate: boolean,
): Promise<PartnerRow | null> => {
  return loadSinglePartnerRow(characterId, partnerId, forUpdate);
};

const loadPartnerDefinitionOrThrow = async (
  partnerDefId: string,
): Promise<PartnerDefConfig> => {
  const definition = await getPartnerDefinitionById(partnerDefId);
  if (!definition) {
    throw new Error(`伙伴模板不存在: ${partnerDefId}`);
  }
  return definition;
};

const loadGeneratedPartnerRequestedBaseModel = async (
  sourceJobId: string,
): Promise<string | null> => {
  const normalizedSourceJobId = normalizeText(sourceJobId);
  if (!normalizedSourceJobId) return null;
  const result = await query(
    `
      SELECT requested_base_model
      FROM partner_recruit_job
      WHERE id = $1
      LIMIT 1
    `,
    [normalizedSourceJobId],
  );
  if (result.rows.length <= 0) {
    return null;
  }
  return normalizeText((result.rows[0] as { requested_base_model?: string | null }).requested_base_model) || null;
};

const buildPartnerDetailWithTradeState = async (params: {
  row: PartnerRow;
  definition: PartnerDefConfig;
  techniqueRows: PartnerTechniqueRow[];
  ownerRealm: PartnerOwnerRealmContext;
}): Promise<PartnerDetailDto> => {
  const tradeStateMap = await loadPartnerMarketTradeStateMap([params.row.id]);
  const fusionStateMap = await loadPartnerFusionLockStateMap([params.row.id]);
  return attachPartnerTradeState(
    buildPartnerDisplay(params),
    {
      tradeState: tradeStateMap.get(params.row.id),
      fusionState: fusionStateMap.get(params.row.id),
    },
  );
};

const schedulePartnerBattleStateRefreshByCharacterId = async (
  characterId: number,
): Promise<void> => {
  await Promise.all([
    scheduleActivePartnerBattleCacheRefreshByCharacterId(characterId),
    scheduleOnlineBattleCharacterSnapshotRefreshByCharacterId(characterId),
  ]);
};

export const executeGeneratedPartnerRebone = async (
  params: GeneratedPartnerReboneExecutionParams,
): Promise<GeneratedPartnerReboneExecutionResult<PartnerDetailDto>> => {
  try {
    const targetResult = await validateGeneratedPartnerReboneTarget({
      characterId: params.characterId,
      partnerId: params.partnerId,
      forUpdate: true,
    });
    if (!targetResult.success || !targetResult.data) {
      return { success: false, message: targetResult.message };
    }
    const {
      character,
      definition,
      originalDescription,
      requestedBaseModel,
    } = targetResult.data;

    const rerollResult = await tryGenerateGeneratedPartnerBaseAttrs({
      quality: (normalizeText(definition.quality) as '黄' | '玄' | '地' | '天') || '黄',
      requestedBaseModel,
      partner: {
        name: normalizeText(definition.name) || definition.id,
        description: originalDescription,
        role: normalizeText(definition.role) || '伙伴',
        attributeElement: normalizeText(definition.attribute_element) || 'none',
        maxTechniqueSlots: Math.max(0, normalizeInteger(definition.max_technique_slots, 0)),
      },
    });
    if (!rerollResult.success) {
      return { success: false, message: rerollResult.reason };
    }

    await query(
      `
        UPDATE generated_partner_def
        SET base_attrs = $2::jsonb,
            level_attr_gains = $3::jsonb,
            updated_at = NOW()
        WHERE id = $1
      `,
      [
        definition.id,
        JSON.stringify(rerollResult.draft.partner.baseAttrs),
        JSON.stringify(rerollResult.draft.partner.levelAttrGains),
      ],
    );

    if (params.refreshGeneratedSnapshots) {
      await refreshGeneratedPartnerSnapshots();
    }

    await schedulePartnerBattleStateRefreshByCharacterId(params.characterId);
    await schedulePartnerRankSnapshotRefreshByCharacterId(params.characterId);

    if (!params.includePartnerDetail) {
      return {
        success: true,
        message: '归元洗髓成功',
      };
    }

    const refreshedPartner = await loadSingleOwnedPartnerRow(params.characterId, params.partnerId, false);
    if (!refreshedPartner) {
      return { success: false, message: '伙伴刷新失败' };
    }
    const refreshedDefinition = await loadPartnerDefinitionOrThrow(refreshedPartner.partner_def_id);
    const techniqueMap = await loadPartnerTechniqueRows([params.partnerId], false);
    const partner = await buildPartnerDetailWithTradeState({
      row: refreshedPartner,
      definition: refreshedDefinition,
      techniqueRows: techniqueMap.get(params.partnerId) ?? [],
      ownerRealm: {
        realm: character.realm,
        subRealm: character.sub_realm,
      },
    });

    return {
      success: true,
      message: '归元洗髓成功',
      data: partner,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : '未知错误';
    return { success: false, message: `归元洗髓失败：${reason}` };
  }
};

export const validateGeneratedPartnerReboneTarget = async (params: {
  characterId: number;
  partnerId: number;
  forUpdate: boolean;
}): Promise<GeneratedPartnerReboneExecutionResult<GeneratedPartnerReboneTargetContext>> => {
  const unlocked = await isFeatureUnlocked(params.characterId, PARTNER_SYSTEM_FEATURE_CODE);
  if (!unlocked) {
    return { success: false, message: '伙伴系统尚未解锁' };
  }

  const character = await loadCharacterRealmRow(params.characterId, params.forUpdate);
  if (!character) {
    return { success: false, message: '角色不存在' };
  }

  const partnerRow = await loadSingleOwnedPartnerRow(params.characterId, params.partnerId, params.forUpdate);
  if (!partnerRow) {
    return { success: false, message: '伙伴不存在' };
  }
  if (await loadActivePartnerMarketListing(params.partnerId, params.forUpdate)) {
    return { success: false, message: '已在坊市挂单的伙伴不可洗髓' };
  }
  if (await loadActivePartnerFusionMaterial(params.partnerId, params.forUpdate)) {
    return { success: false, message: '归契中的伙伴不可洗髓' };
  }

  const definition = await loadPartnerDefinitionOrThrow(partnerRow.partner_def_id);
  if (!definition.id.startsWith('partner-gen-') && !normalizeText(definition.source_job_id)) {
    return { success: false, message: '只有 AI 生成的动态伙伴可使用归元洗髓露' };
  }

  const originalDescription = normalizeText(definition.description);
  if (!originalDescription) {
    return { success: false, message: '该动态伙伴缺少原始描述，无法重新洗髓' };
  }

  const requestedBaseModel = await loadGeneratedPartnerRequestedBaseModel(
    normalizeText(definition.source_job_id),
  );

  return {
    success: true,
    message: 'ok',
    data: {
      character,
      partnerRow,
      definition,
      originalDescription,
      requestedBaseModel,
    },
  };
};
