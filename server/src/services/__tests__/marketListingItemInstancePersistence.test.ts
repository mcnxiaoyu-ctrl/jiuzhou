/**
 * 坊市 item_instance 强一致落库回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定坊市上架/下架/购买都复用共享“立即应用实例 mutation”入口，避免再回退成“邮件已发出但实例仍停留在缓冲层”的弱一致写法。
 * 2. 做什么：锁定挂单创建仍然在写入 `market_listing` 前完成实例真实落库，保证挂单引用的 `item_instance` 已可被数据库查询命中。
 * 3. 做什么：锁定下架返邮与成交发邮都先完成实例落库，再写业务记录/发送邮件，避免继续制造“附件异常”邮件。
 * 4. 做什么：锁定坊市并发协议，避免回退成“cancel 先锁 listing、buy 先锁背包”的锁顺序反转，以及事务提交前提前失效列表缓存。
 * 5. 不做什么：不执行真实坊市交易，不校验 Redis flush 循环；这里只约束源码中的关键时序与复用入口。
 *
 * 输入 / 输出：
 * - 输入：`marketService` 与 `characterItemInstanceMutationService` 的源码文本。
 * - 输出：共享立即落库 helper 的导出，以及坊市关键写路径先落实例、再写业务记录、再在提交后失效缓存的断言结果。
 *
 * 数据流 / 状态流：
 * - 读取共享 mutation 服务源码，确认立即落库 helper 存在；
 * - 再读取坊市服务源码，确认挂单、下架、购买都在关键业务写入前调用该 helper；
 * - 同时锁定坊市写链路统一遵循“先背包锁，后 listing 行锁”和“提交后再失效缓存”。
 *
 * 复用设计说明：
 * - 把立即落库能力与列表失效时机都集中在共享入口/单一 helper 上，避免坊市服务各个写方法重复维护并发协议。
 * - 本测试同时约束“共享 helper 存在”“坊市链路确实复用 helper”和“缓存失效只能提交后触发”，防止后续回退。
 *
 * 关键边界条件与坑点：
 * 1. 这里只锁定“先真实落库、再写业务记录/发邮件”和“统一锁顺序/缓存时机”的关键结构，避免回归到旧实现。
 * 2. 这里只验证源码结构，不覆盖数据库运行时行为；运行时正确性仍需依赖构建与后续集成验证。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readSource = (relativePath: string): string => {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
};

test("marketService 应把坊市实例迁移统一收敛到立即落库入口", () => {
  const marketSource = readSource("../marketService.ts");
  const mutationSource = readSource("../shared/characterItemInstanceMutationService.ts");

  assert.match(
    mutationSource,
    /export const applyCharacterItemInstanceMutationsImmediately = async/u,
  );
  assert.match(
    marketSource,
    /await applyCharacterItemInstanceMutationsImmediately\(\[[\s\S]*?INSERT INTO market_listing/iu,
  );
  assert.match(
    marketSource,
    /await lockCharacterInventoryMutex\(params\.characterId\);[\s\S]*?await applyCharacterItemInstanceMutationsImmediately\(\[/u,
  );
  assert.match(
    marketSource,
    /await lockCharacterInventoryMutex\(params\.characterId\);[\s\S]*?WHERE id = \$1[\s\S]*?FOR UPDATE/u,
  );
  assert.match(
    marketSource,
    /await lockCharacterInventoryMutexes\(\[[\s\S]*?params\.buyerCharacterId[\s\S]*?sellerCharacterIdFromMeta[\s\S]*?\]\);[\s\S]*?WHERE ml\.id = \$1[\s\S]*?FOR UPDATE/u,
  );
  assert.match(
    marketSource,
    /await applyCharacterItemInstanceMutationsImmediately\(\[[\s\S]*?UPDATE market_listing[\s\S]*?await mailService\.sendMail\(\{/u,
  );
  assert.match(
    marketSource,
    /await applyCharacterItemInstanceMutationsImmediately\(\[[\s\S]*?INSERT INTO market_trade_record[\s\S]*?await mailService\.sendMail\(\{/u,
  );
  assert.doesNotMatch(
    marketSource,
    /bufferCharacterItemInstanceMutations/u,
  );
  assert.match(
    marketSource,
    /const invalidateMarketListingsCache = async \(\): Promise<void> => \{[\s\S]*?await afterTransactionCommit\(async \(\) => \{[\s\S]*?await invalidateMarketListingsCacheNow\(\);[\s\S]*?\}\);[\s\S]*?\};/u,
  );
});
