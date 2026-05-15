/**
 * AI 生成功法配置刷新去重回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定短时间并发调用刷新时只执行一次真实数据库加载。
 * 2. 做什么：避免生成功法发布或预览链路把高成本宽表查询重复压到 Postgres。
 * 3. 不做什么：不验证 SQL 执行计划，不连接真实数据库。
 *
 * 输入 / 输出：
 * - 输入：mock 的 query 方法和并发 reload 调用。
 * - 输出：query 调用次数保持为 3，因为真实加载包含 def/skill/layer 三条查询。
 *
 * 数据流 / 状态流：
 * 多个 reloadGeneratedTechniqueConfigStore 调用 -> 共享 inflight promise -> 单次数据库加载 -> 所有调用完成。
 *
 * 复用设计说明：
 * - 把去重放在 config store 内部，所有刷新调用点自动复用，不需要每个业务服务各自节流。
 * - 测试直接覆盖导出的刷新入口，后续新增刷新来源无需再复制并发保护断言。
 *
 * 关键边界条件与坑点：
 * 1. 失败时必须清空 inflight promise，否则后续永远无法刷新。
 * 2. 串行两次刷新仍应执行两轮加载，不能把新发布内容长期缓存住。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as database from '../../config/database.js';
import { reloadGeneratedTechniqueConfigStore } from '../generatedTechniqueConfigStore.js';

test('reloadGeneratedTechniqueConfigStore 并发调用应复用同一个刷新任务', async (t) => {
  let queryCount = 0;
  t.mock.method(database, 'query', async () => {
    queryCount += 1;
    return { rows: [] };
  });

  await Promise.all([
    reloadGeneratedTechniqueConfigStore(),
    reloadGeneratedTechniqueConfigStore(),
    reloadGeneratedTechniqueConfigStore(),
  ]);

  assert.equal(queryCount, 3);
});

test('reloadGeneratedTechniqueConfigStore 失败后应清空刷新任务并允许重试', async (t) => {
  let queryCount = 0;
  let shouldFailFirstLoad = true;
  const reloadFailedError = new Error('reload failed');

  t.mock.method(database, 'query', async () => {
    queryCount += 1;
    if (shouldFailFirstLoad && queryCount === 1) {
      throw reloadFailedError;
    }
    return { rows: [] };
  });

  const failedReloadCalls = [
    reloadGeneratedTechniqueConfigStore(),
    reloadGeneratedTechniqueConfigStore(),
    reloadGeneratedTechniqueConfigStore(),
  ];

  await Promise.all(
    failedReloadCalls.map((reloadCall) => assert.rejects(reloadCall, { message: 'reload failed' })),
  );
  assert.equal(queryCount, 3);

  shouldFailFirstLoad = false;
  const queryCountAfterFailedLoad = queryCount;

  await reloadGeneratedTechniqueConfigStore();

  assert.equal(queryCount - queryCountAfterFailedLoad, 3);
});
