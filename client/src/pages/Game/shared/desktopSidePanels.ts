/**
 * Game 桌面双侧栏共享状态与展示推导。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中维护桌面端左侧角色栏、右侧功能栏的折叠语义，避免 `Game/index.tsx` 左右两边各自重复拼 class、文案与 aria-label。
 * 2. 做什么：提供页面层可直接消费的纯数据，让侧栏切换逻辑只保留一份，后续若调整文案或折叠视觉，改这里即可同步生效。
 * 3. 不做什么：不持有 React state、不处理点击事件，也不参与移动端抽屉/底栏逻辑。
 *
 * 输入/输出：
 * - 输入：侧栏位置 `side` 与当前折叠状态 `collapsed`。
 * - 输出：侧栏容器 class、内容区 class、切换按钮 class、下一步动作文案、无障碍文案与箭头方向。
 *
 * 数据流/状态流：
 * - Game 页 state -> 本模块纯函数 -> 页面 JSX / SCSS class -> 桌面端双侧栏可收起 UI。
 *
 * 关键边界条件与坑点：
 * 1. 左右侧栏虽然都支持收起，但按钮方向和文案并不对称，必须走同一份推导逻辑，避免一边修了另一边漏改。
 * 2. 收起后仍需保留稳定的再次展开入口，所以这里只返回“窄栏 + 展开按钮”的语义，不能把侧栏直接判成完全隐藏。
 */

export type DesktopSidePanelSide = 'left' | 'right';
export type DesktopSidePanelDirection = 'left' | 'right';

export interface DesktopSidePanelState {
  leftCollapsed: boolean;
  rightCollapsed: boolean;
}

export interface DesktopSidePanelDisplay {
  containerClassName: string;
  contentClassName: string;
  toggleClassName: string;
  nextActionLabel: string;
  nextActionAriaLabel: string;
  nextActionDirection: DesktopSidePanelDirection;
}

interface DesktopSidePanelMeta {
  baseClassName: 'game-left' | 'game-right';
  label: '角色面板' | '功能面板';
  ariaSideLabel: '左侧' | '右侧';
  expandedDirection: DesktopSidePanelDirection;
  collapsedDirection: DesktopSidePanelDirection;
}

const DESKTOP_SIDE_PANEL_META: Record<DesktopSidePanelSide, DesktopSidePanelMeta> = {
  left: {
    baseClassName: 'game-left',
    label: '角色面板',
    ariaSideLabel: '左侧',
    expandedDirection: 'left',
    collapsedDirection: 'right',
  },
  right: {
    baseClassName: 'game-right',
    label: '功能面板',
    ariaSideLabel: '右侧',
    expandedDirection: 'right',
    collapsedDirection: 'left',
  },
};

const joinClassNames = (...values: Array<string | false>): string => values.filter(Boolean).join(' ');

export const getInitialDesktopSidePanelState = (): DesktopSidePanelState => ({
  leftCollapsed: false,
  rightCollapsed: false,
});

export const getDesktopSidePanelDisplay = (
  side: DesktopSidePanelSide,
  collapsed: boolean,
): DesktopSidePanelDisplay => {
  const meta = DESKTOP_SIDE_PANEL_META[side];
  const actionLabel = collapsed ? '展开' : '收起';

  return {
    containerClassName: joinClassNames(meta.baseClassName, collapsed && 'is-collapsed'),
    contentClassName: joinClassNames('game-side-panel-content', collapsed && 'is-hidden'),
    toggleClassName: joinClassNames(
      'game-side-panel-toggle',
      side === 'left' ? 'is-left' : 'is-right',
      collapsed && 'is-collapsed',
    ),
    nextActionLabel: `${actionLabel}${meta.label}`,
    nextActionAriaLabel: `${actionLabel}${meta.ariaSideLabel}${meta.label}`,
    nextActionDirection: collapsed ? meta.collapsedDirection : meta.expandedDirection,
  };
};
