/**
 * 股市两位小数价格存储回填。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把历史整数灵石股价列迁移为定点分单位，保证后续 0.01 灵石价格精度不会把老数据显示成 1/100。
 * 2. 做什么：通过迁移标记表保证全库只执行一次，避免价格长期涨跌后被重复或漏回填。
 * 3. 不做什么：不改持仓成本、成交额、手续费、到账额等真实整数灵石金额，也不创建数据库结构。
 *
 * 输入 / 输出：
 * - 输入：现有 quote/history/trade_record 中的单价列与固定迁移 key。
 * - 输出：首次迁移时把全部正数单价乘以价格精度倍数，并写入迁移标记。
 *
 * 数据流 / 状态流：
 * initTables -> 本模块抢占迁移 key -> 三条批量 SQL 分别修正报价、历史收盘价和交易记录单价 -> 写入同事务提交。
 *
 * 复用设计说明：
 * - 价格精度切换是股市服务、排行榜、AI prompt 和前端图表共同依赖的基础口径，集中回填可以避免各查询路径自行判断旧数据。
 * - 迁移 key 是本次数据语义切换的单一入口，避免服务启动、行情查询或交易路径各自补偿历史数据。
 *
 * 关键边界条件与坑点：
 * 1. 这里只处理单价列；持仓成本和成交金额本来就是整数灵石，不能乘以 100。
 * 2. 新服空表也会写迁移标记，后续插入的初始报价已经是分单位，不需要再迁移。
 * 3. 迁移 key 先插入再更新，依赖唯一键让多进程启动时只有一个事务执行实际回填。
 */
import { query, withTransaction } from '../../config/database.js';
import { STOCK_MARKET_PRICE_SCALE } from './stockMarketRules.js';

const STOCK_MARKET_PRICE_SCALE_MIGRATION_KEY = 'stock-market-price-scale-v2';

type StockMarketDataMigrationInsertRow = {
  migration_key: string;
};

const runStockMarketPriceScaleBackfillSql = async (
  sql: string,
): Promise<number> => {
  const result = await query(sql, [
    STOCK_MARKET_PRICE_SCALE.toString(),
  ]);
  return Number(result.rowCount ?? 0);
};

export const backfillStockMarketPriceScale = async (): Promise<void> => {
  await withTransaction(async () => {
    const insertResult = await query<StockMarketDataMigrationInsertRow>(
      `
        INSERT INTO stock_market_data_migration (migration_key)
        VALUES ($1)
        ON CONFLICT (migration_key) DO NOTHING
        RETURNING migration_key
      `,
      [STOCK_MARKET_PRICE_SCALE_MIGRATION_KEY],
    );
    if (insertResult.rows.length <= 0) return;

    const quoteCount = await runStockMarketPriceScaleBackfillSql(
      `
        UPDATE stock_market_quote
        SET current_price_spirit_stones = current_price_spirit_stones * $1::bigint,
            updated_at = NOW()
        WHERE current_price_spirit_stones > 0
      `,
    );

    const historyCount = await runStockMarketPriceScaleBackfillSql(
      `
        UPDATE stock_market_price_history
        SET price_spirit_stones = price_spirit_stones * $1::bigint
        WHERE price_spirit_stones > 0
      `,
    );

    const tradeRecordCount = await runStockMarketPriceScaleBackfillSql(
      `
        UPDATE stock_market_trade_record
        SET unit_price_spirit_stones = unit_price_spirit_stones * $1::bigint
        WHERE unit_price_spirit_stones > 0
      `,
    );

    const updatedCount = quoteCount + historyCount + tradeRecordCount;
    if (updatedCount > 0) {
      console.log(`[stock_market] 已回填两位小数价格存储: quote ${quoteCount} / history ${historyCount} / trade ${tradeRecordCount} 条`);
    }
  });
};
