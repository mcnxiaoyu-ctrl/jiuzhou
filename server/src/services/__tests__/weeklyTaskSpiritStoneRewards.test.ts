/**
 * 周常任务灵石奖励梯度测试
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：锁定所有已配置灵石奖励的周常任务数值，确保整条周常奖励梯度只在 `task_def.json` 这一处集中维护。
 * - 做什么：验证历劫准备周常灵石达到 78000，并保持更低境界按既定梯度递增，避免同类数值规则在别处散落复制。
 * - 不做什么：不验证周常任务的物品奖励、不执行任务结算流程，也不推导任何运行时公式。
 *
 * 输入/输出：
 * - 输入：`task_def.json` 中所有标题以“周常：”开头的任务种子。
 * - 输出：周常任务 ID -> 灵石数量映射，以及按境界顺序递增的阶段最大值断言。
 *
 * 数据流/状态流：
 * - 先读取任务种子并筛出周常任务；
 * - 再只提取 `spirit_stones` 奖励，收敛成单一映射表；
 * - 最后校验具体数值和阶段最大值，给后续奖励调优提供唯一回归锚点。
 *
 * 关键边界条件与坑点：
 * 1) `task-lianji-weekly-003` 当前刻意只有物品奖励，没有灵石；测试必须允许它缺席，避免把“无灵石”误判成漏配。
 * 2) 周常档位跨多个境界，若只校验最高档，容易出现中间档位被误改而不自知；因此同时锁定逐任务数值与逐阶段上限。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  asArray,
  asObject,
  asText,
  loadSeed,
} from './seedTestUtils.js';

const EXPECTED_WEEKLY_SPIRIT_STONES = new Map<string, number>([
  ['task-event-001', 3000],
  ['task-event-002', 3500],
  ['task-event-003', 6000],
  ['task-lianji-weekly-001', 18000],
  ['task-lianji-weekly-002', 20000],
  ['task-lianji-weekly-004', 22000],
  ['task-caiyao-weekly-002', 28000],
  ['task-caiyao-weekly-003', 30000],
  ['task-caiyao-weekly-004', 32000],
  ['task-jietai-weekly-001', 38000],
  ['task-jietai-weekly-002', 42000],
  ['task-huanxu-weekly-001', 46000],
  ['task-huanxu-weekly-002', 52000],
  ['task-hedao-weekly-001', 58000],
  ['task-zhengdao-weekly-001', 68000],
  ['task-lijie-weekly-001', 78000],
]);

const EXPECTED_REALM_STAGE_MAX = new Map<string, number>([
  ['炼精化炁·通脉期', 3000],
  ['炼精化炁·养气期', 3500],
  ['炼精化炁·凝炁期', 6000],
  ['炼炁化神·炼己期', 22000],
  ['炼炁化神·采药期', 32000],
  ['炼炁化神·结胎期', 42000],
  ['炼神返虚·养神期', 52000],
  ['炼神返虚·合道期', 68000],
  ['炼虚合道·证道期', 78000],
]);

const collectWeeklySpiritStoneRewards = (): Map<string, { realm: string; amount: number }> => {
  const taskSeed = loadSeed('task_def.json');
  const taskEntries = asArray(taskSeed.tasks);
  const rewardMap = new Map<string, { realm: string; amount: number }>();

  for (const entry of taskEntries) {
    const task = asObject(entry);
    const taskId = asText(task?.id);
    const title = asText(task?.title);
    if (!taskId || !title.startsWith('周常：')) continue;

    let spiritStoneAmount = 0;
    for (const rewardEntry of asArray(task?.rewards)) {
      const reward = asObject(rewardEntry);
      if (asText(reward?.type) !== 'spirit_stones') continue;
      spiritStoneAmount = Number(reward?.amount ?? 0);
      break;
    }

    if (spiritStoneAmount <= 0) continue;
    rewardMap.set(taskId, { realm: asText(task?.realm), amount: spiritStoneAmount });
  }

  return rewardMap;
};

test('周常任务灵石奖励应符合新的整体梯度表', () => {
  const rewardMap = collectWeeklySpiritStoneRewards();

  assert.deepEqual(
    new Map(Array.from(rewardMap.entries()).map(([taskId, reward]) => [taskId, reward.amount])),
    EXPECTED_WEEKLY_SPIRIT_STONES,
  );
});

test('周常任务各境界阶段最大灵石奖励应逐档递增并以历劫准备 78000 封顶', () => {
  const rewardMap = collectWeeklySpiritStoneRewards();
  const stageMaxMap = new Map<string, number>();

  for (const reward of rewardMap.values()) {
    const prevAmount = stageMaxMap.get(reward.realm) ?? 0;
    stageMaxMap.set(reward.realm, Math.max(prevAmount, reward.amount));
  }

  assert.deepEqual(stageMaxMap, EXPECTED_REALM_STAGE_MAX);

  const stageAmounts = Array.from(stageMaxMap.values());
  for (let index = 1; index < stageAmounts.length; index += 1) {
    assert.ok(
      stageAmounts[index]! > stageAmounts[index - 1]!,
      `阶段最大灵石奖励未递增: ${stageAmounts[index - 1]} !< ${stageAmounts[index]}`,
    );
  }
});
