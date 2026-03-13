/**
 * 秘境领域公共类型定义
 *
 * 作用：集中定义 dungeon 模块所有对外/对内共享类型。
 * 所有子模块（configLoader / entryCount / participants / rewards / combat 等）从此处引用。
 *
 * 边界条件：
 * 1) DungeonType 枚举值与静态配置保持一致，新增类型时需同步。
 * 2) DungeonInstanceRow 的 participants / instance_data 为 JSON 字段，运行时需解析。
 */

/** 秘境类型枚举 */
export type DungeonType = 'material' | 'equipment' | 'trial' | 'challenge' | 'event';

/** 秘境分类 DTO */
export type DungeonCategoryDto = {
  type: DungeonType;
  label: string;
  count: number;
};

/** 秘境定义 DTO（对外输出格式） */
export type DungeonDefDto = {
  id: string;
  name: string;
  type: DungeonType;
  category: string | null;
  description: string | null;
  icon: string | null;
  background: string | null;
  min_players: number;
  max_players: number;
  min_realm: string | null;
  recommended_realm: string | null;
  unlock_condition: unknown;
  daily_limit: number;
  weekly_limit: number;
  stamina_cost: number;
  time_limit_sec: number;
  revive_limit: number;
  tags: unknown;
  sort_weight: number;
  enabled: boolean;
  version: number;
};

/** 秘境难度行 */
export type DungeonDifficultyRow = {
  id: string;
  dungeon_id: string;
  name: string;
  difficulty_rank: number;
  monster_level_add: number;
  monster_attr_mult: string | number;
  reward_mult: string | number;
  min_realm: string | null;
  unlock_prev_difficulty: boolean;
  first_clear_rewards: unknown;
  drop_pool_id: string | null;
  enabled: boolean;
};

/** 秘境关卡行 */
export type DungeonStageRow = {
  id: string;
  difficulty_id: string;
  stage_index: number;
  name: string | null;
  type: string;
  description: string | null;
  time_limit_sec: number;
  clear_condition: unknown;
  fail_condition: unknown;
  events: unknown;
};

/** 秘境波次行 */
export type DungeonWaveRow = {
  id: string;
  stage_id: string;
  wave_index: number;
  spawn_delay_sec: number;
  monsters: unknown;
  wave_rewards: unknown;
};

/** 怪物简略行 */
export type MonsterLiteRow = {
  id: string;
  name: string;
  realm: string | null;
  level: number;
  avatar: string | null;
  kind: string | null;
  drop_pool_id?: string | null;
};

/** 物品简略行 */
export type ItemLiteRow = {
  id: string;
  name: string;
  quality: string | null;
  icon: string | null;
};

/** 秘境实例状态 */
export type DungeonInstanceStatus = 'preparing' | 'running' | 'cleared' | 'failed' | 'abandoned';

/** 秘境实例参与者 */
export type DungeonInstanceParticipant = {
  userId: number;
  characterId: number;
  role: 'leader' | 'member';
};

/** 秘境实例数据库行 */
export type DungeonInstanceRow = {
  id: string;
  dungeon_id: string;
  difficulty_id: string;
  creator_id: number;
  team_id: string | null;
  status: DungeonInstanceStatus;
  current_stage: number;
  current_wave: number;
  participants: unknown;
  start_time: string | null;
  end_time: string | null;
  time_spent_sec: number;
  total_damage: number;
  death_count: number;
  rewards_claimed: boolean;
  instance_data: unknown;
  created_at: string;
};

/** 秘境奖励物品 */
export type DungeonRewardItem = {
  itemDefId: string;
  qty: number;
  bindType?: string;
};

/** 秘境奖励包 */
export type DungeonRewardBundle = {
  exp: number;
  silver: number;
  items: DungeonRewardItem[];
};
