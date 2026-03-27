/**
 * 竞技场投影共享规则
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一竞技场投影的默认积分、次数上限、剩余次数收敛与候选角色集合并逻辑，避免预热链路与按需初始化链路各写一套。
 * 2. 做什么：把“活跃角色即使没有竞技场历史也要拥有竞技场投影”收敛成纯函数规则，供启动预热与运行时补齐共用。
 * 3. 不做什么：不访问数据库、不读写 Redis、不处理战报排序；这里只负责纯数据规范化。
 *
 * 输入/输出：
 * - 输入：角色 ID 集合、已有积分/胜负场/已用次数，以及已整理好的战报数组。
 * - 输出：去重排序后的角色 ID 列表，以及结构稳定的竞技场投影对象。
 *
 * 数据流/状态流：
 * 活跃角色 ID + 竞技场历史角色 ID -> 候选集合函数 -> 竞技场预热 / 懒初始化
 * 原始积分与次数 -> 投影构造函数 -> 状态接口 / 匹配校验 / 战后推送。
 *
 * 复用设计说明：
 * 1. 默认值与剩余次数计算属于高频变化点，如果散落在预热、懒加载、状态接口里，任何一次改规则都会漏改至少一个入口。
 * 2. 把候选集和投影构造收敛到共享纯函数后，启动预热与运行时初始化都只消费同一套结果，避免再次出现“前端显示一套、后端校验另一套”。
 * 3. 当前被 `onlineBattleProjectionService` 的竞技场预热与 `getArenaProjection` 按需初始化复用，后续若补角色创建初始化，也应继续复用这里。
 *
 * 关键边界条件与坑点：
 * 1. 角色 ID、积分、次数可能是 NaN/Infinity/负数；这里必须统一收敛，否则会把脏值写进权威投影。
 * 2. 今日已用次数可能因历史数据异常大于上限；剩余次数只能钳制到 0，不能返回负数。
 */

export const DEFAULT_ARENA_SCORE = 1000;
export const DEFAULT_ARENA_DAILY_LIMIT = 20;

const toPositiveInt = (value: number): number => {
  const normalized = Math.floor(Number(value));
  if (!Number.isFinite(normalized) || normalized <= 0) return 0;
  return normalized;
};

const toNonNegativeInt = (value: number | undefined, fallback: number): number => {
  const normalized = Math.floor(Number(value));
  if (!Number.isFinite(normalized) || normalized < 0) return fallback;
  return normalized;
};

export const collectArenaProjectionCharacterIds = (params: {
  activeCharacterIds: number[];
  ratedCharacterIds: number[];
  todayUsageCharacterIds: number[];
}): number[] => {
  const characterIds = new Set<number>();
  for (const characterId of params.activeCharacterIds) {
    const normalizedCharacterId = toPositiveInt(characterId);
    if (normalizedCharacterId > 0) characterIds.add(normalizedCharacterId);
  }
  for (const characterId of params.ratedCharacterIds) {
    const normalizedCharacterId = toPositiveInt(characterId);
    if (normalizedCharacterId > 0) characterIds.add(normalizedCharacterId);
  }
  for (const characterId of params.todayUsageCharacterIds) {
    const normalizedCharacterId = toPositiveInt(characterId);
    if (normalizedCharacterId > 0) characterIds.add(normalizedCharacterId);
  }
  return [...characterIds].sort((left, right) => left - right);
};

export const buildArenaProjectionRecord = <TRecord>(params: {
  characterId: number;
  score?: number;
  winCount?: number;
  loseCount?: number;
  todayUsed?: number;
  todayLimit?: number;
  records: TRecord[];
}): {
  characterId: number;
  score: number;
  winCount: number;
  loseCount: number;
  todayUsed: number;
  todayLimit: number;
  todayRemaining: number;
  records: TRecord[];
} => {
  const characterId = toPositiveInt(params.characterId);
  const score = toNonNegativeInt(params.score, DEFAULT_ARENA_SCORE);
  const winCount = toNonNegativeInt(params.winCount, 0);
  const loseCount = toNonNegativeInt(params.loseCount, 0);
  const todayUsed = toNonNegativeInt(params.todayUsed, 0);
  const todayLimitRaw = toNonNegativeInt(params.todayLimit, DEFAULT_ARENA_DAILY_LIMIT);
  const todayLimit = todayLimitRaw > 0 ? todayLimitRaw : DEFAULT_ARENA_DAILY_LIMIT;

  return {
    characterId,
    score,
    winCount,
    loseCount,
    todayUsed,
    todayLimit,
    todayRemaining: Math.max(0, todayLimit - todayUsed),
    records: params.records,
  };
};
