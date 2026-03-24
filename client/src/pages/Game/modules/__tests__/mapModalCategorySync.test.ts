/**
 * MapModal 默认分类同步规则回归测试。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定地图弹窗“入口默认分类”和“用户手动切换分类”的边界，避免二者互相覆盖。
 * 2. 做什么：保证同一打开周期里只消费一次相同的 `initialCategory`，并允许父层显式切换到新的入口分类。
 * 3. 不做什么：不挂载 React 组件、不请求接口，也不验证 antd Tabs 的渲染样式。
 *
 * 输入/输出：
 * - 输入：弹窗开关、当前分类、父层默认分类、最近一次已消费的默认分类。
 * - 输出：是否需要同步分类，以及同步后的分类记录。
 *
 * 数据流/状态流：
 * - Game 传入入口分类 -> 纯函数决定是否同步 -> MapModal effect 消费结果并更新本地状态。
 *
 * 关键边界条件与坑点：
 * 1. 同一打开周期里重复收到同一个 `initialCategory` 时，不能再次覆盖用户刚点过的 tab。
 * 2. 父层入口从“大世界”切到“秘境”这类显式变更，必须触发一次新的同步，否则弹窗会停在旧分类。
 */

import { describe, expect, it } from 'vitest';
import { resolveMapModalCategorySync } from '../MapModal/categorySync.js';

describe('resolveMapModalCategorySync', () => {
  it('弹窗首次打开时，应同步父层传入的默认分类', () => {
    expect(
      resolveMapModalCategorySync({
        open: true,
        category: 'world',
        initialCategory: 'dungeon',
        appliedInitialCategory: null,
      }),
    ).toEqual({
      shouldSync: true,
      nextCategory: 'dungeon',
      nextAppliedInitialCategory: 'dungeon',
    });
  });

  it('同一打开周期里，用户手动切换后不应再被同一个默认分类顶回去', () => {
    expect(
      resolveMapModalCategorySync({
        open: true,
        category: 'event',
        initialCategory: 'world',
        appliedInitialCategory: 'world',
      }),
    ).toEqual({
      shouldSync: false,
      nextCategory: 'event',
      nextAppliedInitialCategory: 'world',
    });
  });

  it('父层在弹窗打开期间明确切换入口分类时，应允许再次同步', () => {
    expect(
      resolveMapModalCategorySync({
        open: true,
        category: 'world',
        initialCategory: 'dungeon',
        appliedInitialCategory: 'world',
      }),
    ).toEqual({
      shouldSync: true,
      nextCategory: 'dungeon',
      nextAppliedInitialCategory: 'dungeon',
    });
  });

  it('弹窗关闭时，应清空已消费的默认分类记录', () => {
    expect(
      resolveMapModalCategorySync({
        open: false,
        category: 'dungeon',
        initialCategory: 'dungeon',
        appliedInitialCategory: 'dungeon',
      }),
    ).toEqual({
      shouldSync: false,
      nextCategory: 'dungeon',
      nextAppliedInitialCategory: null,
    });
  });
});
