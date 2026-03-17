/**
 * IdleConfigPanel — 挂机配置面板
 *
 * 作用：
 *   提供地图/房间选择、伙伴参战开关、最大挂机时长（基础 8 小时，月卡生效时可到 12 小时）、技能策略槽位（最多 6 个）的配置界面。
 *   Stamina 不足时禁用"开始挂机"按钮并显示提示。
 *   不包含任何状态管理逻辑，所有状态通过 props 传入。
 *
 * 输入/输出：
 *   - config: 当前配置草稿
 *   - isActive: 是否有活跃会话（有则禁用配置修改）
 *   - onConfigChange: 配置变更回调
 *   - onStart: 开始挂机回调
 *   - onStop: 停止挂机回调
 *
 * 数据流：
 *   useIdleBattle.config → props.config → 本地 Select/Slider 展示
 *   用户操作 → onConfigChange → useIdleBattle.setConfig → 重新渲染
 *
 * 关键边界条件：
 *   1. isActive = true 时地图/房间/伙伴开关/时长/技能策略均不可修改（只读展示）
 *   3. 技能槽位最多 6 个，超出时"添加槽位"按钮 disabled
 */

import React, { useEffect, useState } from 'react';
import { Button, Select, Slider, Switch, Tag, Tooltip } from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import { getEnabledMaps, getMapDetail, type MapDefLite, type MapRoom } from '../../../../../services/api/world';
import { getCharacterTechniqueStatus } from '../../../../../services/api/technique';
import { gameSocket } from '../../../../../services/gameSocket';
import type { IdleConfigDto } from '../types';
import { buildMonsterOptions, filterIdleMaps, filterRoomsWithMonsters } from '../utils/idleMapOptions';
import {
  BASE_IDLE_MAX_DURATION_MS,
  getIdleDurationPresetOptions,
  getIdleDurationSliderMaxMinutes,
} from '../utils/idleDurationOptions';
import './IdleConfigPanel.scss';

/** 可选技能项（从角色功法状态 API 获取） */
interface AvailableSkillOption {
  skillId: string;
  skillName: string;
  skillIcon: string;
}

// ============================================
// 常量
// ============================================

const MIN_DURATION_MS = 600_000;
const MAX_SKILL_SLOTS = 6;

// ============================================
// Props
// ============================================

interface IdleConfigPanelProps {
  config: IdleConfigDto;
  maxDurationLimitMs: number;
  monthCardActive: boolean;
  isActive: boolean;
  isStopping: boolean;
  isLoading: boolean;
  onConfigChange: (patch: Partial<IdleConfigDto>) => void;
  onStart: () => void;
  onStop: () => void;
  onSave: () => void;
}

// ============================================
// 组件
// ============================================

const IdleConfigPanel: React.FC<IdleConfigPanelProps> = ({
  config,
  maxDurationLimitMs,
  monthCardActive,
  isActive,
  isStopping,
  isLoading,
  onConfigChange,
  onStart,
  onStop,
  onSave,
}) => {
  const [maps, setMaps] = useState<MapDefLite[]>([]);
  const [rooms, setRooms] = useState<MapRoom[]>([]);
  const [mapsLoading, setMapsLoading] = useState(false);
  const [roomsLoading, setRoomsLoading] = useState(false);
  const [availableSkills, setAvailableSkills] = useState<AvailableSkillOption[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);

  // 加载地图列表
  useEffect(() => {
    setMapsLoading(true);
    void getEnabledMaps()
      .then((res) => {
        const allMaps = res.success && res.data?.maps ? res.data.maps : [];
        setMaps(filterIdleMaps(allMaps));
      })
      .catch(() => setMaps([]))
      .finally(() => setMapsLoading(false));
  }, []);

  // 地图变更时加载房间列表
  useEffect(() => {
    if (!config.mapId) {
      setRooms([]);
      return;
    }
    setRoomsLoading(true);
    void getMapDetail(config.mapId)
      .then((res) => {
        const allRooms = res.success && res.data?.rooms ? res.data.rooms : [];
        setRooms(filterRoomsWithMonsters(allRooms));
      })
      .catch(() => setRooms([]))
      .finally(() => setRoomsLoading(false));
  }, [config.mapId]);

  // 加载角色可用技能列表（订阅角色数据，确保 characterId 可用后再请求）
  // 合并 equippedSkills（已装备到技能栏，含普通攻击等先天技能）和 availableSkills（功法解锁的），去重
  useEffect(() => {
    let cancelled = false;

    const loadSkills = (charId: number) => {
      setSkillsLoading(true);
      void getCharacterTechniqueStatus(charId)
        .then((res) => {
          if (cancelled || !res.success || !res.data) return;
          const seen = new Set<string>();
          const merged: AvailableSkillOption[] = [];

          // 已装备技能栏的技能（含先天技能如普通攻击）
          for (const s of res.data.equippedSkills) {
            if (!s.skill_id || seen.has(s.skill_id)) continue;
            seen.add(s.skill_id);
            merged.push({
              skillId: s.skill_id,
              skillName: s.skill_name ?? s.skill_id,
              skillIcon: s.skill_icon ?? '',
            });
          }

          // 功法解锁但未装备的技能
          for (const s of res.data.availableSkills) {
            if (seen.has(s.skillId)) continue;
            seen.add(s.skillId);
            merged.push({
              skillId: s.skillId,
              skillName: s.skillName,
              skillIcon: s.skillIcon,
            });
          }

          setAvailableSkills(merged);
        })
        .finally(() => { if (!cancelled) setSkillsLoading(false); });
    };

    // 尝试立即加载（角色数据可能已就绪）
    const charId = gameSocket.getCharacter()?.id;
    if (charId) {
      loadSkills(charId);
    }

    // 订阅角色更新，首次拿到 id 时加载
    const unsub = gameSocket.onCharacterUpdate((c) => {
      if (cancelled || !c?.id) return;
      setAvailableSkills((prev) => {
        if (prev.length === 0) loadSkills(c.id);
        return prev;
      });
    });

    return () => { cancelled = true; unsub(); };
  }, []);

  const handleMapChange = (mapId: string) => {
    onConfigChange({ mapId, roomId: null, targetMonsterDefId: null });
  };

  const handleRoomChange = (roomId: string) => {
    onConfigChange({ roomId, targetMonsterDefId: null });
  };

  const handleMonsterChange = (targetMonsterDefId: string) => {
    onConfigChange({ targetMonsterDefId });
  };

  const handleDurationChange = (ms: number) => {
    onConfigChange({ maxDurationMs: ms });
  };

  const handlePartnerToggleChange = (checked: boolean) => {
    onConfigChange({ includePartnerInBattle: checked });
  };

  // 技能槽位操作（顺序即优先级，无需独立 priority 输入）
  const handleAddSlot = () => {
    if (config.autoSkillPolicy.slots.length >= MAX_SKILL_SLOTS) return;
    const nextPriority = config.autoSkillPolicy.slots.length + 1;
    onConfigChange({
      autoSkillPolicy: {
        slots: [...config.autoSkillPolicy.slots, { skillId: '', priority: nextPriority }],
      },
    });
  };

  const handleRemoveSlot = (index: number) => {
    // 移除后重新编号 priority（顺序即优先级）
    const next = config.autoSkillPolicy.slots
      .filter((_, i) => i !== index)
      .map((slot, i) => ({ ...slot, priority: i + 1 }));
    onConfigChange({ autoSkillPolicy: { slots: next } });
  };

  const handleSlotSkillChange = (index: number, skillId: string) => {
    const next = config.autoSkillPolicy.slots.map((slot, i) =>
      i === index ? { ...slot, skillId } : slot
    );
    onConfigChange({ autoSkillPolicy: { slots: next } });
  };

  // 从当前选中房间派生怪物选项
  const currentRoom = rooms.find((r) => r.id === config.roomId);
  const monsterOptions = buildMonsterOptions(currentRoom);

  const canStart = !!config.mapId && !!config.roomId && !!config.targetMonsterDefId && !isActive;
  const durationMinutes = Math.round(config.maxDurationMs / 60_000);
  const durationPresetOptions = getIdleDurationPresetOptions(maxDurationLimitMs);
  const sliderMaxMinutes = getIdleDurationSliderMaxMinutes(maxDurationLimitMs);
  const extendedDurationEnabled = maxDurationLimitMs > BASE_IDLE_MAX_DURATION_MS;

  return (
    <div className="idle-config-panel">
      {/* 第一区：地图、房间与队伍 */}
      <div className="idle-config-section">
        <div className="idle-config-grid">
          <div className="idle-config-field">
            <label className="idle-config-label">挂机地图</label>
            <Select
              className="idle-config-select"
              value={config.mapId ?? undefined}
              onChange={handleMapChange}
              loading={mapsLoading}
              disabled={isActive || isStopping}
              placeholder="选择地图"
              options={maps.map((m) => ({ value: m.id, label: m.name }))}
            />
          </div>
          <div className="idle-config-field">
            <label className="idle-config-label">挂机房间</label>
            <Select
              className="idle-config-select"
              value={config.roomId ?? undefined}
              onChange={handleRoomChange}
              loading={roomsLoading}
              disabled={isActive || isStopping || !config.mapId}
              placeholder="选择房间"
              options={rooms.map((r) => ({
                value: r.id,
                label: r.name,
                title: r.description,
              }))}
            />
          </div>
          <div className="idle-config-field">
            <label className="idle-config-label">挂机怪物</label>
            <Select
              className="idle-config-select"
              value={config.targetMonsterDefId ?? undefined}
              onChange={handleMonsterChange}
              disabled={isActive || isStopping || !config.roomId || monsterOptions.length === 0}
              placeholder="选择怪物"
              options={monsterOptions}
            />
          </div>
          <div className="idle-config-field">
            <label className="idle-config-label">伙伴参战</label>
            <div className="idle-config-partner-toggle">
              <span className="idle-config-partner-desc">
                自动携带当前出战伙伴
              </span>
              <Switch
                size="small"
                checked={config.includePartnerInBattle}
                onChange={handlePartnerToggleChange}
                disabled={isActive || isStopping}
              />
            </div>
          </div>
        </div>
      </div>

      {/* 第二区：挂机时长 */}
      <div className="idle-config-section">
        <label className="idle-config-label">挂机时长</label>
        <div className="idle-config-duration">
          {extendedDurationEnabled && monthCardActive && (
            <div className="idle-config-partner-toggle">
              <span className="idle-config-partner-desc">月卡生效中，当前离线挂机上限已提升至 12 小时</span>
            </div>
          )}
          <div className="idle-config-duration-tags">
            {durationPresetOptions.map((p) => (
              <Tag.CheckableTag
                key={p.value}
                checked={config.maxDurationMs === p.value}
                onChange={() => !isActive && !isStopping && handleDurationChange(p.value)}
              >
                {p.label}
              </Tag.CheckableTag>
            ))}
          </div>
          <div className="idle-config-duration-slider">
            <Slider
              min={MIN_DURATION_MS / 60_000}
              max={sliderMaxMinutes}
              step={10}
              value={durationMinutes}
              onChange={(v) => handleDurationChange(v * 60_000)}
              disabled={isActive || isStopping}
              tooltip={{ formatter: (v) => `${v}分钟` }}
            />
            <span className="idle-config-duration-value">{durationMinutes} 分钟</span>
          </div>
        </div>
      </div>

      {/* 第三区：技能策略 */}
      <div className="idle-config-section idle-config-section--skills">
        <label className="idle-config-label">
          技能策略
          <span className="idle-config-label-hint">（按顺序释放，最多 {MAX_SKILL_SLOTS} 个）</span>
        </label>
        <div className="idle-skill-slots">
          {config.autoSkillPolicy.slots.map((slot, index) => (
            <div key={index} className="idle-skill-slot">
              <span className="idle-skill-slot-priority">{index + 1}</span>
              <Select
                className="idle-skill-slot-select"
                value={slot.skillId || undefined}
                placeholder="选择技能"
                onChange={(v) => handleSlotSkillChange(index, v)}
                disabled={isActive || isStopping}
                loading={skillsLoading}
                size="small"
                options={availableSkills.map((s) => ({
                  value: s.skillId,
                  label: s.skillName,
                }))}
                showSearch
                optionFilterProp="label"
              />
              <Button
                type="text"
                danger
                icon={<DeleteOutlined />}
                onClick={() => handleRemoveSlot(index)}
                disabled={isActive || isStopping}
                size="small"
                aria-label={`删除第 ${index + 1} 个技能`}
              />
            </div>
          ))}
          {config.autoSkillPolicy.slots.length < MAX_SKILL_SLOTS && (
            <button
              type="button"
              className="idle-skill-add-btn"
              onClick={handleAddSlot}
              disabled={isActive || isStopping}
            >
              <PlusOutlined />
              <span>添加技能</span>
            </button>
          )}
        </div>
      </div>

      {/* 操作按钮 */}
      <div className="idle-config-actions">
        {!isActive && !isStopping ? (
          <>
            <Button onClick={onSave} disabled={isLoading}>
              保存配置
            </Button>
            <Tooltip title={(!config.mapId || !config.roomId) ? '请先选择地图和房间' : !config.targetMonsterDefId ? '请选择挂机怪物' : ''}>
              <Button
                type="primary"
                onClick={onStart}
                disabled={!canStart || isLoading}
                loading={isLoading}
              >
                开始挂机
              </Button>
            </Tooltip>
          </>
        ) : (
          <Button
            danger
            onClick={onStop}
            loading={isStopping}
            disabled={isStopping}
          >
            {isStopping ? '停止中...' : '停止挂机'}
          </Button>
        )}
      </div>
    </div>
  );
};

export default IdleConfigPanel;
