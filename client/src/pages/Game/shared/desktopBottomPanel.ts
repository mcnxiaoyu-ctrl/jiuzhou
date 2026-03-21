/**
 * Game 桌面底部聊天区共享状态与展示推导。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中维护桌面端底部左侧聊天列的展开/收起语义，避免 `Game/index.tsx` 里散落聊天列 class、文案和 aria-label 判断。
 * 2. 做什么：提供页面层可直接消费的纯数据，让聊天列按钮和内容容器只保留一套切换规则，同时保持右侧组队面板常驻。
 * 3. 不做什么：不持有 React state，不参与移动端聊天抽屉或底部功能栏逻辑。
 *
 * 输入/输出：
 * - 输入：当前左侧聊天列是否收起 `collapsed`。
 * - 输出：聊天区容器 class、整体内容容器 class、左侧聊天列 class、聊天内容 class、切换按钮 class、下一步动作文案、无障碍文案与箭头方向。
 *
 * 数据流/状态流：
 * - Game 页桌面聊天列 state -> 本模块纯函数 -> 页面 JSX / SCSS class -> 左侧聊天列收起 UI。
 *
 * 关键边界条件与坑点：
 * 1. 收起时只允许左侧聊天列缩成窄条，右侧组队面板必须继续占据原高度，否则会再次回到“整块底部一起消失”的错误行为。
 * 2. 移动端聊天区是独立抽屉分支，桌面端 class 不能混进 `.is-mobile-drawer` 逻辑，否则会互相污染。
 */

export type DesktopBottomPanelDirection = 'up' | 'down';

export interface DesktopBottomPanelDisplay {
  containerClassName: string;
  contentClassName: string;
  chatLeftClassName: string;
  chatLeftContentClassName: string;
  toggleClassName: string;
  nextActionLabel: string;
  nextActionAriaLabel: string;
  nextActionDirection: DesktopBottomPanelDirection;
}

const joinClassNames = (...values: Array<string | false>): string => values.filter(Boolean).join(' ');

export const getInitialDesktopBottomPanelCollapsed = (): boolean => false;

export const getDesktopBottomPanelDisplay = (collapsed: boolean): DesktopBottomPanelDisplay => {
  const actionLabel = collapsed ? '展开' : '收起';

  return {
    containerClassName: joinClassNames('game-chat-area', collapsed && 'is-collapsed'),
    contentClassName: 'game-chat-area-content',
    chatLeftClassName: joinClassNames('game-chat-left', collapsed && 'is-collapsed'),
    chatLeftContentClassName: joinClassNames('game-chat-left-content', collapsed && 'is-hidden'),
    toggleClassName: joinClassNames('game-bottom-panel-toggle', collapsed && 'is-collapsed'),
    nextActionLabel: `${actionLabel}聊天区`,
    nextActionAriaLabel: `${actionLabel}左侧聊天区`,
    nextActionDirection: collapsed ? 'up' : 'down',
  };
};
