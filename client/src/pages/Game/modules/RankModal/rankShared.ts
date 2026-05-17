/**
 * 排行榜弹窗的数据加载与短时缓存。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一管理角色榜单、伙伴多维榜单和股市多维榜单的按需请求、模块级短时缓存和并发去重。
 * 2. 做什么：把“左侧分类 + 榜单维度”组合成单一 query key，避免 RankModal 自己维护多套加载状态机。
 * 3. 不做什么：不渲染表格/卡片 UI，不持久化到 localStorage，也不改变后端榜单排序规则。
 *
 * 输入/输出：
 * - 输入：弹窗可见状态、当前榜单分类，以及伙伴榜/股市榜当前维度。
 * - 输出：常规榜单数据、伙伴榜数据、股市榜数据，以及它们各自的 loading 状态。
 *
 * 数据流/状态流：
 * RankModal 传入当前 tab / metric -> 本模块读取模块级缓存 -> 缓存未命中时调用对应接口 ->
 * 写回缓存与局部状态 -> UI 只渲染当前激活的榜单结果。
 *
 * 复用设计说明：
 * 1. 旧的境界/宗门/财富/竞技四类榜单和新增多维榜共享同一套缓存与去重逻辑，只在 loader 表里扩维，避免重复写第二份 Hook。
 * 2. 多维榜使用 `${domain}:${metric}` query key，后续如果再加新股市维度，只需要补 metadata 与 loader，不需要改状态结构。
 * 3. 缓存放在模块级，继续兼容 `destroyOnHidden` 场景，弹窗销毁后重新打开也不会重复请求刚加载过的数据。
 *
 * 关键边界条件与坑点：
 * 1. 多维榜与角色榜共用弹窗，但 loading 必须按 query key 独立管理，不能切换某个维度时把其他榜单也一起置为 loading。
 * 2. 这里只做短 TTL 缓存，避免榜单长时间停留旧值；TTL 到期后会自动重新请求。
 */
import { useEffect, useState } from 'react';
import {
  getArenaRanks,
  getPartnerRanks,
  getRealmRanks,
  getSectRanks,
  getStockMarketRanks,
  getWealthRanks,
  type ArenaRankRowDto,
  type PartnerRankMetricDto,
  type PartnerRankRowDto,
  type RealmRankRowDto,
  type SectRankRowDto,
  type StockMarketRankMetricDto,
  type StockMarketRankRowDto,
  type WealthRankRowDto,
} from '../../../../services/api';

export type RankTab = 'realm' | 'sect' | 'wealth' | 'arena' | 'partner' | 'stockMarket';
export type StandardRankTab = Exclude<RankTab, 'partner' | 'stockMarket'>;
export type PartnerRankMetric = PartnerRankMetricDto;
export type StockMarketRankMetric = StockMarketRankMetricDto;

export interface RankTabMeta {
  key: RankTab;
  label: string;
  shortLabel: string;
  subtitle: string;
}

export interface PartnerRankMetricMeta {
  key: PartnerRankMetric;
  label: string;
  subtitle: string;
}

export interface StockMarketRankMetricMeta {
  key: StockMarketRankMetric;
  label: string;
  subtitle: string;
}

export const RANK_TAB_META: RankTabMeta[] = [
  { key: 'realm', label: '境界排行榜', shortLabel: '境界', subtitle: '按境界与战力综合排序' },
  { key: 'sect', label: '宗门排行榜', shortLabel: '宗门', subtitle: '按宗门综合实力排序' },
  { key: 'wealth', label: '财富排行榜', shortLabel: '财富', subtitle: '按灵石与银两总量排序' },
  { key: 'arena', label: '竞技场排行榜', shortLabel: '竞技', subtitle: '按竞技场积分排序' },
  { key: 'partner', label: '伙伴排行榜', shortLabel: '伙伴', subtitle: '按伙伴主要培养维度查看排行' },
  { key: 'stockMarket', label: '股市排行榜', shortLabel: '股市', subtitle: '按玩家股市持仓与收益查看排行' },
];

export const RANK_TAB_KEYS: RankTab[] = RANK_TAB_META.map((item) => item.key);

export const RANK_TAB_META_MAP: Record<RankTab, RankTabMeta> = {
  realm: RANK_TAB_META[0],
  sect: RANK_TAB_META[1],
  wealth: RANK_TAB_META[2],
  arena: RANK_TAB_META[3],
  partner: RANK_TAB_META[4],
  stockMarket: RANK_TAB_META[5],
};

export const PARTNER_RANK_METRIC_META: PartnerRankMetricMeta[] = [
  { key: 'level', label: '等级', subtitle: '按伙伴实际等级排序，同等级再比较战力' },
  { key: 'power', label: '战力', subtitle: '按伙伴当前战力排序，同战力再比较等级' },
];

export const PARTNER_RANK_METRIC_KEYS: PartnerRankMetric[] =
  PARTNER_RANK_METRIC_META.map((item) => item.key);

export const PARTNER_RANK_METRIC_META_MAP: Record<PartnerRankMetric, PartnerRankMetricMeta> = {
  level: PARTNER_RANK_METRIC_META[0],
  power: PARTNER_RANK_METRIC_META[1],
};

export const STOCK_MARKET_RANK_METRIC_META: StockMarketRankMetricMeta[] = [
  { key: 'value', label: '市值', subtitle: '按当前股票持仓市值排序，同市值再比较总收益' },
  { key: 'profit', label: '收益', subtitle: '按股市总收益排序，包含浮动盈亏与已实现盈亏' },
];

export const STOCK_MARKET_RANK_METRIC_KEYS: StockMarketRankMetric[] =
  STOCK_MARKET_RANK_METRIC_META.map((item) => item.key);

export const STOCK_MARKET_RANK_METRIC_META_MAP: Record<StockMarketRankMetric, StockMarketRankMetricMeta> = {
  value: STOCK_MARKET_RANK_METRIC_META[0],
  profit: STOCK_MARKET_RANK_METRIC_META[1],
};

export type RankRowsByTab = {
  realm: RealmRankRowDto[];
  sect: SectRankRowDto[];
  wealth: WealthRankRowDto[];
  arena: ArenaRankRowDto[];
};

export type PartnerRankRowsByMetric = {
  level: PartnerRankRowDto[];
  power: PartnerRankRowDto[];
};

export type StockMarketRankRowsByMetric = {
  value: StockMarketRankRowDto[];
  profit: StockMarketRankRowDto[];
};

type LoadingByTab = Record<StandardRankTab, boolean>;
type PartnerLoadingByMetric = Record<PartnerRankMetric, boolean>;
type StockMarketLoadingByMetric = Record<StockMarketRankMetric, boolean>;

type PartnerRankQueryKey = `partner:${PartnerRankMetric}`;
type StockMarketRankQueryKey = `stockMarket:${StockMarketRankMetric}`;
type RankQueryKey = StandardRankTab | PartnerRankQueryKey | StockMarketRankQueryKey;

type RankQueryRowsMap = {
  realm: RealmRankRowDto[];
  sect: SectRankRowDto[];
  wealth: WealthRankRowDto[];
  arena: ArenaRankRowDto[];
  'partner:level': PartnerRankRowDto[];
  'partner:power': PartnerRankRowDto[];
  'stockMarket:value': StockMarketRankRowDto[];
  'stockMarket:profit': StockMarketRankRowDto[];
};

type RankCacheEntry<K extends RankQueryKey = RankQueryKey> = {
  rows: RankQueryRowsMap[K];
  expiresAt: number;
};

const RANK_CACHE_TTL_MS = 30_000;
const rankCache = new Map<RankQueryKey, RankCacheEntry>();
const inflightRequests = new Map<RankQueryKey, Promise<RankQueryRowsMap[RankQueryKey]>>();

const toPartnerRankQueryKey = (metric: PartnerRankMetric): PartnerRankQueryKey => `partner:${metric}`;
const toStockMarketRankQueryKey = (
  metric: StockMarketRankMetric,
): StockMarketRankQueryKey => `stockMarket:${metric}`;

const isPartnerRankQueryKey = (key: RankQueryKey): key is PartnerRankQueryKey => {
  return key.startsWith('partner:');
};

const isStockMarketRankQueryKey = (key: RankQueryKey): key is StockMarketRankQueryKey => {
  return key.startsWith('stockMarket:');
};

const getPartnerMetricFromQueryKey = (
  key: PartnerRankQueryKey,
): PartnerRankMetric => {
  return key === 'partner:level' ? 'level' : 'power';
};

const getStockMarketMetricFromQueryKey = (
  key: StockMarketRankQueryKey,
): StockMarketRankMetric => {
  return key === 'stockMarket:value' ? 'value' : 'profit';
};

const createEmptyRankRows = (): RankRowsByTab => ({
  realm: [],
  sect: [],
  wealth: [],
  arena: [],
});

const createEmptyPartnerRankRows = (): PartnerRankRowsByMetric => ({
  level: [],
  power: [],
});

const createEmptyStockMarketRankRows = (): StockMarketRankRowsByMetric => ({
  value: [],
  profit: [],
});

const createLoadingState = (): LoadingByTab => ({
  realm: false,
  sect: false,
  wealth: false,
  arena: false,
});

const createPartnerLoadingState = (): PartnerLoadingByMetric => ({
  level: false,
  power: false,
});

const createStockMarketLoadingState = (): StockMarketLoadingByMetric => ({
  value: false,
  profit: false,
});

const readCachedRows = <K extends RankQueryKey>(queryKey: K): RankQueryRowsMap[K] | null => {
  const cached = rankCache.get(queryKey) as RankCacheEntry<K> | undefined;
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    rankCache.delete(queryKey);
    return null;
  }
  return cached.rows;
};

const writeCachedRows = <K extends RankQueryKey>(
  queryKey: K,
  rows: RankQueryRowsMap[K],
): void => {
  rankCache.set(queryKey, {
    rows,
    expiresAt: Date.now() + RANK_CACHE_TTL_MS,
  });
};

const fetchRowsByQueryKey = async <K extends RankQueryKey>(
  queryKey: K,
): Promise<RankQueryRowsMap[K]> => {
  if (queryKey === 'realm') {
    const response = await getRealmRanks(50);
    return (response.data ?? []) as RankQueryRowsMap[K];
  }

  if (queryKey === 'sect') {
    const response = await getSectRanks(30);
    return (response.data ?? []) as RankQueryRowsMap[K];
  }

  if (queryKey === 'wealth') {
    const response = await getWealthRanks(50);
    return (response.data ?? []) as RankQueryRowsMap[K];
  }

  if (queryKey === 'arena') {
    const response = await getArenaRanks(50);
    return (response.data ?? []) as RankQueryRowsMap[K];
  }

  if (isStockMarketRankQueryKey(queryKey)) {
    const metric = getStockMarketMetricFromQueryKey(queryKey);
    const response = await getStockMarketRanks(metric, 50);
    return (response.data ?? []) as RankQueryRowsMap[K];
  }

  const metric = getPartnerMetricFromQueryKey(queryKey);
  const response = await getPartnerRanks(metric, 50);
  return (response.data ?? []) as RankQueryRowsMap[K];
};

const getRowsWithCache = async <K extends RankQueryKey>(
  queryKey: K,
): Promise<RankQueryRowsMap[K]> => {
  const cached = readCachedRows(queryKey);
  if (cached) return cached;

  const existingRequest = inflightRequests.get(queryKey);
  if (existingRequest) return existingRequest as Promise<RankQueryRowsMap[K]>;

  const request = fetchRowsByQueryKey(queryKey)
    .then((rows) => {
      writeCachedRows(queryKey, rows);
      return rows;
    })
    .finally(() => {
      inflightRequests.delete(queryKey);
    });

  inflightRequests.set(queryKey, request);
  return request as Promise<RankQueryRowsMap[K]>;
};

const readAllCachedStandardRows = (): RankRowsByTab => {
  const next = createEmptyRankRows();
  const realmRows = readCachedRows('realm');
  const sectRows = readCachedRows('sect');
  const wealthRows = readCachedRows('wealth');
  const arenaRows = readCachedRows('arena');

  if (realmRows) next.realm = realmRows;
  if (sectRows) next.sect = sectRows;
  if (wealthRows) next.wealth = wealthRows;
  if (arenaRows) next.arena = arenaRows;
  return next;
};

const readAllCachedPartnerRows = (): PartnerRankRowsByMetric => {
  const next = createEmptyPartnerRankRows();
  const levelRows = readCachedRows('partner:level');
  const powerRows = readCachedRows('partner:power');

  if (levelRows) next.level = levelRows;
  if (powerRows) next.power = powerRows;
  return next;
};

const readAllCachedStockMarketRows = (): StockMarketRankRowsByMetric => {
  const next = createEmptyStockMarketRankRows();
  const valueRows = readCachedRows('stockMarket:value');
  const profitRows = readCachedRows('stockMarket:profit');

  if (valueRows) next.value = valueRows;
  if (profitRows) next.profit = profitRows;
  return next;
};

export const useRankRows = (
  open: boolean,
  activeTab: RankTab,
  activePartnerMetric: PartnerRankMetric,
  activeStockMarketMetric: StockMarketRankMetric,
): {
  rankRowsByTab: RankRowsByTab;
  partnerRankRowsByMetric: PartnerRankRowsByMetric;
  stockMarketRankRowsByMetric: StockMarketRankRowsByMetric;
  loadingByTab: LoadingByTab;
  partnerLoadingByMetric: PartnerLoadingByMetric;
  stockMarketLoadingByMetric: StockMarketLoadingByMetric;
} => {
  const [rankRowsByTab, setRankRowsByTab] = useState<RankRowsByTab>(() => readAllCachedStandardRows());
  const [partnerRankRowsByMetric, setPartnerRankRowsByMetric] = useState<PartnerRankRowsByMetric>(() => readAllCachedPartnerRows());
  const [stockMarketRankRowsByMetric, setStockMarketRankRowsByMetric] =
    useState<StockMarketRankRowsByMetric>(() => readAllCachedStockMarketRows());
  const [loadingByTab, setLoadingByTab] = useState<LoadingByTab>(() => createLoadingState());
  const [partnerLoadingByMetric, setPartnerLoadingByMetric] = useState<PartnerLoadingByMetric>(() => createPartnerLoadingState());
  const [stockMarketLoadingByMetric, setStockMarketLoadingByMetric] =
    useState<StockMarketLoadingByMetric>(() => createStockMarketLoadingState());

  useEffect(() => {
    if (!open) return;

    setRankRowsByTab((prev) => ({
      ...prev,
      ...readAllCachedStandardRows(),
    }));
    setPartnerRankRowsByMetric((prev) => ({
      ...prev,
      ...readAllCachedPartnerRows(),
    }));
    setStockMarketRankRowsByMetric((prev) => ({
      ...prev,
      ...readAllCachedStockMarketRows(),
    }));

    const activeQueryKey: RankQueryKey = activeTab === 'partner'
      ? toPartnerRankQueryKey(activePartnerMetric)
      : activeTab === 'stockMarket'
      ? toStockMarketRankQueryKey(activeStockMarketMetric)
      : activeTab;

    const cachedRows = readCachedRows(activeQueryKey);
    if (cachedRows) {
      if (isPartnerRankQueryKey(activeQueryKey)) {
        const metric = getPartnerMetricFromQueryKey(activeQueryKey);
        setPartnerRankRowsByMetric((prev) => ({ ...prev, [metric]: cachedRows }));
        setPartnerLoadingByMetric((prev) => ({ ...prev, [metric]: false }));
      } else if (isStockMarketRankQueryKey(activeQueryKey)) {
        const metric = getStockMarketMetricFromQueryKey(activeQueryKey);
        setStockMarketRankRowsByMetric((prev) => ({ ...prev, [metric]: cachedRows }));
        setStockMarketLoadingByMetric((prev) => ({ ...prev, [metric]: false }));
      } else {
        setRankRowsByTab((prev) => ({ ...prev, [activeQueryKey]: cachedRows }));
        setLoadingByTab((prev) => ({ ...prev, [activeQueryKey]: false }));
      }
      return;
    }

    if (isPartnerRankQueryKey(activeQueryKey)) {
      const metric = getPartnerMetricFromQueryKey(activeQueryKey);
      setPartnerLoadingByMetric((prev) => ({ ...prev, [metric]: true }));
    } else if (isStockMarketRankQueryKey(activeQueryKey)) {
      const metric = getStockMarketMetricFromQueryKey(activeQueryKey);
      setStockMarketLoadingByMetric((prev) => ({ ...prev, [metric]: true }));
    } else {
      setLoadingByTab((prev) => ({ ...prev, [activeQueryKey]: true }));
    }

    let cancelled = false;
    void getRowsWithCache(activeQueryKey)
      .then((rows) => {
        if (cancelled) return;
        if (isPartnerRankQueryKey(activeQueryKey)) {
          const metric = getPartnerMetricFromQueryKey(activeQueryKey);
          setPartnerRankRowsByMetric((prev) => ({ ...prev, [metric]: rows }));
          return;
        }
        if (isStockMarketRankQueryKey(activeQueryKey)) {
          const metric = getStockMarketMetricFromQueryKey(activeQueryKey);
          setStockMarketRankRowsByMetric((prev) => ({ ...prev, [metric]: rows }));
          return;
        }
        setRankRowsByTab((prev) => ({ ...prev, [activeQueryKey]: rows }));
      })
      .catch(() => {
        if (cancelled) return;
        if (isPartnerRankQueryKey(activeQueryKey)) {
          const metric = getPartnerMetricFromQueryKey(activeQueryKey);
          setPartnerRankRowsByMetric((prev) => ({ ...prev, [metric]: [] }));
          return;
        }
        if (isStockMarketRankQueryKey(activeQueryKey)) {
          const metric = getStockMarketMetricFromQueryKey(activeQueryKey);
          setStockMarketRankRowsByMetric((prev) => ({ ...prev, [metric]: [] }));
          return;
        }
        setRankRowsByTab((prev) => ({ ...prev, [activeQueryKey]: [] }));
      })
      .finally(() => {
        if (cancelled) return;
        if (isPartnerRankQueryKey(activeQueryKey)) {
          const metric = getPartnerMetricFromQueryKey(activeQueryKey);
          setPartnerLoadingByMetric((prev) => ({ ...prev, [metric]: false }));
          return;
        }
        if (isStockMarketRankQueryKey(activeQueryKey)) {
          const metric = getStockMarketMetricFromQueryKey(activeQueryKey);
          setStockMarketLoadingByMetric((prev) => ({ ...prev, [metric]: false }));
          return;
        }
        setLoadingByTab((prev) => ({ ...prev, [activeQueryKey]: false }));
      });

    return () => {
      cancelled = true;
    };
  }, [activePartnerMetric, activeStockMarketMetric, activeTab, open]);

  return {
    rankRowsByTab,
    partnerRankRowsByMetric,
    stockMarketRankRowsByMetric,
    loadingByTab,
    partnerLoadingByMetric,
    stockMarketLoadingByMetric,
  };
};
