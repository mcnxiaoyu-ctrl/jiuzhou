/**
 * 仓库快照纯读聚合策略回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定 `/inventory/warehouse/snapshot` 是纯读接口，不触发同步库存 preflight。
 * 2. 做什么：锁定仓库快照只读取一次 projected item instances，然后按 bag/equipped/warehouse 分桶复用。
 * 3. 不做什么：不测试 React 渲染，不连接真实数据库。
 *
 * 输入 / 输出：
 * - 输入：inventoryRoutes.ts、inventory/itemQuery.ts 源码文本。
 * - 输出：静态结构断言结果。
 *
 * 数据流 / 状态流：
 * GET /warehouse/snapshot -> projected item instances -> bag/equipped/warehouse 分桶
 * -> 容量信息 + 两侧物品统一富化 -> 单响应返回。
 *
 * 复用设计说明：
 * - 复用 `partitionProjectedInventoryItemsByLocation` 和 `buildInventoryItemDefContext`，避免仓库弹窗再拆成 info/bag/warehouse 三条请求。
 * - 后续移动、整理、批量操作刷新仓库时仍走同一个快照入口。
 *
 * 关键边界条件与坑点：
 * 1. 仓库快照不得返回 pending grant 虚拟物品 ID，只能用容量 overlay 反映占用。
 * 2. 背包和仓库必须共享同一份物品定义上下文，避免同一批静态定义重复计算。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readSource = (relativePath: string): string => {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
};

const extractWarehouseSnapshotSource = (source: string): string => {
  const startIndex = source.indexOf('export const getWarehouseInventorySnapshot = async');
  assert.notEqual(startIndex, -1, '缺少 getWarehouseInventorySnapshot 导出');

  const nextExportIndex = source.indexOf('\nexport const ', startIndex + 1);
  return source.slice(startIndex, nextExportIndex === -1 ? source.length : nextExportIndex);
};

test('warehouse snapshot 路由不应挂同步库存实体态 preflight', () => {
  const source = readSource('../../routes/inventoryRoutes.ts');

  assert.match(
    source,
    /router\.get\('\/warehouse\/snapshot',\s*asyncHandler\(async \(req, res\) => \{/u,
  );
  assert.doesNotMatch(
    source,
    /router\.get\('\/warehouse\/snapshot',\s*prepareInventoryConcreteState/u,
  );
});

test('getWarehouseInventorySnapshot 应复用单次 projected 读取与共享富化上下文', () => {
  const source = readSource('../inventory/itemQuery.ts');
  const snapshotSource = extractWarehouseSnapshotSource(source);
  const projectedReadMatches = snapshotSource.match(/loadProjectedCharacterItemInstances\(characterId,/gu) ?? [];

  assert.equal(projectedReadMatches.length, 1);
  assert.match(source, /export const getWarehouseInventorySnapshot = async/u);
  assert.match(
    snapshotSource,
    /const projectedItems = await loadProjectedCharacterItemInstances\(characterId,\s*\{\s*pendingMutations,\s*\}\);/u,
  );
  assert.match(
    snapshotSource,
    /const \{\s*bag: bagProjectedItems,\s*equipped: equippedProjectedItems,\s*warehouse: warehouseProjectedItems/u,
  );
  assert.match(
    snapshotSource,
    /partitionProjectedInventoryItemsByLocation\(projectedItems\)/u,
  );
  assert.match(
    snapshotSource,
    /const sourceItems = \[\.\.\.bagResult\.items,\s*\.\.\.warehouseResult\.items\];/u,
  );
  assert.match(
    snapshotSource,
    /getInventoryItems\(characterId,\s*"equipped",\s*1,\s*200,\s*\{\s*projectedItems: equippedProjectedItems,\s*pendingMutations,\s*\}\)/u,
  );
  assert.match(
    snapshotSource,
    /buildInventoryItemDefContext\(characterId,\s*sourceItems,\s*\{\s*equippedItems: equippedResult\.items,\s*pendingMutations,\s*\}\)/u,
  );
});

test('getWarehouseInventorySnapshot 不应固定截断仓库物品页大小', () => {
  const source = readSource('../inventory/itemQuery.ts');
  const snapshotSource = extractWarehouseSnapshotSource(source);

  assert.doesNotMatch(
    snapshotSource,
    /getInventoryItems\(\s*characterId\s*,\s*"warehouse"\s*,\s*1\s*,\s*200\b/u,
  );
  assert.match(
    snapshotSource,
    /const\s+warehousePageSize\s*=\s*Math\.max\(\s*warehouseProjectedItems\.length\s*,\s*info\.warehouse_capacity\s*\);/u,
  );
  assert.match(
    snapshotSource,
    /getInventoryItems\(\s*characterId\s*,\s*"warehouse"\s*,\s*1\s*,\s*warehousePageSize\s*,/u,
  );
});
