/**
 * IdleRowMappers — 挂机模块数据库行映射单一入口
 *
 * 作用：
 *   集中处理 idle_sessions 的数据库行到领域类型映射，
 *   避免多个模块重复手写 snake_case → camelCase 转换。
 *   不负责查询数据库，也不负责业务判断。
 *
 * 输入/输出：
 *   - rowToIdleSessionRow(row) => IdleSessionRow
 *   - 当前只保留会话级映射，不再承接批次表结果
 *
 * 数据流：
 *   DB query rows（snake_case）→ rowMappers 统一转换 → 业务模块（Service/Executor）消费
 *
 * 关键边界条件与坑点：
 *   1. 数据库字段名必须使用表结构的 snake_case（例如 character_id），不能直接读取 characterId。
 *   2. JSON 字段（session_snapshot/reward_items）默认由 pg 解析；
 *      本模块不做兼容解析，调用方需保证查询驱动配置一致。
 */

import type { IdleSessionRow, RewardItemEntry, SessionSnapshot } from './types.js';

/** 将 idle_sessions 查询行映射为 IdleSessionRow。 */
export function rowToIdleSessionRow(row: Record<string, unknown>): IdleSessionRow {
  return {
    id: String(row.id),
    characterId: Number(row.character_id),
    status: row.status as IdleSessionRow['status'],
    mapId: String(row.map_id),
    roomId: String(row.room_id),
    maxDurationMs: Number(row.max_duration_ms),
    sessionSnapshot: row.session_snapshot as SessionSnapshot,
    totalBattles: Number(row.total_battles),
    winCount: Number(row.win_count),
    loseCount: Number(row.lose_count),
    totalExp: Number(row.total_exp),
    totalSilver: Number(row.total_silver),
    rewardItems: (row.reward_items as RewardItemEntry[]) ?? [],
    bagFullFlag: Boolean(row.bag_full_flag),
    startedAt: new Date(row.started_at as string),
    endedAt: row.ended_at ? new Date(row.ended_at as string) : null,
    viewedAt: row.viewed_at ? new Date(row.viewed_at as string) : null,
  };
}
