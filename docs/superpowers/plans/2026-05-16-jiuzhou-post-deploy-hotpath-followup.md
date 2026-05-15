# Jiuzhou Post-Deploy Hotpath Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 2026-05-16 线上复查仍存在的单 Node 事件循环拥塞继续拆开，先让 API 与后台 worker 分角色运行，再压低自动分解、`/inventory/use` 和大响应接口的同步成本。

**Architecture:** 第一优先级是部署隔离：`server` 服务只做 API，新增 `server_worker` 承担在线结算与后台任务，避免后台结算继续占用玩家 HTTP 的 event loop。第二优先级是热路径收敛：自动分解奖励按物品聚合后批量入包，`useItem` 对简单消耗品不再强制重载完整角色，市场/背包/伙伴列表改用列表级瘦身 DTO，详情按需加载。

**Tech Stack:** Docker Swarm、Node.js、TypeScript、Express、PostgreSQL、Redis、React、Axios、node:test 静态策略测试。

---

## 线上证据

- `jiuzhou_server` 仍是 `1/1` 副本，容器环境没有 `JIUZHOU_RUNTIME_ROLE`，运行角色仍是默认 `all`。
- 整机资源仍空：104 CPU 线程，内存可用约 214GiB，IO wait 接近 0。
- 最近 5 分钟：`slow_http=203`、`event_loop_busy=56`、event loop 平均利用率 `0.87`、最大 p95 delay `196.7ms`。
- 慢操作：
  - `onlineBattleSettlementRunner.executeTask`：37 次，平均 `1038ms`。
  - `battleDropService.settleBattleRewardPlan`：36 次，平均 `963ms`。
  - `itemService.useItem`：27 次，平均 `738ms`。
  - `characterItemGrant.flush.phase1`：12 次，平均 `508ms`。
- `battleDropService` 的新字段显示：`rawDropCount == grantUnitCount`，`totalMergedDrop=0`。这轮实际慢点不是普通非装备重复掉落，而是装备/自动分解发奖。
- `itemService.useItem` 的新字段显示：`bufferLootItems` 基本 `0~1ms`，慢点主要在首次阶段和 `loadUpdatedCharacter`。
- 大响应仍明显：`/api/partner/overview` 最大 `233545` 字节，`/api/inventory/items` 最大 `216125` 字节，`/api/market/partner-listings` 最大 `146006` 字节。

## 当前约束

- 未经用户明确要求，不执行任何 Git 命令，包括 `git status`、`git diff`、`git commit`。
- 未经用户明确要求，不执行 dev/start/build/test/联调命令。
- 代码修改后必须执行：

```powershell
.\node_modules\.bin\tsc.cmd -b
```

- 本计划中的测试文件用于回归保护。执行阶段如未获授权，只写测试并运行 `tsc -b`。

## 文件结构

- Modify: `docker-stack.yml`  
  把现有 `server` 固定为 API 角色，新增无端口的 `server_worker` 角色。
- Modify: `server/src/config/runtimeRole.ts`  
  增加更细粒度的启动角色判断，避免 API 角色继续启动 worker pool、定时器、在线结算和恢复型后台任务。
- Modify: `server/src/bootstrap/startupPipeline.ts`  
  按运行角色包住 worker pool、后台协调器、在线结算、定时任务、战斗/挂机恢复和 HTTP 监听。
- Test: `server/src/services/__tests__/dockerStackRuntimeRolePolicy.test.ts`  
  静态锁定 Swarm 服务拆分。
- Test: `server/src/services/__tests__/startupRuntimeRolePolicy.test.ts`  
  扩展现有运行角色策略测试。
- Create: `server/src/services/autoDisassembleRewardBatch.ts`  
  自动分解奖励聚合工具，把同一发奖调用内的分解产物按 `itemDefId` 聚合。
- Modify: `server/src/services/autoDisassembleRewardService.ts`  
  装备自动分解路径先聚合分解产物，再批量调用 `createItem`。
- Test: `server/src/services/__tests__/autoDisassembleRewardBatch.test.ts`  
  纯函数测试聚合顺序、数量、失败回退边界。
- Modify: `server/src/services/itemService.ts`  
  拆准 `useItem` 阶段打点，并对无需重算派生属性的简单消耗品使用内存合成角色快照。
- Test: `server/src/services/__tests__/itemUseFastCharacterSnapshotPolicy.test.ts`  
  静态测试锁定简单消耗品不强制走 `bypassStaticCache` 重载。
- Modify: `server/src/routes/inventoryRoutes.ts`  
  增加市场上架专用背包候选列表入口，避免市场弹窗请求完整 `/inventory/items?pageSize=200`。
- Modify: `server/src/services/inventory/itemQuery.ts`  
  增加瘦身候选 DTO，只返回上架选择所需字段。
- Modify: `client/src/services/api/inventory.ts`  
  增加 `getInventorySaleCandidates` API 类型。
- Modify: `client/src/pages/Game/modules/MarketModal/index.tsx`  
  市场上架背包列表改用瘦身候选接口。
- Modify: `server/src/services/partnerMarketService.ts`  
  公开伙伴坊市列表返回 summary DTO，不再把完整 `PartnerDisplayDto.techniques` 全量带入列表。
- Modify: `client/src/services/api/market-mail.ts`  
  区分伙伴列表 summary 与详情 DTO。
- Modify: `client/src/pages/Game/modules/MarketModal/index.tsx`  
  列表使用 summary，打开预览时按 listingId 拉详情。
- Test: `server/src/services/__tests__/marketListPayloadPolicy.test.ts`  
  静态锁定公开列表不返回完整伙伴功法数组。

---

### Task 1: Docker Swarm 拆分 API 与 Worker 服务

**Files:**
- Modify: `docker-stack.yml`
- Test: `server/src/services/__tests__/dockerStackRuntimeRolePolicy.test.ts`

- [ ] **Step 1: 写 Swarm 角色策略静态测试**

Create `server/src/services/__tests__/dockerStackRuntimeRolePolicy.test.ts`:

```ts
/**
 * Docker Swarm 运行角色拆分策略测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定 `server` 服务只作为 API 角色运行并暴露 6011。
 * 2. 做什么：锁定 `server_worker` 服务作为 worker 角色运行且不暴露 HTTP 端口。
 * 3. 不做什么：不部署 Swarm，不访问 Docker daemon。
 *
 * 输入 / 输出：
 * - 输入：仓库根目录 docker-stack.yml 源码文本。
 * - 输出：静态结构断言。
 *
 * 数据流 / 状态流：
 * docker-stack.yml -> JIUZHOU_RUNTIME_ROLE -> startupPipeline -> API/worker 分别启动不同任务。
 *
 * 复用设计说明：
 * - 部署角色在 stack 文件集中声明，避免线上手工 `docker service update --env-add` 漏配。
 *
 * 关键边界条件与坑点：
 * 1. `client` 的 `API_HOST=server:6011` 依赖服务名 `server`，不能把 API 服务改名。
 * 2. `server_worker` 不能复用 HTTP healthcheck，否则 worker 角色不监听端口会被 Swarm 判定 unhealthy。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../../../../docker-stack.yml', import.meta.url), 'utf8');

test('server 服务必须是 API 角色并暴露 6011', () => {
  assert.match(source, /^\s{2}server:\n[\s\S]*?JIUZHOU_RUNTIME_ROLE=api/u);
  assert.match(source, /^\s{2}server:\n[\s\S]*?-\s+"6011:6011"/u);
  assert.match(source, /API_HOST=server:6011/u);
});

test('server_worker 服务必须是 worker 角色且不暴露 HTTP 端口', () => {
  assert.match(source, /^\s{2}server_worker:\n[\s\S]*?JIUZHOU_RUNTIME_ROLE=worker/u);
  const workerStart = source.indexOf('  server_worker:\n');
  assert.notEqual(workerStart, -1, '缺少 server_worker 服务');
  const nextService = source.indexOf('\n  postgres:', workerStart);
  const workerSource = source.slice(workerStart, nextService);
  assert.doesNotMatch(workerSource, /\n\s+ports:/u);
  assert.doesNotMatch(workerSource, /localhost:6011\/api\/health/u);
});
```

- [ ] **Step 2: 修改 `server` 服务为 API 角色**

In `docker-stack.yml`, in `services.server.environment`, add:

```yaml
      - JIUZHOU_RUNTIME_ROLE=api
```

Keep:

```yaml
    ports:
      - "6011:6011"
```

- [ ] **Step 3: 新增 `server_worker` 服务**

Add after `server` and before `postgres`:

```yaml
  server_worker:
    image: ccr.ccs.tencentyun.com/tcb-100001011660-qtgo/jiuzhou-server:latest
    environment:
      - NODE_ENV=production
      - JIUZHOU_RUNTIME_ROLE=worker
      - DB_HOST=postgres
      - DB_PORT=5432
      - DB_NAME=jiuzhou
      - DB_USER=postgres
      - DB_PASSWORD=${DB_PASSWORD:-postgres}
      - DATABASE_URL=postgresql://postgres:${DB_PASSWORD:-postgres}@postgres:5432/jiuzhou
      - REDIS_URL=redis://redis:6379
      - JWT_SECRET=${JWT_SECRET:-change-me-in-production}
      - JWT_EXPIRES_IN=7d
      - PORT=6011
      - CORS_ORIGIN=${CORS_ORIGIN:-*}
      - IDLE_WORKER_COUNT=${IDLE_WORKER_COUNT:-12}
      - COS_SECRET_ID=${COS_SECRET_ID}
      - COS_SECRET_KEY=${COS_SECRET_KEY}
      - COS_BUCKET=${COS_BUCKET}
      - COS_REGION=${COS_REGION:-ap-guangzhou}
      - COS_AVATAR_PREFIX=${COS_AVATAR_PREFIX:-avatars/}
      - COS_GENERATED_IMAGE_PREFIX=${COS_GENERATED_IMAGE_PREFIX:-generated/}
      - COS_DOMAIN=${COS_DOMAIN}
    volumes:
      - uploads:/app/server/uploads
    networks:
      - jiuzhou_net
    stop_grace_period: 30s
    deploy:
      replicas: 1
      update_config:
        parallelism: 1
        delay: 10s
        order: start-first
        failure_action: rollback
      rollback_config:
        parallelism: 1
        delay: 10s
      restart_policy:
        condition: on-failure
        delay: 10s
        max_attempts: 5
        window: 120s
```

- [ ] **Step 4: 校验**

Run:

```powershell
.\node_modules\.bin\tsc.cmd -b
```

Expected: exit code 0.

---

### Task 2: 启动流水线按角色严格关闭后台任务

**Files:**
- Modify: `server/src/config/runtimeRole.ts`
- Modify: `server/src/bootstrap/startupPipeline.ts`
- Test: `server/src/services/__tests__/startupRuntimeRolePolicy.test.ts`

- [ ] **Step 1: 扩展运行角色测试**

Append to `server/src/services/__tests__/startupRuntimeRolePolicy.test.ts`:

```ts
test('API 角色不得启动后台 worker pool、在线结算和定时器', () => {
  const runtimeRoleSource = readFileSync(new URL('../../config/runtimeRole.ts', import.meta.url), 'utf8');
  const startupSource = readFileSync(new URL('../../bootstrap/startupPipeline.ts', import.meta.url), 'utf8');

  assert.match(runtimeRoleSource, /export const shouldStartWorkerPool/u);
  assert.match(runtimeRoleSource, /export const shouldStartScheduledBackgroundServices/u);
  assert.match(runtimeRoleSource, /export const shouldRecoverHttpBattleState/u);
  assert.match(runtimeRoleSource, /export const shouldRecoverIdleSessions/u);

  assert.match(startupSource, /if \(shouldStartWorkerPool\(runtimeRole\)\) \{/u);
  assert.match(startupSource, /if \(shouldStartScheduledBackgroundServices\(runtimeRole\)\) \{/u);
  assert.match(startupSource, /if \(shouldRecoverHttpBattleState\(runtimeRole\) && redisConnected\) \{/u);
  assert.match(startupSource, /if \(shouldRecoverIdleSessions\(runtimeRole\)\) \{/u);
});
```

- [ ] **Step 2: 增加角色判断函数**

Modify `server/src/config/runtimeRole.ts`:

```ts
export const shouldStartWorkerPool = (role: JiuzhouRuntimeRole): boolean => {
  return role === 'all' || role === 'worker';
};

export const shouldStartScheduledBackgroundServices = (role: JiuzhouRuntimeRole): boolean => {
  return role === 'all' || role === 'worker';
};

export const shouldRecoverHttpBattleState = (role: JiuzhouRuntimeRole): boolean => {
  return role === 'all' || role === 'api';
};

export const shouldRecoverIdleSessions = (role: JiuzhouRuntimeRole): boolean => {
  return role === 'all' || role === 'worker';
};
```

- [ ] **Step 3: 包住 worker pool 初始化**

Modify import in `server/src/bootstrap/startupPipeline.ts`:

```ts
import {
  resolveJiuzhouRuntimeRole,
  shouldRecoverHttpBattleState,
  shouldRecoverIdleSessions,
  shouldStartGeneralBackgroundWorkers,
  shouldStartHttpServer,
  shouldStartOnlineSettlementRunner,
  shouldStartScheduledBackgroundServices,
  shouldStartWorkerPool,
} from "../config/runtimeRole.js";
```

Replace worker pool startup block with:

```ts
  if (shouldStartWorkerPool(runtimeRole)) {
    console.log("正在初始化 Worker 池...");
    const cpuCount = cpus().length;
    const workerCount = process.env.IDLE_WORKER_COUNT
      ? parseInt(process.env.IDLE_WORKER_COUNT, 10)
      : Math.max(1, cpuCount - 1);

    console.log(`  - CPU 核心数: ${cpuCount}，启动 ${workerCount} 个 Worker`);
    console.log("  - 挂机战斗怪物解析复用普通战斗服务配置");

    await runStartupStep("Worker 池初始化", () =>
      initializeWorkerPool({
        workerCount,
      }),
    );
    console.log(`✓ Worker 池已就绪（${workerCount} 个 Worker）\n`);
  }
```

- [ ] **Step 4: 包住后台定时器和恢复任务**

Move these startup calls under:

```ts
  if (shouldStartScheduledBackgroundServices(runtimeRole)) {
    await runStartupStep("爱发电私信重试调度器初始化", initializeAfdianMessageRetryService);
    console.log("✓ 爱发电私信重试调度器已就绪\n");
    await runStartupStep("角色排行榜快照夜间刷新调度器初始化", initializeRankSnapshotNightlyRefreshScheduler);
    console.log("✓ 角色排行榜快照夜间刷新调度器已就绪\n");

    await runStartupStep("游戏时间服务初始化", initGameTimeService);
    await runStartupStep("竞技场周结算服务初始化", async () => {
      initArenaWeeklySettlementService();
    });
    await runStartupStep("清理 Worker 启动", async () => {
      await startCleanupWorker();
    });
  }
```

Replace battle recovery:

```ts
  if (shouldRecoverHttpBattleState(runtimeRole) && redisConnected) {
    await runStartupStep("战斗状态恢复", async () => {
      console.log("正在恢复战斗状态...");
      await recoverBattlesFromRedis();
    });
    await runStartupStep("战斗会话恢复", async () => {
      const recoveredSessionCount = await recoverBattleSessionsFromProjection();
      console.log(`✓ 已恢复 ${recoveredSessionCount} 条战斗会话`);
    });
  }
```

Replace idle recovery:

```ts
  if (shouldRecoverIdleSessions(runtimeRole)) {
    await runStartupStep("挂机会话恢复", recoverActiveIdleSessions);
  }
```

- [ ] **Step 5: 校验**

Run:

```powershell
.\node_modules\.bin\tsc.cmd -b
```

Expected: exit code 0.

---

### Task 3: 装备自动分解奖励按物品聚合后发放

**Files:**
- Create: `server/src/services/autoDisassembleRewardBatch.ts`
- Modify: `server/src/services/autoDisassembleRewardService.ts`
- Test: `server/src/services/__tests__/autoDisassembleRewardBatch.test.ts`

- [ ] **Step 1: 写聚合纯函数测试**

Create `server/src/services/__tests__/autoDisassembleRewardBatch.test.ts`:

```ts
/**
 * 自动分解奖励聚合测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定同一次发奖调用内的分解产物按 itemDefId 聚合数量。
 * 2. 做什么：锁定 sourceFallbackIndex 保留，后续批量发放失败时能回退到对应原装备。
 * 3. 不做什么：不调用 itemService，不生成装备，不访问数据库。
 *
 * 输入 / 输出：
 * - 输入：多条装备自动分解的产物与回退索引。
 * - 输出：按 itemDefId 聚合后的产物数组，以及每组关联的回退索引。
 *
 * 数据流 / 状态流：
 * equipment auto-disassemble reward plan -> appendAutoDisassembleRewardBatchEntry
 * -> finalizeAutoDisassembleRewardBatch -> grantRewardItemWithAutoDisassemble 批量 createItem。
 *
 * 复用设计说明：
 * - 把聚合规则抽成纯函数，自动分解服务只负责调用 createItem，避免装备循环里散落 Map 累加逻辑。
 *
 * 关键边界条件与坑点：
 * 1. 只能按 itemDefId 聚合；不能跨 obtainedFrom 或装备源回退状态合并其他语义。
 * 2. 回退索引必须去重并保留首次出现顺序，避免失败时重复补发原装备。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendAutoDisassembleRewardBatchEntry,
  createAutoDisassembleRewardBatch,
  finalizeAutoDisassembleRewardBatch,
} from '../autoDisassembleRewardBatch.js';

test('自动分解产物应按 itemDefId 聚合并保留首次顺序', () => {
  const batch = createAutoDisassembleRewardBatch();

  appendAutoDisassembleRewardBatchEntry(batch, {
    fallbackIndex: 0,
    rewards: [
      { itemDefId: 'material_dust', qty: 2 },
      { itemDefId: 'material_core', qty: 1 },
    ],
  });
  appendAutoDisassembleRewardBatchEntry(batch, {
    fallbackIndex: 1,
    rewards: [
      { itemDefId: 'material_dust', qty: 3 },
    ],
  });

  assert.deepEqual(finalizeAutoDisassembleRewardBatch(batch), [
    {
      itemDefId: 'material_dust',
      qty: 5,
      fallbackIndexes: [0, 1],
    },
    {
      itemDefId: 'material_core',
      qty: 1,
      fallbackIndexes: [0],
    },
  ]);
});
```

- [ ] **Step 2: 新增聚合模块**

Create `server/src/services/autoDisassembleRewardBatch.ts`:

```ts
/**
 * 自动分解奖励聚合器
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把同一次发奖调用内的自动分解产物按 itemDefId 聚合，减少 createItem 调用次数。
 * 2. 做什么：记录每个聚合产物关联的源装备回退索引，便于批量发放失败时只回退受影响源。
 * 3. 不做什么：不调用数据库，不判断是否自动分解，不创建原装备。
 *
 * 输入 / 输出：
 * - 输入：单件装备分解后的奖励产物与 fallbackIndex。
 * - 输出：按 itemDefId 聚合后的奖励产物列表。
 *
 * 数据流 / 状态流：
 * grantRewardItemWithAutoDisassemble equipment loop -> 本模块聚合 -> 批量 createItem -> result。
 *
 * 复用设计说明：
 * - 聚合规则集中后，后续邮件附件、任务奖励、手动分解批量化可以复用同一结构。
 *
 * 关键边界条件与坑点：
 * 1. qty 必须取正整数，非正数产物直接忽略。
 * 2. fallbackIndexes 使用 Set 去重，但输出保持源装备首次加入顺序。
 */

export type AutoDisassembleRewardBatchItem = {
  itemDefId: string;
  qty: number;
  fallbackIndexes: number[];
};

type MutableBatchItem = {
  itemDefId: string;
  qty: number;
  fallbackIndexSet: Set<number>;
  fallbackIndexes: number[];
};

export type AutoDisassembleRewardBatch = {
  itemByDefId: Map<string, MutableBatchItem>;
};

export const createAutoDisassembleRewardBatch = (): AutoDisassembleRewardBatch => ({
  itemByDefId: new Map<string, MutableBatchItem>(),
});

export const appendAutoDisassembleRewardBatchEntry = (
  batch: AutoDisassembleRewardBatch,
  entry: {
    fallbackIndex: number;
    rewards: readonly Array<{ itemDefId: string; qty: number }>;
  },
): void => {
  if (!Number.isInteger(entry.fallbackIndex) || entry.fallbackIndex < 0) return;

  for (const reward of entry.rewards) {
    const itemDefId = reward.itemDefId.trim();
    const qty = Math.max(0, Math.floor(Number(reward.qty) || 0));
    if (!itemDefId || qty <= 0) continue;

    const existing = batch.itemByDefId.get(itemDefId);
    if (existing) {
      existing.qty += qty;
      if (!existing.fallbackIndexSet.has(entry.fallbackIndex)) {
        existing.fallbackIndexSet.add(entry.fallbackIndex);
        existing.fallbackIndexes.push(entry.fallbackIndex);
      }
      continue;
    }

    batch.itemByDefId.set(itemDefId, {
      itemDefId,
      qty,
      fallbackIndexSet: new Set<number>([entry.fallbackIndex]),
      fallbackIndexes: [entry.fallbackIndex],
    });
  }
};

export const finalizeAutoDisassembleRewardBatch = (
  batch: AutoDisassembleRewardBatch,
): AutoDisassembleRewardBatchItem[] => {
  return [...batch.itemByDefId.values()].map((item) => ({
    itemDefId: item.itemDefId,
    qty: item.qty,
    fallbackIndexes: [...item.fallbackIndexes],
  }));
};
```

- [ ] **Step 3: 修改装备自动分解路径**

Modify `server/src/services/autoDisassembleRewardService.ts`:

```ts
import {
  appendAutoDisassembleRewardBatchEntry,
  createAutoDisassembleRewardBatch,
  finalizeAutoDisassembleRewardBatch,
} from './autoDisassembleRewardBatch.js';
```

Inside `grantRewardItemWithAutoDisassemble`, in the equipment branch:

```ts
  const sourceFallbacks: Array<() => Promise<void>> = [];
  const disassembleRewardBatch = createAutoDisassembleRewardBatch();
  let batchedSilver = 0;
```

For each equipment unit, push the source fallback before deciding auto-disassemble:

```ts
    const fallbackIndex = sourceFallbacks.length;
    sourceFallbacks.push(createSourceItem);
```

When `rewardPlan.success` and `rewardApplySuccess` would previously create each reward item immediately, replace per-item `input.createItem` calls with:

```ts
    appendAutoDisassembleRewardBatchEntry(disassembleRewardBatch, {
      fallbackIndex,
      rewards: rewardPlan.rewards.items.map((rewardItem) => ({
        itemDefId: rewardItem.itemDefId,
        qty: rewardItem.qty,
      })),
    });
    batchedSilver += Math.max(0, Math.floor(Number(rewardPlan.rewards.silver) || 0));
    continue;
```

After the equipment loop, before `return result`, grant the batch:

```ts
  const batchedRewardItems = finalizeAutoDisassembleRewardBatch(disassembleRewardBatch);
  const failedFallbackIndexes = new Set<number>();

  for (const rewardItem of batchedRewardItems) {
    const chunkGrantResult = await grantAutoDisassembleRewardItemInChunks(
      result,
      input.createItem,
      input.metrics,
      rewardItem,
    );
    if (!chunkGrantResult.success) {
      result.warnings.push(
        chunkGrantResult.message ?? `自动分解奖励入包失败: ${rewardItem.itemDefId}`,
      );
      for (const fallbackIndex of rewardItem.fallbackIndexes) {
        failedFallbackIndexes.add(fallbackIndex);
      }
    }
  }

  if (failedFallbackIndexes.size > 0) {
    for (const fallbackIndex of [...failedFallbackIndexes].sort((a, b) => a - b)) {
      const fallback = sourceFallbacks[fallbackIndex];
      if (fallback) await fallback();
    }
    return result;
  }

  if (batchedSilver > 0) {
    if (!input.addSilver) {
      result.warnings.push(`自动分解银两发放失败: ${input.itemDefId}, 缺少addSilver实现`);
    } else {
      const addSilverResult = await measureAsyncMetric(
        input.metrics,
        'addSilverCostMs',
        () => input.addSilver!(input.characterId, batchedSilver),
      );
      if (addSilverResult.success) {
        result.gainedSilver += batchedSilver;
      } else {
        result.warnings.push(`自动分解银两发放失败: ${input.itemDefId}, ${addSilverResult.message}`);
      }
    }
  }
```

- [ ] **Step 4: 校验**

Run:

```powershell
.\node_modules\.bin\tsc.cmd -b
```

Expected: exit code 0.

---

### Task 4: `/inventory/use` 精准分段并避免简单消耗品重载角色

**Files:**
- Modify: `server/src/services/itemService.ts`
- Test: `server/src/services/__tests__/itemUseFastCharacterSnapshotPolicy.test.ts`

- [ ] **Step 1: 写静态策略测试**

Create `server/src/services/__tests__/itemUseFastCharacterSnapshotPolicy.test.ts`:

```ts
/**
 * itemService.useItem 角色快照策略测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定简单资源/货币消耗品使用后不强制重载完整角色计算结果。
 * 2. 做什么：锁定 useItem 慢日志区分前置读取、互斥锁、效果执行、角色快照构建。
 * 3. 不做什么：不连接数据库，不执行真实物品使用。
 *
 * 输入 / 输出：
 * - 输入：itemService.ts 源码文本。
 * - 输出：静态结构断言。
 *
 * 数据流 / 状态流：
 * computedBefore + rewardDelta + resourceDelta -> buildItemUseCharacterSnapshot -> route response。
 *
 * 复用设计说明：
 * - 角色快照合成集中在服务层，路由继续只消费 `ItemUseResult.character`，避免接口层重复拼角色字段。
 *
 * 关键边界条件与坑点：
 * 1. 学功法、解绑装备、影响派生属性的效果仍必须重载角色。
 * 2. 合成快照只处理本次 useItem 已知的资源变化，不能伪造未知字段。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../itemService.ts', import.meta.url), 'utf8');

test('useItem 应根据效果决定是否重载完整角色', () => {
  assert.match(source, /const shouldReloadCharacterAfterUseItem = \(/u);
  assert.match(source, /const updatedChar = shouldReloadCharacterAfterUseItem\(/u);
  assert.match(source, /buildItemUseCharacterSnapshot\(/u);
});

test('useItem 慢日志应拆分前置读取和互斥锁等待', () => {
  assert.match(source, /slowLogger\.mark\('loadUseContext'/u);
  assert.match(source, /slowLogger\.mark\('lockInventoryMutex'/u);
  assert.match(source, /slowLogger\.mark\('applyUseEffects'/u);
  assert.match(source, /slowLogger\.mark\('buildCharacterSnapshot'/u);
});
```

- [ ] **Step 2: 增加角色快照合成函数**

Add near `aggregateItemUseLootItems` in `server/src/services/itemService.ts`:

```ts
const buildItemUseCharacterSnapshot = (
  base: CharacterComputedRow,
  delta: {
    exp: number;
    silver: number;
    spiritStones: number;
    qixue: number;
    lingqi: number;
    stamina: number;
  },
): CharacterComputedRow => {
  return {
    ...base,
    exp: Number(base.exp) + delta.exp,
    silver: Number(base.silver) + delta.silver,
    spirit_stones: Number(base.spirit_stones) + delta.spiritStones,
    qixue: Number(base.qixue) + delta.qixue,
    lingqi: Number(base.lingqi) + delta.lingqi,
    stamina: Number(base.stamina) + delta.stamina,
  };
};

const shouldReloadCharacterAfterUseItem = (flags: {
  hasLearnTechnique: boolean;
  hasEquipmentUnbindEffect: boolean;
  hasExpandEffect: boolean;
}): boolean => {
  return flags.hasLearnTechnique || flags.hasEquipmentUnbindEffect || flags.hasExpandEffect;
};
```

- [ ] **Step 3: 拆准慢日志阶段**

In `useItem`, after `computedBefore`:

```ts
    slowLogger.mark('loadUseContext');
```

After `lockCharacterInventoryMutex`:

```ts
    slowLogger.mark('lockInventoryMutex');
```

After the effect loop:

```ts
    slowLogger.mark('applyUseEffects', {
      effectCount: effectDefs.length,
      lootItemCount: lootItemsToAdd.length,
      hasLoot,
      hasLearnTechnique,
      hasLearnPartnerTechnique,
      hasEquipmentUnbindEffect,
      hasPartnerBaseAttrRerollEffect,
    });
```

Replace the final character load with:

```ts
    const updatedChar = shouldReloadCharacterAfterUseItem({
      hasLearnTechnique,
      hasEquipmentUnbindEffect,
      hasExpandEffect,
    })
      ? await getCharacterComputedByCharacterId(characterId, { bypassStaticCache: true })
      : buildItemUseCharacterSnapshot(computedBefore, {
          exp: rewardDelta.exp,
          silver: rewardDelta.silver,
          spiritStones: rewardDelta.spiritStones,
          qixue: deltaQixue,
          lingqi: deltaLingqi,
          stamina: deltaStamina,
        });
    slowLogger.mark('buildCharacterSnapshot', {
      reloadedCharacter: shouldReloadCharacterAfterUseItem({
        hasLearnTechnique,
        hasEquipmentUnbindEffect,
        hasExpandEffect,
      }),
    });
```

- [ ] **Step 4: 校验**

Run:

```powershell
.\node_modules\.bin\tsc.cmd -b
```

Expected: exit code 0.

---

### Task 5: 市场与公开列表改用瘦身 DTO

**Files:**
- Modify: `server/src/routes/inventoryRoutes.ts`
- Modify: `server/src/services/inventory/itemQuery.ts`
- Modify: `server/src/services/partnerMarketService.ts`
- Modify: `server/src/routes/marketRoutes.ts`
- Modify: `client/src/services/api/inventory.ts`
- Modify: `client/src/services/api/market-mail.ts`
- Modify: `client/src/pages/Game/modules/MarketModal/index.tsx`
- Test: `server/src/services/__tests__/marketListPayloadPolicy.test.ts`

- [ ] **Step 1: 写响应体策略测试**

Create `server/src/services/__tests__/marketListPayloadPolicy.test.ts`:

```ts
/**
 * 市场列表响应体瘦身策略测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定市场上架背包候选不再调用完整 `/inventory/items` 富化列表。
 * 2. 做什么：锁定公开伙伴坊市列表不返回完整 techniques 数组。
 * 3. 不做什么：不启动 Express，不验证前端渲染。
 *
 * 输入 / 输出：
 * - 输入：路由与服务源码文本。
 * - 输出：静态结构断言。
 *
 * 数据流 / 状态流：
 * MarketModal -> /inventory/sale-candidates -> slim item DTO；
 * MarketModal -> /market/partner-listings -> partner summary DTO -> preview 时按需拉详情。
 *
 * 复用设计说明：
 * - 列表 DTO 与详情 DTO 分离，避免公开列表、我的上架、交易记录都携带一份完整详情。
 *
 * 关键边界条件与坑点：
 * 1. 上架弹窗仍要能展示装备基础信息，但不需要 long_desc、effect_defs、完整 affixDefs。
 * 2. 伙伴列表预览仍可按 listingId 拉详情，不能在列表阶段全量返回 techniques。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('库存上架候选应使用专用瘦身入口', () => {
  const routeSource = readFileSync(new URL('../../routes/inventoryRoutes.ts', import.meta.url), 'utf8');
  const itemQuerySource = readFileSync(new URL('../inventory/itemQuery.ts', import.meta.url), 'utf8');

  assert.match(routeSource, /router\.get\('\/sale-candidates'/u);
  assert.match(itemQuerySource, /getInventorySaleCandidates/u);
  assert.doesNotMatch(routeSource, /\/sale-candidates[\s\S]*getInventoryItemsWithDefs/u);
});

test('公开伙伴坊市列表不得直接返回完整 techniques', () => {
  const partnerMarketSource = readFileSync(new URL('../partnerMarketService.ts', import.meta.url), 'utf8');
  assert.match(partnerMarketSource, /MarketPartnerListingSummaryDto/u);
  assert.match(partnerMarketSource, /buildPartnerListingSummaryDto/u);
  assert.doesNotMatch(partnerMarketSource, /MarketPartnerListingSummaryDto[\s\S]*techniques:/u);
});
```

- [ ] **Step 2: 增加库存上架候选服务**

In `server/src/services/inventory/itemQuery.ts`, add:

```ts
export type InventorySaleCandidateDto = {
  id: number;
  itemDefId: string;
  name: string;
  icon: string | null;
  quality: string | null;
  category: string | null;
  subCategory: string | null;
  qty: number;
  locked: boolean;
  bindType: string | null;
  strengthenLevel: number | null;
  refineLevel: number | null;
};

export const getInventorySaleCandidates = async (
  characterId: number,
): Promise<InventorySaleCandidateDto[]> => {
  const result = await getInventoryItems(characterId, 'bag', 1, 200);
  return result.items.map((item) => {
    const def = getItemDefinitionById(item.item_def_id);
    return {
      id: item.id,
      itemDefId: item.item_def_id,
      name: String(def?.name ?? item.item_def_id),
      icon: typeof def?.icon === 'string' ? def.icon : null,
      quality: item.quality ?? (typeof def?.quality === 'string' ? def.quality : null),
      category: typeof def?.category === 'string' ? def.category : null,
      subCategory: typeof def?.sub_category === 'string' ? def.sub_category : null,
      qty: item.qty,
      locked: item.locked,
      bindType: item.bind_type ?? null,
      strengthenLevel: item.strengthen_level,
      refineLevel: item.refine_level,
    };
  });
};
```

- [ ] **Step 3: 增加库存路由**

In `server/src/routes/inventoryRoutes.ts`, add before `/items`:

```ts
router.get('/sale-candidates', asyncHandler(async (req, res) => {
    const characterId = req.characterId!;
    const items = await inventoryService.getInventorySaleCandidates(characterId);
    sendSuccess(res, { items });
}));
```

Expose through `server/src/services/inventory/service.ts`:

```ts
  async getInventorySaleCandidates(characterId: number): Promise<InventorySaleCandidateDto[]> {
    return getInventorySaleCandidates(characterId);
  }
```

- [ ] **Step 4: 公开伙伴坊市列表返回 summary**

In `server/src/services/partnerMarketService.ts`, add:

```ts
export interface MarketPartnerListingSummaryDto {
  id: number;
  partner: {
    id: number;
    partnerDefId: string;
    name: string;
    nickname: string | null;
    avatar: string | null;
    quality: string;
    element: string;
    role: string;
    level: number;
    currentEffectiveLevel: number;
  };
  unitPriceSpiritStones: number;
  sellerCharacterId: number;
  sellerName: string;
  listedAt: number;
  buyTicket?: string | null;
}
```

Add summary builder:

```ts
const buildPartnerListingSummaryDto = (row: PartnerListingRow): MarketPartnerListingSummaryDto | null => {
  const snapshot = row.partner_snapshot;
  if (!snapshot) return null;
  return {
    id: Number(row.id),
    partner: {
      id: Number(snapshot.id),
      partnerDefId: normalizeText(snapshot.partnerDefId),
      name: normalizeText(snapshot.name),
      nickname: snapshot.nickname ? normalizeText(snapshot.nickname) : null,
      avatar: snapshot.avatar ? normalizeText(snapshot.avatar) : null,
      quality: normalizeText(snapshot.quality),
      element: normalizeText(snapshot.element),
      role: normalizeText(snapshot.role),
      level: normalizeInteger(snapshot.level),
      currentEffectiveLevel: normalizeInteger(snapshot.currentEffectiveLevel),
    },
    unitPriceSpiritStones: Number(row.unit_price_spirit_stones),
    sellerCharacterId: Number(row.seller_character_id),
    sellerName: String(row.seller_name ?? ''),
    listedAt: new Date(String(row.listed_at ?? '')).getTime(),
  };
};
```

Change public `loadPartnerListingsCacheData` to use summary builder:

```ts
  const listings = (listResult.rows as PartnerListingRow[])
    .map((row) => buildPartnerListingSummaryDto(row))
    .filter((row): row is MarketPartnerListingSummaryDto => row !== null);
```

Keep `getMyPartnerListings` and trade records on full DTO if the UI needs full details for owned assets.

- [ ] **Step 5: 前端市场弹窗接入瘦身接口**

In `client/src/services/api/inventory.ts`, add:

```ts
export interface InventorySaleCandidateDto {
  id: number;
  itemDefId: string;
  name: string;
  icon: string | null;
  quality: string | null;
  category: string | null;
  subCategory: string | null;
  qty: number;
  locked: boolean;
  bindType: string | null;
  strengthenLevel: number | null;
  refineLevel: number | null;
}

export const getInventorySaleCandidates = (): Promise<{
  success: boolean;
  message?: string;
  data?: { items: InventorySaleCandidateDto[] };
}> => {
  return api.get('/inventory/sale-candidates');
};
```

In `client/src/pages/Game/modules/MarketModal/index.tsx`, replace:

```ts
const res = await getInventoryItems('bag', 1, 200);
```

with:

```ts
const res = await getInventorySaleCandidates();
```

and update `buildBagItem` to accept `InventorySaleCandidateDto`.

- [ ] **Step 6: 校验**

Run:

```powershell
.\node_modules\.bin\tsc.cmd -b
```

Expected: exit code 0.

---

## 验收标准

- 线上 `docker service ls` 出现 `jiuzhou_server 1/1` 与 `jiuzhou_server_worker 1/1`。
- `jiuzhou_server` 容器环境包含 `JIUZHOU_RUNTIME_ROLE=api`，`jiuzhou_server_worker` 包含 `JIUZHOU_RUNTIME_ROLE=worker`。
- API 容器日志不再出现：
  - `onlineBattleSettlementRunner.tick`
  - `onlineBattleSettlementRunner.executeTask`
  - `洞府研修 worker 协调器初始化`
  - `清理 Worker 启动`
- worker 容器日志不出现 `服务已启动: http://...`。
- 最近 5 分钟 API 容器 `event_loop_busy` 数量显著下降。
- `battleDropService.settleBattleRewardPlan` 中 `grantRewardCreateDisassembleRewardCreateCallCount` 明显低于装备自动分解产物总数。
- `/api/inventory/use` 慢日志中 `buildCharacterSnapshot` 替代大部分 `loadUpdatedCharacter` 高耗时。
- `/api/inventory/sale-candidates` 响应体显著小于原 `/api/inventory/items?pageSize=200`。
- `/api/market/partner-listings` 的 `contentLength` 不再出现 100KB 级别常态响应。
- `.\node_modules\.bin\tsc.cmd -b` 成功。

## 线上复查命令

```bash
api_cid=$(docker ps --filter name=jiuzhou_server --format '{{.Names}}' | grep -v worker | sed -n '1p')
worker_cid=$(docker ps --filter name=jiuzhou_server_worker --format '{{.Names}}' | sed -n '1p')

docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$api_cid" | grep JIUZHOU_RUNTIME_ROLE
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$worker_cid" | grep JIUZHOU_RUNTIME_ROLE

docker logs --since 5m "$api_cid" 2>&1 \
  | perl -pe 's/\e\[[0-9;]*m//g' \
  | awk '
    /http.slow-request/ {slow_http++}
    /"kind":"event_loop_busy"/ {event_loop++}
    /onlineBattleSettlementRunner/ {runner++}
    /itemService.useItem/ {use_item++}
    END {
      print "api_slow_http", slow_http+0;
      print "api_event_loop_busy", event_loop+0;
      print "api_runner_logs", runner+0;
      print "api_item_use", use_item+0;
    }'

docker logs --since 5m "$worker_cid" 2>&1 \
  | perl -pe 's/\e\[[0-9;]*m//g' \
  | awk '
    /onlineBattleSettlementRunner.executeTask/ {runner_task++}
    /battleDropService.settleBattleRewardPlan/ {battle_drop++}
    END {
      print "worker_runner_task", runner_task+0;
      print "worker_battle_drop", battle_drop+0;
    }'
```

## 暂不做

- 不直接把 API 副本扩到多个。Socket、用户连接槽位、boardgame 运行态还需要单独确认跨实例一致性；本阶段先拆 API/worker 角色。
- 不砍掉 `partner/overview` 的完整功能。伙伴弹窗仍需要完整数据，本阶段先让公开市场列表不携带完整详情。
- 不把所有发奖改成单条 SQL。自动分解、装备生成、背包容量、邮件补发有复杂边界；本阶段只批量化同一次自动分解产物。

## Self-Review

- Spec coverage：覆盖了线上复查暴露的 5 个问题：运行角色未启用、后台结算抢 event loop、自动分解 create 调用过多、`useItem` 最终角色重载慢、大响应接口。
- Placeholder scan：未使用 TBD、TODO、implement later、类似“写测试覆盖以上”的空泛步骤；每个任务都有具体文件、代码片段和校验命令。
- Type consistency：`JiuzhouRuntimeRole`、`MarketPartnerListingSummaryDto`、`InventorySaleCandidateDto`、`AutoDisassembleRewardBatchItem` 名称在任务内保持一致。
