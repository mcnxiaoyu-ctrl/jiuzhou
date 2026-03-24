/**
 * 月卡货币流共享入口回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定旧的月卡直购入口已经删除，避免前后端再次恢复已下线的购买链路。
 * 2. 做什么：锁定月卡领取继续复用共享 `bigint` 加钱入口，并通过共享入口返回剩余余额。
 * 3. 不做什么：不执行真实月卡领取流程，不校验 ownership、日期计算与缓存刷新。
 *
 * 输入/输出：
 * - 输入：monthCardService 源码文本。
 * - 输出：共享入口引用与禁用旧 SQL 片段的断言结果。
 *
 * 数据流/状态流：
 * 读取源码 -> 检查服务端月卡购买方法和路由是否删除
 * -> 检查前端旧购买导出是否删除
 * -> 检查领取链路启用了 `addCharacterCurrenciesExact(..., { includeRemaining: true })`。
 *
 * 关键边界条件与坑点：
 * 1. 必须同时锁定前端导出、后端路由、服务方法三处删除，避免只删一半留下死接口。
 * 2. 这里只约束购买入口删除与领取加钱协议，不约束月卡 ownership 的 `FOR UPDATE` 与日期推进逻辑，避免把测试绑到无关细节。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readSource = (relativePath: string): string => {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
};

test('月卡直购入口应已删除，领取仍复用共享 bigint 加钱入口', () => {
  const serviceSource = readSource('../monthCardService.ts');
  const routeSource = readSource('../../routes/monthCardRoutes.ts');
  const clientSource = readSource('../../../../client/src/services/api/welfare.ts');

  const removedServiceMethodPattern = new RegExp(String.raw`async buy` + String.raw`MonthCard\s*\(`, 'u');
  const removedClientExportPattern = new RegExp(String.raw`export const buy` + String.raw`MonthCard\s*=`, 'u');

  assert.doesNotMatch(serviceSource, removedServiceMethodPattern);
  assert.doesNotMatch(routeSource, /router\.post\('\/buy'/u);
  assert.doesNotMatch(clientSource, removedClientExportPattern);
  assert.match(
    serviceSource,
    /addCharacterCurrenciesExact\(characterId,\s*\{[\s\S]*spiritStones:\s*BigInt\(reward\)[\s\S]*\},\s*\{\s*includeRemaining:\s*true\s*\}\)/u,
  );
});
