/**
 * 股市接口封装。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中定义股市概览、走势、交易记录与买卖请求的 DTO 和 API 函数。
 * 2. 不做什么：不在前端重复计算手续费、持仓上限或服务端交易规则。
 *
 * 输入 / 输出：
 * - 输入：股票 ID、交易数量、分页参数与可选请求配置。
 * - 输出：标准接口响应 Promise，供股市弹窗和纯函数派生层消费。
 *
 * 数据流 / 状态流：
 * StockMarketModal -> 本模块发起 HTTP 请求 -> 后端股市服务 -> DTO -> stockMarketView 统一派生展示模型。
 *
 * 复用设计说明：
 * - DTO 与请求函数放在同一文件，避免弹窗、测试和后续入口各自重复声明接口形状。
 * - 分页和查询参数统一走 `withRequestParams`，避免多个调用点手写 params 合并。
 *
 * 关键边界条件与坑点：
 * 1. 买卖失败提示由统一拦截器处理，本模块不额外 catch，避免重复 toast。
 * 2. 历史走势只按选中股票单独请求，概览接口不承载大历史数组，首屏更轻。
 */
import type { AxiosRequestConfig } from 'axios';
import api from './core';
import { withRequestParams } from './requestConfig';

export type StockMarketTradeSide = 'buy' | 'sell';

export interface StockMarketStockDto {
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
}

export interface StockMarketNewsImpactDto {
  stockId: string;
  stockName: string;
  direction: string;
  changeBps: number;
  reason: string | null;
}

export interface StockMarketNewsDto {
  tickId: number;
  tickHour: number;
  headline: string;
  summary: string;
  impacts: StockMarketNewsImpactDto[];
  createdAt: number;
}

export interface StockMarketPortfolioDto {
  totalHoldingQty: number;
  totalCostSpiritStones: number;
  totalMarketValueSpiritStones: number;
  totalUnrealizedPnlSpiritStones: number;
}

export interface StockMarketTradeRulesDto {
  feeBps: number;
  maxOrderQty: number;
  maxOrderValueSpiritStones: number;
  maxSingleStockValueSpiritStones: number;
  maxTotalValueSpiritStones: number;
  minPriceSpiritStones: number;
}

export interface StockMarketOverviewDto {
  stocks: StockMarketStockDto[];
  latestNews: StockMarketNewsDto | null;
  portfolio: StockMarketPortfolioDto;
  tradeRules: StockMarketTradeRulesDto;
  nextRefreshAt: number;
}

export interface StockMarketHistoryPointDto {
  stockId: string;
  priceSpiritStones: number;
  changeBps: number;
  direction: string;
  reason: string | null;
  createdAt: number;
}

export interface StockMarketTradeRecordDto {
  id: number;
  stockId: string;
  stockName: string;
  stockCode: string;
  side: StockMarketTradeSide;
  quantity: number;
  unitPriceSpiritStones: number;
  grossAmountSpiritStones: number;
  feeSpiritStones: number;
  netAmountSpiritStones: number;
  realizedPnlSpiritStones: number | null;
  createdAt: number;
}

interface StockMarketApiResponse<TData> {
  success: boolean;
  message?: string;
  data?: TData;
}

export type StockMarketOverviewResponse = StockMarketApiResponse<StockMarketOverviewDto>;
export type StockMarketHistoryResponse = StockMarketApiResponse<{ points: StockMarketHistoryPointDto[] }>;
export type StockMarketTradesResponse = StockMarketApiResponse<{
  records: StockMarketTradeRecordDto[];
  total: number;
  page: number;
  pageSize: number;
}>;
export type StockMarketTradeResponse = StockMarketApiResponse<never>;

export const getStockMarketOverview = (
  requestConfig?: AxiosRequestConfig,
): Promise<StockMarketOverviewResponse> => {
  return api.get('/stock-market/overview', requestConfig);
};

export const getStockMarketHistory = (
  stockId: string,
  requestConfig?: AxiosRequestConfig,
): Promise<StockMarketHistoryResponse> => {
  return api.get('/stock-market/history', withRequestParams(requestConfig, { stockId }));
};

export const getStockMarketTrades = (
  params?: { page?: number },
  requestConfig?: AxiosRequestConfig,
): Promise<StockMarketTradesResponse> => {
  return api.get('/stock-market/trades', withRequestParams(requestConfig, { page: params?.page }));
};

export const buyStockMarketStock = (
  body: { stockId: string; quantity: number },
  requestConfig?: AxiosRequestConfig,
): Promise<StockMarketTradeResponse> => {
  return api.post('/stock-market/buy', body, requestConfig);
};

export const sellStockMarketStock = (
  body: { stockId: string; quantity: number },
  requestConfig?: AxiosRequestConfig,
): Promise<StockMarketTradeResponse> => {
  return api.post('/stock-market/sell', body, requestConfig);
};
