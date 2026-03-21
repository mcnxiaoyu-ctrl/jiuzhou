/**
 * Game 桌面面板切换把手。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一渲染桌面端左右侧栏与底部聊天区的收起/展开按钮，避免页面层重复维护 Button 结构、Tooltip 与无障碍文案。
 * 2. 做什么：通过隐藏文本子节点主动规避 antd `icon-only` 宽度分支，让左右/上下两类把手宽度都真正受业务样式变量控制。
 * 3. 不做什么：不持有面板状态，也不决定具体文案规则；这些由各自的共享纯函数模块提供。
 *
 * 输入/输出：
 * - 输入：`display` 展示配置、`onClick` 点击回调。
 * - 输出：带 Tooltip 的桌面面板切换按钮。
 *
 * 数据流/状态流：
 * - Game 页面板状态 -> 共享纯函数 -> 本组件渲染统一按钮结构 -> SCSS 控制左右/上下把手样式。
 *
 * 关键边界条件与坑点：
 * 1. 若退回 antd `icon` prop 且没有文本子节点，组件会重新带上 `ant-btn-icon-only`，把手宽度会再次被组件库默认尺寸覆盖。
 * 2. 隐藏文本只用于阻止 icon-only 分支，真正的无障碍名称仍由 `aria-label` 提供，避免视觉调整影响读屏体验。
 */

import { Button, Tooltip } from 'antd';
import { DownOutlined, LeftOutlined, RightOutlined, UpOutlined } from '@ant-design/icons';
import type { FC } from 'react';

type DesktopPanelToggleDirection = 'left' | 'right' | 'up' | 'down';

interface DesktopPanelToggleDisplay {
  toggleClassName: string;
  nextActionLabel: string;
  nextActionAriaLabel: string;
  nextActionDirection: DesktopPanelToggleDirection;
}

const resolveToggleIcon = (direction: DesktopPanelToggleDirection) => {
  if (direction === 'left') return <LeftOutlined />;
  if (direction === 'right') return <RightOutlined />;
  if (direction === 'up') return <UpOutlined />;
  return <DownOutlined />;
};

const DesktopPanelToggleButton: FC<{
  display: DesktopPanelToggleDisplay;
  onClick: () => void;
}> = ({ display, onClick }) => (
  <Tooltip title={display.nextActionLabel} placement="top">
    <Button
      className={display.toggleClassName}
      type="text"
      aria-label={display.nextActionAriaLabel}
      onClick={onClick}
    >
      <span className="game-panel-toggle__icon" aria-hidden="true">
        {resolveToggleIcon(display.nextActionDirection)}
      </span>
      <span className="game-panel-toggle__text" aria-hidden="true">
        {display.nextActionLabel}
      </span>
    </Button>
  </Tooltip>
);

export default DesktopPanelToggleButton;
