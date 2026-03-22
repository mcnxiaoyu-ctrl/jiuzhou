/**
 * 千层塔冻结前沿选择入口。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中决定某层该走冻结怪物池还是最新怪物池，避免 tower service、overview、开战链路各写一套边界判断。
 * 2. 做什么：保持楼层生成算法单一，只切换怪物池来源，不再把冻结逻辑揉进 `algorithm.ts`。
 * 3. 不做什么：不负责数据库 schema 变更，不负责冻结快照写入。
 *
 * 输入/输出：
 * - 输入：楼层号、冻结前沿值，以及冻结/最新池对应的楼层解析器。
 * - 输出：楼层解析结果与当前使用的池来源标记。
 *
 * 数据流/状态流：
 * - tower service -> 读取冻结前沿/冻结池 -> 本模块决定来源 -> tower algorithm 解析楼层。
 *
 * 关键边界条件与坑点：
 * 1. 前沿判断只看 `floor <= frozenFloorMax`；不允许调用方自己散落实现不同口径。
 * 2. 前沿内外必须复用同一套楼层算法，只能替换怪物池来源，避免生成规则再次分叉。
 */

import {
  getLiveTowerMonsterPools,
  resolveTowerFloorFromPools,
} from './algorithm.js';
import { loadFrozenTowerPool } from './frozenPool.js';
import type { ResolvedTowerFloor, TowerMonsterPoolState } from './types.js';

type TowerFloorResolver = (floor: number) => ResolvedTowerFloor;

export interface FrozenFrontierTowerResolution extends ResolvedTowerFloor {
  poolSource: 'frozen' | 'latest';
}

const buildTowerFloorResolver = (
  pools: TowerMonsterPoolState,
): TowerFloorResolver => {
  return (floor: number) =>
    resolveTowerFloorFromPools({
      floor,
      pools,
    });
};

export const resolveTowerFloorFromFrozenFrontier = (params: {
  floor: number;
  frozenFloorMax: number;
  frozenResolver: TowerFloorResolver;
  latestResolver: TowerFloorResolver;
}): FrozenFrontierTowerResolution => {
  if (params.floor <= params.frozenFloorMax) {
    return {
      poolSource: 'frozen',
      ...params.frozenResolver(params.floor),
    };
  }
  return {
    poolSource: 'latest',
    ...params.latestResolver(params.floor),
  };
};

export const resolveTowerFloorByFrozenFrontier = async (
  floor: number,
): Promise<FrozenFrontierTowerResolution> => {
  const { frontier, pools: frozenPools } = await loadFrozenTowerPool();
  const latestPools = getLiveTowerMonsterPools();

  return resolveTowerFloorFromFrozenFrontier({
    floor,
    frozenFloorMax: frontier.frozenFloorMax,
    frozenResolver: buildTowerFloorResolver(frozenPools),
    latestResolver: buildTowerFloorResolver(latestPools),
  });
};
