/**
 * 地图资源采集限流策略测试
 *
 * 作用：锁定资源采集在进入 DB 行锁前先走角色级短限流。
 * 输入/输出：输入为 roomObjectService.ts 源码文本，输出为策略断言。
 * 数据流：请求参数 -> 房间/资源合法性确认 -> acquireCharacterMutationThrottle -> DB 行锁和奖励写入。
 * 复用设计说明：限流 helper 是角色突变类接口的统一入口，本测试先锁定 gather 热路径复用它。
 * 关键边界条件与坑点：
 * 1. 限流必须在 `lockCharacterInventoryMutex` 之前，否则无法削减锁竞争。
 * 2. 限流不能放在参数校验之前，避免无效请求污染合法操作窗口。
 */
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../roomObjectService.ts', import.meta.url), 'utf8');

test('gatherRoomResourceImpl 应在背包锁前执行角色级采集限流', () => {
  const throttleIndex = source.indexOf('acquireCharacterMutationThrottle');
  const lockIndex = source.indexOf('lockCharacterInventoryMutex(characterId)');
  assert.notEqual(throttleIndex, -1);
  assert.notEqual(lockIndex, -1);
  assert.ok(throttleIndex < lockIndex);
  assert.match(source, /scope:\s*'map-resource-gather'/u);
});
