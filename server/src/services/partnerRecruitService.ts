/**
 * AI 伙伴招募服务
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：提供伙伴招募状态查询、任务创建、异步生成落库、结果确认、放弃与已读标记。
 * 2) 做什么：把动态伙伴定义、伙伴专属生成功法与招募任务状态机收口到单一服务，避免伙伴系统走双轨实现。
 * 3) 不做什么：不解析 HTTP 参数、不直接推送 WebSocket，也不在这里维护 worker 队列。
 *
 * 输入/输出：
 * - 输入：characterId、generationId。
 * - 输出：统一 ServiceResult，以及伙伴招募状态 DTO / 确认结果 DTO。
 *
 * 数据流/状态流：
 * route -> partnerRecruitService.create -> runner.enqueue -> worker -> processPendingRecruitJob -> preview -> confirm/discard。
 *
 * 关键边界条件与坑点：
 * 1) 失败路径必须退款并把任务写成终结态，不能让任务卡在 pending，也不能吞掉头像/模型失败。
 * 2) 伙伴预览只生成动态定义，不直接创建实例；只有 confirm 才真正写入 `character_partner`。
 */
import { randomUUID } from 'crypto';
import { query } from '../config/database.js';
import { Transactional } from '../decorators/transactional.js';
import {
  PARTNER_SYSTEM_FEATURE_CODE,
  isFeatureUnlocked,
} from './featureUnlockService.js';
import {
  getPartnerDefinitionById,
  getSkillDefinitions,
  getTechniqueDefinitions,
  refreshGeneratedPartnerSnapshots,
  refreshGeneratedTechniqueSnapshots,
  type PartnerDefConfig,
} from './staticConfigLoader.js';
import { partnerService } from './partnerService.js';
import {
  buildTechniqueTextModelPayload,
  extractTechniqueTextModelContent,
  parseTechniqueTextModelJsonObject,
  resolveTechniqueTextModelEndpoint,
} from './shared/techniqueTextModelShared.js';
import { resolveTechniqueGenerationRequestFailure } from './shared/techniqueGenerationRequestFailure.js';
import {
  buildPartnerRecruitJobState,
  type PartnerRecruitJobStatus,
  type PartnerRecruitPreviewDto,
} from './shared/partnerRecruitJobShared.js';
import {
  buildPartnerRecruitCooldownState,
  buildPartnerRecruitPreviewExpireAt,
  buildPartnerRecruitPromptInput,
  fillPartnerRecruitBaseAttrs,
  formatPartnerRecruitCooldownRemaining,
  getPartnerRecruitExpectedInnateTechniqueCount,
  getPartnerRecruitTechniqueMaxLayer,
  isPartnerRecruitPreviewExpired,
  PARTNER_RECRUIT_SPIRIT_STONES_COST,
  resolvePartnerRecruitQualityByWeight,
  type PartnerRecruitDraft,
  type PartnerRecruitElement,
  type PartnerRecruitPassiveKey,
  type PartnerRecruitQuality,
  type PartnerRecruitRole,
  validatePartnerRecruitDraft,
} from './shared/partnerRecruitRules.js';
import { generatePartnerRecruitAvatar } from './shared/partnerRecruitAvatarGenerator.js';

export type ServiceResult<T = unknown> = {
  success: boolean;
  message: string;
  data?: T;
  code?: string;
};

export interface PartnerRecruitJobDto {
  generationId: string;
  status: PartnerRecruitJobStatus;
  startedAt: string;
  finishedAt: string | null;
  previewExpireAt: string | null;
  preview: PartnerRecruitPreviewDto | null;
  errorMessage: string | null;
}

export interface PartnerRecruitStatusDto {
  unlocked: true;
  featureCode: string;
  spiritStoneCost: number;
  cooldownHours: number;
  cooldownUntil: string | null;
  cooldownRemainingSeconds: number;
  currentJob: PartnerRecruitJobDto | null;
  hasUnreadResult: boolean;
  resultStatus: 'generated_draft' | 'failed' | null;
}

export interface PartnerRecruitConfirmResponse {
  generationId: string;
  partnerId: number;
  partnerDefId: string;
  partnerName: string;
  partnerAvatar: string | null;
  activated: boolean;
}

type RecruitJobRow = {
  generationId: string;
  status: PartnerRecruitJobStatus;
  quality: PartnerRecruitQuality;
  spiritStonesCost: number;
  cooldownStartedAt: string;
  finishedAt: string | null;
  viewedAt: string | null;
  errorMessage: string | null;
  previewPartnerDefId: string | null;
};

type RecruitTextAttemptFailure = {
  success: false;
  reason: string;
  modelName: string;
};

type RecruitTextAttemptSuccess = {
  success: true;
  draft: PartnerRecruitDraft;
  modelName: string;
};

type RecruitTextAttemptResult = RecruitTextAttemptFailure | RecruitTextAttemptSuccess;

type GeneratedTechniqueInsert = {
  techniqueId: string;
  name: string;
  description: string;
  type: '武技' | '法诀' | '辅修';
  quality: PartnerRecruitQuality;
  attributeType: 'physical' | 'magic';
  attributeElement: string;
  maxLayer: number;
  skill: null | {
    skillId: string;
    name: string;
    description: string;
    icon: string;
    targetType: 'single_enemy' | 'single_ally' | 'self';
    damageType: 'physical' | 'magic' | 'none';
    element: string;
    costLingqi: number;
    cooldown: number;
    aiPriority: number;
    effects: unknown[];
  };
  layers: Array<{
    layer: number;
    costSpiritStones: number;
    costExp: number;
    passives: Array<{ key: PartnerRecruitPassiveKey; value: number }>;
  }>;
};

const PARTNER_RECRUIT_PROMPT_SYSTEM_MESSAGE = [
  '你是《九州修仙录》的伙伴创作引擎。',
  '你必须返回严格 JSON，不得输出 markdown、解释、注释。',
  '你要生成一个可招募的仙侠伙伴草稿，字段必须完整且满足输入约束。',
  '不要生成现代词汇、科幻词汇、英文名、阿拉伯数字名。',
].join('\n');

const DEFAULT_ATTACK_SKILL_ICON = '/assets/skills/icon_skill_38.png';
const DEFAULT_SUPPORT_SKILL_ICON = '/assets/skills/icon_skill_36.png';
const DEFAULT_GUARD_SKILL_ICON = '/assets/skills/icon_skill_14.png';

const asString = (raw: unknown): string => (typeof raw === 'string' ? raw.trim() : '');

const asNumber = (raw: unknown, fallback = 0): number => {
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};

const toIsoString = (raw: unknown): string | null => {
  if (!raw) return null;
  const date = new Date(String(raw));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
};

const normalizeGeneratedId = (prefix: string): string => {
  return `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
};

const buildPartnerRecruitGenerationId = (): string => normalizeGeneratedId('partner-recruit');
const buildGeneratedPartnerDefId = (): string => normalizeGeneratedId('partner-gen');
const buildGeneratedTechniqueId = (): string => normalizeGeneratedId('tech-partner');
const buildGeneratedSkillId = (): string => normalizeGeneratedId('skill-partner');

const extractPassiveKeyIncrementByLayer = (
  totalValue: number,
  maxLayer: number,
  layer: number,
): number => {
  if (maxLayer <= 0) return totalValue;
  return Math.max(1, Math.floor((totalValue * layer) / maxLayer));
};

const resolveRoleCombatStyle = (role: PartnerRecruitRole): {
  attributeType: 'physical' | 'magic';
  damageType: 'physical' | 'magic';
  scaleAttr: 'wugong' | 'fagong';
} => {
  if (role === '剑修' || role === '护卫') {
    return {
      attributeType: 'physical',
      damageType: 'physical',
      scaleAttr: 'wugong',
    };
  }
  return {
    attributeType: 'magic',
    damageType: 'magic',
    scaleAttr: 'fagong',
  };
};

const buildAttackSkillEffects = (
  role: PartnerRecruitRole,
  element: PartnerRecruitElement,
  techniqueIndex: number,
): unknown[] => {
  const combatStyle = resolveRoleCombatStyle(role);
  return [
    {
      type: 'damage',
      valueType: 'scale',
      scaleAttr: combatStyle.scaleAttr,
      scaleRate: Number((1.05 + techniqueIndex * 0.15).toFixed(2)),
      element,
    },
  ];
};

const buildSupportSkillEffects = (role: PartnerRecruitRole): unknown[] => {
  if (role === '药师') {
    return [
      {
        type: 'heal',
        valueType: 'scale',
        scaleAttr: 'fagong',
        scaleRate: 0.95,
        value: 100,
      },
    ];
  }
  return [
    {
      type: 'buff',
      duration: 3,
      value: 0.18,
      buffKey: 'buff-zengshang-up',
      buffKind: 'attr',
      attrKey: 'zengshang',
      applyType: 'flat',
    },
  ];
};

const buildGuardSkillEffects = (): unknown[] => {
  return [
    {
      type: 'buff',
      duration: 3,
      value: 0.2,
      buffKey: 'buff-wufang-up',
      buffKind: 'attr',
      attrKey: 'wufang',
      applyType: 'flat',
    },
  ];
};

const buildTechniqueArtifactsFromDraft = (
  draft: PartnerRecruitDraft,
): GeneratedTechniqueInsert[] => {
  const quality = draft.partner.quality;
  const maxLayer = getPartnerRecruitTechniqueMaxLayer(quality);
  const roleStyle = resolveRoleCombatStyle(draft.partner.role);
  return draft.innateTechniques.map((entry, index) => {
    const techniqueId = buildGeneratedTechniqueId();
    const skillId = entry.kind === 'guard' && index > 0 ? '' : buildGeneratedSkillId();
    const skill = entry.kind === 'attack'
      ? {
          skillId,
          name: `${entry.name}诀`,
          description: entry.description,
          icon: DEFAULT_ATTACK_SKILL_ICON,
          targetType: 'single_enemy' as const,
          damageType: roleStyle.damageType,
          element: draft.partner.attributeElement,
          costLingqi: 8 + index * 2,
          cooldown: 1 + index,
          aiPriority: 60 + index * 5,
          effects: buildAttackSkillEffects(draft.partner.role, draft.partner.attributeElement, index),
        }
      : entry.kind === 'support'
        ? {
            skillId,
            name: `${entry.name}术`,
            description: entry.description,
            icon: DEFAULT_SUPPORT_SKILL_ICON,
            targetType: draft.partner.role === '药师' ? 'single_ally' as const : 'self' as const,
            damageType: 'none' as const,
            element: draft.partner.attributeElement,
            costLingqi: 10 + index * 2,
            cooldown: 2,
            aiPriority: 68,
            effects: buildSupportSkillEffects(draft.partner.role),
          }
        : {
            skillId: skillId || buildGeneratedSkillId(),
            name: `${entry.name}印`,
            description: entry.description,
            icon: DEFAULT_GUARD_SKILL_ICON,
            targetType: 'self' as const,
            damageType: 'none' as const,
            element: draft.partner.attributeElement,
            costLingqi: 9,
            cooldown: 3,
            aiPriority: 58,
            effects: buildGuardSkillEffects(),
          };
    const techniqueType = entry.kind === 'attack'
      ? (roleStyle.attributeType === 'physical' ? '武技' : '法诀')
      : '辅修';
    return {
      techniqueId,
      name: entry.name,
      description: entry.description,
      type: techniqueType,
      quality,
      attributeType: roleStyle.attributeType,
      attributeElement: draft.partner.attributeElement,
      maxLayer,
      skill,
      layers: Array.from({ length: maxLayer }, (_, idx) => {
        const layer = idx + 1;
        return {
          layer,
          costSpiritStones: 1_500 * layer * (index + 1),
          costExp: 1_000 * layer * (index + 1),
          passives: [{
            key: entry.passiveKey,
            value: extractPassiveKeyIncrementByLayer(entry.passiveValue, maxLayer, layer),
          }],
        };
      }),
    } satisfies GeneratedTechniqueInsert;
  });
};

const buildPartnerDefFromDraft = (
  partnerDefId: string,
  generationId: string,
  characterId: number,
  draft: PartnerRecruitDraft,
  avatarUrl: string,
  techniques: GeneratedTechniqueInsert[],
): PartnerDefConfig => {
  return {
    id: partnerDefId,
    name: draft.partner.name,
    description: draft.partner.description,
    avatar: avatarUrl,
    quality: draft.partner.quality,
    attribute_element: draft.partner.attributeElement,
    role: draft.partner.role,
    max_technique_slots: draft.partner.maxTechniqueSlots,
    innate_technique_ids: techniques.map((entry) => entry.techniqueId),
    base_attrs: draft.partner.baseAttrs,
    level_attr_gains: draft.partner.levelAttrGains,
    enabled: true,
    sort_weight: 1000,
    created_by_character_id: characterId,
    source_job_id: generationId,
  };
};

const buildPreviewFromPartnerDefinition = (
  definition: PartnerDefConfig,
): PartnerRecruitPreviewDto => {
  const skillDefinitions = getSkillDefinitions().filter((entry) => entry.enabled !== false);
  const techniqueDefinitions = getTechniqueDefinitions().filter((entry) => entry.enabled !== false);
  const techniqueMap = new Map(techniqueDefinitions.map((entry) => [entry.id, entry] as const));
  const skillsByTechniqueId = new Map<string, string[]>();
  for (const skill of skillDefinitions) {
    if (skill.source_type !== 'technique') continue;
    const sourceId = asString(skill.source_id);
    if (!sourceId) continue;
    const list = skillsByTechniqueId.get(sourceId) ?? [];
    const name = asString(skill.name);
    if (name) list.push(name);
    skillsByTechniqueId.set(sourceId, list);
  }

  return {
    partnerDefId: definition.id,
    name: definition.name,
    description: definition.description ?? '',
    avatar: definition.avatar ?? null,
    quality: definition.quality ?? '黄',
    element: definition.attribute_element ?? 'none',
    role: definition.role ?? '伙伴',
    slotCount: Math.max(1, Number(definition.max_technique_slots) || 1),
    baseAttrs: fillPartnerRecruitBaseAttrs(definition.base_attrs),
    levelAttrGains: fillPartnerRecruitBaseAttrs(definition.level_attr_gains),
    innateTechniques: definition.innate_technique_ids.map((techniqueId) => {
      const technique = techniqueMap.get(techniqueId);
      return {
        techniqueId,
        name: asString(technique?.name) || techniqueId,
        description: asString(technique?.description),
        quality: asString(technique?.quality) || definition.quality || '黄',
        icon: asString(technique?.icon) || null,
        skillNames: [...new Set(skillsByTechniqueId.get(techniqueId) ?? [])],
      };
    }),
  };
};

const summarizeHttpErrorResponse = (responseText: string): string => {
  const normalized = responseText.trim().replace(/\s+/g, ' ');
  if (!normalized) return '';
  return normalized.slice(0, 300);
};

const tryCallPartnerRecruitTextModel = async (
  quality: PartnerRecruitQuality,
): Promise<RecruitTextAttemptResult> => {
  const endpoint = resolveTechniqueTextModelEndpoint(asString(process.env.AI_TECHNIQUE_MODEL_URL));
  const apiKey = asString(process.env.AI_TECHNIQUE_MODEL_KEY);
  const modelName = asString(process.env.AI_TECHNIQUE_MODEL_NAME) || 'gpt-4o-mini';
  if (!endpoint || !apiKey) {
    return {
      success: false,
      reason: '缺少 AI_TECHNIQUE_MODEL_URL 或 AI_TECHNIQUE_MODEL_KEY 配置',
      modelName,
    };
  }

  const payload = buildTechniqueTextModelPayload({
    modelName,
    systemMessage: PARTNER_RECRUIT_PROMPT_SYSTEM_MESSAGE,
    userMessage: JSON.stringify(buildPartnerRecruitPromptInput(quality)),
  });

  const controller = new AbortController();
  const timeoutMs = 180_000;
  let didTimeout = false;
  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      const responseText = await response.text();
      const responseSummary = summarizeHttpErrorResponse(responseText);
      return {
        success: false,
        reason: responseSummary
          ? `伙伴生成模型返回非成功状态：${response.status}（${responseSummary}）`
          : `伙伴生成模型返回非成功状态：${response.status}`,
        modelName,
      };
    }
    const body = (await response.json()) as Record<string, unknown>;
    const content = extractTechniqueTextModelContent(
      ((body.choices as Array<Record<string, unknown>> | undefined)?.[0]?.message as {
        content?: string | Array<{ text?: string | null }> | null;
      } | undefined)?.content,
    );
    const parsed = parseTechniqueTextModelJsonObject(content);
    if (!parsed.success) {
      return {
        success: false,
        reason: parsed.reason === 'empty_content' ? '伙伴生成模型返回空内容' : '伙伴生成模型未返回合法 JSON',
        modelName,
      };
    }
    const draft = validatePartnerRecruitDraft(parsed.data);
    if (!draft) {
      return {
        success: false,
        reason: '伙伴生成模型返回结构非法或超出约束',
        modelName,
      };
    }
    if (draft.partner.quality !== quality) {
      return {
        success: false,
        reason: '伙伴生成模型返回的品质与本次抽取品质不一致',
        modelName,
      };
    }
    if (draft.innateTechniques.length !== getPartnerRecruitExpectedInnateTechniqueCount(quality)) {
      return {
        success: false,
        reason: '伙伴生成模型返回的天生功法数量与品质要求不一致',
        modelName,
      };
    }
    return {
      success: true,
      draft,
      modelName,
    };
  } catch (error) {
    const failure = resolveTechniqueGenerationRequestFailure({
      error,
      didTimeout,
      timeoutMs,
    });
    return {
      success: false,
      reason: failure.reason,
      modelName,
    };
  } finally {
    clearTimeout(timer);
  }
};

const buildRecruitPreviewByPartnerDefId = (
  partnerDefId: string,
): PartnerRecruitPreviewDto | null => {
  const definition = getPartnerDefinitionById(partnerDefId);
  if (!definition) return null;
  return buildPreviewFromPartnerDefinition(definition);
};

class PartnerRecruitService {
  private async assertPartnerSystemUnlocked(characterId: number): Promise<ServiceResult<{ featureCode: string }>> {
    const unlocked = await isFeatureUnlocked(characterId, PARTNER_SYSTEM_FEATURE_CODE);
    if (!unlocked) {
      return { success: false, message: '伙伴系统尚未解锁', code: 'PARTNER_SYSTEM_LOCKED' };
    }
    return {
      success: true,
      message: 'ok',
      data: {
        featureCode: PARTNER_SYSTEM_FEATURE_CODE,
      },
    };
  }

  @Transactional
  private async discardExpiredDraftJobsTx(characterId: number): Promise<void> {
    const expiredRes = await query(
      `
        SELECT id, finished_at
        FROM partner_recruit_job
        WHERE character_id = $1
          AND status = 'generated_draft'
        FOR UPDATE
      `,
      [characterId],
    );

    const expiredGenerationIds = (expiredRes.rows as Array<Record<string, unknown>>)
      .filter((row) => isPartnerRecruitPreviewExpired(toIsoString(row.finished_at)))
      .map((row) => asString(row.id))
      .filter(Boolean);
    if (expiredGenerationIds.length <= 0) return;

    await query(
      `
        UPDATE partner_recruit_job
        SET status = 'discarded',
            viewed_at = COALESCE(viewed_at, NOW()),
            updated_at = NOW()
        WHERE character_id = $1
          AND id = ANY($2::text[])
      `,
      [characterId, expiredGenerationIds],
    );
  }

  private async loadLatestJobRow(
    characterId: number,
    forUpdate: boolean,
  ): Promise<RecruitJobRow | null> {
    const lockSql = forUpdate ? 'FOR UPDATE' : '';
    const result = await query(
      `
        SELECT
          id,
          status,
          quality_rolled,
          spirit_stones_cost,
          cooldown_started_at,
          finished_at,
          viewed_at,
          error_message,
          preview_partner_def_id
        FROM partner_recruit_job
        WHERE character_id = $1
        ORDER BY created_at DESC
        LIMIT 1
        ${lockSql}
      `,
      [characterId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      generationId: asString(row.id),
      status: (asString(row.status) as PartnerRecruitJobStatus) || 'pending',
      quality: (asString(row.quality_rolled) as PartnerRecruitQuality) || '黄',
      spiritStonesCost: Math.max(0, Math.floor(asNumber(row.spirit_stones_cost, 0))),
      cooldownStartedAt: toIsoString(row.cooldown_started_at) ?? new Date().toISOString(),
      finishedAt: toIsoString(row.finished_at),
      viewedAt: toIsoString(row.viewed_at),
      errorMessage: asString(row.error_message) || null,
      previewPartnerDefId: asString(row.preview_partner_def_id) || null,
    };
  }

  private async loadCharacterSpiritStones(characterId: number, forUpdate: boolean): Promise<number | null> {
    const lockSql = forUpdate ? 'FOR UPDATE' : '';
    const result = await query(
      `
        SELECT spirit_stones
        FROM characters
        WHERE id = $1
        LIMIT 1
        ${lockSql}
      `,
      [characterId],
    );
    if (result.rows.length <= 0) return null;
    return Math.max(0, Math.floor(asNumber((result.rows[0] as Record<string, unknown>).spirit_stones, 0)));
  }

  async getRecruitStatus(characterId: number): Promise<ServiceResult<PartnerRecruitStatusDto>> {
    const unlockState = await this.assertPartnerSystemUnlocked(characterId);
    if (!unlockState.success || !unlockState.data) {
      return { success: false, message: unlockState.message, code: unlockState.code };
    }

    await this.discardExpiredDraftJobsTx(characterId);
    const latestJob = await this.loadLatestJobRow(characterId, false);
    const cooldownState = buildPartnerRecruitCooldownState(latestJob?.cooldownStartedAt ?? null);
    const preview = latestJob?.previewPartnerDefId
      ? buildRecruitPreviewByPartnerDefId(latestJob.previewPartnerDefId)
      : null;
    const jobState = buildPartnerRecruitJobState(latestJob
      ? {
          generationId: latestJob.generationId,
          status: latestJob.status,
          startedAt: latestJob.cooldownStartedAt,
          finishedAt: latestJob.finishedAt,
          viewedAt: latestJob.viewedAt,
          errorMessage: latestJob.errorMessage,
          previewExpireAt: buildPartnerRecruitPreviewExpireAt(latestJob.finishedAt),
          preview,
        }
      : null);

    return {
      success: true,
      message: '获取成功',
      data: {
        unlocked: true,
        featureCode: unlockState.data.featureCode,
        spiritStoneCost: PARTNER_RECRUIT_SPIRIT_STONES_COST,
        cooldownHours: cooldownState.cooldownHours,
        cooldownUntil: cooldownState.cooldownUntil,
        cooldownRemainingSeconds: cooldownState.cooldownRemainingSeconds,
        currentJob: jobState.currentJob,
        hasUnreadResult: jobState.hasUnreadResult,
        resultStatus: jobState.resultStatus,
      },
    };
  }

  @Transactional
  private async createRecruitJobTx(characterId: number, quality: PartnerRecruitQuality): Promise<ServiceResult<{ generationId: string }>> {
    await this.discardExpiredDraftJobsTx(characterId);

    const unlockState = await this.assertPartnerSystemUnlocked(characterId);
    if (!unlockState.success) {
      return { success: false, message: unlockState.message, code: unlockState.code };
    }

    const latestJob = await this.loadLatestJobRow(characterId, true);
    if (latestJob && (latestJob.status === 'pending' || latestJob.status === 'generated_draft')) {
      return {
        success: false,
        message: latestJob.status === 'pending' ? '当前已有伙伴招募进行中' : '当前已有待确认的伙伴预览',
        code: 'RECRUIT_JOB_ACTIVE',
      };
    }

    const cooldownState = buildPartnerRecruitCooldownState(latestJob?.cooldownStartedAt ?? null);
    if (cooldownState.isCoolingDown) {
      return {
        success: false,
        message: `伙伴招募冷却中，还需等待${formatPartnerRecruitCooldownRemaining(cooldownState.cooldownRemainingSeconds)}`,
        code: 'RECRUIT_COOLDOWN_ACTIVE',
      };
    }

    const spiritStones = await this.loadCharacterSpiritStones(characterId, true);
    if (spiritStones === null) {
      return { success: false, message: '角色不存在', code: 'CHARACTER_NOT_FOUND' };
    }
    if (spiritStones < PARTNER_RECRUIT_SPIRIT_STONES_COST) {
      return {
        success: false,
        message: `灵石不足，需要${PARTNER_RECRUIT_SPIRIT_STONES_COST.toLocaleString()}，当前${spiritStones.toLocaleString()}`,
        code: 'SPIRIT_STONES_NOT_ENOUGH',
      };
    }

    const generationId = buildPartnerRecruitGenerationId();
    await query(
      `
        UPDATE characters
        SET spirit_stones = spirit_stones - $2,
            updated_at = NOW()
        WHERE id = $1
      `,
      [characterId, PARTNER_RECRUIT_SPIRIT_STONES_COST],
    );

    await query(
      `
        INSERT INTO partner_recruit_job (
          id,
          character_id,
          status,
          quality_rolled,
          spirit_stones_cost,
          cooldown_started_at,
          created_at,
          updated_at
        ) VALUES (
          $1, $2, 'pending', $3, $4, NOW(), NOW(), NOW()
        )
      `,
      [generationId, characterId, quality, PARTNER_RECRUIT_SPIRIT_STONES_COST],
    );

    return {
      success: true,
      message: '伙伴招募已开始',
      data: {
        generationId,
      },
    };
  }

  async createRecruitJob(characterId: number, quality: PartnerRecruitQuality): Promise<ServiceResult<{ generationId: string }>> {
    return this.createRecruitJobTx(characterId, quality);
  }

  @Transactional
  private async refundRecruitJobTx(
    characterId: number,
    generationId: string,
    reason: string,
    nextStatus: 'failed' | 'refunded' = 'refunded',
  ): Promise<void> {
    const jobRes = await query(
      `
        SELECT status, spirit_stones_cost
        FROM partner_recruit_job
        WHERE id = $1 AND character_id = $2
        FOR UPDATE
      `,
      [generationId, characterId],
    );
    if (jobRes.rows.length <= 0) return;
    const row = jobRes.rows[0] as Record<string, unknown>;
    const status = asString(row.status);
    const spiritStonesCost = Math.max(0, Math.floor(asNumber(row.spirit_stones_cost, 0)));
    if (status === 'accepted' || status === 'discarded' || status === 'failed' || status === 'refunded') return;

    await query(
      `
        UPDATE characters
        SET spirit_stones = spirit_stones + $2,
            updated_at = NOW()
        WHERE id = $1
      `,
      [characterId, spiritStonesCost],
    );
    await query(
      `
        UPDATE partner_recruit_job
        SET status = $3,
            error_message = $4,
            finished_at = COALESCE(finished_at, NOW()),
            viewed_at = NULL,
            updated_at = NOW()
        WHERE id = $1 AND character_id = $2
      `,
      [generationId, characterId, nextStatus, reason],
    );
  }

  async forceRefundPendingRecruitJob(
    characterId: number,
    generationId: string,
    reason: string,
  ): Promise<void> {
    await this.refundRecruitJobTx(characterId, generationId, reason, 'refunded');
  }

  @Transactional
  @Transactional
  private async persistGeneratedRecruitDraftTx(args: {
    characterId: number;
    generationId: string;
    draft: PartnerRecruitDraft;
    partnerDefId: string;
    avatarUrl: string;
    techniques: GeneratedTechniqueInsert[];
  }): Promise<ServiceResult<{ preview: PartnerRecruitPreviewDto }>> {
    const { characterId, generationId, draft, partnerDefId, avatarUrl, techniques } = args;
    const jobRes = await query(
      `
        SELECT id, status
        FROM partner_recruit_job
        WHERE id = $1 AND character_id = $2
        FOR UPDATE
      `,
      [generationId, characterId],
    );
    if (jobRes.rows.length <= 0) {
      return { success: false, message: '招募任务不存在', code: 'RECRUIT_JOB_NOT_FOUND' };
    }
    const jobStatus = asString((jobRes.rows[0] as Record<string, unknown>).status);
    if (jobStatus !== 'pending') {
      return { success: false, message: '招募任务状态异常', code: 'RECRUIT_JOB_STATE_INVALID' };
    }

    for (const technique of techniques) {
      await query(
        `
          INSERT INTO generated_technique_def (
            id,
            generation_id,
            created_by_character_id,
            name,
            display_name,
            normalized_name,
            type,
            quality,
            max_layer,
            required_realm,
            attribute_type,
            attribute_element,
            usage_scope,
            tags,
            description,
            long_desc,
            icon,
            is_published,
            published_at,
            name_locked,
            enabled,
            version,
            created_at,
            updated_at
          ) VALUES (
            $1, $2, $3,
            $4, $5, NULL,
            $6, $7, $8, '凡人',
            $9, $10, 'partner_only',
            '[]'::jsonb,
            $11, $12, $13,
            true, NOW(), true, true, 1, NOW(), NOW()
          )
        `,
        [
          technique.techniqueId,
          generationId,
          characterId,
          technique.name,
          technique.name,
          technique.type,
          technique.quality,
          technique.maxLayer,
          technique.attributeType,
          technique.attributeElement,
          technique.description,
          `${technique.description}（伙伴天生功法）`,
          technique.skill?.icon ?? null,
        ],
      );

      if (technique.skill) {
        await query(
          `
            INSERT INTO generated_skill_def (
              id,
              generation_id,
              source_type,
              source_id,
              code,
              name,
              description,
              icon,
              cost_lingqi,
              cost_lingqi_rate,
              cost_qixue,
              cost_qixue_rate,
              cooldown,
              target_type,
              target_count,
              damage_type,
              element,
              effects,
              trigger_type,
              ai_priority,
              upgrades,
              enabled,
              version,
              created_at,
              updated_at
            ) VALUES (
              $1, $2, 'technique', $3, $4, $5, $6, $7,
              $8, 0, 0, 0, $9, $10, 1, $11, $12, $13::jsonb,
              'active', $14, '[]'::jsonb, true, 1, NOW(), NOW()
            )
          `,
          [
            technique.skill.skillId,
            generationId,
            technique.techniqueId,
            technique.skill.skillId,
            technique.skill.name,
            technique.skill.description,
            technique.skill.icon,
            technique.skill.costLingqi,
            technique.skill.cooldown,
            technique.skill.targetType,
            technique.skill.damageType,
            technique.skill.element,
            JSON.stringify(technique.skill.effects),
            technique.skill.aiPriority,
          ],
        );
      }

      for (const layer of technique.layers) {
        await query(
          `
            INSERT INTO generated_technique_layer (
              generation_id,
              technique_id,
              layer,
              cost_spirit_stones,
              cost_exp,
              cost_materials,
              passives,
              unlock_skill_ids,
              upgrade_skill_ids,
              required_realm,
              layer_desc,
              enabled,
              created_at,
              updated_at
            ) VALUES (
              $1, $2, $3,
              $4, $5,
              '[]'::jsonb,
              $6::jsonb,
              $7::text[],
              '{}'::text[],
              '凡人',
              $8,
              true,
              NOW(),
              NOW()
            )
          `,
          [
            generationId,
            technique.techniqueId,
            layer.layer,
            layer.costSpiritStones,
            layer.costExp,
            JSON.stringify(layer.passives),
            technique.skill && layer.layer === 1 ? [technique.skill.skillId] : [],
            `第 ${layer.layer} 层`,
          ],
        );
      }
    }

    const partnerDef = buildPartnerDefFromDraft(partnerDefId, generationId, characterId, draft, avatarUrl, techniques);
    await query(
      `
        INSERT INTO generated_partner_def (
          id,
          name,
          description,
          avatar,
          quality,
          attribute_element,
          role,
          max_technique_slots,
          base_attrs,
          level_attr_gains,
          innate_technique_ids,
          enabled,
          created_by_character_id,
          source_job_id,
          created_at,
          updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9::jsonb,
          $10::jsonb,
          $11::text[],
          true, $12, $13, NOW(), NOW()
        )
      `,
      [
        partnerDef.id,
        partnerDef.name,
        partnerDef.description ?? null,
        partnerDef.avatar ?? null,
        partnerDef.quality,
        partnerDef.attribute_element,
        partnerDef.role,
        partnerDef.max_technique_slots,
        JSON.stringify(partnerDef.base_attrs),
        JSON.stringify(partnerDef.level_attr_gains ?? {}),
        partnerDef.innate_technique_ids,
        characterId,
        generationId,
      ],
    );

    await query(
      `
        UPDATE partner_recruit_job
        SET status = 'generated_draft',
            preview_partner_def_id = $3,
            preview_avatar_url = $4,
            finished_at = NOW(),
            viewed_at = NULL,
            error_message = NULL,
            updated_at = NOW()
        WHERE id = $1 AND character_id = $2
      `,
      [generationId, characterId, partnerDefId, avatarUrl],
    );

    await refreshGeneratedTechniqueSnapshots();
    await refreshGeneratedPartnerSnapshots();

    const preview = buildRecruitPreviewByPartnerDefId(partnerDefId);
    if (!preview) {
      return { success: false, message: '生成成功但预览构建失败', code: 'RECRUIT_PREVIEW_BUILD_FAILED' };
    }

    return {
      success: true,
      message: '伙伴预览已生成',
      data: {
        preview,
      },
    };
  }

  async processPendingRecruitJob(args: {
    characterId: number;
    generationId: string;
    quality: PartnerRecruitQuality;
  }): Promise<ServiceResult<{ status: Extract<PartnerRecruitJobStatus, 'generated_draft' | 'failed' | 'refunded'>; preview: PartnerRecruitPreviewDto | null; errorMessage: string | null }>> {
    const maxAttempts = 3;
    let lastFailure = '伙伴生成失败';
    let lastModelName = '';

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const result = await tryCallPartnerRecruitTextModel(args.quality);
      if (!result.success) {
        lastFailure = result.reason;
        lastModelName = result.modelName;
        continue;
      }

      const partnerDefId = buildGeneratedPartnerDefId();
      const techniques = buildTechniqueArtifactsFromDraft(result.draft);
      const avatarUrl = await generatePartnerRecruitAvatar({
        partnerId: partnerDefId,
        name: result.draft.partner.name,
        quality: result.draft.partner.quality,
        element: result.draft.partner.attributeElement,
        role: result.draft.partner.role,
        description: result.draft.partner.description,
      });

      const persist = await this.persistGeneratedRecruitDraftTx({
        characterId: args.characterId,
        generationId: args.generationId,
        draft: result.draft,
        partnerDefId,
        avatarUrl,
        techniques,
      });
      if (!persist.success || !persist.data) {
        lastFailure = persist.message;
        lastModelName = result.modelName;
        continue;
      }

      return {
        success: true,
        message: '伙伴预览生成成功',
        data: {
          status: 'generated_draft',
          preview: persist.data.preview,
          errorMessage: null,
        },
      };
    }

    const finalReason = lastModelName ? `伙伴生成失败：${lastFailure}（model=${lastModelName}）` : `伙伴生成失败：${lastFailure}`;
    await this.refundRecruitJobTx(args.characterId, args.generationId, finalReason, 'refunded');
    return {
      success: true,
      message: finalReason,
      data: {
        status: 'refunded',
        preview: null,
        errorMessage: finalReason,
      },
    };
  }

  @Transactional
  async confirmRecruitDraft(characterId: number, generationId: string): Promise<ServiceResult<PartnerRecruitConfirmResponse>> {
    const unlockState = await this.assertPartnerSystemUnlocked(characterId);
    if (!unlockState.success) {
      return { success: false, message: unlockState.message, code: unlockState.code };
    }

    await this.discardExpiredDraftJobsTx(characterId);
    const result = await query(
      `
        SELECT id, status, finished_at, preview_partner_def_id
        FROM partner_recruit_job
        WHERE id = $1 AND character_id = $2
        FOR UPDATE
      `,
      [generationId, characterId],
    );
    if (result.rows.length <= 0) {
      return { success: false, message: '招募任务不存在', code: 'RECRUIT_JOB_NOT_FOUND' };
    }
    const row = result.rows[0] as Record<string, unknown>;
    const status = asString(row.status) as PartnerRecruitJobStatus;
    const previewPartnerDefId = asString(row.preview_partner_def_id);
    if (status !== 'generated_draft' || !previewPartnerDefId) {
      return { success: false, message: '当前预览不可确认收下', code: 'RECRUIT_JOB_STATE_INVALID' };
    }
    if (isPartnerRecruitPreviewExpired(toIsoString(row.finished_at))) {
      await query(
        `
          UPDATE partner_recruit_job
          SET status = 'discarded',
              viewed_at = COALESCE(viewed_at, NOW()),
              updated_at = NOW()
          WHERE id = $1 AND character_id = $2
        `,
        [generationId, characterId],
      );
      return { success: false, message: '预览已过期，无法确认收下', code: 'RECRUIT_PREVIEW_EXPIRED' };
    }

    const definition = getPartnerDefinitionById(previewPartnerDefId);
    if (!definition) {
      return { success: false, message: '预览伙伴定义不存在', code: 'RECRUIT_PREVIEW_NOT_FOUND' };
    }

    const created = await partnerService.createPartnerInstanceFromDefinition({
      characterId,
      definition,
      obtainedFrom: 'partner_recruit',
      obtainedRefId: generationId,
      nickname: definition.name,
    });

    await query(
      `
        UPDATE partner_recruit_job
        SET status = 'accepted',
            viewed_at = COALESCE(viewed_at, NOW()),
            updated_at = NOW()
        WHERE id = $1 AND character_id = $2
      `,
      [generationId, characterId],
    );

    return {
      success: true,
      message: '已确认收下新伙伴',
      data: {
        generationId,
        partnerId: created.reward.partnerId,
        partnerDefId: created.reward.partnerDefId,
        partnerName: created.reward.partnerName,
        partnerAvatar: created.reward.partnerAvatar,
        activated: created.activated,
      },
    };
  }

  @Transactional
  async discardRecruitDraft(characterId: number, generationId: string): Promise<ServiceResult<{ generationId: string }>> {
    const result = await query(
      `
        SELECT status
        FROM partner_recruit_job
        WHERE id = $1 AND character_id = $2
        FOR UPDATE
      `,
      [generationId, characterId],
    );
    if (result.rows.length <= 0) {
      return { success: false, message: '招募任务不存在', code: 'RECRUIT_JOB_NOT_FOUND' };
    }
    const status = asString((result.rows[0] as Record<string, unknown>).status) as PartnerRecruitJobStatus;
    if (status !== 'generated_draft') {
      return { success: false, message: '当前任务不可放弃', code: 'RECRUIT_JOB_STATE_INVALID' };
    }

    await query(
      `
        UPDATE partner_recruit_job
        SET status = 'discarded',
            viewed_at = COALESCE(viewed_at, NOW()),
            updated_at = NOW()
        WHERE id = $1 AND character_id = $2
      `,
      [generationId, characterId],
    );
    return {
      success: true,
      message: '已放弃本次伙伴预览',
      data: {
        generationId,
      },
    };
  }

  @Transactional
  async markResultViewed(characterId: number): Promise<ServiceResult<{ generationId: string | null }>> {
    const latestJob = await this.loadLatestJobRow(characterId, true);
    if (!latestJob) {
      return {
        success: true,
        message: '当前没有可标记结果',
        data: {
          generationId: null,
        },
      };
    }

    if (
      latestJob.status !== 'generated_draft' &&
      latestJob.status !== 'failed' &&
      latestJob.status !== 'refunded'
    ) {
      return {
        success: true,
        message: '当前没有可标记结果',
        data: {
          generationId: null,
        },
      };
    }

    await query(
      `
        UPDATE partner_recruit_job
        SET viewed_at = COALESCE(viewed_at, NOW()),
            updated_at = NOW()
        WHERE id = $1 AND character_id = $2
      `,
      [latestJob.generationId, characterId],
    );
    return {
      success: true,
      message: '已标记查看',
      data: {
        generationId: latestJob.generationId,
      },
    };
  }

  resolveQualityForNewRecruit(): PartnerRecruitQuality {
    return resolvePartnerRecruitQualityByWeight();
  }
}

export const partnerRecruitService = new PartnerRecruitService();
export default partnerRecruitService;
