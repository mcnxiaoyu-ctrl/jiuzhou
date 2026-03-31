import { getMapDefinitions } from './staticConfigLoader.js';

export type GridPosition = 'NW' | 'N' | 'NE' | 'W' | 'C' | 'E' | 'SW' | 'S' | 'SE';

export type WorldMapAreaDto = {
  id: GridPosition;
  name: string;
  description: string;
  level: string;
};

export type MapDefRow = {
  id: string;
  code: string | null;
  name: string;
  description: string | null;
  background_image: string | null;
  map_type: string;
  parent_map_id: string | null;
  world_position: unknown;
  region: string | null;
  req_realm_min: string | null;
  req_level_min: number;
  req_quest_id: string | null;
  req_item_id: string | null;
  safe_zone: boolean;
  pk_mode: string | null;
  revive_map_id: string | null;
  revive_room_id: string | null;
  rooms: unknown;
  sort_weight: number;
  enabled: boolean;
};

export type MapRoom = {
  id: string;
  name: string;
  description?: string;
  position?: { x: number; y: number };
  room_type?: string;
  connections?: Array<{
    direction: string;
    target_room_id: string;
    target_map_id?: string;
    req_item_id?: string;
    req_realm_min?: string;
  }>;
  npcs?: string[];
  monsters?: Array<{ monster_def_id: string; count: number; respawn_sec?: number }>;
  resources?: Array<{ resource_id: string; count: number; respawn_sec?: number; collect_limit?: number }>;
  items?: Array<{ item_def_id: string; once?: boolean; chance?: number; req_quest_id?: string }>;
  portals?: Array<{ target_map_id: string; target_room_id: string; name: string; req_realm_min?: string }>;
  events?: Array<{ event_id: string; trigger: string; once?: boolean }>;
};

const parseRooms = (rooms: unknown): MapRoom[] => {
  if (Array.isArray(rooms)) return rooms as MapRoom[];
  if (typeof rooms === 'string') {
    try {
      const parsed = JSON.parse(rooms) as unknown;
      return Array.isArray(parsed) ? (parsed as MapRoom[]) : [];
    } catch {
      return [];
    }
  }
  return [];
};

const mapDefCache = new Map<string, MapDefRow | null>();
const mapRoomsCache = new Map<string, MapRoom[]>();

/**
 * 统一地图可用性判定。
 * 约定：仅当 enabled 显式为 false 时视为不可用；缺省按可用处理。
 */
export const isMapEnabled = (
  map: { enabled?: boolean | null } | null | undefined
): boolean => {
  return Boolean(map && map.enabled !== false);
};

export const getMapDefById = async (mapId: string): Promise<MapDefRow | null> => {
  if (mapDefCache.has(mapId)) {
    return mapDefCache.get(mapId) ?? null;
  }

  const row = (getMapDefinitions().find((entry) => entry.id === mapId) ?? null) as MapDefRow | null;
  mapDefCache.set(mapId, row);
  if (row && isMapEnabled(row)) {
    mapRoomsCache.set(mapId, parseRooms(row.rooms));
  } else {
    mapRoomsCache.delete(mapId);
  }
  return row;
};

export const getEnabledMaps = async (): Promise<
  Array<
    Pick<
      MapDefRow,
      'id' | 'code' | 'name' | 'description' | 'background_image' | 'map_type' | 'region' | 'sort_weight' | 'req_level_min' | 'req_realm_min'
    >
  >
> => {
  return getMapDefinitions()
    .filter((entry) => isMapEnabled(entry))
    .sort((left, right) => {
      const leftSortWeight = Number(left.sort_weight ?? 0);
      const rightSortWeight = Number(right.sort_weight ?? 0);
      if (leftSortWeight !== rightSortWeight) return rightSortWeight - leftSortWeight;
      return String(left.id || '').localeCompare(String(right.id || ''));
    })
    .map((entry) => ({
      id: entry.id,
      code: entry.code ?? null,
      name: entry.name,
      description: entry.description ?? null,
      background_image: entry.background_image ?? null,
      map_type: entry.map_type ?? 'field',
      region: entry.region ?? null,
      sort_weight: Number(entry.sort_weight ?? 0),
      req_level_min: Number(entry.req_level_min ?? 0),
      req_realm_min: entry.req_realm_min ?? null,
    }));
};

export const getRoomsInMap = async (mapId: string): Promise<MapRoom[]> => {
  const map = await getMapDefById(mapId);
  if (!map || !isMapEnabled(map)) {
    mapRoomsCache.delete(mapId);
    return [];
  }

  const cachedRooms = mapRoomsCache.get(mapId);
  if (cachedRooms) return cachedRooms;

  const rooms = parseRooms(map.rooms);
  mapRoomsCache.set(mapId, rooms);
  return rooms;
};

export const getRoomInMap = async (mapId: string, roomId: string): Promise<MapRoom | null> => {
  const rooms = await getRoomsInMap(mapId);
  return rooms.find((r) => r.id === roomId) ?? null;
};

const ALL_POSITIONS: GridPosition[] = ['NW', 'N', 'NE', 'W', 'C', 'E', 'SW', 'S', 'SE'];

const POS_COORD: Record<GridPosition, { x: number; y: number }> = {
  NW: { x: -1, y: 1 },
  N: { x: 0, y: 1 },
  NE: { x: 1, y: 1 },
  W: { x: -1, y: 0 },
  C: { x: 0, y: 0 },
  E: { x: 1, y: 0 },
  SW: { x: -1, y: -1 },
  S: { x: 0, y: -1 },
  SE: { x: 1, y: -1 },
};

const coordKey = (x: number, y: number) => `${x},${y}`;

const POS_BY_COORD: Record<string, GridPosition> = Object.fromEntries(
  ALL_POSITIONS.map((p) => [coordKey(POS_COORD[p].x, POS_COORD[p].y), p])
) as Record<string, GridPosition>;

export const getWorldMap = async (): Promise<{
  mapName: string;
  areas: WorldMapAreaDto[];
  connections: Array<[GridPosition, GridPosition]>;
}> => {
  const areas: WorldMapAreaDto[] = ALL_POSITIONS.map((id) => ({
    id,
    name: id,
    description: '',
    level: 'Lv.1',
  }));

  const connections: Array<[GridPosition, GridPosition]> = [];
  const added = new Set<string>();
  for (const p of ALL_POSITIONS) {
    const { x, y } = POS_COORD[p];
    const neighbors = [
      { x: x, y: y + 1 },
      { x: x, y: y - 1 },
      { x: x - 1, y: y },
      { x: x + 1, y: y },
    ];
    for (const n of neighbors) {
      const other = POS_BY_COORD[coordKey(n.x, n.y)];
      if (!other) continue;
      const a = p < other ? p : other;
      const b = p < other ? other : p;
      const k = `${a}-${b}`;
      if (added.has(k)) continue;
      added.add(k);
      connections.push([a, b]);
    }
  }

  return { mapName: '九州大陆', areas, connections };
};

