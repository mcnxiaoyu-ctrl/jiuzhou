import { App, Button, Modal, Progress, Segmented, Tag } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  claimAchievementPointsReward,
  claimAchievementReward,
  equipTitle,
  getAchievementList,
  getAchievementPointsRewards,
  getTitleList,
  type AchievementItemDto,
  type AchievementPointRewardDto,
  type AchievementRewardView,
  type TitleInfoDto,
} from '../../../../services/api';
import { gameSocket } from '../../../../services/gameSocket';
import { resolveIconUrl, DEFAULT_ICON as coin01 } from '../../shared/resolveIcon';
import { IMG_LINGSHI as lingshiIcon, IMG_TONGQIAN as tongqianIcon, IMG_EXP as expIcon } from '../../shared/imageAssets';
import { useIsMobile } from '../../shared/responsive';
import { formatTitleEffectsText } from '../../shared/titleEffectText';
import './index.scss';

interface AchievementModalProps {
  open: boolean;
  onClose: () => void;
  onChanged?: () => void;
}

type AchievementTab = 'all' | 'combat' | 'cultivation' | 'exploration' | 'social' | 'collection';
const achievementTabKeys: AchievementTab[] = ['all', 'combat', 'cultivation', 'exploration', 'social', 'collection'];

type RewardViewModel = {
  id: string;
  name: string;
  icon: string;
  amountText: string;
};

const resolveRewardIcon = resolveIconUrl;

const resolveRewardView = (reward: AchievementRewardView, index: number): RewardViewModel | null => {
  if (!reward) return null;
  if (reward.type === 'item') {
    const rawItemName = String(reward.itemName || '').trim();
    const itemName = rawItemName && rawItemName !== reward.itemDefId ? rawItemName : '未知材料';
    const icon = resolveRewardIcon(reward.itemIcon);
    const qty = typeof reward.qty === 'number' ? Math.max(1, Math.floor(reward.qty)) : 1;
    return {
      id: `${reward.type}:${reward.itemDefId || index}`,
      name: itemName,
      icon,
      amountText: `×${qty.toLocaleString()}`,
    };
  }

  const amount = typeof reward.amount === 'number' ? Math.max(0, Math.floor(reward.amount)) : 0;
  const name = reward.type === 'silver' ? '银两' : reward.type === 'spirit_stones' ? '灵石' : '经验';
  const icon = reward.type === 'silver' ? tongqianIcon : reward.type === 'spirit_stones' ? lingshiIcon : expIcon;
  return {
    id: `${reward.type}:${index}`,
    name,
    icon,
    amountText: `×${amount.toLocaleString()}`,
  };
};

const tabs: Array<{ key: AchievementTab; label: string }> = [
  { key: 'all', label: '全部成就' },
  { key: 'combat', label: '战斗成就' },
  { key: 'cultivation', label: '修炼成就' },
  { key: 'exploration', label: '探索成就' },
  { key: 'social', label: '社交成就' },
  { key: 'collection', label: '收集成就' },
];

const pad2 = (value: number): string => String(value).padStart(2, '0');

const formatTitleExpireAt = (expiresAt: string): string => {
  const date = new Date(expiresAt);
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const hour = pad2(date.getHours());
  const minute = pad2(date.getMinutes());
  return `${year}-${month}-${day} ${hour}:${minute}`;
};

const formatTitleRemaining = (expiresAt: string, nowMs: number): string => {
  const deltaMs = new Date(expiresAt).getTime() - nowMs;
  if (deltaMs <= 0) return '已过期';

  const totalMinutes = Math.floor(deltaMs / 60_000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}天${hours}小时${minutes}分`;
  if (hours > 0) return `${hours}小时${minutes}分`;
  return `${minutes}分`;
};

const AchievementModal: React.FC<AchievementModalProps> = ({ open, onClose, onChanged }) => {
  const { message } = App.useApp();

  const [tab, setTab] = useState<AchievementTab>('all');
  const isMobile = useIsMobile();
  const [characterId, setCharacterId] = useState<number | null>(() => gameSocket.getCharacter()?.id ?? null);
  const [loading, setLoading] = useState(false);
  const [achievements, setAchievements] = useState<AchievementItemDto[]>([]);
  const [pointsInfo, setPointsInfo] = useState({
    total: 0,
    byCategory: { combat: 0, cultivation: 0, exploration: 0, social: 0, collection: 0 },
  });
  const [pointRewards, setPointRewards] = useState<AchievementPointRewardDto[]>([]);
  const [titles, setTitles] = useState<TitleInfoDto[]>([]);
  const [claimingId, setClaimingId] = useState('');
  const [claimingPointThreshold, setClaimingPointThreshold] = useState<number | null>(null);
  const [equippingTitleId, setEquippingTitleId] = useState('');
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const refreshData = useCallback(async (mode: 'blocking' | 'silent' = 'blocking') => {
    const isBlocking = mode === 'blocking';
    if (isBlocking) {
      setLoading(true);
    }

    try {
      const category = tab === 'all' ? undefined : tab;
      const [listRes, pointsRewardRes, titleRes] = await Promise.all([
        getAchievementList({ category, page: 1, limit: 200 }),
        getAchievementPointsRewards(),
        getTitleList(),
      ]);

      if (listRes.success && listRes.data) {
        setAchievements(Array.isArray(listRes.data.achievements) ? listRes.data.achievements : []);
        setPointsInfo(listRes.data.points || {
          total: 0,
          byCategory: { combat: 0, cultivation: 0, exploration: 0, social: 0, collection: 0 },
        });
      } else {
        setAchievements([]);
      }

      if (pointsRewardRes.success && pointsRewardRes.data) {
        setPointRewards(Array.isArray(pointsRewardRes.data.rewards) ? pointsRewardRes.data.rewards : []);
      } else {
        setPointRewards([]);
      }

      if (titleRes.success && titleRes.data) {
        setTitles(Array.isArray(titleRes.data.titles) ? titleRes.data.titles : []);
      } else {
        setTitles([]);
      }
    } catch {
      setAchievements([]);
      setPointRewards([]);
      setTitles([]);
    } finally {
      if (isBlocking) {
        setLoading(false);
      }
    }
  }, [tab]);

  useEffect(() => {
    if (!open) return;
    void refreshData();
  }, [open, refreshData]);

  useEffect(() => {
    return gameSocket.onCharacterUpdate((character) => {
      setCharacterId(character?.id ?? null);
    });
  }, []);

  useEffect(() => {
    if (!open || !characterId) return;
    // 弹窗打开时已经主动拉取过完整数据，这里只接收后续增量推送，避免订阅瞬间回放当前缓存导致重复请求。
    return gameSocket.onAchievementUpdate((payload) => {
      if (payload.characterId !== characterId) return;
      void refreshData('silent');
    }, { emitCurrent: false });
  }, [characterId, open, refreshData]);

  /**
   * 称号剩余时间按分钟刷新即可，避免逐秒刷新导致不必要的重渲染。
   */
  useEffect(() => {
    if (!open) return;
    setNowMs(Date.now());
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 60 * 1000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [open]);

  const overall = useMemo(() => {
    const total = achievements.length;
    const doneCount = achievements.filter((a) => a.progress?.done).length;
    const claimedCount = achievements.filter((a) => a.status === 'claimed').length;
    return { total, doneCount, claimedCount };
  }, [achievements]);

  const claimAchievement = useCallback(
    async (id: string) => {
      if (!id) return;
      setClaimingId(id);
      try {
        const res = await claimAchievementReward(id);
        if (!res.success) {
          void 0;
          return;
        }
        message.success('领取成功');
        await refreshData();
        onChanged?.();
      } catch {
        void 0;
      } finally {
        setClaimingId('');
      }
    },
    [message, onChanged, refreshData],
  );

  const claimPointReward = useCallback(
    async (threshold: number) => {
      setClaimingPointThreshold(threshold);
      try {
        const res = await claimAchievementPointsReward(threshold);
        if (!res.success) {
          void 0;
          return;
        }
        message.success('点数奖励领取成功');
        await refreshData();
        onChanged?.();
      } catch {
        void 0;
      } finally {
        setClaimingPointThreshold(null);
      }
    },
    [message, onChanged, refreshData],
  );

  const equipTitleAction = useCallback(
    async (titleId: string) => {
      if (!titleId) return;
      setEquippingTitleId(titleId);
      try {
        const res = await equipTitle(titleId);
        if (!res.success) {
          void 0;
          return;
        }
        message.success('已装备称号');
        await refreshData();
        onChanged?.();
      } catch {
        void 0;
      } finally {
        setEquippingTitleId('');
      }
    },
    [message, onChanged, refreshData],
  );

  const sortedTitles = useMemo(() => {
    const list = [...titles];
    list.sort((a, b) => {
      if (a.isEquipped && !b.isEquipped) return -1;
      if (!a.isEquipped && b.isEquipped) return 1;
      return a.name.localeCompare(b.name);
    });
    return list;
  }, [titles]);

  const mobileTabOptions = useMemo(
    () => [
      { value: 'all', label: '全部' },
      { value: 'combat', label: '战斗' },
      { value: 'cultivation', label: '修炼' },
      { value: 'exploration', label: '探索' },
      { value: 'social', label: '社交' },
      { value: 'collection', label: '收集' },
    ],
    [],
  );

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      title={null}
      centered
      width={1080}
      className="achievement-modal"
      destroyOnHidden
      maskClosable
      afterOpenChange={(visible) => {
        if (!visible) return;
        setTab('all');
      }}
    >
      <div className="achievement-shell">
        <div className="achievement-left">
          <div className="achievement-left-title">
            <img className="achievement-left-icon" src={coin01} alt="成就" />
            <div className="achievement-left-name">成就</div>
          </div>
          {isMobile ? (
            <div className="achievement-left-segmented-wrap">
              <Segmented
                className="achievement-left-segmented"
                value={tab}
                options={mobileTabOptions}
                onChange={(value) => {
                  if (typeof value !== 'string') return;
                  if (!achievementTabKeys.includes(value as AchievementTab)) return;
                  setTab(value as AchievementTab);
                }}
              />
            </div>
          ) : (
            <div className="achievement-left-list">
              {tabs.map((item) => (
                <Button
                  key={item.key}
                  type={tab === item.key ? 'primary' : 'default'}
                  className="achievement-left-item"
                  onClick={() => setTab(item.key)}
                >
                  {item.label}
                </Button>
              ))}
            </div>
          )}
        </div>

        <div className="achievement-right">
          <div className="achievement-pane">
            <div className="achievement-pane-top">
              <div className="achievement-top-row">
                <div className="achievement-title">{tabs.find((x) => x.key === tab)?.label ?? '成就'}</div>
                <div className="achievement-tags">
                  <Tag color="blue">当前点数 {pointsInfo.total.toLocaleString()}</Tag>
                  <Tag color="green">
                    已完成 {overall.doneCount}/{overall.total}
                  </Tag>
                  <Tag color="purple">
                    已领取 {overall.claimedCount}/{overall.total}
                  </Tag>
                </div>
              </div>
              <div className="achievement-top-progress">
                <div className="achievement-progress-left">分类进度</div>
                <div className="achievement-progress-right">
                  <Progress
                    percent={overall.total > 0 ? (overall.doneCount / overall.total) * 100 : 0}
                    showInfo={false}
                    strokeColor="var(--primary-color)"
                  />
                </div>
              </div>
            </div>

            <div className="achievement-pane-body">
              <div className="achievement-list">
                {achievements.map((row) => {
                  const claimable = row.claimable && row.status !== 'claimed';
                  const rewardRows = row.rewards
                    .map((reward, index) => resolveRewardView(reward, index))
                    .filter((item): item is RewardViewModel => item !== null);
                  return (
                    <div key={row.id} className="achievement-item">
                      <div className="achievement-item-main">
                        <div className="achievement-item-top">
                          <div className="achievement-item-title">{row.name}</div>
                          <div className="achievement-item-tags">
                            {row.status === 'claimed' ? (
                              <Tag color="green">已领取</Tag>
                            ) : claimable ? (
                              <Tag color="blue">可领取</Tag>
                            ) : row.progress?.done ? (
                              <Tag color="gold">已完成</Tag>
                            ) : (
                              <Tag>进行中</Tag>
                            )}
                            <Tag color="cyan">+{row.points}点</Tag>
                          </div>
                        </div>
                        <div className="achievement-item-desc">{row.description}</div>
                        <div className="achievement-item-progress">
                          <Progress
                            percent={typeof row.progress?.percent === 'number' ? row.progress.percent : 0}
                            showInfo={false}
                            strokeColor="var(--primary-color)"
                          />
                          <div className="achievement-item-progress-meta">
                            {(row.progress?.current ?? 0).toLocaleString()}/{(row.progress?.target ?? 0).toLocaleString()}
                          </div>
                        </div>
                        <div className="achievement-rewards">
                          {rewardRows.map((reward) => (
                            <div key={reward.id} className="achievement-reward">
                              <img className="achievement-reward-icon" src={reward.icon} alt={reward.name} />
                              <div className="achievement-reward-name">{reward.name}</div>
                              <div className="achievement-reward-amount">{reward.amountText}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="achievement-item-right">
                        <Button
                          type="primary"
                          size="small"
                          className="achievement-claim-btn"
                          disabled={!claimable || loading}
                          loading={claimingId === row.id}
                          onClick={() => void claimAchievement(row.id)}
                        >
                          {row.status === 'claimed' ? '已领取' : '领取'}
                        </Button>
                      </div>
                    </div>
                  );
                })}
                {loading ? <div className="achievement-empty">加载中...</div> : null}
                {!loading && achievements.length === 0 ? <div className="achievement-empty">暂无成就</div> : null}
              </div>

              <div className="achievement-section-title">成就点奖励</div>
              <div className="achievement-points-list">
                {pointRewards.map((row) => {
                  const rewardRows = row.rewards
                    .map((reward, index) => resolveRewardView(reward, index))
                    .filter((item): item is RewardViewModel => item !== null);
                  return (
                    <div key={row.id} className="achievement-points-item">
                      <div className="achievement-points-main">
                        <div className="achievement-points-top">
                          <div className="achievement-points-name">{row.name}</div>
                          <Tag color="geekblue">{row.threshold} 点</Tag>
                        </div>
                        <div className="achievement-item-desc">{row.description}</div>
                        <div className="achievement-rewards">
                          {rewardRows.map((reward) => (
                            <div key={reward.id} className="achievement-reward">
                              <img className="achievement-reward-icon" src={reward.icon} alt={reward.name} />
                              <div className="achievement-reward-name">{reward.name}</div>
                              <div className="achievement-reward-amount">{reward.amountText}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="achievement-item-right">
                        <Button
                          type="primary"
                          size="small"
                          disabled={!row.claimable || row.claimed || loading}
                          loading={claimingPointThreshold === row.threshold}
                          onClick={() => void claimPointReward(row.threshold)}
                        >
                          {row.claimed ? '已领取' : row.claimable ? '领取' : '未达成'}
                        </Button>
                      </div>
                    </div>
                  );
                })}
                {!loading && pointRewards.length === 0 ? <div className="achievement-empty">暂无点数奖励</div> : null}
              </div>

              <div className="achievement-section-title">称号</div>
              <div className="achievement-title-list">
                {sortedTitles.map((title) => {
                  const effectsText = formatTitleEffectsText(title.effects || {});
                  return (
                    <div key={title.id} className="achievement-title-item">
                      <div className="achievement-title-main">
                        <div className="achievement-title-top">
                          <div className="achievement-title-name">{title.name}</div>
                        </div>
                        <div className="achievement-item-desc">{title.description}</div>
                        <div className="achievement-item-desc">{effectsText || '无属性加成'}</div>
                        <div className="achievement-title-expire-line">
                          有效期：{title.expiresAt ? formatTitleExpireAt(title.expiresAt) : '永久'}
                        </div>
                        <div className="achievement-title-expire-line">
                          剩余：{title.expiresAt ? formatTitleRemaining(title.expiresAt, nowMs) : '永久'}
                        </div>
                      </div>
                      <div className="achievement-item-right">
                        <Button
                          type={title.isEquipped ? 'default' : 'primary'}
                          size="small"
                          disabled={title.isEquipped || loading}
                          loading={equippingTitleId === title.id}
                          onClick={() => void equipTitleAction(title.id)}
                        >
                          {title.isEquipped ? '已装备' : '装备'}
                        </Button>
                      </div>
                    </div>
                  );
                })}
                {!loading && sortedTitles.length === 0 ? <div className="achievement-empty">暂无称号</div> : null}
              </div>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
};

export default AchievementModal;
