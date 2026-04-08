/**
 * 离线挂机战斗系统 — 服务端共享类型定义
 *
 * 作用：
 *   定义离线挂机系统（Offline Idle Battle）所有服务端模块共用的 TypeScript 类型。
 *   不包含任何运行时逻辑，仅作类型约束。
 *
 * 输入/输出：
 *   - 被 idleSessionService、idleBattleExecutor、autoSkillPolicyCodec、idleRoutes 等模块导入
 *   - 复用 ../../battle/types 中的 BattleAttrs、BattleSkill、BattleLogEntry、BattleSetBonusEffect，不重复定义
 *
 * 数据流：
 *   客户端 → IdleConfigDto → idleRoutes → idleSessionService → IdleSessionRow（持久化）
 *   IdleSessionRow.sessionSnapshot → IdleBattleExecutor → BattleEngine（战斗结算）
 *   IdleSessionRow / RewardItemEntry → 会话级挂机汇总展示
 *
 * 关键边界条件：
 *   1. maxDurationMs 最小值固定为 60_000，最大值由当前月卡权益决定（基础 8 小时，月卡生效时提升到 12 小时），超出范围应在路由层拒绝
 *   2. AutoSkillPolicy.slots 最多 6 个，超出时 validateAutoSkillPolicy 应返回字段路径错误
 *   3. IdleSessionRow.status 为联合字面量类型，禁止使用 string 替代，防止非法状态写入
 *   4. ParseResult<T> 使用判别联合（discriminated union），调用方必须先检查 success 字段再访问 value/errors
 */

import type {
  CharacterData,
  SkillData,
} from '../../battle/battleFactory.js';
import type { PartnerSkillPolicySlotDto } from '../shared/partnerSkillPolicy.js';

// 复用现有战斗类型，不重复定义
export type {
  BattleAttrs,
  BattleSkill,
  BattleLogEntry,
  BattleSetBonusEffect,
} from '../../battle/types.js';

/**
 * 挂机战斗重放快照。
 * - 仅用于内部校验 / 测试场景，不再参与挂机日志持久化。
 * - initialState：开战前的初始 BattleState 快照，用于按随机种子重放整场战斗。
 * - playerAutoSkillPolicy：挂机玩家的自动放技能策略；若为空则重放时走默认自动战斗逻辑。
 */
export interface IdleBattleReplaySnapshot {
  initialState: import('../../battle/types.js').BattleState;
  playerAutoSkillPolicy: AutoSkillPolicy | null;
}

// ============================================
// 挂机配置
// ============================================

/**
 * 挂机配置（客户端传入）
 * - mapId / roomId：目标地图与房间标识
 * - maxDurationMs：最大挂机时长，最小值 60_000，最大值由当前月卡权益决定
 * - autoSkillPolicy：自动技能释放策略
 */
export interface IdleConfigDto {
  mapId: string;
  roomId: string;
  maxDurationMs: number;
  autoSkillPolicy: AutoSkillPolicy;
  /** 目标怪物定义 ID（选择只打某一种怪） */
  targetMonsterDefId: string;
  /** 是否让当前出战伙伴参与挂机战斗 */
  includePartnerInBattle: boolean;
}

/**
 * 自动技能策略
 * - slots：技能槽位列表，最多 6 个，按 priority 升序执行（1 = 最高优先级）
 */
export interface AutoSkillPolicy {
  slots: AutoSkillSlot[];
}

/**
 * 单个技能槽位
 * - skillId：技能定义 ID
 * - priority：优先级，值越小越优先；相同 priority 时按 slots 数组顺序
 */
export interface AutoSkillSlot {
  skillId: string;
  priority: number;
}

// ============================================
// 会话快照
// ============================================

/**
 * 会话快照（战斗开始时的角色属性，用于确定性结算与事后校验）
 * - 快照在 startIdleSession 时一次性写入，后续战斗均使用此快照，不随角色实时属性变化
 * - baseAttrs / skills / setBonusEffects 直接复用战斗引擎类型，保证与在线战斗一致
 */
export interface SessionSnapshot {
  characterId: number;
  /** 角色昵称（用于战斗日志中显示玩家名，而非 characterId） */
  nickname: string;
  realm: string;
  baseAttrs: import('../../battle/types.js').BattleAttrs;
  skills: import('../../battle/types.js').BattleSkill[];
  setBonusEffects: import('../../battle/types.js').BattleSetBonusEffect[];
  /** 挂机技能策略快照（开始挂机时写入，旧会话可能缺失） */
  autoSkillPolicy?: AutoSkillPolicy;
  /** 目标怪物定义 ID（旧会话可能缺失，缺失时走全怪物逻辑） */
  targetMonsterDefId?: string;
  /** 挂机开始时的伙伴参战开关快照 */
  includePartnerInBattle: boolean;
  /** 挂机开始时冻结的伙伴战斗快照；关闭开关或无出战伙伴时为 null */
  partnerBattleMember: {
    data: CharacterData;
    skills: SkillData[];
    skillPolicy: { slots: PartnerSkillPolicySlotDto[] };
  } | null;
}

// ============================================
// 数据库行映射
// ============================================

/**
 * 挂机会话行（idle_sessions 表的 TypeScript 映射）
 * - status 联合字面量：active → stopping → completed | interrupted
 * - rewardItems 为累计物品奖励列表，每次战斗胜利后追加合并
 * - bagFullFlag 表示本次挂机期间出现过“背包空间不足，改走邮件补发”的情况
 * - viewedAt 为 null 表示玩家尚未查看本次挂机结果（保留会话已读语义）
 */
export interface IdleSessionRow {
  id: string;
  characterId: number;
  status: 'active' | 'stopping' | 'completed' | 'interrupted';
  mapId: string;
  roomId: string;
  maxDurationMs: number;
  sessionSnapshot: SessionSnapshot;
  totalBattles: number;
  winCount: number;
  loseCount: number;
  totalExp: number;
  totalSilver: number;
  rewardItems: RewardItemEntry[];
  bagFullFlag: boolean;
  startedAt: Date;
  endedAt: Date | null;
  viewedAt: Date | null;
}

/**
 * 奖励物品条目
 * - 用于 IdleSessionRow.rewardItems 与实时挂机收益推送
 * - itemDefId：物品定义 ID；itemName：展示名称（快照，防止物品改名后历史记录显示异常）
 */
export interface RewardItemEntry {
  itemDefId: string;
  itemName: string;
  quantity: number;
}

/**
 * 挂机奖励计划中的单条掉落兑现项。
 * - 作用：把“每场已经计算好的掉落事实”与“后续 30 秒窗口统一真实入包”解耦。
 * - 约束：这里只保存兑现所需的最小字段，不保存任何 DB 运行态信息。
 */
export interface IdleRewardPlanDropEntry {
  itemDefId: string;
  quantity: number;
  bindType: string;
  qualityWeights?: Record<string, number>;
}

/**
 * 单场挂机奖励兑现计划。
 * - previewItems：给实时 Socket/UI 展示的预览收益。
 * - dropPlans：flush 时真实入包/邮件补发所需的兑现计划。
 */
export interface IdleBattleRewardSettlementPlan {
  expGained: number;
  silverGained: number;
  previewItems: RewardItemEntry[];
  dropPlans: IdleRewardPlanDropEntry[];
}

// ============================================
// 解析/校验结果类型
// ============================================

/**
 * 解析结果（判别联合类型，用于 AutoSkillPolicyCodec）
 * - success: true  → value 字段包含解析后的合法值
 * - success: false → errors 字段包含字段路径级别的错误列表
 * 调用方必须先检查 success 字段，TypeScript 会通过类型收窄保证安全访问
 */
export type ParseResult<T> =
  | { success: true; value: T }
  | { success: false; errors: FieldError[] };

/**
 * 字段级错误
 * - path：字段路径，如 "slots[2].skillId"，用于前端精确定位错误位置
 * - message：人类可读的错误描述（中文）
 */
export interface FieldError {
  path: string;
  message: string;
}

/**
 * 校验结果（与 ParseResult<T> 等价，语义上强调"校验"而非"解析"）
 * 两者共用同一结构，便于 validateAutoSkillPolicy 与 parseAutoSkillPolicy 统一返回类型
 */
export type ValidationResult<T> = ParseResult<T>;
