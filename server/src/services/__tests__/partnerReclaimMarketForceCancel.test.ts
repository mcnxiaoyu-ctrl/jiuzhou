/**
 * 伙伴回收强制下架测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定伙伴回收脚本对坊市 active 挂单的处理口径，确保执行前会先强制下架并退回手续费，而不是继续阻塞回收。
 * 2. 做什么：让脚本与坊市服务共用同一份挂单取消实现，避免 SQL、退款与缓存失效逻辑再次分叉。
 * 3. 不做什么：不连接数据库、不执行脚本，也不验证真实邮件发放结果。
 *
 * 输入/输出：
 * - 输入：回收脚本源码文本与共享坊市挂单生命周期模块源码文本。
 * - 输出：对阻塞规则、执行顺序与取消挂单关键 SQL 的静态断言结果。
 *
 * 数据流/状态流：
 * 测试读取源码 -> 匹配关键函数与 SQL 片段 -> 断言“强制下架后回收”的约束保持稳定。
 *
 * 复用设计说明：
 * - 这里直接锁定共享生命周期模块与回收脚本之间的调用关系，避免后续有人在脚本里重新内联一套取消挂单逻辑。
 * - 取消挂单 SQL、手续费退回、脚本调用顺序都通过单一测试入口收口，减少多处重复维护断言。
 *
 * 关键边界条件与坑点：
 * 1. 坊市挂单只是不再阻塞回收，不代表可以跳过挂单状态更新；否则会残留 active 脏挂单。
 * 2. 强制下架必须发生在删除伙伴之前，否则购买链路仍可能读到已删除伙伴对应的 active listing。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const readSource = (relativePath: string): string => {
    return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
};

test('buildBlockedReasons: 不应再把坊市挂单视为回收阻塞条件', () => {
    const source = readSource('src/scripts/reclaimPartnersByBaseModel.ts');

    assert.match(source, /const buildBlockedReasons = \(row: TargetPartnerRow\): string\[\] => \{/u);
    assert.doesNotMatch(source, /坊市挂单中/u);
    assert.match(source, /三魂归契占用中/u);
});

test('executeReclaim: 删除伙伴前应先调用共享强制下架入口', () => {
    const source = readSource('src/scripts/reclaimPartnersByBaseModel.ts');

    assert.match(source, /cancelActivePartnerMarketListing/u);
    assert.match(
        source,
        /if \(lockedRow\.active_market_listing_id !== null\) \{\s+await cancelActivePartnerMarketListing\([\s\S]*?listingId: lockedRow\.active_market_listing_id[\s\S]*?\);\s+\}[\s\S]*?DELETE FROM character_partner/u,
    );
});

test('cancelActivePartnerMarketListing: 应取消挂单并退回手续费', () => {
    const source = readSource('src/services/shared/partnerMarketListingLifecycle.ts');

    assert.match(source, /UPDATE market_partner_listing[\s\S]*?SET status = 'cancelled'/u);
    assert.match(source, /cancelled_at = NOW\(\)/u);
    assert.match(source, /const refundFeeSilver = BigInt\(listing\.listing_fee_silver \?\? 0\)/u);
    assert.match(source, /addCharacterCurrenciesExact\(listing\.seller_character_id, \{\s+silver: refundFeeSilver/u);
    assert.match(source, /await invalidatePartnerMarketListingsCache\(\)/u);
});
