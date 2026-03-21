import { describe, expect, it } from 'vitest';

import {
  getDesktopBottomPanelDisplay,
  getInitialDesktopBottomPanelCollapsed,
} from '../desktopBottomPanel';

describe('desktopBottomPanel', () => {
  it('默认状态应保持左侧聊天列展开，避免桌面端首屏直接丢失聊天内容', () => {
    expect(getInitialDesktopBottomPanelCollapsed()).toBe(false);
  });

  it('展开时应只让左侧聊天区向下收起，右侧组队面板语义不应被带走', () => {
    expect(getDesktopBottomPanelDisplay(false)).toMatchObject({
      containerClassName: 'game-chat-area',
      contentClassName: 'game-chat-area-content',
      chatLeftClassName: 'game-chat-left',
      chatLeftContentClassName: 'game-chat-left-content',
      toggleClassName: 'game-bottom-panel-toggle',
      nextActionLabel: '收起聊天区',
      nextActionAriaLabel: '收起左侧聊天区',
      nextActionDirection: 'down',
    });

    expect(getDesktopBottomPanelDisplay(true)).toMatchObject({
      containerClassName: 'game-chat-area is-collapsed',
      contentClassName: 'game-chat-area-content',
      chatLeftClassName: 'game-chat-left is-collapsed',
      chatLeftContentClassName: 'game-chat-left-content is-hidden',
      toggleClassName: 'game-bottom-panel-toggle is-collapsed',
      nextActionLabel: '展开聊天区',
      nextActionAriaLabel: '展开左侧聊天区',
      nextActionDirection: 'up',
    });
  });
});
