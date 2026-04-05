/**
 * recurring 任务事件命中回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定“同一次特定秘境通关应同时命中多条任务”的筛选规则，防止只推进其中一条 recurring 任务。
 * 2. 做什么：覆盖困难秘境也会命中“同副本任意难度要求”的边界，避免后续把难度过滤写窄。
 * 3. 不做什么：不连数据库，不验证 `character_task_progress` 持久化，也不跑完整任务服务流程。
 *
 * 输入/输出：
 * - 输入：任务静态定义、角色境界、以及构造出的 `dungeon_clear` 事件。
 * - 输出：命中的 recurring 任务 ID 集合与单目标命中结果。
 *
 * 数据流/状态流：
 * 静态任务定义 -> 归一化为 matcher 输入
 * -> `collectMatchedRecurringTaskIds` / `objectiveMatchesTaskEvent`
 * -> 断言同一次事件能覆盖所有预期任务。
 *
 * 关键边界条件与坑点：
 * 1. 周常/日常副本目标现在统一不限制难度，因此普通与困难通关都必须命中同一批任务。
 * 2. 这里断言的是“必须包含哪些任务”，不把跨境界通用的“任意秘境”任务硬编码进精确集合，避免和现有高境界兼容策略互相绑死。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { getTaskDefinitions, type TaskDefConfig } from '../staticConfigLoader.js';
import {
  collectMatchedRecurringTaskIds,
  objectiveMatchesTaskEvent,
  type CharacterTaskRealmState,
  type RecurringTaskDefinitionLike,
  type TaskObjectiveLike,
} from '../shared/taskRecurringEventMatcher.js';

const toTaskObjectives = (objectives: TaskDefConfig['objectives']): TaskObjectiveLike[] => {
  return (objectives ?? []).map((objective) => ({
    id: objective.id,
    type: objective.type,
    text: objective.text,
    target: objective.target,
    params: {
      npc_id: typeof objective.params?.npc_id === 'string' ? objective.params.npc_id : undefined,
      monster_id: typeof objective.params?.monster_id === 'string' ? objective.params.monster_id : undefined,
      resource_id: typeof objective.params?.resource_id === 'string' ? objective.params.resource_id : undefined,
      dungeon_id: typeof objective.params?.dungeon_id === 'string' ? objective.params.dungeon_id : undefined,
      difficulty_id: typeof objective.params?.difficulty_id === 'string' ? objective.params.difficulty_id : undefined,
      recipe_id: typeof objective.params?.recipe_id === 'string' ? objective.params.recipe_id : undefined,
      recipe_type: typeof objective.params?.recipe_type === 'string' ? objective.params.recipe_type : undefined,
      craft_kind: typeof objective.params?.craft_kind === 'string' ? objective.params.craft_kind : undefined,
      item_id: typeof objective.params?.item_id === 'string' ? objective.params.item_id : undefined,
    },
  }));
};

const buildRecurringMatcherInputs = (): RecurringTaskDefinitionLike[] => {
  return getTaskDefinitions().map((task) => ({
    id: task.id,
    category: task.category,
    realm: task.realm,
    enabled: task.enabled,
    objectives: toTaskObjectives(task.objectives),
  }));
};

const assertTaskIdsIncluded = (actualTaskIds: string[], expectedTaskIds: string[]): void => {
  const actualTaskIdSet = new Set(actualTaskIds);
  for (const expectedTaskId of expectedTaskIds) {
    assert.equal(actualTaskIdSet.has(expectedTaskId), true, `缺少命中任务: ${expectedTaskId}`);
  }
};

test('collectMatchedRecurringTaskIds: 采药期通关九台宫阙时，应同时命中同副本日常与周常', () => {
  const characterRealmState: CharacterTaskRealmState = {
    realm: '炼炁化神',
    subRealm: '采药期',
  };

  const matchedTaskIds = collectMatchedRecurringTaskIds(
    buildRecurringMatcherInputs(),
    characterRealmState,
    {
      type: 'dungeon_clear',
      dungeonId: 'dungeon-lianqi-jiutai-gongque',
      count: 1,
    },
  );

  assertTaskIdsIncluded(matchedTaskIds, [
    'task-caiyao-daily-004',
    'task-caiyao-daily-005',
    'task-caiyao-weekly-002',
  ]);
});

test('collectMatchedRecurringTaskIds: 养神期通关困难还虚天台时，应同时命中同副本日常与周常', () => {
  const characterRealmState: CharacterTaskRealmState = {
    realm: '炼神返虚',
    subRealm: '养神期',
  };

  const matchedTaskIds = collectMatchedRecurringTaskIds(
    buildRecurringMatcherInputs(),
    characterRealmState,
    {
      type: 'dungeon_clear',
      dungeonId: 'dungeon-lianshen-huixu-tiantai',
      difficultyId: 'dd-huixu-tiantai-h',
      count: 1,
    },
  );

  assertTaskIdsIncluded(matchedTaskIds, [
    'task-huanxu-daily-003',
    'task-huanxu-daily-005',
    'task-huanxu-weekly-001',
  ]);
});

test('collectMatchedRecurringTaskIds: 合道期收集证道法印时，应命中证道期周常收集目标', () => {
  const characterRealmState: CharacterTaskRealmState = {
    realm: '炼神返虚',
    subRealm: '合道期',
  };

  const matchedTaskIds = collectMatchedRecurringTaskIds(
    buildRecurringMatcherInputs(),
    characterRealmState,
    {
      type: 'collect',
      itemId: 'mat-zhendao-fayin',
      count: 1,
    },
  );

  assertTaskIdsIncluded(matchedTaskIds, [
    'task-zhengdao-weekly-001',
  ]);
});

test('objectiveMatchesTaskEvent: 未限制难度的副本目标应被普通与困难通关同时推进', () => {
  const flexibleDungeonObjective: TaskObjectiveLike = {
    id: 'obj-flexible',
    type: 'dungeon_clear',
    text: '通关还虚天台 1次',
    target: 1,
    params: {
      dungeon_id: 'dungeon-lianshen-huixu-tiantai',
    },
  };

  const normalResult = objectiveMatchesTaskEvent(flexibleDungeonObjective, {
    type: 'dungeon_clear',
    dungeonId: 'dungeon-lianshen-huixu-tiantai',
    count: 1,
  });
  const hardResult = objectiveMatchesTaskEvent(flexibleDungeonObjective, {
    type: 'dungeon_clear',
    dungeonId: 'dungeon-lianshen-huixu-tiantai',
    difficultyId: 'dd-huixu-tiantai-h',
    count: 1,
  });

  assert.deepEqual(normalResult, { matched: true, delta: 1 });
  assert.deepEqual(hardResult, { matched: true, delta: 1 });
});

test('objectiveMatchesTaskEvent: collect 目标应按 item_id 命中并累计数量', () => {
  const collectObjective: TaskObjectiveLike = {
    id: 'obj-collect-fayin',
    type: 'collect',
    text: '收集证道法印 4 份',
    target: 4,
    params: {
      item_id: 'mat-zhendao-fayin',
    },
  };

  const result = objectiveMatchesTaskEvent(collectObjective, {
    type: 'collect',
    itemId: 'mat-zhendao-fayin',
    count: 2,
  });

  assert.deepEqual(result, { matched: true, delta: 2 });
});
