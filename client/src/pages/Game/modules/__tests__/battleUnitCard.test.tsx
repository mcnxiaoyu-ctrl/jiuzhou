/**
 * BattleUnitCard 静态渲染测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定战斗卡片不再渲染 buff tag 行，避免后续在局部组件里把状态标签误加回来。
 * 2. 做什么：复用静态 HTML 断言展示结构，避免为了这个纯展示回归引入额外 DOM 事件依赖。
 * 3. 不做什么：不验证 CSS 视觉效果，不覆盖头像背景、浮字动画或点击交互。
 *
 * 输入/输出：
 * - 输入：带有 `buffs` 的最小 `BattleUnitCard` props。
 * - 输出：静态渲染后的 HTML 字符串。
 *
 * 数据流/状态流：
 * - BattleUnit 最小视图模型 -> BattleUnitCard -> renderToStaticMarkup。
 *
 * 关键边界条件与坑点：
 * 1. 即使单位自带 `buffs` 数据，也不应再出现 `battle-unit-status-row` 容器。
 * 2. 当前需求只移除显示，不改战斗快照结构，因此测试必须显式保留 `buffs` 输入。
 * 3. 数值覆盖层必须位于轨道外层，避免被 `overflow: hidden` 的血条轨道裁切后在部分浏览器里出现断裂文本。
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BattleUnitCard } from '../BattleArea/BattleUnitCard';

describe('BattleUnitCard', () => {
  it('单位带有 buffs 数据时也不应渲染状态标签行', () => {
    const html = renderToStaticMarkup(
      <BattleUnitCard
        unit={{
          id: 'ally-1',
          name: '青玄',
          unitType: 'player',
          hp: 120,
          maxHp: 200,
          qi: 80,
          maxQi: 100,
          buffs: [
            {
              id: 'buff-1',
              name: '攻击提升',
              type: 'buff',
              stacks: 2,
            },
          ],
        }}
        team="ally"
        size="standard"
        showAvatarBackground={false}
        onToggleUnit={() => {}}
      />,
    );

    expect(html).not.toContain('battle-unit-status-row');
    expect(html).not.toContain('攻击提升');
  });

  it('血条数值覆盖层应位于轨道外层，避免被轨道裁切', () => {
    const html = renderToStaticMarkup(
      <BattleUnitCard
        unit={{
          id: 'ally-2',
          name: '青玄',
          unitType: 'player',
          hp: 120,
          maxHp: 200,
          qi: 80,
          maxQi: 100,
        }}
        team="ally"
        size="standard"
        showAvatarBackground={false}
        onToggleUnit={() => {}}
      />,
    );

    expect(html).toContain('<div class="battle-bar-track"><div class="battle-bar-fill" style="width:60%"></div></div><span class="battle-bar-value battle-bar-value-overlay">120</span>');
    expect(html).not.toContain('<div class="battle-bar-track"><div class="battle-bar-fill" style="width:60%"></div><span class="battle-bar-value battle-bar-value-overlay">120</span>');
  });
});
