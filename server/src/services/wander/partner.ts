/**
 * 云游故事伙伴带入规则
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中维护“每条云游故事是否带入当前伙伴”的 10% 概率判定，以及故事级伙伴快照的构建与归一化。
 * 2. 做什么：把当前出战伙伴 -> 云游 prompt 轻量快照的裁剪规则收敛到单一入口，避免 service 和 AI 层各自拼字段。
 * 3. 不做什么：不决定伙伴出战切换，不构建战斗快照，也不对前端 DTO 暴露额外字段。
 *
 * 输入 / 输出：
 * - 输入：`storySeed`、`characterId`，以及已存在的故事级伙伴快照。
 * - 输出：故事是否带入伙伴的稳定布尔值，或可直接写入故事表 / prompt 的伙伴快照。
 *
 * 数据流 / 状态流：
 * - 新故事创建前先用 `storySeed` 做稳定 10% 判定；
 * - 若命中，再读取角色当前出战伙伴并裁成故事快照；
 * - 后续幕次和结算阶段只复用故事表中的快照，不再重新读取当前出战伙伴。
 *
 * 复用设计说明：
 * 1. 概率判定与快照裁剪都是故事级共享规则，集中后可同时供“新故事生成”“旧故事续写”“历史故事回填”复用。
 * 2. 若后续要调整带入概率或补充伙伴 prompt 字段，只需改这一处，不会在 service 与测试里散落重复判断。
 *
 * 关键边界条件与坑点：
 * 1. 伙伴带入必须是故事级稳定结果；同一 `storySeed` 绝不能一幕带入、一幕消失。
 * 2. 快照必须冻结故事开始时的当前出战伙伴；后续玩家换伙伴、改名或遣散都不应改写正在推进的故事。
 */

import { query } from '../../config/database.js';
import { getPartnerDefinitionById } from '../staticConfigLoader.js';
import { hashTextUnitFloat } from '../shared/deterministicHash.js';
import { normalizeText } from '../shared/partnerView.js';
import type { WanderStoryPartnerSnapshot } from './types.js';

type ActivePartnerStoryRow = {
  id: number;
  partner_def_id: string;
  nickname: string;
  description: string | null;
};

const WANDER_STORY_PARTNER_INCLUDE_RATE = 0.1;

export const shouldIncludeWanderStoryPartner = (storySeed: number): boolean => {
  const normalizedSeed = Math.trunc(storySeed);
  return hashTextUnitFloat(`wander-story-partner:${normalizedSeed}`) < WANDER_STORY_PARTNER_INCLUDE_RATE;
};

export const normalizeWanderStoryPartnerSnapshot = (
  snapshot: WanderStoryPartnerSnapshot | null,
): WanderStoryPartnerSnapshot | null => {
  if (!snapshot) {
    return null;
  }

  const partnerId = Math.max(0, Math.floor(snapshot.partnerId));
  const partnerDefId = normalizeText(snapshot.partnerDefId);
  const nickname = normalizeText(snapshot.nickname);
  const name = normalizeText(snapshot.name);
  const descriptionText = normalizeText(snapshot.description);
  const role = normalizeText(snapshot.role);
  const quality = normalizeText(snapshot.quality);
  if (partnerId <= 0 || !partnerDefId || !nickname || !name || !role || !quality) {
    return null;
  }

  return {
    partnerId,
    partnerDefId,
    nickname,
    name,
    description: descriptionText || null,
    role,
    quality,
  };
};

export const loadActiveWanderStoryPartnerSnapshot = async (
  characterId: number,
): Promise<WanderStoryPartnerSnapshot | null> => {
  const result = await query<ActivePartnerStoryRow>(
    `
      SELECT cp.id, cp.partner_def_id, cp.nickname, cp.description
      FROM character_partner cp
      WHERE cp.character_id = $1
        AND cp.is_active = TRUE
      ORDER BY cp.id ASC
      LIMIT 1
    `,
    [characterId],
  );

  const row = result.rows[0] ?? null;
  if (!row) {
    return null;
  }

  const definition = await getPartnerDefinitionById(row.partner_def_id);
  if (!definition) {
    throw new Error(`伙伴模板不存在: ${row.partner_def_id}`);
  }

  return normalizeWanderStoryPartnerSnapshot({
    partnerId: row.id,
    partnerDefId: definition.id,
    nickname: normalizeText(row.nickname) || normalizeText(definition.name) || definition.id,
    name: normalizeText(definition.name) || definition.id,
    description: normalizeText(row.description) || normalizeText(definition.description) || null,
    role: normalizeText(definition.role) || '伙伴',
    quality: normalizeText(definition.quality) || '黄',
  });
};
