/**
 * BattleArea 结束后自动推进策略回归测试。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中锁定“战斗结束后该走 onNext、该等待上下文补齐，还是该走本地自动重开”的判定规则。
 * 2. 做什么：覆盖“秘境外部 battleId 已存在，但 onNext 稍后才注入”的竞态，避免 BattleArea 把秘境误判成普通地图连战。
 * 3. 不做什么：不挂载 React 组件、不请求接口，也不验证具体定时器时长。
 *
 * 输入/输出：
 * - 输入：`externalBattleId`、`hasOnNext`。
 * - 输出：`resolveFinishedBattleAdvanceMode` 返回的推进模式。
 *
 * 数据流/状态流：
 * - BattleArea finished state -> 自动推进策略判定 -> 决定等待 `onNext` / 调用 `onNext` / 本地自动重开。
 *
 * 关键边界条件与坑点：
 * 1. 只要当前战斗仍是外部上下文（如秘境 battleId），就算 `onNext` 还没准备好，也必须等待，不能回退成普通地图自动开战。
 * 2. 只有“无外部 battleId 且无 onNext”的普通地图连战场景，才允许走本地自动重开。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveFinishedBattleAdvanceMode } from '../BattleArea/autoNextPolicy.js';

test('外部战斗上下文已存在但 onNext 尚未注入时，应继续等待而不是回退到本地自动重开', () => {
  assert.equal(
    resolveFinishedBattleAdvanceMode({
      externalBattleId: 'dungeon-battle-1001-2',
      hasOnNext: false,
    }),
    'wait_on_next',
  );
});

test('外部战斗上下文且 onNext 已可用时，应走 onNext 推进下一波', () => {
  assert.equal(
    resolveFinishedBattleAdvanceMode({
      externalBattleId: 'dungeon-battle-1001-2',
      hasOnNext: true,
    }),
    'use_on_next',
  );
});

test('普通地图连战在没有 onNext 时，应走本地自动重开分支', () => {
  assert.equal(
    resolveFinishedBattleAdvanceMode({
      externalBattleId: null,
      hasOnNext: false,
    }),
    'use_local_retry',
  );
});

test('空字符串 externalBattleId 不应被误判成外部战斗上下文', () => {
  assert.equal(
    resolveFinishedBattleAdvanceMode({
      externalBattleId: '   ',
      hasOnNext: false,
    }),
    'use_local_retry',
  );
});
