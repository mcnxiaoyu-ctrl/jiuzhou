import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import DesktopPanelToggleButton from '../DesktopPanelToggleButton';
import { getDesktopBottomPanelDisplay } from '../desktopBottomPanel';
import { getDesktopSidePanelDisplay } from '../desktopSidePanels';

describe('DesktopPanelToggleButton', () => {
  it('应通过隐藏文本子节点避免落入 ant icon-only 宽度分支', () => {
    const html = renderToStaticMarkup(
      <DesktopPanelToggleButton
        display={getDesktopSidePanelDisplay('left', false)}
        onClick={() => void 0}
      />,
    );

    expect(html).toContain('game-panel-toggle__text');
    expect(html).not.toContain('ant-btn-icon-only');
  });

  it('应支持底部聊天区的上下方向切换语义', () => {
    const html = renderToStaticMarkup(
      <DesktopPanelToggleButton
        display={getDesktopBottomPanelDisplay(true)}
        onClick={() => void 0}
      />,
    );

    expect(html).toContain('game-bottom-panel-toggle');
    expect(html).toContain('展开聊天区');
    expect(html).not.toContain('ant-btn-icon-only');
  });
});
