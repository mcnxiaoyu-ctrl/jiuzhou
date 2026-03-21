/**
 * 战斗资料 Redis 缓存
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：缓存角色战斗补充资料（技能、套装/词缀战斗效果）与当前出战伙伴战斗成员，覆盖高频开战准备热路径。
 * 2. 做什么：提供“读取缓存”和“主动刷新缓存”双入口，供读链路和写链路共享，避免各处散落手写 Redis 逻辑。
 * 3. 不做什么：不缓存角色实时血量/灵气、地图位置、挂机状态、战斗中状态等高动态数据。
 *
 * 输入/输出：
 * - 输入：角色 ID。
 * - 输出：角色战斗补充资料 `CharacterBattleLoadout`，以及当前出战伙伴 `PartnerBattleMember | null`。
 *
 * 数据流/状态流：
 * - 读：battle / idle -> 本模块 get -> memory -> Redis -> loader。
 * - 写：属性/技能/伙伴变更入口 -> 本模块 refresh -> loader -> memory + Redis。
 *
 * 关键边界条件与坑点：
 * 1. 角色缓存只存“可主动失效的静态补充资料”，绝不把实时资源写进长 TTL 缓存，否则会让开战资格判断读到旧血量。
 * 2. 伙伴缓存必须缓存“无出战伙伴”这一结果；否则单人不带伙伴的高频刷怪会反复查库。
 */

import type { BattleSetBonusEffect } from '../../../battle/types.js';
import type { CharacterData, SkillData } from '../../../battle/battleFactory.js';
import { afterTransactionCommit } from '../../../config/database.js';
import { getCharacterComputedByCharacterId } from '../../characterComputedService.js';
import { createCacheLayer } from '../../shared/cacheLayer.js';
import { loadActivePartnerBattleMember, type PartnerBattleMember } from '../../shared/partnerBattleMember.js';
import { attachSetBonusEffectsToCharacterData } from './effects.js';
import { getCharacterBattleSkillData } from './skills.js';

const BATTLE_PROFILE_REDIS_TTL_SEC = 6 * 60 * 60;
const BATTLE_PROFILE_MEMORY_TTL_MS = 10 * 60_000;

export type CharacterBattleLoadout = {
  setBonusEffects: BattleSetBonusEffect[];
  skills: SkillData[];
};

type ActivePartnerBattleCacheValue = {
  hasPartner: boolean;
  member: PartnerBattleMember | null;
};

const hasOwnAvatarField = (
  member: PartnerBattleMember | null,
): boolean => {
  if (!member) return true;
  return Object.prototype.hasOwnProperty.call(member.data, 'avatar');
};

const buildCharacterBattleLoadout = async (
  characterId: number,
): Promise<CharacterBattleLoadout | null> => {
  const normalizedCharacterId = Math.floor(Number(characterId));
  if (!Number.isFinite(normalizedCharacterId) || normalizedCharacterId <= 0) {
    return null;
  }

  const computed = await getCharacterComputedByCharacterId(normalizedCharacterId);
  if (!computed) {
    return null;
  }

  const [characterWithEffects, skills] = await Promise.all([
    attachSetBonusEffectsToCharacterData(
      normalizedCharacterId,
      computed as unknown as CharacterData,
    ),
    getCharacterBattleSkillData(normalizedCharacterId),
  ]);

  return {
    setBonusEffects: characterWithEffects.setBonusEffects ?? [],
    skills,
  };
};

const buildActivePartnerBattleCacheValue = async (
  characterId: number,
): Promise<ActivePartnerBattleCacheValue | null> => {
  const normalizedCharacterId = Math.floor(Number(characterId));
  if (!Number.isFinite(normalizedCharacterId) || normalizedCharacterId <= 0) {
    return null;
  }

  const member = await loadActivePartnerBattleMember(normalizedCharacterId);
  return {
    hasPartner: member !== null,
    member,
  };
};

const characterBattleLoadoutCache = createCacheLayer<number, CharacterBattleLoadout>({
  keyPrefix: 'battle:profile:character-loadout:v1:',
  redisTtlSec: BATTLE_PROFILE_REDIS_TTL_SEC,
  memoryTtlMs: BATTLE_PROFILE_MEMORY_TTL_MS,
  loader: buildCharacterBattleLoadout,
});

const activePartnerBattleMemberCache = createCacheLayer<number, ActivePartnerBattleCacheValue>({
  keyPrefix: 'battle:profile:active-partner:v2:',
  redisTtlSec: BATTLE_PROFILE_REDIS_TTL_SEC,
  memoryTtlMs: BATTLE_PROFILE_MEMORY_TTL_MS,
  loader: buildActivePartnerBattleCacheValue,
});

export const getCharacterBattleLoadoutByCharacterId = async (
  characterId: number,
): Promise<CharacterBattleLoadout | null> => {
  return characterBattleLoadoutCache.get(characterId);
};

export const refreshCharacterBattleLoadoutByCharacterId = async (
  characterId: number,
): Promise<CharacterBattleLoadout | null> => {
  const nextValue = await buildCharacterBattleLoadout(characterId);
  if (!nextValue) {
    await characterBattleLoadoutCache.invalidate(characterId);
    return null;
  }
  await characterBattleLoadoutCache.set(characterId, nextValue);
  return nextValue;
};

export const scheduleCharacterBattleLoadoutRefreshByCharacterId = async (
  characterId: number,
): Promise<void> => {
  await afterTransactionCommit(async () => {
    await refreshCharacterBattleLoadoutByCharacterId(characterId);
  });
};

export const getActivePartnerBattleMemberByCharacterId = async (
  characterId: number,
): Promise<PartnerBattleMember | null> => {
  const cached = await activePartnerBattleMemberCache.get(characterId);
  if (!cached) {
    return null;
  }
  if (!hasOwnAvatarField(cached.member)) {
    const nextValue = await buildActivePartnerBattleCacheValue(characterId);
    if (!nextValue) {
      await activePartnerBattleMemberCache.invalidate(characterId);
      return null;
    }
    await activePartnerBattleMemberCache.set(characterId, nextValue);
    return nextValue.member;
  }
  return cached.member;
};

export const refreshActivePartnerBattleCacheByCharacterId = async (
  characterId: number,
): Promise<PartnerBattleMember | null> => {
  const nextValue = await buildActivePartnerBattleCacheValue(characterId);
  if (!nextValue) {
    await activePartnerBattleMemberCache.invalidate(characterId);
    return null;
  }
  await activePartnerBattleMemberCache.set(characterId, nextValue);
  return nextValue.member;
};

export const scheduleActivePartnerBattleCacheRefreshByCharacterId = async (
  characterId: number,
): Promise<void> => {
  await afterTransactionCommit(async () => {
    await refreshActivePartnerBattleCacheByCharacterId(characterId);
  });
};
