/**
 * 坊市伙伴功法详情共享协议
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中定义坊市伙伴功法详情的数据来源类型，以及详情缓存键生成规则。
 * 2. 做什么：把“自有伙伴预览”和“坊市挂单预览”两条详情请求链路收敛成显式联合类型，避免调用方传模糊参数。
 * 3. 不做什么：不发起请求、不管理 React 状态，也不承载任何 UI。
 *
 * 输入 / 输出：
 * - 输入：详情来源对象、`techniqueId`。
 * - 输出：稳定的来源标识或缓存键字符串。
 *
 * 数据流 / 状态流：
 * 市场各类伙伴详情调用方 -> 本模块声明来源 -> `MarketPartnerTechniqueList` 按来源拉取详情。
 *
 * 复用设计说明：
 * 1. 详情来源至少被购买详情、移动端预览、待上架预览三处复用，抽出后可以避免多个组件自行约定 `listingId / partnerId` 组合字段。
 * 2. 缓存键也统一在这里生成，后续若补充更多入口，不会再次出现不同组件各自拼接键名导致缓存失效的问题。
 * 3. 高变化点是详情来源类型，而不是请求参数结构，因此把联合类型放在共享模块更利于集中维护。
 *
 * 关键边界条件与坑点：
 * 1. `listing` 与 `partner` 两种来源必须保持互斥，禁止同时存在两个 ID，否则缓存与请求路由都会变得不可预测。
 * 2. 缓存键必须包含来源种类，不能只用数值 ID；不同表的同号 `listingId / partnerId` 否则会相互污染。
 */
export type MarketPartnerTechniqueDetailSource =
  | {
    kind: 'listing';
    listingId: number;
  }
  | {
    kind: 'partner';
    partnerId: number;
  };

export const buildMarketPartnerTechniqueDetailSourceKey = (
  source: MarketPartnerTechniqueDetailSource,
): string => {
  return source.kind === 'listing'
    ? `listing:${source.listingId}`
    : `partner:${source.partnerId}`;
};

export const buildMarketPartnerTechniqueDetailCacheKey = (
  source: MarketPartnerTechniqueDetailSource,
  techniqueId: string,
): string => {
  return `${buildMarketPartnerTechniqueDetailSourceKey(source)}:${techniqueId}`;
};
