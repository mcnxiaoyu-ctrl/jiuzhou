# Server Performance Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 降低几百在线玩家时的接口尾延迟，优先处理线上已观测到的资源采集、背包装备操作、Redis `KEYS`、AI 生成功法快照刷新和邮件已读热点。

**Architecture:** 本计划只改服务端热路径，不改客户端发布方式。优化策略是把高频请求前置短路、把非必要角色全量重算改为条件触发、把 Redis 全库扫描改为游标扫描、把宽表刷新改为版本签名跳过、把邮件已读 SQL 从宽行 CTE 缩为窄行原子更新。

**Tech Stack:** TypeScript, Node.js, Express, PostgreSQL, Redis/ioredis, Docker Swarm.

---

## 执行约束

- 不创建隔离工作区。
- 不运行 `dev` / `start` / `build` / `test`。
- 代码改完只运行 `.\node_modules\.bin\tsc.cmd -b`。
- 不执行任何 Git 命令。
- 只部署服务端时必须由用户再次明确授权；客户端是静态发布，本计划不要求客户端发布。

## 当前线上依据

- 机器 CPU/内存/磁盘没有打满，PostgreSQL 无明显锁等待。
- 慢请求集中在 `/api/map/.../resources/.../gather`、`/api/inventory/use`、`/api/inventory/reroll-affixes`、`/api/inventory/socket`、`/api/character/info`。
- Redis slowlog 出现 `KEYS battle:state:*`，这是服务启动恢复战斗时的全库阻塞扫描。
- `pg_stat_statements` 中 AI 生成功法快照加载 SQL 累计耗时高，说明刷新链路仍有宽查询重复执行。
- `readMail` 的 `WITH target_mail` 查询返回附件 JSON 宽字段，但已读计数只需要收窄到 recipient/read 状态。

## 文件结构

- Modify: `server/src/services/battle/lifecycle.ts`
  - 移除 `redis.keys`，改为 `SCAN` 游标扫描。
- Create: `server/src/services/shared/characterMutationThrottle.ts`
  - 统一角色级短时间突变限流，先用于地图资源采集。
- Modify: `server/src/services/roomObjectService.ts`
  - 在资源合法性确认后、DB 行锁前加入角色采集限流。
- Modify: `server/src/services/inventory/equipment.ts`
  - 洗炼只在装备已穿戴时刷新角色快照。
- Modify: `server/src/services/inventory/socket.ts`
  - 镶嵌只在装备已穿戴时刷新角色快照。
- Modify: `server/src/services/inventory/service.ts`
  - 透传 `affectsCharacter` 字段类型。
- Modify: `server/src/routes/inventoryRoutes.ts`
  - `safePushCharacterUpdate` 改成只在 `affectsCharacter === true` 时触发。
- Modify: `server/src/services/generatedTechniqueConfigStore.ts`
  - 增加快照签名，签名未变化时跳过宽查询刷新。
- Modify: `server/src/services/shared/performanceIndexes.ts`
  - 增加生成功法/技能/层级 `updated_at` 部分索引。
- Modify: `server/src/services/mailService.ts`
  - 收窄 `readMail` CTE 返回字段，不再读取附件 JSON。
- Create/Modify tests under `server/src/services/__tests__/`
  - 增加静态策略测试锁定上述性能边界。

---

### Task 1: Redis 战斗恢复去除 `KEYS`

**Files:**
- Modify: `server/src/services/battle/lifecycle.ts`
- Create: `server/src/services/__tests__/battleLifecycleRedisScanPolicy.test.ts`

- [ ] **Step 1: 写静态策略测试**

Create `server/src/services/__tests__/battleLifecycleRedisScanPolicy.test.ts`:

```ts
/**
 * 战斗恢复 Redis 扫描策略测试
 *
 * 作用：锁定战斗恢复不能再使用 Redis KEYS，必须使用 SCAN 游标扫描。
 * 输入/输出：输入为 lifecycle.ts 源码文本，输出为策略断言。
 * 数据流：启动恢复 -> recoverBattlesFromRedis -> Redis 游标扫描 -> 逐场恢复。
 * 复用设计说明：该测试作为启动热路径的单一策略入口，后续不需要在部署脚本里重复检查。
 * 关键边界条件与坑点：
 * 1. `KEYS battle:state:*` 会阻塞 Redis 主线程，在线上 keyspace 变大时直接放大接口尾延迟。
 * 2. `SCAN` 必须携带 MATCH 前缀，否则会把无关 key 带回应用层过滤。
 */
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../battle/lifecycle.ts', import.meta.url), 'utf8');

test('recoverBattlesFromRedis 应使用 SCAN，禁止 Redis KEYS', () => {
  assert.doesNotMatch(source, /\.keys\(/u);
  assert.match(source, /\.scan\(/u);
  assert.match(source, /MATCH/u);
  assert.match(source, /REDIS_BATTLE_KEY_PREFIX/u);
});
```

- [ ] **Step 2: 在 `lifecycle.ts` 添加前缀扫描 helper**

Add below constants in `server/src/services/battle/lifecycle.ts`:

```ts
const REDIS_BATTLE_SCAN_COUNT = 500;

const scanRedisKeysByPrefix = async (prefix: string): Promise<string[]> => {
  const matchedKeys: string[] = [];
  let cursor = "0";
  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      "MATCH",
      `${prefix}*`,
      "COUNT",
      String(REDIS_BATTLE_SCAN_COUNT),
    );
    cursor = nextCursor;
    matchedKeys.push(...keys);
  } while (cursor !== "0");
  return matchedKeys;
};
```

- [ ] **Step 3: 替换恢复入口扫描**

Replace:

```ts
const keys = await redis.keys(`${REDIS_BATTLE_KEY_PREFIX}*`);
```

with:

```ts
const keys = await scanRedisKeysByPrefix(REDIS_BATTLE_KEY_PREFIX);
```

- [ ] **Step 4: 校验预期**

Run only after all tasks or when doing checkpoint:

```powershell
.\node_modules\.bin\tsc.cmd -b
```

Expected: TypeScript build succeeds.

---

### Task 2: 资源采集入口增加角色级短限流

**Files:**
- Create: `server/src/services/shared/characterMutationThrottle.ts`
- Modify: `server/src/services/roomObjectService.ts`
- Create: `server/src/services/__tests__/roomResourceGatherThrottlePolicy.test.ts`

- [ ] **Step 1: 写静态策略测试**

Create `server/src/services/__tests__/roomResourceGatherThrottlePolicy.test.ts`:

```ts
/**
 * 地图资源采集限流策略测试
 *
 * 作用：锁定资源采集在进入 DB 行锁前先走角色级短限流。
 * 输入/输出：输入为 roomObjectService.ts 源码文本，输出为策略断言。
 * 数据流：请求参数 -> 房间/资源合法性确认 -> acquireCharacterMutationThrottle -> DB 行锁和奖励写入。
 * 复用设计说明：限流 helper 是角色突变类接口的统一入口，本测试先锁定 gather 热路径复用它。
 * 关键边界条件与坑点：
 * 1. 限流必须在 `lockCharacterInventoryMutex` 之前，否则无法削减锁竞争。
 * 2. 限流不能放在参数校验之前，避免无效请求污染合法操作窗口。
 */
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../roomObjectService.ts', import.meta.url), 'utf8');

test('gatherRoomResourceImpl 应在背包锁前执行角色级采集限流', () => {
  const throttleIndex = source.indexOf('acquireCharacterMutationThrottle');
  const lockIndex = source.indexOf('lockCharacterInventoryMutex(characterId)');
  assert.notEqual(throttleIndex, -1);
  assert.notEqual(lockIndex, -1);
  assert.ok(throttleIndex < lockIndex);
  assert.match(source, /scope:\s*'map-resource-gather'/u);
});
```

- [ ] **Step 2: 新增复用限流模块**

Create `server/src/services/shared/characterMutationThrottle.ts`:

```ts
/**
 * 角色突变短限流
 *
 * 作用：
 * 1. 做什么：为高频角色突变接口提供 Redis SET NX PX 短窗口限流。
 * 2. 不做什么：不替代业务冷却、不记录失败次数、不做验证码或风控判定。
 *
 * 输入/输出：
 * - 输入：角色 ID、业务 scope、窗口毫秒数。
 * - 输出：是否允许继续执行。
 *
 * 数据流/状态流：
 * 路由/服务热路径 -> acquireCharacterMutationThrottle -> Redis NX key -> 允许时进入 DB 锁。
 *
 * 复用设计说明：
 * - 资源采集先复用该入口，后续如果其他角色突变接口出现同类抖动，可以只扩展 scope。
 * - key 结构集中在这里，避免各业务服务重复拼 Redis key。
 *
 * 关键边界条件与坑点：
 * 1. 只做短窗口防抖，不承诺强一致；真正的业务状态仍由数据库行锁和事务保证。
 * 2. key 必须带角色 ID 和 scope，不能按 IP 限流，否则同出口玩家会互相影响。
 */
import { redis } from '../../config/redis.js';

export type CharacterMutationThrottleScope = 'map-resource-gather';

const buildCharacterMutationThrottleKey = (
  characterId: number,
  scope: CharacterMutationThrottleScope,
): string => {
  return `character:mutation-throttle:${scope}:${Math.floor(characterId)}`;
};

export const acquireCharacterMutationThrottle = async (params: {
  characterId: number;
  scope: CharacterMutationThrottleScope;
  windowMs: number;
}): Promise<boolean> => {
  const characterId = Math.floor(params.characterId);
  const windowMs = Math.max(1, Math.floor(params.windowMs));
  const result = await redis.set(
    buildCharacterMutationThrottleKey(characterId, params.scope),
    '1',
    'PX',
    windowMs,
    'NX',
  );
  return result === 'OK';
};
```

- [ ] **Step 3: 接入资源采集热路径**

In `server/src/services/roomObjectService.ts`, import:

```ts
import { acquireCharacterMutationThrottle } from './shared/characterMutationThrottle.js';
```

Add a module constant near `getRoomResourceConfig`:

```ts
const ROOM_RESOURCE_GATHER_THROTTLE_WINDOW_MS = 750;
```

After `const cfg = getRoomResourceConfig(room, resourceId);` and before `await lockCharacterInventoryMutex(characterId);`, add:

```ts
  const gatherThrottleAllowed = await acquireCharacterMutationThrottle({
    characterId,
    scope: 'map-resource-gather',
    windowMs: ROOM_RESOURCE_GATHER_THROTTLE_WINDOW_MS,
  });
  if (!gatherThrottleAllowed) {
    return { success: false, message: '采集操作过于频繁，请稍后再试' };
  }
```

- [ ] **Step 4: 校验预期**

Run:

```powershell
.\node_modules\.bin\tsc.cmd -b
```

Expected: TypeScript build succeeds.

---

### Task 3: 洗炼/镶嵌跳过非穿戴装备角色全量重算

**Files:**
- Modify: `server/src/services/inventory/equipment.ts`
- Modify: `server/src/services/inventory/socket.ts`
- Modify: `server/src/services/inventory/service.ts`
- Modify: `server/src/routes/inventoryRoutes.ts`
- Create: `server/src/services/__tests__/inventoryEquipmentCharacterRefreshPolicy.test.ts`

- [ ] **Step 1: 写静态策略测试**

Create `server/src/services/__tests__/inventoryEquipmentCharacterRefreshPolicy.test.ts`:

```ts
/**
 * 装备操作角色刷新策略测试
 *
 * 作用：锁定洗炼/镶嵌只有在操作已穿戴装备时才刷新角色快照和推送角色更新。
 * 输入/输出：输入为源码文本，输出为策略断言。
 * 数据流：装备实例 location -> affectsCharacter -> 条件 getCharacterComputedByCharacterId -> 路由条件推送。
 * 复用设计说明：`affectsCharacter` 是装备突变返回 DTO 的统一刷新信号，避免路由层重复判断装备位置。
 * 关键边界条件与坑点：
 * 1. 背包/仓库装备变更只影响背包快照，不能触发角色全量重算。
 * 2. 已穿戴装备仍必须刷新角色和战斗状态，否则属性面板与战斗快照会过期。
 */
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const equipmentSource = readFileSync(new URL('../inventory/equipment.ts', import.meta.url), 'utf8');
const socketSource = readFileSync(new URL('../inventory/socket.ts', import.meta.url), 'utf8');
const routeSource = readFileSync(new URL('../../routes/inventoryRoutes.ts', import.meta.url), 'utf8');

test('reroll/socket 应通过 affectsCharacter 控制角色重算', () => {
  assert.match(equipmentSource, /const affectsCharacter = item\.location === "equipped"/u);
  assert.match(equipmentSource, /affectsCharacter\s*\?\s*await getCharacterComputedByCharacterId/u);
  assert.match(socketSource, /const affectsCharacter = equip\.location === "equipped"/u);
  assert.match(socketSource, /affectsCharacter\s*\?\s*await getCharacterComputedByCharacterId/u);
  assert.match(routeSource, /result\.data\?\.affectsCharacter === true/u);
});
```

- [ ] **Step 2: 修改洗炼返回 DTO**

In `server/src/services/inventory/equipment.ts`, add `affectsCharacter: boolean` inside `data`.

Before current character reload:

```ts
    const affectsCharacter = item.location === "equipped";
    const character = affectsCharacter
      ? await getCharacterComputedByCharacterId(characterId, {
          bypassStaticCache: true,
        })
      : null;
```

Return:

```ts
        affectsCharacter,
        character,
```

- [ ] **Step 3: 修改镶嵌返回 DTO**

In `server/src/services/inventory/socket.ts`, add `affectsCharacter: boolean` inside `data`.

Before current character reload:

```ts
  const affectsCharacter = equip.location === "equipped";
  const character = affectsCharacter
    ? await getCharacterComputedByCharacterId(characterId, {
        bypassStaticCache: true,
      })
    : null;
```

Return:

```ts
      affectsCharacter,
      character,
```

- [ ] **Step 4: 更新 service 类型透传**

In `server/src/services/inventory/service.ts`, add `affectsCharacter: boolean` to the reroll/socket response data types so route code can type-check without casts.

- [ ] **Step 5: 修改路由推送条件**

In `server/src/routes/inventoryRoutes.ts`, replace both success push blocks:

```ts
    if (result.success) {
      await safePushCharacterUpdate(userId);
    }
```

with:

```ts
    if (result.success && result.data?.affectsCharacter === true) {
      await safePushCharacterUpdate(userId);
    }
```

- [ ] **Step 6: 校验预期**

Run:

```powershell
.\node_modules\.bin\tsc.cmd -b
```

Expected: TypeScript build succeeds.

---

### Task 4: AI 生成功法快照刷新增加签名跳过

**Files:**
- Modify: `server/src/services/generatedTechniqueConfigStore.ts`
- Modify: `server/src/services/shared/performanceIndexes.ts`
- Create: `server/src/services/__tests__/generatedTechniqueConfigStoreSignaturePolicy.test.ts`

- [ ] **Step 1: 写静态策略测试**

Create `server/src/services/__tests__/generatedTechniqueConfigStoreSignaturePolicy.test.ts`:

```ts
/**
 * AI 生成功法快照刷新签名策略测试
 *
 * 作用：锁定快照刷新先读窄签名，签名未变化时跳过宽表加载。
 * 输入/输出：输入为 generatedTechniqueConfigStore.ts 源码文本，输出为策略断言。
 * 数据流：reload -> loadGeneratedTechniqueSnapshotSignature -> 签名比对 -> 必要时加载 def/skill/layer。
 * 复用设计说明：签名逻辑集中在配置缓存层，调用方继续使用 refreshGeneratedTechniqueSnapshots。
 * 关键边界条件与坑点：
 * 1. 签名必须覆盖 technique/skill/layer 三类 updated_at，否则技能或层级变更可能不可见。
 * 2. 首次加载不能跳过；只有已有签名且新签名相等时才返回。
 */
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../generatedTechniqueConfigStore.ts', import.meta.url), 'utf8');

test('reloadGeneratedTechniqueConfigStore 应使用快照签名跳过重复宽查询', () => {
  assert.match(source, /type GeneratedTechniqueSnapshotSignature/u);
  assert.match(source, /loadGeneratedTechniqueSnapshotSignature/u);
  assert.match(source, /isGeneratedTechniqueSnapshotSignatureEqual/u);
  assert.match(source, /lastGeneratedTechniqueSnapshotSignature/u);
});
```

- [ ] **Step 2: 增加签名类型和查询**

In `server/src/services/generatedTechniqueConfigStore.ts`, add:

```ts
type GeneratedTechniqueSnapshotSignature = {
  publishedTechniqueCount: number;
  enabledSkillCount: number;
  enabledLayerCount: number;
  techniqueMaxUpdatedAt: string;
  skillMaxUpdatedAt: string;
  layerMaxUpdatedAt: string;
};

type GeneratedTechniqueSnapshotSignatureRow = {
  published_technique_count: number | string | null;
  enabled_skill_count: number | string | null;
  enabled_layer_count: number | string | null;
  technique_max_updated_at: Date | string | null;
  skill_max_updated_at: Date | string | null;
  layer_max_updated_at: Date | string | null;
};

let lastGeneratedTechniqueSnapshotSignature: GeneratedTechniqueSnapshotSignature | null = null;

const LOAD_GENERATED_TECHNIQUE_SNAPSHOT_SIGNATURE_SQL = `
  SELECT
    (
      SELECT COUNT(*)::bigint
      FROM generated_technique_def
      WHERE is_published = true AND enabled = true
    ) AS published_technique_count,
    (
      SELECT COUNT(*)::bigint
      FROM generated_skill_def
      WHERE enabled = true
    ) AS enabled_skill_count,
    (
      SELECT COUNT(*)::bigint
      FROM generated_technique_layer
      WHERE enabled = true
    ) AS enabled_layer_count,
    (
      SELECT MAX(updated_at)
      FROM generated_technique_def
      WHERE is_published = true AND enabled = true
    ) AS technique_max_updated_at,
    (
      SELECT MAX(updated_at)
      FROM generated_skill_def
      WHERE enabled = true
    ) AS skill_max_updated_at,
    (
      SELECT MAX(updated_at)
      FROM generated_technique_layer
      WHERE enabled = true
    ) AS layer_max_updated_at
`;
```

- [ ] **Step 3: 增加签名 normalize/equal helper**

```ts
const normalizeSignatureDate = (value: Date | string | null): string => {
  if (value === null) return '';
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? String(ms) : '';
};

const normalizeSignatureCount = (value: number | string | null): number => {
  const normalized = Math.floor(Number(value) || 0);
  return normalized > 0 ? normalized : 0;
};

const loadGeneratedTechniqueSnapshotSignature = async (): Promise<GeneratedTechniqueSnapshotSignature> => {
  const result = await query<GeneratedTechniqueSnapshotSignatureRow>(
    LOAD_GENERATED_TECHNIQUE_SNAPSHOT_SIGNATURE_SQL,
  );
  const row = result.rows[0];
  return {
    publishedTechniqueCount: normalizeSignatureCount(row?.published_technique_count ?? null),
    enabledSkillCount: normalizeSignatureCount(row?.enabled_skill_count ?? null),
    enabledLayerCount: normalizeSignatureCount(row?.enabled_layer_count ?? null),
    techniqueMaxUpdatedAt: normalizeSignatureDate(row?.technique_max_updated_at ?? null),
    skillMaxUpdatedAt: normalizeSignatureDate(row?.skill_max_updated_at ?? null),
    layerMaxUpdatedAt: normalizeSignatureDate(row?.layer_max_updated_at ?? null),
  };
};

const isGeneratedTechniqueSnapshotSignatureEqual = (
  left: GeneratedTechniqueSnapshotSignature | null,
  right: GeneratedTechniqueSnapshotSignature,
): boolean => {
  return left !== null
    && left.publishedTechniqueCount === right.publishedTechniqueCount
    && left.enabledSkillCount === right.enabledSkillCount
    && left.enabledLayerCount === right.enabledLayerCount
    && left.techniqueMaxUpdatedAt === right.techniqueMaxUpdatedAt
    && left.skillMaxUpdatedAt === right.skillMaxUpdatedAt
    && left.layerMaxUpdatedAt === right.layerMaxUpdatedAt;
};
```

- [ ] **Step 4: 在 reload 内部先比对签名**

At the start of `reloadGeneratedTechniqueConfigStoreInternal`:

```ts
    const nextSignature = await loadGeneratedTechniqueSnapshotSignature();
    if (isGeneratedTechniqueSnapshotSignatureEqual(lastGeneratedTechniqueSnapshotSignature, nextSignature)) {
      return;
    }
```

After caches are replaced:

```ts
    lastGeneratedTechniqueSnapshotSignature = nextSignature;
```

In undefined-table branch also add:

```ts
      lastGeneratedTechniqueSnapshotSignature = null;
```

- [ ] **Step 5: 增加签名索引**

In `server/src/services/shared/performanceIndexes.ts`, add constants:

```ts
export const GENERATED_TECHNIQUE_PUBLISHED_UPDATED_INDEX_NAME = 'idx_generated_technique_def_published_updated';
export const GENERATED_SKILL_ENABLED_UPDATED_INDEX_NAME = 'idx_generated_skill_def_enabled_updated';
export const GENERATED_TECHNIQUE_LAYER_ENABLED_UPDATED_INDEX_NAME = 'idx_generated_technique_layer_enabled_updated';
```

Add definitions:

```ts
  {
    name: GENERATED_TECHNIQUE_PUBLISHED_UPDATED_INDEX_NAME,
    createSql: `
      CREATE INDEX IF NOT EXISTS ${GENERATED_TECHNIQUE_PUBLISHED_UPDATED_INDEX_NAME}
      ON generated_technique_def (updated_at DESC, id)
      WHERE is_published = true
        AND enabled = true
    `,
    matchFragments: [
      'generated_technique_def',
      'updated_at DESC',
      'id',
      'is_published = true',
      'enabled = true',
    ],
  },
  {
    name: GENERATED_SKILL_ENABLED_UPDATED_INDEX_NAME,
    createSql: `
      CREATE INDEX IF NOT EXISTS ${GENERATED_SKILL_ENABLED_UPDATED_INDEX_NAME}
      ON generated_skill_def (updated_at DESC, source_id)
      WHERE enabled = true
    `,
    matchFragments: [
      'generated_skill_def',
      'updated_at DESC',
      'source_id',
      'enabled = true',
    ],
  },
  {
    name: GENERATED_TECHNIQUE_LAYER_ENABLED_UPDATED_INDEX_NAME,
    createSql: `
      CREATE INDEX IF NOT EXISTS ${GENERATED_TECHNIQUE_LAYER_ENABLED_UPDATED_INDEX_NAME}
      ON generated_technique_layer (updated_at DESC, technique_id)
      WHERE enabled = true
    `,
    matchFragments: [
      'generated_technique_layer',
      'updated_at DESC',
      'technique_id',
      'enabled = true',
    ],
  },
```

- [ ] **Step 6: 校验预期**

Run:

```powershell
.\node_modules\.bin\tsc.cmd -b
```

Expected: TypeScript build succeeds.

---

### Task 5: 邮件已读 SQL 瘦身

**Files:**
- Modify: `server/src/services/mailService.ts`
- Create: `server/src/services/__tests__/mailReadNarrowSqlPolicy.test.ts`

- [ ] **Step 1: 写静态策略测试**

Create `server/src/services/__tests__/mailReadNarrowSqlPolicy.test.ts`:

```ts
/**
 * 邮件已读窄查询策略测试
 *
 * 作用：锁定 readMail 不再读取附件 JSON 宽字段。
 * 输入/输出：输入为 mailService.ts 源码文本，输出为策略断言。
 * 数据流：readMail -> target_mail 窄字段 -> marked_mail 原子更新 -> unread counter delta。
 * 复用设计说明：已读只影响 unread counter，不复用领取附件的宽行状态读取。
 * 关键边界条件与坑点：
 * 1. readMail 不需要 attach_items / attach_rewards / attach_instance_ids，否则会放大单封已读延迟。
 * 2. 已读成功但原本已读的邮件不能重复扣减 unread counter。
 */
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../mailService.ts', import.meta.url), 'utf8');
const readMailMatch = source.match(/async readMail\([\s\S]*?return \{ success: true, message: '已读' \};/u);
assert.ok(readMailMatch);
const readMailSource = readMailMatch[0];

test('readMail 的 target_mail 不应读取附件宽字段', () => {
  assert.doesNotMatch(readMailSource, /attach_items/u);
  assert.doesNotMatch(readMailSource, /attach_rewards/u);
  assert.doesNotMatch(readMailSource, /attach_instance_ids/u);
  assert.match(readMailSource, /marked_read/u);
});
```

- [ ] **Step 2: 收窄 readMail row type**

In `server/src/services/mailService.ts`, replace `ReadMailTransitionRow` with:

```ts
type ReadMailTransitionRow = {
  recipient_user_id: number | string;
  recipient_character_id: number | string | null;
  read_at: Date | string | null;
  marked_read: boolean;
};
```

- [ ] **Step 3: 收窄 readMail SQL**

In `readMail`, replace the SQL with:

```ts
    const result = await query<ReadMailTransitionRow>(`
      WITH target_mail AS (
        SELECT
          id,
          recipient_user_id,
          recipient_character_id,
          read_at
        FROM mail
        WHERE id = $1
          AND ${this.buildRecipientScopeSql(2, 3)}
          AND deleted_at IS NULL
        LIMIT 1
      ),
      marked_mail AS (
        UPDATE mail
        SET read_at = NOW(),
            updated_at = NOW()
        WHERE id = (
          SELECT id
          FROM target_mail
          WHERE read_at IS NULL
          LIMIT 1
        )
        RETURNING id
      )
      SELECT
        target_mail.recipient_user_id,
        target_mail.recipient_character_id,
        target_mail.read_at,
        EXISTS(SELECT 1 FROM marked_mail) AS marked_read
      FROM target_mail
    `, [mailId, characterId, userId]);
```

- [ ] **Step 4: 直接构造 read counter delta**

Replace:

```ts
    const readState = buildMailCounterStateFromRow(result.rows[0]);
    await this.applyMailCounterDeltaInputs([
      result.rows[0]?.marked_read === true && readState ? buildMailCounterReadDelta(readState) : null,
    ]);
```

with:

```ts
    const row = result.rows[0];
    await this.applyMailCounterDeltaInputs([
      row.marked_read === true
        ? {
            recipientUserId: Number(row.recipient_user_id),
            recipientCharacterId: row.recipient_character_id === null ? null : Number(row.recipient_character_id),
            unreadCountDelta: -1,
          }
        : null,
    ]);
```

- [ ] **Step 5: 校验预期**

Run:

```powershell
.\node_modules\.bin\tsc.cmd -b
```

Expected: TypeScript build succeeds.

---

### Task 6: 总体验证与线上复查

**Files:**
- No source changes.

- [ ] **Step 1: 执行 TypeScript 构建校验**

Run:

```powershell
.\node_modules\.bin\tsc.cmd -b
```

Expected: TypeScript build succeeds.

- [ ] **Step 2: 如果用户明确要求部署，执行服务端构建与 Swarm 更新**

Run only after user confirms deployment:

```powershell
.\docker-build.ps1 latest --server-only
```

Expected: server image builds and pushes successfully.

Then update production stack only for server services, keeping client untouched.

- [ ] **Step 3: 部署后只读复查**

Run on production:

```bash
docker service ls | grep jiuzhou
docker logs --since 5m $(docker ps --filter name=jiuzhou_server -q | head -n 1) | grep slow_http_request | tail -n 20
docker exec $(docker ps --filter name=jiuzhou_redis -q | head -n 1) redis-cli slowlog get 10
```

Expected:
- `jiuzhou_server` and `jiuzhou_server_worker` are `1/1`.
- Redis slowlog no longer shows `KEYS battle:state:*` after restart/recover path.
- `/api/map/.../resources/.../gather` slow logs drop under spam traffic.
- `/api/inventory/reroll-affixes` and `/api/inventory/socket` no longer reload character for bag/warehouse equipment operations.

## 复用与去重说明

- `characterMutationThrottle.ts` 是新的单一限流入口，先被资源采集复用，避免路由或服务内重复拼 Redis key。
- `affectsCharacter` 是装备突变的单一刷新信号，路由层不再重复理解装备位置和属性影响规则。
- 生成功法快照签名集中在 `generatedTechniqueConfigStore.ts`，调用方继续使用既有刷新入口，不新增旁路 API。
- 邮件已读不再复用领取附件的宽字段状态，已读计数直接以窄 row 构造 delta。

## Self-Review

- Spec coverage: 覆盖线上观测的 Redis `KEYS`、采集慢请求、装备操作全量角色重算、AI 生成功法快照宽查询、邮件已读宽 SQL。
- Placeholder scan: 无 TBD/TODO/implement later。
- Type consistency: 新增类型均使用明确字段；计划中不新增 `any` / `unknown`。
