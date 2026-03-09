/**
 * 功法表初始化顺序测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：验证旧版 `technique_generation_job` 升级时，依赖新增列的注释与索引一定排在补列之后。
 * 2. 不做什么：不连接真实数据库，也不执行 SQL，只检查初始化计划的顺序约束。
 *
 * 输入/输出：
 * - 输入：`getTechniqueGenerationCompatibilityQueries` 生成的 SQL 队列。
 * - 输出：通过断言确认 `ADD COLUMN`、`COMMENT ON COLUMN`、`CREATE INDEX` 的先后关系。
 *
 * 数据流/状态流：
 * 兼容升级计划 -> 提取关键 SQL 索引位置 -> 断言顺序正确 -> 锁住旧表升级回归点。
 *
 * 关键边界条件与坑点：
 * 1. 这里只验证 SQL 顺序，不验证 PostgreSQL 执行结果；真实执行仍由启动阶段完成。
 * 2. 若未来新增依赖列的注释或条件索引，必须继续复用同一初始化计划，否则这个回归点会重新出现。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { getTechniqueGenerationCompatibilityQueries } from '../../models/techniqueGenerationTable.js';

const findQueryIndex = (queries: readonly string[], pattern: RegExp): number =>
  queries.findIndex((query) => pattern.test(query));

test('旧表升级时应先补 viewed_at 系列列，再创建注释与未读索引', () => {
  const queries = getTechniqueGenerationCompatibilityQueries();

  const addViewedAtIndex = findQueryIndex(
    queries,
    /ALTER TABLE technique_generation_job ADD COLUMN IF NOT EXISTS viewed_at TIMESTAMPTZ/,
  );
  const addFailedViewedAtIndex = findQueryIndex(
    queries,
    /ALTER TABLE technique_generation_job ADD COLUMN IF NOT EXISTS failed_viewed_at TIMESTAMPTZ/,
  );
  const addFinishedAtIndex = findQueryIndex(
    queries,
    /ALTER TABLE technique_generation_job ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ/,
  );
  const commentViewedAtIndex = findQueryIndex(
    queries,
    /COMMENT ON COLUMN technique_generation_job\.viewed_at IS '生成成功结果首次被玩家查看时间'/,
  );
  const commentFailedViewedAtIndex = findQueryIndex(
    queries,
    /COMMENT ON COLUMN technique_generation_job\.failed_viewed_at IS '生成失败结果首次被玩家查看时间'/,
  );
  const unreadIndexQueryIndex = findQueryIndex(
    queries,
    /CREATE INDEX IF NOT EXISTS idx_technique_generation_job_unread_result/,
  );

  assert.ok(addViewedAtIndex >= 0, '应先生成 viewed_at 补列语句');
  assert.ok(addFailedViewedAtIndex >= 0, '应先生成 failed_viewed_at 补列语句');
  assert.ok(addFinishedAtIndex >= 0, '应先生成 finished_at 补列语句');
  assert.ok(commentViewedAtIndex > addViewedAtIndex, 'viewed_at 列注释必须在补列之后');
  assert.ok(
    commentFailedViewedAtIndex > addFailedViewedAtIndex,
    'failed_viewed_at 列注释必须在补列之后',
  );
  assert.ok(
    unreadIndexQueryIndex > addFinishedAtIndex,
    '依赖 viewed_at/failed_viewed_at 的未读索引必须在补列之后',
  );
});

test('旧表升级时应包含 type_rolled 补列与注释，确保任务类型可恢复', () => {
  const queries = getTechniqueGenerationCompatibilityQueries();

  const addTypeRolledIndex = findQueryIndex(
    queries,
    /ALTER TABLE technique_generation_job ADD COLUMN IF NOT EXISTS type_rolled VARCHAR\(16\)/,
  );
  const commentTypeRolledIndex = findQueryIndex(
    queries,
    /COMMENT ON COLUMN technique_generation_job\.type_rolled IS '程序预先随机出的功法类型'/,
  );

  assert.ok(addTypeRolledIndex >= 0, '应生成 type_rolled 补列语句');
  assert.ok(commentTypeRolledIndex > addTypeRolledIndex, 'type_rolled 列注释必须在补列之后');
});

test('旧表升级时应先补 generated_technique_def 的发布列，再创建相关索引', () => {
  const queries = getTechniqueGenerationCompatibilityQueries();

  const addNormalizedNameIndex = findQueryIndex(
    queries,
    /ALTER TABLE generated_technique_def ADD COLUMN IF NOT EXISTS normalized_name VARCHAR\(64\)/,
  );
  const addIsPublishedIndex = findQueryIndex(
    queries,
    /ALTER TABLE generated_technique_def ADD COLUMN IF NOT EXISTS is_published BOOLEAN NOT NULL DEFAULT false/,
  );
  const publishedIndexQueryIndex = findQueryIndex(
    queries,
    /CREATE INDEX IF NOT EXISTS idx_generated_technique_def_published/,
  );
  const uniqueNameIndexQueryIndex = findQueryIndex(
    queries,
    /CREATE UNIQUE INDEX IF NOT EXISTS uq_generated_technique_def_normalized_name_published/,
  );

  assert.ok(addNormalizedNameIndex >= 0, '应先生成 normalized_name 补列语句');
  assert.ok(addIsPublishedIndex >= 0, '应先生成 is_published 补列语句');
  assert.ok(
    publishedIndexQueryIndex > addIsPublishedIndex,
    '发布索引必须在 is_published 补列之后',
  );
  assert.ok(
    uniqueNameIndexQueryIndex > addNormalizedNameIndex,
    '名称唯一索引必须在 normalized_name 补列之后',
  );
});
