/**
 * 挂机时长选项共享模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中维护挂机时长预设选项与“当前上限下可展示哪些按钮”的规则，避免面板组件和测试重复硬编码 8 小时、12 小时等数值。
 * 2. 做什么：把月卡扩展挂机上限后的 UI 派生逻辑收敛成纯函数，便于后续继续扩展更多时长档位。
 * 3. 不做什么：不读取接口、不持有 React 状态，也不负责真正校验服务端提交参数是否合法。
 *
 * 输入/输出：
 * - 输入：当前允许的最大挂机时长毫秒值。
 * - 输出：可用的时长预设列表，以及给 Slider 使用的最大分钟数。
 *
 * 数据流/状态流：
 * GET /idle/config -> useIdleBattle.maxDurationLimitMs -> 本模块纯函数 -> IdleConfigPanel 渲染。
 *
 * 关键边界条件与坑点：
 * 1. 12 小时档位只在当前上限允许时显示，不能始终展示后再靠提交时报错兜底。
 * 2. 基础 8 小时档位属于默认能力，后续新增更高权益时应在这里扩展，而不是在组件里继续追加 if/else。
 */

export const BASE_IDLE_MAX_DURATION_MS = 28_800_000;
export const MONTH_CARD_IDLE_MAX_DURATION_MS = 43_200_000;

const DURATION_PRESET_OPTIONS: Array<{ label: string; value: number }> = [
  { label: '1小时', value: 3_600_000 },
  { label: '2小时', value: 7_200_000 },
  { label: '4小时', value: 14_400_000 },
  { label: '8小时', value: BASE_IDLE_MAX_DURATION_MS },
  { label: '12小时', value: MONTH_CARD_IDLE_MAX_DURATION_MS },
];

export const getIdleDurationPresetOptions = (
  maxDurationLimitMs: number,
): Array<{ label: string; value: number }> => {
  return DURATION_PRESET_OPTIONS.filter((option) => option.value <= maxDurationLimitMs);
};

export const getIdleDurationSliderMaxMinutes = (
  maxDurationLimitMs: number,
): number => {
  return Math.floor(maxDurationLimitMs / 60_000);
};
