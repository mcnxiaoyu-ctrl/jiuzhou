/**
 * recurring 任务事件命中与补齐候选计算
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中维护“任务目标是否命中一次事件”的判定，以及“这次事件需要补齐哪些日常/周常进度行”的计算，避免任务服务在多个入口散落同类判断。
 * 2. 做什么：把 recurring 任务的命中筛选做成纯函数，既给 `taskService` 复用，也给回归测试直接锁定“同一次秘境通关应命中哪些任务”。
 * 3. 不做什么：不读写数据库，不决定主线/支线接取状态，也不直接修改任务进度。
 *
 * 输入/输出：
 * - 输入：任务事件 `TaskEvent`、任务目标 `TaskObjectiveLike`、以及 recurring 任务定义列表与角色境界状态。
 * - 输出：单目标命中结果 `{ matched, delta }`，或本次事件需要补齐的 recurring 任务 ID 列表。
 *
 * 数据流/状态流：
 * 任务事件 -> `objectiveMatchesTaskEvent`
 * -> `collectMatchedRecurringTaskIds`
 * -> `taskService` 先补齐缺失的 recurring 进度行，再统一读写 `character_task_progress`。
 *
 * 关键边界条件与坑点：
 * 1. `dungeon_clear` 同时要支持“任意秘境”“指定秘境”“指定秘境 + 指定难度”三种口径；这里统一判定，避免不同入口一边按副本判、一边按难度判。
 * 2. recurring 任务是否参与匹配必须复用同一套境界解锁规则；否则会出现列表可见性、自动接取与事件推进三套口径不一致。
 */
import { buildTaskRecurringUnlockState } from './taskRecurringUnlock.js';

export type CharacterTaskRealmState = {
  realm: string;
  subRealm: string | null;
};

export type TaskEvent =
  | { type: 'talk_npc'; npcId: string }
  | { type: 'kill_monster'; monsterId: string; count: number }
  | { type: 'gather_resource'; resourceId: string; count: number }
  | { type: 'collect'; itemId: string; count: number }
  | { type: 'dungeon_clear'; dungeonId: string; difficultyId?: string; count: number }
  | { type: 'craft_item'; recipeId?: string; recipeType?: string; craftKind?: string; itemId?: string; count: number };

export type TaskObjectiveParams = {
  npc_id?: string;
  monster_id?: string;
  resource_id?: string;
  dungeon_id?: string;
  difficulty_id?: string;
  recipe_id?: string;
  recipe_type?: string;
  craft_kind?: string;
  item_id?: string;
};

export type TaskObjectiveLike = {
  id?: string;
  type?: string;
  text?: string;
  target?: number;
  params?: TaskObjectiveParams | null;
};

export type RecurringTaskDefinitionLike = {
  id: string;
  category: string;
  realm: string;
  enabled?: boolean;
  objectives: readonly TaskObjectiveLike[];
};

const normalizeText = (value: string | null | undefined): string => {
  return value?.trim() ?? '';
};

const normalizePositiveCount = (value: number): number => {
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : 1;
};

export const objectiveMatchesTaskEvent = (
  objective: TaskObjectiveLike,
  event: TaskEvent,
): { matched: boolean; delta: number } => {
  const type = normalizeText(objective.type);
  const params = objective.params ?? {};

  if (event.type === 'talk_npc') {
    if (type !== 'talk_npc') return { matched: false, delta: 0 };
    const npcId = normalizeText(params.npc_id);
    if (!npcId || npcId !== event.npcId) return { matched: false, delta: 0 };
    return { matched: true, delta: 1 };
  }

  if (event.type === 'kill_monster') {
    if (type !== 'kill_monster') return { matched: false, delta: 0 };
    const monsterId = normalizeText(params.monster_id);
    if (!monsterId || monsterId !== event.monsterId) return { matched: false, delta: 0 };
    return { matched: true, delta: normalizePositiveCount(event.count) };
  }

  if (event.type === 'gather_resource') {
    if (type !== 'gather_resource') return { matched: false, delta: 0 };
    const resourceId = normalizeText(params.resource_id);
    if (!resourceId || resourceId !== event.resourceId) return { matched: false, delta: 0 };
    return { matched: true, delta: normalizePositiveCount(event.count) };
  }

  if (event.type === 'collect') {
    if (type !== 'collect') return { matched: false, delta: 0 };
    const itemId = normalizeText(params.item_id);
    if (!itemId || itemId !== event.itemId) return { matched: false, delta: 0 };
    return { matched: true, delta: normalizePositiveCount(event.count) };
  }

  if (event.type === 'dungeon_clear') {
    if (type !== 'dungeon_clear') return { matched: false, delta: 0 };
    const dungeonId = normalizeText(params.dungeon_id);
    if (dungeonId && dungeonId !== event.dungeonId) return { matched: false, delta: 0 };

    const difficultyId = normalizeText(params.difficulty_id);
    if (difficultyId && (!event.difficultyId || difficultyId !== event.difficultyId)) {
      return { matched: false, delta: 0 };
    }

    return { matched: true, delta: normalizePositiveCount(event.count) };
  }

  if (event.type === 'craft_item') {
    if (type !== 'craft_item') return { matched: false, delta: 0 };
    const recipeId = normalizeText(params.recipe_id);
    if (recipeId && recipeId !== normalizeText(event.recipeId)) return { matched: false, delta: 0 };
    const recipeType = normalizeText(params.recipe_type);
    if (recipeType && recipeType !== normalizeText(event.recipeType)) return { matched: false, delta: 0 };
    const craftKind = normalizeText(params.craft_kind);
    if (craftKind && craftKind !== normalizeText(event.craftKind)) return { matched: false, delta: 0 };
    const itemId = normalizeText(params.item_id);
    if (itemId && itemId !== normalizeText(event.itemId)) return { matched: false, delta: 0 };
    return { matched: true, delta: normalizePositiveCount(event.count) };
  }

  return { matched: false, delta: 0 };
};

export const collectMatchedRecurringTaskIds = (
  taskDefs: readonly RecurringTaskDefinitionLike[],
  characterRealmState: CharacterTaskRealmState,
  event: TaskEvent,
): string[] => {
  const matchedTaskIds: string[] = [];

  for (const taskDef of taskDefs) {
    if (taskDef.enabled === false) continue;
    if (taskDef.category !== 'daily' && taskDef.category !== 'event') continue;

    const unlockState = buildTaskRecurringUnlockState(
      taskDef.category,
      taskDef.realm,
      characterRealmState.realm,
      characterRealmState.subRealm,
    );
    if (!unlockState.unlocked) continue;

    const taskId = normalizeText(taskDef.id);
    if (!taskId) continue;

    const matched = taskDef.objectives.some((objective) => objectiveMatchesTaskEvent(objective, event).matched);
    if (!matched) continue;
    matchedTaskIds.push(taskId);
  }

  return matchedTaskIds;
};
