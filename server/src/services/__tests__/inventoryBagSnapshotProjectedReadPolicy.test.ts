/**
 * 背包快照纯读投影视图策略回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定 `/api/inventory/bag/snapshot` 不再挂同步库存 preflight，避免只读弹窗被奖励 flush、实例 mutation flush 或背包互斥锁阻塞。
 * 2. 做什么：锁定 `getBagInventorySnapshot` 继续走 projected item instance + pending grant overlay 读路径，避免回退成“先 flush 再读”的重型实现。
 * 3. 不做什么：不连接真实数据库、不启动服务，也不验证前端渲染结果。
 *
 * 输入 / 输出：
 * - 输入：`inventoryRoutes.ts`、`inventory/itemQuery.ts` 源码文本。
 * - 输出：针对路由装配与快照实现的静态断言结果。
 *
 * 数据流 / 状态流：
 * 读取源码 -> 断言 snapshot 路由未挂 `prepareInventoryConcreteState`
 * -> 断言 snapshot 查询显式复用 pending mutations
 * -> 断言容量查询不再强制假设 pending grants 已 flush。
 *
 * 复用设计说明：
 * - 这里锁定的是“读接口必须保持纯读”的结构约束，后续若再优化背包快照实现，仍能复用同一回归边界，避免锁等待问题回流。
 * - 路由层与 service 层同时断言，可以覆盖“只改掉其中一层导致语义半回退”的重复风险。
 *
 * 关键边界条件与坑点：
 * 1. 该测试只验证源码结构，不覆盖运行期 Redis / PostgreSQL 锁竞争；真实并发问题仍由线上观测与集成回归承担。
 * 2. 正则需要尽量约束到 snapshot 片段，避免其他路由或其他查询函数里的同名调用误伤断言。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readSource = (relativePath: string): string => {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
};

test('bag snapshot 路由不应挂同步库存实体态 preflight', () => {
  const source = readSource('../../routes/inventoryRoutes.ts');

  assert.match(
    source,
    /router\.get\('\/bag\/snapshot',\s*asyncHandler\(async \(req, res\) => \{/u,
  );
  assert.doesNotMatch(
    source,
    /router\.get\('\/bag\/snapshot',\s*prepareInventoryConcreteState/u,
  );
});

test('getBagInventorySnapshot 应走 projected 读路径并保留 pending grant overlay', () => {
  const source = readSource('../inventory/itemQuery.ts');

  assert.match(source, /const pendingMutations = await loadCharacterPendingItemInstanceMutations\(characterId\);/u);
  assert.match(
    source,
    /const projectedItems = await loadProjectedCharacterItemInstances\(characterId,\s*\{\s*pendingMutations,\s*\}\);/u,
  );
  assert.match(
    source,
    /getInventoryInfo\(characterId,\s*\{\s*bagProjectedItems,\s*warehouseProjectedItems,\s*\}\)/u,
  );
  assert.doesNotMatch(
    source,
    /getInventoryInfo\(characterId,\s*\{[\s\S]*knownPendingGrantsFlushed:\s*true/u,
  );
  assert.match(
    source,
    /buildInventoryItemDefContext\(characterId,\s*sourceItems,\s*\{\s*equippedItems:\s*equippedResult\.items,\s*pendingMutations,\s*\}\)/u,
  );
});
