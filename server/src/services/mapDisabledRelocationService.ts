/**
 * 禁用地图角色迁移服务
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中维护“地图关闭后角色应该迁到哪里”以及“如何把角色迁出禁用地图”的规则。
 * 2. 做什么：优先复用地图配置里的复活落点；若该落点本身不可用，则统一迁往项目默认出生点。
 * 3. 不做什么：不决定何时触发迁移，不接管挂机/战斗会话终止状态，也不吞掉迁移失败异常。
 *
 * 输入/输出：
 * - 输入：源地图 ID，或 `characterId/userId/sourceMapId` 组合。
 * - 输出：解析后的可落脚目标 `{ mapId, roomId, strategy }`，以及迁移执行结果。
 *
 * 数据流/状态流：
 * - 业务方发现角色仍停留在禁用地图
 * - -> 本模块读取 source map 定义与目标房间可用性
 * - -> 解析唯一迁移落点
 * - -> 调用 characterService 只写位置并同步在线战斗快照
 * - -> 推送角色刷新给在线客户端。
 *
 * 复用设计说明：
 * - 地图关闭、活动图收口、异常运行态清理都需要同一套“禁用地图迁移落点”规则。
 * - 把 revive 落点判断与默认出生点收口到这里，能避免挂机、地图路由、后台清理任务各自散落一套 if/else。
 * - 高变化点在“迁移落点规则”，因此集中成独立模块最利于后续统一调整。
 *
 * 关键边界条件与坑点：
 * 1. 禁用地图自己的 `revive_map_id/revive_room_id` 可能仍指向自己，不能直接照搬，必须重新校验目标房间是否真的可用。
 * 2. 后台强制迁移不能复用前台移动入口，否则会误推进 reach 型主线与探索成就。
 */
import { safePushCharacterUpdate } from '../middleware/pushUpdate.js';
import { relocateCharacterPositionByCharacterId } from './characterService.js';
import { getMapDefById, getRoomInMap } from './mapService.js';

const DISABLED_MAP_SAFE_SPAWN = {
  mapId: 'map-qingyun-village',
  roomId: 'room-village-center',
} as const;

export type DisabledMapRelocationTarget = {
  mapId: string;
  roomId: string;
  strategy: 'revive_point' | 'safe_spawn';
};

const normalizeTargetId = (value: string | null | undefined): string => {
  return typeof value === 'string' ? value.trim() : '';
};

const resolveUsableTarget = async (
  mapId: string,
  roomId: string,
): Promise<{ mapId: string; roomId: string } | null> => {
  const normalizedMapId = normalizeTargetId(mapId);
  const normalizedRoomId = normalizeTargetId(roomId);
  if (!normalizedMapId || !normalizedRoomId) {
    return null;
  }

  const room = await getRoomInMap(normalizedMapId, normalizedRoomId);
  if (!room) {
    return null;
  }

  return {
    mapId: normalizedMapId,
    roomId: normalizedRoomId,
  };
};

export const resolveDisabledMapRelocationTarget = async (
  sourceMapId: string,
): Promise<DisabledMapRelocationTarget> => {
  const sourceMap = await getMapDefById(sourceMapId);
  if (sourceMap) {
    const reviveTarget = await resolveUsableTarget(
      normalizeTargetId(sourceMap.revive_map_id),
      normalizeTargetId(sourceMap.revive_room_id),
    );
    if (reviveTarget) {
      return {
        ...reviveTarget,
        strategy: 'revive_point',
      };
    }
  }

  const safeSpawnTarget = await resolveUsableTarget(
    DISABLED_MAP_SAFE_SPAWN.mapId,
    DISABLED_MAP_SAFE_SPAWN.roomId,
  );
  if (!safeSpawnTarget) {
    throw new Error('禁用地图迁移默认落点不可用');
  }

  return {
    ...safeSpawnTarget,
    strategy: 'safe_spawn',
  };
};

export const relocateCharacterOutOfDisabledMap = async (params: {
  characterId: number;
  userId: number;
  sourceMapId: string;
}): Promise<DisabledMapRelocationTarget> => {
  const target = await resolveDisabledMapRelocationTarget(params.sourceMapId);
  const relocateResult = await relocateCharacterPositionByCharacterId(
    params.characterId,
    target.mapId,
    target.roomId,
  );
  if (!relocateResult.success) {
    throw new Error(relocateResult.message);
  }

  await safePushCharacterUpdate(params.userId);
  return target;
};
