/**
 * inventory/use 成功响应策略回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定 `/inventory/use` 成功后先发送 HTTP 响应，再异步调度角色刷新推送。
 * 2. 做什么：防止 Socket 推送或角色刷新耗时进入当前用户请求总耗时。
 * 3. 不做什么：不验证具体道具效果，不启动 Express，不连接数据库。
 *
 * 输入 / 输出：
 * - 输入：inventoryRoutes.ts 源码文本。
 * - 输出：成功路径响应与补推调度的静态顺序断言。
 *
 * 数据流 / 状态流：
 * itemService.useItem -> responseData -> sendSuccess HTTP 响应 -> scheduleSafeCharacterUpdate 异步补推。
 *
 * 复用设计说明：
 * - 异步补推统一收敛到 middleware/pushUpdate，后续其他“响应已带快照、Socket 只做多端同步”的接口可复用同一入口。
 * - 本测试锁住路由层策略，避免后续维护时把成功路径重新改回同步等待。
 *
 * 关键边界条件与坑点：
 * 1. `partnerReboneJob` 投递失败分支仍需同步回滚和同步推送，不能被本策略异步化。
 * 2. 成功响应已携带 `character`、`lootResults`、`partnerTechniqueResult`，Socket 推送只是补偿同步，不应阻塞当前响应。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../../routes/inventoryRoutes.ts', import.meta.url), 'utf8');

const findBlockEndByOpeningBrace = (sourceText: string, openingBraceIndex: number): number => {
  let depth = 0;
  for (let index = openingBraceIndex; index < sourceText.length; index += 1) {
    const char = sourceText[index];
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char !== '}') continue;

    depth -= 1;
    if (depth === 0) return index + 1;
  }
  return -1;
};

test('inventory/use 成功路径应先响应再调度角色刷新', () => {
  const routeStart = source.indexOf("router.post('/use'");
  assert.notEqual(routeStart, -1, '缺少 /inventory/use 路由');

  const nextRouteStart = source.indexOf("router.post('/equip'", routeStart);
  assert.notEqual(nextRouteStart, -1, '缺少 /inventory/use 后续路由边界');
  const routeSource = source.slice(routeStart, nextRouteStart);

  const partnerReboneJobBranchStart = routeSource.indexOf('if (result.partnerReboneJob) {');
  assert.notEqual(partnerReboneJobBranchStart, -1, '缺少 partnerReboneJob 分支');
  const partnerReboneJobOpeningBrace = routeSource.indexOf('{', partnerReboneJobBranchStart);
  assert.notEqual(partnerReboneJobOpeningBrace, -1, 'partnerReboneJob 分支缺少起始大括号');
  const partnerReboneJobBlockEnd = findBlockEndByOpeningBrace(routeSource, partnerReboneJobOpeningBrace);
  assert.ok(partnerReboneJobBlockEnd > 0, '无法定位 partnerReboneJob 分支结束位置');

  const successTailSource = routeSource.slice(partnerReboneJobBlockEnd);

  const sendSuccessIndex = successTailSource.indexOf('sendSuccess(res, responseData)');
  const scheduleIndex = successTailSource.indexOf('scheduleSafeCharacterUpdate(userId);');
  const beforeSuccessSource = successTailSource.slice(0, sendSuccessIndex);

  assert.ok(sendSuccessIndex > 0, '成功路径必须发送响应');
  assert.ok(scheduleIndex > sendSuccessIndex, '角色刷新必须在成功响应之后调度');
  assert.doesNotMatch(beforeSuccessSource, /safePushCharacterUpdate\(userId\)/u);
});
