/**
 * 千层塔冻结前沿读取与怪物池组装。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中读取单一冻结前沿，并把冻结怪物成员关系组装成塔战可用的 `kind -> realm -> monsters` 池。
 * 2. 做什么：把“前沿读取”“成员读取”“池分组”收口成一个入口，避免 tower service 后面各自拼查询和分组逻辑。
 * 3. 不做什么：不决定楼层该用冻结池还是最新池，不修改 tower 算法本身。
 *
 * 输入/输出：
 * - 输入：数据库中的冻结前沿行与冻结怪物成员行。
 * - 输出：规范化后的前沿记录、冻结怪物池，以及可供后续塔战使用的稳定数据结构。
 *
 * 数据流/状态流：
 * - 读取 `tower_frozen_frontier` -> 按 `frozen_floor_max` 读取 `tower_frozen_monster_snapshot` -> 用当前怪物定义回填成员池。
 *
 * 关键边界条件与坑点：
 * 1. 冻结前沿缺行时等价于 `frozen_floor_max=0`，表示当前还没有任何冻结区间。
 * 2. 冻结成员必须与前沿值一致；如果混入别的前沿数据，说明写入或清理流程出了问题。
 */

import { query } from '../../config/database.js';
import { isRealmName } from '../shared/realmRules.js';
import { getMonsterDefinitions, type MonsterDefConfig } from '../staticConfigLoader.js';
import type {
  TowerFloorKind,
  TowerFrozenFrontierRecord,
  TowerMonsterPoolState,
  TowerFrozenMonsterSnapshot,
} from './types.js';

type TowerFrozenFrontierRow = {
  scope: string;
  frozen_floor_max: number | string;
  updated_at: string | Date;
};

type TowerFrozenMonsterSnapshotRow = {
  frozen_floor_max: number | string;
  kind: string;
  realm: string;
  monster_def_id: string;
  updated_at: string | Date;
};

export interface FrozenTowerPoolLoadResult {
  frontier: TowerFrozenFrontierRecord;
  pools: TowerMonsterPoolState;
}

const TOWER_SCOPED_FRONTIER_KEY = 'tower';
const EMPTY_TOWER_FROZEN_FRONTIER_UPDATED_AT = new Date(0).toISOString();

const isTowerFloorKind = (value: string): value is TowerFloorKind => {
  return value === 'normal' || value === 'elite' || value === 'boss';
};

const parseNonNegativeInteger = (value: number | string, fieldName: string): number => {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`千层塔冻结数据字段非法: ${fieldName}`);
  }
  return parsed;
};

const parseRequiredText = (value: string, fieldName: string): string => {
  const next = value.trim();
  if (!next) {
    throw new Error(`千层塔冻结数据字段非法: ${fieldName}`);
  }
  return next;
};

const parseTimestamp = (value: string | Date, fieldName: string): string => {
  if (value instanceof Date) {
    const next = value.toISOString();
    if (!next) {
      throw new Error(`千层塔冻结数据字段非法: ${fieldName}`);
    }
    return next;
  }
  const next = value.trim();
  if (!next) {
    throw new Error(`千层塔冻结数据字段非法: ${fieldName}`);
  }
  return next;
};

export const normalizeFrozenTowerFrontierRow = (
  row: TowerFrozenFrontierRow,
): TowerFrozenFrontierRecord => {
  const scope = parseRequiredText(row.scope, 'scope');
  if (scope !== TOWER_SCOPED_FRONTIER_KEY) {
    throw new Error(`千层塔冻结前沿 scope 非法: ${scope}`);
  }

  return {
    frozenFloorMax: parseNonNegativeInteger(row.frozen_floor_max, 'frozen_floor_max'),
    updatedAt: parseTimestamp(row.updated_at, 'updated_at'),
  };
};

export const normalizeFrozenTowerMonsterSnapshotRow = (
  row: TowerFrozenMonsterSnapshotRow,
): TowerFrozenMonsterSnapshot => {
  const frozenFloorMax = parseNonNegativeInteger(row.frozen_floor_max, 'frozen_floor_max');
  const kind = parseRequiredText(row.kind, 'kind');
  if (!isTowerFloorKind(kind)) {
    throw new Error(`千层塔冻结怪物快照 kind 非法: ${kind}`);
  }

  const realm = parseRequiredText(row.realm, 'realm');
  if (!isRealmName(realm)) {
    throw new Error(`千层塔冻结怪物快照 realm 非法: ${realm}`);
  }

  const monsterDefId = parseRequiredText(row.monster_def_id, 'monster_def_id');

  return {
    frozenFloorMax,
    kind,
    realm,
    monsterDefId,
    updatedAt: parseTimestamp(row.updated_at, 'updated_at'),
  };
};

const createEmptyFrozenTowerMonsterPools = (): TowerMonsterPoolState => {
  return {
    normal: new Map<string, MonsterDefConfig[]>(),
    elite: new Map<string, MonsterDefConfig[]>(),
    boss: new Map<string, MonsterDefConfig[]>(),
  };
};

const getFrozenTowerMonsterPoolBucket = (
  pools: TowerMonsterPoolState,
  kind: TowerFloorKind,
): Map<string, MonsterDefConfig[]> => {
  if (kind === 'boss') return pools.boss;
  if (kind === 'elite') return pools.elite;
  return pools.normal;
};

const buildCurrentMonsterDefinitionIndex = (
  monsterDefinitions: MonsterDefConfig[],
): Map<string, MonsterDefConfig> => {
  const index = new Map<string, MonsterDefConfig>();
  for (const monster of monsterDefinitions) {
    const monsterId = typeof monster.id === 'string' ? monster.id.trim() : '';
    if (!monsterId) continue;
    index.set(monsterId, {
      ...monster,
      id: monsterId,
    });
  }
  return index;
};

export const buildFrozenTowerMonsterPools = (
  rows: TowerFrozenMonsterSnapshotRow[],
  monsterDefinitions: MonsterDefConfig[] = getMonsterDefinitions(),
): TowerMonsterPoolState => {
  if (rows.length === 0) {
    return createEmptyFrozenTowerMonsterPools();
  }

  const pools = createEmptyFrozenTowerMonsterPools();
  const expectedFrozenFloorMax = parseNonNegativeInteger(rows[0]!.frozen_floor_max, 'frozen_floor_max');
  const monsterDefinitionIndex = buildCurrentMonsterDefinitionIndex(monsterDefinitions);

  for (const row of rows) {
    const snapshot = normalizeFrozenTowerMonsterSnapshotRow(row);
    if (snapshot.frozenFloorMax !== expectedFrozenFloorMax) {
      throw new Error('千层塔冻结怪物快照前沿值不一致');
    }
    const currentMonster = monsterDefinitionIndex.get(snapshot.monsterDefId);
    if (!currentMonster) {
      throw new Error(`千层塔冻结怪物定义不存在: ${snapshot.monsterDefId}`);
    }

    const bucket = getFrozenTowerMonsterPoolBucket(pools, snapshot.kind);
    const realmRows = bucket.get(snapshot.realm) ?? [];
    realmRows.push({
      ...currentMonster,
      kind: snapshot.kind,
      realm: snapshot.realm,
    });
    bucket.set(snapshot.realm, realmRows);
  }

  for (const bucket of [pools.normal, pools.elite, pools.boss] as const) {
    for (const monsters of bucket.values()) {
      monsters.sort((left, right) => left.id.localeCompare(right.id));
    }
  }

  return pools;
};

export const loadFrozenTowerFrontier = async (): Promise<TowerFrozenFrontierRecord> => {
  const result = await query<TowerFrozenFrontierRow>(
    `
      SELECT
        scope,
        frozen_floor_max,
        updated_at
      FROM tower_frozen_frontier
      WHERE scope = $1
      LIMIT 1
    `,
    [TOWER_SCOPED_FRONTIER_KEY],
  );
  const row = result.rows[0];
  if (!row) {
    return {
      frozenFloorMax: 0,
      updatedAt: EMPTY_TOWER_FROZEN_FRONTIER_UPDATED_AT,
    };
  }
  return normalizeFrozenTowerFrontierRow(row);
};

export const loadFrozenTowerMonsterPools = async (
  frozenFloorMax: number,
): Promise<TowerMonsterPoolState> => {
  const normalizedFrozenFloorMax = parseNonNegativeInteger(frozenFloorMax, 'frozen_floor_max');
  const result = await query<TowerFrozenMonsterSnapshotRow>(
    `
      SELECT
        frozen_floor_max,
        kind,
        realm,
        monster_def_id,
        updated_at
      FROM tower_frozen_monster_snapshot
      WHERE frozen_floor_max = $1
      ORDER BY kind ASC, realm ASC, monster_def_id ASC
    `,
    [normalizedFrozenFloorMax],
  );
  if (result.rows.length === 0) {
    if (normalizedFrozenFloorMax === 0) {
      return createEmptyFrozenTowerMonsterPools();
    }
    throw new Error(`千层塔冻结怪物池缺失: frozen_floor_max=${normalizedFrozenFloorMax}`);
  }
  return buildFrozenTowerMonsterPools(result.rows);
};

export const loadFrozenTowerPool = async (): Promise<FrozenTowerPoolLoadResult> => {
  const frontier = await loadFrozenTowerFrontier();
  const pools = await loadFrozenTowerMonsterPools(frontier.frozenFloorMax);
  return {
    frontier,
    pools,
  };
};
