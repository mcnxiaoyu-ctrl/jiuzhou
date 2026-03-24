/**
 * 物品使用角色预读锁策略回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定 `useItem` 必须复用角色境界快照共享入口，而不是在拿到背包锁后继续 `FOR UPDATE characters`。
 * 2. 做什么：锁定只读角色预检要发生在背包互斥锁之前，避免把静态判定和缓存读取都塞进 `3101` 锁窗口。
 * 3. 不做什么：不执行真实物品使用流程，不校验掉落、冷却或体力恢复。
 *
 * 输入/输出：
 * - 输入：itemService 源码文本。
 * - 输出：共享入口引用、调用顺序与禁用旧 SQL 片段的断言结果。
 *
 * 数据流/状态流：
 * 读取源码 -> 检查 `loadCharacterRealmSnapshot` 与 `getCharacterComputedByCharacterId`
 * -> 断言两者都位于 `lockCharacterInventoryMutex` 之前
 * -> 断言旧的 `SELECT ... FROM characters ... FOR UPDATE` 已消失。
 *
 * 关键边界条件与坑点：
 * 1. 这里只锁定“角色预读阶段”的并发协议，不约束物品实例行锁与后续角色资源更新。
 * 2. 必须同时约束“共享入口复用”和“调用顺序”，否则实现仍可能把无锁快照塞回背包锁窗口里。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readSource = (relativePath: string): string => {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
};

test('useItem 应在背包锁前完成角色快照预检并移除 characters FOR UPDATE', () => {
  const source = readSource('../itemService.ts');

  assert.match(
    source,
    /const realmSnapshot = await loadCharacterRealmSnapshot\(characterId\);[\s\S]*const computedBefore = await getCharacterComputedByCharacterId\(characterId\);[\s\S]*await lockCharacterInventoryMutex\(characterId\);/u,
  );
  assert.doesNotMatch(
    source,
    /SELECT id, realm, sub_realm FROM characters WHERE id = \$1 FOR UPDATE/u,
  );
});
