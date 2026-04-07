/**
 * 玩家信息面板全局 BUFF 列表。
 *
 * 作用：
 * 1. 负责把角色快照里的 `globalBuffs` 渲染成左侧面板图标、提示与剩余时间遮罩。
 * 2. 只在本组件内部做秒级倒计时，避免把高频时间刷新扩散到整个 `PlayerInfo` 面板。
 * 不做：
 * 1. 不请求服务端数据；只消费外部传入的角色全局 Buff 快照。
 * 2. 不关心具体业务来源；祈福、活动、福利等 Buff 都按同一展示协议处理。
 *
 * 输入 / 输出：
 * - 输入：`buffs`，来自角色 Socket 快照的全局 Buff 列表。
 * - 输出：BUFF 图标列表；无有效 Buff 时返回 `null`。
 *
 * 数据流 / 状态流：
 * Socket `game:character.globalBuffs`
 * -> 本组件按当前时间计算剩余毫秒、遮罩比例与提示文案
 * -> 输出到玩家左侧面板。
 *
 * 复用设计说明：
 * 1. 把“剩余时间格式化 + 遮罩比例 + Tooltip 文案”集中到一个组件，后续角色页、悬浮卡若也展示同类快照，可以直接复用这套协议。
 * 2. 全局 Buff 展示属于高频变化点，单独拆出后不需要在 `PlayerInfo` 主组件里重复维护倒计时逻辑。
 *
 * 关键边界条件与坑点：
 * 1. 过期 Buff 需要在本地时钟达到过期点后立即隐藏，不能等下一次 30 秒角色刷新才消失。
 * 2. 遮罩比例必须以服务端下发的总持续时间为准，不能通过业务类型硬编码时长，否则后续变更 Buff 时长会出现 UI 错位。
 */
import { Tooltip } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import type { CharacterGlobalBuffData } from '../../../../services/gameSocket';
import { formatGameCooldownRemaining } from '../../shared/cooldownText';

interface PlayerGlobalBuffListProps {
  buffs: CharacterGlobalBuffData[];
}

interface ActivePlayerGlobalBuff extends CharacterGlobalBuffData {
  remainingMs: number;
  remainingText: string;
  remainingRatio: number;
}

type PlayerGlobalBuffTooltipPlacement =
  | 'topLeft'
  | 'top'
  | 'topRight'
  | 'bottomLeft'
  | 'bottom'
  | 'bottomRight';

const PLAYER_GLOBAL_BUFF_TICK_MS = 1000;
const PLAYER_GLOBAL_BUFF_TOOLTIP_EDGE_GAP_PX = 12;

const buildActivePlayerGlobalBuffs = (
  buffs: CharacterGlobalBuffData[],
  nowMs: number,
): ActivePlayerGlobalBuff[] => {
  const activeBuffs: ActivePlayerGlobalBuff[] = [];

  for (const buff of buffs) {
    const expireAtMs = Date.parse(buff.expireAt);
    if (!Number.isFinite(expireAtMs)) continue;

    const remainingMs = Math.max(0, expireAtMs - nowMs);
    if (remainingMs <= 0) continue;

    const totalDurationMs = Math.max(1, Math.floor(Number(buff.totalDurationMs) || 0));
    const remainingRatio = Math.max(0, Math.min(1, remainingMs / totalDurationMs));

    activeBuffs.push({
      ...buff,
      remainingMs,
      remainingText: formatGameCooldownRemaining(Math.ceil(remainingMs / 1000)),
      remainingRatio,
    });
  }

  return activeBuffs;
};

const PlayerGlobalBuffList: React.FC<PlayerGlobalBuffListProps> = ({ buffs }) => {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [tooltipPlacement, setTooltipPlacement] = useState<PlayerGlobalBuffTooltipPlacement>('top');

  useEffect(() => {
    if (buffs.length <= 0) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, PLAYER_GLOBAL_BUFF_TICK_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [buffs.length]);

  const activeBuffs = useMemo(() => {
    return buildActivePlayerGlobalBuffs(buffs, nowMs);
  }, [buffs, nowMs]);

  const resolveTooltipPlacement = (
    event: React.MouseEvent<HTMLDivElement>,
  ): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    const horizontalPlacement: 'Left' | '' | 'Right' = rect.left <= PLAYER_GLOBAL_BUFF_TOOLTIP_EDGE_GAP_PX
      ? 'Left'
      : rect.right >= viewportWidth - PLAYER_GLOBAL_BUFF_TOOLTIP_EDGE_GAP_PX
        ? 'Right'
        : '';
    const verticalPlacement: 'top' | 'bottom' = rect.top <= viewportHeight * 0.2
      ? 'bottom'
      : 'top';

    const nextPlacement = `${verticalPlacement}${horizontalPlacement}` as PlayerGlobalBuffTooltipPlacement;
    setTooltipPlacement((previous) => {
      return previous === nextPlacement ? previous : nextPlacement;
    });
  };

  if (activeBuffs.length <= 0) {
    return null;
  }

  return (
    <div className="player-global-buff-list" aria-label="当前全局BUFF">
      {activeBuffs.map((buff) => (
        <Tooltip
          key={buff.id}
          placement={tooltipPlacement}
          title={(
            <div className="player-global-buff-tooltip">
              <div className="player-global-buff-tooltip-title">{buff.label}</div>
              <div className="player-global-buff-tooltip-effect">{buff.effectText}</div>
              <div className="player-global-buff-tooltip-time">剩余：{buff.remainingText}</div>
            </div>
          )}
        >
          <div
            className="player-global-buff-item"
            role="presentation"
            onMouseEnter={resolveTooltipPlacement}
          >
            <div className="player-global-buff-icon">
              <div
                className="player-global-buff-icon-fill"
                style={{ transform: `scaleY(${buff.remainingRatio})` }}
              />
              <span className="player-global-buff-icon-text">{buff.iconText}</span>
            </div>
          </div>
        </Tooltip>
      ))}
    </div>
  );
};

export default PlayerGlobalBuffList;
