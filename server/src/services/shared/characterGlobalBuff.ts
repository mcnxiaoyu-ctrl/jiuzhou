/**
 * 角色全局 Buff 共享模块
 *
 * 作用：
 * 1. 统一维护角色“全局 Buff”的存储键、聚合查询、展示快照、签名生成与属性应用入口。
 * 2. 为宗门祈福、后续活动增益、限时福利等全局效果提供同一套数据面，避免每个玩法各自建表、各自拼属性。
 * 不做：
 * 1. 不决定具体玩法何时发放 Buff，也不处理每日次数、权限与资源校验。
 * 2. 不直接渲染前端交互；UI 只消费这里生成的统一展示快照。
 *
 * 输入 / 输出：
 * - 输入：角色 ID 列表、Buff 键、Buff 来源、开始/结束时间、数值。
 * - 输出：按角色聚合后的 Buff 数值映射、可直接下发前端的 Buff 展示快照、单条 Buff 记录、属性签名片段。
 *
 * 数据流 / 状态流：
 * - 玩法服务写入 `character_global_buff`；
 * - 角色属性计算批量读取当前有效 Buff，并按 Buff 键汇总；
 * - 计算层通过统一映射把 Buff 数值应用到角色属性。
 *
 * 复用设计说明：
 * - 把“Buff 怎么存”“怎么聚合”“怎么展示”“怎么接到属性计算”收敛在这里，后续新增全局 Buff 只需要扩 Buff 键和展示定义，不再改每个业务入口。
 * - 被 `characterComputedService.ts`、`sect/blessing.ts` 与 `gameServer.ts` 复用。
 * - 全局 Buff 属于高频业务变化点，集中后可以避免再次散落出多套临时表/临时 SQL。
 *
 * 关键边界条件与坑点：
 * 1. 聚合查询只认 `expire_at > now` 的有效 Buff，不能把历史记录误算进当前属性。
 * 2. 属性签名必须显式包含所有已接入计算链的 Buff 键，否则缓存会在 Buff 变化后继续命中旧结果。
 */
import { query } from '../../config/database.js';
import { BLESSING_HALL_BUILDING_TYPE } from '../sect/buildingConfig.js';

export const GLOBAL_BUFF_KEY_FUYUAN_FLAT = 'fuyuan_flat';
const SECT_BLESSING_SOURCE_TYPE = 'sect_blessing';

export const COMPUTED_CHARACTER_GLOBAL_BUFF_KEYS = [
  GLOBAL_BUFF_KEY_FUYUAN_FLAT,
] as const;

export type CharacterGlobalBuffKey =
  typeof COMPUTED_CHARACTER_GLOBAL_BUFF_KEYS[number];

export type CharacterGlobalBuffValues = Partial<
  Record<CharacterGlobalBuffKey, number>
>;

export interface CharacterGlobalBuffRow {
  id: number | string;
  character_id: number | string;
  buff_key: string;
  source_type: string;
  source_id: string;
  buff_value: number | string;
  grant_day_key: Date | string | null;
  started_at: Date | string;
  expire_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface CharacterGlobalBuffUpsertPayload {
  characterId: number;
  buffKey: CharacterGlobalBuffKey;
  sourceType: string;
  sourceId: string;
  buffValue: number;
  grantDayKey?: string | null;
  startedAt: Date;
  expireAt: Date;
}

export interface CharacterGlobalBuffSnapshot {
  id: string;
  buffKey: string;
  label: string;
  iconText: string;
  effectText: string;
  startedAt: string;
  expireAt: string;
  totalDurationMs: number;
}

interface CharacterGlobalBuffDisplayDefinition {
  buffKey: CharacterGlobalBuffKey;
  sourceType: string;
  sourceId: string;
  label: string;
  buildEffectText: (buffValue: number) => string;
}

const formatCharacterGlobalBuffValue = (value: number): string => {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
};

const CHARACTER_GLOBAL_BUFF_DISPLAY_DEFINITIONS = [
  {
    buffKey: GLOBAL_BUFF_KEY_FUYUAN_FLAT,
    sourceType: SECT_BLESSING_SOURCE_TYPE,
    sourceId: BLESSING_HALL_BUILDING_TYPE,
    label: '祈福',
    buildEffectText: (buffValue: number) => {
      return `福源 +${formatCharacterGlobalBuffValue(buffValue)}`;
    },
  },
] as const satisfies readonly CharacterGlobalBuffDisplayDefinition[];

const buildCharacterGlobalBuffDisplayKey = (
  buffKey: CharacterGlobalBuffKey,
  sourceType: string,
  sourceId: string,
): string => {
  return `${buffKey}|${sourceType.trim()}|${sourceId.trim()}`;
};

const CHARACTER_GLOBAL_BUFF_DISPLAY_MAP = new Map<string, CharacterGlobalBuffDisplayDefinition>(
  CHARACTER_GLOBAL_BUFF_DISPLAY_DEFINITIONS.map((definition) => [
    buildCharacterGlobalBuffDisplayKey(
      definition.buffKey,
      definition.sourceType,
      definition.sourceId,
    ),
    definition,
  ]),
);

const normalizeCharacterIds = (characterIds: number[]): number[] => {
  return [...new Set(
    characterIds
      .map((characterId) => Math.floor(Number(characterId)))
      .filter((characterId) => Number.isFinite(characterId) && characterId > 0),
  )];
};

const normalizeBuffValue = (raw: unknown): number => {
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1000) / 1000;
};

const normalizeBuffSourceId = (sourceId: string): string => {
  return sourceId.trim();
};

const normalizeIsoDateString = (value: Date | string): string => {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
};

const normalizeBuffValues = (
  values: CharacterGlobalBuffValues | undefined,
): CharacterGlobalBuffValues => {
  const out: CharacterGlobalBuffValues = {};

  for (const buffKey of COMPUTED_CHARACTER_GLOBAL_BUFF_KEYS) {
    const value = normalizeBuffValue(values?.[buffKey] ?? 0);
    if (value === 0) continue;
    out[buffKey] = value;
  }

  return out;
};

export const buildCharacterGlobalBuffSignaturePart = (
  values: CharacterGlobalBuffValues | undefined,
): string => {
  const normalized = normalizeBuffValues(values);
  return COMPUTED_CHARACTER_GLOBAL_BUFF_KEYS.map((buffKey) => {
    const value = normalizeBuffValue(normalized[buffKey] ?? 0);
    return `${buffKey}:${value}`;
  }).join('|');
};

export const applyCharacterGlobalBuffValuesToStats = <
  TStats extends { fuyuan: number },
>(
  stats: TStats,
  values: CharacterGlobalBuffValues | undefined,
): void => {
  const normalized = normalizeBuffValues(values);
  const fuyuanFlat = normalizeBuffValue(
    normalized[GLOBAL_BUFF_KEY_FUYUAN_FLAT] ?? 0,
  );

  if (fuyuanFlat > 0) {
    stats.fuyuan += fuyuanFlat;
  }
};

export const loadActiveCharacterGlobalBuffValuesByCharacterIds = async (
  characterIds: number[],
  now: Date = new Date(),
): Promise<Map<number, CharacterGlobalBuffValues>> => {
  const ids = normalizeCharacterIds(characterIds);
  const result = new Map<number, CharacterGlobalBuffValues>();

  for (const characterId of ids) {
    result.set(characterId, {});
  }
  if (ids.length <= 0) {
    return result;
  }

  const queryResult = await query<{
    character_id: number | string;
    buff_key: string;
    total_value: number | string;
  }>(
    `
      SELECT
        character_id,
        buff_key,
        SUM(buff_value) AS total_value
      FROM character_global_buff
      WHERE character_id = ANY($1::int[])
        AND expire_at > $2::timestamptz
      GROUP BY character_id, buff_key
    `,
    [ids, now.toISOString()],
  );

  for (const row of queryResult.rows) {
    const characterId = Math.floor(Number(row.character_id));
    const buffKey = String(row.buff_key || '') as CharacterGlobalBuffKey;

    if (!result.has(characterId)) continue;
    if (!COMPUTED_CHARACTER_GLOBAL_BUFF_KEYS.includes(buffKey)) continue;

    const current = result.get(characterId) ?? {};
    current[buffKey] = normalizeBuffValue(row.total_value);
    result.set(characterId, current);
  }

  return result;
};

export const areCharacterGlobalBuffSnapshotsEqual = (
  previous: readonly CharacterGlobalBuffSnapshot[] | undefined,
  next: readonly CharacterGlobalBuffSnapshot[] | undefined,
): boolean => {
  const previousList = previous ?? [];
  const nextList = next ?? [];

  if (previousList.length !== nextList.length) {
    return false;
  }

  for (let index = 0; index < previousList.length; index += 1) {
    const previousItem = previousList[index];
    const nextItem = nextList[index];

    if (
      previousItem.id !== nextItem.id
      || previousItem.buffKey !== nextItem.buffKey
      || previousItem.label !== nextItem.label
      || previousItem.iconText !== nextItem.iconText
      || previousItem.effectText !== nextItem.effectText
      || previousItem.startedAt !== nextItem.startedAt
      || previousItem.expireAt !== nextItem.expireAt
      || previousItem.totalDurationMs !== nextItem.totalDurationMs
    ) {
      return false;
    }
  }

  return true;
};

export const loadActiveCharacterGlobalBuffSnapshotsByCharacterIds = async (
  characterIds: number[],
  now: Date = new Date(),
): Promise<Map<number, CharacterGlobalBuffSnapshot[]>> => {
  const ids = normalizeCharacterIds(characterIds);
  const result = new Map<number, CharacterGlobalBuffSnapshot[]>();

  for (const characterId of ids) {
    result.set(characterId, []);
  }
  if (ids.length <= 0) {
    return result;
  }

  const queryResult = await query<CharacterGlobalBuffRow>(
    `
      SELECT *
      FROM character_global_buff
      WHERE character_id = ANY($1::int[])
        AND expire_at > $2::timestamptz
      ORDER BY character_id ASC, expire_at ASC, started_at ASC, id ASC
    `,
    [ids, now.toISOString()],
  );

  for (const row of queryResult.rows) {
    const characterId = Math.floor(Number(row.character_id));
    const buffKey = String(row.buff_key || '') as CharacterGlobalBuffKey;
    if (!result.has(characterId)) continue;
    if (!COMPUTED_CHARACTER_GLOBAL_BUFF_KEYS.includes(buffKey)) continue;

    const definition = CHARACTER_GLOBAL_BUFF_DISPLAY_MAP.get(
      buildCharacterGlobalBuffDisplayKey(
        buffKey,
        String(row.source_type || ''),
        String(row.source_id || ''),
      ),
    );
    if (!definition) continue;

    const startedAt = normalizeIsoDateString(row.started_at);
    const expireAt = normalizeIsoDateString(row.expire_at);
    if (!startedAt || !expireAt) continue;

    const totalDurationMs = Math.max(
      0,
      new Date(expireAt).getTime() - new Date(startedAt).getTime(),
    );
    if (totalDurationMs <= 0) continue;

    const snapshots = result.get(characterId) ?? [];
    snapshots.push({
      id: buildCharacterGlobalBuffDisplayKey(
        buffKey,
        String(row.source_type || ''),
        String(row.source_id || ''),
      ),
      buffKey,
      label: definition.label,
      iconText: definition.label.slice(0, 1),
      effectText: definition.buildEffectText(normalizeBuffValue(row.buff_value)),
      startedAt,
      expireAt,
      totalDurationMs,
    });
    result.set(characterId, snapshots);
  }

  return result;
};

export const getCharacterGlobalBuffRecord = async (
  characterId: number,
  buffKey: CharacterGlobalBuffKey,
  sourceType: string,
  sourceId: string,
): Promise<CharacterGlobalBuffRow | null> => {
  const normalizedCharacterId = Math.floor(Number(characterId));
  if (!Number.isFinite(normalizedCharacterId) || normalizedCharacterId <= 0) {
    return null;
  }

  const result = await query<CharacterGlobalBuffRow>(
    `
      SELECT *
      FROM character_global_buff
      WHERE character_id = $1
        AND buff_key = $2
        AND source_type = $3
        AND source_id = $4
      LIMIT 1
    `,
    [
      normalizedCharacterId,
      buffKey,
      sourceType,
      normalizeBuffSourceId(sourceId),
    ],
  );

  if (result.rows.length <= 0) {
    return null;
  }

  return result.rows[0];
};

export const upsertCharacterGlobalBuff = async (
  payload: CharacterGlobalBuffUpsertPayload,
): Promise<void> => {
  await query(
    `
      INSERT INTO character_global_buff (
        character_id,
        buff_key,
        source_type,
        source_id,
        buff_value,
        grant_day_key,
        started_at,
        expire_at
      )
      VALUES ($1, $2, $3, $4, $5, $6::date, $7::timestamptz, $8::timestamptz)
      ON CONFLICT (character_id, buff_key, source_type, source_id)
      DO UPDATE SET
        buff_value = EXCLUDED.buff_value,
        grant_day_key = EXCLUDED.grant_day_key,
        started_at = EXCLUDED.started_at,
        expire_at = EXCLUDED.expire_at,
        updated_at = NOW()
    `,
    [
      Math.floor(payload.characterId),
      payload.buffKey,
      payload.sourceType.trim(),
      normalizeBuffSourceId(payload.sourceId),
      payload.buffValue,
      payload.grantDayKey ?? null,
      payload.startedAt.toISOString(),
      payload.expireAt.toISOString(),
    ],
  );
};
