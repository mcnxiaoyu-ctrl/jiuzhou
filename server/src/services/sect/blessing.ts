/**
 * 宗门祈福服务
 *
 * 作用：
 * 1. 把“祈福殿”发放的福源全局 Buff 收敛为单一入口，统一处理每日次数、持续时间、日志记录与属性缓存失效。
 * 2. 为宗门详情页提供当前角色的祈福状态读取，避免前端自己拼接“今日是否已祈福 / Buff 是否仍生效”。
 * 不做：
 * 1. 不处理宗门建筑升级；建筑等级仍由宗门建筑服务负责。
 * 2. 不直接推送角色数据；推送由路由在成功后统一触发。
 *
 * 输入 / 输出：
 * - 输入：角色 ID、当前时间。
 * - 输出：祈福状态快照，以及祈福执行结果。
 *
 * 数据流 / 状态流：
 * - 角色进入宗门 -> 读取祈福殿等级；
 * - 角色执行祈福 -> 写入 `character_global_buff` -> 失效角色属性缓存；
 * - 宗门 `/sect/me` 读取时附带个人祈福状态，供建筑面板直接展示。
 *
 * 复用设计说明：
 * - 把祈福规则集中到这里，后续若还有其他“宗门建筑发放全局 Buff”的玩法，可以沿用同一套状态读取与写入协议。
 * - 被 `sect/core.ts` 与 `sectRoutes.ts` 复用。
 * - “每日 1 次 / 持续 3 小时 / 福源按建筑等级结算”属于高频业务变化点，集中后不会散落到路由和前端。
 *
 * 关键边界条件与坑点：
 * 1. 每日次数必须按 `Asia/Shanghai` 自然日判断，不能依赖服务器本地时区。
 * 2. 祈福写入后必须立刻失效角色静态属性缓存，否则客户端会继续看到旧福源值。
 */
import { query } from '../../config/database.js';
import { Transactional } from '../../decorators/transactional.js';
import { invalidateCharacterComputedCache } from '../characterComputedService.js';
import {
  GLOBAL_BUFF_KEY_FUYUAN_FLAT,
  getCharacterGlobalBuffRecord,
  upsertCharacterGlobalBuff,
} from '../shared/characterGlobalBuff.js';
import {
  BLESSING_HALL_BUILDING_TYPE,
  clampSectBuildingLevel,
} from './buildingConfig.js';
import { assertMember, toNumber } from './db.js';
import { ensureSectDefaultBuildings } from './defaultBuildings.js';
import type { Result } from './types.js';

const SHANGHAI_TIME_ZONE = 'Asia/Shanghai';
const SECT_BLESSING_SOURCE_TYPE = 'sect_blessing';
const SECT_BLESSING_SOURCE_ID = BLESSING_HALL_BUILDING_TYPE;
const SECT_BLESSING_DURATION_HOURS = 3;
const SECT_BLESSING_DURATION_MS = SECT_BLESSING_DURATION_HOURS * 60 * 60 * 1000;

const dateKeyFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: SHANGHAI_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const buildShanghaiDateKey = (now: Date): string => {
  const parts = dateKeyFormatter.formatToParts(now);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;

  if (!year || !month || !day) {
    throw new Error('无法生成祈福日期键');
  }

  return `${year}-${month}-${day}`;
};

const normalizeDateKey = (value: Date | string | null | undefined): string => {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'string') {
    return value.slice(0, 10);
  }
  return '';
};

const normalizeExpireAt = (
  value: Date | string | null | undefined,
): Date | null => {
  if (!value) return null;
  const expireAt = value instanceof Date ? value : new Date(value);
  return Number.isFinite(expireAt.getTime()) ? expireAt : null;
};

const normalizeBuffValue = (value: number | string | null | undefined): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.round(parsed * 10) / 10;
};

const formatBlessingFuyuanBonus = (bonus: number): string => {
  return Number.isInteger(bonus) ? String(bonus) : bonus.toFixed(1);
};

export interface SectBlessingStatus {
  today: string;
  blessedToday: boolean;
  canBless: boolean;
  active: boolean;
  expireAt: string | null;
  fuyuanBonus: number;
  durationHours: number;
}

export interface SectBlessingResult extends Result {
  data?: SectBlessingStatus;
}

export const getSectBlessingFuyuanBonusByLevel = (level: number): number => {
  const safeLevel = clampSectBuildingLevel(level);
  return safeLevel * 0.5;
};

export const getSectBlessingStatus = async (
  characterId: number,
  now: Date = new Date(),
): Promise<SectBlessingStatus> => {
  const today = buildShanghaiDateKey(now);
  const record = await getCharacterGlobalBuffRecord(
    characterId,
    GLOBAL_BUFF_KEY_FUYUAN_FLAT,
    SECT_BLESSING_SOURCE_TYPE,
    SECT_BLESSING_SOURCE_ID,
  );

  const expireAt = normalizeExpireAt(record?.expire_at);
  const active = Boolean(expireAt && expireAt.getTime() > now.getTime());
  const blessedToday = normalizeDateKey(record?.grant_day_key) === today;

  return {
    today,
    blessedToday,
    canBless: !blessedToday,
    active,
    expireAt: active && expireAt ? expireAt.toISOString() : null,
    fuyuanBonus: active ? normalizeBuffValue(record?.buff_value) : 0,
    durationHours: SECT_BLESSING_DURATION_HOURS,
  };
};

class SectBlessingService {
  private async addLog(
    sectId: string,
    operatorId: number,
    content: string,
  ): Promise<void> {
    await query(
      `
        INSERT INTO sect_log (sect_id, log_type, operator_id, target_id, content)
        VALUES ($1, $2, $3, $4, $5)
      `,
      [sectId, 'sect_blessing', operatorId, null, content],
    );
  }

  @Transactional
  async offerBlessing(
    characterId: number,
    now: Date = new Date(),
  ): Promise<SectBlessingResult> {
    const member = await assertMember(characterId);
    await ensureSectDefaultBuildings(member.sectId);

    const buildingResult = await query<{ level: number | string }>(
      `
        SELECT level
        FROM sect_building
        WHERE sect_id = $1
          AND building_type = $2
        LIMIT 1
        FOR UPDATE
      `,
      [member.sectId, BLESSING_HALL_BUILDING_TYPE],
    );

    if (buildingResult.rows.length <= 0) {
      return { success: false, message: '祈福殿尚未建成' };
    }

    const today = buildShanghaiDateKey(now);
    const existingResult = await query<{
      grant_day_key: Date | string | null;
    }>(
      `
        SELECT grant_day_key
        FROM character_global_buff
        WHERE character_id = $1
          AND buff_key = $2
          AND source_type = $3
          AND source_id = $4
        LIMIT 1
        FOR UPDATE
      `,
      [
        characterId,
        GLOBAL_BUFF_KEY_FUYUAN_FLAT,
        SECT_BLESSING_SOURCE_TYPE,
        SECT_BLESSING_SOURCE_ID,
      ],
    );

    if (
      existingResult.rows.length > 0
      && normalizeDateKey(existingResult.rows[0]?.grant_day_key) === today
    ) {
      return { success: false, message: '今日已祈福，请明日再来' };
    }

    const buildingLevel = toNumber(buildingResult.rows[0]?.level);
    const fuyuanBonus = getSectBlessingFuyuanBonusByLevel(buildingLevel);
    const expireAt = new Date(now.getTime() + SECT_BLESSING_DURATION_MS);

    await upsertCharacterGlobalBuff({
      characterId,
      buffKey: GLOBAL_BUFF_KEY_FUYUAN_FLAT,
      sourceType: SECT_BLESSING_SOURCE_TYPE,
      sourceId: SECT_BLESSING_SOURCE_ID,
      buffValue: fuyuanBonus,
      grantDayKey: today,
      startedAt: now,
      expireAt,
    });

    await this.addLog(
      member.sectId,
      characterId,
      `祈福：福源+${formatBlessingFuyuanBonus(fuyuanBonus)}，持续${SECT_BLESSING_DURATION_HOURS}小时`,
    );
    await invalidateCharacterComputedCache(characterId);

    return {
      success: true,
      message: '祈福成功',
      data: {
        today,
        blessedToday: true,
        canBless: false,
        active: true,
        expireAt: expireAt.toISOString(),
        fuyuanBonus,
        durationHours: SECT_BLESSING_DURATION_HOURS,
      },
    };
  }
}

export const sectBlessingService = new SectBlessingService();

export const offerSectBlessing = (
  characterId: number,
  now?: Date,
): Promise<SectBlessingResult> => {
  return sectBlessingService.offerBlessing(characterId, now);
};
