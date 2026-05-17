import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * 排行榜 SQL 回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定 `loadArenaRanks` 只使用子查询显式暴露的 `character_id` 作为最终并列排序键，避免再次引用不存在的 `id` 别名。
 * 2. 做什么：锁定财富榜与股市榜货币字段按 `bigint` 输出，避免数据库把玩家资产压成 `int4` 后在高资产账号上溢出。
 * 3. 不做什么：不连接数据库，不执行排行榜查询，也不验证缓存层与月卡状态拼装逻辑。
 *
 * 输入/输出：
 * - 输入：`server/src/services/rankService.ts` 源码文本。
 * - 输出：断言竞技场排行排序键正确，且财富榜、股市榜金额字段不会出现 `::int` 强转。
 *
 * 数据流/状态流：
 * 读取 `rankService.ts` -> 定位排行榜 SQL 片段 -> 断言高风险 SQL 写法被单一源码测试拦截。
 *
 * 关键边界条件与坑点：
 * 1. 这是源码级保护，不会发现数据库层或运行时缓存层的其他问题；它只负责拦住 SQL 片段回归。
 * 2. 如果后续把排行榜 SQL 拆到独立模块或模板字符串中，必须同步更新这里的定位方式，否则测试会误报。
 */

const rankServicePath = path.resolve(process.cwd(), 'src/services/rankService.ts');

test('loadArenaRanks: 并列排序应使用 character_id 而不是不存在的 id', () => {
  const source = fs.readFileSync(rankServicePath, 'utf8');

  assert.match(
    source,
    /ROW_NUMBER\(\) OVER \(ORDER BY score DESC, win_count DESC, lose_count ASC, character_id ASC\)::int AS rank/,
    '竞技场排行榜应使用 character_id 作为稳定排序键',
  );
  assert.doesNotMatch(
    source,
    /ROW_NUMBER\(\) OVER \(ORDER BY score DESC, win_count DESC, lose_count ASC, id ASC\)::int AS rank/,
    '竞技场排行榜不应再引用子查询外不存在的 id 列',
  );
});

test('loadWealthRanks: 货币字段应保留 bigint 输出，避免 int4 溢出', () => {
  const source = fs.readFileSync(rankServicePath, 'utf8');

  assert.match(
    source,
    /COALESCE\(spirit_stones, 0\)::bigint AS "spiritStones"/,
    '财富排行榜灵石应按 bigint 输出，避免高资产账号溢出',
  );
  assert.match(
    source,
    /COALESCE\(silver, 0\)::bigint AS silver/,
    '财富排行榜银两应按 bigint 输出，避免高资产账号溢出',
  );
  assert.doesNotMatch(
    source,
    /COALESCE\((spirit_stones|silver), 0\)::int/,
    '财富排行榜货币字段不应强转为 int4',
  );
});

test('loadStockMarketRanks: 股市金额聚合与排序口径应稳定', () => {
  const source = fs.readFileSync(rankServicePath, 'utf8');

  assert.match(
    source,
    /SUM\(csh\.quantity::bigint \* smq\.current_price_spirit_stones\)::bigint AS total_market_value_spirit_stones/,
    '股市市值应按 bigint 聚合，避免持仓市值溢出',
  );
  assert.match(
    source,
    /SUM\(COALESCE\(realized_pnl_spirit_stones, 0\)\)::bigint AS realized_pnl_spirit_stones/,
    '股市收益榜必须纳入已实现盈亏',
  );
  assert.match(
    source,
    /value:\s*'"totalMarketValueSpiritStones" DESC, "totalPnlSpiritStones" DESC, character_id ASC'/,
    '股市市值榜应按市值、总收益、角色 ID 稳定排序',
  );
  assert.match(
    source,
    /profit:\s*'"totalPnlSpiritStones" DESC, "totalMarketValueSpiritStones" DESC, character_id ASC'/,
    '股市收益榜应按总收益、市值、角色 ID 稳定排序',
  );
  assert.doesNotMatch(
    source,
    /stock_market[\s\S]*::int(?! AS rank)/u,
    '股市排行榜金额字段不应强转为 int4',
  );
});
