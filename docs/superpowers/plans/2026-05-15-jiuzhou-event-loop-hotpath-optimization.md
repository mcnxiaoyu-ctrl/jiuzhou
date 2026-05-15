# Jiuzhou Event Loop Hotpath Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把线上已确认的单 Node 事件循环拥塞从战斗结算、物品发奖、`/inventory/use` 和大响应列表路径上拆开，降低几百玩家在线时的接口排队与卡顿。

**Architecture:** 先在现有单进程内做事件循环反压，避免后台结算在 HTTP 高峰继续补派任务；再把同步等待用户响应的路径改成“写事务完成即响应、补推异步执行”；随后收敛掉落发奖和列表响应体大小。最后用运行角色开关把 HTTP 进程和结算 worker 拆成可独立扩容的部署单元。

**Tech Stack:** Node.js、TypeScript、Express、PostgreSQL、Redis、Docker Swarm、React、Axios、node:test。

---

## 线上证据

- 服务器整机仍很空：104 线程机器 `vmstat` 采样约 96%~98% idle，iowait 接近 0，内存可用约 217GiB。
- `jiuzhou_server` 只有 1 个副本，新版本已部署且事件循环监控生效。
- 近 1 分钟慢日志：慢请求 128 条，`event_loop_busy` 20 次，事件循环平均利用率 0.85，最高 1.00，最大延迟 515ms。
- 慢操作当前集中在：
  - `onlineBattleSettlementRunner.executeTask`：平均 2747ms，最高 4924ms。
  - `battleDropService.settleBattleRewardPlan`：平均 2363ms，最高 4439ms。
  - `characterItemGrant.flush.phase1`：平均 529ms，最高 1260ms。
  - `onlineBattleSettlementRunner.tick`：最高 5111ms。
- 慢接口当前集中在：
  - `/api/inventory/use`：平均 1544ms，最高 4379ms。
  - `/api/character/info`：平均 1672ms。
  - `/api/battle-session/start`、`/api/dungeon/instance/create`。
  - `/api/market/listings`、`/api/market/partner-listings`。
- `/api/inventory/warehouse/snapshot` 没有慢日志，上一轮仓库快照优化没有成为新瓶颈。

## 文件结构

- Modify: `server/src/services/onlineBattleSettlementDrainPolicy.ts`  
  新增事件循环反压预算纯函数，统一决定每轮 tick 的并发、派发数量和派发窗口。
- Modify: `server/src/services/onlineBattleSettlementRunner.ts`  
  在 tick 开始读取事件循环快照，动态降低后台结算派发强度，慢日志带出反压状态。
- Test: `server/src/services/__tests__/onlineBattleSettlementDrainPolicyBackpressure.test.ts`  
  静态/纯函数测试，锁定 busy event loop 下只派发 1 个后台结算任务。
- Modify: `server/src/middleware/pushUpdate.ts`  
  新增异步调度角色刷新工具，保留现有 `safePushCharacterUpdate`。
- Modify: `server/src/routes/inventoryRoutes.ts`  
  `/inventory/use` 成功后先返回响应，再异步推送角色刷新，减少接口同步等待。
- Test: `server/src/services/__tests__/inventoryUseResponsePolicy.test.ts`  
  静态测试，锁定成功响应不再等待 `safePushCharacterUpdate`。
- Create: `server/src/services/battleDropGrantUnit.ts`  
  把战斗掉落聚合成可发放单元；普通非装备同角色同物品合并，装备保持逐件。
- Modify: `server/src/services/battleDropService.ts`  
  使用掉落发放单元减少 `grantRewardItemWithAutoDisassemble` 与 `itemService.createItem` 调用次数。
- Test: `server/src/services/__tests__/battleDropGrantUnit.test.ts`  
  纯函数测试，锁定普通掉落聚合、装备掉落不聚合、不同角色不聚合。
- Modify: `server/src/services/itemService.ts`  
  给 `/inventory/use` 核心阶段补慢日志，并把 loot item 结果按 `itemDefId` 单次聚合。
- Test: `server/src/services/__tests__/itemUseLootAggregationPolicy.test.ts`  
  静态测试，锁定 `lootItemsToAdd` 在 buffer 前已聚合。
- Modify: `server/src/services/marketService.ts`  
  降低公开坊市列表最大 pageSize，避免单响应 100 条装备详情 JSON 压垮事件循环。
- Modify: `server/src/services/partnerMarketService.ts`  
  降低伙伴坊市列表最大 pageSize，减少 partner snapshot 大响应序列化。
- Test: `server/src/services/__tests__/marketListingPageSizePolicy.test.ts`  
  静态测试，锁定两个公开列表最大 pageSize 为 40。
- Create: `server/src/config/runtimeRole.ts`  
  定义 `JIUZHOU_RUNTIME_ROLE=all|api|worker`，为 HTTP 与后台结算拆进程做运行时开关。
- Modify: `server/src/bootstrap/startupPipeline.ts`  
  根据运行角色决定是否启动 HTTP 监听、在线结算 runner、AI worker 协调器等后台任务。
- Test: `server/src/services/__tests__/startupRuntimeRolePolicy.test.ts`  
  静态测试，锁定 API 角色不启动在线结算 runner，worker 角色不监听 HTTP。

> 当前项目约束：未经用户明确要求，不执行 Git 命令；未经用户明确要求，不执行 dev/start/build/test/联调命令。代码改动后必须执行 `tsc -b`。本计划中的 node:test 测试文件用于回归保护，执行阶段如未获授权，只写测试并运行 `tsc -b`。

---

### Task 1: 在线结算 runner 增加事件循环反压

**Files:**
- Modify: `server/src/services/onlineBattleSettlementDrainPolicy.ts`
- Modify: `server/src/services/onlineBattleSettlementRunner.ts`
- Test: `server/src/services/__tests__/onlineBattleSettlementDrainPolicyBackpressure.test.ts`

- [ ] **Step 1: 写反压预算纯函数测试**

Create `server/src/services/__tests__/onlineBattleSettlementDrainPolicyBackpressure.test.ts`:

```ts
/**
 * 在线战斗延迟结算事件循环反压策略测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定 event loop 繁忙时 runner 单轮只派发 1 个后台结算任务。
 * 2. 做什么：锁定 event loop 正常时保留现有并发预算，避免后台任务无故堆积。
 * 3. 不做什么：不启动真实 runner，不连接 Redis/数据库，不执行真实发奖。
 *
 * 输入 / 输出：
 * - 输入：dispatch budget 参数与事件循环快照。
 * - 输出：反压后的 maxConcurrency、maxDispatchedTaskCount、dispatchBudgetMs。
 *
 * 数据流 / 状态流：
 * eventLoopMonitor 快照 -> resolveOnlineBattleSettlementDispatchBudget
 * -> onlineBattleSettlementRunner.tick 使用预算控制补派任务。
 *
 * 复用设计说明：
 * - 将预算判断抽成纯函数，runner 和测试复用同一入口，避免测试复制调度条件。
 * - 后续调阈值只改策略函数，不改 runner 主循环。
 *
 * 关键边界条件与坑点：
 * 1. `drainAll=true` 是显式 flush，不能被普通反压截断。
 * 2. busy 阈值必须同时看 utilization 和 delay；CPU 空闲但事件循环 delay 高时仍要反压。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveOnlineBattleSettlementDispatchBudget } from '../onlineBattleSettlementDrainPolicy.js';

test('event loop 繁忙时应把常规 tick 限制为单任务派发', () => {
  const budget = resolveOnlineBattleSettlementDispatchBudget({
    drainAll: false,
    baseMaxConcurrency: 4,
    baseMaxDispatchedTaskCount: 8,
    tickBudgetMs: 1500,
    drainTailReserveMs: 350,
    eventLoopUtilization: 0.93,
    eventLoopDelayP95Ms: 42,
  });

  assert.equal(budget.eventLoopBackpressured, true);
  assert.equal(budget.maxConcurrency, 1);
  assert.equal(budget.maxDispatchedTaskCount, 1);
  assert.equal(budget.dispatchBudgetMs, 250);
});

test('event loop 正常时应保留基础派发预算', () => {
  const budget = resolveOnlineBattleSettlementDispatchBudget({
    drainAll: false,
    baseMaxConcurrency: 4,
    baseMaxDispatchedTaskCount: 8,
    tickBudgetMs: 1500,
    drainTailReserveMs: 350,
    eventLoopUtilization: 0.35,
    eventLoopDelayP95Ms: 23,
  });

  assert.equal(budget.eventLoopBackpressured, false);
  assert.equal(budget.maxConcurrency, 4);
  assert.equal(budget.maxDispatchedTaskCount, 8);
  assert.equal(budget.dispatchBudgetMs, 1150);
});

test('drainAll 显式 flush 不应被反压预算截断', () => {
  const budget = resolveOnlineBattleSettlementDispatchBudget({
    drainAll: true,
    baseMaxConcurrency: 4,
    baseMaxDispatchedTaskCount: 8,
    tickBudgetMs: 1500,
    drainTailReserveMs: 350,
    eventLoopUtilization: 1,
    eventLoopDelayP95Ms: 160,
  });

  assert.equal(budget.eventLoopBackpressured, false);
  assert.equal(budget.maxConcurrency, 4);
  assert.equal(budget.maxDispatchedTaskCount, 8);
  assert.equal(budget.dispatchBudgetMs, 1150);
});
```

- [ ] **Step 2: 新增预算函数**

Modify `server/src/services/onlineBattleSettlementDrainPolicy.ts`:

```ts
export type OnlineBattleSettlementDispatchBudget = {
  eventLoopBackpressured: boolean;
  maxConcurrency: number;
  maxDispatchedTaskCount: number;
  dispatchBudgetMs: number;
};

export const resolveOnlineBattleSettlementDispatchBudget = (params: {
  drainAll: boolean;
  baseMaxConcurrency: number;
  baseMaxDispatchedTaskCount: number;
  tickBudgetMs: number;
  drainTailReserveMs: number;
  eventLoopUtilization?: number;
  eventLoopDelayP95Ms?: number;
}): OnlineBattleSettlementDispatchBudget => {
  const baseDispatchBudgetMs = Math.max(0, params.tickBudgetMs - params.drainTailReserveMs);
  if (params.drainAll) {
    return {
      eventLoopBackpressured: false,
      maxConcurrency: params.baseMaxConcurrency,
      maxDispatchedTaskCount: params.baseMaxDispatchedTaskCount,
      dispatchBudgetMs: baseDispatchBudgetMs,
    };
  }

  const utilization = Number(params.eventLoopUtilization ?? 0);
  const p95DelayMs = Number(params.eventLoopDelayP95Ms ?? 0);
  if (utilization >= 0.85 || p95DelayMs >= 80) {
    return {
      eventLoopBackpressured: true,
      maxConcurrency: 1,
      maxDispatchedTaskCount: 1,
      dispatchBudgetMs: Math.min(baseDispatchBudgetMs, 250),
    };
  }

  if (utilization >= 0.7 || p95DelayMs >= 40) {
    return {
      eventLoopBackpressured: true,
      maxConcurrency: Math.min(params.baseMaxConcurrency, 2),
      maxDispatchedTaskCount: Math.min(params.baseMaxDispatchedTaskCount, 2),
      dispatchBudgetMs: Math.min(baseDispatchBudgetMs, 500),
    };
  }

  return {
    eventLoopBackpressured: false,
    maxConcurrency: params.baseMaxConcurrency,
    maxDispatchedTaskCount: params.baseMaxDispatchedTaskCount,
    dispatchBudgetMs: baseDispatchBudgetMs,
  };
};
```

Update existing policy call to accept `dispatchBudgetMs`:

```ts
export const shouldContinueOnlineBattleSettlementDispatch = (params: {
  drainAll: boolean;
  elapsedMs: number;
  dispatchedTaskCount: number;
  dispatchBudgetMs: number;
  maxDispatchedTaskCount: number;
}): boolean => {
  if (params.drainAll) return true;
  if (params.dispatchedTaskCount >= params.maxDispatchedTaskCount) return false;
  return params.elapsedMs < params.dispatchBudgetMs;
};
```

- [ ] **Step 3: runner 使用预算**

Modify `server/src/services/onlineBattleSettlementRunner.ts` imports:

```ts
import { getLatestEventLoopHealthSnapshot } from './eventLoopMonitorService.js';
import {
  resolveOnlineBattleSettlementDispatchBudget,
  shouldContinueOnlineBattleSettlementDispatch,
} from './onlineBattleSettlementDrainPolicy.js';
```

Inside `tick`, before `createSlowOperationLogger`:

```ts
const eventLoopSnapshot = getLatestEventLoopHealthSnapshot();
const dispatchBudget = resolveOnlineBattleSettlementDispatchBudget({
  drainAll: options?.drainAll === true,
  baseMaxConcurrency: MAX_CONCURRENT_SETTLEMENT_TASKS,
  baseMaxDispatchedTaskCount: MAX_SETTLEMENT_TASKS_PER_TICK,
  tickBudgetMs: RUNNER_INTERVAL_MS,
  drainTailReserveMs: SETTLEMENT_TICK_DRAIN_TAIL_RESERVE_MS,
  eventLoopUtilization: eventLoopSnapshot?.utilization,
  eventLoopDelayP95Ms: eventLoopSnapshot?.p95DelayMs,
});
```

Add slow logger fields:

```ts
eventLoopBackpressured: dispatchBudget.eventLoopBackpressured,
eventLoopUtilization: eventLoopSnapshot?.utilization,
eventLoopDelayP95Ms: eventLoopSnapshot?.p95DelayMs,
maxConcurrency: dispatchBudget.maxConcurrency,
dispatchBudgetMs: dispatchBudget.dispatchBudgetMs,
maxDispatchedTaskCount: dispatchBudget.maxDispatchedTaskCount,
```

Replace loop budget usage:

```ts
const availableSlots = dispatchBudget.maxConcurrency - activePromises.size;
```

Replace `shouldContinueOnlineBattleSettlementDispatch` call:

```ts
shouldContinueOnlineBattleSettlementDispatch({
  drainAll: options?.drainAll === true,
  elapsedMs: Date.now() - drainStartedAt,
  dispatchedTaskCount,
  dispatchBudgetMs: dispatchBudget.dispatchBudgetMs,
  maxDispatchedTaskCount: dispatchBudget.maxDispatchedTaskCount,
})
```

- [ ] **Step 4: 校验**

Run: `tsc -b`  
Expected: PASS。

---

### Task 2: `/inventory/use` 成功响应不等待 Socket 角色刷新

**Files:**
- Modify: `server/src/middleware/pushUpdate.ts`
- Modify: `server/src/routes/inventoryRoutes.ts`
- Test: `server/src/services/__tests__/inventoryUseResponsePolicy.test.ts`

- [ ] **Step 1: 写响应策略静态测试**

Create `server/src/services/__tests__/inventoryUseResponsePolicy.test.ts`:

```ts
/**
 * inventory/use 成功响应策略回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定 `/inventory/use` 成功后先发送响应，再异步调度角色刷新推送。
 * 2. 做什么：避免 Socket 推送耗时进入用户 HTTP 响应总耗时。
 * 3. 不做什么：不验证具体道具效果，不启动 Express。
 *
 * 输入 / 输出：
 * - 输入：inventoryRoutes.ts 源码文本。
 * - 输出：静态顺序断言。
 *
 * 数据流 / 状态流：
 * itemService.useItem -> sendSuccess HTTP 响应 -> scheduleSafeCharacterUpdate 异步补推。
 *
 * 复用设计说明：
 * - 把异步推送封装到 middleware/pushUpdate，其他成功后只需补推角色的接口可复用同一入口。
 *
 * 关键边界条件与坑点：
 * 1. `partnerReboneJob` 投递失败分支仍需同步处理回滚和失败响应，不能异步吞掉。
 * 2. 成功响应已携带 `character` 快照，Socket 推送只是多端同步补偿，不应阻塞当前请求。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../../routes/inventoryRoutes.ts', import.meta.url), 'utf8');

test('inventory/use 成功路径应先响应再调度角色刷新', () => {
  const routeStart = source.indexOf("router.post('/use'");
  assert.notEqual(routeStart, -1, '缺少 /inventory/use 路由');
  const routeEnd = source.indexOf('\n}));', routeStart);
  const routeSource = source.slice(routeStart, routeEnd);

  const sendSuccessIndex = routeSource.indexOf('sendSuccess(res, {');
  const scheduleIndex = routeSource.indexOf('scheduleSafeCharacterUpdate(userId);');

  assert.ok(sendSuccessIndex > 0, '成功路径必须发送响应');
  assert.ok(scheduleIndex > sendSuccessIndex, '角色刷新必须在成功响应之后调度');
  assert.doesNotMatch(routeSource, /await safePushCharacterUpdate\(userId\);\s*return sendSuccess/u);
});
```

- [ ] **Step 2: 增加异步推送工具**

Modify `server/src/middleware/pushUpdate.ts`:

```ts
export const scheduleSafeCharacterUpdate = (userId: number): void => {
  setImmediate(() => {
    void safePushCharacterUpdate(userId);
  });
};
```

- [ ] **Step 3: 修改 `/inventory/use` 成功路径**

Modify import in `server/src/routes/inventoryRoutes.ts`:

```ts
import { safePushCharacterUpdate, scheduleSafeCharacterUpdate } from '../middleware/pushUpdate.js';
```

Replace success tail:

```ts
    const responseData = {
      character: result.character,
      lootResults: result.lootResults,
      partnerTechniqueResult: result.partnerTechniqueResult,
    };

    sendSuccess(res, responseData);
    scheduleSafeCharacterUpdate(userId);
    return;
```

Keep failure and `partnerReboneJob` error branches unchanged.

- [ ] **Step 4: 校验**

Run: `tsc -b`  
Expected: PASS。

---

### Task 3: 战斗掉落先聚合再发放

**Files:**
- Create: `server/src/services/battleDropGrantUnit.ts`
- Modify: `server/src/services/battleDropService.ts`
- Test: `server/src/services/__tests__/battleDropGrantUnit.test.ts`
- Test: `server/src/services/__tests__/battleDropServiceSlowLogging.test.ts`

- [ ] **Step 1: 写掉落聚合纯函数测试**

Create `server/src/services/__tests__/battleDropGrantUnit.test.ts`:

```ts
/**
 * 战斗掉落发放单元聚合测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定普通非装备掉落在同角色、同物品、同绑定类型下合并数量。
 * 2. 做什么：锁定装备掉落保持逐件发放，避免改变装备生成随机性。
 * 3. 不做什么：不调用 itemService，不连接数据库，不验证掉落概率。
 *
 * 输入 / 输出：
 * - 输入：战斗掉落条目及其静态分类。
 * - 输出：发放单元数组。
 *
 * 数据流 / 状态流：
 * plan.drops -> buildBattleDropGrantUnits -> battleDropService 顺序调用发奖服务。
 *
 * 复用设计说明：
 * - 聚合规则集中到纯函数，战斗结算和后续秘境结算都能复用，不在事务循环里散落判断。
 *
 * 关键边界条件与坑点：
 * 1. 装备不可合并，否则会把逐件品质/词缀/福缘随机压成一次。
 * 2. 不同 receiver 或 bindType 不可合并，否则归属和绑定状态会错。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBattleDropGrantUnits } from '../battleDropGrantUnit.js';

test('普通非装备掉落应按角色、物品和绑定类型合并', () => {
  const units = buildBattleDropGrantUnits([
    {
      receiverCharacterId: 1001,
      receiverUserId: 101,
      receiverFuyuan: 1,
      itemDefId: 'material_herb',
      quantity: 1,
      bindType: 'bound',
      category: 'material',
    },
    {
      receiverCharacterId: 1001,
      receiverUserId: 101,
      receiverFuyuan: 1,
      itemDefId: 'material_herb',
      quantity: 2,
      bindType: 'bound',
      category: 'material',
    },
  ]);

  assert.equal(units.length, 1);
  assert.equal(units[0]?.quantity, 3);
  assert.equal(units[0]?.sourceDropCount, 2);
});

test('装备掉落必须保持逐件发放', () => {
  const units = buildBattleDropGrantUnits([
    {
      receiverCharacterId: 1001,
      receiverUserId: 101,
      receiverFuyuan: 8,
      itemDefId: 'weapon_test_blade',
      quantity: 1,
      bindType: 'bound',
      category: 'equipment',
    },
    {
      receiverCharacterId: 1001,
      receiverUserId: 101,
      receiverFuyuan: 8,
      itemDefId: 'weapon_test_blade',
      quantity: 1,
      bindType: 'bound',
      category: 'equipment',
    },
  ]);

  assert.equal(units.length, 2);
  assert.deepEqual(units.map((unit) => unit.quantity), [1, 1]);
});
```

- [ ] **Step 2: 新增聚合模块**

Create `server/src/services/battleDropGrantUnit.ts`:

```ts
/**
 * 战斗掉落发放单元构建器
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把战斗掉落列表聚合成更少的发放单元，降低事务内 createItem 调用次数。
 * 2. 做什么：只合并普通非装备掉落，装备保持逐件发放以保留随机性。
 * 3. 不做什么：不读取静态配置，不调用数据库，不决定自动分解规则。
 *
 * 输入 / 输出：
 * - 输入：带静态 category 的掉落条目。
 * - 输出：发放单元数组，保持首次出现顺序。
 *
 * 数据流 / 状态流：
 * battle reward plan drops -> service 先解析 item meta -> 本模块聚合 -> 发奖事务逐单元处理。
 *
 * 复用设计说明：
 * - 聚合规则集中在单文件，避免 battleDropService 主事务继续膨胀。
 * - sourceDropCount 进入慢日志后可对比“原始掉落数”和“发放单元数”。
 *
 * 关键边界条件与坑点：
 * 1. 只有非 equipment 且无 qualityWeights 的掉落可合并。
 * 2. 合并 key 必须包含 receiverCharacterId、receiverUserId、itemDefId、bindType，不能跨角色或跨绑定状态合并。
 */

export type BattleDropGrantInput = {
  receiverCharacterId: number;
  receiverUserId: number;
  receiverFuyuan: number;
  itemDefId: string;
  quantity: number;
  bindType: string;
  category: string;
  qualityWeights?: Record<string, number>;
};

export type BattleDropGrantUnit = BattleDropGrantInput & {
  sourceDropCount: number;
};

const buildAggregatableDropKey = (drop: BattleDropGrantInput): string | null => {
  if (drop.category === 'equipment') return null;
  if (drop.qualityWeights) return null;
  return [
    drop.receiverCharacterId,
    drop.receiverUserId,
    drop.itemDefId,
    drop.bindType,
  ].join('|');
};

export const buildBattleDropGrantUnits = (
  drops: readonly BattleDropGrantInput[],
): BattleDropGrantUnit[] => {
  const units: BattleDropGrantUnit[] = [];
  const unitIndexByKey = new Map<string, number>();

  for (const drop of drops) {
    const key = buildAggregatableDropKey(drop);
    if (!key) {
      units.push({ ...drop, sourceDropCount: 1 });
      continue;
    }

    const existingIndex = unitIndexByKey.get(key);
    if (existingIndex === undefined) {
      unitIndexByKey.set(key, units.length);
      units.push({ ...drop, sourceDropCount: 1 });
      continue;
    }

    const existingUnit = units[existingIndex];
    if (!existingUnit) continue;
    units[existingIndex] = {
      ...existingUnit,
      quantity: existingUnit.quantity + drop.quantity,
      sourceDropCount: existingUnit.sourceDropCount + 1,
    };
  }

  return units;
};
```

- [ ] **Step 3: battleDropService 使用聚合单元**

Modify `server/src/services/battleDropService.ts`:

```ts
import { buildBattleDropGrantUnits, type BattleDropGrantInput } from './battleDropGrantUnit.js';
```

Before the grant loop:

```ts
const grantInputs: BattleDropGrantInput[] = [];
for (const drop of plan.drops) {
  const receiverCharacterId = Number(drop.receiverCharacterId);
  if (!Number.isInteger(receiverCharacterId) || receiverCharacterId <= 0) {
    console.warn(`奖励分发跳过：非法角色ID ${String(drop.receiverCharacterId)}`);
    continue;
  }
  const sourceMeta = this.getRewardItemMeta(drop.itemDefId);
  grantInputs.push({
    receiverCharacterId,
    receiverUserId: drop.receiverUserId,
    receiverFuyuan: drop.receiverFuyuan,
    itemDefId: drop.itemDefId,
    quantity: drop.quantity,
    bindType: drop.bindType,
    category: sourceMeta.category,
    ...(drop.qualityWeights ? { qualityWeights: drop.qualityWeights } : {}),
  });
}
const grantUnits = buildBattleDropGrantUnits(grantInputs);
```

Then iterate `for (const drop of grantUnits)` and add slow log fields:

```ts
rawDropCount: plan.drops.length,
grantUnitCount: grantUnits.length,
mergedDropCount: plan.drops.length - grantUnits.length,
```

- [ ] **Step 4: 校验**

Run: `tsc -b`  
Expected: PASS。

---

### Task 4: `/inventory/use` 内部阶段打点与 loot 聚合

**Files:**
- Modify: `server/src/services/itemService.ts`
- Test: `server/src/services/__tests__/itemUseLootAggregationPolicy.test.ts`

- [ ] **Step 1: 写静态测试**

Create `server/src/services/__tests__/itemUseLootAggregationPolicy.test.ts`:

```ts
/**
 * itemService.useItem loot 聚合策略测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定使用道具产生的 loot item 在 buffer 前按 itemDefId 聚合。
 * 2. 做什么：锁定 useItem 有慢日志阶段，能区分慢在锁、效果解析、奖励缓冲还是角色刷新。
 * 3. 不做什么：不连接数据库，不执行真实物品使用。
 *
 * 输入 / 输出：
 * - 输入：itemService.ts 源码文本。
 * - 输出：静态结构断言。
 *
 * 数据流 / 状态流：
 * effect_defs -> lootItemsToAdd -> aggregateItemUseLootItems -> bufferSimpleCharacterItemGrants。
 *
 * 复用设计说明：
 * - 聚合函数后续可给礼包、宝石袋、随机资源包共用，避免每个 effect 分支重复 Map 累加逻辑。
 *
 * 关键边界条件与坑点：
 * 1. 聚合只按 itemDefId 合并数量，不能改动货币和学习功法结果。
 * 2. 慢日志不能包住整个 HTTP 路由，只覆盖 useItem 服务内部阶段，避免和路由慢日志重复。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../itemService.ts', import.meta.url), 'utf8');

test('useItem 应在 bufferSimpleCharacterItemGrants 前聚合 loot item', () => {
  assert.match(source, /const aggregateItemUseLootItems = \(/u);
  assert.match(source, /const aggregatedLootItemsToAdd = aggregateItemUseLootItems\(lootItemsToAdd\);/u);
  assert.match(source, /bufferSimpleCharacterItemGrants\(\s*characterId,\s*userId,\s*aggregatedLootItemsToAdd\.map/u);
});

test('useItem 应输出分段慢日志', () => {
  assert.match(source, /label: 'itemService.useItem'/u);
  assert.match(source, /slowLogger\.mark\('lockInventoryMutex'/u);
  assert.match(source, /slowLogger\.mark\('bufferLootItems'/u);
  assert.match(source, /slowLogger\.mark\('loadUpdatedCharacter'/u);
});
```

- [ ] **Step 2: 新增 loot 聚合函数**

Add near helper functions in `server/src/services/itemService.ts`:

```ts
type ItemUseLootItem = {
  itemDefId: string;
  qty: number;
};

const aggregateItemUseLootItems = (
  lootItems: readonly ItemUseLootItem[],
): ItemUseLootItem[] => {
  const qtyByItemDefId = new Map<string, number>();
  for (const lootItem of lootItems) {
    const itemDefId = lootItem.itemDefId.trim();
    const qty = Math.max(0, Math.floor(Number(lootItem.qty) || 0));
    if (!itemDefId || qty <= 0) continue;
    qtyByItemDefId.set(itemDefId, (qtyByItemDefId.get(itemDefId) ?? 0) + qty);
  }
  return [...qtyByItemDefId.entries()].map(([itemDefId, qty]) => ({ itemDefId, qty }));
};
```

- [ ] **Step 3: useItem 使用聚合结果并补慢日志**

At beginning of `useItem`:

```ts
const slowLogger = createSlowOperationLogger({
  label: 'itemService.useItem',
  thresholdMs: 200,
  fields: {
    characterId,
    itemInstanceId: instanceId,
    qty,
  },
});
let success = false;
```

After inventory mutex:

```ts
slowLogger.mark('lockInventoryMutex');
```

Before buffering loot:

```ts
const aggregatedLootItemsToAdd = aggregateItemUseLootItems(lootItemsToAdd);
slowLogger.mark('aggregateLootItems', {
  rawLootItemCount: lootItemsToAdd.length,
  aggregatedLootItemCount: aggregatedLootItemsToAdd.length,
});
```

Replace buffer input:

```ts
if (aggregatedLootItemsToAdd.length > 0) {
  await bufferSimpleCharacterItemGrants(
    characterId,
    userId,
    aggregatedLootItemsToAdd.map((lootItem) => ({
      itemDefId: lootItem.itemDefId,
      qty: lootItem.qty,
      obtainedFrom: `use_item:${itemDef.id}`,
    })),
  );
}
slowLogger.mark('bufferLootItems', {
  lootItemCount: aggregatedLootItemsToAdd.length,
});
```

Before final return:

```ts
slowLogger.mark('loadUpdatedCharacter');
success = true;
```

In `finally`:

```ts
finally {
  slowLogger.flush({ success });
}
```

- [ ] **Step 4: 校验**

Run: `tsc -b`  
Expected: PASS。

---

### Task 5: 坊市公开列表限制单响应大小

**Files:**
- Modify: `server/src/services/marketService.ts`
- Modify: `server/src/services/partnerMarketService.ts`
- Test: `server/src/services/__tests__/marketListingPageSizePolicy.test.ts`

- [ ] **Step 1: 写 pageSize 策略测试**

Create `server/src/services/__tests__/marketListingPageSizePolicy.test.ts`:

```ts
/**
 * 坊市公开列表 pageSize 策略测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定物品坊市和伙伴坊市公开列表最大 pageSize 为 40。
 * 2. 做什么：避免单响应携带 100 条装备/伙伴详情导致 JSON 序列化占满事件循环。
 * 3. 不做什么：不验证 SQL 查询结果，不连接数据库。
 *
 * 输入 / 输出：
 * - 输入：marketService.ts 和 partnerMarketService.ts 源码文本。
 * - 输出：静态断言。
 *
 * 数据流 / 状态流：
 * route query pageSize -> service normalize query -> clamp 到公开列表上限 -> cache key。
 *
 * 复用设计说明：
 * - 将上限作为模块级常量，避免 normalize 和测试各写魔法数字。
 *
 * 关键边界条件与坑点：
 * 1. 只限制公开列表，不影响 my-listings 和 records 的内部管理页。
 * 2. cache key 必须使用 clamp 后的 pageSize，避免同一页产生多个缓存 key。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('物品坊市公开列表 pageSize 最大值应为 40', () => {
  const source = readFileSync(new URL('../marketService.ts', import.meta.url), 'utf8');
  assert.match(source, /const MARKET_PUBLIC_LISTINGS_PAGE_SIZE_MAX = 40;/u);
  assert.match(source, /pageSize: clampInt\(parsePositiveInt\(params\.pageSize\) \?\? 20, 1, MARKET_PUBLIC_LISTINGS_PAGE_SIZE_MAX\)/u);
});

test('伙伴坊市公开列表 pageSize 最大值应为 40', () => {
  const source = readFileSync(new URL('../partnerMarketService.ts', import.meta.url), 'utf8');
  assert.match(source, /const PARTNER_MARKET_PUBLIC_LISTINGS_PAGE_SIZE_MAX = 40;/u);
  assert.match(source, /pageSize: clampInt\(parsePositiveInt\(params\.pageSize\) \?\? 20, 1, PARTNER_MARKET_PUBLIC_LISTINGS_PAGE_SIZE_MAX\)/u);
});
```

- [ ] **Step 2: 修改物品坊市公开列表上限**

Modify `server/src/services/marketService.ts`:

```ts
const MARKET_PUBLIC_LISTINGS_PAGE_SIZE_MAX = 40;
```

Replace in `normalizeMarketListingsQuery`:

```ts
pageSize: clampInt(parsePositiveInt(params.pageSize) ?? 20, 1, MARKET_PUBLIC_LISTINGS_PAGE_SIZE_MAX),
```

- [ ] **Step 3: 修改伙伴坊市公开列表上限**

Modify `server/src/services/partnerMarketService.ts`:

```ts
const PARTNER_MARKET_PUBLIC_LISTINGS_PAGE_SIZE_MAX = 40;
```

Replace in `normalizePartnerListingsQuery`:

```ts
pageSize: clampInt(parsePositiveInt(params.pageSize) ?? 20, 1, PARTNER_MARKET_PUBLIC_LISTINGS_PAGE_SIZE_MAX),
```

- [ ] **Step 4: 校验**

Run: `tsc -b`  
Expected: PASS。

---

### Task 6: 拆分运行角色，为独立 settlement worker 做准备

**Files:**
- Create: `server/src/config/runtimeRole.ts`
- Modify: `server/src/bootstrap/startupPipeline.ts`
- Test: `server/src/services/__tests__/startupRuntimeRolePolicy.test.ts`

- [ ] **Step 1: 写运行角色策略测试**

Create `server/src/services/__tests__/startupRuntimeRolePolicy.test.ts`:

```ts
/**
 * 服务运行角色启动策略测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定 API 角色不启动在线战斗延迟结算 runner。
 * 2. 做什么：锁定 worker 角色不监听 HTTP 端口。
 * 3. 不做什么：不启动真实服务，不修改 Docker Swarm。
 *
 * 输入 / 输出：
 * - 输入：runtimeRole.ts 和 startupPipeline.ts 源码文本。
 * - 输出：静态断言。
 *
 * 数据流 / 状态流：
 * JIUZHOU_RUNTIME_ROLE -> runtimeRole helpers -> startupPipeline 按角色启动 HTTP 或后台任务。
 *
 * 复用设计说明：
 * - 用单一 runtimeRole 模块集中解释环境变量，避免 startupPipeline 各处直接解析字符串。
 *
 * 关键边界条件与坑点：
 * 1. 默认 all 保持当前单服务行为，降低部署切换风险。
 * 2. worker 角色仍需数据库、Redis、事件循环监控和必要静态配置预热，但不能接受 HTTP 流量。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('runtimeRole 应定义 all/api/worker 三种运行角色', () => {
  const source = readFileSync(new URL('../../config/runtimeRole.ts', import.meta.url), 'utf8');
  assert.match(source, /export type JiuzhouRuntimeRole = 'all' \| 'api' \| 'worker';/u);
  assert.match(source, /export const shouldStartHttpServer/u);
  assert.match(source, /export const shouldStartOnlineSettlementRunner/u);
});

test('startupPipeline 应按运行角色控制 HTTP 与在线结算 runner', () => {
  const source = readFileSync(new URL('../../bootstrap/startupPipeline.ts', import.meta.url), 'utf8');
  assert.match(source, /if \(shouldStartOnlineSettlementRunner\(runtimeRole\)\) \{/u);
  assert.match(source, /if \(shouldStartHttpServer\(runtimeRole\)\) \{/u);
});
```

- [ ] **Step 2: 新增 runtimeRole 模块**

Create `server/src/config/runtimeRole.ts`:

```ts
/**
 * 服务运行角色配置
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中解释 `JIUZHOU_RUNTIME_ROLE`，用于拆分 HTTP API 进程与后台 worker 进程。
 * 2. 做什么：提供启动流水线可读的布尔判断，避免各处直接比较字符串。
 * 3. 不做什么：不读取 Docker service 配置，不修改端口，不决定副本数量。
 *
 * 输入 / 输出：
 * - 输入：环境变量 `JIUZHOU_RUNTIME_ROLE`。
 * - 输出：`all | api | worker` 之一，以及启动决策函数。
 *
 * 数据流 / 状态流：
 * process.env -> resolveJiuzhouRuntimeRole -> startupPipeline -> 按角色启动 HTTP 或后台任务。
 *
 * 复用设计说明：
 * - 运行角色是部署级高频变化点，集中在 config 模块后，后续新增 worker 类型不需要散改 startupPipeline。
 *
 * 关键边界条件与坑点：
 * 1. 默认必须是 `all`，保持当前部署行为。
 * 2. 非法值必须回落到 `all`，避免环境变量写错导致服务不监听或后台任务不跑。
 */

export type JiuzhouRuntimeRole = 'all' | 'api' | 'worker';

export const resolveJiuzhouRuntimeRole = (): JiuzhouRuntimeRole => {
  const role = String(process.env.JIUZHOU_RUNTIME_ROLE ?? '').trim();
  if (role === 'api' || role === 'worker' || role === 'all') return role;
  return 'all';
};

export const shouldStartHttpServer = (role: JiuzhouRuntimeRole): boolean => {
  return role === 'all' || role === 'api';
};

export const shouldStartOnlineSettlementRunner = (role: JiuzhouRuntimeRole): boolean => {
  return role === 'all' || role === 'worker';
};

export const shouldStartGeneralBackgroundWorkers = (role: JiuzhouRuntimeRole): boolean => {
  return role === 'all' || role === 'worker';
};
```

- [ ] **Step 3: startupPipeline 使用运行角色**

Modify `server/src/bootstrap/startupPipeline.ts` imports:

```ts
import {
  resolveJiuzhouRuntimeRole,
  shouldStartGeneralBackgroundWorkers,
  shouldStartHttpServer,
  shouldStartOnlineSettlementRunner,
} from '../config/runtimeRole.js';
```

At start of `startServerWithPipeline`:

```ts
const runtimeRole = resolveJiuzhouRuntimeRole();
console.log(`运行角色: ${runtimeRole}`);
```

Wrap online settlement runner:

```ts
if (shouldStartOnlineSettlementRunner(runtimeRole)) {
  await runStartupStep("在线战斗延迟结算协调器初始化", initializeOnlineBattleSettlementRunner);
  console.log("✓ 在线战斗延迟结算协调器已就绪\n");
}
```

Wrap non-essential background worker coordinators:

```ts
if (shouldStartGeneralBackgroundWorkers(runtimeRole)) {
  await runStartupStep("洞府研修 worker 协调器初始化", initializeTechniqueGenerationJobRunner);
  await runStartupStep("AI 伙伴招募 worker 协调器初始化", initializePartnerRecruitJobRunner);
  await runStartupStep("三魂归契 worker 协调器初始化", initializePartnerFusionJobRunner);
  await runStartupStep("归元洗髓 worker 协调器初始化", initializePartnerReboneJobRunner);
  await runStartupStep("云游奇遇 worker 协调器初始化", initializeWanderJobRunner);
}
```

Wrap HTTP listen:

```ts
if (shouldStartHttpServer(runtimeRole)) {
  await new Promise<void>((resolve, reject) => {
    options.httpServer.listen(options.port, options.host, () => {
      console.log(`🚀 服务已启动: http://${options.host}:${options.port} (或 http://localhost:${options.port})\n`);
      resolve();
    });
    options.httpServer.once("error", reject);
  });
} else {
  console.log("✓ Worker 角色不监听 HTTP 端口\n");
}
```

- [ ] **Step 4: 校验**

Run: `tsc -b`  
Expected: PASS。

---

## 验收标准

- `onlineBattleSettlementRunner.tick` 慢日志出现 `eventLoopBackpressured`、`eventLoopUtilization`、`eventLoopDelayP95Ms`、动态 `maxConcurrency`。
- 事件循环忙时，常规 tick 每轮最多补派 1 个结算任务；`flush({ drainAll: true })` 不受影响。
- `/api/inventory/use` 成功路径不再等待 `safePushCharacterUpdate` 才返回。
- `battleDropService.settleBattleRewardPlan` 慢日志出现 `rawDropCount`、`grantUnitCount`、`mergedDropCount`。
- 物品/伙伴坊市公开列表 pageSize 最大 40，慢请求中的 `contentLength` 明显下降。
- `tsc -b` 成功。

## 线上复查命令

```bash
docker logs --since 5m <jiuzhou_server_container_id> 2>&1 \
  | perl -pe 's/\e\[[0-9;]*m//g' \
  | awk '
    /http.slow-request/ {slow_http++}
    /"kind":"event_loop_busy"/ {event_loop++}
    /onlineBattleSettlementRunner.tick/ {runner_tick++}
    /battleDropService.settleBattleRewardPlan/ {battle_drop++}
    END {
      print "slow_http", slow_http+0;
      print "event_loop_busy", event_loop+0;
      print "runner_tick", runner_tick+0;
      print "battle_drop", battle_drop+0;
    }'
```

Expected after Tasks 1-5 deploy:
- `event_loop_busy` 次数下降。
- `/api/inventory/use` 平均慢请求耗时下降。
- `onlineBattleSettlementRunner.tick` 不再出现 5 秒级常规 tick。
- `market/listings` 和 `partner-listings` 的 `contentLength` 降到当前高峰的一半以下。

## 暂不做

- 不直接把 `jiuzhou_server` 副本数扩大到多副本。当前存在进程内用户槽位、Socket 推送和多个后台 runner，必须先通过 Task 6 拆运行角色。
- 不直接把所有 `itemService.createItem` 改成一条大 SQL。装备生成、自动分解和槽位分配规则复杂，先聚合普通非装备掉落，保留行为边界。
- 不改数据库参数。当前没有锁等待堆积，也不是整机 IO 饱和。
- 不把 `/inventory/items` 直接砍字段。先处理已确认的 `/inventory/use` 和公开市场大响应；背包列表瘦身需要结合前端 tooltip 交互单独拆计划。

## Self-Review

- Spec coverage：覆盖了新线上证据中的事件循环拥塞、战斗结算、掉落发奖、`inventory/use` 同步等待和市场/伙伴大响应。
- Placeholder scan：未发现禁用占位词；每个任务都有明确文件、测试和实现片段。
- Type consistency：新增类型只使用明确结构；未引入 `any` 或新的 `unknown`；运行角色、反压预算、掉落发放单元均有单一入口。
