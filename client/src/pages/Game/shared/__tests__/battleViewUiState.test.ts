/**
 * Game 战斗视图 UI 状态归一化回归测试。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定“战斗视图切换时不应自动关闭任何信息弹窗”的规则，覆盖怪物与玩家两类常见窗口。
 * 2. 做什么：校验切到战斗或回到地图时，顶层 tab 仍会统一归到 `map`，避免移动端停留在房间标签。
 * 3. 不做什么：不挂载 React 组件、不订阅 socket，也不验证 InfoModal 具体渲染细节。
 *
 * 输入/输出：
 * - 输入：当前 Game 页 UI 状态快照，以及目标视图模式。
 * - 输出：`resolveBattleViewUiState` 返回的下一份 UI 状态。
 *
 * 数据流/状态流：
 * - battle session / realtime / 战斗入口动作 -> 共享纯函数 -> Game 页 React state。
 *
 * 关键边界条件与坑点：
 * 1. 已打开的怪物信息窗口不能因为进入战斗就被清空，否则用户无法一边战斗一边查看怪物信息。
 * 2. 已打开的玩家信息窗口同样必须保留，避免战斗同步把“查看玩家状态”打断。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveBattleViewUiState } from '../battleViewUiState.js';

test('进入战斗视图时应保留已打开的怪物信息窗口', () => {
  const monsterInfoTarget = {
    type: 'monster',
    id: 'monster-gray-wolf',
    name: '灰狼',
  };

  assert.deepEqual(
    resolveBattleViewUiState(
      {
        viewMode: 'map',
        topTab: 'room',
        infoTarget: monsterInfoTarget,
      },
      'battle',
    ),
    {
      viewMode: 'battle',
      topTab: 'map',
      infoTarget: monsterInfoTarget,
    },
  );
});

test('战斗视图同步时应保留已打开的玩家信息窗口', () => {
  const playerInfoTarget = {
    type: 'player',
    id: '1001',
    name: '青玄',
  };

  assert.deepEqual(
    resolveBattleViewUiState(
      {
        viewMode: 'battle',
        topTab: 'map',
        infoTarget: playerInfoTarget,
      },
      'battle',
    ),
    {
      viewMode: 'battle',
      topTab: 'map',
      infoTarget: playerInfoTarget,
    },
  );
});

test('退出战斗回到地图时也不应清空已打开的信息窗口', () => {
  const itemInfoTarget = {
    type: 'item',
    id: 'ore-1',
    name: '灵铁矿',
  };

  assert.deepEqual(
    resolveBattleViewUiState(
      {
        viewMode: 'battle',
        topTab: 'room',
        infoTarget: itemInfoTarget,
      },
      'map',
    ),
    {
      viewMode: 'map',
      topTab: 'map',
      infoTarget: itemInfoTarget,
    },
  );
});

test('主动从信息窗口发起攻击时，应允许显式关闭当前信息窗口', () => {
  const monsterInfoTarget = {
    type: 'monster',
    id: 'monster-gray-wolf',
    name: '灰狼',
  };

  assert.deepEqual(
    resolveBattleViewUiState(
      {
        viewMode: 'map',
        topTab: 'room',
        infoTarget: monsterInfoTarget,
      },
      'battle',
      {
        preserveInfoTarget: false,
      },
    ),
    {
      viewMode: 'battle',
      topTab: 'map',
      infoTarget: null,
    },
  );
});
