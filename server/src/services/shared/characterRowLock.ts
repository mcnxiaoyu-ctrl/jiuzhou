/**
 * 角色行顺序锁定工具
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：对一组角色 ID 去重、过滤并按升序锁定 `characters` 行，统一多角色事务的行锁顺序。
 * 2. 做什么：把“按固定顺序 `FOR UPDATE characters`”的协议收口到共享入口，避免业务服务各自拼同一段 SQL。
 * 3. 不做什么：不获取背包互斥锁，不校验业务权限，也不更新任何角色资源。
 *
 * 输入/输出：
 * - normalizeCharacterRowLockIds(characterIds) -> 规范化后的角色 ID 列表。
 * - lockCharacterRowsInOrder(characterIds) -> 实际成功锁定到的角色 ID 列表。
 *
 * 数据流/状态流：
 * 服务层传入角色 ID 列表 -> 本模块统一排序去重 -> 执行 `SELECT ... FOR UPDATE`
 * -> 返回已锁定角色 ID，调用方再决定是否继续业务。
 *
 * 关键边界条件与坑点：
 * 1. 本模块必须运行在事务上下文中，否则 `FOR UPDATE` 只在单语句生命周期内生效。
 * 2. 返回值只包含数据库中实际存在且被锁住的角色 ID；调用方若要求“所有角色都必须存在”，需要自行校验数量。
 */
import { query } from '../../config/database.js';

export const normalizeCharacterRowLockIds = (characterIds: number[]): number[] =>
  [...new Set(characterIds)]
    .filter((characterId) => Number.isInteger(characterId) && characterId > 0)
    .sort((left, right) => left - right);

export const lockCharacterRowsInOrder = async (
  characterIds: number[],
): Promise<number[]> => {
  const normalizedCharacterIds = normalizeCharacterRowLockIds(characterIds);
  if (normalizedCharacterIds.length === 0) {
    return [];
  }

  const result = await query(
    `
      SELECT id
      FROM characters
      WHERE id = ANY($1::int[])
      ORDER BY id
      FOR UPDATE
    `,
    [normalizedCharacterIds],
  );

  return result.rows
    .map((row) => Number(row.id))
    .filter((characterId) => Number.isInteger(characterId) && characterId > 0);
};
