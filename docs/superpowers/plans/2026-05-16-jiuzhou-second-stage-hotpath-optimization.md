# Jiuzhou Second Stage Hotpath Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 继续压低 2026-05-16 线上复查中剩余的 API event loop 抖动、功法读查询、`/api/inventory/use`、战斗推进和奖励结算锁等待。

**Architecture:** 本轮不再扩展服务形态，优先在现有模块内把热路径从重复扫描、重复序列化和过宽锁范围改成索引读取、离线跳过、Redis 批处理与精确锁定。所有优化都沿用项目已有的静态索引工厂、慢日志、Redis pipeline、静态策略测试和 `tsc -b` 校验方式，避免另起一套性能基础设施。

**Tech Stack:** Node.js、TypeScript、Express、PostgreSQL、Redis/ioredis、Docker Swarm、node:test 静态策略测试。

---

## 线上证据

- 服务器资源没有打满：内存可用约 214GiB，磁盘正常，IO wait 接近 0。
- 最近 10 分钟 API 慢请求 187 次，慢操作 102 次。
- `/api/inventory/use` 慢请求 37 次，`itemService.useItem` 慢操作 33 次。
- 战斗链路仍明显：`api/battle-session/advance` 19 次、`dungeon.nextDungeonInstance` 14 次、`battle.finishBattle` 12 次、`battle.persistBattleSnapshotToRedis` 10 次。
- API event loop busy 60 次，最大 utilization 到 1.0，P95 延迟最高 323ms，max delay 552ms。
- PostgreSQL 累计热点里 `generated_technique_*` 宽查询均值高，且线上仍能看到发布 AI 功法触发 2.6s 级请求。
- Worker 没有 event loop 拥塞，但 `battleDropService.settleBattleRewardPlan` 中 `aggregateRewardDeltas` 阶段出现 1.8s；源码显示该阶段包含 `lockCharacterRewardInventoryTargets` 等待时间，当前打点名称掩盖了真实锁等待。
- Redis 旧 `KEYS battle:state:*` 未出现新记录，上一轮 SCAN 改造已生效。

## 当前约束

- 不创建隔离工作区。
- 未经用户明确要求，不执行任何 Git 命令，包括 `git status`、`git diff`、`git commit`。
- 未经用户明确要求，不执行 dev/start/build/test/联调命令。
- 本计划不包含 Git commit 步骤；执行完成后如需提交，必须先获得用户明确授权。
- 代码修改后必须执行：

```powershell
.\node_modules\.bin\tsc.cmd -b
```

- 如需运行测试命令，必须先获得用户明确授权；默认只写静态策略测试并执行 `tsc -b`。

## 文件结构

- Create: `server/src/services/technique/definitionReadModel.ts`  
  集中构建功法定义、技能、层级的只读索引，替代 `techniqueService.ts` 多处 `find/filter/sort`。
- Modify: `server/src/services/techniqueService.ts`  
  改为读取功法读模型；保留 DTO 映射和敏感层级裁剪。
- Modify: `server/src/services/itemService.ts`  
  使用功法读模型和物品使用静态索引，减少 `useItem` 中全量定义扫描；拆分 `loadUseContext` 慢日志。
- Create: `server/src/services/itemUse/staticUseIndex.ts`  
  缓存随机宝石袋候选、可学习功法定义等使用物品阶段需要的静态派生结果。
- Modify: `server/src/services/battle/runtime/ticker.ts`  
  在没有在线接收者时跳过 `battle_state` payload 构建与 WS 派发；保留终态处理与 Redis 持久化规则。
- Modify: `server/src/services/battle/runtime/persistence.ts`  
  将三次 `setex` 改成单个 Redis pipeline，减少战斗快照持久化往返。
- Modify: `server/src/services/battleDropService.ts`  
  将奖励库存锁目标从全部参与者收窄到实际掉落接收者，并单独记录锁等待阶段。
- Test: `server/src/services/__tests__/techniqueReadModelPolicy.test.ts`  
  静态锁定功法读服务不能继续全量扫描。
- Test: `server/src/services/__tests__/itemUseStaticIndexPolicy.test.ts`  
  静态锁定 `useItem` 不再直接扫描全部物品/功法定义。
- Test: `server/src/services/__tests__/battleRealtimeDispatchPolicy.test.ts`  
  静态锁定离线接收者跳过 `battle_state` payload 构建。
- Test: `server/src/services/__tests__/battleRedisPipelinePolicy.test.ts`  
  静态锁定战斗快照使用 Redis pipeline。
- Test: `server/src/services/__tests__/battleRewardInventoryLockScopePolicy.test.ts`  
  静态锁定奖励库存锁只覆盖实际掉落接收者。

---

### Task 1: 功法读模型索引

**Files:**
- Create: `server/src/services/technique/definitionReadModel.ts`
- Modify: `server/src/services/techniqueService.ts`
- Test: `server/src/services/__tests__/techniqueReadModelPolicy.test.ts`

- [ ] **Step 1: 写静态策略测试**

Create `server/src/services/__tests__/techniqueReadModelPolicy.test.ts`:

```ts
/**
 * 功法读模型索引策略测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定功法详情与列表读取统一经过 `definitionReadModel`。
 * 2. 做什么：防止 `techniqueService.ts` 在请求热路径继续对全量定义数组做 find/filter/sort。
 * 3. 不做什么：不启动服务，不访问数据库。
 *
 * 输入 / 输出：
 * - 输入：源码文本。
 * - 输出：静态结构断言。
 *
 * 数据流 / 状态流：
 * staticConfigLoader 缓存数组 -> definitionReadModel 按数组引用构建索引 -> techniqueService 按 id / techniqueId 读取。
 *
 * 复用设计说明：
 * - 复用 `createStaticDefinitionIndexGetter` 的数组引用失效模式，和 battle 静态索引保持一致。
 *
 * 关键边界条件与坑点：
 * 1. 生成功法发布后 staticConfigLoader 会替换数组引用，索引必须随引用变化重建。
 * 2. 伙伴功法详情允许 partner_only，角色可见列表只能使用角色可见过滤。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const techniqueServiceSource = readFileSync(
  new URL('../techniqueService.ts', import.meta.url),
  'utf8',
);
const readModelSource = readFileSync(
  new URL('../technique/definitionReadModel.ts', import.meta.url),
  'utf8',
);

test('techniqueService 应复用 definitionReadModel，不在详情热路径扫描全量定义', () => {
  assert.match(techniqueServiceSource, /from '\.\/technique\/definitionReadModel\.js'/u);
  assert.doesNotMatch(techniqueServiceSource, /getTechniqueDefinitions\(\)\.find/u);
  assert.doesNotMatch(techniqueServiceSource, /getTechniqueLayerDefinitions\(\)\s*\n\s*\.filter/u);
  assert.doesNotMatch(techniqueServiceSource, /getSkillDefinitions\(\)\s*\n\s*\.filter/u);
});

test('definitionReadModel 应按源数组引用重建索引', () => {
  assert.match(readModelSource, /techniqueSource !== techniqueDefinitions/u);
  assert.match(readModelSource, /skillSource !== skillDefinitions/u);
  assert.match(readModelSource, /layerSource !== layerDefinitions/u);
  assert.match(readModelSource, /visibleTechniqueById/u);
  assert.match(readModelSource, /layersByTechniqueId/u);
  assert.match(readModelSource, /skillsByTechniqueId/u);
});
```

- [ ] **Step 2: 新建功法读模型**

Create `server/src/services/technique/definitionReadModel.ts` with these exported getters:

```ts
/**
 * 功法定义读模型索引
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把功法定义、功法层级、技能定义构建成按 id / techniqueId 访问的只读索引。
 * 2. 做什么：为角色功法列表、详情、物品学习功法共用同一套过滤与排序结果。
 * 3. 不做什么：不访问数据库，不映射路由 DTO，不裁剪敏感层级字段。
 *
 * 输入 / 输出：
 * - 输入：`staticConfigLoader` 中已缓存的定义数组。
 * - 输出：按数组引用自动失效的只读索引与已排序列表。
 *
 * 数据流 / 状态流：
 * staticConfigLoader -> 本模块索引快照 -> techniqueService / itemService 热路径复用。
 *
 * 复用设计说明：
 * - 替代 `techniqueService.ts`、`itemService.ts` 中重复的 `getTechniqueDefinitions().find/filter`。
 * - 功法可见性是高频业务变化点，集中在本模块后只维护一次。
 *
 * 关键边界条件与坑点：
 * 1. 缓存失效必须看源数组引用，不能只看长度，否则生成功法内容更新后会读到旧对象。
 * 2. 技能和层级分组必须只包含 enabled 项，避免调用方重复写启用判断。
 */
import {
  getSkillDefinitions,
  getTechniqueDefinitions,
  getTechniqueLayerDefinitions,
  type SkillDefConfig,
  type TechniqueDefConfig,
  type TechniqueLayerConfig,
} from '../staticConfigLoader.js';
import { resolveQualityRankFromName } from '../shared/itemQuality.js';
import { isCharacterVisibleTechniqueDefinition } from '../shared/techniqueUsageScope.js';

type TechniqueReadModelSnapshot = {
  techniqueSource: readonly TechniqueDefConfig[];
  skillSource: readonly SkillDefConfig[];
  layerSource: readonly TechniqueLayerConfig[];
  visibleTechniqueById: ReadonlyMap<string, TechniqueDefConfig>;
  enabledTechniqueById: ReadonlyMap<string, TechniqueDefConfig>;
  visibleTechniqueList: readonly TechniqueDefConfig[];
  layersByTechniqueId: ReadonlyMap<string, readonly TechniqueLayerConfig[]>;
  skillsByTechniqueId: ReadonlyMap<string, readonly SkillDefConfig[]>;
};

let snapshot: TechniqueReadModelSnapshot | null = null;

const getDefinitionId = (value: string): string => value.trim();

const pushGrouped = <T>(
  target: Map<string, T[]>,
  key: string,
  value: T,
): void => {
  const normalizedKey = getDefinitionId(key);
  if (!normalizedKey) return;
  const bucket = target.get(normalizedKey);
  if (bucket) {
    bucket.push(value);
    return;
  }
  target.set(normalizedKey, [value]);
};

const buildSnapshot = (): TechniqueReadModelSnapshot => {
  const techniqueDefinitions = getTechniqueDefinitions();
  const skillDefinitions = getSkillDefinitions();
  const layerDefinitions = getTechniqueLayerDefinitions();
  const visibleTechniqueById = new Map<string, TechniqueDefConfig>();
  const enabledTechniqueById = new Map<string, TechniqueDefConfig>();
  const visibleTechniqueList: TechniqueDefConfig[] = [];
  const layersByTechniqueId = new Map<string, TechniqueLayerConfig[]>();
  const skillsByTechniqueId = new Map<string, SkillDefConfig[]>();

  for (const technique of techniqueDefinitions) {
    if (technique.enabled === false) continue;
    const id = getDefinitionId(technique.id);
    if (!id) continue;
    enabledTechniqueById.set(id, technique);
    if (!isCharacterVisibleTechniqueDefinition(technique)) continue;
    visibleTechniqueById.set(id, technique);
    visibleTechniqueList.push(technique);
  }

  visibleTechniqueList.sort((left, right) => {
    const leftQualityRank = resolveQualityRankFromName(left.quality, 1);
    const rightQualityRank = resolveQualityRankFromName(right.quality, 1);
    return Number(right.sort_weight ?? 0) - Number(left.sort_weight ?? 0)
      || rightQualityRank - leftQualityRank
      || left.id.localeCompare(right.id);
  });

  for (const layer of layerDefinitions) {
    if (layer.enabled === false) continue;
    pushGrouped(layersByTechniqueId, layer.technique_id, layer);
  }
  for (const rows of layersByTechniqueId.values()) {
    rows.sort((left, right) => Number(left.layer) - Number(right.layer));
  }

  for (const skill of skillDefinitions) {
    if (skill.enabled === false) continue;
    if (skill.source_type !== 'technique') continue;
    const sourceId = typeof skill.source_id === 'string' ? skill.source_id : '';
    pushGrouped(skillsByTechniqueId, sourceId, skill);
  }
  for (const rows of skillsByTechniqueId.values()) {
    rows.sort((left, right) => Number(right.sort_weight ?? 0) - Number(left.sort_weight ?? 0) || left.id.localeCompare(right.id));
  }

  return {
    techniqueSource: techniqueDefinitions,
    skillSource: skillDefinitions,
    layerSource: layerDefinitions,
    visibleTechniqueById,
    enabledTechniqueById,
    visibleTechniqueList,
    layersByTechniqueId,
    skillsByTechniqueId,
  };
};

const getTechniqueReadModelSnapshot = (): TechniqueReadModelSnapshot => {
  const techniqueDefinitions = getTechniqueDefinitions();
  const skillDefinitions = getSkillDefinitions();
  const layerDefinitions = getTechniqueLayerDefinitions();
  if (
    snapshot === null
    || snapshot.techniqueSource !== techniqueDefinitions
    || snapshot.skillSource !== skillDefinitions
    || snapshot.layerSource !== layerDefinitions
  ) {
    snapshot = buildSnapshot();
  }
  return snapshot;
};

export const getVisibleTechniqueDefinitionsSorted = (): readonly TechniqueDefConfig[] => {
  return getTechniqueReadModelSnapshot().visibleTechniqueList;
};

export const getVisibleTechniqueDefinitionById = (techniqueId: string): TechniqueDefConfig | null => {
  return getTechniqueReadModelSnapshot().visibleTechniqueById.get(getDefinitionId(techniqueId)) ?? null;
};

export const getEnabledTechniqueDefinitionById = (techniqueId: string): TechniqueDefConfig | null => {
  return getTechniqueReadModelSnapshot().enabledTechniqueById.get(getDefinitionId(techniqueId)) ?? null;
};

export const getEnabledTechniqueLayersByTechniqueId = (techniqueId: string): readonly TechniqueLayerConfig[] => {
  return getTechniqueReadModelSnapshot().layersByTechniqueId.get(getDefinitionId(techniqueId)) ?? [];
};

export const getEnabledTechniqueSkillsByTechniqueId = (techniqueId: string): readonly SkillDefConfig[] => {
  return getTechniqueReadModelSnapshot().skillsByTechniqueId.get(getDefinitionId(techniqueId)) ?? [];
};
```

- [ ] **Step 3: 改造 `techniqueService.ts` 读取入口**

Replace direct `getTechniqueDefinitions/getSkillDefinitions/getTechniqueLayerDefinitions` imports with:

```ts
import {
  getEnabledTechniqueDefinitionById,
  getEnabledTechniqueLayersByTechniqueId,
  getEnabledTechniqueSkillsByTechniqueId,
  getVisibleTechniqueDefinitionById,
  getVisibleTechniqueDefinitionsSorted,
} from './technique/definitionReadModel.js';
```

Change:

```ts
const rows = getTechniqueDefinitions()
  .filter(...)
  .map(...)
  .sort(...);
```

to:

```ts
const rows = getVisibleTechniqueDefinitionsSorted().map((entry) => mapTechniqueDefRow(entry));
```

Change `getTechniqueDefById` to:

```ts
export const getTechniqueDefById = async (techniqueId: string): Promise<TechniqueDefRow | null> => {
  const entry = getVisibleTechniqueDefinitionById(techniqueId);
  return entry ? mapTechniqueDefRow(entry) : null;
};
```

Change layer and skill source reads to:

```ts
const rows = getEnabledTechniqueLayersByTechniqueId(techniqueId)
  .map((entry) => ({
    technique_id: entry.technique_id,
    layer: Number(entry.layer),
    cost_spirit_stones: scaleTechniqueBaseCostByQuality(Number(entry.cost_spirit_stones ?? 0), qualityMultiplier),
    cost_exp: scaleTechniqueBaseCostByQuality(Number(entry.cost_exp ?? 0), qualityMultiplier),
    cost_materials: Array.isArray(entry.cost_materials) ? entry.cost_materials : [],
    passives: Array.isArray(entry.passives) ? entry.passives : [],
    unlock_skill_ids: Array.isArray(entry.unlock_skill_ids) ? entry.unlock_skill_ids : [],
    upgrade_skill_ids: Array.isArray(entry.upgrade_skill_ids) ? entry.upgrade_skill_ids : [],
    required_realm: typeof entry.required_realm === 'string' ? entry.required_realm : null,
    required_quest_id: typeof entry.required_quest_id === 'string' ? entry.required_quest_id : null,
    layer_desc: typeof entry.layer_desc === 'string' ? entry.layer_desc : null,
  } satisfies TechniqueLayerRow));
```

and:

```ts
return getEnabledTechniqueSkillsByTechniqueId(techniqueId)
  .map((entry) => ({
    id: entry.id,
    code: entry.code ?? null,
    name: entry.name,
    description: entry.description ?? null,
    icon: entry.icon ?? null,
    source_type: entry.source_type,
    source_id: entry.source_id ?? null,
    cost_lingqi: Number(entry.cost_lingqi ?? 0),
    cost_lingqi_rate: Number(entry.cost_lingqi_rate ?? 0),
    cost_qixue: Number(entry.cost_qixue ?? 0),
    cost_qixue_rate: Number(entry.cost_qixue_rate ?? 0),
    cooldown: Number(entry.cooldown ?? 0),
    target_type: entry.target_type,
    target_count: Number(entry.target_count ?? 1),
    damage_type: entry.damage_type ?? null,
    element: entry.element ?? 'none',
    effects: Array.isArray(entry.effects) ? entry.effects : [],
    trigger_type: resolveSkillTriggerType({
      triggerType: entry.trigger_type,
      effects: Array.isArray(entry.effects)
        ? (entry.effects as Array<{ type?: string; buffKind?: string }>)
        : [],
    }),
    conditions: entry.conditions ?? null,
    ai_priority: Number(entry.ai_priority ?? 50),
    ai_conditions: entry.ai_conditions ?? null,
    upgrades: entry.upgrades ?? [],
    sort_weight: Number(entry.sort_weight ?? 0),
    version: Number(entry.version ?? 1),
    enabled: true,
  } satisfies SkillDefRow));
```

- [ ] **Step 4: 校验**

Run:

```powershell
.\node_modules\.bin\tsc.cmd -b
```

Expected: exit code 0.

---

### Task 2: 物品使用静态索引与慢日志拆分

**Files:**
- Create: `server/src/services/itemUse/staticUseIndex.ts`
- Modify: `server/src/services/itemService.ts`
- Test: `server/src/services/__tests__/itemUseStaticIndexPolicy.test.ts`

- [ ] **Step 1: 写静态策略测试**

Create `server/src/services/__tests__/itemUseStaticIndexPolicy.test.ts`:

```ts
/**
 * 使用物品静态索引策略测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定 `itemService.useItem` 的随机宝石袋和功法学习不再全量扫描静态定义。
 * 2. 做什么：锁定 `loadUseContext` 被拆成更细阶段，后续线上慢日志能定位是境界、角色快照还是库存锁。
 * 3. 不做什么：不调用真实物品使用流程，不访问数据库。
 *
 * 输入 / 输出：
 * - 输入：源码文本。
 * - 输出：静态策略断言。
 *
 * 数据流 / 状态流：
 * staticConfigLoader -> staticUseIndex -> itemService.useItem -> 奖励与角色快照。
 *
 * 复用设计说明：
 * - 随机宝石候选和功法定义读取是多个物品效果共享的静态派生结果，集中索引后避免每次使用重复扫描。
 *
 * 关键边界条件与坑点：
 * 1. 宝石候选索引必须按 item_def 数组引用失效，否则配置热更新后候选池不变。
 * 2. 生成功法学习必须复用功法读模型，不能自己再维护一套 visibility 规则。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const itemServiceSource = readFileSync(new URL('../itemService.ts', import.meta.url), 'utf8');
const staticUseIndexSource = readFileSync(new URL('../itemUse/staticUseIndex.ts', import.meta.url), 'utf8');

test('useItem 不应直接扫描全部物品定义生成随机宝石候选', () => {
  assert.match(itemServiceSource, /getRandomGemItemDefinitionIds/u);
  assert.doesNotMatch(itemServiceSource, /getItemDefinitions\(\)\s*\n\s*\.filter/u);
});

test('useItem 应通过功法读模型读取可见功法', () => {
  assert.match(itemServiceSource, /getVisibleTechniqueDefinitionById/u);
  assert.doesNotMatch(itemServiceSource, /getTechniqueDefinitions\(\)\.find/u);
});

test('staticUseIndex 应按物品定义数组引用重建缓存', () => {
  assert.match(staticUseIndexSource, /source !== itemDefinitions/u);
  assert.match(staticUseIndexSource, /randomGemIdsByScope/u);
});

test('useItem 应拆分 loadUseContext 慢日志', () => {
  assert.match(itemServiceSource, /slowLogger\.mark\('loadRealmSnapshot'/u);
  assert.match(itemServiceSource, /slowLogger\.mark\('loadComputedBefore'/u);
  assert.match(itemServiceSource, /slowLogger\.mark\('lockInventoryMutex'/u);
});
```

- [ ] **Step 2: 新建 `staticUseIndex.ts`**

Create `server/src/services/itemUse/staticUseIndex.ts`:

```ts
/**
 * 使用物品静态派生索引
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：缓存使用物品阶段需要的静态候选集合，例如随机宝石袋候选。
 * 2. 做什么：按物品定义数组引用自动失效，避免每次使用物品都扫描全量 item_def。
 * 3. 不做什么：不处理角色库存、不生成掉落、不读写数据库。
 *
 * 输入 / 输出：
 * - 输入：`getItemDefinitions()` 返回的静态物品定义数组。
 * - 输出：按子分类和等级范围过滤后的物品 ID 列表。
 *
 * 数据流 / 状态流：
 * item_def 缓存 -> 本模块构建候选索引 -> itemService.useItem 按参数读取候选 ID。
 *
 * 复用设计说明：
 * - 随机宝石袋是高频消耗品，候选集合由静态配置决定，集中缓存可避免每次使用重复 filter/map。
 *
 * 关键边界条件与坑点：
 * 1. 子分类集合不同会产生不同候选范围，缓存 key 必须包含排序后的子分类和等级边界。
 * 2. 返回值只包含启用宝石定义，调用方不再额外兜底扫描全表。
 */
import { getItemDefinitions } from '../staticConfigLoader.js';
import { getGemLevel, isGemItemDefinition } from '../shared/gemItemSemantics.js';

type RandomGemScope = {
  subCategories: readonly string[];
  minLevel: number;
  maxLevel: number;
};

type StaticUseIndexSnapshot = {
  source: ReturnType<typeof getItemDefinitions>;
  randomGemIdsByScope: Map<string, readonly string[]>;
};

let snapshot: StaticUseIndexSnapshot | null = null;

const getSnapshot = (): StaticUseIndexSnapshot => {
  const itemDefinitions = getItemDefinitions();
  if (snapshot?.source !== itemDefinitions) {
    snapshot = {
      source: itemDefinitions,
      randomGemIdsByScope: new Map(),
    };
  }
  return snapshot;
};

const buildRandomGemScopeKey = (scope: RandomGemScope): string => {
  return [
    scope.subCategories.map((value) => value.trim()).filter(Boolean).sort().join(','),
    Math.max(1, Math.floor(scope.minLevel)),
    Math.max(1, Math.floor(scope.maxLevel)),
  ].join('|');
};

export const getRandomGemItemDefinitionIds = (scope: RandomGemScope): readonly string[] => {
  const current = getSnapshot();
  const cacheKey = buildRandomGemScopeKey(scope);
  const cached = current.randomGemIdsByScope.get(cacheKey);
  if (cached) return cached;

  const subCategorySet = new Set(scope.subCategories.map((value) => value.trim()).filter(Boolean));
  const minLevel = Math.max(1, Math.floor(scope.minLevel));
  const maxLevel = Math.max(minLevel, Math.floor(scope.maxLevel));
  const ids: string[] = [];
  for (const itemDef of current.source) {
    if (itemDef.enabled === false) continue;
    if (!isGemItemDefinition(itemDef)) continue;
    const subCategory = String(itemDef.sub_category || '').trim();
    if (!subCategorySet.has(subCategory)) continue;
    const gemLevel = getGemLevel(itemDef);
    if (gemLevel === null || gemLevel < minLevel || gemLevel > maxLevel) continue;
    const id = String(itemDef.id || '').trim();
    if (id) ids.push(id);
  }
  current.randomGemIdsByScope.set(cacheKey, ids);
  return ids;
};
```

- [ ] **Step 3: 修改 `itemService.ts` 的静态扫描**

Add imports:

```ts
import { getRandomGemItemDefinitionIds } from './itemUse/staticUseIndex.js';
import { getVisibleTechniqueDefinitionById } from './technique/definitionReadModel.js';
```

Replace random gem candidate scan:

```ts
const subCategorySet = new Set(subCategories);
const gemIds = getItemDefinitions()
  .filter(...)
  .map(...)
  .filter(...);
```

with:

```ts
const gemIds = getRandomGemItemDefinitionIds({
  subCategories,
  minLevel,
  maxLevel,
});
```

Replace both technique learning lookups:

```ts
const techniqueDef = getTechniqueDefinitions().find((entry) => (
  entry.id === techniqueId &&
  entry.enabled !== false &&
  isCharacterVisibleTechniqueDefinition(entry)
)) ?? null;
```

with:

```ts
const techniqueDef = getVisibleTechniqueDefinitionById(techniqueId);
```

and for generated technique:

```ts
const techniqueDef = getVisibleTechniqueDefinitionById(generatedTechniqueId);
```

- [ ] **Step 4: 拆分 `loadUseContext` 慢日志**

Change the top of `useItem` from one coarse mark:

```ts
const realmSnapshot = await loadCharacterRealmSnapshot(characterId);
...
const computedBefore = await getCharacterComputedByCharacterId(characterId);
...
slowLogger.mark('loadUseContext');
```

to:

```ts
const realmSnapshot = await loadCharacterRealmSnapshot(characterId);
slowLogger.mark('loadRealmSnapshot');
if (!realmSnapshot) {
  return { success: false, message: '角色不存在' };
}

const computedBefore = await getCharacterComputedByCharacterId(characterId);
slowLogger.mark('loadComputedBefore');
if (!computedBefore) {
  return { success: false, message: '角色数据异常' };
}
```

Keep `lockInventoryMutex` mark unchanged so线上可以区分角色快照慢和库存锁等待慢。

- [ ] **Step 5: 校验**

Run:

```powershell
.\node_modules\.bin\tsc.cmd -b
```

Expected: exit code 0.

---

### Task 3: 战斗实时推送离线跳过与 Redis pipeline

**Files:**
- Modify: `server/src/services/battle/runtime/ticker.ts`
- Modify: `server/src/services/battle/runtime/persistence.ts`
- Test: `server/src/services/__tests__/battleRealtimeDispatchPolicy.test.ts`
- Test: `server/src/services/__tests__/battleRedisPipelinePolicy.test.ts`

- [ ] **Step 1: 写战斗实时派发策略测试**

Create `server/src/services/__tests__/battleRealtimeDispatchPolicy.test.ts`:

```ts
/**
 * 战斗实时派发热路径策略测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定无在线接收者时不构建 battle_state delta payload。
 * 2. 做什么：保留 battle_finished / battle_abandoned 终态消息的原有分支。
 * 3. 不做什么：不启动 socket，不创建真实战斗。
 *
 * 输入 / 输出：
 * - 输入：ticker.ts 源码文本。
 * - 输出：静态策略断言。
 *
 * 数据流 / 状态流：
 * battle tick -> emitBattleUpdate -> 在线接收者判断 -> payload 构建 / 跳过。
 *
 * 复用设计说明：
 * - 在线判断直接复用 `gameServer.isUserOnline`，不引入新的在线状态存储。
 *
 * 关键边界条件与坑点：
 * 1. 离线跳过只能用于 `battle_state`，终态仍由结算路径处理。
 * 2. Redis 持久化不能依赖是否在线，否则离线恢复会丢状态。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../battle/runtime/ticker.ts', import.meta.url), 'utf8');

test('battle_state 无在线接收者时应跳过 payload 构建', () => {
  assert.match(source, /hasOnlineBattleUpdateRecipient/u);
  assert.match(source, /kind === "battle_state"/u);
  assert.match(source, /outcome: "no_online_recipient"/u);
  assert.match(source, /patchBattleUpdatePayload/u);
});

test('离线跳过不得作用于终态消息', () => {
  assert.match(source, /kind !== "battle_finished"/u);
  assert.match(source, /kind !== "battle_abandoned"/u);
});
```

- [ ] **Step 2: 写 Redis pipeline 策略测试**

Create `server/src/services/__tests__/battleRedisPipelinePolicy.test.ts`:

```ts
/**
 * 战斗 Redis 快照批处理策略测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定战斗快照三段 state/participants/static 使用同一个 pipeline 写入。
 * 2. 不做什么：不连接 Redis，不序列化真实战斗。
 *
 * 输入 / 输出：
 * - 输入：persistence.ts 源码文本。
 * - 输出：静态策略断言。
 *
 * 数据流 / 状态流：
 * saveBattleToRedis -> pending queue -> persistBattleSnapshotToRedis -> redis.pipeline().setex().exec()。
 *
 * 复用设计说明：
 * - 项目其他 Redis 批处理已使用 `redis.pipeline()`，这里沿用同一模式。
 *
 * 关键边界条件与坑点：
 * 1. pipeline 失败必须抛出，不能静默吞掉快照持久化异常。
 * 2. 三个 key 的 TTL 必须保持一致，不能因批处理改变恢复语义。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../battle/runtime/persistence.ts', import.meta.url), 'utf8');

test('persistBattleSnapshotToRedis 应使用 Redis pipeline', () => {
  assert.match(source, /const pipeline = redis\.pipeline\(\)/u);
  assert.match(source, /pipeline\.setex/u);
  assert.match(source, /await pipeline\.exec\(\)/u);
  assert.doesNotMatch(source, /Promise\.all\(tasks\)/u);
});
```

- [ ] **Step 3: 修改 `emitBattleUpdate` 离线跳过**

In `server/src/services/battle/runtime/ticker.ts`, add:

```ts
const hasOnlineBattleUpdateRecipient = (
  userIds: readonly number[],
  gameServer: ReturnType<typeof getGameServer>,
): boolean => {
  for (const userId of userIds) {
    if (!Number.isFinite(userId)) continue;
    if (gameServer.isUserOnline(userId)) return true;
  }
  return false;
};
```

In `emitBattleUpdate`, compute `gameServer` before payload patching and insert:

```ts
const gameServer = getGameServer();
const hasOnlineRecipient = hasOnlineBattleUpdateRecipient(participants, gameServer);
if (
  kind === "battle_state"
  && !hasOnlineRecipient
  && kind !== "battle_finished"
  && kind !== "battle_abandoned"
) {
  const engine = activeBattles.get(battleId);
  if (engine && shouldPersistBattleToRedis(battleId)) {
    const now = Date.now();
    const lastSavedAt = battleLastRedisSavedAt.get(battleId) ?? 0;
    if (now - lastSavedAt >= BATTLE_REDIS_SAVE_INTERVAL_MS) {
      battleLastRedisSavedAt.set(battleId, now);
      saveBattleToRedis(battleId, engine, participants);
      slowLogger.mark("queueBattleRedisSave", { shouldSave: true });
    }
  }
  slowLogger.flush({
    participantCount: participants.length,
    persisted: engine !== undefined,
    outcome: "no_online_recipient",
  });
  return;
}
```

Then reuse the already created `gameServer` in the existing emit loop; do not call `getGameServer()` a second time.

- [ ] **Step 4: 修改 Redis 持久化为 pipeline**

In `server/src/services/battle/runtime/persistence.ts`, replace:

```ts
const tasks: Promise<unknown>[] = [
  redis.setex(...),
  redis.setex(...),
  redis.setex(...),
];
await Promise.all(tasks);
```

with:

```ts
const pipeline = redis.pipeline();
pipeline.setex(
  `${REDIS_BATTLE_KEY_PREFIX}${battleId}`,
  REDIS_BATTLE_TTL_SECONDS,
  dynamicStateJson,
);
pipeline.setex(
  `${REDIS_BATTLE_PARTICIPANTS_PREFIX}${battleId}`,
  REDIS_BATTLE_TTL_SECONDS,
  participantsJson,
);
pipeline.setex(
  `${REDIS_BATTLE_STATIC_PREFIX}${battleId}`,
  REDIS_BATTLE_TTL_SECONDS,
  staticStateJson,
);
const results = await pipeline.exec();
if (!results) {
  throw new Error(`保存战斗快照到 Redis 失败: ${battleId}`);
}
for (const [error] of results) {
  if (error) throw error;
}
```

Keep the existing `slowLogger.mark("persistRedis")` after the pipeline result validation.

- [ ] **Step 5: 校验**

Run:

```powershell
.\node_modules\.bin\tsc.cmd -b
```

Expected: exit code 0.

---

### Task 4: 战斗奖励库存锁范围收窄

**Files:**
- Modify: `server/src/services/battleDropService.ts`
- Test: `server/src/services/__tests__/battleRewardInventoryLockScopePolicy.test.ts`

- [ ] **Step 1: 写静态策略测试**

Create `server/src/services/__tests__/battleRewardInventoryLockScopePolicy.test.ts`:

```ts
/**
 * 战斗奖励库存锁范围策略测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定战斗掉落结算只锁实际掉落接收者，不再锁全部参与者。
 * 2. 做什么：锁定慢日志单独记录 `lockRewardInventoryTargets`，避免把锁等待误记为聚合耗时。
 * 3. 不做什么：不调用真实发奖，不访问数据库。
 *
 * 输入 / 输出：
 * - 输入：battleDropService.ts 源码文本。
 * - 输出：静态策略断言。
 *
 * 数据流 / 状态流：
 * BattleRewardSettlementPlan.drops -> resolveBattleDropInventoryTargetIds -> lockCharacterRewardInventoryTargets。
 *
 * 复用设计说明：
 * - 角色 ID 规范化继续复用 `normalizeCharacterRewardTargetIds`，只改变输入来源。
 *
 * 关键边界条件与坑点：
 * 1. 只有掉落需要库存锁；纯经验/银两奖励不应锁库存。
 * 2. 自动分解设置也只需要读取掉落接收者，不能继续按全部参与者查询。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../battleDropService.ts', import.meta.url), 'utf8');

test('战斗奖励库存锁应只覆盖实际掉落接收者', () => {
  assert.match(source, /resolveBattleDropInventoryTargetIds/u);
  assert.match(source, /plan\.drops\.map\(\(drop\) => Number\(drop\.receiverCharacterId\)\)/u);
  assert.doesNotMatch(source, /requiresInventoryMutation[\s\S]{0,220}plan\.perPlayerRewards\.map/u);
});

test('锁等待应有独立慢日志阶段', () => {
  assert.match(source, /slowLogger\.mark\('lockRewardInventoryTargets'/u);
  assert.match(source, /inventoryTargetCount/u);
});
```

- [ ] **Step 2: 增加锁目标解析函数**

In `server/src/services/battleDropService.ts`, near settlement helpers, add:

```ts
const resolveBattleDropInventoryTargetIds = (
  plan: BattleRewardSettlementPlan,
): number[] => {
  return normalizeCharacterRewardTargetIds(
    plan.drops.map((drop) => Number(drop.receiverCharacterId)),
  );
};
```

- [ ] **Step 3: 收窄库存锁目标与自动分解设置读取**

Change:

```ts
const participantCharacterIds = normalizeCharacterRewardTargetIds(
  plan.perPlayerRewards.map((reward) => Number(reward.characterId)),
);
const requiresInventoryMutation = plan.drops.length > 0;
```

to:

```ts
const inventoryTargetCharacterIds = resolveBattleDropInventoryTargetIds(plan);
const requiresInventoryMutation = inventoryTargetCharacterIds.length > 0;
```

Change:

```ts
if (requiresInventoryMutation && participantCharacterIds.length > 0) {
  await lockCharacterRewardInventoryTargets(participantCharacterIds);
}
```

to:

```ts
if (requiresInventoryMutation) {
  await lockCharacterRewardInventoryTargets(inventoryTargetCharacterIds);
  slowLogger.mark('lockRewardInventoryTargets', {
    inventoryTargetCount: inventoryTargetCharacterIds.length,
  });
}
```

Change auto-disassemble query input from `participantCharacterIds` to `inventoryTargetCharacterIds`:

```ts
if (requiresInventoryMutation) {
  const settingResult = await query(
    `
      SELECT id, auto_disassemble_enabled, auto_disassemble_rules
      FROM characters
      WHERE id = ANY($1)
    `,
    [inventoryTargetCharacterIds],
  );
  ...
}
```

Keep reward delta aggregation over `plan.perPlayerRewards`; only the inventory lock and auto-disassemble settings use the narrowed target list.

- [ ] **Step 4: 校验**

Run:

```powershell
.\node_modules\.bin\tsc.cmd -b
```

Expected: exit code 0.

---

## Execution Order

1. Task 1 first: 功法详情和状态接口已经在线上形成 PostgreSQL/CPU 热点，索引化收益直接。
2. Task 2 second: `/api/inventory/use` 是当前最高频慢请求，先消除静态扫描并拆细慢日志。
3. Task 3 third: 战斗实时链路会造成 event loop 批量抖动，离线跳过和 pipeline 对 API 进程最直接。
4. Task 4 fourth: Worker 结算不拥塞 event loop，但锁等待会反向影响玩家写操作，锁范围需要收窄。

## Verification

每个任务完成后运行：

```powershell
.\node_modules\.bin\tsc.cmd -b
```

部署后只读复查：

```powershell
ssh root@192.168.99.110 "docker service logs --since 10m jiuzhou_server 2>&1 | grep -Ei 'slow http request|slow operation|event loop busy' | tail -n 120"
```

预期指标：

- `/api/inventory/use` 慢请求占比下降。
- `itemService.useItem` 新慢日志能区分 `loadRealmSnapshot`、`loadComputedBefore`、`lockInventoryMutex`。
- `battle.persistBattleSnapshotToRedis` 次数和耗时下降，Redis 慢日志不出现新 `KEYS battle:state:*`。
- `battle.emitBattleUpdate` 出现 `outcome=no_online_recipient`，且不伴随 payload 构建慢日志。
- `battleDropService.settleBattleRewardPlan` 的 `aggregateRewardDeltas` 不再吞锁等待，新增 `lockRewardInventoryTargets` 能反映真实锁竞争。

## Self-Review

- Spec coverage: 覆盖当前线上四个主热点：功法读、物品使用、战斗实时、奖励结算锁等待。
- Placeholder scan: 未发现禁用占位词。
- Type consistency: 新增函数名在测试和实现步骤中保持一致：`getRandomGemItemDefinitionIds`、`getVisibleTechniqueDefinitionById`、`hasOnlineBattleUpdateRecipient`、`resolveBattleDropInventoryTargetIds`。
- Constraint check: 未包含 Git 写操作；未要求 dev/start/build/test；所有代码改动后的校验统一为 `.\node_modules\.bin\tsc.cmd -b`。
