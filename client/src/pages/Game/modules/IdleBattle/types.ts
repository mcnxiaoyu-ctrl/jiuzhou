/**
 * 离线挂机战斗模块 — 客户端共享类型定义
 *
 * 作用：
 *   定义客户端视图层所需的 DTO 类型，与服务端 API 响应字段对齐。
 *   不包含任何运行时逻辑，仅作类型约束。
 *   不重复定义已有的 BattleLogEntryDto（复用 combat-realm.ts 中的定义）。
 *
 * 输入/输出：
 *   - 被 idleBattleApi、useIdleBattle Hook、UI 组件导入
 *   - 与服务端 IdleSessionRow、IdleBattleSummaryRow、IdleBattleDetailRow、IdleConfigDto 字段对齐
 *
 * 数据流：
 *   服务端 JSON → idleBattleApi 解析 → 这里的 DTO 类型 → useIdleBattle → UI 组件
 *
 * 关键边界条件：
 *   1. status 为联合字面量，UI 层必须先检查 status 再决定展示逻辑
 *   2. viewedAt 为 null 表示玩家尚未查看本次挂机结果，用于触发回放弹窗
 */

import type { BattleLogEntryDto } from "../../../../services/api/combat-realm";

// ============================================
// 挂机配置（客户端视图）
// ============================================

/**
 * 技能槽位（与服务端 AutoSkillSlot 对齐）
 */
export interface AutoSkillSlotDto {
  skillId: string;
  priority: number;
}

/**
 * 自动技能策略（与服务端 AutoSkillPolicy 对齐）
 */
export interface AutoSkillPolicyDto {
  slots: AutoSkillSlotDto[];
}

/**
 * 挂机配置 DTO（GET /api/idle/config 响应体）
 * - mapId / roomId 可为 null（未配置时）
 */
export interface IdleConfigDto {
  mapId: string | null;
  roomId: string | null;
  maxDurationMs: number;
  autoSkillPolicy: AutoSkillPolicyDto;
  /** 目标怪物定义 ID（null 表示未选择） */
  targetMonsterDefId: string | null;
}

// ============================================
// 挂机会话（客户端视图）
// ============================================

/**
 * 奖励物品条目（与服务端 RewardItemEntry 对齐）
 */
export interface RewardItemEntryDto {
  itemDefId: string;
  itemName: string;
  quantity: number;
}

/**
 * 挂机会话 DTO（GET /api/idle/status、GET /api/idle/history 响应体）
 * - status 联合字面量：active → stopping → completed | interrupted
 * - viewedAt 为 null 表示未查看，UI 层据此触发回放弹窗
 */
export interface IdleSessionDto {
  id: string;
  characterId: number;
  status: "active" | "stopping" | "completed" | "interrupted";
  mapId: string;
  roomId: string;
  maxDurationMs: number;
  totalBattles: number;
  winCount: number;
  loseCount: number;
  totalExp: number;
  totalSilver: number;
  rewardItems: RewardItemEntryDto[];
  bagFullFlag: boolean;
  startedAt: string; // ISO 8601 字符串，UI 层按需转换为 Date
  endedAt: string | null;
  viewedAt: string | null;
  /** 目标怪物定义 ID（由服务端从 sessionSnapshot 提取） */
  targetMonsterDefId: string | null;
  /** 目标怪物中文名（由服务端从 monster_def 解析） */
  targetMonsterName: string | null;
}

// ============================================
// 单场战斗记录（客户端视图）
// ============================================

/**
 * 单场战斗批次摘要 DTO（GET /api/idle/history/:id/batches 响应体）
 * - 仅包含左侧列表渲染所需字段，不携带完整 battleLog
 * - itemCount 由服务端聚合，避免前端为显示“物品×N”读取整段奖励 JSON
 */
export interface IdleBatchSummaryDto {
  id: string;
  sessionId: string;
  batchIndex: number;
  result: "attacker_win" | "defender_win" | "draw";
  roundCount: number;
  expGained: number;
  silverGained: number;
  itemCount: number;
  executedAt: string; // ISO 8601 字符串
}

/**
 * 单场战斗批次详情 DTO（GET /api/idle/history/:id/batches/:batchId 响应体）
 * - 仅在玩家选中某个批次后加载，右侧日志面板使用
 * - battleLog 复用 BattleLogEntryDto，与在线战斗日志格式一致
 */
export interface IdleBatchDetailDto extends IdleBatchSummaryDto {
  randomSeed: number;
  itemsGained: RewardItemEntryDto[];
  battleLog: BattleLogEntryDto[];
  monsterIds: string[];
}

// ============================================
// API 响应数据类型（已在 API 层解包 data）
// ============================================

export interface IdleStartResponse {
  sessionId?: string;
  existingSessionId?: string;
}

export interface IdleStatusResponse {
  session: IdleSessionDto | null;
}

export interface IdleHistoryResponse {
  history: IdleSessionDto[];
}

export interface IdleBatchesResponse {
  batches: IdleBatchSummaryDto[];
}

export interface IdleBatchDetailResponse {
  batch: IdleBatchDetailDto | null;
}

export interface IdleProgressResponse {
  session: IdleSessionDto | null;
  batches: IdleBatchSummaryDto[];
}

export interface IdleConfigResponse {
  config: IdleConfigDto;
}

/** POST /start 请求体 */
export interface IdleStartParams {
  mapId: string;
  roomId: string;
  maxDurationMs: number;
  autoSkillPolicy: AutoSkillPolicyDto;
  targetMonsterDefId: string;
}
