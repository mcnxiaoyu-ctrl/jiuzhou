import { query } from '../../config/database.js';

/**
 * Character Reward Settlement - 角色奖励资源延后结算工具
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：统一累加角色奖励中的经验/银两/灵石，并在所有入包动作结束后按角色 ID 升序落库。
 * - 不做什么：不处理背包互斥锁获取，不负责奖励来源解析，也不处理扣减类资源变化。
 *
 * 输入/输出：
 * - createCharacterRewardDelta()：返回空的奖励增量对象。
 * - mergeCharacterRewardDelta(target, delta)：把单次奖励增量合并到目标对象。
 * - addCharacterRewardDelta(map, characterId, delta)：把指定角色的奖励增量合并到 Map。
 * - applyCharacterRewardDeltas(map)：按角色 ID 升序把累计奖励写入 `characters` 表。
 *
 * 数据流/状态流：
 * - 业务服务先在事务内完成物品创建、自动分解、邮件补发等背包相关操作；
 * - 过程中把经验/银两/灵石累计到本模块的增量对象；
 * - 最后统一调用本模块写回 `characters`，缩短角色行锁持有时长，避免和背包互斥锁形成反向等待。
 *
 * 关键边界条件与坑点：
 * 1. 本模块只处理非负增量；负数会被压成 0，避免把“扣减资源”误走到奖励结算路径。
 * 2. 多角色写回必须按升序执行，减少不同事务在 `characters` 行锁上的顺序反转。
 */
export type CharacterRewardDelta = {
  exp: number;
  silver: number;
  spiritStones: number;
};

type CharacterRewardDeltaInput = {
  exp?: number;
  silver?: number;
  spiritStones?: number;
};

const normalizeRewardDeltaValue = (value: number | undefined): number => {
  if (value === undefined) return 0;
  const normalized = Math.floor(Number(value));
  if (!Number.isFinite(normalized) || normalized <= 0) return 0;
  return normalized;
};

const hasRewardDelta = (delta: CharacterRewardDelta): boolean => {
  return delta.exp > 0 || delta.silver > 0 || delta.spiritStones > 0;
};

export const createCharacterRewardDelta = (): CharacterRewardDelta => ({
  exp: 0,
  silver: 0,
  spiritStones: 0,
});

export const mergeCharacterRewardDelta = (
  target: CharacterRewardDelta,
  delta: CharacterRewardDeltaInput,
): void => {
  target.exp += normalizeRewardDeltaValue(delta.exp);
  target.silver += normalizeRewardDeltaValue(delta.silver);
  target.spiritStones += normalizeRewardDeltaValue(delta.spiritStones);
};

export const addCharacterRewardDelta = (
  rewardMap: Map<number, CharacterRewardDelta>,
  characterId: number,
  delta: CharacterRewardDeltaInput,
): void => {
  if (!Number.isInteger(characterId) || characterId <= 0) return;

  const existing = rewardMap.get(characterId) ?? createCharacterRewardDelta();
  mergeCharacterRewardDelta(existing, delta);
  rewardMap.set(characterId, existing);
};

export const applyCharacterRewardDeltas = async (
  rewardMap: Map<number, CharacterRewardDelta>,
): Promise<void> => {
  const sortedCharacterIds = [...rewardMap.keys()]
    .filter((characterId) => Number.isInteger(characterId) && characterId > 0)
    .sort((left, right) => left - right);

  for (const characterId of sortedCharacterIds) {
    const delta = rewardMap.get(characterId);
    if (!delta || !hasRewardDelta(delta)) continue;

    await query(
      `
        UPDATE characters
        SET exp = exp + $2,
            silver = silver + $3,
            spirit_stones = spirit_stones + $4,
            updated_at = NOW()
        WHERE id = $1
      `,
      [characterId, delta.exp, delta.silver, delta.spiritStones],
    );
  }
};
