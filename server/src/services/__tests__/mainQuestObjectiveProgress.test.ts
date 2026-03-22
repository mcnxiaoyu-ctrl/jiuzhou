/**
 * mainQuestObjectiveProgress 回归测试
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：锁定“进入 objectives 阶段时，背包里已持有的收集目标物品应立即回填进度”的规则。
 * - 不做什么：不验证真实掉落、战斗或对话流程，也不触达真实数据库。
 *
 * 输入/输出：
 * - 输入：主线进度快照、任务节 objectives，以及数据库查询 mock。
 * - 输出：`syncCurrentSectionStaticProgress` 对 `objectives_progress` 和 `section_status` 的写回参数。
 *
 * 数据流/状态流：
 * - 读取当前任务节与进度快照
 * - 读取当前背包里的任务物品数量
 * - 若背包数量已满足 collect 目标，则直接把该目标回填到 target，并在全部完成时切到 turnin
 *
 * 关键边界条件与坑点：
 * 1) collect 回填只应该前进不应该回退，避免玩家消耗物品后把已完成进度倒扣。
 * 2) 回填发生在 objectives 阶段入口，保证前置节奖励或提前收集的物品不会让任务表现成“明明够了却还卡着”。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as database from '../../config/database.js';
import { syncCurrentSectionStaticProgress } from '../mainQuest/objectiveProgress.js';
import * as questConfig from '../mainQuest/shared/questConfig.js';

test('syncCurrentSectionStaticProgress: 背包已持有的收集物应在进入 objectives 时立即回填', async (t) => {
  const updateCalls: Array<{ sql: string; params?: unknown[] }> = [];

  t.mock.method(database, 'query', async (sql: string, params?: unknown[]) => {
    if (sql.includes('SELECT current_section_id, section_status, objectives_progress')) {
      return {
        rows: [{
          current_section_id: 'main-7-006',
          section_status: 'objectives',
          objectives_progress: {},
        }],
      };
    }

    if (sql.includes('FROM item_instance')) {
      assert.equal(params?.[0], 1001);
      return {
        rows: [{
          item_def_id: 'mat-hedao-qiyin',
          qty: 4,
        }],
      };
    }

    if (sql.includes('SELECT realm, sub_realm FROM characters')) {
      return {
        rows: [{
          realm: '炼神返虚',
          sub_realm: '还虚期',
        }],
      };
    }

    if (sql.includes('SELECT technique_id, current_layer FROM character_technique')) {
      return { rows: [] };
    }

    if (sql.includes('UPDATE character_main_quest_progress')) {
      updateCalls.push({ sql, params });
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`unexpected sql: ${sql}`);
  });

  t.mock.method(questConfig, 'getEnabledMainQuestSectionById', () => ({
    id: 'main-7-006',
    objectives: [
      {
        id: 'obj-1',
        type: 'collect',
        target: 4,
        params: {
          item_id: 'mat-hedao-qiyin',
        },
      },
    ],
  }) as never);

  await syncCurrentSectionStaticProgress(1001);

  assert.equal(updateCalls.length, 1);
  const updateParams = updateCalls[0]?.params;
  if (!updateParams) {
    assert.fail('应写回主线进度');
  }
  assert.equal(updateParams[0], 1001);
  assert.equal(updateParams[2], 'turnin');
  assert.deepEqual(JSON.parse(String(updateParams[1])), { 'obj-1': 4 });
});
