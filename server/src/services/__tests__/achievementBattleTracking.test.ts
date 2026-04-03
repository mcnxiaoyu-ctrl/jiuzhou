/**
 * 战斗成就窄路径回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：验证战斗结算成就会把 battle_state 的补齐与加锁合并到单次 SQL，并把成就进度补齐、加锁、读取收敛到窄查询链路。
 * 2. 做什么：验证连胜 10 场与低血胜利在同一战斗里可一次性完成，并正确累计战斗成就点数与推送通知。
 * 3. 不做什么：不连接真实数据库，不覆盖通用成就入口，也不校验成就列表接口返回结构。
 *
 * 输入/输出：
 * - 输入：对 `withTransaction`、`query`、静态成就定义与推送模块的 mock。
 * - 输出：执行后的 SQL 形态、点数增量参数与推送调用结果。
 *
 * 数据流/状态流：
 * - 测试把事务包装器改成直通；
 * - 再模拟 battle_state / character_achievement 的当前行状态；
 * - 最后断言结算链路只走合并后的窄 SQL，并触发一次角色级成就推送。
 *
 * 复用设计说明：
 * - 这里直接覆盖 `recordBattleOutcomeAchievements` 的热点入口，避免在 settlement 测试里重复 mock 同一套成就 SQL 细节。
 * - battle 结算与后续其他成就来源都共享同一批表结构，因此把“窄 SQL 形态 + 点数累计”锁在这里，可以减少未来回归时的重复断言。
 * - 高变更点集中在 battle 成就定义与批量 SQL 结构，本文件只关心这两个点，避免和奖励、掉落等无关模块耦合。
 *
 * 关键边界条件与坑点：
 * 1. `@Transactional` 装饰器会走 `withTransaction`；若不先 mock 成直通，测试会误触真实连接池。
 * 2. battle 成就定义是从静态配置读取的；这里必须显式提供最小定义集合，避免测试被无关成就配置噪音干扰。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as database from '../../config/database.js';
import * as achievementPush from '../achievementPush.js';
import { recordBattleOutcomeAchievements } from '../achievement/battleTracking.js';
import * as staticConfigLoader from '../staticConfigLoader.js';

const normalizeSql = (sql: string): string => {
  return sql.replace(/\s+/g, ' ').trim();
};

test('recordBattleOutcomeAchievements: 应合并战斗成就热点 SQL 往返并正确累计点数', async (t) => {
  const executedSql: string[] = [];
  const executedParams: unknown[][] = [];

  t.mock.method(database, 'withTransaction', async <T>(callback: () => Promise<T>) => {
    return await callback();
  });
  t.mock.method(staticConfigLoader, 'getAchievementDefinitions', () => [
    {
      id: 'ach-combat-win-streak-10',
      name: '势如破竹',
      category: 'combat',
      points: 90,
      track_type: 'flag',
      track_key: 'battle:win:streak:10',
      target_value: 1,
      rewards: [],
      enabled: true,
      version: 1,
    },
    {
      id: 'ach-combat-low-hp-win-3',
      name: '命悬一线',
      category: 'combat',
      points: 110,
      track_type: 'counter',
      track_key: 'battle:win:low_hp',
      target_value: 3,
      rewards: [],
      enabled: true,
      version: 1,
    },
  ]);
  const notifyMock = t.mock.method(achievementPush, 'notifyAchievementUpdate', async () => {});
  t.mock.method(database, 'query', async (sql: string, params?: unknown[]) => {
    const normalizedSql = normalizeSql(sql);
    executedSql.push(normalizedSql);
    executedParams.push(params ? [...params] : []);

    if (
      normalizedSql.includes('INSERT INTO character_achievement_battle_state') &&
      normalizedSql.includes('FOR UPDATE')
    ) {
      return {
        rows: [
          {
            character_id: 1001,
            current_win_streak: 9,
            last_processed_battle_id: 'battle-prev',
          },
        ],
      };
    }

    if (normalizedSql.includes('UPDATE character_achievement_battle_state')) {
      return { rows: [] };
    }

    if (
      normalizedSql.includes('INSERT INTO character_achievement_points') &&
      normalizedSql.includes('INSERT INTO character_achievement (character_id, achievement_id, status, progress, progress_data)') &&
      normalizedSql.includes('FOR UPDATE OF ca')
    ) {
      return {
        rows: [
          {
            id: 1,
            character_id: 1001,
            achievement_id: 'ach-combat-win-streak-10',
            status: 'in_progress',
            progress: 0,
            progress_data: {},
            completed_at: null,
            claimed_at: null,
            updated_at: '2026-04-03T00:00:00.000Z',
          },
          {
            id: 2,
            character_id: 1001,
            achievement_id: 'ach-combat-low-hp-win-3',
            status: 'in_progress',
            progress: 2,
            progress_data: {},
            completed_at: null,
            claimed_at: null,
            updated_at: '2026-04-03T00:00:00.000Z',
          },
        ],
      };
    }

    if (normalizedSql.includes('UPDATE character_achievement ca')) {
      return { rows: [] };
    }

    if (normalizedSql.includes('UPDATE character_achievement_points cap')) {
      return { rows: [] };
    }

    throw new Error(`未覆盖的 SQL: ${normalizedSql}`);
  });

  await recordBattleOutcomeAchievements(
    'battle-now',
    'attacker_win',
    [
      {
        characterId: 1001,
        finalQixue: 10,
        finalMaxQixue: 100,
      },
    ],
  );

  assert.equal(executedSql.length, 5);
  assert.ok(
    executedSql.some((sql) =>
      sql.includes('INSERT INTO character_achievement_battle_state') &&
      sql.includes('FOR UPDATE'),
    ),
  );
  assert.ok(
    executedSql.some((sql) =>
      sql.includes('INSERT INTO character_achievement_points') &&
      sql.includes('INSERT INTO character_achievement (character_id, achievement_id, status, progress, progress_data)') &&
      sql.includes('FOR UPDATE OF ca'),
    ),
  );

  const pointDeltaParam = executedParams.find((params, index) =>
    executedSql[index]?.includes('UPDATE character_achievement_points cap'),
  )?.[0];
  assert.equal(
    pointDeltaParam,
    JSON.stringify([
      {
        character_id: 1001,
        total_points: 200,
        combat_points: 200,
      },
    ]),
  );

  assert.equal(notifyMock.mock.callCount(), 1);
  assert.deepEqual(notifyMock.mock.calls[0]?.arguments, [1001]);
});
