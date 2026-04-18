import { query, withTransaction } from '../config/database.js';
import type { PoolClient } from 'pg';
import { ensureMainQuestProgressForNewChapters } from './mainQuest/index.js';
import { updateAchievementProgressBatch } from './achievement/progress.js';
import { Transactional } from '../decorators/transactional.js';
import { BusinessError } from '../middleware/BusinessError.js';
import { updateSectionProgressByEventsBatch } from './mainQuest/progressUpdater.js';
import type { MainQuestProgressEvent } from './mainQuest/types.js';
import {
  getDungeonDefinitions,
  getDungeonDifficultyById,
  getDungeonDifficultiesByDungeonId,
  getDungeonStagesByDifficultyId,
  getDungeonWavesByStageId,
  getMainQuestChapterById,
  getMainQuestSectionById,
  getMapDefinitions,
  getNpcDefinitions,
  getTalkTreeDefinitions,
} from './staticConfigLoader.js';
import {
  getStaticTaskDefinitions,
  getTaskDefinitionById,
  getTaskDefinitionsByIds,
  getTaskDefinitionsByNpcIds,
  type TaskDefinition,
} from './taskDefinitionService.js';
import { getCharacterIdByUserId as getCharacterIdByUserIdShared } from './shared/characterId.js';
import {
  applyCharacterRewardDeltas,
  createCharacterRewardDelta,
  mergeCharacterRewardDelta,
  type CharacterRewardDelta,
} from './shared/characterRewardSettlement.js';
import {
  getRewardCurrencyDisplayName,
  resolveRewardItemDisplayMeta,
  resolveRewardItemDisplayMetaMap,
  type RewardItemDisplayMeta,
} from './shared/rewardDisplay.js';
import { assertServiceSuccess } from './shared/assertServiceSuccess.js';
import { resolveNpcTalkGreetingLines } from './shared/npcTalkGreeting.js';
import {
  getTaskStaticIndex,
  normalizeTaskObjectives,
} from './shared/taskStaticIndex.js';
import { buildTaskRecurringUnlockState } from './shared/taskRecurringUnlock.js';
import { notifyTaskOverviewUpdate } from './taskOverviewPush.js';
import { createScopedLogger } from '../utils/logger.js';
import {
  collectMatchedRecurringTaskIds,
  objectiveMatchesTaskEvent,
  type CharacterTaskRealmState,
  type TaskEvent,
  type TaskObjectiveLike,
} from './shared/taskRecurringEventMatcher.js';
import {
  bufferCharacterProgressDeltaFields,
  claimCharacterProgressDelta,
  finalizeClaimedCharacterProgressDelta,
  listDirtyCharacterIdsForProgressDelta,
  loadClaimedCharacterProgressDeltaHash,
  restoreClaimedCharacterProgressDelta,
  type CharacterProgressDeltaField,
} from './shared/characterProgressDeltaStore.js';
import { enqueueCharacterItemGrant } from './shared/characterItemGrantDeltaService.js';

export type TaskCategory = 'main' | 'side' | 'daily' | 'event';

export type TaskStatus = 'ongoing' | 'turnin' | 'claimable' | 'completed';

export type TaskObjectiveDto = {
  id: string;
  type: string;
  text: string;
  done: number;
  target: number;
  params?: Record<string, unknown>;
  mapName: string | null;
  mapNameType: 'map' | 'dungeon' | null;
};

export type TaskRewardDto =
  | { type: 'silver'; name: string; amount: number }
  | { type: 'spirit_stones'; name: string; amount: number }
  | { type: 'item'; itemDefId: string; name: string; icon: string | null; amount: number; amountMax?: number };

export type TaskOverviewDto = {
  id: string;
  category: TaskCategory;
  title: string;
  realm: string;
  giverNpcId: string | null;
  mapId: string | null;
  mapName: string | null;
  roomId: string | null;
  status: TaskStatus;
  tracked: boolean;
  description: string;
  objectives: TaskObjectiveDto[];
  rewards: TaskRewardDto[];
};

export type TaskOverviewSummaryDto = Pick<
  TaskOverviewDto,
  'id' | 'category' | 'mapId' | 'roomId' | 'status' | 'tracked'
>;

export type BountyTaskSourceType = 'daily' | 'player';

export type BountyTaskOverviewDto = Omit<TaskOverviewDto, 'category'> & {
  category: 'bounty';
  bountyInstanceId: number;
  sourceType: BountyTaskSourceType;
  expiresAt: string | null;
  remainingSeconds: number | null;
};

export type BountyTaskOverviewSummaryDto = {
  id: string;
  status: TaskStatus;
  sourceType: BountyTaskSourceType;
  expiresAt: string | null;
  remainingSeconds: number | null;
};

type RawReward = {
  type?: unknown;
  item_def_id?: unknown;
  qty?: unknown;
  qty_min?: unknown;
  qty_max?: unknown;
  amount?: unknown;
};

type RawObjective = TaskObjectiveLike;

type RecurringTaskResetPlan = {
  autoAcceptTaskIds: string[];
  dailyTaskIds: string[];
  eventTaskIds: string[];
};

type RecurringTaskResetInflightEntry = {
  promise: Promise<void>;
  realmStateKey: string | null;
};

type TaskProgressRecord = Record<string, number>;

type TaskOverviewSourceRow = {
  id: string;
  category: TaskCategory;
  title: string;
  realm: string;
  giverNpcId: string | null;
  mapId: string | null;
  roomId: string | null;
  description: string;
  objectives: RawObjective[];
  rewards: RawReward[];
  progressStatus: string | null;
  tracked: boolean;
  progress: TaskProgressRecord | null;
};

type BountyTaskOverviewSourceRow = {
  taskId: string;
  bountyInstanceId: number;
  sourceType: BountyTaskSourceType;
  title: string;
  description: string;
  expiresAt: string | null;
  extraSpiritStonesReward: number;
  extraSilverReward: number;
  progressStatus: string | null;
  tracked: boolean;
  progress: TaskProgressRecord | null;
  taskDef: TaskDefinition;
};

const taskProgressDeltaLogger = createScopedLogger('task.progressDelta');
const TASK_PROGRESS_DELTA_FLUSH_INTERVAL_MS = 1_000;
const TASK_PROGRESS_DELTA_FLUSH_BATCH_LIMIT = 200;
let taskProgressDeltaFlushTimer: ReturnType<typeof setInterval> | null = null;
let taskProgressDeltaFlushInFlight: Promise<void> | null = null;

const asNonEmptyString = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s : null;
};

const asFiniteNonNegativeInt = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
};

const resolveRewardQtyRange = (reward: RawReward): { min: number; max: number } => {
  const fixedQty = asFiniteNonNegativeInt(reward?.qty, 0);
  if (fixedQty > 0) return { min: fixedQty, max: fixedQty };

  const minQty = Math.max(1, asFiniteNonNegativeInt(reward?.qty_min, 1));
  const maxQty = Math.max(minQty, asFiniteNonNegativeInt(reward?.qty_max, minQty));
  return { min: minQty, max: maxQty };
};

const rollRangeIntInclusive = (min: number, max: number): number => {
  if (max <= min) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
};

export const getCharacterIdByUserId = async (userId: number): Promise<number | null> => {
  return getCharacterIdByUserIdShared(userId);
};

const normalizeTaskCategory = (v: unknown): TaskCategory | null => {
  const s = asNonEmptyString(v);
  if (!s) return null;
  if (s === 'main' || s === 'side' || s === 'daily' || s === 'event') return s;
  return null;
};

const mapProgressStatusToUiStatus = (v: unknown): TaskStatus => {
  const s = asNonEmptyString(v) || 'ongoing';
  if (s === 'turnin') return 'turnin';
  if (s === 'claimable') return 'claimable';
  if (s === 'completed' || s === 'claimed') return 'completed';
  return 'ongoing';
};

const parseObjectives = (objectives: unknown): RawObjective[] => (Array.isArray(objectives) ? (objectives as RawObjective[]) : []);

const parseRewards = (rewards: unknown): RawReward[] => (Array.isArray(rewards) ? (rewards as RawReward[]) : []);

/** 根据 mapId 从地图定义中查找地图名称 */
const resolveMapName = (mapId: string | null): string | null => {
  if (!mapId) return null;
  const map = getMapDefinitions().find((m) => m.id === mapId);
  return map?.name ?? null;
};

/**
 * 从所有副本定义中构建 dungeon_id → 副本名称 的缓存
 * 用于让任务目标直接展示真实副本名，而不是笼统的“秘境”
 */
let dungeonNameCache: Map<string, string> | null = null;

const buildDungeonNameCache = (): Map<string, string> => {
  if (dungeonNameCache) return dungeonNameCache;
  const cache = new Map<string, string>();
  for (const dungeon of getDungeonDefinitions()) {
    if (!dungeon.id || !dungeon.name) continue;
    cache.set(dungeon.id, dungeon.name);
  }
  dungeonNameCache = cache;
  return cache;
};

/**
 * 从 map_def.json 的房间数据中构建 entity_id → 地图名称 的缓存
 * 用于将怪物/资源 ID 解析到其所在的地图
 */
let entityMapNameCache: Map<string, string> | null = null;

const buildEntityMapNameCache = (): Map<string, string> => {
  if (entityMapNameCache) return entityMapNameCache;
  const cache = new Map<string, string>();
  const maps = getMapDefinitions();
  for (const map of maps) {
    const rooms = map.rooms as Array<{
      monsters?: Array<{ monster_def_id: string }>;
      resources?: Array<{ resource_id: string }>;
    }> | undefined;
    if (!Array.isArray(rooms)) continue;
    for (const room of rooms) {
      if (Array.isArray(room.monsters)) {
        for (const m of room.monsters) {
          if (m.monster_def_id && !cache.has(m.monster_def_id)) {
            cache.set(m.monster_def_id, map.name);
          }
        }
      }
      if (Array.isArray(room.resources)) {
        for (const r of room.resources) {
          if (r.resource_id && !cache.has(r.resource_id)) {
            cache.set(r.resource_id, map.name);
          }
        }
      }
    }
  }
  entityMapNameCache = cache;
  return cache;
};

/**
 * 从所有副本的波次数据中构建 monster_id → 副本名称 的缓存
 * 用于将秘境内 boss/怪物解析到其所属副本
 */
let monsterDungeonNameCache: Map<string, string> | null = null;

const buildMonsterDungeonNameCache = (): Map<string, string> => {
  if (monsterDungeonNameCache) return monsterDungeonNameCache;
  const cache = new Map<string, string>();
  for (const dungeon of getDungeonDefinitions()) {
    const diffs = getDungeonDifficultiesByDungeonId(dungeon.id);
    for (const diff of diffs) {
      for (const stage of getDungeonStagesByDifficultyId(diff.id)) {
        for (const wave of getDungeonWavesByStageId(stage.id)) {
          for (const m of wave.monsters ?? []) {
            const mid = typeof m === 'object' && m !== null && typeof (m as Record<string, unknown>).monster_def_id === 'string'
              ? String((m as Record<string, unknown>).monster_def_id)
              : '';
            if (mid && !cache.has(mid)) {
              cache.set(mid, dungeon.name);
            }
          }
        }
      }
    }
  }
  monsterDungeonNameCache = cache;
  return cache;
};

/**
 * 根据目标参数解析该目标实际执行的地点标签及类型
 * - dungeon_clear：有具体 dungeon_id 时返回对应副本名称；配置缺失时返回 null
 * - kill_monster：优先从副本波次查找所属副本名，其次从地图房间查找地图名
 * - gather_resource：从地图房间查找地图名
 * - 无具体目标：返回 null
 */
const resolveObjectiveMapName = (
  params: Record<string, unknown> | undefined,
): { name: string; type: 'map' | 'dungeon' } | null => {
  if (!params) return null;
  const dungeonId = asNonEmptyString(params.dungeon_id);
  if (dungeonId) {
    const dungeonName = buildDungeonNameCache().get(dungeonId);
    return dungeonName ? { name: dungeonName, type: 'dungeon' } : null;
  }
  const monsterId = asNonEmptyString(params.monster_id);
  if (monsterId) {
    const dungeonName = buildMonsterDungeonNameCache().get(monsterId);
    if (dungeonName) return { name: dungeonName, type: 'dungeon' };
    const mapName = buildEntityMapNameCache().get(monsterId);
    if (mapName) return { name: mapName, type: 'map' };
    return null;
  }
  const resourceId = asNonEmptyString(params.resource_id);
  if (resourceId) {
    const mapName = buildEntityMapNameCache().get(resourceId);
    if (mapName) return { name: mapName, type: 'map' };
    return null;
  }
  return null;
};

const collectRewardItemDefIds = (rewardGroups: Iterable<RawReward[]>): string[] => {
  const itemRewardIds = new Set<string>();
  for (const rewards of rewardGroups) {
    for (const reward of rewards) {
      if (asNonEmptyString(reward?.type) !== 'item') continue;
      const itemDefId = asNonEmptyString(reward?.item_def_id);
      if (!itemDefId) continue;
      itemRewardIds.add(itemDefId);
    }
  }
  return Array.from(itemRewardIds);
};

const toTaskRewardItemMetaMap = (
  itemDefIds: Iterable<string>,
): Map<string, RewardItemDisplayMeta> => {
  return resolveRewardItemDisplayMetaMap(itemDefIds);
};

const toTaskRewardDto = (
  reward: RawReward,
  itemMeta: Map<string, RewardItemDisplayMeta>,
): TaskRewardDto | null => {
  const type = asNonEmptyString(reward?.type) ?? '';
  if (type === 'silver') {
    return {
      type: 'silver',
      name: getRewardCurrencyDisplayName('silver'),
      amount: asFiniteNonNegativeInt(reward?.amount, 0),
    };
  }
  if (type === 'spirit_stones') {
    return {
      type: 'spirit_stones',
      name: getRewardCurrencyDisplayName('spirit_stones'),
      amount: asFiniteNonNegativeInt(reward?.amount, 0),
    };
  }
  if (type !== 'item') return null;

  const itemDefId = asNonEmptyString(reward?.item_def_id);
  if (!itemDefId) return null;
  const qtyRange = resolveRewardQtyRange(reward);
  const meta = itemMeta.get(itemDefId) ?? resolveRewardItemDisplayMeta(itemDefId);
  const amountMax = qtyRange.max > qtyRange.min ? qtyRange.max : undefined;
  return {
    type: 'item',
    itemDefId,
    name: meta.name,
    icon: meta.icon,
    amount: qtyRange.min,
    ...(amountMax ? { amountMax } : {}),
  };
};

const toTaskProgressRecord = (value: unknown): TaskProgressRecord | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record: TaskProgressRecord = {};
  for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
    record[key] = asFiniteNonNegativeInt(entryValue, 0);
  }
  return record;
};

const getProgressValue = (progress: TaskProgressRecord | null | undefined, objectiveId: string): number => {
  if (!objectiveId) return 0;
  if (!progress) return 0;
  return asFiniteNonNegativeInt(progress[objectiveId], 0);
};

const computeRemainingSeconds = (expiresAt: unknown): number | null => {
  if (!expiresAt) return null;
  const ms = expiresAt instanceof Date ? expiresAt.getTime() : typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((ms - Date.now()) / 1000));
};

const buildTaskObjectiveDtos = (
  objectives: RawObjective[],
  progress: TaskProgressRecord | null,
): TaskObjectiveDto[] => {
  return objectives
    .map((objective) => {
      const objectiveId = asNonEmptyString(objective.id) ?? '';
      const text = String(objective.text ?? '');
      const target = Math.max(1, asFiniteNonNegativeInt(objective.target, 1));
      const done = Math.min(target, getProgressValue(progress, objectiveId));
      const type = String(objective.type ?? 'unknown');
      const paramsValue = objective.params;
      const params = paramsValue && typeof paramsValue === 'object'
        ? (paramsValue as Record<string, unknown>)
        : undefined;
      const objectiveMapName = resolveObjectiveMapName(params);
      return {
        id: objectiveId,
        type,
        text,
        done,
        target,
        mapName: objectiveMapName?.name ?? null,
        mapNameType: objectiveMapName?.type ?? null,
        ...(params ? { params } : {}),
      };
    })
    .filter((objective) => objective.text);
};

const buildTaskRewardDtos = (
  rewards: RawReward[],
  itemMeta: Map<string, RewardItemDisplayMeta>,
): TaskRewardDto[] => {
  return rewards
    .map((reward) => toTaskRewardDto(reward, itemMeta))
    .filter((reward): reward is TaskRewardDto => reward !== null && reward.amount > 0);
};

const normalizeBountyTaskSourceType = (value: unknown): BountyTaskSourceType => {
  return asNonEmptyString(value) === 'player' ? 'player' : 'daily';
};

const loadCharacterTaskRealmState = async (
  characterId: number,
  dbClient?: PoolClient,
): Promise<CharacterTaskRealmState | null> => {
  const cid = Number(characterId);
  if (!Number.isFinite(cid) || cid <= 0) return null;

  const runner = dbClient ?? { query };
  const res = await runner.query(
    `
      SELECT realm, sub_realm
      FROM characters
      WHERE id = $1
      LIMIT 1
    `,
    [cid],
  );

  const row = (res.rows?.[0] ?? null) as Record<string, unknown> | null;
  if (!row) return null;
  return {
    realm: asNonEmptyString(row.realm) ?? '凡人',
    subRealm: asNonEmptyString(row.sub_realm),
  };
};

const loadCharacterTaskRealmStatesBatch = async (
  characterIds: readonly number[],
): Promise<Map<number, CharacterTaskRealmState>> => {
  const normalizedCharacterIds = [...new Set(
    characterIds
      .map((characterId) => Math.floor(Number(characterId)))
      .filter((characterId) => Number.isFinite(characterId) && characterId > 0),
  )];
  if (normalizedCharacterIds.length <= 0) {
    return new Map<number, CharacterTaskRealmState>();
  }

  const res = await query(
    `
      SELECT id, realm, sub_realm
      FROM characters
      WHERE id = ANY($1::int[])
    `,
    [normalizedCharacterIds],
  );

  const stateByCharacterId = new Map<number, CharacterTaskRealmState>();
  for (const row of res.rows as Array<Record<string, unknown>>) {
    const characterId = asFiniteNonNegativeInt(row.id, 0);
    if (!characterId) continue;
    stateByCharacterId.set(characterId, {
      realm: asNonEmptyString(row.realm) ?? '凡人',
      subRealm: asNonEmptyString(row.sub_realm),
    });
  }

  return stateByCharacterId;
};

const buildRecurringTaskResetPlan = (
  characterRealmState: CharacterTaskRealmState,
): RecurringTaskResetPlan => {
  const autoAcceptTaskIds: string[] = [];
  const dailyTaskIds: string[] = [];
  const eventTaskIds: string[] = [];

  for (const taskDef of getStaticTaskDefinitions()) {
    if (!taskDef.enabled) continue;
    if (taskDef.category !== 'daily' && taskDef.category !== 'event') continue;
    if (!isTaskDefinitionUnlockedForCharacter(taskDef, characterRealmState)) continue;
    const taskId = taskDef.id.trim();
    if (!taskId) continue;

    autoAcceptTaskIds.push(taskId);
    if (taskDef.category === 'daily') {
      dailyTaskIds.push(taskId);
      continue;
    }
    eventTaskIds.push(taskId);
  }

  return {
    autoAcceptTaskIds,
    dailyTaskIds,
    eventTaskIds,
  };
};

const buildCharacterTaskRealmStateKey = (
  characterRealmState?: CharacterTaskRealmState,
): string | null => {
  if (!characterRealmState) return null;
  return `${characterRealmState.realm}::${characterRealmState.subRealm ?? ''}`;
};

const recurringTaskResetInflight = new Map<number, RecurringTaskResetInflightEntry>();

const insertMissingTaskProgressRows = async (
  runner: Pick<PoolClient, 'query'>,
  characterId: number,
  taskIds: readonly string[],
  tracked: boolean,
): Promise<boolean> => {
  const cid = Number(characterId);
  if (!Number.isFinite(cid) || cid <= 0) return false;
  const normalizedTaskIds = Array.from(new Set(taskIds.map((taskId) => taskId.trim()).filter(Boolean)));
  if (normalizedTaskIds.length === 0) return false;

  const insertResult = await runner.query(
    `
      INSERT INTO character_task_progress
        (character_id, task_id, status, progress, tracked, accepted_at, completed_at, claimed_at, updated_at)
      SELECT
        $1,
        recurring_task.task_id,
        'ongoing',
        '{}'::jsonb,
        $3,
        NOW(),
        NULL,
        NULL,
        NOW()
      FROM unnest($2::varchar[]) AS recurring_task(task_id)
      ON CONFLICT (character_id, task_id) DO NOTHING
    `,
    [cid, normalizedTaskIds, tracked],
  );

  return (insertResult.rowCount ?? 0) > 0;
};

const runRecurringTaskProgressReset = async (
  characterId: number,
  dbClient?: PoolClient,
  characterRealmState?: CharacterTaskRealmState,
): Promise<void> => {
  const cid = Number(characterId);
  if (!Number.isFinite(cid) || cid <= 0) return;
  const runner = dbClient ?? { query };
  const resolvedCharacterRealmState = characterRealmState ?? await loadCharacterTaskRealmState(cid, dbClient);
  if (!resolvedCharacterRealmState) return;

  const resetPlan = buildRecurringTaskResetPlan(resolvedCharacterRealmState);

  if (resetPlan.autoAcceptTaskIds.length > 0) {
    // 日常/周常任务为自动接取：缺失进度行时自动补齐，避免首次必须手动“接取”。
    await insertMissingTaskProgressRows(runner, cid, resetPlan.autoAcceptTaskIds, false);
  }

  if (resetPlan.dailyTaskIds.length === 0 && resetPlan.eventTaskIds.length === 0) return;

  await runner.query(
    `
      UPDATE character_task_progress
      SET status = 'ongoing',
          progress = '{}'::jsonb,
          accepted_at = NOW(),
          completed_at = NULL,
          claimed_at = NULL,
          updated_at = NOW()
      WHERE character_id = $1
        AND (
          (task_id = ANY($2::varchar[]) AND accepted_at < date_trunc('day', NOW()))
          OR
          (task_id = ANY($3::varchar[]) AND accepted_at < date_trunc('week', NOW()))
        )
    `,
    [cid, resetPlan.dailyTaskIds, resetPlan.eventTaskIds],
  );
};

const isTaskDefinitionUnlockedForCharacter = (
  taskDef: Pick<TaskDefinition, 'category' | 'realm'>,
  characterRealm: CharacterTaskRealmState,
): boolean => {
  return buildTaskRecurringUnlockState(
    taskDef.category,
    taskDef.realm,
    characterRealm.realm,
    characterRealm.subRealm,
  ).unlocked;
};

const getTaskDefinitionUnlockFailureMessage = (
  taskDef: Pick<TaskDefinition, 'category' | 'realm'>,
  characterRealm: CharacterTaskRealmState,
): string | null => {
  const unlockState = buildTaskRecurringUnlockState(
    taskDef.category,
    taskDef.realm,
    characterRealm.realm,
    characterRealm.subRealm,
  );
  if (unlockState.unlocked || !unlockState.requiredRealm) return null;
  return `需达到${unlockState.requiredRealm}后开放`;
};

const resetRecurringTaskProgressIfNeeded = async (
  characterId: number,
  dbClient?: PoolClient,
  characterRealmState?: CharacterTaskRealmState,
): Promise<void> => {
  const cid = Number(characterId);
  if (!Number.isFinite(cid) || cid <= 0) return;
  if (dbClient) {
    await runRecurringTaskProgressReset(cid, dbClient, characterRealmState);
    return;
  }

  const realmStateKey = buildCharacterTaskRealmStateKey(characterRealmState);
  const inflight = recurringTaskResetInflight.get(cid);
  if (inflight && inflight.realmStateKey === realmStateKey) {
    await inflight.promise;
    return;
  }

  const entry: RecurringTaskResetInflightEntry = {
    promise: Promise.resolve(),
    realmStateKey,
  };
  const request = runRecurringTaskProgressReset(cid, undefined, characterRealmState).finally(() => {
    const latest = recurringTaskResetInflight.get(cid);
    if (latest === entry) {
      recurringTaskResetInflight.delete(cid);
    }
  });
  entry.promise = request;
  recurringTaskResetInflight.set(cid, entry);
  await request;
};

const buildTaskOverviewSourceRows = async (
  characterId: number,
  category?: TaskCategory,
): Promise<TaskOverviewSourceRow[]> => {
  const cid = Number(characterId);
  if (!Number.isFinite(cid) || cid <= 0) return [];
  const characterRealmState = await loadCharacterTaskRealmState(cid);
  if (!characterRealmState) return [];
  await resetRecurringTaskProgressIfNeeded(cid, undefined, characterRealmState);

  const resolvedCategory = normalizeTaskCategory(category);
  const defs = getStaticTaskDefinitions().filter((entry) => {
    if (!entry.enabled) return false;
    if (resolvedCategory && entry.category !== resolvedCategory) return false;
    return isTaskDefinitionUnlockedForCharacter(entry, characterRealmState);
  });

  const taskIds = defs.map((entry) => entry.id);
  const progressRes =
    taskIds.length === 0
      ? { rows: [] as Array<Record<string, unknown>> }
      : await query(
          `
            SELECT task_id, status AS progress_status, tracked, progress
            FROM character_task_progress
            WHERE character_id = $1
              AND task_id = ANY($2::varchar[])
          `,
          [cid, taskIds],
        );

  const progressByTaskId = new Map<string, {
    progressStatus: string | null;
    tracked: boolean;
    progress: TaskProgressRecord | null;
  }>();
  for (const row of progressRes.rows as Array<Record<string, unknown>>) {
    const taskId = asNonEmptyString(row.task_id);
    if (!taskId) continue;
    progressByTaskId.set(taskId, {
      progressStatus: asNonEmptyString(row.progress_status),
      tracked: row.tracked === true,
      progress: toTaskProgressRecord(row.progress),
    });
  }

  return defs
    .sort((left, right) => left.category.localeCompare(right.category) || right.sort_weight - left.sort_weight || left.id.localeCompare(right.id))
    .map((def) => {
      const progress = progressByTaskId.get(def.id);
      return {
        id: def.id,
        category: normalizeTaskCategory(def.category) ?? 'main',
        title: String(def.title ?? def.id),
        realm: asNonEmptyString(def.realm) ?? '凡人',
        giverNpcId: asNonEmptyString(def.giver_npc_id),
        mapId: asNonEmptyString(def.map_id),
        roomId: asNonEmptyString(def.room_id),
        description: String(def.description ?? ''),
        objectives: parseObjectives(def.objectives),
        rewards: parseRewards(def.rewards),
        progressStatus: progress?.progressStatus ?? null,
        tracked: progress?.tracked === true,
        progress: progress?.progress ?? null,
      };
    });
};

const buildTaskOverviewRewardMeta = (
  rows: TaskOverviewSourceRow[],
): Map<string, RewardItemDisplayMeta> => {
  return toTaskRewardItemMetaMap(collectRewardItemDefIds(rows.map((row) => row.rewards)));
};

const mapTaskOverviewDetail = (
  row: TaskOverviewSourceRow,
  itemMeta: Map<string, RewardItemDisplayMeta>,
): TaskOverviewDto => {
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    realm: row.realm,
    giverNpcId: row.giverNpcId,
    mapId: row.mapId,
    mapName: resolveMapName(row.mapId),
    roomId: row.roomId,
    status: mapProgressStatusToUiStatus(row.progressStatus),
    tracked: row.tracked,
    description: row.description,
    objectives: buildTaskObjectiveDtos(row.objectives, row.progress),
    rewards: buildTaskRewardDtos(row.rewards, itemMeta),
  };
};

const mapTaskOverviewSummary = (
  row: TaskOverviewSourceRow,
): TaskOverviewSummaryDto => {
  return {
    id: row.id,
    category: row.category,
    mapId: row.mapId,
    roomId: row.roomId,
    status: mapProgressStatusToUiStatus(row.progressStatus),
    tracked: row.tracked,
  };
};

const buildBountyTaskOverviewSourceRows = async (
  characterId: number,
): Promise<BountyTaskOverviewSourceRow[]> => {
  const cid = Number(characterId);
  if (!Number.isFinite(cid) || cid <= 0) return [];
  const characterRealmState = await loadCharacterTaskRealmState(cid);
  if (!characterRealmState) return [];
  await resetRecurringTaskProgressIfNeeded(cid, undefined, characterRealmState);

  const res = await query(
    `
      SELECT
        i.id AS bounty_instance_id,
        i.source_type,
        i.task_id,
        i.title AS bounty_title,
        COALESCE(i.description, '') AS bounty_description,
        CASE
          WHEN i.source_type = 'daily' AND i.expires_at IS NULL THEN (date_trunc('day', NOW()) + interval '1 day')
          ELSE i.expires_at
        END AS expires_at,
        i.spirit_stones_reward,
        i.silver_reward,
        COALESCE(p.status, 'ongoing') AS progress_status,
        COALESCE(p.tracked, false) AS tracked,
        COALESCE(p.progress, '{}'::jsonb) AS progress
      FROM bounty_claim c
      JOIN bounty_instance i ON i.id = c.bounty_instance_id
      LEFT JOIN character_task_progress p
        ON p.task_id = i.task_id
       AND p.character_id = $1
      WHERE c.character_id = $1
        AND c.status IN ('claimed','completed')
        AND (
          i.source_type <> 'daily'
          OR (
            i.refresh_date = CURRENT_DATE
            AND (i.expires_at IS NULL OR i.expires_at > NOW())
          )
        )
        AND (
          i.source_type <> 'player'
          OR i.expires_at IS NULL
          OR i.expires_at > NOW()
        )
      ORDER BY c.claimed_at DESC, i.id DESC
    `,
    [cid],
  );

  const queryRows = (res.rows ?? []) as Array<Record<string, unknown>>;
  const taskDefMap = await getTaskDefinitionsByIds(
    queryRows
      .map((row) => asNonEmptyString(row.task_id))
      .filter((taskId): taskId is string => Boolean(taskId)),
  );

  return queryRows.flatMap((row) => {
    const taskId = asNonEmptyString(row.task_id);
    if (!taskId) return [];
    const taskDef = taskDefMap.get(taskId);
    if (!taskDef) return [];

    const bountyInstanceIdRaw = typeof row.bounty_instance_id === 'number'
      ? row.bounty_instance_id
      : Number(row.bounty_instance_id);
    const bountyInstanceId = Number.isFinite(bountyInstanceIdRaw) ? Math.trunc(bountyInstanceIdRaw) : 0;
    const expiresAt = row.expires_at ? new Date(String(row.expires_at)).toISOString() : null;

    return [{
      taskId,
      bountyInstanceId,
      sourceType: normalizeBountyTaskSourceType(row.source_type),
      title: String(row.bounty_title ?? taskId),
      description: String(row.bounty_description ?? ''),
      expiresAt,
      extraSpiritStonesReward: asFiniteNonNegativeInt(row.spirit_stones_reward, 0),
      extraSilverReward: asFiniteNonNegativeInt(row.silver_reward, 0),
      progressStatus: asNonEmptyString(row.progress_status),
      tracked: row.tracked === true,
      progress: toTaskProgressRecord(row.progress),
      taskDef,
    }];
  });
};

const buildBountyTaskOverviewRewardMeta = (
  rows: BountyTaskOverviewSourceRow[],
): Map<string, RewardItemDisplayMeta> => {
  return toTaskRewardItemMetaMap(
    collectRewardItemDefIds(rows.map((row) => parseRewards(row.taskDef.rewards))),
  );
};

const mapBountyTaskOverviewDetail = (
  row: BountyTaskOverviewSourceRow,
  itemMeta: Map<string, RewardItemDisplayMeta>,
): BountyTaskOverviewDto => {
  const rewardOut: TaskRewardDto[] = [];
  if (row.extraSilverReward > 0) {
    rewardOut.push({
      type: 'silver',
      name: getRewardCurrencyDisplayName('silver'),
      amount: row.extraSilverReward,
    });
  }
  if (row.extraSpiritStonesReward > 0) {
    rewardOut.push({
      type: 'spirit_stones',
      name: getRewardCurrencyDisplayName('spirit_stones'),
      amount: row.extraSpiritStonesReward,
    });
  }
  rewardOut.push(...buildTaskRewardDtos(parseRewards(row.taskDef.rewards), itemMeta));

  return {
    id: row.taskId,
    category: 'bounty',
    title: row.title,
    realm: asNonEmptyString(row.taskDef.realm) ?? '凡人',
    giverNpcId: asNonEmptyString(row.taskDef.giver_npc_id),
    mapId: asNonEmptyString(row.taskDef.map_id),
    mapName: resolveMapName(asNonEmptyString(row.taskDef.map_id)),
    roomId: asNonEmptyString(row.taskDef.room_id),
    status: mapProgressStatusToUiStatus(row.progressStatus),
    tracked: row.tracked,
    description: row.description,
    objectives: buildTaskObjectiveDtos(parseObjectives(row.taskDef.objectives), row.progress),
    rewards: rewardOut,
    bountyInstanceId: row.bountyInstanceId,
    sourceType: row.sourceType,
    expiresAt: row.expiresAt,
    remainingSeconds: computeRemainingSeconds(row.expiresAt),
  };
};

const mapBountyTaskOverviewSummary = (
  row: BountyTaskOverviewSourceRow,
): BountyTaskOverviewSummaryDto => {
  return {
    id: row.taskId,
    status: mapProgressStatusToUiStatus(row.progressStatus),
    sourceType: row.sourceType,
    expiresAt: row.expiresAt,
    remainingSeconds: computeRemainingSeconds(row.expiresAt),
  };
};

export const getTaskOverview = async (
  characterId: number,
  category?: TaskCategory,
): Promise<{ tasks: TaskOverviewDto[] }> => {
  const rows = await buildTaskOverviewSourceRows(characterId, category);
  const itemMeta = buildTaskOverviewRewardMeta(rows);
  return {
    tasks: rows.map((row) => mapTaskOverviewDetail(row, itemMeta)),
  };
};

export const getTaskOverviewSummary = async (
  characterId: number,
  category?: TaskCategory,
): Promise<{ tasks: TaskOverviewSummaryDto[] }> => {
  const rows = await buildTaskOverviewSourceRows(characterId, category);
  return {
    tasks: rows.map(mapTaskOverviewSummary),
  };
};

export const getBountyTaskOverview = async (
  characterId: number,
): Promise<{ tasks: BountyTaskOverviewDto[] }> => {
  const rows = await buildBountyTaskOverviewSourceRows(characterId);
  const itemMeta = buildBountyTaskOverviewRewardMeta(rows);
  return {
    tasks: rows.map((row) => mapBountyTaskOverviewDetail(row, itemMeta)),
  };
};

export const getBountyTaskOverviewSummary = async (
  characterId: number,
): Promise<{ tasks: BountyTaskOverviewSummaryDto[] }> => {
  const rows = await buildBountyTaskOverviewSourceRows(characterId);
  return {
    tasks: rows.map(mapBountyTaskOverviewSummary),
  };
};

export const setTaskTracked = async (
  characterId: number,
  taskId: string,
  tracked: boolean
): Promise<{ success: boolean; message: string; data?: { taskId: string; tracked: boolean } }> => {
  const cid = Number(characterId);
  if (!Number.isFinite(cid) || cid <= 0) return { success: false, message: '角色不存在' };
  const tid = asNonEmptyString(taskId);
  if (!tid) return { success: false, message: '任务ID不能为空' };

  const taskDef = await getTaskDefinitionById(tid);
  if (!taskDef) return { success: false, message: '任务不存在' };
  const characterRealmState = await loadCharacterTaskRealmState(cid);
  if (!characterRealmState) return { success: false, message: '角色不存在' };
  const unlockFailureMessage = getTaskDefinitionUnlockFailureMessage(taskDef, characterRealmState);
  if (unlockFailureMessage) return { success: false, message: unlockFailureMessage };

  const res = await query(
    `
      INSERT INTO character_task_progress (character_id, task_id, tracked)
      VALUES ($1, $2, $3)
      ON CONFLICT (character_id, task_id) DO UPDATE SET
        tracked = EXCLUDED.tracked,
        updated_at = NOW()
      RETURNING tracked
    `,
    [cid, tid, tracked]
  );

  const saved = res.rows?.[0]?.tracked === true;
  return { success: true, message: 'ok', data: { taskId: tid, tracked: saved } };
};

type ClaimedRewardResult =
  | { type: 'silver'; amount: number }
  | { type: 'spirit_stones'; amount: number }
  | { type: 'item'; itemDefId: string; qty: number; itemIds?: number[]; itemName?: string; itemIcon?: string };

const appendClaimedCurrencyReward = (
  rewards: ClaimedRewardResult[],
  rewardDelta: CharacterRewardDelta,
  type: 'silver' | 'spirit_stones',
  amount: number,
): void => {
  if (amount <= 0) return;
  if (type === 'silver') {
    mergeCharacterRewardDelta(rewardDelta, { silver: amount });
  } else {
    mergeCharacterRewardDelta(rewardDelta, { spiritStones: amount });
  }
  rewards.push({ type, amount });
};

export const claimTaskReward = async (
  userId: number,
  characterId: number,
  taskId: string
): Promise<{ success: boolean; message: string; data?: { taskId: string; rewards: ClaimedRewardResult[] } }> => {
  return taskService.claimTaskReward(userId, characterId, taskId);
};

type TaskProgressStatusDb = 'ongoing' | 'turnin' | 'claimable' | 'claimed';

type TaskRewardClaimTransitionRow = {
  previous_status: string | null;
  claimed_task_id: string | null;
};

type TaskRewardClaimTransition = {
  claimed: boolean;
  previousStatus: TaskProgressStatusDb | null;
};

type TaskSubmitClaimTransitionRow = {
  previous_status: string | null;
  transitioned_task_id: string | null;
};

type TaskSubmitClaimTransition = {
  transitioned: boolean;
  previousStatus: TaskProgressStatusDb | null;
};

type TaskAcceptTransitionRow = {
  previous_status: string | null;
  accepted_task_id: string | null;
};

type TaskAcceptTransition = {
  accepted: boolean;
  previousStatus: TaskProgressStatusDb | null;
};

type BountyClaimRewardTransitionRow = {
  claim_id: number | string;
  spirit_stones_reward: number | string | null;
  silver_reward: number | string | null;
};

const asTaskProgressStatusDb = (v: unknown): TaskProgressStatusDb => {
  const s = asNonEmptyString(v) || 'ongoing';
  if (s === 'turnin') return 'turnin';
  if (s === 'claimable') return 'claimable';
  if (s === 'claimed') return 'claimed';
  return 'ongoing';
};

const claimTaskRewardProgressTx = async (
  characterId: number,
  taskId: string,
): Promise<TaskRewardClaimTransition> => {
  const res = await query<TaskRewardClaimTransitionRow>(
    `
      WITH current_progress AS (
        SELECT status
        FROM character_task_progress
        WHERE character_id = $1 AND task_id = $2
        LIMIT 1
      ),
      claimed_progress AS (
        UPDATE character_task_progress
        SET status = 'claimed',
            completed_at = COALESCE(completed_at, NOW()),
            claimed_at = NOW(),
            tracked = false,
            updated_at = NOW()
        WHERE character_id = $1
          AND task_id = $2
          AND status = 'claimable'
        RETURNING task_id
      )
      SELECT
        (SELECT status FROM current_progress LIMIT 1) AS previous_status,
        (SELECT task_id FROM claimed_progress LIMIT 1) AS claimed_task_id
    `,
    [characterId, taskId],
  );
  const row = res.rows[0];
  const claimedTaskId = asNonEmptyString(row?.claimed_task_id);
  return {
    claimed: claimedTaskId === taskId,
    previousStatus: row?.previous_status ? asTaskProgressStatusDb(row.previous_status) : null,
  };
};

const markTaskClaimableTx = async (
  characterId: number,
  taskId: string,
): Promise<TaskSubmitClaimTransition> => {
  const res = await query<TaskSubmitClaimTransitionRow>(
    `
      WITH current_progress AS (
        SELECT status
        FROM character_task_progress
        WHERE character_id = $1 AND task_id = $2
        LIMIT 1
      ),
      transitioned_progress AS (
        UPDATE character_task_progress
        SET status = 'claimable',
            completed_at = COALESCE(completed_at, NOW()),
            updated_at = NOW()
        WHERE character_id = $1
          AND task_id = $2
          AND status NOT IN ('claimable', 'claimed')
        RETURNING task_id
      )
      SELECT
        (SELECT status FROM current_progress LIMIT 1) AS previous_status,
        (SELECT task_id FROM transitioned_progress LIMIT 1) AS transitioned_task_id
    `,
    [characterId, taskId],
  );
  const row = res.rows[0];
  const transitionedTaskId = asNonEmptyString(row?.transitioned_task_id);
  return {
    transitioned: transitionedTaskId === taskId,
    previousStatus: row?.previous_status ? asTaskProgressStatusDb(row.previous_status) : null,
  };
};

const acceptTaskProgressTx = async (
  characterId: number,
  taskId: string,
): Promise<TaskAcceptTransition> => {
  const res = await query<TaskAcceptTransitionRow>(
    `
      WITH current_progress AS (
        SELECT status
        FROM character_task_progress
        WHERE character_id = $1 AND task_id = $2
        LIMIT 1
      ),
      accepted_progress AS (
        INSERT INTO character_task_progress
          (character_id, task_id, status, progress, tracked, accepted_at, completed_at, claimed_at, updated_at)
        SELECT
          $1,
          $2,
          'ongoing',
          '{}'::jsonb,
          true,
          NOW(),
          NULL,
          NULL,
          NOW()
        WHERE NOT EXISTS (SELECT 1 FROM current_progress)
        ON CONFLICT (character_id, task_id) DO NOTHING
        RETURNING task_id
      )
      SELECT
        (SELECT status FROM current_progress LIMIT 1) AS previous_status,
        (SELECT task_id FROM accepted_progress LIMIT 1) AS accepted_task_id
    `,
    [characterId, taskId],
  );
  const row = res.rows[0];
  const acceptedTaskId = asNonEmptyString(row?.accepted_task_id);
  return {
    accepted: acceptedTaskId === taskId,
    previousStatus: row?.previous_status ? asTaskProgressStatusDb(row.previous_status) : null,
  };
};

const asStringArray = (v: unknown): string[] => {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x ?? '').trim()).filter(Boolean);
};

const parseProgressRecord = (progress: unknown): Record<string, number> => {
  if (!progress || typeof progress !== 'object') return {};
  const record = progress as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(record)) {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (Number.isFinite(n)) out[k] = Math.max(0, Math.floor(n));
  }
  return out;
};

const computeAllObjectivesDone = (objectives: readonly RawObjective[], progressRecord: Record<string, number>): boolean => {
  const list = objectives.filter((o) => asNonEmptyString(o?.id));
  if (list.length === 0) return false;
  for (const o of list) {
    const oid = asNonEmptyString(o?.id) ?? '';
    const target = Math.max(1, asFiniteNonNegativeInt(o?.target, 1));
    const done = Math.min(target, asFiniteNonNegativeInt(progressRecord[oid], 0));
    if (done < target) return false;
  }
  return true;
};

const checkPrereqSatisfied = async (characterId: number, prereqTaskIds: string[]): Promise<boolean> => {
  const prereqIds = prereqTaskIds.map((x) => x.trim()).filter(Boolean);
  if (prereqIds.length === 0) return true;
  const res = await query(
    `
      SELECT task_id, status
      FROM character_task_progress
      WHERE character_id = $1 AND task_id = ANY($2::varchar[])
    `,
    [characterId, prereqIds],
  );
  const statusById = new Map<string, TaskProgressStatusDb>();
  for (const r of res.rows ?? []) {
    const tid = asNonEmptyString(r?.task_id);
    if (!tid) continue;
    statusById.set(tid, asTaskProgressStatusDb(r?.status));
  }
  for (const tid of prereqIds) {
    const st = statusById.get(tid);
    if (!st) return false;
    if (st !== 'turnin' && st !== 'claimable' && st !== 'claimed') return false;
  }
  return true;
};

export const acceptTaskFromNpc = async (
  characterId: number,
  taskId: string,
  npcId: string,
): Promise<{ success: boolean; message: string; data?: { taskId: string } }> => {
  const cid = Number(characterId);
  if (!Number.isFinite(cid) || cid <= 0) return { success: false, message: '角色不存在' };
  const tid = asNonEmptyString(taskId);
  if (!tid) return { success: false, message: '任务ID不能为空' };
  const nid = asNonEmptyString(npcId);
  if (!nid) return { success: false, message: 'NPC不存在' };
  const characterRealmState = await loadCharacterTaskRealmState(cid);
  if (!characterRealmState) return { success: false, message: '角色不存在' };
  await resetRecurringTaskProgressIfNeeded(cid, undefined, characterRealmState);

  const taskDef = await getTaskDefinitionById(tid);
  if (!taskDef) return { success: false, message: '任务不存在' };
  const unlockFailureMessage = getTaskDefinitionUnlockFailureMessage(taskDef, characterRealmState);
  if (unlockFailureMessage) return { success: false, message: unlockFailureMessage };
  const taskCategory = normalizeTaskCategory(taskDef.category) ?? 'main';
  const giverNpcId = asNonEmptyString(taskDef.giver_npc_id);
  if (!giverNpcId || giverNpcId !== nid) return { success: false, message: '该NPC无法发放此任务' };
  const prereqTaskIds = asStringArray(taskDef.prereq_task_ids);
  const prereqOk = await checkPrereqSatisfied(cid, prereqTaskIds);
  if (!prereqOk) return { success: false, message: '前置任务未完成' };

  const acceptTransition = await acceptTaskProgressTx(cid, tid);
  if (!acceptTransition.accepted) {
    if (acceptTransition.previousStatus !== 'claimed') return { success: false, message: '任务已接取' };
    if (taskCategory === 'main' || taskCategory === 'side') return { success: false, message: '任务已完成，不可重复接取' };
    if (taskCategory === 'daily') return { success: false, message: '今日任务已完成' };
    if (taskCategory === 'event') return { success: false, message: '本周活动任务已完成' };
    return { success: false, message: '任务已完成，不可重复接取' };
  }

  return { success: true, message: 'ok', data: { taskId: tid } };
};

export const submitTask = async (
  characterId: number,
  taskId: string,
  npcId: string,
): Promise<{ success: boolean; message: string; data?: { taskId: string } }> => {
  const cid = Number(characterId);
  if (!Number.isFinite(cid) || cid <= 0) return { success: false, message: '角色不存在' };
  const tid = asNonEmptyString(taskId);
  if (!tid) return { success: false, message: '任务ID不能为空' };
  const nid = asNonEmptyString(npcId);
  if (!nid) return { success: false, message: 'NPC不存在' };
  const characterRealmState = await loadCharacterTaskRealmState(cid);
  if (!characterRealmState) return { success: false, message: '角色不存在' };
  await resetRecurringTaskProgressIfNeeded(cid, undefined, characterRealmState);

  const res = await query(
    `
      SELECT status, progress
      FROM character_task_progress
      WHERE character_id = $1 AND task_id = $2
      LIMIT 1
    `,
    [cid, tid],
  );
  if ((res.rows ?? []).length === 0) return { success: false, message: '任务未接取' };

  const taskDef = await getTaskDefinitionById(tid);
  if (!taskDef) return { success: false, message: '任务不存在' };
  const unlockFailureMessage = getTaskDefinitionUnlockFailureMessage(taskDef, characterRealmState);
  if (unlockFailureMessage) return { success: false, message: unlockFailureMessage };

  const row = res.rows[0] as { status?: unknown; progress?: unknown };
  const giverNpcId = asNonEmptyString(taskDef.giver_npc_id);
  if (!giverNpcId || giverNpcId !== nid) return { success: false, message: '该任务无法在此提交' };
  const status = asTaskProgressStatusDb(row?.status);
  if (status === 'claimed') return { success: false, message: '任务已完成' };
  if (status === 'claimable') return { success: true, message: 'ok', data: { taskId: tid } };

  const objectives = parseObjectives(taskDef.objectives);
  const progressRecord = parseProgressRecord(row?.progress);
  const allDone = computeAllObjectivesDone(objectives, progressRecord);
  if (!allDone) return { success: false, message: '任务未完成' };

  const submitTransition = await markTaskClaimableTx(cid, tid);
  if (!submitTransition.transitioned && submitTransition.previousStatus === 'claimed') {
    return { success: false, message: '任务已完成' };
  }
  return { success: true, message: 'ok', data: { taskId: tid } };
};

type CharacterTaskEventsBatchInput = {
  characterId: number;
  events: readonly TaskEvent[];
  characterRealmState?: CharacterTaskRealmState;
};

type ResolvedCharacterTaskEventsBatchInput = {
  characterId: number;
  events: TaskEvent[];
  characterRealmState: CharacterTaskRealmState;
};

type TaskProgressBatchMutation = {
  characterId: number;
  taskId: string;
  progress: TaskProgressRecord;
  nextStatus: TaskProgressStatusDb;
};

type CharacterBatchAchievementInput = {
  trackKey: string;
  increment: number;
};

type CharacterProgressEventBatchInput = {
  characterId: number;
  taskEvents: TaskEvent[];
  mainQuestEvents: MainQuestProgressEvent[];
  achievementInputs: CharacterBatchAchievementInput[];
};

type BufferedProgressDeltaBucket =
  | 'talk_npc'
  | 'kill_monster'
  | 'collect'
  | 'gather_resource'
  | 'dungeon_clear'
  | 'craft_item';

type BufferedCraftItemPayload = {
  recipeId?: string;
  recipeType?: string;
  craftKind?: string;
  itemId?: string;
};

const encodeProgressDeltaField = (
  bucket: BufferedProgressDeltaBucket,
  payload: Record<string, string | number | undefined>,
): string => `${bucket}:${JSON.stringify(payload)}`;

const decodeProgressDeltaField = (
  field: string,
): {
  bucket: BufferedProgressDeltaBucket;
  payload: Record<string, unknown>;
} | null => {
  const delimiterIndex = field.indexOf(':');
  if (delimiterIndex <= 0) return null;
  const bucket = field.slice(0, delimiterIndex) as BufferedProgressDeltaBucket;
  const rawPayload = field.slice(delimiterIndex + 1);
  if (
    bucket !== 'talk_npc'
    && bucket !== 'kill_monster'
    && bucket !== 'collect'
    && bucket !== 'gather_resource'
    && bucket !== 'dungeon_clear'
    && bucket !== 'craft_item'
  ) {
    return null;
  }
  try {
    const payload = JSON.parse(rawPayload) as Record<string, unknown>;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return null;
    }
    return { bucket, payload };
  } catch {
    return null;
  }
};

const normalizeCharacterTaskEventsBatchInputs = (
  inputs: CharacterTaskEventsBatchInput[],
): CharacterTaskEventsBatchInput[] => {
  const eventsByCharacterId = new Map<number, TaskEvent[]>();
  const stateByCharacterId = new Map<number, CharacterTaskRealmState>();

  for (const input of inputs) {
    const characterId = Math.floor(Number(input.characterId));
    if (!Number.isFinite(characterId) || characterId <= 0) continue;
    if (input.events.length <= 0) continue;

    const existingEvents = eventsByCharacterId.get(characterId);
    if (existingEvents) {
      existingEvents.push(...input.events);
    } else {
      eventsByCharacterId.set(characterId, [...input.events]);
    }

    if (input.characterRealmState && !stateByCharacterId.has(characterId)) {
      stateByCharacterId.set(characterId, input.characterRealmState);
    }
  }

  return [...eventsByCharacterId.entries()].map(([characterId, events]) => ({
    characterId,
    events,
    characterRealmState: stateByCharacterId.get(characterId),
  }));
};

const resolveCharacterTaskEventsBatchInputs = async (
  inputs: CharacterTaskEventsBatchInput[],
): Promise<ResolvedCharacterTaskEventsBatchInput[]> => {
  const normalizedInputs = normalizeCharacterTaskEventsBatchInputs(inputs);
  if (normalizedInputs.length <= 0) {
    return [];
  }

  const unresolvedCharacterIds = normalizedInputs
    .filter((input) => !input.characterRealmState)
    .map((input) => input.characterId);
  const loadedStateByCharacterId = unresolvedCharacterIds.length > 0
    ? await loadCharacterTaskRealmStatesBatch(unresolvedCharacterIds)
    : new Map<number, CharacterTaskRealmState>();

  return normalizedInputs.flatMap((input) => {
    const characterRealmState = input.characterRealmState ?? loadedStateByCharacterId.get(input.characterId);
    if (!characterRealmState) {
      return [];
    }
    const events = [...input.events];
    return [{
      characterId: input.characterId,
      events,
      characterRealmState,
    }];
  });
};

const insertMissingTaskProgressRowsBatch = async (
  runner: Pick<PoolClient, 'query'>,
  rows: Array<{
    characterId: number;
    taskIds: readonly string[];
    tracked: boolean;
  }>,
): Promise<Set<number>> => {
  const serializedRows: Array<{
    character_id: number;
    task_id: string;
    tracked: boolean;
  }> = [];
  const dedupeKeySet = new Set<string>();

  for (const row of rows) {
    const characterId = Math.floor(Number(row.characterId));
    if (!Number.isFinite(characterId) || characterId <= 0) continue;
    for (const rawTaskId of row.taskIds) {
      const taskId = rawTaskId.trim();
      if (!taskId) continue;
      const dedupeKey = `${characterId}:${taskId}`;
      if (dedupeKeySet.has(dedupeKey)) continue;
      dedupeKeySet.add(dedupeKey);
      serializedRows.push({
        character_id: characterId,
        task_id: taskId,
        tracked: row.tracked,
      });
    }
  }

  if (serializedRows.length <= 0) {
    return new Set<number>();
  }

  const insertResult = await runner.query(
    `
      WITH target_rows AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb)
          AS x(character_id int, task_id varchar(64), tracked boolean)
      ),
      inserted_rows AS (
        INSERT INTO character_task_progress
          (character_id, task_id, status, progress, tracked, accepted_at, completed_at, claimed_at, updated_at)
        SELECT
          target_rows.character_id,
          target_rows.task_id,
          'ongoing',
          '{}'::jsonb,
          target_rows.tracked,
          NOW(),
          NULL,
          NULL,
          NOW()
        FROM target_rows
        ON CONFLICT (character_id, task_id) DO NOTHING
        RETURNING character_id
      )
      SELECT DISTINCT character_id
      FROM inserted_rows
    `,
    [JSON.stringify(serializedRows)],
  );

  return new Set<number>(
    (insertResult.rows as Array<Record<string, unknown>>)
      .map((row) => asFiniteNonNegativeInt(row.character_id, 0))
      .filter((characterId) => characterId > 0),
  );
};

const buildRecurringTaskResetPlanByCharacterStateKey = (
  characterRealmStates: Iterable<CharacterTaskRealmState>,
): Map<string, RecurringTaskResetPlan> => {
  const planByStateKey = new Map<string, RecurringTaskResetPlan>();

  for (const characterRealmState of characterRealmStates) {
    const stateKey = buildCharacterTaskRealmStateKey(characterRealmState);
    if (!stateKey || planByStateKey.has(stateKey)) continue;
    planByStateKey.set(stateKey, buildRecurringTaskResetPlan(characterRealmState));
  }

  return planByStateKey;
};

const resetRecurringTaskProgressIfNeededBatch = async (
  inputs: Array<{
    characterId: number;
    characterRealmState: CharacterTaskRealmState;
  }>,
): Promise<void> => {
  if (inputs.length <= 0) return;

  const dedupedInputs = new Map<number, CharacterTaskRealmState>();
  for (const input of inputs) {
    const characterId = Math.floor(Number(input.characterId));
    if (!Number.isFinite(characterId) || characterId <= 0) continue;
    dedupedInputs.set(characterId, input.characterRealmState);
  }
  if (dedupedInputs.size <= 0) return;

  const planByStateKey = buildRecurringTaskResetPlanByCharacterStateKey(dedupedInputs.values());
  const autoAcceptRows: Array<{
    characterId: number;
    taskIds: readonly string[];
    tracked: boolean;
  }> = [];
  const resetRows: Array<{
    character_id: number;
    daily_task_ids: string[];
    event_task_ids: string[];
  }> = [];

  for (const [characterId, characterRealmState] of dedupedInputs.entries()) {
    const stateKey = buildCharacterTaskRealmStateKey(characterRealmState);
    const resetPlan = stateKey ? planByStateKey.get(stateKey) : buildRecurringTaskResetPlan(characterRealmState);
    if (!resetPlan) continue;

    if (resetPlan.autoAcceptTaskIds.length > 0) {
      autoAcceptRows.push({
        characterId,
        taskIds: resetPlan.autoAcceptTaskIds,
        tracked: false,
      });
    }
    if (resetPlan.dailyTaskIds.length > 0 || resetPlan.eventTaskIds.length > 0) {
      resetRows.push({
        character_id: characterId,
        daily_task_ids: resetPlan.dailyTaskIds,
        event_task_ids: resetPlan.eventTaskIds,
      });
    }
  }

  if (autoAcceptRows.length > 0) {
    await insertMissingTaskProgressRowsBatch({ query }, autoAcceptRows);
  }

  if (resetRows.length <= 0) return;

  await query(
    `
      WITH reset_rows AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb)
          AS x(character_id int, daily_task_ids varchar[], event_task_ids varchar[])
      )
      UPDATE character_task_progress AS progress_row
      SET status = 'ongoing',
          progress = '{}'::jsonb,
          accepted_at = NOW(),
          completed_at = NULL,
          claimed_at = NULL,
          updated_at = NOW()
      FROM reset_rows
      WHERE progress_row.character_id = reset_rows.character_id
        AND (
          (
            COALESCE(array_length(reset_rows.daily_task_ids, 1), 0) > 0
            AND progress_row.task_id = ANY(reset_rows.daily_task_ids)
            AND progress_row.accepted_at < date_trunc('day', NOW())
          )
          OR
          (
            COALESCE(array_length(reset_rows.event_task_ids, 1), 0) > 0
            AND progress_row.task_id = ANY(reset_rows.event_task_ids)
            AND progress_row.accepted_at < date_trunc('week', NOW())
          )
        )
    `,
    [JSON.stringify(resetRows)],
  );
};

const loadActiveTaskProgressRowsBatch = async (
  characterIds: readonly number[],
): Promise<Map<number, Array<Record<string, unknown>>>> => {
  const normalizedCharacterIds = [...new Set(
    characterIds
      .map((characterId) => Math.floor(Number(characterId)))
      .filter((characterId) => Number.isFinite(characterId) && characterId > 0),
  )];
  const rowsByCharacterId = new Map<number, Array<Record<string, unknown>>>();
  if (normalizedCharacterIds.length <= 0) {
    return rowsByCharacterId;
  }

  const res = await query(
    `
      SELECT
        p.character_id,
        p.task_id,
        p.status,
        p.progress
      FROM character_task_progress p
      WHERE p.character_id = ANY($1::int[])
        AND COALESCE(p.status, 'ongoing') <> 'claimed'
    `,
    [normalizedCharacterIds],
  );

  for (const row of res.rows as Array<Record<string, unknown>>) {
    const characterId = asFiniteNonNegativeInt(row.character_id, 0);
    if (!characterId) continue;
    const existingRows = rowsByCharacterId.get(characterId);
    if (existingRows) {
      existingRows.push(row);
      continue;
    }
    rowsByCharacterId.set(characterId, [row]);
  }

  return rowsByCharacterId;
};

/**
 * 批量推进任务事件。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把多角色任务推进收敛成“一次角色境界解析、一次活跃进度读取、一次批量写回”，直接服务战斗多人结算热路径。
 * 2. 做什么：保留 recurring 自动补齐、目标命中、交付 NPC 直达 claimable 等既有语义，不让收集/击杀两条链路分叉。
 * 3. 不做什么：不负责主线和成就更新；这些由外层批量入口统一调度。
 *
 * 输入/输出：
 * - 输入：多角色任务事件数组，每个角色可以携带一批已归一化事件。
 * - 输出：发生任务概览变化的角色 ID 列表。
 *
 * 数据流/状态流：
 * 多角色事件 -> recurring 命中补齐 -> 一次读取全部活跃任务进度
 * -> 内存态匹配并计算所有角色的进度变更 -> 一次批量 UPDATE 落库。
 *
 * 复用设计说明：
 * 1. 单角色 `applyTaskEvents` 直接委托给这里，避免单人/多人入口维护两份任务推进协议。
 * 2. 收集事件、击杀事件与未来其他战斗事件都能复用同一条批量 SQL 链路，减少热点分支。
 *
 * 关键边界条件与坑点：
 * 1. `talk_npc` 必须允许和同批次目标完成一起直达 `claimable`，否则会把原本一跳可交付的任务卡在 `turnin`。
 * 2. 多角色输入只允许在内存里按角色拆分计算，不能跨角色共享进度快照，否则会污染任务状态。
 */
const applyTaskEventsBatch = async (
  inputs: CharacterTaskEventsBatchInput[],
): Promise<number[]> => {
  const resolvedInputs = await resolveCharacterTaskEventsBatchInputs(inputs);
  if (resolvedInputs.length <= 0) {
    return [];
  }

  const taskStaticIndex = getTaskStaticIndex();
  const recurringInsertRows: Array<{
    characterId: number;
    taskIds: readonly string[];
    tracked: boolean;
  }> = [];

  for (const input of resolvedInputs) {
    const matchedRecurringTaskIdSet = new Set<string>();
    for (const event of input.events) {
      const matchedRecurringTaskIds = collectMatchedRecurringTaskIds(
        taskStaticIndex.recurringTaskDefinitions,
        input.characterRealmState,
        event,
      );
      for (const taskId of matchedRecurringTaskIds) {
        matchedRecurringTaskIdSet.add(taskId);
      }
    }
    if (matchedRecurringTaskIdSet.size <= 0) continue;
    recurringInsertRows.push({
      characterId: input.characterId,
      taskIds: Array.from(matchedRecurringTaskIdSet),
      tracked: false,
    });
  }

  const insertedRecurringCharacterIds = recurringInsertRows.length > 0
    ? await insertMissingTaskProgressRowsBatch({ query }, recurringInsertRows)
    : new Set<number>();

  const progressRowsByCharacterId = await loadActiveTaskProgressRowsBatch(
    resolvedInputs.map((input) => input.characterId),
  );

  const taskIds = new Set<string>();
  for (const rows of progressRowsByCharacterId.values()) {
    for (const row of rows) {
      const taskId = asNonEmptyString(row.task_id);
      if (taskId) {
        taskIds.add(taskId);
      }
    }
  }
  const taskDefMap = await getTaskDefinitionsByIds(Array.from(taskIds));

  const changedCharacterIds = new Set<number>(insertedRecurringCharacterIds);
  const taskProgressMutations: TaskProgressBatchMutation[] = [];

  for (const input of resolvedInputs) {
    const rows = progressRowsByCharacterId.get(input.characterId) ?? [];
    let changedAnyTask = insertedRecurringCharacterIds.has(input.characterId);

    for (const row of rows) {
      const taskId = asNonEmptyString(row.task_id);
      if (!taskId) continue;
      const taskDef = taskDefMap.get(taskId);
      if (!taskDef) continue;
      if (!isTaskDefinitionUnlockedForCharacter(taskDef, input.characterRealmState)) continue;

      const status = asTaskProgressStatusDb(row.status);
      if (status === 'claimed') continue;

      const objectives = taskDef.source === 'static'
        ? (taskStaticIndex.objectivesByTaskId.get(taskId) ?? [])
        : parseObjectives(taskDef.objectives);
      const normalizedObjectives = taskDef.source === 'static'
        ? (taskStaticIndex.normalizedObjectivesByTaskId.get(taskId) ?? [])
        : normalizeTaskObjectives(objectives);
      const progressRecord = parseProgressRecord(row.progress);
      const category = normalizeTaskCategory(taskDef.category) ?? 'main';
      const giverNpcId = asNonEmptyString(taskDef.giver_npc_id);

      let changed = false;
      let giverTalkMatched = false;
      for (const event of input.events) {
        if (event.type === 'talk_npc' && giverNpcId && giverNpcId === event.npcId) {
          giverTalkMatched = true;
        }
        for (const objectiveEntry of normalizedObjectives) {
          const match = objectiveMatchesTaskEvent(objectiveEntry.objective, event);
          if (!match.matched) continue;
          const current = asFiniteNonNegativeInt(progressRecord[objectiveEntry.objectiveId], 0);
          const next = Math.min(objectiveEntry.target, current + match.delta);
          if (next !== current) {
            progressRecord[objectiveEntry.objectiveId] = next;
            changed = true;
          }
        }
      }

      const allDone = computeAllObjectivesDone(objectives, progressRecord);
      let nextStatus: TaskProgressStatusDb = status;
      if (allDone) {
        if (category === 'event') {
          nextStatus = 'claimable';
        } else {
          if (status === 'ongoing') nextStatus = 'turnin';
          if (giverTalkMatched && (status === 'turnin' || nextStatus === 'turnin' || status === 'claimable')) {
            nextStatus = 'claimable';
          }
        }
      }

      if (!changed && nextStatus === status) continue;
      taskProgressMutations.push({
        characterId: input.characterId,
        taskId,
        progress: progressRecord,
        nextStatus,
      });
      changedAnyTask = true;
    }

    if (changedAnyTask) {
      changedCharacterIds.add(input.characterId);
    }
  }

  if (taskProgressMutations.length > 0) {
    await query(
      `
        WITH next_rows AS (
          SELECT *
          FROM jsonb_to_recordset($1::jsonb)
            AS x(character_id int, task_id varchar(64), progress jsonb, next_status varchar(16))
        )
        UPDATE character_task_progress AS progress_row
        SET progress = next_rows.progress,
            status = next_rows.next_status,
            completed_at = CASE
              WHEN next_rows.next_status = 'claimable'::varchar(16)
                THEN COALESCE(progress_row.completed_at, NOW())
              ELSE progress_row.completed_at
            END,
            updated_at = NOW()
        FROM next_rows
        WHERE progress_row.character_id = next_rows.character_id
          AND progress_row.task_id = next_rows.task_id
      `,
      [JSON.stringify(taskProgressMutations.map((mutation) => ({
        character_id: mutation.characterId,
        task_id: mutation.taskId,
        progress: mutation.progress,
        next_status: mutation.nextStatus,
      })))],
    );
  }

  return [...changedCharacterIds];
};

const normalizePositiveInt = (value: unknown, fallback = 1): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const floor = Math.floor(n);
  return floor > 0 ? floor : fallback;
};

type KillMonsterEventInput = {
  monsterId: string;
  count: number;
};

type KillMonsterEventsBatchInput = {
  characterId: number;
  events: KillMonsterEventInput[];
};

/**
 * 统一规整怪物击杀事件，供战斗结算和单次击杀都走同一入口。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：过滤非法 monsterId、合并重复怪物、累计正整数击杀次数。
 * 2. 不做什么：不触发任务更新、不写数据库，只负责把输入整理成单一数据源。
 *
 * 输入/输出：
 * - 输入：`events`，允许包含重复 monsterId 和非规范 count。
 * - 输出：按 monsterId 聚合后的击杀事件数组。
 *
 * 数据流/状态流：
 * - 战斗结算/单次调用 -> 归一化怪物击杀事件 -> 统一进入任务/主线/成就更新。
 *
 * 关键边界条件与坑点：
 * 1. 空 monsterId 会被直接丢弃，避免把脏数据写进任务进度。
 * 2. 同一场战斗可能出现重复怪物定义，必须先聚合，避免重复通知和重复主线写入。
 */
const normalizeKillMonsterEvents = (
  events: KillMonsterEventInput[],
): KillMonsterEventInput[] => {
  const countByMonsterId = new Map<string, number>();

  for (const event of events) {
    const monsterId = asNonEmptyString(event.monsterId);
    if (!monsterId) continue;
    const count = normalizePositiveInt(event.count, 1);
    countByMonsterId.set(monsterId, (countByMonsterId.get(monsterId) ?? 0) + count);
  }

  return [...countByMonsterId.entries()].map(([monsterId, count]) => ({
    monsterId,
    count,
  }));
};

const buildKillMonsterTaskEvents = (
  normalizedEvents: KillMonsterEventInput[],
): TaskEvent[] => normalizedEvents.map((event) => ({
  type: 'kill_monster',
  monsterId: event.monsterId,
  count: event.count,
}));

const buildKillMonsterMainQuestEvents = (
  normalizedEvents: KillMonsterEventInput[],
): MainQuestProgressEvent[] => normalizedEvents.map((event) => ({
  type: 'kill_monster',
  monsterId: event.monsterId,
  count: event.count,
}));

const buildKillMonsterAchievementInputs = (
  normalizedEvents: KillMonsterEventInput[],
): CharacterBatchAchievementInput[] => normalizedEvents.map((event) => ({
  trackKey: `kill:monster:${event.monsterId}`,
  increment: event.count,
}));

const normalizeKillMonsterEventBatchInputs = (
  inputs: KillMonsterEventsBatchInput[],
): Array<{
  characterId: number;
  normalizedEvents: KillMonsterEventInput[];
}> => {
  const countByMonsterIdByCharacterId = new Map<number, Map<string, number>>();

  for (const input of inputs) {
    const characterId = asFiniteNonNegativeInt(input.characterId, 0);
    if (!characterId) continue;

    const normalizedEvents = normalizeKillMonsterEvents(input.events);
    if (normalizedEvents.length <= 0) continue;

    const countByMonsterId = countByMonsterIdByCharacterId.get(characterId) ?? new Map<string, number>();
    for (const event of normalizedEvents) {
      countByMonsterId.set(event.monsterId, (countByMonsterId.get(event.monsterId) ?? 0) + event.count);
    }
    countByMonsterIdByCharacterId.set(characterId, countByMonsterId);
  }

  return [...countByMonsterIdByCharacterId.entries()].map(([characterId, countByMonsterId]) => ({
    characterId,
    normalizedEvents: [...countByMonsterId.entries()].map(([monsterId, count]) => ({
      monsterId,
      count,
    })),
  }));
};

const normalizeCharacterProgressEventBatchInputs = (
  inputs: CharacterProgressEventBatchInput[],
): CharacterProgressEventBatchInput[] => {
  const inputByCharacterId = new Map<number, CharacterProgressEventBatchInput>();

  for (const input of inputs) {
    const characterId = asFiniteNonNegativeInt(input.characterId, 0);
    if (!characterId) continue;

    const existing = inputByCharacterId.get(characterId);
    if (existing) {
      existing.taskEvents.push(...input.taskEvents);
      existing.mainQuestEvents.push(...input.mainQuestEvents);
      existing.achievementInputs.push(...input.achievementInputs);
      continue;
    }

    inputByCharacterId.set(characterId, {
      characterId,
      taskEvents: [...input.taskEvents],
      mainQuestEvents: [...input.mainQuestEvents],
      achievementInputs: [...input.achievementInputs],
    });
  }

  return [...inputByCharacterId.values()].filter((input) =>
    input.taskEvents.length > 0 || input.mainQuestEvents.length > 0 || input.achievementInputs.length > 0,
  );
};

const buildBufferedProgressDeltaFields = (
  inputs: CharacterProgressEventBatchInput[],
): CharacterProgressDeltaField[] => {
  const incrementByCompositeKey = new Map<string, CharacterProgressDeltaField>();

  for (const input of inputs) {
    const characterId = asFiniteNonNegativeInt(input.characterId, 0);
    if (!characterId) continue;

    const pushBufferedField = (
      field: string,
      increment: number,
    ): void => {
      const normalizedIncrement = normalizePositiveInt(increment, 0);
      if (normalizedIncrement <= 0) return;
      const compositeKey = `${characterId}:${field}`;
      const existing = incrementByCompositeKey.get(compositeKey);
      if (existing) {
        existing.increment += normalizedIncrement;
        return;
      }
      incrementByCompositeKey.set(compositeKey, {
        characterId,
        field,
        increment: normalizedIncrement,
      });
    };

    for (const taskEvent of input.taskEvents) {
      if (taskEvent.type === 'talk_npc') {
        if (!taskEvent.npcId) continue;
        pushBufferedField(
          encodeProgressDeltaField('talk_npc', { npcId: taskEvent.npcId }),
          1,
        );
        continue;
      }
      if (taskEvent.type === 'kill_monster') {
        if (!taskEvent.monsterId) continue;
        pushBufferedField(
          encodeProgressDeltaField('kill_monster', { monsterId: taskEvent.monsterId }),
          normalizePositiveInt(taskEvent.count ?? 1, 1),
        );
        continue;
      }
      if (taskEvent.type === 'collect') {
        if (!taskEvent.itemId) continue;
        pushBufferedField(
          encodeProgressDeltaField('collect', { itemId: taskEvent.itemId }),
          normalizePositiveInt(taskEvent.count ?? 1, 1),
        );
        continue;
      }
      if (taskEvent.type === 'gather_resource') {
        if (!taskEvent.resourceId) continue;
        pushBufferedField(
          encodeProgressDeltaField('gather_resource', { resourceId: taskEvent.resourceId }),
          normalizePositiveInt(taskEvent.count ?? 1, 1),
        );
        continue;
      }
      if (taskEvent.type === 'dungeon_clear') {
        if (!taskEvent.dungeonId) continue;
        const isTeamClear = input.achievementInputs.some(
          (achievementInput) => achievementInput.trackKey === `team:dungeon:clear:${taskEvent.dungeonId}`,
        );
        pushBufferedField(
          encodeProgressDeltaField('dungeon_clear', {
            dungeonId: taskEvent.dungeonId,
            difficultyId: taskEvent.difficultyId ?? '',
            participantCount: isTeamClear ? 2 : 1,
          }),
          normalizePositiveInt(taskEvent.count ?? 1, 1),
        );
        continue;
      }
      if (taskEvent.type === 'craft_item') {
        pushBufferedField(
          encodeProgressDeltaField('craft_item', {
            recipeId: taskEvent.recipeId ?? '',
            recipeType: taskEvent.recipeType ?? '',
            craftKind: taskEvent.craftKind ?? '',
            itemId: taskEvent.itemId ?? '',
          }),
          normalizePositiveInt(taskEvent.count ?? 1, 1),
        );
      }
    }
  }

  return [...incrementByCompositeKey.values()];
};

const parseBufferedProgressDeltaHash = (
  characterId: number,
  hash: Record<string, string>,
): CharacterProgressEventBatchInput | null => {
  const talkEvents: TaskEvent[] = [];
  const taskEvents: TaskEvent[] = [];
  const mainQuestEvents: MainQuestProgressEvent[] = [];
  const achievementInputs: CharacterBatchAchievementInput[] = [];

  for (const [field, rawIncrement] of Object.entries(hash)) {
    const increment = normalizePositiveInt(Number(rawIncrement), 0);
    if (increment <= 0) continue;

    const decoded = decodeProgressDeltaField(field);
    if (!decoded) continue;

    if (decoded.bucket === 'talk_npc') {
      const npcId = asNonEmptyString(decoded.payload.npcId);
      if (!npcId) continue;
      for (let index = 0; index < increment; index += 1) {
        const talkEvent: TaskEvent = { type: 'talk_npc', npcId };
        talkEvents.push(talkEvent);
        mainQuestEvents.push({ type: 'talk_npc', npcId });
      }
      achievementInputs.push({
        trackKey: `talk:npc:${npcId}`,
        increment,
      });
      continue;
    }

    if (decoded.bucket === 'kill_monster') {
      const monsterId = asNonEmptyString(decoded.payload.monsterId);
      if (!monsterId) continue;
      taskEvents.push({ type: 'kill_monster', monsterId, count: increment });
      mainQuestEvents.push({ type: 'kill_monster', monsterId, count: increment });
      achievementInputs.push({
        trackKey: `kill:monster:${monsterId}`,
        increment,
      });
      continue;
    }

    if (decoded.bucket === 'collect') {
      const itemId = asNonEmptyString(decoded.payload.itemId);
      if (!itemId) continue;
      taskEvents.push({ type: 'collect', itemId, count: increment });
      mainQuestEvents.push({ type: 'collect', itemId, count: increment });
      achievementInputs.push({
        trackKey: `item:obtain:${itemId}`,
        increment,
      });
      continue;
    }

    if (decoded.bucket === 'gather_resource') {
      const resourceId = asNonEmptyString(decoded.payload.resourceId);
      if (!resourceId) continue;
      taskEvents.push({ type: 'gather_resource', resourceId, count: increment });
      mainQuestEvents.push({ type: 'gather_resource', resourceId, count: increment });
      mainQuestEvents.push({ type: 'collect', itemId: resourceId, count: increment });
      achievementInputs.push({
        trackKey: `gather:resource:${resourceId}`,
        increment,
      });
      achievementInputs.push({
        trackKey: `item:obtain:${resourceId}`,
        increment,
      });
      continue;
    }

    if (decoded.bucket === 'dungeon_clear') {
      const dungeonId = asNonEmptyString(decoded.payload.dungeonId);
      if (!dungeonId) continue;
      const difficultyId = asNonEmptyString(decoded.payload.difficultyId) ?? undefined;
      const participantCount = normalizePositiveInt(Number(decoded.payload.participantCount ?? 1), 1);
      taskEvents.push({ type: 'dungeon_clear', dungeonId, difficultyId, count: increment });
      mainQuestEvents.push({ type: 'dungeon_clear', dungeonId, difficultyId, count: increment });
      achievementInputs.push({
        trackKey: `dungeon:clear:${dungeonId}`,
        increment,
      });
      if (difficultyId) {
        const difficultyDef = getDungeonDifficultyById(difficultyId);
        const difficultyName = typeof difficultyDef?.name === 'string' ? difficultyDef.name.trim() : '';
        if (difficultyName === '噩梦') {
          achievementInputs.push({
            trackKey: 'dungeon:clear:difficulty:nightmare',
            increment,
          });
        }
      }
      if (participantCount > 1) {
        achievementInputs.push({
          trackKey: `team:dungeon:clear:${dungeonId}`,
          increment,
        });
      }
      continue;
    }

    if (decoded.bucket === 'craft_item') {
      const craftPayload: BufferedCraftItemPayload = {
        recipeId: asNonEmptyString(decoded.payload.recipeId) ?? undefined,
        recipeType: asNonEmptyString(decoded.payload.recipeType) ?? undefined,
        craftKind: asNonEmptyString(decoded.payload.craftKind) ?? undefined,
        itemId: asNonEmptyString(decoded.payload.itemId) ?? undefined,
      };
      taskEvents.push({
        type: 'craft_item',
        recipeId: craftPayload.recipeId,
        recipeType: craftPayload.recipeType,
        craftKind: craftPayload.craftKind,
        itemId: craftPayload.itemId,
        count: increment,
      });
      mainQuestEvents.push({
        type: 'craft_item',
        recipeId: craftPayload.recipeId,
        recipeType: craftPayload.recipeType,
        craftKind: craftPayload.craftKind,
        itemId: craftPayload.itemId,
        count: increment,
      });
      if (craftPayload.recipeId) {
        achievementInputs.push({
          trackKey: `craft:recipe:${craftPayload.recipeId}`,
          increment,
        });
      }
      if (craftPayload.craftKind) {
        achievementInputs.push({
          trackKey: `craft:kind:${craftPayload.craftKind}`,
          increment,
        });
      }
      if (craftPayload.itemId) {
        achievementInputs.push({
          trackKey: `craft:item:${craftPayload.itemId}`,
          increment,
        });
      }
    }
  }

  const mergedTaskEvents = [...talkEvents, ...taskEvents];
  if (mergedTaskEvents.length <= 0 && mainQuestEvents.length <= 0 && achievementInputs.length <= 0) {
    return null;
  }

  return {
    characterId,
    taskEvents: mergedTaskEvents,
    mainQuestEvents,
    achievementInputs,
  };
};

const bufferCharacterProgressEventBatches = async (
  inputs: CharacterProgressEventBatchInput[],
): Promise<void> => {
  const normalizedInputs = normalizeCharacterProgressEventBatchInputs(inputs);
  if (normalizedInputs.length <= 0) return;

  await bufferCharacterProgressDeltaFields(buildBufferedProgressDeltaFields(normalizedInputs));
};

/**
 * 多角色任务/主线/成就批量推进管线。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把多角色事件统一收敛成“一次角色境界读取、一次 recurring 重置、一次任务批量推进、一次主线批量推进、一次成就批量推进”。
 * 2. 做什么：为收集、击杀等高频战斗事件提供单一批处理入口，减少同一场结算里三张进度表的重复读写。
 * 3. 不做什么：不构造事件本身，也不决定奖励结算策略；调用方只负责把已归一化事件喂进来。
 *
 * 输入/输出：
 * - 输入：多角色事件批次，包含任务事件、主线事件和成就增量。
 * - 输出：无；副作用是推进任务/主线/成就并按需推送任务总览。
 *
 * 数据流/状态流：
 * 多角色事件 -> 批量读取角色境界 -> recurring 周期任务批量重置
 * -> `applyTaskEventsBatch` 批量推进任务
 * -> `updateSectionProgressByEventsBatch` 批量推进主线
 * -> `updateAchievementProgressBatch` 批量推进成就 -> 按角色推送任务概览。
 *
 * 复用设计说明：
 * 1. 收集事件和击杀事件都复用这里，避免继续各自维护一套“任务 + 主线 + 成就”推进顺序。
 * 2. 高频变化点只剩事件归一化规则；真正的批量 SQL 协议集中在这一处，后续扩展新事件种类只加构造器。
 *
 * 关键边界条件与坑点：
 * 1. 不存在的角色必须在境界批量加载后被整体剔除，避免对任务/主线/成就表写出孤儿数据。
 * 2. 同一角色可能在同一批次里重复出现，必须先合并事件数组，否则会重复推进并增加锁持有时间。
 */
const recordCharacterProgressEventBatchesInternal = async (
  inputs: CharacterProgressEventBatchInput[],
): Promise<void> => {
  const normalizedInputs = normalizeCharacterProgressEventBatchInputs(inputs);
  if (normalizedInputs.length <= 0) return;

  const resolvedTaskInputs = await resolveCharacterTaskEventsBatchInputs(
    normalizedInputs.map((input) => ({
      characterId: input.characterId,
      events: input.taskEvents,
    })),
  );
  if (resolvedTaskInputs.length <= 0) return;

  const resolvedCharacterIdSet = new Set<number>(resolvedTaskInputs.map((input) => input.characterId));
  const resolvedInputs = normalizedInputs.filter((input) => resolvedCharacterIdSet.has(input.characterId));
  if (resolvedInputs.length <= 0) return;

  await resetRecurringTaskProgressIfNeededBatch(
    resolvedTaskInputs.map((input) => ({
      characterId: input.characterId,
      characterRealmState: input.characterRealmState,
    })),
  );

  const changedCharacterIds = await applyTaskEventsBatch(resolvedTaskInputs);

  const mainQuestInputs = resolvedInputs
    .filter((input) => input.mainQuestEvents.length > 0)
    .map((input) => ({
      characterId: input.characterId,
      events: input.mainQuestEvents,
    }));
  if (mainQuestInputs.length > 0) {
    await updateSectionProgressByEventsBatch(mainQuestInputs);
  }

  const achievementProgressInputs = resolvedInputs.flatMap((input) =>
    input.achievementInputs.map((achievementInput) => ({
      characterId: input.characterId,
      trackKey: achievementInput.trackKey,
      increment: achievementInput.increment,
    })),
  );
  if (achievementProgressInputs.length > 0) {
    await updateAchievementProgressBatch(achievementProgressInputs);
  }

  await Promise.all(
    changedCharacterIds.map((characterId) => notifyTaskOverviewUpdate(characterId, ['task'])),
  );
};

const flushBufferedCharacterProgressDeltas = async (
  options: { drainAll?: boolean; limit?: number } = {},
): Promise<void> => {
  const drainAll = options.drainAll === true;
  const limit = Math.max(1, Math.floor(options.limit ?? TASK_PROGRESS_DELTA_FLUSH_BATCH_LIMIT));

  do {
    const dirtyCharacterIds = await listDirtyCharacterIdsForProgressDelta(limit);
    if (dirtyCharacterIds.length <= 0) {
      return;
    }

    const claimedInputs: CharacterProgressEventBatchInput[] = [];
    const claimedCharacterIds: number[] = [];
    for (const characterId of dirtyCharacterIds) {
      const claimed = await claimCharacterProgressDelta(characterId);
      if (!claimed) continue;
      claimedCharacterIds.push(characterId);
      const hash = await loadClaimedCharacterProgressDeltaHash(characterId);
      const parsed = parseBufferedProgressDeltaHash(characterId, hash);
      if (parsed) {
        claimedInputs.push(parsed);
      }
    }

    if (claimedCharacterIds.length <= 0) {
      if (!drainAll) return;
      continue;
    }

    try {
      if (claimedInputs.length > 0) {
        await recordCharacterProgressEventBatchesInternal(claimedInputs);
      }
      for (const characterId of claimedCharacterIds) {
        await finalizeClaimedCharacterProgressDelta(characterId);
      }
    } catch (error) {
      for (const characterId of claimedCharacterIds) {
        await restoreClaimedCharacterProgressDelta(characterId);
      }
      throw error;
    }
  } while (drainAll);
};

const runTaskProgressDeltaFlushLoopOnce = async (): Promise<void> => {
  if (taskProgressDeltaFlushInFlight) {
    await taskProgressDeltaFlushInFlight;
    return;
  }

  const currentFlush = flushBufferedCharacterProgressDeltas().catch((error: Error) => {
    taskProgressDeltaLogger.error(error, '角色软进度 Delta flush 失败');
  });
  taskProgressDeltaFlushInFlight = currentFlush;
  try {
    await currentFlush;
  } finally {
    if (taskProgressDeltaFlushInFlight === currentFlush) {
      taskProgressDeltaFlushInFlight = null;
    }
  }
};

export const initializeTaskProgressDeltaFlushService = async (): Promise<void> => {
  if (taskProgressDeltaFlushTimer) return;

  taskProgressDeltaFlushTimer = setInterval(() => {
    void runTaskProgressDeltaFlushLoopOnce();
  }, TASK_PROGRESS_DELTA_FLUSH_INTERVAL_MS);
};

export const shutdownTaskProgressDeltaFlushService = async (): Promise<void> => {
  if (taskProgressDeltaFlushTimer) {
    clearInterval(taskProgressDeltaFlushTimer);
    taskProgressDeltaFlushTimer = null;
  }

  if (taskProgressDeltaFlushInFlight) {
    await taskProgressDeltaFlushInFlight;
  }

  await flushBufferedCharacterProgressDeltas({ drainAll: true });
};

const recordTalkNpcEvent = async (characterId: number, npcId: string): Promise<void> => {
  const nid = asNonEmptyString(npcId);
  if (!nid) return;

  await bufferCharacterProgressEventBatches([{
    characterId,
    taskEvents: [{ type: 'talk_npc', npcId: nid }],
    mainQuestEvents: [{ type: 'talk_npc', npcId: nid }],
    achievementInputs: [{ trackKey: `talk:npc:${nid}`, increment: 1 }],
  }]);
};

export const recordKillMonsterEvent = async (characterId: number, monsterId: string, count: number): Promise<void> => {
  await recordKillMonsterEvents(characterId, [{ monsterId, count }]);
};

/**
 * 批量记录怪物击杀事件，供战斗结算统一复用。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把一场战斗内的多只怪击杀统一推进到任务、主线和成就系统。
 * 2. 不做什么：不推断战斗来源，也不负责战斗奖励结算。
 *
 * 输入/输出：
 * - 输入：`characterId` 与一组怪物击杀事件。
 * - 输出：无；副作用是更新任务/主线/成就并按需推送任务总览。
 *
 * 数据流/状态流：
 * - 战斗结算拿到怪物列表 -> 本函数聚合 -> applyTaskEvents/updateSectionProgressBatch/updateAchievementProgress。
 *
 * 关键边界条件与坑点：
 * 1. 必须先聚合同怪多次击杀，否则同一场战斗会产生多次任务总览刷新。
 * 2. 主线目标支持批量推进，因此这里必须走 batch 入口，避免对同一角色重复锁进度行。
 */
export const recordKillMonsterEvents = async (
  characterId: number,
  events: KillMonsterEventInput[],
): Promise<void> => {
  await recordKillMonsterEventsBatch([{ characterId, events }]);
};

export const recordKillMonsterEventsBatch = async (
  inputs: KillMonsterEventsBatchInput[],
): Promise<void> => {
  const normalizedInputs = normalizeKillMonsterEventBatchInputs(inputs);
  if (normalizedInputs.length <= 0) return;

  await bufferCharacterProgressEventBatches(
    normalizedInputs.map((input) => ({
      characterId: input.characterId,
      taskEvents: buildKillMonsterTaskEvents(input.normalizedEvents),
      mainQuestEvents: buildKillMonsterMainQuestEvents(input.normalizedEvents),
      achievementInputs: buildKillMonsterAchievementInputs(input.normalizedEvents),
    })),
  );
};

export const recordGatherResourceEvent = async (characterId: number, resourceId: string, count: number): Promise<void> => {
  const rid = asNonEmptyString(resourceId);
  if (!rid) return;
  const c = normalizePositiveInt(count, 1);

  await bufferCharacterProgressEventBatches([{
    characterId,
    taskEvents: [{ type: 'gather_resource', resourceId: rid, count: c }],
    mainQuestEvents: [
      { type: 'gather_resource', resourceId: rid, count: c },
      { type: 'collect', itemId: rid, count: c },
    ],
    achievementInputs: [
      { trackKey: `gather:resource:${rid}`, increment: c },
      { trackKey: `item:obtain:${rid}`, increment: c },
    ],
  }]);
};

export const recordCollectItemEvent = async (characterId: number, itemId: string, count: number): Promise<void> => {
  return taskService.recordCollectItemEvent(characterId, itemId, count);
};

type CollectItemEventInput = {
  itemId: string;
  count: number;
};

type CollectItemEventsBatchInput = {
  characterId: number;
  events: CollectItemEventInput[];
};

const normalizeCollectItemEvents = (
  events: CollectItemEventInput[],
): CollectItemEventInput[] => {
  const countByItemId = new Map<string, number>();

  for (const event of events) {
    const itemId = asNonEmptyString(event.itemId);
    if (!itemId) continue;
    const count = normalizePositiveInt(event.count, 1);
    countByItemId.set(itemId, (countByItemId.get(itemId) ?? 0) + count);
  }

  return [...countByItemId.entries()].map(([itemId, count]) => ({
    itemId,
    count,
  }));
};

const buildCollectTaskEvents = (
  normalizedEvents: CollectItemEventInput[],
) => normalizedEvents.map((event) => ({
  type: 'collect' as const,
  itemId: event.itemId,
  count: event.count,
}));

const buildCollectAchievementProgressInputs = (
  normalizedEvents: CollectItemEventInput[],
) => normalizedEvents.map((event) => ({
  trackKey: `item:obtain:${event.itemId}`,
  increment: event.count,
}));

const normalizeCollectItemEventBatchInputs = (
  inputs: CollectItemEventsBatchInput[],
): Array<{
  characterId: number;
  normalizedEvents: CollectItemEventInput[];
}> => {
  const eventMapByCharacter = new Map<number, Map<string, number>>();

  for (const input of inputs) {
    const characterId = asFiniteNonNegativeInt(input.characterId, 0);
    if (!characterId) continue;
    const normalizedEvents = normalizeCollectItemEvents(input.events);
    if (normalizedEvents.length <= 0) continue;

    const countByItemId = eventMapByCharacter.get(characterId) ?? new Map<string, number>();
    for (const event of normalizedEvents) {
      countByItemId.set(event.itemId, (countByItemId.get(event.itemId) ?? 0) + event.count);
    }
    eventMapByCharacter.set(characterId, countByItemId);
  }

  return [...eventMapByCharacter.entries()].map(([characterId, countByItemId]) => ({
    characterId,
    normalizedEvents: [...countByItemId.entries()].map(([itemId, count]) => ({
      itemId,
      count,
    })),
  }));
};

const recordCollectItemEventsBatchInternal = async (
  inputs: CollectItemEventsBatchInput[],
): Promise<void> => {
  const normalizedInputs = normalizeCollectItemEventBatchInputs(inputs);
  if (normalizedInputs.length <= 0) return;

  await bufferCharacterProgressEventBatches(
    normalizedInputs.map((input) => ({
      characterId: input.characterId,
      taskEvents: buildCollectTaskEvents(input.normalizedEvents),
      mainQuestEvents: buildCollectTaskEvents(input.normalizedEvents),
      achievementInputs: buildCollectAchievementProgressInputs(input.normalizedEvents),
    })),
  );
};

/**
 * 批量记录收集物品事件，供掉落/邮件等多物品入口复用。
 *
 * 作用：
 * 1. 把同一角色的一批收集事件聚合成一次 recurring 任务推进、一次主线批量推进和一次成就批量推进，减少掉落热路径的重复读写。
 * 2. 统一让战斗掉落、邮件补发等所有“获得物品”入口都走同一套任务命中口径，避免某些收集型周常永远不加进度。
 *
 * 输入 / 输出：
 * - 输入：角色 ID 与一组可能重复的 `itemId/count` 收集事件。
 * - 输出：无；副作用是推进 recurring 任务、主线章节收集目标与物品获取成就。
 *
 * 数据流 / 状态流：
 * 收集事件数组 -> 先按 itemId 聚合 -> recurring 周期任务重置检查
 * -> `applyTaskEvents` 命中收集目标 -> `updateSectionProgressBatch` 回填主线
 * -> `updateAchievementProgressBatch` 推进成就 -> 按需推送任务总览。
 *
 * 复用设计说明：
 * 1. recurring 任务推进继续复用 `applyTaskEvents`，不额外新写一套 collect 判定分支，避免 kill/gather/collect 三条链路规则漂移。
 * 2. 主线与成就仍复用既有批量入口，让同一批物品只做一次聚合，减少重复遍历与数据库交互。
 *
 * 关键边界条件与坑点：
 * 1. 同一批里重复 itemId 必须先合并，否则 recurring / 主线 / 成就都会被重复累加。
 * 2. 收集事件也可能发生在新周期开始后的第一场掉落前，因此必须先做 recurring 重置检查，避免写进过期周常。
 */
export const recordCollectItemEvents = async (
  characterId: number,
  events: CollectItemEventInput[],
): Promise<void> => {
  return taskService.recordCollectItemEvents(characterId, events);
};

export const recordCollectItemEventsBatch = async (
  inputs: CollectItemEventsBatchInput[],
): Promise<void> => {
  return taskService.recordCollectItemEventsBatch(inputs);
};

export const recordDungeonClearEvent = async (
  characterId: number,
  dungeonId: string,
  count: number,
  participantCount: number,
  difficultyId?: string,
): Promise<void> => {
  const did = asNonEmptyString(dungeonId);
  if (!did) return;
  const diffId = asNonEmptyString(difficultyId) ?? undefined;
  const c = normalizePositiveInt(count, 1);

  const achievementProgressInputs: CharacterBatchAchievementInput[] = [{
    trackKey: `dungeon:clear:${did}`,
    increment: c,
  }];
  if (diffId) {
    const difficultyDef = getDungeonDifficultyById(diffId);
    const difficultyName = typeof difficultyDef?.name === 'string' ? difficultyDef.name.trim() : '';
    if (difficultyName === '噩梦') {
      achievementProgressInputs.push({
        trackKey: 'dungeon:clear:difficulty:nightmare',
        increment: c,
      });
    }
  }
  if (participantCount > 1) {
    achievementProgressInputs.push({
      trackKey: `team:dungeon:clear:${did}`,
      increment: c,
    });
  }
  await bufferCharacterProgressEventBatches([{
    characterId,
    taskEvents: [{
      type: 'dungeon_clear',
      dungeonId: did,
      difficultyId: diffId,
      count: c,
    }],
    mainQuestEvents: [{
      type: 'dungeon_clear',
      dungeonId: did,
      difficultyId: diffId,
      count: c,
    }],
    achievementInputs: achievementProgressInputs,
  }]);
};

export const recordCraftItemEvent = async (
  characterId: number,
  recipeId: string | undefined,
  craftKind: string | undefined,
  itemId: string | undefined,
  count: number,
  recipeType?: string,
): Promise<void> => {
  const rid = asNonEmptyString(recipeId) ?? undefined;
  const kind = asNonEmptyString(craftKind) ?? undefined;
  const iid = asNonEmptyString(itemId) ?? undefined;
  const rtype = asNonEmptyString(recipeType) ?? undefined;
  const c = normalizePositiveInt(count, 1);

  const achievementInputs: CharacterBatchAchievementInput[] = [];
  if (rid) achievementInputs.push({ trackKey: `craft:recipe:${rid}`, increment: c });
  if (kind) achievementInputs.push({ trackKey: `craft:kind:${kind}`, increment: c });
  if (iid) achievementInputs.push({ trackKey: `craft:item:${iid}`, increment: c });

  await bufferCharacterProgressEventBatches([{
    characterId,
    taskEvents: [{
      type: 'craft_item',
      recipeId: rid,
      recipeType: rtype,
      craftKind: kind,
      itemId: iid,
      count: c,
    }],
    mainQuestEvents: [{
      type: 'craft_item',
      recipeId: rid,
      recipeType: rtype,
      craftKind: kind,
      itemId: iid,
      count: c,
    }],
    achievementInputs,
  }]);
};

type NpcTalkTaskOption = {
  taskId: string;
  title: string;
  category: TaskCategory;
  status: 'locked' | 'available' | 'accepted' | 'turnin' | 'claimable' | 'claimed';
};

type NpcTalkMainQuestOption = {
  sectionId: string;
  sectionName: string;
  chapterName: string;
  status: 'not_started' | 'dialogue' | 'objectives' | 'turnin' | 'completed';
  canStartDialogue: boolean;
  canComplete: boolean;
};

export const npcTalk = async (
  characterId: number,
  npcId: string,
): Promise<{
  success: boolean;
  message: string;
  data?: { 
    npcId: string; 
    npcName: string; 
    lines: string[]; 
    tasks: NpcTalkTaskOption[];
    mainQuest?: NpcTalkMainQuestOption;
  };
}> => {
  const cid = Number(characterId);
  if (!Number.isFinite(cid) || cid <= 0) return { success: false, message: '角色不存在' };
  const nid = asNonEmptyString(npcId);
  if (!nid) return { success: false, message: 'NPC不存在' };
  const characterRealmState = await loadCharacterTaskRealmState(cid);
  if (!characterRealmState) return { success: false, message: '角色不存在' };
  await resetRecurringTaskProgressIfNeeded(cid, undefined, characterRealmState);
  await ensureMainQuestProgressForNewChapters(cid);

  const npcDef = getNpcDefinitions().find((entry) => entry.enabled !== false && entry.id === nid);
  if (!npcDef) return { success: false, message: 'NPC不存在' };
  const npcName = String(npcDef.name || nid);
  const talkTreeId = asNonEmptyString(npcDef.talk_tree_id);

  await recordTalkNpcEvent(cid, nid);

  const mainQuestRes = await query(
    `SELECT current_section_id, section_status FROM character_main_quest_progress WHERE character_id = $1 LIMIT 1`,
    [cid],
  );
  const currentSectionId = asNonEmptyString(mainQuestRes.rows?.[0]?.current_section_id);
  const sectionStatus = (mainQuestRes.rows?.[0]?.section_status ?? 'not_started') as
    | 'not_started'
    | 'dialogue'
    | 'objectives'
    | 'turnin'
    | 'completed';

  let talkTreeLines: string[] = [];
  if (talkTreeId) {
    const talkTree = getTalkTreeDefinitions().find((entry) => entry.enabled !== false && entry.id === talkTreeId);
    if (talkTree && Array.isArray(talkTree.greeting_lines)) {
      talkTreeLines = talkTree.greeting_lines.map((x) => String(x ?? '').trim()).filter(Boolean);
    }
  }
  const lines = resolveNpcTalkGreetingLines({
    npcId: nid,
    currentSectionId,
    currentSectionStatus: sectionStatus,
    talkTreeLines,
  });
  if (lines.length === 0) {
    lines.push(`${npcName}看着你，没有多说什么。`);
  }

  const taskDefs = await getTaskDefinitionsByNpcIds([nid]);
  const taskIds = taskDefs.map((entry) => entry.id);
  const progressRes =
    taskIds.length === 0
      ? { rows: [] as Array<Record<string, unknown>> }
      : await query(
          `
            SELECT task_id, status, progress
            FROM character_task_progress
            WHERE character_id = $1
              AND task_id = ANY($2::varchar[])
          `,
          [cid, taskIds],
        );
  const progressByTaskId = new Map<string, { status?: unknown; progress?: unknown }>();
  for (const row of progressRes.rows as Array<Record<string, unknown>>) {
    const taskId = asNonEmptyString(row.task_id);
    if (!taskId) continue;
    progressByTaskId.set(taskId, { status: row.status, progress: row.progress });
  }

  const tasks: NpcTalkTaskOption[] = [];
  for (const def of taskDefs) {
    if (!isTaskDefinitionUnlockedForCharacter(def, characterRealmState)) continue;
    const tid = asNonEmptyString(def.id);
    if (!tid) continue;
    const title = String(def.title ?? tid);
    const category = normalizeTaskCategory(def.category) ?? 'main';
    const progress = progressByTaskId.get(tid);
    const status = asTaskProgressStatusDb(progress?.status);

    const objectives = parseObjectives(def.objectives);
    const progressRecord = parseProgressRecord(progress?.progress);
    const allDone = computeAllObjectivesDone(objectives, progressRecord);

    if (!progress?.status) {
      const prereqTaskIds = asStringArray(def.prereq_task_ids);
      const prereqOk = await checkPrereqSatisfied(cid, prereqTaskIds);
      tasks.push({ taskId: tid, title, category, status: prereqOk ? 'available' : 'locked' });
      continue;
    }

    if (status === 'claimed') {
      tasks.push({ taskId: tid, title, category, status: 'claimed' });
      continue;
    }
    if (status === 'claimable') {
      tasks.push({ taskId: tid, title, category, status: 'claimable' });
      continue;
    }
    if ((status === 'turnin' && allDone) || (status === 'ongoing' && allDone)) {
      tasks.push({ taskId: tid, title, category, status: 'turnin' });
      continue;
    }
    tasks.push({ taskId: tid, title, category, status: 'accepted' });
  }

  // 查询主线任务
  let mainQuest: NpcTalkMainQuestOption | undefined;
  if (mainQuestRes.rows?.[0]) {
    const section = currentSectionId ? getMainQuestSectionById(currentSectionId) : null;
    const chapter = section ? getMainQuestChapterById(section.chapter_id) : null;
    if (section && section.enabled !== false && chapter && chapter.enabled !== false && section.npc_id === nid) {
      // 判断是否可以开始对话（未开始或对话中）
      const canStartDialogue = sectionStatus === 'not_started' || sectionStatus === 'dialogue';
      // 判断是否可以完成（可交付状态）
      const canComplete = sectionStatus === 'turnin';

      mainQuest = {
        sectionId: section.id,
        sectionName: String(section.name || section.id),
        chapterName: String(chapter.name || chapter.id),
        status: sectionStatus,
        canStartDialogue,
        canComplete,
      };
    }
  }

  return { success: true, message: 'ok', data: { npcId: nid, npcName, lines, tasks, mainQuest } };
};

/**
 * TaskService 类
 *
 * 作用：封装任务相关的核心业务逻辑，使用 @Transactional 装饰器管理事务
 *
 * 关键方法：
 * - claimTaskReward: 领取任务奖励（事务）
 * - recordCollectItemEvent: 记录收集物品事件（事务）
 *
 * 数据流：
 * - 输入：用户ID、角色ID、任务ID等业务参数
 * - 处理：校验状态、发放奖励、更新进度
 * - 输出：操作结果与奖励详情
 *
 * 边界条件：
 * - 使用 @Transactional 自动管理事务，无需手动 commit/rollback
 * - 所有 client.query 调用已替换为 query
 */
class TaskService {
  /**
   * 领取任务奖励
   *
   * @Transactional 自动管理事务边界
   *
   * 流程：
   * 1. 校验任务状态为 claimable
   * 2. 发放任务奖励（银两、灵石、物品）
   * 3. 发放悬赏奖励（如果有）
   * 4. 更新任务状态为 claimed
   */
  async claimTaskReward(
    userId: number,
    characterId: number,
    taskId: string
  ): Promise<{ success: boolean; message: string; data?: { taskId: string; rewards: ClaimedRewardResult[] } }> {
    const uid = Number(userId);
    const cid = Number(characterId);
    if (!Number.isFinite(uid) || uid <= 0) return { success: false, message: '未登录' };
    if (!Number.isFinite(cid) || cid <= 0) return { success: false, message: '角色不存在' };
    const tid = asNonEmptyString(taskId);
    if (!tid) return { success: false, message: '任务ID不能为空' };
    try {
      return await withTransaction(async () => {
        const characterRealmState = await loadCharacterTaskRealmState(cid);
        if (!characterRealmState) return { success: false, message: '角色不存在' };
        await resetRecurringTaskProgressIfNeeded(cid, undefined, characterRealmState);

        const taskDef = await getTaskDefinitionById(tid);
        if (!taskDef) {
          return { success: false, message: '任务不存在' };
        }
        const unlockFailureMessage = getTaskDefinitionUnlockFailureMessage(taskDef, characterRealmState);
        if (unlockFailureMessage) {
          return { success: false, message: unlockFailureMessage };
        }

        const claimTransition = await claimTaskRewardProgressTx(cid, tid);
        if (!claimTransition.claimed) {
          if (claimTransition.previousStatus === null) {
            return { success: false, message: '任务未接取' };
          }
          return { success: false, message: '任务不可领取' };
        }

        const rewards = parseRewards(taskDef.rewards);
        const applyResult = await this.applyTaskRewards(uid, cid, rewards);
        assertServiceSuccess(applyResult);

        const bountyResult = await this.applyBountyRewardOnTaskClaim(cid, tid);
        if (bountyResult.rewards.length > 0) {
          applyResult.rewards.push(...bountyResult.rewards);
        }
        mergeCharacterRewardDelta(applyResult.rewardDelta, bountyResult.rewardDelta);
        await applyCharacterRewardDeltas(new Map([[cid, applyResult.rewardDelta]]));

        return { success: true, message: 'ok', data: { taskId: tid, rewards: applyResult.rewards } };
      });
    } catch (error) {
      if (error instanceof BusinessError) {
        return { success: false, message: error.message };
      }
      throw error;
    }
  }

  /**
   * 应用任务奖励（内部方法，在事务中调用）
   */
  private async applyTaskRewards(
    userId: number,
    characterId: number,
    rewards: RawReward[]
  ): Promise<{ success: boolean; message: string; rewards: ClaimedRewardResult[]; rewardDelta: CharacterRewardDelta }> {
    const out: ClaimedRewardResult[] = [];
    const rewardDelta = createCharacterRewardDelta();

    for (const rw of rewards) {
      const type = asNonEmptyString(rw?.type) ?? '';
      if (type === 'silver') {
        const amount = asFiniteNonNegativeInt(rw?.amount, 0);
        if (amount <= 0) continue;
        appendClaimedCurrencyReward(out, rewardDelta, 'silver', amount);
        continue;
      }
      if (type === 'spirit_stones') {
        const amount = asFiniteNonNegativeInt(rw?.amount, 0);
        if (amount <= 0) continue;
        appendClaimedCurrencyReward(out, rewardDelta, 'spirit_stones', amount);
        continue;
      }
      if (type === 'item') {
        const itemDefId = asNonEmptyString(rw?.item_def_id);
        if (!itemDefId) continue;
        const qtyRange = resolveRewardQtyRange(rw);
        const qty = rollRangeIntInclusive(qtyRange.min, qtyRange.max);
        const itemMeta = resolveRewardItemDisplayMeta(itemDefId);
        const result = await enqueueCharacterItemGrant({
          characterId,
          userId,
          itemDefId,
          qty,
          obtainedFrom: 'task_reward',
        });
        if (!result.success) return { success: false, message: result.message, rewards: out, rewardDelta };
        out.push({
          type: 'item',
          itemDefId,
          qty,
          itemIds: result.itemIds,
          itemName: itemMeta.name || undefined,
          itemIcon: itemMeta.icon || undefined,
        });
        continue;
      }
    }

    return { success: true, message: 'ok', rewards: out, rewardDelta };
  }

  /**
   * 应用悬赏奖励（内部方法，在事务中调用）
   */
  private async applyBountyRewardOnTaskClaim(
    characterId: number,
    taskId: string
  ): Promise<{ rewards: ClaimedRewardResult[]; rewardDelta: CharacterRewardDelta }> {
    const res = await query<BountyClaimRewardTransitionRow>(
      `
        WITH target_claim AS (
          SELECT
            c.id AS claim_id,
            i.spirit_stones_reward,
            i.silver_reward
          FROM bounty_claim c
          JOIN bounty_instance i ON i.id = c.bounty_instance_id
          WHERE c.character_id = $1
            AND i.task_id = $2
            AND c.status IN ('claimed','completed')
          ORDER BY c.id ASC
          LIMIT 1
        ),
        rewarded_claim AS (
          UPDATE bounty_claim AS c
          SET status = 'rewarded',
              updated_at = NOW()
          WHERE c.id = (SELECT claim_id FROM target_claim)
            AND c.status IN ('claimed','completed')
          RETURNING c.id AS claim_id
        )
        SELECT
          t.claim_id,
          t.spirit_stones_reward,
          t.silver_reward
        FROM target_claim t
        JOIN rewarded_claim r ON r.claim_id = t.claim_id
      `,
      [characterId, taskId]
    );
    if ((res.rows ?? []).length === 0) {
      return { rewards: [], rewardDelta: createCharacterRewardDelta() };
    }

    const row = res.rows[0];
    const claimId = Number(row?.claim_id);
    if (!Number.isFinite(claimId) || claimId <= 0) {
      return { rewards: [], rewardDelta: createCharacterRewardDelta() };
    }

    const out: ClaimedRewardResult[] = [];
    const rewardDelta = createCharacterRewardDelta();
    const spirit = asFiniteNonNegativeInt(row?.spirit_stones_reward, 0);
    const silver = asFiniteNonNegativeInt(row?.silver_reward, 0);

    if (spirit > 0) {
      appendClaimedCurrencyReward(out, rewardDelta, 'spirit_stones', spirit);
    }
    if (silver > 0) {
      appendClaimedCurrencyReward(out, rewardDelta, 'silver', silver);
    }
    return { rewards: out, rewardDelta };
  }

  /**
   * 记录收集物品事件。
   *
   * 作用：
   * 1. 把高频收集事件直接写入 Redis Delta，避免掉落链路为任务/主线/成就同步开事务打库。
   * 2. 复用批量收集入口，让单条和批量事件都走同一套归一化与合并协议。
   *
   * 边界条件：
   * 1. 这里只负责写入缓存增量，不在当前调用栈内等待主线/成就实际落库。
   * 2. 调用方如果本身位于事务内，真正写 Redis 会自动延迟到事务提交后，避免回滚后留下脏进度。
   */
  async recordCollectItemEvent(characterId: number, itemId: string, count: number): Promise<void> {
    await this.recordCollectItemEvents(characterId, [{ itemId, count }]);
  }

  /**
   * 批量记录收集物品事件。
   *
   * 作用：
   * 1. 把同一角色的一批收集事件聚合成一组 Redis Delta field，降低同批掉落的缓存写放大。
   * 2. 让战斗掉落、邮件补发等入口共享同一套收集增量协议，避免 Redis key 设计散落。
   *
   * 边界条件：
   * 1. 重复 itemId 必须先合并，避免同一批次重复更新同一目标。
   * 2. 空事件或非法 itemId 直接忽略，和单条入口保持同一口径。
   */
  async recordCollectItemEvents(characterId: number, events: CollectItemEventInput[]): Promise<void> {
    await recordCollectItemEventsBatchInternal([{ characterId, events }]);
  }

  async recordCollectItemEventsBatch(inputs: CollectItemEventsBatchInput[]): Promise<void> {
    await recordCollectItemEventsBatchInternal(inputs);
  }
}

// 单例导出
export const taskService = new TaskService();
