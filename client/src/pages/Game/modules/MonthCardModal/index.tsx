import {
  ClockCircleOutlined,
  FieldTimeOutlined,
  GiftOutlined,
  StarOutlined,
  ThunderboltOutlined,
  UsergroupAddOutlined,
} from '@ant-design/icons';
import { App, Button, Modal } from 'antd';
import { useCallback, useMemo, useState, type ComponentType } from 'react';
import { activateMonthCardItem, claimMonthCardReward, getInventoryItems, getMonthCardStatus } from '../../../../services/api';
import { gameSocket } from '../../../../services/gameSocket';
import {
  buildMonthCardDailyRewards,
  buildMonthCardPanelState,
  getMonthCardPrivileges,
  type MonthCardDailyReward,
  type MonthCardPrivilegeIconName,
} from './monthCardDisplay';
import './index.scss';

interface MonthCardModalProps {
  open: boolean;
  onClose: () => void;
}

const monthCardId = 'monthcard-001';
const monthCardItemDefId = 'cons-monthcard-001';
const defaultDailySpiritStones = 10000;
const privilegeIconMap: Record<MonthCardPrivilegeIconName, ComponentType> = {
  GiftOutlined,
  UsergroupAddOutlined,
  ClockCircleOutlined,
  FieldTimeOutlined,
  ThunderboltOutlined,
  StarOutlined,
};

const MonthCardModal: React.FC<MonthCardModalProps> = ({ open, onClose }) => {
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState(false);
  const [status, setStatus] = useState<Awaited<ReturnType<typeof getMonthCardStatus>>['data'] | null>(null);
  const [monthCardItem, setMonthCardItem] = useState<{ instanceId: number; qty: number } | null>(null);

  const refreshStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getMonthCardStatus(monthCardId);
      if (!res.success || !res.data) {
        setStatus(null);
        return;
      }
      setStatus(res.data);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [message]);

  const refreshMonthCardItem = useCallback(async () => {
    try {
      const res = await getInventoryItems('bag', 1, 200);
      const items = res.data?.items || [];

      let pickedId = 0;
      let totalQty = 0;
      for (const it of items) {
        if (it.item_def_id !== monthCardItemDefId) continue;
        totalQty += Number(it.qty) || 0;
        if (!pickedId) pickedId = Number(it.id) || 0;
      }

      if (pickedId && totalQty > 0) {
        setMonthCardItem({ instanceId: pickedId, qty: totalQty });
      } else {
        setMonthCardItem(null);
      }
    } catch {
      setMonthCardItem(null);
    }
  }, []);

  const dailyRewards = useMemo<MonthCardDailyReward[]>(() => {
    const amount = status?.dailySpiritStones ?? defaultDailySpiritStones;
    return buildMonthCardDailyRewards(amount);
  }, [status?.dailySpiritStones]);
  const privileges = useMemo(() => {
    if (!status?.benefits) return [];
    return getMonthCardPrivileges(status.benefits);
  }, [status?.benefits]);

  const active = Boolean(status?.active);
  const daysLeft = status?.daysLeft ?? 0;
  const canClaim = Boolean(status?.canClaim);
  const today = status?.today ?? '';
  const lastClaimDate = status?.lastClaimDate ?? '';
  const isExpired = useMemo(() => {
    if (!status?.expireAt) return false;
    const ts = Date.parse(status.expireAt);
    if (!Number.isFinite(ts)) return false;
    return ts <= Date.now();
  }, [status?.expireAt]);

  const panelState = useMemo(
    () =>
      buildMonthCardPanelState({
        active,
        isExpired,
        daysLeft,
        expireAt: status?.expireAt ?? null,
      }),
    [active, daysLeft, isExpired, status?.expireAt],
  );

  const doUseItem = useCallback(async () => {
    if (acting) return;
    if (!monthCardItem?.instanceId) {
      message.error('背包中没有月卡道具');
      return;
    }
    setActing(true);
    try {
      const res = await activateMonthCardItem({ monthCardId, itemInstanceId: monthCardItem.instanceId });
      if (!res.success) {
        return;
      }
      message.success('使用成功');
      gameSocket.refreshCharacter();
      await refreshStatus();
      await refreshMonthCardItem();
    } catch {
      // ignore
    } finally {
      setActing(false);
    }
  }, [acting, message, monthCardItem?.instanceId, refreshMonthCardItem, refreshStatus]);

  const claim = useCallback(async () => {
    if (acting) return;
    if (!canClaim) return;
    setActing(true);
    try {
      const res = await claimMonthCardReward(monthCardId);
      if (!res.success) {
        return;
      }
      message.success(`领取成功 +${res.data?.rewardSpiritStones ?? 0} 灵石`);
      await refreshStatus();
    } catch {
      // ignore
    } finally {
      setActing(false);
    }
  }, [acting, canClaim, message, refreshStatus]);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      title={null}
      centered
      width={760}
      className="monthcard-modal"
      destroyOnHidden
      maskClosable
      afterOpenChange={(visible) => {
        if (!visible) {
          setStatus(null);
          setMonthCardItem(null);
          return;
        }
        void refreshStatus();
        void refreshMonthCardItem();
      }}
    >
      <div className="monthcard-shell">
        <div className="monthcard-header">
          <div className="monthcard-title">修仙月卡</div>
        </div>

        <div className="monthcard-body">
          <div className="monthcard-vip-card">
            <div className="monthcard-vip-bg-fx"></div>
            <div className="monthcard-vip-content-wrapper">
              <div className="monthcard-vip-header">
                <div className="monthcard-vip-name">{status?.name || '修行月卡'}</div>
              </div>
              
              <div className="monthcard-vip-main">
                <div className="monthcard-vip-status">
                  <div className="monthcard-vip-status-value">{panelState.statusValue}</div>
                  <div className="monthcard-vip-status-hint">{panelState.statusHint}</div>
                </div>
                
                <div className="monthcard-vip-action">
                  <Button 
                    type="primary" 
                    onClick={doUseItem} 
                    disabled={acting || loading || !monthCardItem?.instanceId}
                    className="monthcard-vip-btn"
                  >
                    {monthCardItem?.instanceId ? panelState.actionLabel : '无月卡道具'}
                  </Button>
                  <div className="monthcard-vip-action-meta">背包已存：{monthCardItem?.qty ? `${monthCardItem.qty} 个` : '0 个'}</div>
                </div>
              </div>
            </div>
          </div>

          <div className="monthcard-privileges">
            <div className="monthcard-section-title">月卡专属特权</div>
            <div className="monthcard-privilege-list">
              {privileges.map((privilege) => {
                const IconComp = privilegeIconMap[privilege.iconName];

                return (
                  <div key={privilege.id} className="monthcard-privilege-item">
                    <div className="monthcard-privilege-icon">
                      <IconComp />
                    </div>
                    <div className="monthcard-privilege-info">
                      <div className="monthcard-privilege-name">{privilege.name}</div>
                      <div className="monthcard-privilege-desc">{privilege.description}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="monthcard-claim-panel">
            <div className="monthcard-section-title">每日领礼</div>
            <div className="monthcard-claim-content">
              <div className="monthcard-reward-grid">
                {dailyRewards.map((r) => (
                  <div key={r.id} className="monthcard-reward">
                    <img className="monthcard-reward-icon" src={r.icon} alt={r.name} />
                    <div className="monthcard-reward-meta">
                      <div className="monthcard-reward-name">{r.name}</div>
                      <div className="monthcard-reward-amount">x{r.amount}</div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="monthcard-claim-action">
                <Button type="primary" disabled={!canClaim || acting || loading} loading={acting && canClaim} onClick={claim}>
                  {today === lastClaimDate ? '今日已领取' : '领取奖励'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
};

export default MonthCardModal;
