/**
 * 坊市公开列表 pageSize 策略测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定物品坊市和伙伴坊市公开列表最大 pageSize 为 40。
 * 2. 做什么：避免单响应携带 100 条装备/伙伴详情导致 JSON 序列化占满事件循环。
 * 3. 不做什么：不验证 SQL 查询结果，不连接数据库。
 *
 * 输入 / 输出：
 * - 输入：marketService.ts 和 partnerMarketService.ts 源码文本。
 * - 输出：静态断言。
 *
 * 数据流 / 状态流：
 * route query pageSize -> service normalize query -> clamp 到公开列表上限 -> cache key。
 *
 * 复用设计说明：
 * - 将上限作为模块级常量，避免 normalize 和测试各写魔法数字。
 *
 * 关键边界条件与坑点：
 * 1. 只限制公开列表，不影响 my-listings 和 records 的内部管理页。
 * 2. cache key 必须使用 clamp 后的 pageSize，避免同一页产生多个缓存 key。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('物品坊市公开列表 pageSize 最大值应为 40', () => {
  const source = readFileSync(new URL('../marketService.ts', import.meta.url), 'utf8');
  assert.match(source, /const MARKET_PUBLIC_LISTINGS_PAGE_SIZE_MAX = 40;/u);
  assert.match(
    source,
    /pageSize: clampInt\(parsePositiveInt\(params\.pageSize\) \?\? 20, 1, MARKET_PUBLIC_LISTINGS_PAGE_SIZE_MAX\)/u,
  );
});

test('伙伴坊市公开列表 pageSize 最大值应为 40', () => {
  const source = readFileSync(new URL('../partnerMarketService.ts', import.meta.url), 'utf8');
  assert.match(source, /const PARTNER_MARKET_PUBLIC_LISTINGS_PAGE_SIZE_MAX = 40;/u);
  assert.match(
    source,
    /pageSize: clampInt\(parsePositiveInt\(params\.pageSize\) \?\? 20, 1, PARTNER_MARKET_PUBLIC_LISTINGS_PAGE_SIZE_MAX\)/u,
  );
});
