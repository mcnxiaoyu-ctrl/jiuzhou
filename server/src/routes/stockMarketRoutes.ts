/**
 * 股市 HTTP 路由。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：提供股市概览、历史、交易记录、买入、卖出和清仓接口。
 * 2. 不做什么：不在路由层重复手续费、持仓上限或 AI 行情规则。
 *
 * 输入 / 输出：
 * - 输入：登录角色上下文、股票 ID、交易数量、清仓范围、分页参数。
 * - 输出：标准 `{ success, data?, message }` 响应。
 *
 * 数据流 / 状态流：
 * 前端股市弹窗 -> 本路由解析轻量参数 -> `stockMarketService` -> DTO -> 必要时推送角色资源刷新。
 *
 * 复用设计说明：
 * - 路由只做鉴权、QPS 和参数归一化，所有业务判断集中到 service，避免前端和路由各自维护限制文案。
 * - 买入/卖出共用同一个 body 解析函数，减少 stockId/quantity 校验分叉。
 *
 * 关键边界条件与坑点：
 * 1. 买卖和清仓成功后需要推送角色刷新，否则灵石余额会滞后。
 * 2. 查询接口保持低 QPS 限制，避免玩家频繁刷新股市概览造成数据库压力。
 */
import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireCharacter } from '../middleware/auth.js';
import { createQpsLimitMiddleware } from '../middleware/qpsLimit.js';
import { safePushCharacterUpdate } from '../middleware/pushUpdate.js';
import { sendResult, sendSuccess } from '../middleware/response.js';
import { parseFiniteNumber, parseNonEmptyText, getSingleQueryValue } from '../services/shared/httpParam.js';
import { stockMarketService } from '../services/stockMarket/stockMarketService.js';

const router = Router();

const STOCK_MARKET_QPS_WINDOW_MS = 1000;
const STOCK_MARKET_QUERY_QPS_LIMIT = 5;
const STOCK_MARKET_MUTATION_QPS_LIMIT = 2;
const STOCK_MARKET_QPS_LIMIT_MESSAGE = '股市请求过于频繁，请稍后再试';

type StockMarketTradeBody = {
  stockId?: string | null;
  quantity?: string | number | null;
};

type StockMarketClearPositionBody = {
  stockId?: string | null;
};

const createStockMarketQpsLimit = (routeKey: string, limit: number) => createQpsLimitMiddleware({
  keyPrefix: `qps:stock-market:${routeKey}`,
  limit,
  windowMs: STOCK_MARKET_QPS_WINDOW_MS,
  message: STOCK_MARKET_QPS_LIMIT_MESSAGE,
  resolveScope: (req) => req.userId!,
});

const stockMarketOverviewQpsLimit = createStockMarketQpsLimit('overview', STOCK_MARKET_QUERY_QPS_LIMIT);
const stockMarketHistoryQpsLimit = createStockMarketQpsLimit('history', STOCK_MARKET_QUERY_QPS_LIMIT);
const stockMarketTradesQpsLimit = createStockMarketQpsLimit('trades', STOCK_MARKET_QUERY_QPS_LIMIT);
const stockMarketBuyQpsLimit = createStockMarketQpsLimit('buy', STOCK_MARKET_MUTATION_QPS_LIMIT);
const stockMarketSellQpsLimit = createStockMarketQpsLimit('sell', STOCK_MARKET_MUTATION_QPS_LIMIT);
const stockMarketClearQpsLimit = createStockMarketQpsLimit('clear', STOCK_MARKET_MUTATION_QPS_LIMIT);

const parseTradeBody = (body: StockMarketTradeBody): { stockId: string; quantity: number } | null => {
  const stockId = typeof body.stockId === 'string' ? body.stockId.trim() : '';
  const quantity = parseFiniteNumber(body.quantity ?? undefined);
  if (!stockId || quantity === undefined) return null;
  return {
    stockId,
    quantity,
  };
};

const parseClearPositionBody = (body: StockMarketClearPositionBody): { stockId: string | null } | null => {
  if (body.stockId === undefined || body.stockId === null) {
    return { stockId: null };
  }
  if (typeof body.stockId !== 'string') return null;
  const stockId = body.stockId.trim();
  return { stockId: stockId || null };
};

router.get('/overview', requireCharacter, stockMarketOverviewQpsLimit, asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const data = await stockMarketService.getOverview(characterId);
  sendSuccess(res, data);
}));

router.get('/history', requireCharacter, stockMarketHistoryQpsLimit, asyncHandler(async (req, res) => {
  const stockId = parseNonEmptyText(getSingleQueryValue(req.query.stockId));
  if (!stockId) {
    sendResult(res, { success: false, message: 'stockId 参数无效' });
    return;
  }

  const result = await stockMarketService.getHistory(stockId);
  sendResult(res, result);
}));

router.get('/trades', requireCharacter, stockMarketTradesQpsLimit, asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const page = parseFiniteNumber(getSingleQueryValue(req.query.page));
  const data = await stockMarketService.getTradeRecords(characterId, page ?? 1);
  sendSuccess(res, data);
}));

router.post('/buy', requireCharacter, stockMarketBuyQpsLimit, asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const body = parseTradeBody(req.body as StockMarketTradeBody);
  if (!body) {
    sendResult(res, { success: false, message: '买入参数无效' });
    return;
  }

  const result = await stockMarketService.buyStock({
    characterId,
    stockId: body.stockId,
    quantity: body.quantity,
  });
  if (result.success) {
    await safePushCharacterUpdate(req.userId!);
  }
  sendResult(res, result);
}));

router.post('/sell', requireCharacter, stockMarketSellQpsLimit, asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const body = parseTradeBody(req.body as StockMarketTradeBody);
  if (!body) {
    sendResult(res, { success: false, message: '卖出参数无效' });
    return;
  }

  const result = await stockMarketService.sellStock({
    characterId,
    stockId: body.stockId,
    quantity: body.quantity,
  });
  if (result.success) {
    await safePushCharacterUpdate(req.userId!);
  }
  sendResult(res, result);
}));

router.post('/clear', requireCharacter, stockMarketClearQpsLimit, asyncHandler(async (req, res) => {
  const characterId = req.characterId!;
  const body = parseClearPositionBody(req.body as StockMarketClearPositionBody);
  if (!body) {
    sendResult(res, { success: false, message: '清仓参数无效' });
    return;
  }

  const result = await stockMarketService.clearPosition({
    characterId,
    stockId: body.stockId,
  });
  if (result.success) {
    await safePushCharacterUpdate(req.userId!);
  }
  sendResult(res, result);
}));

export default router;
