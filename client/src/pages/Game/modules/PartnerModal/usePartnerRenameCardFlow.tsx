/**
 * 伙伴易名符改名流程 Hook
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把伙伴总览页的“点击编辑图标 -> 消耗易名符改名 -> 刷新伙伴总览”流程收敛成单入口。
 * 2. 做什么：复用共享改名弹窗与提交流程，避免伙伴页再复制一套提交状态和错误提示逻辑。
 * 3. 不做什么：不负责决定按钮是否可点，也不自行修改伙伴列表本地状态。
 *
 * 输入/输出：
 * - 输入：当前伙伴、总览刷新函数，以及改名成功后的额外回调。
 * - 输出：打开改名弹窗的方法、提交中状态、是否可改名，以及共享弹窗节点。
 *
 * 数据流/状态流：
 * 伙伴总览头部点击图标 -> `openPartnerRename` 写入易名符上下文 -> 共享弹窗提交 -> `/partner/renameWithCard` -> 刷新总览。
 *
 * 关键边界条件与坑点：
 * 1. 未选中伙伴时不能发请求，因此入口必须先基于 `partner` 判空。
 * 2. 改名成功后既要刷新伙伴总览，也要派发 `partner:changed`，否则列表与依赖伙伴快照的模块可能不同步。
 */
import type { ReactNode } from 'react';

import { renamePartnerWithCard, type PartnerDetailDto } from '../../../../services/api';
import { dispatchPartnerChangedEvent } from '../../shared/partnerTradeEvents';
import { useRenameCardFlow, type RenameCardContext } from '../../shared/useRenameCardFlow';
import { getPartnerDisplayName } from '../../shared/partnerDisplay';

interface UsePartnerRenameCardFlowOptions {
  partner: PartnerDetailDto | null;
  refresh: () => Promise<void>;
  onAfterSuccess?: () => void;
}

export const usePartnerRenameCardFlow = ({
  partner,
  refresh,
  onAfterSuccess,
}: UsePartnerRenameCardFlowOptions): {
  canRenamePartner: boolean;
  renameSubmitting: boolean;
  openPartnerRename: (context: RenameCardContext) => void;
  renameModalNode: ReactNode;
} => {
  const { renameSubmitting, openRename, renameModalNode } = useRenameCardFlow({
    currentName: partner ? getPartnerDisplayName(partner) : '',
    copy: {
      title: '伙伴改名',
      inputLabel: '新伙伴名',
      inputPlaceholder: '请输入新的伙伴名',
      submitText: '确认改名',
      buildDescription: (itemName) => `消耗 1 张【${itemName}】后，立即将当前伙伴名称改为新的名称。`,
      successFallbackMessage: '伙伴改名成功',
      failureFallbackMessage: '伙伴改名失败',
    },
    refresh,
    requestRename: (context: RenameCardContext, name, requestConfig) => {
      if (!partner) {
        throw new Error('当前未选中伙伴');
      }
      return renamePartnerWithCard(partner.id, context.itemInstanceId, name, requestConfig);
    },
    onAfterSuccess: () => {
      dispatchPartnerChangedEvent();
      onAfterSuccess?.();
    },
  });

  return {
    canRenamePartner: partner !== null,
    renameSubmitting,
    openPartnerRename: openRename,
    renameModalNode,
  };
};
