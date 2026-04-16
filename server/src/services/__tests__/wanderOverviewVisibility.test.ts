/**
 * 云游概览生成任务可见性回归测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定概览里 `currentGenerationJob` 的暴露规则，避免旧失败任务继续污染当前可展示幕次或冷却结果。
 * 2. 做什么：直接覆盖 `shouldExposeWanderGenerationJob` 这个纯函数入口，让 pending/failed 两类任务的可见性收敛到单一判断。
 * 3. 不做什么：不连接数据库，不覆盖完整 `getOverview` 查询流程，也不校验前端弹窗文案。
 *
 * 输入/输出：
 * - 输入：构造的最新生成任务、当前幕次以及最近幕次创建时间戳。
 * - 输出：概览是否应继续暴露这条生成任务。
 *
 * 数据流 / 状态流：
 * - 测试数据 -> `shouldExposeWanderGenerationJob` -> 断言布尔结果。
 *
 * 复用设计说明：
 * 1. 失败任务是否仍应展示属于 overview 的高频状态变化点，抽成纯函数后由服务层和测试复用同一套规则，避免再次散落分支。
 * 2. 这里锁住“失败只在无当前幕次时可重试”的语义，后续若概览或首页红点继续复用，也能共享这条规则。
 *
 * 关键边界条件与坑点：
 * 1. `pending` 任务仍需保留原有暴露逻辑，不能因为修 failed 分支把轮询状态一起隐藏。
 * 2. 当已有 `currentEpisode` 时，旧 failed 任务必须隐藏；否则弹窗会同时展示有效幕次和失败状态，造成“卡住”错觉。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  shouldExposeWanderCurrentEpisode,
  shouldExposeWanderGenerationJob,
} from '../wander/service.js';

const buildGenerationJob = (overrides: Partial<{
  status: 'pending' | 'generated' | 'failed';
  generated_episode_id: string | null;
  created_at: string;
}> = {}) => ({
  status: 'failed' as const,
  generated_episode_id: null,
  created_at: '2026-04-16T12:00:00.000Z',
  ...overrides,
});

const buildCurrentEpisode = (overrides: Partial<{ id: string; chosen_at: string | null }> = {}) => ({
  id: 'wander-episode-current',
  chosen_at: null,
  ...overrides,
});

test('shouldExposeWanderGenerationJob: 无当前幕次时应暴露最新 failed 任务供重新推演', () => {
  assert.equal(
    shouldExposeWanderGenerationJob({
      latestGenerationJob: buildGenerationJob({ status: 'failed' }),
      currentEpisode: null,
      latestEpisodeCreatedAtMs: Number.NaN,
    }),
    true,
  );
});

test('shouldExposeWanderGenerationJob: 已有当前幕次时不应继续暴露旧 failed 任务', () => {
  assert.equal(
    shouldExposeWanderGenerationJob({
      latestGenerationJob: buildGenerationJob({ status: 'failed' }),
      currentEpisode: buildCurrentEpisode(),
      latestEpisodeCreatedAtMs: Date.parse('2026-04-16T11:59:00.000Z'),
    }),
    false,
  );
});

test('shouldExposeWanderGenerationJob: pending 任务命中当前幕次且未结算时仍应暴露', () => {
  assert.equal(
    shouldExposeWanderGenerationJob({
      latestGenerationJob: buildGenerationJob({
        status: 'pending',
        generated_episode_id: 'wander-episode-current',
      }),
      currentEpisode: buildCurrentEpisode(),
      latestEpisodeCreatedAtMs: Date.parse('2026-04-16T11:59:00.000Z'),
    }),
    true,
  );
});

test('shouldExposeWanderGenerationJob: 早于最新幕次的 failed 任务不应继续暴露', () => {
  assert.equal(
    shouldExposeWanderGenerationJob({
      latestGenerationJob: buildGenerationJob({
        status: 'failed',
        created_at: '2026-04-16T11:00:00.000Z',
      }),
      currentEpisode: null,
      latestEpisodeCreatedAtMs: Date.parse('2026-04-16T12:30:00.000Z'),
    }),
    false,
  );
});

test('shouldExposeWanderCurrentEpisode: 待选择幕次应继续作为当前幕暴露', () => {
  assert.equal(
    shouldExposeWanderCurrentEpisode({
      latestEpisode: {
        chosen_option_index: null,
        chosen_at: null,
      },
      isCoolingDown: false,
    }),
    true,
  );
});

test('shouldExposeWanderCurrentEpisode: 冷却中的已结算幕次应继续作为当前幕暴露', () => {
  assert.equal(
    shouldExposeWanderCurrentEpisode({
      latestEpisode: {
        chosen_option_index: 1,
        chosen_at: '2026-04-16T12:10:00.000Z',
      },
      isCoolingDown: true,
    }),
    true,
  );
});

test('shouldExposeWanderCurrentEpisode: 已选择但未处于冷却中的幕次不应继续阻塞入口', () => {
  assert.equal(
    shouldExposeWanderCurrentEpisode({
      latestEpisode: {
        chosen_option_index: 1,
        chosen_at: null,
      },
      isCoolingDown: false,
    }),
    false,
  );
});
