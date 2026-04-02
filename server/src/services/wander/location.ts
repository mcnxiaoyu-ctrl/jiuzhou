/**
 * 云游奇遇幕次地点规划
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：基于故事种子与幕次序号，为每一幕稳定挑选一个随机地图与该地图下的随机区域，供云游 AI 生成与结算共用。
 * 2. 做什么：把地图静态配置到“可用于云游的地点池”转换集中在这里，避免 service 与 prompt 入口重复解析 `map_def.json`。
 * 3. 不做什么：不写数据库，不读取角色当前位置，也不决定剧情文本本身。
 *
 * 输入 / 输出：
 * - 输入：`storySeed` 与 `episodeIndex`。
 * - 输出：当前幕固定地点，包含地区、地图、区域与组合展示名。
 *
 * 数据流 / 状态流：
 * - `wanderService` 生成或结算某一幕时传入 `storySeed + episodeIndex`
 * - 本模块稳定选出该幕地点
 * - AI prompt 统一使用同一地点，保证同幕生成与结算不漂移
 *
 * 复用设计说明：
 * 1. 地点池构建与稳定随机是同一类高频业务规则，单独拆分后，生成下一幕、结算当前幕、回填历史幕次都能复用同一入口。
 * 2. 地图筛选、区域解析和展示名拼接集中在这里，避免后续多处手写“地区 + 地图 + 区域”导致口径分叉。
 *
 * 关键边界条件与坑点：
 * 1. 同一 `storySeed + episodeIndex` 必须始终映射到同一地点，否则同一幕的生成和结算会出现地点漂移。
 * 2. 地点池必须只包含启用且具备合法房间名称的地图；否则模型会拿到空地点或不可用地图。
 */

import { getMapDefinitions, type MapDefConfig } from '../staticConfigLoader.js';
import { pickDeterministicItem } from '../shared/deterministicHash.js';

type WanderLocationRoom = {
  id: string;
  name: string;
};

type WanderLocationMap = {
  id: string;
  name: string;
  region: string;
  areas: WanderLocationRoom[];
};

export interface WanderStoryLocation {
  region: string;
  mapId: string;
  mapName: string;
  areaId: string;
  areaName: string;
  fullName: string;
}

const isNonEmptyString = (value: unknown): value is string => {
  return typeof value === 'string' && value.trim().length > 0;
};

const isEnabledMap = (map: MapDefConfig): boolean => {
  return map.enabled !== false;
};

const parseLocationRooms = (rooms: unknown): WanderLocationRoom[] => {
  if (!Array.isArray(rooms)) {
    return [];
  }

  const normalizedRooms: WanderLocationRoom[] = [];

  for (const room of rooms) {
    if (typeof room !== 'object' || room === null) {
      continue;
    }

    const roomId = 'id' in room && isNonEmptyString(room.id) ? room.id.trim() : '';
    const roomName = 'name' in room && isNonEmptyString(room.name) ? room.name.trim() : '';
    if (!roomId || !roomName) {
      continue;
    }

    normalizedRooms.push({
      id: roomId,
      name: roomName,
    });
  }

  normalizedRooms.sort((left, right) => left.id.localeCompare(right.id, 'zh-Hans-CN'));
  return normalizedRooms;
};

const buildWanderLocationPool = (): WanderLocationMap[] => {
  const locationMaps: WanderLocationMap[] = [];

  for (const map of getMapDefinitions()) {
    if (!isEnabledMap(map)) {
      continue;
    }

    const mapId = isNonEmptyString(map.id) ? map.id.trim() : '';
    const mapName = isNonEmptyString(map.name) ? map.name.trim() : '';
    const region = isNonEmptyString(map.region) ? map.region.trim() : '';
    const areas = parseLocationRooms(map.rooms);

    if (!mapId || !mapName || !region || areas.length <= 0) {
      continue;
    }

    locationMaps.push({
      id: mapId,
      name: mapName,
      region,
      areas,
    });
  }

  locationMaps.sort((left, right) => left.id.localeCompare(right.id, 'zh-Hans-CN'));
  return locationMaps;
};

const WANDER_LOCATION_POOL = buildWanderLocationPool();

export const resolveWanderStoryLocation = (params: {
  storySeed: number;
  episodeIndex: number;
}): WanderStoryLocation => {
  if (WANDER_LOCATION_POOL.length <= 0) {
    throw new Error('云游奇遇地点池为空');
  }

  const normalizedEpisodeIndex = Math.max(1, Math.floor(params.episodeIndex));
  const seed = `wander-story-location:${Math.trunc(params.storySeed)}:${normalizedEpisodeIndex}`;
  const selectedMap = pickDeterministicItem({
    seed,
    items: WANDER_LOCATION_POOL,
  });
  const selectedArea = pickDeterministicItem({
    seed,
    items: selectedMap.areas,
    offset: 1,
  });

  return {
    region: selectedMap.region,
    mapId: selectedMap.id,
    mapName: selectedMap.name,
    areaId: selectedArea.id,
    areaName: selectedArea.name,
    fullName: `${selectedMap.region}·${selectedMap.name}·${selectedArea.name}`,
  };
};
