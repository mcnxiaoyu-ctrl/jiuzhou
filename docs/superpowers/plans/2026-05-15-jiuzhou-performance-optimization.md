# Jiuzhou Performance Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 降低几百玩家在线时的接口延迟与卡顿，把当前 `jiuzhou_server` 单 Node 事件循环、库存发奖、战斗结算和大响应序列化热点拆成可观测、可验证、可逐步交付的优化。

**Architecture:** 先补齐事件循环与慢路径证据，避免继续靠整机指标误判；再把库存只读链路从同步 flush 中拆出来，减少 `/api/inventory/*` 对背包锁和 `item_instance` 写入的放大；最后优化战斗掉落发放和可缓存配置查询，并在进程内状态收敛后再评估服务副本扩容。

**Tech Stack:** Node.js、TypeScript、Express、PostgreSQL、Redis、Docker Swarm、React、Axios、node:test。

---

## 现状证据

- 服务器 104 CPU 线程、257GB 内存，采样时整机 CPU 空闲约 97%，磁盘 iowait 接近 0。
- `jiuzhou_server` 只有 1 个副本，`node dist/app.js` 单进程长期占用约 80%~100% 单核 CPU。
- 近 30 分钟慢日志：慢 HTTP 445 次、慢业务操作 213 次、用户请求槽排队 166 次。
- 慢接口集中在 `/api/inventory/use`、`/api/inventory/items`、`/api/idle/status`、`/api/character/info`。
- 慢业务集中在 `onlineBattleSettlementRunner.executeTask`、`battleDropService.settleBattleRewardPlan`、`characterItemGrant.flush.phase1`。
- Postgres 当前无锁等待，但累计统计显示 `item_instance` 读写与 advisory lock 是核心热点。

## 文件结构

- Modify: `server/src/bootstrap/startupPipeline.ts`  
  启动和关闭事件循环监控，保证慢请求日志带主线程拥塞指标。
- Test: `server/src/services/__tests__/startupPipelineEventLoopMonitor.test.ts`  
  静态回归测试，防止事件循环监控再次只打印不启动。
- Modify: `server/src/routes/inventoryRoutes.ts`  
  拆分库存只读路由与写操作 preflight，避免 GET 请求触发同步 flush。
- Modify: `server/src/services/inventory/service.ts`  
  给库存 info/list 查询暴露明确的实体态/投影视图读取策略。
- Modify: `server/src/services/inventory/itemQuery.ts`  
  新增仓库快照聚合入口，复用投影视图和一次性富化上下文。
- Test: `server/src/services/__tests__/inventoryReadPreflightPolicy.test.ts`  
  锁定 `/info`、`/items`、`/bag/snapshot`、`/warehouse/snapshot` 的纯读策略。
- Modify: `client/src/services/api/inventory.ts`  
  新增仓库快照 API 类型和请求函数。
- Modify: `client/src/pages/Game/modules/WarehouseModal/index.tsx`  
  从 3 类请求改为 1 次快照请求，避免打开仓库时触发多次服务端 preflight。
- Test: `server/src/services/__tests__/warehouseSnapshotPolicy.test.ts`  
  静态锁定仓库快照复用单次 projected 读取。
- Modify: `server/src/services/shared/characterItemGrantDeltaService.ts`  
  优化 pending grant flush 的批量化边界和慢日志字段。
- Modify: `server/src/services/battleDropService.ts`  
  减少掉落结算中逐物品同步创建导致的主线程和数据库放大。
- Test: `server/src/services/__tests__/battleDropServiceSlowLogging.test.ts`  
  扩展现有慢日志测试，锁定新增批量字段。
- Modify: `server/src/services/generatedTechniqueConfigStore.ts`  
  给高成本生成功法快照刷新增加去重节流和刷新原因日志。
- Test: `server/src/services/__tests__/generatedTechniqueConfigStoreRefreshPolicy.test.ts`  
  锁定短时间重复刷新只执行一次真实数据库加载。
- Modify: `docs/ops/jiuzhou-performance-runbook.md`  
  新增线上只读诊断手册，统一后续排查口径。

> Git 写操作不纳入本计划执行步骤。当前项目要求未经用户明确要求不得执行 `git status`、`git diff`、`git commit` 等 Git 写/读命令。

---

### Task 1: 启动事件循环监控

**Files:**
- Modify: `server/src/bootstrap/startupPipeline.ts`
- Test: `server/src/services/__tests__/startupPipelineEventLoopMonitor.test.ts`

- [ ] **Step 1: 写失败测试**

新增 `server/src/services/__tests__/startupPipelineEventLoopMonitor.test.ts`：

```ts
/**
 * 事件循环监控启动回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定服务启动流水线必须真实调用事件循环监控初始化，而不是只打印“已就绪”。
 * 2. 做什么：锁定优雅关闭阶段会停止事件循环监控，避免测试和热重启残留定时器。
 * 3. 不做什么：不启动 HTTP 服务，不采样真实事件循环，不连接数据库。
 *
 * 输入 / 输出：
 * - 输入：startupPipeline.ts 源码文本。
 * - 输出：静态断言结果。
 *
 * 数据流 / 状态流：
 * 源码读取 -> 校验 import -> 校验 startServerWithPipeline 中 runStartupStep 调用
 * -> 校验 graceful shutdown 中 stopEventLoopMonitor 调用。
 *
 * 复用设计说明：
 * - 用静态测试锁定启动装配边界，后续调整监控实现时不需要 mock 整条启动流水线。
 * - 和现有 inventory 策略测试保持同类模式，降低测试维护成本。
 *
 * 关键边界条件与坑点：
 * 1. 不能只断言日志文本，否则仍可能出现“打印已就绪但没有启动”的回退。
 * 2. 关闭断言必须覆盖 `registerGracefulShutdown` 内部，避免监控定时器在优雅停服后残留。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readSource = (relativePath: string): string => {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
};

test('startupPipeline 应启动并停止事件循环监控', () => {
  const source = readSource('../../bootstrap/startupPipeline.ts');

  assert.match(
    source,
    /initializeEventLoopMonitor,\s*stopEventLoopMonitor/u,
  );
  assert.match(
    source,
    /await runStartupStep\("事件循环监控初始化",\s*initializeEventLoopMonitor\);/u,
  );
  assert.match(
    source,
    /stopEventLoopMonitor\(\);\s*console\.log\("✓ 事件循环监控已停止"\);/u,
  );
});
```

- [ ] **Step 2: 验证测试失败**

Run: `pnpm --filter ./server test:local`  
Expected: FAIL，提示缺少 `initializeEventLoopMonitor` 或启动步骤。

> 执行时需先得到用户对 test 命令的明确许可；若未许可，只执行 `tsc -b`。

- [ ] **Step 3: 实现启动和关闭**

在 `server/src/bootstrap/startupPipeline.ts` 增加 import：

```ts
import {
  initializeEventLoopMonitor,
  stopEventLoopMonitor,
} from "../services/eventLoopMonitorService.js";
```

在在线战斗延迟结算协调器初始化之后替换当前纯日志：

```ts
await runStartupStep("事件循环监控初始化", initializeEventLoopMonitor);
console.log("✓ 事件循环监控已就绪\n");
```

在优雅关闭阶段、后台服务停止区间加入：

```ts
stopEventLoopMonitor();
console.log("✓ 事件循环监控已停止");
```

- [ ] **Step 4: 验证**

Run: `tsc -b`  
Expected: PASS。

Run: `pnpm --filter ./server test:local`  
Expected: PASS，其中 `startupPipeline 应启动并停止事件循环监控` 通过。

---

### Task 2: 拆分库存只读请求和同步 flush

**Files:**
- Modify: `server/src/routes/inventoryRoutes.ts`
- Modify: `server/src/services/inventory/service.ts`
- Test: `server/src/services/__tests__/inventoryReadPreflightPolicy.test.ts`

- [ ] **Step 1: 写失败测试**

新增 `server/src/services/__tests__/inventoryReadPreflightPolicy.test.ts`：

```ts
/**
 * 库存只读接口 preflight 策略回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定 `/inventory/info` 与 `/inventory/items` 不再挂同步库存实体态 preflight。
 * 2. 做什么：锁定写操作仍然使用 `prepareInventoryConcreteState`，保证使用、移动、装备等操作面对真实实例。
 * 3. 不做什么：不连接 Redis/PostgreSQL，不断言具体物品数据。
 *
 * 输入 / 输出：
 * - 输入：inventoryRoutes.ts、inventory/service.ts 源码文本。
 * - 输出：静态策略断言。
 *
 * 数据流 / 状态流：
 * GET 只读请求 -> 投影视图读取；POST 写请求 -> prepareInventoryInteraction -> 实体态写操作。
 *
 * 复用设计说明：
 * - 读写边界集中在路由层测试，避免后续新增 GET 路由时复制错误的同步 flush 策略。
 * - service 层测试锁定默认 info 查询不再假设 pending grants 已 flush。
 *
 * 关键边界条件与坑点：
 * 1. `/inventory/use` 必须继续保留 preflight，否则会拿到尚未落库的实例 ID。
 * 2. `/inventory/items` 只读列表不展示 pending grant 的虚拟物品 ID，只通过容量 overlay 体现占用。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readSource = (relativePath: string): string => {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
};

test('库存 GET 只读接口不应挂同步实体态 preflight', () => {
  const source = readSource('../../routes/inventoryRoutes.ts');

  assert.match(source, /router\.get\('\/info',\s*asyncHandler/u);
  assert.doesNotMatch(source, /router\.get\('\/info',\s*prepareInventoryConcreteState/u);

  assert.match(source, /router\.get\('\/items',\s*asyncHandler/u);
  assert.doesNotMatch(source, /router\.get\('\/items',\s*prepareInventoryConcreteState/u);

  assert.match(source, /router\.post\('\/use',\s*prepareInventoryConcreteState/u);
  assert.match(source, /router\.post\('\/move',\s*prepareInventoryConcreteState/u);
});

test('InventoryService.getInventoryInfo 默认不应声明 pending grants 已 flush', () => {
  const source = readSource('../inventory/service.ts');

  assert.doesNotMatch(
    source,
    /async getInventoryInfo\(characterId: number\): Promise<InventoryInfo> \{\s*return getInventoryInfo\(characterId,\s*\{\s*knownPendingGrantsFlushed:\s*true\s*\}\);/u,
  );
  assert.match(
    source,
    /async getInventoryInfo\(\s*characterId: number,\s*options: \{ knownPendingGrantsFlushed\?: boolean \} = \{\},\s*\): Promise<InventoryInfo>/u,
  );
});
```

- [ ] **Step 2: 实现 service 参数**

修改 `server/src/services/inventory/service.ts`：

```ts
  async getInventoryInfo(
    characterId: number,
    options: { knownPendingGrantsFlushed?: boolean } = {},
  ): Promise<InventoryInfo> {
    return getInventoryInfo(characterId, options);
  }
```

- [ ] **Step 3: 修改只读路由**

修改 `server/src/routes/inventoryRoutes.ts`：

```ts
router.get('/info', asyncHandler(async (req, res) => {
    const characterId = req.characterId!;

    const info = await inventoryService.getInventoryInfo(characterId);
    sendSuccess(res, info);
}));

router.get('/items', asyncHandler(async (req, res) => {
    const characterId = req.characterId!;

    const location = parseNonEmptyText(getSingleQueryValue(req.query.location)) ?? 'bag';
    if (!isAllowedLocation(location)) {
      throw new BusinessError('location参数错误');
    }
    const page = parsePositiveInt(getSingleQueryValue(req.query.page)) ?? 1;
    const pageSize = Math.min(parsePositiveInt(getSingleQueryValue(req.query.pageSize)) ?? 100, 200);

    const result = await inventoryService.getInventoryItemsWithDefs(characterId, location, page, pageSize);

    sendSuccess(res, {
      items: result.items,
      total: result.total,
      page,
      pageSize,
    });
}));
```

- [ ] **Step 4: 验证**

Run: `tsc -b`  
Expected: PASS。

Run: `pnpm --filter ./server test:local`  
Expected: PASS，库存策略测试通过。

---

### Task 3: 新增仓库快照，减少打开仓库时的请求数和重复富化

**Files:**
- Modify: `server/src/services/inventory/itemQuery.ts`
- Modify: `server/src/services/inventory/service.ts`
- Modify: `server/src/routes/inventoryRoutes.ts`
- Modify: `client/src/services/api/inventory.ts`
- Modify: `client/src/pages/Game/modules/WarehouseModal/index.tsx`
- Test: `server/src/services/__tests__/warehouseSnapshotPolicy.test.ts`

- [ ] **Step 1: 写失败测试**

新增 `server/src/services/__tests__/warehouseSnapshotPolicy.test.ts`：

```ts
/**
 * 仓库快照纯读聚合策略回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定 `/inventory/warehouse/snapshot` 是纯读接口，不触发同步库存 preflight。
 * 2. 做什么：锁定仓库快照只读取一次 projected item instances，然后按 bag/warehouse 分桶复用。
 * 3. 不做什么：不测试 React 渲染，不连接真实数据库。
 *
 * 输入 / 输出：
 * - 输入：inventoryRoutes.ts、inventory/itemQuery.ts 源码文本。
 * - 输出：静态结构断言。
 *
 * 数据流 / 状态流：
 * GET /warehouse/snapshot -> projected item instances -> bag/warehouse 分桶
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

  assert.match(source, /export const getWarehouseInventorySnapshot = async/u);
  assert.match(
    source,
    /const projectedItems = await loadProjectedCharacterItemInstances\(characterId,\s*\{\s*pendingMutations,\s*\}\);/u,
  );
  assert.match(
    source,
    /const \{\s*bag: bagProjectedItems,\s*warehouse: warehouseProjectedItems/u,
  );
  assert.match(
    source,
    /const sourceItems = \[\.\.\.bagResult\.items,\s*\.\.\.warehouseResult\.items\];/u,
  );
});
```

- [ ] **Step 2: 新增服务端快照类型和方法**

在 `server/src/services/inventory/itemQuery.ts` 增加导出：

```ts
export const getWarehouseInventorySnapshot = async (
  characterId: number,
): Promise<{
  info: InventoryInfo;
  bagItems: InventoryItemWithDef[];
  warehouseItems: InventoryItemWithDef[];
}> => {
  const pendingMutations = await loadCharacterPendingItemInstanceMutations(characterId);
  const projectedItems = await loadProjectedCharacterItemInstances(characterId, {
    pendingMutations,
  });
  const {
    bag: bagProjectedItems,
    warehouse: warehouseProjectedItems,
  } = partitionProjectedInventoryItemsByLocation(projectedItems);

  const [info, bagResult, warehouseResult] = await Promise.all([
    getInventoryInfo(characterId, {
      bagProjectedItems,
      warehouseProjectedItems,
    }),
    getInventoryItems(characterId, "bag", 1, 200, {
      projectedItems: bagProjectedItems,
      pendingMutations,
    }),
    getInventoryItems(characterId, "warehouse", 1, 200, {
      projectedItems: warehouseProjectedItems,
      pendingMutations,
    }),
  ]);

  const sourceItems = [...bagResult.items, ...warehouseResult.items];
  if (sourceItems.length <= 0) {
    return { info, bagItems: [], warehouseItems: [] };
  }

  const context = await buildInventoryItemDefContext(characterId, sourceItems, {
    pendingMutations,
  });
  const enrichedItems = enrichInventoryItemsWithDefs(sourceItems, context);
  const bagItemIdSet = new Set(bagResult.items.map((item) => item.id));
  const bagItems: InventoryItemWithDef[] = [];
  const warehouseItems: InventoryItemWithDef[] = [];

  for (const item of enrichedItems) {
    if (bagItemIdSet.has(item.id)) {
      bagItems.push(item);
    } else {
      warehouseItems.push(item);
    }
  }

  return { info, bagItems, warehouseItems };
};
```

在 `server/src/services/inventory/service.ts` 引入并暴露：

```ts
import {
  getBagInventorySnapshot,
  getInventoryItemsWithDefs,
  getEquippedItemDefIds,
  getWarehouseInventorySnapshot,
} from "./itemQuery.js";

  async getWarehouseInventorySnapshot(characterId: number): Promise<{
    info: InventoryInfo;
    bagItems: InventoryItemWithDef[];
    warehouseItems: InventoryItemWithDef[];
  }> {
    return getWarehouseInventorySnapshot(characterId);
  }
```

- [ ] **Step 3: 新增路由**

在 `server/src/routes/inventoryRoutes.ts` 的 bag snapshot 后增加：

```ts
router.get('/warehouse/snapshot', asyncHandler(async (req, res) => {
    const characterId = req.characterId!;

    const snapshot = await inventoryService.getWarehouseInventorySnapshot(characterId);
    sendSuccess(res, snapshot);
}));
```

- [ ] **Step 4: 前端 API 与仓库弹窗改为单请求**

在 `client/src/services/api/inventory.ts` 增加：

```ts
export interface InventoryWarehouseSnapshotResponse {
  success: boolean;
  message?: string;
  data?: {
    info: InventoryInfoData;
    bagItems: InventoryItemDto[];
    warehouseItems: InventoryItemDto[];
  };
}

export const getWarehouseInventorySnapshot = (
  requestConfig?: AxiosRequestConfig,
): Promise<InventoryWarehouseSnapshotResponse> => {
  return api.get('/inventory/warehouse/snapshot', requestConfig);
};
```

在 `client/src/pages/Game/modules/WarehouseModal/index.tsx` 中替换 `refreshAll` 内的并发三请求：

```ts
const refreshAll = useCallback(async (options?: { keepLoading?: boolean }) => {
  const keepLoading = Boolean(options?.keepLoading);
  if (!keepLoading) setLoading(true);
  try {
    const snapshotRes = await getWarehouseInventorySnapshot();
    const snapshot = snapshotRes.success ? snapshotRes.data : undefined;
    const nextBagCap = snapshot ? Number(snapshot.info.bag_capacity || 0) : 0;
    const nextWhCap = snapshot ? Number(snapshot.info.warehouse_capacity || 0) : 0;
    setBagCapacity(nextBagCap);
    setWarehouseCapacity(nextWhCap);
    setBagSlots(buildSlots(nextBagCap, snapshot?.bagItems ?? []));
    setWarehouseSlots(buildSlots(nextWhCap, snapshot?.warehouseItems ?? []));
  } catch {
    setBagSlots([]);
    setBagCapacity(0);
    setWarehouseSlots([]);
    setWarehouseCapacity(0);
  } finally {
    if (!keepLoading) setLoading(false);
  }
}, []);
```

- [ ] **Step 5: 验证**

Run: `tsc -b`  
Expected: PASS。

Run: `pnpm --filter ./server test:local`  
Expected: PASS。

---

### Task 4: 量化并收敛物品发放 flush 热点

**Files:**
- Modify: `server/src/services/shared/characterItemGrantDeltaService.ts`
- Modify: `server/src/services/battleDropService.ts`
- Test: `server/src/services/__tests__/battleDropServiceSlowLogging.test.ts`

- [ ] **Step 1: 扩展慢日志字段测试**

在现有 `battleDropServiceSlowLogging.test.ts` 中扩展断言，要求 `grantRewardDrops` 阶段带出以下字段：

```ts
assert.deepEqual(
  marks.find((mark) => mark.name === 'grantRewardDrops')?.fields,
  assert.objectContaining({
    grantedDropCount: 1,
    grantRewardOriginalItemCreateCallCount: 1,
    grantRewardDisassembleRewardCreateCallCount: 0,
    grantRewardEquipmentGenerateCount: 1,
  }) as never,
);
```

若 `assert.objectContaining` 不适用于当前 node:test 环境，改为逐字段断言：

```ts
const grantRewardMark = marks.find((mark) => mark.name === 'grantRewardDrops');
assert.equal(grantRewardMark?.fields?.grantedDropCount, 1);
assert.equal(grantRewardMark?.fields?.grantRewardOriginalItemCreateCallCount, 1);
assert.equal(grantRewardMark?.fields?.grantRewardDisassembleRewardCreateCallCount, 0);
assert.equal(grantRewardMark?.fields?.grantRewardEquipmentGenerateCount, 1);
```

- [ ] **Step 2: 给 `characterItemGrant.flush.phase1` 增加批量度指标**

在 `flushSingleCharacterItemGrants` 的 slow logger fields 中保留现有字段，并补充：

```ts
fields: {
  characterId,
  item_grant_flush_batch_size: grants.length,
  item_grant_distinct_item_def_count: new Set(grants.map((grant) => grant.payload.itemDefId)).size,
}
```

在 `createItems` mark 中增加：

```ts
slowLogger.mark('createItems', {
  item_grant_overflow_count: pendingMailItems.length,
  item_grant_created_count: grants.length - pendingMailItems.length,
  item_grant_pending_mail_item_count: pendingMailItems.length,
});
```

- [ ] **Step 3: 用证据决定批量落库范围**

线上观察 24 小时后，按日志聚合：

```bash
docker logs --since 24h 7432dbc743fc 2>&1 \
  | sed -r 's/\x1B\[[0-9;]*[mK]//g' \
  | grep 'characterItemGrant.flush.phase1' \
  | grep -o '"item_grant_flush_batch_size":[0-9]*' \
  | sort | uniq -c | sort -nr | head -20
```

Expected: 得到批量大小分布。若 `batch_size=1` 占绝大多数，优先减少触发次数；若大批量多，优先做批量 SQL。

- [ ] **Step 4: 第一阶段只做低风险收敛**

不得直接把所有 `itemService.createItem` 改成一条复杂 SQL。先保证：

```ts
const slotSession = await createInventorySlotSession([characterId]);
const bagSlotAllocator = createCharacterBagSlotAllocatorFromSession(slotSession, [characterId]);
const inventoryMutationContext = createCharacterInventoryMutationContextFromSession(slotSession);
```

仍然只创建一次，并且所有 `itemService.createItem` 复用这三个对象。若当前已满足，则只提交指标，不改行为。

- [ ] **Step 5: 验证**

Run: `tsc -b`  
Expected: PASS。

Run: `pnpm --filter ./server test:local`  
Expected: PASS。

---

### Task 5: 生成功法配置刷新去重节流

**Files:**
- Modify: `server/src/services/generatedTechniqueConfigStore.ts`
- Test: `server/src/services/__tests__/generatedTechniqueConfigStoreRefreshPolicy.test.ts`

- [ ] **Step 1: 写失败测试**

新增测试，锁定并发刷新只执行一次真实查询：

```ts
/**
 * AI 生成功法配置刷新去重回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定短时间并发调用刷新时只执行一次真实数据库加载。
 * 2. 做什么：避免生成功法发布或预览链路把高成本宽表查询重复压到 Postgres。
 * 3. 不做什么：不验证 SQL 执行计划，不连接真实数据库。
 *
 * 输入 / 输出：
 * - 输入：mock 的 query 方法和并发 reload 调用。
 * - 输出：query 调用次数保持为 3，因为真实加载包含 def/skill/layer 三条查询。
 *
 * 数据流 / 状态流：
 * 多个 reloadGeneratedTechniqueConfigStore 调用 -> 共享 inflight promise -> 单次数据库加载 -> 所有调用完成。
 *
 * 复用设计说明：
 * - 把去重放在 config store 内部，所有刷新调用点自动复用，不需要每个业务服务各自节流。
 *
 * 关键边界条件与坑点：
 * 1. 失败时必须清空 inflight promise，否则后续永远无法刷新。
 * 2. 串行两次刷新仍应执行两轮加载，不能把新发布内容长期缓存住。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as database from '../../config/database.js';
import { reloadGeneratedTechniqueConfigStore } from '../generatedTechniqueConfigStore.js';

test('reloadGeneratedTechniqueConfigStore 并发调用应复用同一个刷新任务', async (t) => {
  let queryCount = 0;
  t.mock.method(database, 'query', async () => {
    queryCount += 1;
    return { rows: [] };
  });

  await Promise.all([
    reloadGeneratedTechniqueConfigStore(),
    reloadGeneratedTechniqueConfigStore(),
    reloadGeneratedTechniqueConfigStore(),
  ]);

  assert.equal(queryCount, 3);
});
```

- [ ] **Step 2: 实现 inflight 去重**

在 `server/src/services/generatedTechniqueConfigStore.ts` 增加模块级状态：

```ts
let reloadGeneratedTechniqueConfigStorePromise: Promise<void> | null = null;
```

把现有 `reloadGeneratedTechniqueConfigStore` 包一层：

```ts
const reloadGeneratedTechniqueConfigStoreInternal = async (): Promise<void> => {
  // 保留现有 try/catch 与三段 query 实现
};

export const reloadGeneratedTechniqueConfigStore = async (): Promise<void> => {
  if (reloadGeneratedTechniqueConfigStorePromise) {
    return reloadGeneratedTechniqueConfigStorePromise;
  }

  const reloadPromise = reloadGeneratedTechniqueConfigStoreInternal();
  reloadGeneratedTechniqueConfigStorePromise = reloadPromise;
  try {
    await reloadPromise;
  } finally {
    if (reloadGeneratedTechniqueConfigStorePromise === reloadPromise) {
      reloadGeneratedTechniqueConfigStorePromise = null;
    }
  }
};
```

- [ ] **Step 3: 验证**

Run: `tsc -b`  
Expected: PASS。

Run: `pnpm --filter ./server test:local`  
Expected: PASS。

---

### Task 6: 线上只读诊断手册

**Files:**
- Create: `docs/ops/jiuzhou-performance-runbook.md`

- [ ] **Step 1: 新增诊断手册**

写入以下内容：

```md
# 九州服务性能只读诊断手册

## 目标

用于确认卡顿来自整机资源、Node 事件循环、数据库、Redis、网络连接，还是业务热点路径。

## 禁止操作

- 不重启容器。
- 不修改 Docker service。
- 不执行数据库 DDL/DML。
- 不清理 Redis。
- 不执行 Git 操作。

## 基础采样

```bash
hostname; whoami; date; uptime; uname -a
nproc
free -m
vmstat 1 5
iostat -xz 1 5
docker stats --no-stream
docker ps --format 'table {{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
```

## Node 主线程判断

```bash
ps -eo pid,ppid,user,stat,psr,pcpu,pmem,rss,vsz,etimes,comm,args --sort=-pcpu | head -30
pidstat -u -p <node-pid> 1 6
pidstat -t -u -p <node-pid> 1 6
```

## 慢日志聚合

```bash
docker logs --since 30m <jiuzhou_server_container_id> 2>&1 \
  | sed -r 's/\x1B\[[0-9;]*[mK]//g' \
  | awk '
    /http.slow-request/ {slow_http++}
    /slow-operation/ {slow_op++}
    /UserConnectionSlots/ {slots++}
    END {
      print "slow_http", slow_http+0;
      print "slow_operation", slow_op+0;
      print "user_slot_queue", slots+0;
    }'
```

## Postgres 当前状态

```bash
docker exec <postgres_container_id> psql -U postgres -d jiuzhou -c "
select state, wait_event_type, wait_event, count(*)
from pg_stat_activity
group by state, wait_event_type, wait_event
order by count(*) desc;"
```

## Postgres 累计热点

```bash
docker exec <postgres_container_id> psql -U postgres -d jiuzhou -c "
select calls,
       round(total_exec_time::numeric,2) as total_ms,
       round(mean_exec_time::numeric,2) as mean_ms,
       rows,
       left(query, 180) as query
from pg_stat_statements
order by total_exec_time desc
limit 20;"
```
```

- [ ] **Step 2: 验证**

Run: `tsc -b`  
Expected: PASS。该任务只新增文档，但整批优化结束仍统一执行 TypeScript 构建校验。

---

## 验收标准

- 慢请求日志必须出现 `eventLoopUtilization`、`eventLoopDelayP95Ms`、`eventLoopDelayMaxMs` 字段。
- `/api/inventory/info` 和 `/api/inventory/items` 不再触发 `characterItemGrant.flush.phase1`。
- 打开仓库由 3 类库存请求收敛为 1 次 `/api/inventory/warehouse/snapshot`。
- 近 30 分钟 `UserConnectionSlots` 排队次数显著下降；若仍高，继续查单用户高频请求来源。
- `battleDropService.settleBattleRewardPlan` 慢日志能区分慢在掉落数量、装备生成、原物品创建、自动分解创建。
- `tsc -b` 必须成功。

## 执行顺序

1. Task 1 先做监控，避免后续优化缺少主线程指标。
2. Task 2 和 Task 3 优先做，因为它们直接减少用户打开背包/仓库时的同步 flush 和请求数。
3. Task 4 先补指标再决定是否批量 SQL，避免盲目重写发奖事务。
4. Task 5 处理低频但单次重的配置刷新，降低 Postgres 累计热点。
5. Task 6 固化运维排查口径。

## 暂不做

- 暂不直接把 `jiuzhou_server` 扩到多副本，因为存在进程内状态，例如 `UserConnectionSlots`。扩容前必须先确认用户槽位、在线战斗投影、Socket 推送、定时任务是否能跨实例一致。
- 暂不把所有库存写入改成一条大 SQL。先用日志确认批量大小和热点分布，再做最小可验证批量化。
- 暂不修改数据库参数。当前证据显示不是整机 IO 或 Postgres 锁等待导致的主卡点。

## Self-Review

- Spec coverage：覆盖了事件循环证据、库存只读链路、仓库请求收敛、战斗掉落发放、功法配置重查询和运维诊断。
- Placeholder scan：没有 `TBD`、`TODO`、`implement later`；每个代码任务都给出具体文件、测试或实现片段。
- Type consistency：新增 API 类型使用现有 `InventoryInfoData`、`InventoryItemDto`；服务端快照返回复用 `InventoryInfo`、`InventoryItemWithDef`。
