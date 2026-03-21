import { describe, expect, it } from 'vitest';

import {
  getDesktopSidePanelDisplay,
  getInitialDesktopSidePanelState,
} from '../desktopSidePanels';

describe('desktopSidePanels', () => {
  it('默认状态应保持左右侧栏都展开，避免桌面端首屏直接丢失信息区', () => {
    expect(getInitialDesktopSidePanelState()).toEqual({
      leftCollapsed: false,
      rightCollapsed: false,
    });
  });

  it('左侧展开时应返回收起文案，收起后应切换成展开文案', () => {
    expect(getDesktopSidePanelDisplay('left', false)).toMatchObject({
      containerClassName: 'game-left',
      contentClassName: 'game-side-panel-content',
      toggleClassName: 'game-side-panel-toggle is-left',
      nextActionLabel: '收起角色面板',
      nextActionAriaLabel: '收起左侧角色面板',
    });

    expect(getDesktopSidePanelDisplay('left', true)).toMatchObject({
      containerClassName: 'game-left is-collapsed',
      contentClassName: 'game-side-panel-content is-hidden',
      toggleClassName: 'game-side-panel-toggle is-left is-collapsed',
      nextActionLabel: '展开角色面板',
      nextActionAriaLabel: '展开左侧角色面板',
    });
  });

  it('右侧应复用同一套推导逻辑，但保留功能面板专属文案与方向 class', () => {
    expect(getDesktopSidePanelDisplay('right', false)).toMatchObject({
      containerClassName: 'game-right',
      contentClassName: 'game-side-panel-content',
      toggleClassName: 'game-side-panel-toggle is-right',
      nextActionLabel: '收起功能面板',
      nextActionAriaLabel: '收起右侧功能面板',
    });

    expect(getDesktopSidePanelDisplay('right', true)).toMatchObject({
      containerClassName: 'game-right is-collapsed',
      contentClassName: 'game-side-panel-content is-hidden',
      toggleClassName: 'game-side-panel-toggle is-right is-collapsed',
      nextActionLabel: '展开功能面板',
      nextActionAriaLabel: '展开右侧功能面板',
    });
  });
});
