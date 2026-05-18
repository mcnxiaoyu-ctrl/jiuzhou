/**
 * 股市交易与行情服务。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：初始化静态股票报价、生成小时行情、查询概览/历史/交易记录，并处理系统即时买卖。
 * 2. 不做什么：不实现玩家挂单撮合、不把股票伪装成坊市物品、不在路由层重复业务规则。
 *
 * 输入 / 输出：
 * - 输入：角色 ID、股票 ID、交易数量、调度 tick 时间。
 * - 输出：股市概览 DTO、历史价格、交易记录和买卖结果。
 *
 * 数据流 / 状态流：
 * 静态股票 -> 初始 quote -> AI 新闻具体涨跌 -> quote/history；
 * 角色请求 -> 交易校验 -> 货币 Delta -> holding/trade record -> route 推送角色刷新。
 *
 * 复用设计说明：
 * - 报价、持仓、交易记录都在本服务单点聚合，前端只消费 DTO，避免列表页、持仓页和交易页各自拼 SQL。
 * - 买卖都复用 `stockMarketRules` 与现有精确货币入口，手续费、限额和灵石扣增不会散落。
 *
 * 关键边界条件与坑点：
 * 1. 买入必须先按角色货币锁串行化，再更新持仓，避免同角色并发买入突破总持仓上限。
 * 2. AI 失败只更新 tick 状态，不触碰 quote/history，保证价格只由有效新闻驱动。
 */
import { withTransaction, query } from '../../config/database.js';
import { Transactional } from '../../decorators/transactional.js';
import {
  addCharacterCurrenciesExact,
  consumeCharacterCurrenciesExact,
} from '../inventory/shared/consume.js';
import {
  getEnabledStockDefinitionById,
  getEnabledStockDefinitions,
  type StockMarketDefinition,
} from './stockMarketDefinitions.js';
import {
  generateStockMarketAiNewsDraft,
  type StockMarketValidatedImpact,
} from './stockMarketAi.js';
import {
  STOCK_MARKET_HISTORY_LIMIT,
  STOCK_MARKET_TRADE_RECORD_PAGE_SIZE,
  applyStockMarketPriceChange,
  buildStockMarketTradeRulesDto,
  calculateStockMarketMaxBuyQuantity,
  calculateStockMarketMaxSellQuantity,
  calculateReleasedStockHoldingCost,
  calculateStockMarketGrossAmount,
  calculateStockMarketTradeFee,
} from './stockMarketRules.js';
import {
  floorStockMarketTickHour,
  getNextStockMarketRefreshAt,
} from './stockMarketTime.js';

type StockMarketQuoteRow = {
  stock_id: string;
  current_price_spirit_stones: string | number | bigint;
  last_change_bps: string | number;
  updated_at: Date | string;
};

type StockMarketHoldingRow = {
  stock_id: string;
  quantity: string | number;
  total_cost_spirit_stones: string | number | bigint;
};

type StockMarketNewsRow = {
  id: string | number | bigint;
  tick_hour: Date | string;
  headline: string | null;
  summary: string | null;
  created_at: Date | string;
  stock_id: string | null;
  change_bps: string | number | null;
  direction: string | null;
  reason: string | null;
};

type StockMarketHistoryRow = {
  tick_hour: Date | string;
  price_spirit_stones: string | number | bigint | null;
  change_bps: string | number | null;
  direction: string | null;
  reason: string | null;
  baseline_price_spirit_stones: string | number | bigint;
};

type StockMarketTradeRow = {
  id: string | number | bigint;
  stock_id: string;
  side: string;
  quantity: string | number;
  unit_price_spirit_stones: string | number | bigint;
  gross_amount_spirit_stones: string | number | bigint;
  fee_spirit_stones: string | number | bigint;
  net_amount_spirit_stones: string | number | bigint;
  realized_pnl_spirit_stones: string | number | bigint | null;
  created_at: Date | string;
};

type StockMarketTickInsertRow = {
  id: string | number | bigint;
};

type StockMarketTickRow = {
  id: string | number | bigint;
  status: string;
};

export type StockMarketStockDto = {
  stockId: string;
  code: string;
  name: string;
  shortName: string;
  sector: string;
  description: string;
  priceSpiritStones: number;
  lastChangeBps: number;
  updatedAt: number;
  holdingQty: number;
  holdingCostSpiritStones: number;
  holdingMarketValueSpiritStones: number;
  unrealizedPnlSpiritStones: number;
  maxBuyQty: number;
  maxSellQty: number;
};

export type StockMarketNewsDto = {
  tickId: number;
  tickHour: number;
  headline: string;
  summary: string;
  impacts: Array<{
    stockId: string;
    stockName: string;
    direction: string;
    changeBps: number;
    reason: string | null;
  }>;
  createdAt: number;
};

export type StockMarketPortfolioDto = {
  totalHoldingQty: number;
  totalCostSpiritStones: number;
  totalMarketValueSpiritStones: number;
  totalUnrealizedPnlSpiritStones: number;
};

export type StockMarketOverviewDto = {
  stocks: StockMarketStockDto[];
  latestNews: StockMarketNewsDto | null;
  newsRecords: StockMarketNewsDto[];
  portfolio: StockMarketPortfolioDto;
  tradeRules: ReturnType<typeof buildStockMarketTradeRulesDto>;
  nextRefreshAt: number;
};

export type StockMarketHistoryPointDto = {
  stockId: string;
  priceSpiritStones: number;
  changeBps: number;
  direction: string;
  reason: string | null;
  createdAt: number;
};

export type StockMarketTradeRecordDto = {
  id: number;
  stockId: string;
  stockName: string;
  stockCode: string;
  side: 'buy' | 'sell';
  quantity: number;
  unitPriceSpiritStones: number;
  grossAmountSpiritStones: number;
  feeSpiritStones: number;
  netAmountSpiritStones: number;
  realizedPnlSpiritStones: number | null;
  createdAt: number;
};

type StockMarketStockBuildInput = {
  definition: StockMarketDefinition;
  price: bigint;
  lastChangeBps: number;
  updatedAt: Date | string;
  quantity: number;
  holdingCost: bigint;
  marketValue: bigint;
};

const toBigIntValue = (value: string | number | bigint | null | undefined): bigint => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  if (typeof value === 'string' && value.trim()) return BigInt(value);
  return 0n;
};

const toIntValue = (value: string | number | null | undefined): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
};

const toTimestamp = (value: Date | string): number => {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
};

const toDtoNumber = (value: bigint): number => {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized)) {
    throw new Error('股市数值超过前端安全整数范围');
  }
  return normalized;
};

const normalizeTradeQuantity = (quantity: number): number | null => {
  if (!Number.isInteger(quantity) || quantity <= 0) return null;
  if (!Number.isSafeInteger(quantity)) return null;
  return quantity;
};

const buildStockMarketDirection = (changeBps: number): string => {
  if (changeBps > 0) return 'up';
  if (changeBps < 0) return 'down';
  return 'flat';
};

class StockMarketService {
  async ensureInitialQuotes(): Promise<void> {
    const definitions = getEnabledStockDefinitions();
    if (definitions.length <= 0) return;

    const values: Array<string | number> = [];
    const placeholders = definitions.map((definition, index) => {
      const baseIndex = index * 2;
      values.push(definition.id, definition.initial_price_spirit_stones);
      return `($${baseIndex + 1}, $${baseIndex + 2})`;
    });

    await query(
      `
        INSERT INTO stock_market_quote (stock_id, current_price_spirit_stones)
        VALUES ${placeholders.join(', ')}
        ON CONFLICT (stock_id) DO NOTHING
      `,
      values,
    );
  }

  private async loadQuoteRowsForUpdate(stockIds: readonly string[]): Promise<Map<string, StockMarketQuoteRow>> {
    if (stockIds.length <= 0) return new Map<string, StockMarketQuoteRow>();
    const result = await query<StockMarketQuoteRow>(
      `
        SELECT stock_id, current_price_spirit_stones, last_change_bps, updated_at
        FROM stock_market_quote
        WHERE stock_id = ANY($1::text[])
        FOR UPDATE
      `,
      [stockIds],
    );
    return new Map(result.rows.map((row) => [row.stock_id, row] as const));
  }

  private async loadCurrentTotalHoldingValue(characterId: number): Promise<bigint> {
    const result = await query<{ total_value: string | number | bigint | null }>(
      `
        SELECT COALESCE(SUM(csh.quantity::bigint * smq.current_price_spirit_stones), 0)::bigint AS total_value
        FROM character_stock_holding csh
        JOIN stock_market_quote smq ON smq.stock_id = csh.stock_id
        WHERE csh.character_id = $1
      `,
      [characterId],
    );
    return toBigIntValue(result.rows[0]?.total_value ?? 0);
  }

  async getOverview(characterId: number): Promise<StockMarketOverviewDto> {
    await this.ensureInitialQuotes();

    const definitions = getEnabledStockDefinitions();
    const [quoteResult, holdingResult, newsResult] = await Promise.all([
      query<StockMarketQuoteRow>(
        `
          SELECT stock_id, current_price_spirit_stones, last_change_bps, updated_at
          FROM stock_market_quote
          WHERE stock_id = ANY($1::text[])
        `,
        [definitions.map((definition) => definition.id)],
      ),
      query<StockMarketHoldingRow>(
        `
          SELECT stock_id, quantity, total_cost_spirit_stones
          FROM character_stock_holding
          WHERE character_id = $1
        `,
        [characterId],
      ),
      query<StockMarketNewsRow>(
        `
          WITH recent_ticks AS (
            SELECT id, tick_hour, headline, summary, created_at
            FROM stock_market_tick
            WHERE status = 'generated'
            ORDER BY tick_hour DESC
            LIMIT 10
          )
          SELECT
            rt.id,
            rt.tick_hour,
            rt.headline,
            rt.summary,
            rt.created_at,
            h.stock_id,
            h.change_bps,
            h.direction,
            h.reason
          FROM recent_ticks rt
          LEFT JOIN stock_market_price_history h ON h.tick_id = rt.id
          ORDER BY rt.tick_hour DESC, h.id ASC
        `,
      ),
    ]);

    const quoteByStockId = new Map(quoteResult.rows.map((row) => [row.stock_id, row] as const));
    const holdingByStockId = new Map(holdingResult.rows.map((row) => [row.stock_id, row] as const));
    const definitionMap = new Map(definitions.map((definition) => [definition.id, definition] as const));
    const stockBuildInputs: StockMarketStockBuildInput[] = [];
    let totalHoldingQty = 0;
    let totalCost = 0n;
    let totalMarketValue = 0n;

    for (const definition of definitions) {
      const quote = quoteByStockId.get(definition.id);
      const holding = holdingByStockId.get(definition.id);
      const price = toBigIntValue(quote?.current_price_spirit_stones ?? definition.initial_price_spirit_stones);
      const quantity = toIntValue(holding?.quantity ?? 0);
      const holdingCost = toBigIntValue(holding?.total_cost_spirit_stones ?? 0);
      const marketValue = price * BigInt(quantity);
      totalHoldingQty += quantity;
      totalCost += holdingCost;
      totalMarketValue += marketValue;
      stockBuildInputs.push({
        definition,
        price,
        lastChangeBps: toIntValue(quote?.last_change_bps ?? 0),
        updatedAt: quote?.updated_at ?? new Date(),
        quantity,
        holdingCost,
        marketValue,
      });
    }

    const newsRecords = this.buildNewsDtos(newsResult.rows, definitionMap);

    return {
      stocks: stockBuildInputs.map((input) => this.buildStockDto({
        ...input,
        totalMarketValue,
      })),
      latestNews: newsRecords[0] ?? null,
      newsRecords,
      portfolio: {
        totalHoldingQty,
        totalCostSpiritStones: toDtoNumber(totalCost),
        totalMarketValueSpiritStones: toDtoNumber(totalMarketValue),
        totalUnrealizedPnlSpiritStones: toDtoNumber(totalMarketValue - totalCost),
      },
      tradeRules: buildStockMarketTradeRulesDto(),
      nextRefreshAt: getNextStockMarketRefreshAt().getTime(),
    };
  }

  async getHistory(stockId: string): Promise<{
    success: boolean;
    message: string;
    data?: { points: StockMarketHistoryPointDto[] };
  }> {
    const definition = getEnabledStockDefinitionById(stockId);
    if (!definition) return { success: false, message: '股票不存在' };

    await this.ensureInitialQuotes();
    const result = await query<StockMarketHistoryRow>(
      `
        WITH recent_ticks AS (
          SELECT id, tick_hour
          FROM stock_market_tick
          WHERE status = 'generated'
          ORDER BY tick_hour DESC
          LIMIT $2
        ),
        ordered_ticks AS (
          SELECT id, tick_hour
          FROM recent_ticks
          ORDER BY tick_hour ASC
        ),
        first_tick AS (
          SELECT tick_hour
          FROM ordered_ticks
          ORDER BY tick_hour ASC
          LIMIT 1
        ),
        baseline AS (
          SELECT h.price_spirit_stones
          FROM stock_market_price_history h
          CROSS JOIN first_tick ft
          WHERE h.stock_id = $1
            AND h.created_at < ft.tick_hour
          ORDER BY h.created_at DESC, h.id DESC
          LIMIT 1
        )
        SELECT
          ot.tick_hour,
          h.price_spirit_stones,
          h.change_bps,
          h.direction,
          h.reason,
          COALESCE((SELECT price_spirit_stones FROM baseline), $3::bigint) AS baseline_price_spirit_stones
        FROM ordered_ticks ot
        LEFT JOIN stock_market_price_history h ON h.tick_id = ot.id AND h.stock_id = $1
        ORDER BY ot.tick_hour ASC
      `,
      [definition.id, STOCK_MARKET_HISTORY_LIMIT, definition.initial_price_spirit_stones],
    );

    return {
      success: true,
      message: 'ok',
      data: {
        points: this.buildHistoryPointDtos(definition.id, result.rows),
      },
    };
  }

  async getTradeRecords(characterId: number, page: number): Promise<{
    records: StockMarketTradeRecordDto[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const safePage = Number.isInteger(page) && page > 0 ? page : 1;
    const offset = (safePage - 1) * STOCK_MARKET_TRADE_RECORD_PAGE_SIZE;
    const [recordsResult, totalResult] = await Promise.all([
      query<StockMarketTradeRow>(
        `
          SELECT
            id, stock_id, side, quantity, unit_price_spirit_stones,
            gross_amount_spirit_stones, fee_spirit_stones, net_amount_spirit_stones,
            realized_pnl_spirit_stones, created_at
          FROM stock_market_trade_record
          WHERE character_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT $2 OFFSET $3
        `,
        [characterId, STOCK_MARKET_TRADE_RECORD_PAGE_SIZE, offset],
      ),
      query<{ total: string | number }>(
        `
          SELECT COUNT(*)::int AS total
          FROM stock_market_trade_record
          WHERE character_id = $1
        `,
        [characterId],
      ),
    ]);

    const definitionMap = new Map(getEnabledStockDefinitions().map((definition) => [definition.id, definition] as const));
    return {
      records: recordsResult.rows.map((row) => this.buildTradeRecordDto(row, definitionMap)),
      total: toIntValue(totalResult.rows[0]?.total ?? 0),
      page: safePage,
      pageSize: STOCK_MARKET_TRADE_RECORD_PAGE_SIZE,
    };
  }

  @Transactional
  async buyStock(params: {
    characterId: number;
    stockId: string;
    quantity: number;
  }): Promise<{ success: boolean; message: string }> {
    const definition = getEnabledStockDefinitionById(params.stockId);
    if (!definition) return { success: false, message: '股票不存在' };
    const quantity = normalizeTradeQuantity(params.quantity);
    if (quantity === null) return { success: false, message: '购买数量不合法' };

    await this.ensureInitialQuotes();
    const quoteByStockId = await this.loadQuoteRowsForUpdate([definition.id]);
    const quote = quoteByStockId.get(definition.id);
    if (!quote) return { success: false, message: '股票报价不存在' };

    const holding = await this.loadHoldingForUpdate(params.characterId, definition.id);
    const price = toBigIntValue(quote.current_price_spirit_stones);
    const currentQuantity = toIntValue(holding?.quantity ?? 0);
    const totalHoldingValue = await this.loadCurrentTotalHoldingValue(params.characterId);
    const maxBuyQuantity = calculateStockMarketMaxBuyQuantity({
      unitPriceSpiritStones: price,
      currentSingleStockValueSpiritStones: price * BigInt(currentQuantity),
      currentTotalValueSpiritStones: totalHoldingValue,
    });
    if (quantity > maxBuyQuantity) {
      return { success: false, message: '购买数量超过当前可买上限' };
    }

    const grossAmount = calculateStockMarketGrossAmount(price, quantity);
    const fee = calculateStockMarketTradeFee(grossAmount, 'buy');
    const consumeResult = await consumeCharacterCurrenciesExact(params.characterId, {
      spiritStones: grossAmount + fee,
    });
    if (!consumeResult.success) return { success: false, message: consumeResult.message };

    await query(
      `
        INSERT INTO character_stock_holding (
          character_id, stock_id, quantity, total_cost_spirit_stones, updated_at
        )
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (character_id, stock_id)
        DO UPDATE SET
          quantity = character_stock_holding.quantity + EXCLUDED.quantity,
          total_cost_spirit_stones = character_stock_holding.total_cost_spirit_stones + EXCLUDED.total_cost_spirit_stones,
          updated_at = NOW()
      `,
      [params.characterId, definition.id, quantity, grossAmount.toString()],
    );
    await this.insertTradeRecord({
      characterId: params.characterId,
      stockId: definition.id,
      side: 'buy',
      quantity,
      price,
      grossAmount,
      fee,
      netAmount: grossAmount + fee,
      realizedPnl: null,
    });

    return { success: true, message: '买入成功' };
  }

  @Transactional
  async sellStock(params: {
    characterId: number;
    stockId: string;
    quantity: number;
  }): Promise<{ success: boolean; message: string }> {
    const definition = getEnabledStockDefinitionById(params.stockId);
    if (!definition) return { success: false, message: '股票不存在' };
    const quantity = normalizeTradeQuantity(params.quantity);
    if (quantity === null) return { success: false, message: '卖出数量不合法' };

    await this.ensureInitialQuotes();
    const quoteByStockId = await this.loadQuoteRowsForUpdate([definition.id]);
    const quote = quoteByStockId.get(definition.id);
    if (!quote) return { success: false, message: '股票报价不存在' };

    const holding = await this.loadHoldingForUpdate(params.characterId, definition.id);
    if (!holding) return { success: false, message: '未持有该股票' };
    const holdingQuantity = toIntValue(holding.quantity);
    const maxSellQuantity = calculateStockMarketMaxSellQuantity(holdingQuantity);
    if (quantity > maxSellQuantity) return { success: false, message: '持仓数量不足' };

    const price = toBigIntValue(quote.current_price_spirit_stones);
    const grossAmount = calculateStockMarketGrossAmount(price, quantity);
    const fee = calculateStockMarketTradeFee(grossAmount, 'sell');
    const netAmount = grossAmount > fee ? grossAmount - fee : 0n;
    const holdingCost = toBigIntValue(holding.total_cost_spirit_stones);
    const releasedCost = calculateReleasedStockHoldingCost(holdingCost, holdingQuantity, quantity);
    const realizedPnl = netAmount - releasedCost;

    if (netAmount > 0n) {
      const addResult = await addCharacterCurrenciesExact(params.characterId, {
        spiritStones: netAmount,
      });
      if (!addResult.success) return { success: false, message: addResult.message };
    }

    if (holdingQuantity === quantity) {
      await query(
        `
          DELETE FROM character_stock_holding
          WHERE character_id = $1 AND stock_id = $2
        `,
        [params.characterId, definition.id],
      );
    } else {
      await query(
        `
          UPDATE character_stock_holding
          SET
            quantity = quantity - $3,
            total_cost_spirit_stones = total_cost_spirit_stones - $4,
            updated_at = NOW()
          WHERE character_id = $1 AND stock_id = $2
        `,
        [params.characterId, definition.id, quantity, releasedCost.toString()],
      );
    }

    await this.insertTradeRecord({
      characterId: params.characterId,
      stockId: definition.id,
      side: 'sell',
      quantity,
      price,
      grossAmount,
      fee,
      netAmount,
      realizedPnl,
    });

    return { success: true, message: '卖出成功' };
  }

  async runHourlyTick(now: Date = new Date()): Promise<{
    status: 'generated' | 'failed' | 'skipped';
    message: string;
  }> {
    await this.ensureInitialQuotes();
    const tickHour = floorStockMarketTickHour(now);
    const insertResult = await query<StockMarketTickInsertRow>(
      `
        INSERT INTO stock_market_tick (tick_hour, status, created_at)
        VALUES ($1, 'running', NOW())
        ON CONFLICT (tick_hour) DO NOTHING
        RETURNING id
      `,
      [tickHour],
    );
    const insertedTick = insertResult.rows[0];
    if (!insertedTick) {
      return { status: 'skipped', message: '当前小时股市 tick 已存在' };
    }

    const tickId = toBigIntValue(insertedTick.id);
    const definitions = getEnabledStockDefinitions();
    const quoteResult = await query<StockMarketQuoteRow>(
      `
        SELECT stock_id, current_price_spirit_stones, last_change_bps, updated_at
        FROM stock_market_quote
        WHERE stock_id = ANY($1::text[])
      `,
      [definitions.map((definition) => definition.id)],
    );
    const newsResult = await generateStockMarketAiNewsDraft({
      definitions,
      quotes: quoteResult.rows.map((row) => ({
        stockId: row.stock_id,
        currentPriceSpiritStones: toBigIntValue(row.current_price_spirit_stones),
      })),
      tickHour,
    });

    if (!newsResult.success) {
      await this.recordTickFailure(tickId, newsResult.reason);
      return { status: 'failed', message: newsResult.reason };
    }

    await this.applyGeneratedTick({
      tickId,
      tickHour,
      headline: newsResult.draft.headline,
      summary: newsResult.draft.summary,
      modelName: newsResult.draft.modelName,
      promptSnapshot: newsResult.draft.promptSnapshot,
      impacts: newsResult.draft.impacts,
    });
    return { status: 'generated', message: '股市新闻与行情已生成' };
  }

  private buildStockDto(params: {
    definition: StockMarketDefinition;
    price: bigint;
    lastChangeBps: number;
    updatedAt: Date | string;
    quantity: number;
    holdingCost: bigint;
    marketValue: bigint;
    totalMarketValue: bigint;
  }): StockMarketStockDto {
    return {
      stockId: params.definition.id,
      code: params.definition.code,
      name: params.definition.name,
      shortName: params.definition.short_name ?? params.definition.name,
      sector: params.definition.sector,
      description: params.definition.description ?? '',
      priceSpiritStones: toDtoNumber(params.price),
      lastChangeBps: params.lastChangeBps,
      updatedAt: toTimestamp(params.updatedAt),
      holdingQty: params.quantity,
      holdingCostSpiritStones: toDtoNumber(params.holdingCost),
      holdingMarketValueSpiritStones: toDtoNumber(params.marketValue),
      unrealizedPnlSpiritStones: toDtoNumber(params.marketValue - params.holdingCost),
      maxBuyQty: calculateStockMarketMaxBuyQuantity({
        unitPriceSpiritStones: params.price,
        currentSingleStockValueSpiritStones: params.marketValue,
        currentTotalValueSpiritStones: params.totalMarketValue,
      }),
      maxSellQty: calculateStockMarketMaxSellQuantity(params.quantity),
    };
  }

  private buildNewsDto(
    rows: readonly StockMarketNewsRow[],
    definitionMap: ReadonlyMap<string, StockMarketDefinition>,
  ): StockMarketNewsDto | null {
    const row = rows[0] ?? null;
    if (!row?.headline || !row.summary) return null;
    const impacts: StockMarketNewsDto['impacts'] = [];
    for (const entry of rows) {
      if (!entry.stock_id) continue;
      impacts.push({
        stockId: entry.stock_id,
        stockName: definitionMap.get(entry.stock_id)?.name ?? entry.stock_id,
        direction: entry.direction ?? 'flat',
        changeBps: toIntValue(entry.change_bps ?? 0),
        reason: entry.reason,
      });
    }
    return {
      tickId: toDtoNumber(toBigIntValue(row.id)),
      tickHour: toTimestamp(row.tick_hour),
      headline: row.headline,
      summary: row.summary,
      impacts,
      createdAt: toTimestamp(row.created_at),
    };
  }

  private buildNewsDtos(
    rows: readonly StockMarketNewsRow[],
    definitionMap: ReadonlyMap<string, StockMarketDefinition>,
  ): StockMarketNewsDto[] {
    const rowsByTickId = new Map<string, StockMarketNewsRow[]>();
    for (const row of rows) {
      const tickId = String(row.id);
      const group = rowsByTickId.get(tickId);
      if (group) {
        group.push(row);
      } else {
        rowsByTickId.set(tickId, [row]);
      }
    }

    const records: StockMarketNewsDto[] = [];
    for (const group of rowsByTickId.values()) {
      const record = this.buildNewsDto(group, definitionMap);
      if (record) {
        records.push(record);
      }
    }
    return records;
  }

  private buildHistoryPointDtos(
    stockId: string,
    rows: readonly StockMarketHistoryRow[],
  ): StockMarketHistoryPointDto[] {
    const points: StockMarketHistoryPointDto[] = [];
    let lastPrice = toBigIntValue(rows[0]?.baseline_price_spirit_stones);

    for (const row of rows) {
      const changed = row.price_spirit_stones !== null;
      const price = changed ? toBigIntValue(row.price_spirit_stones) : lastPrice;
      const changeBps = changed ? toIntValue(row.change_bps) : 0;

      points.push({
        stockId,
        priceSpiritStones: toDtoNumber(price),
        changeBps,
        direction: changed ? row.direction ?? buildStockMarketDirection(changeBps) : 'flat',
        reason: changed ? row.reason : null,
        createdAt: toTimestamp(row.tick_hour),
      });

      lastPrice = price;
    }

    return points;
  }

  private buildTradeRecordDto(
    row: StockMarketTradeRow,
    definitionMap: ReadonlyMap<string, StockMarketDefinition>,
  ): StockMarketTradeRecordDto {
    return {
      id: toDtoNumber(toBigIntValue(row.id)),
      stockId: row.stock_id,
      stockName: definitionMap.get(row.stock_id)?.name ?? row.stock_id,
      stockCode: definitionMap.get(row.stock_id)?.code ?? row.stock_id,
      side: row.side === 'sell' ? 'sell' : 'buy',
      quantity: toIntValue(row.quantity),
      unitPriceSpiritStones: toDtoNumber(toBigIntValue(row.unit_price_spirit_stones)),
      grossAmountSpiritStones: toDtoNumber(toBigIntValue(row.gross_amount_spirit_stones)),
      feeSpiritStones: toDtoNumber(toBigIntValue(row.fee_spirit_stones)),
      netAmountSpiritStones: toDtoNumber(toBigIntValue(row.net_amount_spirit_stones)),
      realizedPnlSpiritStones: row.realized_pnl_spirit_stones === null
        ? null
        : toDtoNumber(toBigIntValue(row.realized_pnl_spirit_stones)),
      createdAt: toTimestamp(row.created_at),
    };
  }

  private async loadHoldingForUpdate(
    characterId: number,
    stockId: string,
  ): Promise<StockMarketHoldingRow | null> {
    const result = await query<StockMarketHoldingRow>(
      `
        SELECT stock_id, quantity, total_cost_spirit_stones
        FROM character_stock_holding
        WHERE character_id = $1 AND stock_id = $2
        FOR UPDATE
      `,
      [characterId, stockId],
    );
    return result.rows[0] ?? null;
  }

  private async insertTradeRecord(params: {
    characterId: number;
    stockId: string;
    side: 'buy' | 'sell';
    quantity: number;
    price: bigint;
    grossAmount: bigint;
    fee: bigint;
    netAmount: bigint;
    realizedPnl: bigint | null;
  }): Promise<void> {
    await query(
      `
        INSERT INTO stock_market_trade_record (
          character_id, stock_id, side, quantity, unit_price_spirit_stones,
          gross_amount_spirit_stones, fee_spirit_stones, net_amount_spirit_stones,
          realized_pnl_spirit_stones
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        params.characterId,
        params.stockId,
        params.side,
        params.quantity,
        params.price.toString(),
        params.grossAmount.toString(),
        params.fee.toString(),
        params.netAmount.toString(),
        params.realizedPnl === null ? null : params.realizedPnl.toString(),
      ],
    );
  }

  private async recordTickFailure(tickId: bigint, errorMessage: string): Promise<void> {
    await query(
      `
        UPDATE stock_market_tick
        SET status = 'failed',
            error_message = $2,
            finished_at = NOW()
        WHERE id = $1
      `,
      [tickId.toString(), errorMessage],
    );
  }

  private async applyGeneratedTick(params: {
    tickId: bigint;
    tickHour: Date;
    headline: string;
    summary: string;
    modelName: string;
    promptSnapshot: string;
    impacts: readonly StockMarketValidatedImpact[];
  }): Promise<void> {
    await withTransaction(async () => {
      const tickResult = await query<StockMarketTickRow>(
        `
          SELECT id, status
          FROM stock_market_tick
          WHERE id = $1
          FOR UPDATE
        `,
        [params.tickId.toString()],
      );
      if (tickResult.rows[0]?.status !== 'running') return;

      const impactedStockIds = params.impacts.map((impact) => impact.stockId);
      const quoteByStockId = await this.loadQuoteRowsForUpdate(impactedStockIds);
      if (quoteByStockId.size !== impactedStockIds.length) {
        await this.recordTickFailure(params.tickId, 'AI 新闻包含缺失报价的股票');
        return;
      }

      await query(
        `
          UPDATE stock_market_tick
          SET status = 'generated',
              headline = $2,
              summary = $3,
              model_name = $4,
              prompt_snapshot = $5,
              finished_at = NOW()
          WHERE id = $1
        `,
        [
          params.tickId.toString(),
          params.headline,
          params.summary,
          params.modelName,
          params.promptSnapshot,
        ],
      );

      for (const impact of params.impacts) {
        const quote = quoteByStockId.get(impact.stockId);
        if (!quote) continue;
        const currentPrice = toBigIntValue(quote.current_price_spirit_stones);
        const changeBps = impact.changeBps;
        const nextPrice = applyStockMarketPriceChange(currentPrice, changeBps);
        const direction = buildStockMarketDirection(changeBps);
        await query(
          `
            UPDATE stock_market_quote
            SET current_price_spirit_stones = $2,
                last_change_bps = $3,
                last_tick_id = $4,
                updated_at = NOW()
            WHERE stock_id = $1
          `,
          [impact.stockId, nextPrice.toString(), changeBps, params.tickId.toString()],
        );
        await query(
          `
            INSERT INTO stock_market_price_history (
              stock_id, tick_id, price_spirit_stones, change_bps, direction, reason, created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
          `,
          [
            impact.stockId,
            params.tickId.toString(),
            nextPrice.toString(),
            changeBps,
            direction,
            impact.reason,
            params.tickHour,
          ],
        );
      }
    });
  }
}

export const stockMarketService = new StockMarketService();
