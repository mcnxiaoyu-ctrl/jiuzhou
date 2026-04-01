/**
 * 归元洗髓任务共享状态映射
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：把归元洗髓任务原始状态统一映射为前端可直接消费的当前任务、未读结果与结果态。
 * 2) 做什么：收口 pending / succeeded / failed 的可见性规则，避免服务端和前端各写一套判断。
 * 3) 不做什么：不查询数据库、不创建任务，也不执行洗髓逻辑。
 *
 * 输入/输出：
 * - 输入：归元洗髓任务状态输入对象。
 * - 输出：当前任务视图、未读标记与结果态。
 *
 * 数据流/状态流：
 * DB 行 -> buildPartnerReboneJobState -> 状态接口 / Socket 推送 / 伙伴页按钮禁用态。
 *
 * 复用设计说明：
 * - 这一层只维护“任务状态怎么展示”，让 route、push、前端共享同一口径。
 * - 后续如果洗髓结果卡片或历史记录要扩展，也只需要在这里加状态映射，不必改散落的业务判断。
 *
 * 关键边界条件与坑点：
 * 1) `pending` 只能表示进行中，不能被错误标成未读结果，否则按钮会被误判成“有结果待看”。
 * 2) `succeeded / failed` 必须在未读前继续保留 `currentJob`，否则用户刷新后看不到最后一次结果。
 */
export type PartnerReboneJobStatus =
  | 'pending'
  | 'succeeded'
  | 'failed';

export type PartnerReboneJobStateInput = {
  reboneId: string;
  status: PartnerReboneJobStatus;
  partnerId: number;
  itemDefId: string;
  itemQty: number;
  startedAt: string;
  finishedAt: string | null;
  viewedAt: string | null;
  errorMessage: string | null;
};

export type PartnerReboneJobView = {
  reboneId: string;
  status: PartnerReboneJobStatus;
  partnerId: number;
  itemDefId: string;
  itemQty: number;
  startedAt: string;
  finishedAt: string | null;
  errorMessage: string | null;
};

export type PartnerReboneJobStateOutput = {
  currentJob: PartnerReboneJobView | null;
  hasUnreadResult: boolean;
  resultStatus: 'succeeded' | 'failed' | null;
};

export const buildPartnerReboneJobState = (
  input: PartnerReboneJobStateInput | null,
): PartnerReboneJobStateOutput => {
  if (!input) {
    return {
      currentJob: null,
      hasUnreadResult: false,
      resultStatus: null,
    };
  }

  const currentJob: PartnerReboneJobView = {
    reboneId: input.reboneId,
    status: input.status,
    partnerId: input.partnerId,
    itemDefId: input.itemDefId,
    itemQty: input.itemQty,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    errorMessage: input.errorMessage,
  };

  if (input.status === 'pending') {
    return {
      currentJob,
      hasUnreadResult: false,
      resultStatus: null,
    };
  }

  if (input.status === 'succeeded') {
    return {
      currentJob,
      hasUnreadResult: !input.viewedAt,
      resultStatus: 'succeeded',
    };
  }

  return {
    currentJob,
    hasUnreadResult: !input.viewedAt,
    resultStatus: 'failed',
  };
};
