/**
 * 战斗恢复 Redis 扫描策略测试
 *
 * 作用：锁定战斗恢复不能再使用 Redis KEYS，必须使用 SCAN 游标扫描。
 * 输入/输出：输入为 lifecycle.ts 源码文本，输出为策略断言。
 * 数据流：启动恢复 -> recoverBattlesFromRedis -> Redis 游标扫描 -> 逐场恢复。
 * 复用设计说明：该测试作为启动热路径的单一策略入口，后续不需要在部署脚本里重复检查。
 * 关键边界条件与坑点：
 * 1. `KEYS battle:state:*` 会阻塞 Redis 主线程，在线上 keyspace 变大时直接放大接口尾延迟。
 * 2. `SCAN` 必须携带 MATCH 前缀，否则会把无关 key 带回应用层过滤。
 */
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../battle/lifecycle.ts', import.meta.url), 'utf8');

test('recoverBattlesFromRedis 应使用 SCAN，禁止 Redis KEYS', () => {
  assert.doesNotMatch(source, /\.keys\(/u);
  assert.match(source, /\.scan\(/u);
  assert.match(source, /MATCH/u);
  assert.match(source, /REDIS_BATTLE_KEY_PREFIX/u);
});
