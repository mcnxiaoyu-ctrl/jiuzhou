/**
 * 坊市列表载荷策略静态测试
 *
 * 作用：
 * 1. 约束库存上架候选与公开伙伴坊市列表只走轻量 DTO。
 * 2. 不做运行时数据库断言，只检查关键路由、服务与 DTO 边界是否存在。
 *
 * 输入 / 输出：
 * - 输入：相关路由与服务源码文本。
 * - 输出：node:test 断言结果。
 *
 * 数据流 / 状态流：
 * 源码文件 -> 静态正则与片段提取 -> 载荷策略断言。
 *
 * 复用设计说明：
 * - 将“列表接口不能返回大详情”的策略集中在单一测试文件，避免库存与伙伴坊市各写一套易漂移断言。
 * - 后续列表瘦身策略扩展时，只需在这里追加对应源码边界断言。
 *
 * 关键边界条件与坑点：
 * 1. 这里只做静态策略保护，不能替代接口响应快照或性能压测。
 * 2. 类型块提取依赖接口声明命名稳定，重命名 DTO 时必须同步更新断言。
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const readSource = (relativePath: string): string =>
  readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('库存上架候选使用 sale-candidates 轻量路由且不走富化列表', () => {
  const inventoryRoutesSource = readSource('../../routes/inventoryRoutes.ts');
  const itemQuerySource = readSource('../inventory/itemQuery.ts');
  const saleCandidatesRouteMatch = inventoryRoutesSource.match(
    /router\.get\('\/sale-candidates'[\s\S]*?\}\)\);/u,
  );

  assert.ok(saleCandidatesRouteMatch, '缺少 /inventory/sale-candidates 路由');
  assert.ok(
    !saleCandidatesRouteMatch[0]!.includes('getInventoryItemsWithDefs'),
    '/inventory/sale-candidates 不应调用 getInventoryItemsWithDefs',
  );
  assert.match(itemQuerySource, /export type InventorySaleCandidateDto/u);
  assert.match(itemQuerySource, /export const getInventorySaleCandidates = async/u);
});

test('公开物品列表返回 summary 且完整详情按需读取', () => {
  const marketServiceSource = readSource('../marketService.ts');
  const marketRoutesSource = readSource('../../routes/marketRoutes.ts');
  const publicListSqlMatch = marketServiceSource.match(
    /const listSql = `[\s\S]*?`;/u,
  );
  const listingDetailRouteMatch = marketRoutesSource.match(
    /router\.get\('\/listing-detail'[\s\S]*?\n\}\)\);/u,
  );

  assert.ok(publicListSqlMatch, '缺少公开物品列表 SQL');
  assert.ok(listingDetailRouteMatch, '缺少物品挂单详情路由');
  assert.match(marketServiceSource, /export type MarketListingSummaryDto/u);
  assert.match(
    marketServiceSource,
    /data\?: \{ listings: MarketListingSummaryDto\[\]; total: number \}/u,
  );
  assert.doesNotMatch(
    publicListSqlMatch[0]!,
    /ii\.socketed_gems|ii\.affixes|ii\.metadata/u,
    '公开物品列表不应读取宝石、词条或 metadata 详情字段',
  );
  assert.match(
    marketServiceSource,
    /async getMarketListingDetail/u,
    '缺少物品挂单详情服务方法',
  );
  assert.match(
    listingDetailRouteMatch[0]!,
    /marketListingDetailQpsLimit[\s\S]*?getMarketListingDetail/u,
    '物品挂单详情路由必须接入独立限流并调用详情服务',
  );
  assert.match(
    listingDetailRouteMatch[0]!,
    /characterId[\s\S]*listingId/u,
    '物品挂单详情路由必须传入 characterId 与 listingId',
  );
});

test('公开伙伴列表返回 summary 且完整详情按需读取', () => {
  const partnerMarketServiceSource = readSource('../partnerMarketService.ts');
  const marketRoutesSource = readSource('../../routes/marketRoutes.ts');
  const summaryTypeMatch = partnerMarketServiceSource.match(
    /export interface MarketPartnerListingSummaryDto[\s\S]*?\nexport interface MarketPartnerTradeRecordDto/u,
  );
  const publicListSqlMatch = partnerMarketServiceSource.match(
    /const listSql = `[\s\S]*?`;/u,
  );
  const summaryBuilderMatch = partnerMarketServiceSource.match(
    /const buildPartnerListingSummaryDto = \([\s\S]*?\n\};/u,
  );
  const listingDetailRouteMatch = marketRoutesSource.match(
    /router\.get\('\/partner-listing-detail'[\s\S]*?\n\}\)\);/u,
  );

  assert.ok(summaryTypeMatch, '缺少 MarketPartnerListingSummaryDto');
  assert.ok(publicListSqlMatch, '缺少公开伙伴列表 SQL');
  assert.ok(summaryBuilderMatch, '缺少公开伙伴列表 summary 构建器');
  assert.ok(listingDetailRouteMatch, '缺少伙伴挂单详情路由');
  assert.ok(
    !/techniques|growth|computedAttrs|levelAttrGains/u.test(summaryTypeMatch[0]!),
    'MarketPartnerListingSummaryDto 不应包含功法、成长或计算属性等详情大字段',
  );
  assert.doesNotMatch(
    publicListSqlMatch[0]!,
    /^\s*mpl\.partner_snapshot\s*,/mu,
    '公开伙伴列表不应读取完整 partner_snapshot',
  );
  assert.match(
    publicListSqlMatch[0]!,
    /mpl\.partner_snapshot ->> 'avatar'/u,
    '公开伙伴列表只应读取 summary 必需的 JSON 标量字段',
  );
  assert.doesNotMatch(
    summaryBuilderMatch[0]!,
    /readPartnerSnapshot|getPartnerDefinitionById/u,
    '公开伙伴列表 summary 构建器不应反向加载完整快照或静态定义',
  );
  assert.match(partnerMarketServiceSource, /buildPartnerListingSummaryDto/u);
  assert.match(
    partnerMarketServiceSource,
    /data\?: \{ listings: MarketPartnerListingSummaryDto\[\]; total: number \}/u,
  );
  assert.match(
    partnerMarketServiceSource,
    /async getPartnerListingDetail/u,
    '缺少伙伴挂单详情服务方法',
  );
  assert.match(
    listingDetailRouteMatch[0]!,
    /partnerMarketListingDetailQpsLimit[\s\S]*?getPartnerListingDetail/u,
    '伙伴挂单详情路由必须接入独立限流并调用详情服务',
  );
  assert.match(
    listingDetailRouteMatch[0]!,
    /characterId[\s\S]*listingId/u,
    '伙伴挂单详情路由必须传入 characterId 与 listingId',
  );
});
