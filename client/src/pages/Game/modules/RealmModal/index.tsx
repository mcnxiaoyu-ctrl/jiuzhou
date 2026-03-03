import { App, Button, Modal, Progress, Tag } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { CharacterData } from '../../../../services/gameSocket';
import { gameSocket } from '../../../../services/gameSocket';
import {
  breakthroughToNextRealm,
  getInsightOverview,
  getRealmOverview,
  injectInsightExp,
  type InsightInjectResultDto,
  type InsightOverviewDto,
  type RealmOverviewDto,
} from '../../../../services/api';
import { resolveIconUrl, DEFAULT_ICON as coin01 } from '../../shared/resolveIcon';
import { IMG_LINGSHI as lingshiIcon, IMG_TONGQIAN as tongqianIcon } from '../../shared/imageAssets';
import { useIsMobile } from '../../shared/responsive';
import { REALM_ORDER, getRealmRankFromAlias, normalizeRealmWithAlias } from '../../shared/realm';
import InsightPanel from './InsightPanel';
import {
  calcInsightProgressPct,
  simulateInsightInjectByExp,
  type InsightGrowthStageConfig,
} from './insightShared';
import './index.scss';

interface RealmModalProps {
  open: boolean;
  onClose: () => void;
  character: CharacterData | null;
}

type RealmRank = {
  currentIdx: number;
  total: number;
  current: string;
  next: string | null;
};

type RequirementRow = {
  id: string;
  title: string;
  detail: string;
  status: 'done' | 'todo' | 'unknown';
};

type CostRow = {
  id: string;
  name: string;
  amountText: string;
  icon?: string;
};

type RewardRow = {
  id: string;
  title: string;
  detail: string;
};

type UnlockRow = {
  id: string;
  title: string;
  detail: string;
};

type RealmPaneKey = 'breakthrough' | 'insight';
type MobileSectionKey = 'requirements' | 'costs' | 'rewards' | 'unlocks';

const resolveIcon = resolveIconUrl;

const buildRealmRank = (character: CharacterData | null): RealmRank => {
  const current = normalizeRealmWithAlias(character?.realm ?? '凡人');
  const currentIdx = getRealmRankFromAlias(current);
  const next = currentIdx + 1 < REALM_ORDER.length ? REALM_ORDER[currentIdx + 1] : null;
  return { currentIdx, total: REALM_ORDER.length, current, next };
};

const getRequirementTag = (status: RequirementRow['status']) => {
  if (status === 'done') return <Tag color="green">已满足</Tag>;
  if (status === 'todo') return <Tag color="red">未满足</Tag>;
  return <Tag>未知</Tag>;
};

const INSIGHT_HOLD_START_STEP_EXP = 1;
const INSIGHT_HOLD_STEP_ACCEL_BASE_PER_SEC = 120;
const INSIGHT_HOLD_STEP_ACCEL_GROWTH_PER_SEC2 = 800;
const INSIGHT_HOLD_MAX_STEP_EXP = 120_000;

interface InsightHoldBaseSnapshot {
  currentLevel: number;
  currentProgressExp: number;
  characterExp: number;
  growth: InsightGrowthStageConfig;
}

const RealmModal: React.FC<RealmModalProps> = ({ open, onClose, character }) => {
  const { message } = App.useApp();

  const [overview, setOverview] = useState<RealmOverviewDto | null>(null);
  const [breakthroughLoading, setBreakthroughLoading] = useState(false);
  const [insightOverview, setInsightOverview] = useState<InsightOverviewDto | null>(null);
  const [insightLoading, setInsightLoading] = useState(false);
  const [insightInjecting, setInsightInjecting] = useState(false);
  const [insightHolding, setInsightHolding] = useState(false);
  const [insightHoldGainLevels, setInsightHoldGainLevels] = useState(0);
  const [insightHoldSpentExp, setInsightHoldSpentExp] = useState(0);
  const [insightHoldGainBonusPct, setInsightHoldGainBonusPct] = useState(0);
  const [insightHoldAfterProgressExp, setInsightHoldAfterProgressExp] = useState(0);
  const [insightHoldNextLevelCostExp, setInsightHoldNextLevelCostExp] = useState(0);
  const [activePane, setActivePane] = useState<RealmPaneKey>('breakthrough');
  const isMobile = useIsMobile();
  const [mobileSection, setMobileSection] = useState<MobileSectionKey>('requirements');
  const insightOverviewRef = useRef<InsightOverviewDto | null>(null);
  const insightHoldingRef = useRef(false);
  const insightHoldBaseRef = useRef<InsightHoldBaseSnapshot | null>(null);
  const insightHoldIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const insightHoldStartTimestampRef = useRef<number | null>(null);
  const insightHoldLastTimestampRef = useRef<number | null>(null);
  const insightHoldSpentFloatRef = useRef(0);
  const insightHoldStepFloatRef = useRef(INSIGHT_HOLD_START_STEP_EXP);
  const insightHoldSpentExpRef = useRef(0);

  const refreshOverview = useCallback(async () => {
    if (!open) return;
    try {
      const res = await getRealmOverview();
      if (res.success && res.data) {
        setOverview(res.data);
      } else {
        setOverview(null);
        void 0;
      }
    } catch {
      setOverview(null);
      void 0;
    }
  }, [open]);

  const refreshInsightOverview = useCallback(async () => {
    if (!open) return;
    setInsightLoading(true);
    try {
      const res = await getInsightOverview();
      if (res.success && res.data) {
        setInsightOverview(res.data);
      } else {
        setInsightOverview(null);
      }
    } catch {
      setInsightOverview(null);
    } finally {
      setInsightLoading(false);
    }
  }, [open]);

  useEffect(() => {
    if (open) {
      void refreshOverview();
      void refreshInsightOverview();
    } else {
      insightHoldingRef.current = false;
      if (insightHoldIntervalRef.current !== null) {
        clearInterval(insightHoldIntervalRef.current);
        insightHoldIntervalRef.current = null;
      }
      insightHoldBaseRef.current = null;
      insightHoldStartTimestampRef.current = null;
      insightHoldLastTimestampRef.current = null;
      insightHoldSpentFloatRef.current = 0;
      insightHoldStepFloatRef.current = INSIGHT_HOLD_START_STEP_EXP;
      insightHoldSpentExpRef.current = 0;
      setOverview(null);
      setInsightOverview(null);
      setInsightHolding(false);
      setInsightHoldGainLevels(0);
      setInsightHoldSpentExp(0);
      setInsightHoldGainBonusPct(0);
      setInsightHoldAfterProgressExp(0);
      setInsightHoldNextLevelCostExp(0);
      setActivePane('breakthrough');
    }
  }, [open, refreshInsightOverview, refreshOverview]);

  useEffect(() => {
    insightOverviewRef.current = insightOverview;
  }, [insightOverview]);

  useEffect(() => {
    if (insightHolding) return;
    if (!insightOverview) {
      setInsightHoldAfterProgressExp(0);
      setInsightHoldNextLevelCostExp(0);
      return;
    }
    setInsightHoldAfterProgressExp(insightOverview.currentProgressExp);
    setInsightHoldNextLevelCostExp(insightOverview.nextLevelCostExp);
  }, [insightHolding, insightOverview]);

  const rank = useMemo<RealmRank>(() => {
    if (overview) {
      const total = Math.max(1, overview.realmOrder.length);
      const currentIdx = Math.max(0, Number(overview.currentIndex ?? 0) || 0);
      const current = String(overview.currentRealm || '凡人');
      const next = overview.nextRealm ? String(overview.nextRealm) : null;
      return { currentIdx, total, current, next };
    }
    return buildRealmRank(character);
  }, [character, overview]);

  const plan = useMemo(() => {
    if (overview) {
      const requirements: RequirementRow[] = (overview.requirements ?? []).map((r) => ({
        id: r.id,
        title: r.title,
        detail: r.detail,
        status: r.status,
      }));
      const costs: CostRow[] = (overview.costs ?? []).map((c) => ({
        id: c.id,
        name: c.title,
        amountText: c.detail,
        icon:
          c.type === 'item'
            ? resolveIcon(c.itemIcon)
            : c.type === 'spirit_stones'
              ? lingshiIcon
              : c.type === 'exp'
                ? tongqianIcon
                : coin01,
      }));
      return { requirements, costs };
    }
    return { requirements: [] as RequirementRow[], costs: [] as CostRow[] };
  }, [overview]);

  const outcome = useMemo(() => {
    if (overview) {
      const rewards: RewardRow[] = (overview.rewards ?? []).map((r) => ({ id: r.id, title: r.title, detail: r.detail }));
      return { rewards, unlocks: [] as UnlockRow[] };
    }
    return { rewards: [] as RewardRow[], unlocks: [] as UnlockRow[] };
  }, [overview]);

  const mobileTabs = useMemo<Array<{ key: MobileSectionKey; label: string }>>(() => {
    const tabs: Array<{ key: MobileSectionKey; label: string }> = [
      { key: 'requirements', label: '条件' },
      { key: 'costs', label: '消耗' },
      { key: 'rewards', label: '收益' },
    ];

    if (outcome.unlocks.length > 0) tabs.push({ key: 'unlocks', label: '解锁' });

    return tabs;
  }, [outcome.unlocks.length]);

  useEffect(() => {
    if (!open) {
      setMobileSection('requirements');
      return;
    }

    if (!mobileTabs.some((tab) => tab.key === mobileSection)) {
      setMobileSection(mobileTabs[0]?.key ?? 'requirements');
    }
  }, [mobileSection, mobileTabs, open]);

  const progressPercent = useMemo(() => {
    const totalSteps = Math.max(1, rank.total - 1);
    return Math.max(0, Math.min(100, (rank.currentIdx / totalSteps) * 100));
  }, [rank.currentIdx, rank.total]);

  const canBreakthrough = useMemo(() => {
    if (!rank.next) return false;
    if (overview) return !!overview.canBreakthrough;
    if (plan.requirements.length === 0) return false;
    return plan.requirements.every((r) => r.status === 'done');
  }, [overview, plan.requirements, rank.next]);

  const insightUpgradeProgressPct = useMemo(() => {
    const isPreviewing = insightHolding || insightHoldSpentExp > 0;
    if (isPreviewing) {
      return calcInsightProgressPct(insightHoldAfterProgressExp, insightHoldNextLevelCostExp);
    }
    if (!insightOverview) return 0;
    return calcInsightProgressPct(insightOverview.currentProgressExp, insightOverview.nextLevelCostExp);
  }, [insightHoldAfterProgressExp, insightHoldNextLevelCostExp, insightHoldSpentExp, insightHolding, insightOverview]);

  /**
   * 悟道展示进度（分子/分母）：
   * - 长按中使用前端模拟值，保证数字与进度条同步滚动；
   * - 非长按时回落到服务端总览值。
   */
  const insightDisplayProgress = useMemo(() => {
    const isPreviewing = insightHolding || insightHoldSpentExp > 0;
    if (isPreviewing) {
      return {
        progressExp: insightHoldAfterProgressExp,
        nextLevelCostExp: insightHoldNextLevelCostExp,
      };
    }
    return {
      progressExp: insightOverview?.currentProgressExp ?? 0,
      nextLevelCostExp: insightOverview?.nextLevelCostExp ?? 0,
    };
  }, [insightHoldAfterProgressExp, insightHoldNextLevelCostExp, insightHoldSpentExp, insightHolding, insightOverview]);

  const insightInjectDisabled = useMemo(() => {
    return (
      !insightOverview ||
      !insightOverview.unlocked ||
      insightLoading ||
      insightOverview.characterExp <= 0
    );
  }, [insightLoading, insightOverview]);

  const displayExp = overview ? Number(overview.exp ?? 0) : Number(character?.exp ?? 0);
  const displaySpiritStones = overview ? Number(overview.spiritStones ?? 0) : Number(character?.spiritStones ?? 0);

  const handleBreakthrough = useCallback(async () => {
    if (!rank.next) return;
    setBreakthroughLoading(true);
    try {
      const res = await breakthroughToNextRealm();
      if (!res.success) {
        void 0;
        return;
      }
      message.success(res.message || '突破成功');
      gameSocket.refreshCharacter();
      void refreshOverview();
    } catch {
      void 0;
    } finally {
      setBreakthroughLoading(false);
    }
  }, [message, rank.next, refreshOverview]);

  const handleInjectInsight = useCallback(
    async (exp: number, options?: { silent?: boolean }): Promise<InsightInjectResultDto | null> => {
      if (!insightOverview || !insightOverview.unlocked) return null;
      setInsightInjecting(true);
      try {
        const res = await injectInsightExp({ exp });
        if (!res.success || !res.data) {
          if (!options?.silent) message.error(res.message || '悟道失败');
          return null;
        }

        if (!options?.silent) message.success(res.message || '悟道成功');

        gameSocket.refreshCharacter();
        await Promise.all([refreshOverview(), refreshInsightOverview()]);
        return res.data;
      } catch {
        if (!options?.silent) message.error('悟道失败');
        return null;
      } finally {
        setInsightInjecting(false);
      }
    },
    [insightOverview, message, refreshInsightOverview, refreshOverview],
  );

  /**
   * 重置本次长按会话预览状态。
   *
   * 说明：
   * - 这里只清理“前端模拟”数值，不触发后端请求。
   * - 统一复用，避免在多个路径重复写同样清零逻辑。
   */
  const resetInsightHoldPreview = useCallback(() => {
    insightHoldSpentFloatRef.current = 0;
    insightHoldStepFloatRef.current = INSIGHT_HOLD_START_STEP_EXP;
    insightHoldSpentExpRef.current = 0;
    setInsightHoldGainLevels(0);
    setInsightHoldSpentExp(0);
    setInsightHoldGainBonusPct(0);
  }, []);

  /**
   * 取消长按模拟（不提交后端）。
   *
   * 说明：
   * - 仅做状态机收口与动画帧清理；
   * - 用于页签切换、弹窗关闭、组件卸载等“非松手提交”路径。
   */
  const cancelInsightHoldInject = useCallback(() => {
    insightHoldingRef.current = false;
    if (insightHoldIntervalRef.current !== null) {
      clearInterval(insightHoldIntervalRef.current);
      insightHoldIntervalRef.current = null;
    }
    insightHoldBaseRef.current = null;
    insightHoldStartTimestampRef.current = null;
    insightHoldLastTimestampRef.current = null;
    setInsightHolding(false);
  }, []);

  /**
   * 把“当前注入经验预算”映射为一组可展示的悟道预览值。
   *
   * 说明：
   * 1) 该函数是长按模拟期唯一的预览更新入口，避免散落重复计算；
   * 2) 输入为预算经验，内部用共享规则函数得到等级、加成和进度变化；
   * 3) 会同步更新 `insightHoldSpentExpRef`，用于松手提交时读取最终经验值。
   */
  const applyInsightHoldPreview = useCallback((injectExpBudget: number) => {
    const base = insightHoldBaseRef.current;
    if (!base) return;

    const preview = simulateInsightInjectByExp({
      currentLevel: base.currentLevel,
      currentProgressExp: base.currentProgressExp,
      injectExp: injectExpBudget,
      growth: base.growth,
    });

    insightHoldSpentExpRef.current = preview.appliedExp;
    setInsightHoldSpentExp(preview.appliedExp);
    setInsightHoldGainLevels(preview.gainedLevels);
    setInsightHoldGainBonusPct(preview.gainedBonusPct);
    setInsightHoldAfterProgressExp(preview.afterProgressExp);
    setInsightHoldNextLevelCostExp(preview.nextLevelCostExp);
  }, []);

  /**
   * 执行一次前端长按模拟帧。
   *
   * 说明：
   * 1) 只在前端推进“已注入经验预算”，不访问后端；
   * 2) 注入步长从 1 开始并持续加速，形成“数字滚动越来越快”的观感；
   * 3) 每帧基于同一份快照做纯计算，避免前后状态抖动。
   */
  const runInsightHoldSimulationTick = useCallback(() => {
    if (!insightHoldingRef.current) return;
    const base = insightHoldBaseRef.current;
    if (!base) {
      cancelInsightHoldInject();
      return;
    }
    const now = performance.now();

    if (insightHoldStartTimestampRef.current === null || insightHoldLastTimestampRef.current === null) {
      insightHoldStartTimestampRef.current = now;
      insightHoldLastTimestampRef.current = now;
      /**
       * 首帧直接推进 1 点预算，确保按下后能立即看到从 1 开始滚动。
       */
      insightHoldSpentFloatRef.current = Math.min(
        base.characterExp,
        Math.max(insightHoldSpentFloatRef.current, INSIGHT_HOLD_START_STEP_EXP),
      );
      applyInsightHoldPreview(insightHoldSpentFloatRef.current);
      return;
    }

    const deltaSec = Math.max(0, (now - insightHoldLastTimestampRef.current) / 1000);
    const elapsedSec = Math.max(0, (now - insightHoldStartTimestampRef.current) / 1000);
    insightHoldLastTimestampRef.current = now;

    /**
     * 速度模型：
     * - step 初始为 1；
     * - 每秒按 (base + growth * elapsed) 增加步长，随时间越来越快；
     * - 每帧至少 +1，保证数字持续滚动。
     */
    const currentAccelPerSec = INSIGHT_HOLD_STEP_ACCEL_BASE_PER_SEC + INSIGHT_HOLD_STEP_ACCEL_GROWTH_PER_SEC2 * elapsedSec;
    insightHoldStepFloatRef.current = Math.min(
      INSIGHT_HOLD_MAX_STEP_EXP,
      insightHoldStepFloatRef.current + currentAccelPerSec * deltaSec,
    );
    const frameStepExp = Math.max(INSIGHT_HOLD_START_STEP_EXP, Math.floor(insightHoldStepFloatRef.current));

    insightHoldSpentFloatRef.current = Math.min(
      base.characterExp,
      insightHoldSpentFloatRef.current + frameStepExp,
    );
    applyInsightHoldPreview(insightHoldSpentFloatRef.current);
  }, [applyInsightHoldPreview, cancelInsightHoldInject]);

  /**
   * 开始长按注入模拟。
   *
   * 说明：
   * 1) 按下时只启动前端模拟，不立即提交后端；
   * 2) 松手时再以 `本次模拟经验` 一次性调用注入接口。
   */
  const startInsightHoldInject = useCallback(() => {
    if (insightHoldingRef.current) return;
    if (insightInjectDisabled || insightInjecting) return;
    const currentOverview = insightOverviewRef.current;
    if (!currentOverview || !currentOverview.unlocked) return;

    resetInsightHoldPreview();
    insightHoldBaseRef.current = {
      currentLevel: currentOverview.currentLevel,
      currentProgressExp: currentOverview.currentProgressExp,
      characterExp: currentOverview.characterExp,
      growth: {
        costStageLevels: currentOverview.costStageLevels,
        costStageBaseExp: currentOverview.costStageBaseExp,
        bonusPctPerLevel: currentOverview.bonusPctPerLevel,
      },
    };
    setInsightHoldAfterProgressExp(currentOverview.currentProgressExp);
    setInsightHoldNextLevelCostExp(currentOverview.nextLevelCostExp);
    insightHoldStartTimestampRef.current = null;
    insightHoldLastTimestampRef.current = null;
    setInsightHolding(true);
    insightHoldingRef.current = true;
    runInsightHoldSimulationTick();
    insightHoldIntervalRef.current = setInterval(runInsightHoldSimulationTick, 16);
  }, [insightInjectDisabled, insightInjecting, resetInsightHoldPreview, runInsightHoldSimulationTick]);

  /**
   * 松手结束长按：停止前端模拟并一次性提交后端。
   */
  const finishInsightHoldInject = useCallback(() => {
    if (!insightHoldingRef.current) return;
    const commitExp = Math.max(0, Math.floor(insightHoldSpentExpRef.current));
    cancelInsightHoldInject();
    if (commitExp <= 0) return;
    void handleInjectInsight(commitExp).then(() => {
      resetInsightHoldPreview();
    });
  }, [cancelInsightHoldInject, handleInjectInsight, resetInsightHoldPreview]);

  /**
   * 指针按下入口（统一鼠标/触控）：
   * 1) 仅响应主键鼠标，避免右键误触发；
   * 2) 禁用默认触控手势，避免长按过程中被浏览器手势中断。
   */
  const handleInsightPointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    startInsightHoldInject();
  }, [startInsightHoldInject]);

  /**
   * 指针释放入口：统一进入“停止模拟并提交后端”流程。
   */
  const handleInsightPointerUp = useCallback(() => {
    finishInsightHoldInject();
  }, [finishInsightHoldInject]);

  /**
   * 全局抬手监听：
   * - 防止手指/鼠标离开按钮后收不到元素级 pointerup，导致“长按状态卡住”。
   */
  useEffect(() => {
    if (!insightHolding) return;
    const onPointerFinish = () => {
      finishInsightHoldInject();
    };
    window.addEventListener('pointerup', onPointerFinish);
    window.addEventListener('pointercancel', onPointerFinish);
    return () => {
      window.removeEventListener('pointerup', onPointerFinish);
      window.removeEventListener('pointercancel', onPointerFinish);
    };
  }, [finishInsightHoldInject, insightHolding]);

  useEffect(() => {
    if (activePane !== 'insight') {
      cancelInsightHoldInject();
      resetInsightHoldPreview();
    }
  }, [activePane, cancelInsightHoldInject, resetInsightHoldPreview]);

  useEffect(() => {
    return () => {
      insightHoldingRef.current = false;
      if (insightHoldIntervalRef.current !== null) {
        clearInterval(insightHoldIntervalRef.current);
        insightHoldIntervalRef.current = null;
      }
    };
  }, []);

  const renderRequirementList = () => (
    <div className="realm-req-list">
      {plan.requirements.map((r) => (
        <div key={r.id} className="realm-req-item">
          <div className="realm-req-main">
            <div className="realm-req-head">
              <div className="realm-req-title">{r.title}</div>
              <div className="realm-req-tag">{getRequirementTag(r.status)}</div>
            </div>
            <div className="realm-req-detail">{r.detail}</div>
          </div>
        </div>
      ))}
      {plan.requirements.length === 0 ? <div className="realm-empty">暂无条件</div> : null}
    </div>
  );

  const renderCostList = () => (
    <div className="realm-costs">
      {plan.costs.map((c) => (
        <div key={c.id} className="realm-cost">
          <img className="realm-cost-icon" src={c.icon ?? coin01} alt={c.name} />
          <div className="realm-cost-name">{c.name}</div>
          <div className="realm-cost-amount">{c.amountText}</div>
        </div>
      ))}
      {plan.costs.length === 0 ? <div className="realm-empty">暂无消耗</div> : null}
    </div>
  );

  const renderRewardList = () => (
    <div className="realm-reward-list">
      {outcome.rewards.map((r) => (
        <div key={r.id} className="realm-reward-item">
          <div className="realm-reward-title">{r.title}</div>
          <div className="realm-reward-detail">{r.detail}</div>
        </div>
      ))}
      {outcome.rewards.length === 0 ? <div className="realm-empty">暂无收益</div> : null}
    </div>
  );

  const renderUnlockList = () => (
    <div className="realm-unlock-list">
      {outcome.unlocks.map((u) => (
        <div key={u.id} className="realm-unlock-item">
          <div className="realm-unlock-title">{u.title}</div>
          <div className="realm-unlock-detail">{u.detail}</div>
        </div>
      ))}
      {outcome.unlocks.length === 0 ? <div className="realm-empty">暂无解锁</div> : null}
    </div>
  );

  const renderRealmSummary = () => (
    <>
      <div className="realm-left-card">
        <div className="realm-left-card-k">当前境界</div>
        <div className="realm-left-card-v">{rank.current}</div>
        <div className="realm-left-card-sub">
          {rank.currentIdx + 1}/{rank.total}
        </div>
        <div className="realm-left-progress">
          <Progress percent={progressPercent} showInfo={false} strokeColor="var(--primary-color)" />
        </div>
      </div>

      <div className="realm-stats">
        <div className="realm-stat">
          <div className="realm-stat-k">经验</div>
          <div className="realm-stat-v">{displayExp.toLocaleString()}</div>
        </div>
        <div className="realm-stat">
          <div className="realm-stat-k">灵石</div>
          <div className="realm-stat-v">{displaySpiritStones.toLocaleString()}</div>
        </div>
        <div className="realm-stat">
          <div className="realm-stat-k">可用属性点</div>
          <div className="realm-stat-v">{(character?.attributePoints ?? 0).toLocaleString()}</div>
        </div>
      </div>
    </>
  );

  const renderActionButtons = () => (
    <>
      <Button onClick={onClose}>关闭</Button>
      <Button
        type="primary"
        disabled={!canBreakthrough}
        loading={breakthroughLoading}
        onClick={handleBreakthrough}
      >
        {rank.next ? '突破' : '已达巅峰'}
      </Button>
    </>
  );

  const paneTabs: Array<{ key: RealmPaneKey; label: string }> = [
    { key: 'breakthrough', label: '境界突破' },
    { key: 'insight', label: '悟道' },
  ];

  const mobileSectionTitle: Record<MobileSectionKey, string> = {
    requirements: '突破条件',
    costs: '消耗预览',
    rewards: '突破收益',
    unlocks: '联动解锁',
  };

  const activeMobileSection = mobileTabs.some((tab) => tab.key === mobileSection)
    ? mobileSection
    : mobileTabs[0]?.key ?? 'requirements';

  const renderMobileSectionContent = () => {
    if (activeMobileSection === 'requirements') return renderRequirementList();
    if (activeMobileSection === 'costs') return renderCostList();
    if (activeMobileSection === 'rewards') return renderRewardList();
    return renderUnlockList();
  };

  const renderDesktopShell = () => (
    <div className="realm-shell">
      <div className="realm-left">
        <div className="realm-left-title">
          <img className="realm-left-icon" src={coin01} alt="境界" />
          <div className="realm-left-name">境界</div>
        </div>

        {renderRealmSummary()}
      </div>

      <div className="realm-right">
        <div className="realm-pane">
          <div className="realm-pane-top">
            <div className="realm-mode-tabs">
              {paneTabs.map((tab) => (
                <Button
                  key={tab.key}
                  size="small"
                  type={activePane === tab.key ? 'primary' : 'default'}
                  className="realm-mode-tab"
                  onClick={() => setActivePane(tab.key)}
                >
                  {tab.label}
                </Button>
              ))}
            </div>
            <div className="realm-title">{activePane === 'breakthrough' ? '境界突破' : '悟道修行'}</div>
            <div className="realm-subtitle">
              {activePane === 'breakthrough'
                ? rank.next
                  ? `下一境界：${rank.next}`
                  : '已达当前版本最高境界'
                : '持续消耗经验，获取全模式永久属性加成'}
            </div>
          </div>

          <div className="realm-pane-body">
            {activePane === 'breakthrough' ? (
              <>
                <div className="realm-section">
                  <div className="realm-section-title">突破条件</div>
                  {renderRequirementList()}
                </div>

                <div className="realm-section">
                  <div className="realm-section-title">消耗预览</div>
                  {renderCostList()}
                </div>

                <div className="realm-section">
                  <div className="realm-section-title">突破收益</div>
                  {renderRewardList()}
                </div>

                {outcome.unlocks.length > 0 ? (
                  <div className="realm-section">
                    <div className="realm-section-title">联动解锁</div>
                    {renderUnlockList()}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="realm-section">
                <div className="realm-section-title">悟道总览</div>
                <InsightPanel
                  overview={insightOverview}
                  holdGainLevels={insightHoldGainLevels}
                  holdSpentExp={insightHoldSpentExp}
                  holdGainBonusPct={insightHoldGainBonusPct}
                  displayProgressExp={insightDisplayProgress.progressExp}
                  displayNextLevelCostExp={insightDisplayProgress.nextLevelCostExp}
                  upgradeProgressPct={insightUpgradeProgressPct}
                />
              </div>
            )}
          </div>

          {activePane === 'breakthrough' ? (
            <div className="realm-pane-footer">{renderActionButtons()}</div>
          ) : (
            <div className="realm-pane-footer">
              <Button
                type="primary"
                className={`realm-insight-hold-btn ${insightHolding ? 'is-holding' : ''}`.trim()}
                loading={insightInjecting && !insightHolding}
                disabled={(insightInjectDisabled || insightInjecting) && !insightHolding}
                onPointerDown={handleInsightPointerDown}
                onPointerUp={handleInsightPointerUp}
                onPointerCancel={handleInsightPointerUp}
              >
                {insightHolding ? '注入中，松开停止' : '按住注入经验'}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  const renderMobileShell = () => (
    <div className="realm-mobile-shell">
      <div className="realm-left-title realm-mobile-title">
        <img className="realm-left-icon" src={coin01} alt="境界" />
        <div className="realm-left-name">境界</div>
      </div>

      <div className="realm-mobile-intro">
        <div className="realm-mode-tabs realm-mode-tabs-mobile">
          {paneTabs.map((tab) => (
            <Button
              key={tab.key}
              size="small"
              type={activePane === tab.key ? 'primary' : 'default'}
              className="realm-mode-tab"
              onClick={() => setActivePane(tab.key)}
            >
              {tab.label}
            </Button>
          ))}
        </div>
        <div className="realm-title">{activePane === 'breakthrough' ? '境界突破' : '悟道修行'}</div>
        <div className="realm-subtitle">
          {activePane === 'breakthrough'
            ? rank.next
              ? `下一境界：${rank.next}`
              : '已达当前版本最高境界'
            : '持续消耗经验，获取全模式永久属性加成'}
        </div>
      </div>

      {activePane === 'breakthrough' ? (
        <div className="realm-mobile-tabs" style={{ gridTemplateColumns: `repeat(${mobileTabs.length}, minmax(0, 1fr))` }}>
          {mobileTabs.map((tab) => (
            <Button
              key={tab.key}
              size="small"
              type={tab.key === activeMobileSection ? 'primary' : 'default'}
              className="realm-mobile-tab"
              onClick={() => setMobileSection(tab.key)}
            >
              {tab.label}
            </Button>
          ))}
        </div>
      ) : null}

      <div className="realm-mobile-body">
        {activePane === 'breakthrough' ? (
          <div className="realm-section">
            <div className="realm-section-title">{mobileSectionTitle[activeMobileSection]}</div>
            {renderMobileSectionContent()}
          </div>
        ) : (
          <div className="realm-section">
            <div className="realm-section-title">悟道总览</div>
            <InsightPanel
              overview={insightOverview}
              holdGainLevels={insightHoldGainLevels}
              holdSpentExp={insightHoldSpentExp}
              holdGainBonusPct={insightHoldGainBonusPct}
              displayProgressExp={insightDisplayProgress.progressExp}
              displayNextLevelCostExp={insightDisplayProgress.nextLevelCostExp}
              upgradeProgressPct={insightUpgradeProgressPct}
            />
          </div>
        )}
      </div>

      {activePane === 'breakthrough' ? (
        <div className="realm-mobile-footer">{renderActionButtons()}</div>
      ) : (
        <div className="realm-mobile-footer">
          <Button
            type="primary"
            className={`realm-insight-hold-btn ${insightHolding ? 'is-holding' : ''}`.trim()}
            loading={insightInjecting && !insightHolding}
            disabled={(insightInjectDisabled || insightInjecting) && !insightHolding}
            onPointerDown={handleInsightPointerDown}
            onPointerUp={handleInsightPointerUp}
            onPointerCancel={handleInsightPointerUp}
          >
            {insightHolding ? '注入中，松开停止' : '按住注入经验'}
          </Button>
        </div>
      )}
    </div>
  );

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      title={null}
      centered
      width={isMobile ? 'calc(100vw - 16px)' : 1080}
      className={`realm-modal ${isMobile ? 'is-mobile' : ''}`.trim()}
      style={isMobile ? { paddingBottom: 0 } : undefined}
      destroyOnHidden
      maskClosable
    >
      {isMobile ? renderMobileShell() : renderDesktopShell()}
    </Modal>
  );
};

export default RealmModal;
