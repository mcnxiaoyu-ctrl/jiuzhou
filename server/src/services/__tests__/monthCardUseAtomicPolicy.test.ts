/**
 * 月卡续期原子推进协议回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定 `useMonthCardItem` 必须复用单一 UPSERT helper 推进 ownership，避免回退成 `FOR UPDATE` 预读再分支更新。
 * 2. 做什么：锁定“首次激活”和“已激活续期”都走同一条 SQL，避免激活/续期逻辑再次散落在业务方法里。
 * 3. 不做什么：不执行真实月卡道具消耗，不校验成就推进、缓存失效或推送。
 *
 * 输入/输出：
 * - 输入：monthCardService 源码文本。
 * - 输出：原子 helper、入口复用与禁用旧锁查询的断言结果。
 *
 * 数据流/状态流：
 * 读取源码 -> 检查 `extendMonthCardOwnershipTx` 的 `INSERT ... ON CONFLICT` 结构
 * -> 检查 `useMonthCardItem` 复用该 helper
 * -> 断言旧的 ownership `FOR UPDATE` 查询与分支更新已移除。
 *
 * 复用设计说明：
 * 1. 续期 SQL 是月卡 ownership 的高频变化点，集中到 helper 后，后续若新增礼包激活、补偿续期等入口都能复用同一协议。
 * 2. 把“首次插入”和“已存在续期”合并到同一入口，可以避免业务方法里重复维护时间推进规则。
 *
 * 关键边界条件与坑点：
 * 1. helper 必须同时覆盖“已过期重置 start_at”和“未过期累加 expire_at”，否则续期时长会错。
 * 2. 必须同时锁定 helper 复用与旧 SQL 消失，否则后续有人可能保留 helper 但又把分支更新加回来。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('useMonthCardItem 应复用原子 UPSERT helper 并移除 ownership FOR UPDATE', () => {
  const source = readFileSync(new URL('../monthCardService.ts', import.meta.url), 'utf8');

  assert.match(source, /const extendMonthCardOwnershipTx = async/u);
  assert.match(source, /INSERT INTO month_card_ownership \(character_id, month_card_id, start_at, expire_at\)/u);
  assert.match(source, /ON CONFLICT \(character_id, month_card_id\) DO UPDATE SET/u);
  assert.match(source, /month_card_ownership\.expire_at \+ \(\$3::integer \* INTERVAL '1 day'\)/u);
  assert.match(source, /const nextExpireAt = await extendMonthCardOwnershipTx\(characterId,\s*monthCardId,\s*durationDays\)/u);

  assert.doesNotMatch(
    source,
    /SELECT id, start_at, expire_at[\s\S]*FROM month_card_ownership[\s\S]*FOR UPDATE/u,
  );
  assert.doesNotMatch(
    source,
    /UPDATE month_card_ownership SET start_at = NOW\(\), expire_at = \$1, updated_at = NOW\(\) WHERE id = \$2/u,
  );
  assert.doesNotMatch(
    source,
    /UPDATE month_card_ownership SET expire_at = \$1, updated_at = NOW\(\) WHERE id = \$2/u,
  );
});
