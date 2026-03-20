/**
 * 易名符改名提交流程 Hook
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中管理“打开改名弹窗 -> 提交接口 -> 成功提示 -> 刷新背包”的完整流程，供桌面端与移动端背包复用。
 * 2. 做什么：把改名成功后的 UI 副作用收敛到单一入口，避免两个背包组件各自维护一套请求与提示逻辑。
 * 3. 不做什么：不决定哪个物品是易名符，该判断仍由背包共享语义模块负责。
 *
 * 输入/输出：
 * - 输入：刷新函数，以及改名成功后的额外 UI 回调。
 * - 输出：打开改名弹窗的方法、提交中状态，以及可直接渲染的共享弹窗节点。
 *
 * 数据流/状态流：
 * 背包点击使用 -> `openCharacterRename` 写入当前道具 -> 共享弹窗提交 -> `/character/renameWithCard` -> 服务端负责全服播报 -> 成功后前端刷新背包。
 *
 * 关键边界条件与坑点：
 * 1. 同一次提交流程内不能重复点击提交，否则会产生重复请求与重复扣卡风险。
 * 2. 成功后必须同时刷新背包和派发 `inventory:changed`，否则道具数量与外层角标会不同步。
 */
import type { ReactNode } from 'react';

import { renameCharacterWithCard } from '../../../services/api';
import { gameSocket } from '../../../services/gameSocket';
import { useRenameCardFlow, type RenameCardContext } from './useRenameCardFlow';

interface UseCharacterRenameCardFlowOptions {
  refresh: () => Promise<void>;
  onAfterSuccess?: () => void;
}

export const useCharacterRenameCardFlow = ({
  refresh,
  onAfterSuccess,
}: UseCharacterRenameCardFlowOptions): {
  renameSubmitting: boolean;
  openCharacterRename: (context: RenameCardContext) => void;
  renameModalNode: ReactNode;
} => {
  const { renameSubmitting, openRename, renameModalNode } = useRenameCardFlow({
    currentName: gameSocket.getCharacter()?.nickname ?? '',
    copy: {
      title: '使用易名符',
      inputLabel: '新道号',
      inputPlaceholder: '请输入新的道号',
      submitText: '确认改名',
      buildDescription: (itemName) => `消耗 1 张【${itemName}】后，立即将当前角色道号改为新的名称。`,
      successFallbackMessage: '改名成功',
      failureFallbackMessage: '改名失败',
    },
    refresh,
    requestRename: (context: RenameCardContext, name, requestConfig) => {
      return renameCharacterWithCard(context.itemInstanceId, name, requestConfig);
    },
    onAfterSuccess,
  });

  return {
    renameSubmitting,
    openCharacterRename: openRename,
    renameModalNode,
  };
};
