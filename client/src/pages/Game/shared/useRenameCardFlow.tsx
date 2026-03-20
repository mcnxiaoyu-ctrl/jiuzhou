/**
 * 易名符改名流程共享 Hook
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中管理“打开改名弹窗 -> 提交接口 -> 成功提示 -> 刷新背包/业务数据”的通用流程，供角色与伙伴改名共用。
 * 2. 做什么：把提交中态、统一错误提示与弹窗渲染收口，避免多个入口各复制一套 state 和副作用。
 * 3. 不做什么：不决定改名对象的服务端接口，也不识别哪个道具是易名符。
 *
 * 输入/输出：
 * - 输入：当前名字、弹窗文案、改名请求函数，以及成功后的刷新回调。
 * - 输出：打开改名弹窗的方法、提交中状态，以及可直接渲染的弹窗节点。
 *
 * 数据流/状态流：
 * 业务入口点击改名 -> `openRename` 写入易名符上下文 -> 共享弹窗提交 -> 调用业务请求 -> 刷新背包与业务数据。
 *
 * 关键边界条件与坑点：
 * 1. 同一次提交流程内不能重复点击提交，否则会出现重复请求与重复扣卡风险。
 * 2. 这里统一派发 `inventory:changed`，保证易名符数量变化后角标与列表同步刷新。
 */
import { App } from 'antd';
import { useCallback, useMemo, useState, type ReactNode } from 'react';

import {
  notifyUnifiedApiError,
  SILENT_API_REQUEST_CONFIG,
} from '../../../services/api';
import CharacterRenameModal from './CharacterRenameModal';

export interface RenameCardContext {
  itemInstanceId: number;
  itemName: string;
}

interface RenameCardFlowCopy {
  title: string;
  inputLabel: string;
  inputPlaceholder: string;
  submitText: string;
  buildDescription: (itemName: string) => string;
  successFallbackMessage: string;
  failureFallbackMessage: string;
}

interface UseRenameCardFlowOptions {
  currentName: string;
  copy: RenameCardFlowCopy;
  refresh: () => Promise<void>;
  requestRename: (
    context: RenameCardContext,
    name: string,
    requestConfig: typeof SILENT_API_REQUEST_CONFIG,
  ) => Promise<{ success: boolean; message: string }>;
  onAfterSuccess?: () => void | Promise<void>;
}

export const useRenameCardFlow = ({
  currentName,
  copy,
  refresh,
  requestRename,
  onAfterSuccess,
}: UseRenameCardFlowOptions): {
  renameSubmitting: boolean;
  openRename: (context: RenameCardContext) => void;
  renameModalNode: ReactNode;
} => {
  const { message } = App.useApp();
  const [renameContext, setRenameContext] = useState<RenameCardContext | null>(null);
  const [renameSubmitting, setRenameSubmitting] = useState(false);

  const closeRename = useCallback(() => {
    if (renameSubmitting) {
      return;
    }
    setRenameContext(null);
  }, [renameSubmitting]);

  const openRename = useCallback((context: RenameCardContext) => {
    setRenameContext(context);
  }, []);

  const handleSubmitRename = useCallback(async (name: string) => {
    if (!renameContext || renameSubmitting) {
      return;
    }

    setRenameSubmitting(true);
    try {
      const result = await requestRename(renameContext, name, SILENT_API_REQUEST_CONFIG);
      message.success(result.message || copy.successFallbackMessage);
      await refresh();
      window.dispatchEvent(new Event('inventory:changed'));
      setRenameContext(null);
      await onAfterSuccess?.();
    } catch (error) {
      notifyUnifiedApiError(message, error, copy.failureFallbackMessage);
    } finally {
      setRenameSubmitting(false);
    }
  }, [copy.failureFallbackMessage, copy.successFallbackMessage, message, onAfterSuccess, refresh, renameContext, renameSubmitting, requestRename]);

  const renameModalNode = useMemo(() => {
    return (
      <CharacterRenameModal
        open={renameContext !== null}
        title={copy.title}
        itemName={renameContext?.itemName ?? '易名符'}
        description={copy.buildDescription(renameContext?.itemName ?? '易名符')}
        inputLabel={copy.inputLabel}
        inputPlaceholder={copy.inputPlaceholder}
        submitText={copy.submitText}
        initialName={currentName}
        submitting={renameSubmitting}
        onCancel={closeRename}
        onSubmit={handleSubmitRename}
      />
    );
  }, [closeRename, copy, currentName, handleSubmitRename, renameContext, renameSubmitting]);

  return {
    renameSubmitting,
    openRename,
    renameModalNode,
  };
};
