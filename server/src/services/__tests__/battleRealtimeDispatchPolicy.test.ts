/**
 * 战斗实时推送离线跳过策略测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：静态锁定 `battle_state` 在没有在线接收者时先跳过 payload 构建与 WS 派发。
 * 2. 做什么：锁定终态消息仍走原实时派发路径，避免结算语义被离线优化误伤。
 * 3. 不做什么：不启动 ticker、不 mock socket，也不验证具体战斗 payload 内容。
 *
 * 输入 / 输出：
 * - 输入：ticker.ts 源码文本。
 * - 输出：关键 helper、分支条件与日志字段必须存在。
 *
 * 数据流 / 状态流：
 * emitBattleUpdate -> 读取参与者 -> 复用 gameServer 检查在线接收者
 * -> battle_state 离线时丢弃实时日志增量并跳过 patchBattleUpdatePayload / emitToUser
 * -> started / finished / abandoned 继续原派发链路。
 *
 * 复用设计说明：
 * 1. 该测试把“哪些实时消息允许跳过”集中锁定，后续不用在多个行为测试里重复硬编码终态保护。
 * 2. `hasOnlineBattleUpdateRecipient` 作为 ticker 内部统一入口，避免不同分支重复扫描参与者在线状态。
 * 3. `outcome` 文案在这里统一锁定，便于慢日志和线上排查复用同一判定口径。
 *
 * 关键边界条件与坑点：
 * 1. 离线优化只能作用于过程态 `battle_state`，否则 `battle_finished` 会丢失结算后的实时通知语义。
 * 2. 跳过发生在 payload patch 前，才能避免离线战斗持续构建增量状态和日志数组。
 * 3. 跳过前必须清理实时日志增量，否则下一次在线帧会补发离线期间积压日志。
 */

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

const source = readFileSync(
  new URL("../battle/runtime/ticker.ts", import.meta.url),
  "utf8",
);

test("emitBattleUpdate 应通过统一 helper 判断是否存在在线接收者", () => {
  assert.match(source, /hasOnlineBattleUpdateRecipient/u);
  assert.match(source, /gameServer\.isUserOnline\(userId\)/u);
});

test("离线跳过只允许作用于 battle_state，且必须发生在 payload patch 前", () => {
  assert.match(source, /kind\s*===\s*"battle_state"/u);
  assert.match(source, /outcome:\s*"no_online_recipient"/u);
  assert.match(source, /queueBattleRedisSaveIfNeeded/u);
  assert.match(source, /discardBattleLogDelta\(battleId\)/u);
  assert.match(source, /battleLogDiscarded:\s*discardedLogCount/u);
  assert.match(source, /patchBattleUpdatePayload/u);
  assert.match(
    source,
    /discardBattleLogDelta\(battleId\)[\s\S]*no_online_recipient[\s\S]*return;[\s\S]*patchBattleUpdatePayload/u,
  );
});

test("慢日志 Redis 保存字段应使用明确语义，禁止 persisted 模糊字段", () => {
  assert.match(source, /redisPersistEligible:\s*redisSave\.shouldPersist/u);
  assert.match(source, /redisSaveQueued:\s*redisSave\.queued/u);
  assert.doesNotMatch(source, /\bpersisted\s*:/u);
});

test("离线跳过不得作用于战斗终态实时消息", () => {
  assert.match(source, /kind\s*!==\s*"battle_finished"/u);
  assert.match(source, /kind\s*!==\s*"battle_abandoned"/u);
});
