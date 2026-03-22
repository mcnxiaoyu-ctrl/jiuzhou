/**
 * 千层塔冻结前沿写入服务。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中校验冻结前沿只能单调前进，并把当前 live 怪物池扁平化写入冻结成员快照。
 * 2. 做什么：为脚本或后台入口提供单一冻结写口，避免不同地方各自拼 SQL 与快照结构。
 * 3. 不做什么：不负责楼层解析，不切换冻结/最新池读取逻辑。
 *
 * 输入/输出：
 * - 输入：目标冻结前沿，以及当前 live 怪物池。
 * - 输出：待写入的冻结成员快照列表，以及冻结完成后的概要信息。
 *
 * 数据流/状态流：
 * - 调用方给出目标前沿 -> 校验前沿递增 -> 读取 live 怪物池 -> 生成冻结成员快照 -> 事务写入前沿与快照。
 *
 * 关键边界条件与坑点：
 * 1. 冻结前沿只能前进，不能回退或重复；否则旧层冻结边界会被破坏。
 * 2. 冻结的是成员关系而不是属性快照，所以这里绝不复制怪物 attrs/skills，后续旧怪属性变动会自然体现在冻结层。
 */

import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../config/database.js';
import { getLiveTowerMonsterPools } from './algorithm.js';
import type {
  TowerFloorKind,
  TowerFrozenMonsterSnapshot,
  TowerMonsterPoolState,
} from './types.js';

interface TowerFrozenFrontierRow {
  frozen_floor_max: number | string;
}

export interface TowerFrozenSnapshotInsertRecord {
  frozenFloorMax: number;
  kind: TowerFloorKind;
  realm: string;
  monsterDefId: string;
}

export const assertTowerFrozenFrontierAdvanceable = (params: {
  currentFrozenFloorMax: number;
  nextFrozenFloorMax: number;
}): void => {
  const currentFrozenFloorMax = Math.max(0, Math.floor(params.currentFrozenFloorMax));
  const nextFrozenFloorMax = Math.max(0, Math.floor(params.nextFrozenFloorMax));
  if (nextFrozenFloorMax <= currentFrozenFloorMax) {
    throw new Error('冻结前沿必须大于当前前沿');
  }
};

export const buildTowerFrozenMonsterSnapshots = (params: {
  frozenFloorMax: number;
  pools: TowerMonsterPoolState;
}): TowerFrozenSnapshotInsertRecord[] => {
  const frozenFloorMax = Math.max(0, Math.floor(params.frozenFloorMax));
  const snapshots: TowerFrozenSnapshotInsertRecord[] = [];

  const pushBucket = (
    kind: TowerFloorKind,
    bucket: Map<string, { id?: string }[]>,
  ): void => {
    const realms = Array.from(bucket.keys()).sort((left, right) => left.localeCompare(right));
    for (const realm of realms) {
      const monsters = (bucket.get(realm) ?? [])
        .map((monster) => (typeof monster.id === 'string' ? monster.id.trim() : ''))
        .filter((monsterId) => monsterId.length > 0)
        .sort((left, right) => left.localeCompare(right));
      for (const monsterDefId of monsters) {
        snapshots.push({
          frozenFloorMax,
          kind,
          realm,
          monsterDefId,
        });
      }
    }
  };

  pushBucket('boss', params.pools.boss);
  pushBucket('elite', params.pools.elite);
  pushBucket('normal', params.pools.normal);
  return snapshots;
};

const loadCurrentFrozenFloorMax = async (client?: PoolClient): Promise<number> => {
  const sql = `
    SELECT frozen_floor_max
    FROM tower_frozen_frontier
    WHERE scope = 'tower'
    LIMIT 1
  `;
  const result = client
    ? await client.query<TowerFrozenFrontierRow>(sql)
    : await query<TowerFrozenFrontierRow>(sql);
  const row = result.rows[0];
  if (!row) {
    return 0;
  }
  return Math.max(0, Math.floor(Number(row.frozen_floor_max) || 0));
};

const upsertTowerFrozenFrontier = async (params: {
  client: PoolClient;
  frozenFloorMax: number;
}): Promise<void> => {
  await params.client.query(
    `
      INSERT INTO tower_frozen_frontier (scope, frozen_floor_max, updated_at)
      VALUES ('tower', $1, NOW())
      ON CONFLICT (scope) DO UPDATE
      SET frozen_floor_max = EXCLUDED.frozen_floor_max,
          updated_at = NOW()
    `,
    [params.frozenFloorMax],
  );
};

const replaceTowerFrozenMonsterSnapshots = async (params: {
  client: PoolClient;
  frozenFloorMax: number;
  snapshots: TowerFrozenSnapshotInsertRecord[];
}): Promise<void> => {
  await params.client.query(
    `
      DELETE FROM tower_frozen_monster_snapshot
      WHERE frozen_floor_max = $1
    `,
    [params.frozenFloorMax],
  );

  for (const snapshot of params.snapshots) {
    await params.client.query(
      `
        INSERT INTO tower_frozen_monster_snapshot (
          frozen_floor_max,
          kind,
          realm,
          monster_def_id,
          updated_at
        )
        VALUES ($1, $2, $3, $4, NOW())
      `,
      [
        snapshot.frozenFloorMax,
        snapshot.kind,
        snapshot.realm,
        snapshot.monsterDefId,
      ],
    );
  }
};

export const freezeTowerFrontier = async (nextFrozenFloorMax: number): Promise<{
  frozenFloorMax: number;
  snapshotCount: number;
}> => {
  return withTransaction(async (client) => {
    const currentFrozenFloorMax = await loadCurrentFrozenFloorMax(client);
    assertTowerFrozenFrontierAdvanceable({
      currentFrozenFloorMax,
      nextFrozenFloorMax,
    });

    const snapshots = buildTowerFrozenMonsterSnapshots({
      frozenFloorMax: nextFrozenFloorMax,
      pools: getLiveTowerMonsterPools(),
    });

    await replaceTowerFrozenMonsterSnapshots({
      client,
      frozenFloorMax: nextFrozenFloorMax,
      snapshots,
    });
    await upsertTowerFrozenFrontier({
      client,
      frozenFloorMax: nextFrozenFloorMax,
    });

    return {
      frozenFloorMax: Math.max(0, Math.floor(nextFrozenFloorMax)),
      snapshotCount: snapshots.length,
    };
  });
};
