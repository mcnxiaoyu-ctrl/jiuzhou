/**
 * 宗门建筑面板。
 * 输入：建筑列表、升级权限、升级动作。
 * 输出：建筑效果、升级需求与升级按钮。
 * 约束：
 * 1) 按钮禁用规则 = 必须有权限 + 可升级 + 资源足够。
 * 2) 升级建筑需要二次确认，提示消耗的资源。
 */
import { App, Button, Tag, Tooltip } from 'antd';
import {
  ArrowRightOutlined,
} from '@ant-design/icons';
import {
  BLESSING_HALL_BUILDING_TYPE,
  formatBlessingBuildingFuyuanBonus,
} from '../constants';
import type { SectBuildingVm, SectPermissionState } from '../types';

interface BuildingsPanelProps {
  buildings: SectBuildingVm[];
  permissions: SectPermissionState;
  actionLoadingKey: string | null;
  onUpgrade: (buildingType: string) => void;
  onBless: () => void;
}

const formatBlessingExpireAt = (expireAt: string | null): string => {
  if (!expireAt) return '';
  const parsed = new Date(expireAt);
  if (!Number.isFinite(parsed.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(parsed);
};

const BuildingsPanel: React.FC<BuildingsPanelProps> = ({ buildings, permissions, actionLoadingKey, onUpgrade, onBless }) => {
  const { modal } = App.useApp();

  const handleUpgradeClick = (building: SectBuildingVm) => {
    const funds = building.requirement.funds ?? 0;
    const buildPoints = building.requirement.buildPoints ?? 0;
    modal.confirm({
      title: `确认升级「${building.name}」？`,
      content: `升级将消耗宗门资金 ${funds.toLocaleString()} 和建设点 ${buildPoints.toLocaleString()}。`,
      okText: '确认升级',
      cancelText: '取消',
      onOk: async () => {
        await onUpgrade(building.buildingType);
      },
    });
  };

  const handleBlessClick = (building: SectBuildingVm) => {
    if (!building.blessing?.canBless) return;
    modal.confirm({
      title: `确认在「${building.name}」祈福？`,
      content: `本次将获得 ${building.blessing.durationHours} 小时福源 +${formatBlessingBuildingFuyuanBonus(building.blessing.availableFuyuanBonus)} 全局 Buff，今日仅可进行 1 次。`,
      okText: '确认祈福',
      cancelText: '取消',
      onOk: async () => {
        await onBless();
      },
    });
  };

  return (
    <div className="sect-pane">
      <div className="sect-pane-top">
        <div className="sect-pane-title-wrap">
          <div className="sect-title">宗门建筑</div>
          <div className="sect-subtitle">建设宗门基业，提升建筑等级以解锁更多功能。</div>
        </div>
      </div>

      <div className="sect-pane-body sect-panel-scroll">
        <div className="sect-building-grid">
          {buildings.map((building) => {
            const canTriggerUpgrade = building.requirement.upgradable && permissions.canUpgradeBuilding && building.canAfford;
            const loadingKey = `upgrade-${building.buildingType}`;
            const blessLoadingKey = `bless-${building.buildingType}`;
            
            const upgradeLabel = !building.requirement.upgradable
              ? building.requirement.reason || '已达上限'
              : !permissions.canUpgradeBuilding
                ? '权限不足'
                : !building.canAfford
                  ? '资源不足'
                  : '提升等级';
            const blessingStatusText = building.blessing
              ? building.blessing.active && building.blessing.expireAt
                ? `当前祈福：福源 +${formatBlessingBuildingFuyuanBonus(building.blessing.fuyuanBonus)}，至 ${formatBlessingExpireAt(building.blessing.expireAt)} 结束`
                : building.blessing.blessedToday
                  ? '今日祈福已完成，本次福源加成已结束'
                  : `今日可祈福 1 次，持续 ${building.blessing.durationHours} 小时`
              : '';
            const blessLabel = building.blessing?.canBless ? '立即祈福' : '今日已祈福';

            return (
              <div key={building.id} className={`sect-building-card${building.requirement.upgradable ? '' : ' is-maxed'}`}>
                {/* 建筑头部：基础信息 */}
                <div className="sect-building-header">
                  <div className="sect-building-info">
                    <div className="sect-building-name-row">
                      <div className="sect-building-name">{building.name}</div>
                      <Tag color={building.requirement.upgradable ? 'blue' : 'orange'} className="sect-building-tag">
                        {building.requirement.upgradable ? `Lv.${building.level}` : '已满级'}
                      </Tag>
                    </div>
                  </div>
                </div>

                {/* 建筑描述与效果 */}
                <div className="sect-building-content">
                  <div className="sect-building-desc">{building.desc}</div>
                  <div className="sect-building-effect">
                    <div className="effect-row">
                      <div className="effect-side">
                        <span className="side-label">当前</span>
                        <span className="side-val">{building.effect}</span>
                      </div>
                      {building.nextEffect && (
                        <>
                          <ArrowRightOutlined className="side-arrow" />
                          <div className="effect-side next">
                            <span className="side-label">下级</span>
                            <span className="side-val">{building.nextEffect}</span>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                {/* 升级需求区域 */}
                <div className="sect-building-footer">
                  {building.requirement.upgradable ? (
                    <div className="sect-building-upgrade-zone">
                      <div className="sect-building-costs">
                        <Tooltip title={building.fundsGap > 0 ? `还差 ${building.fundsGap.toLocaleString()} 宗门资金` : ''}>
                          <div className={`cost-item ${building.fundsGap > 0 ? 'is-lack' : ''}`}>
                            <span className="cost-label">宗门资金:</span>
                            <span className="cost-val">{(building.requirement.funds ?? 0).toLocaleString()}</span>
                          </div>
                        </Tooltip>
                        <Tooltip title={building.buildPointsGap > 0 ? `还差 ${building.buildPointsGap.toLocaleString()} 建设点` : ''}>
                          <div className={`cost-item ${building.buildPointsGap > 0 ? 'is-lack' : ''}`}>
                            <span className="cost-label">建设点:</span>
                            <span className="cost-val">{(building.requirement.buildPoints ?? 0).toLocaleString()}</span>
                          </div>
                        </Tooltip>
                      </div>
                      <Button
                        type="primary"
                        size="middle"
                        className="upgrade-btn"
                        disabled={!canTriggerUpgrade}
                        loading={actionLoadingKey === loadingKey}
                        onClick={() => handleUpgradeClick(building)}
                      >
                        {upgradeLabel}
                      </Button>
                    </div>
                  ) : (
                    <div className="sect-building-maxed-tip">
                      {building.requirement.reason || '此建筑已修至圆满'}
                    </div>
                  )}
                </div>

                {building.buildingType === BLESSING_HALL_BUILDING_TYPE && building.blessing ? (
                  <div className="sect-building-action-zone">
                    <div className="sect-building-action-text">{blessingStatusText}</div>
                    <Button
                      type="default"
                      size="middle"
                      className="sect-building-action-btn"
                      disabled={!building.blessing.canBless}
                      loading={actionLoadingKey === blessLoadingKey}
                      onClick={() => handleBlessClick(building)}
                    >
                      {blessLabel}
                    </Button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default BuildingsPanel;
