/**
 * 战斗 Redis 快照 pipeline 策略测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：静态锁定战斗快照三段 Redis 写入必须使用单 pipeline。
 * 2. 做什么：禁止重新退回三个 `redis.setex` 后 `Promise.all(tasks)` 的多往返写法。
 * 3. 不做什么：不连接 Redis、不验证 TTL 具体值，也不执行真实持久化。
 *
 * 输入 / 输出：
 * - 输入：persistence.ts 源码文本。
 * - 输出：pipeline 创建、setex 入队、exec 校验与旧批量写法禁用断言。
 *
 * 数据流 / 状态流：
 * persistBattleSnapshotToRedis -> 构建 dynamic / participants / static JSON
 * -> redis.pipeline() -> pipeline.setex 三段 key -> await pipeline.exec()
 * -> 校验 pipeline 结果后记录慢日志。
 *
 * 复用设计说明：
 * 1. 该测试作为 Redis 快照写入策略的单一守卫，避免后续优化或重构在不同测试里重复判断写入形态。
 * 2. pipeline 把三段 key 的 TTL 与值写入集中到同一次 Redis 往返，减少战斗 tick 热路径的后台 IO 压力。
 * 3. 禁用 `Promise.all(tasks)` 能避免维护者误以为并发 Promise 等同于单次 Redis pipeline。
 *
 * 关键边界条件与坑点：
 * 1. pipeline.exec 返回结果数量不等于三段写入时必须视为失败，否则快照可能静默丢失。
 * 2. 每个 pipeline 子结果都要检查 error，否则单个 key 写入失败会被整体流程误判为成功。
 */

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

const source = readFileSync(
  new URL("../battle/runtime/persistence.ts", import.meta.url),
  "utf8",
);

test("persistBattleSnapshotToRedis 应使用 Redis pipeline 写入三段快照", () => {
  assert.match(source, /const\s+pipeline\s*=\s*redis\.pipeline\(\)/u);
  assert.match(source, /pipeline\.setex/u);
  assert.match(source, /await\s+pipeline\.exec\(\)/u);
  assert.match(source, /results\.length\s*!==\s*3/u);
});

test("persistBattleSnapshotToRedis 不得继续使用 Promise.all(tasks) 批量 redis.setex", () => {
  assert.doesNotMatch(source, /Promise\.all\(tasks\)/u);
});
