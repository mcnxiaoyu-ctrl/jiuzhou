/**
 * 洗炼词条池预览 Hook
 *
 * 作用（做什么 / 不做什么）：
 * - 做什么：统一管理词条池预览的加载、缓存、自动预取与弹窗开关，让桌面端与移动端共用同一条数据流。
 * - 做什么：保证装备切换时立即清空旧词条池，避免自动洗炼目标沿用上一件装备的数据。
 * - 不做什么：不决定自动洗炼何时可执行，也不拼接提示文案。
 *
 * 输入/输出：
 * - 输入：当前装备实例 id、是否启用、是否需要自动预取。
 * - 输出：预览弹窗开关、当前词条池数据、加载状态、是否已为当前装备成功加载，以及手动打开/关闭方法。
 *
 * 数据流/状态流：
 * - `itemId/autoLoad` 变化 -> 请求 `/inventory/reroll-affixes/pool-preview` -> 写入当前装备词条池 -> 桌面端/移动端消费同一份数据。
 *
 * 关键边界条件与坑点：
 * 1) 同一件装备自动预取失败后不能在每次渲染时无限重试，否则会形成请求风暴；是否重试只在用户手动打开预览时决定。
 * 2) 装备切换时必须同时清空 `data/open/error`，否则自动洗炼会拿到上一件装备的目标池。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getAffixPoolPreview,
  type AffixPoolPreviewResponse,
} from '../../../../services/api';

type AffixPoolPreviewData = NonNullable<AffixPoolPreviewResponse['data']>;

interface UseAffixPoolPreviewOptions {
  itemId: number | null;
  enabled: boolean;
  autoLoad: boolean;
}

export const useAffixPoolPreview = ({
  itemId,
  enabled,
  autoLoad,
}: UseAffixPoolPreviewOptions): {
  poolPreviewOpen: boolean;
  poolPreviewLoading: boolean;
  poolPreviewData: AffixPoolPreviewData | null;
  poolPreviewReady: boolean;
  poolPreviewErrorMessage: string;
  openPoolPreview: () => Promise<void>;
  closePoolPreview: () => void;
} => {
  const [poolPreviewOpen, setPoolPreviewOpen] = useState(false);
  const [poolPreviewLoading, setPoolPreviewLoading] = useState(false);
  const [poolPreviewData, setPoolPreviewData] = useState<AffixPoolPreviewData | null>(null);
  const [poolPreviewLoadedItemId, setPoolPreviewLoadedItemId] = useState<number | null>(null);
  const [poolPreviewAttemptedItemId, setPoolPreviewAttemptedItemId] = useState<number | null>(null);
  const [poolPreviewErrorMessage, setPoolPreviewErrorMessage] = useState('');
  const requestSerialRef = useRef(0);

  const loadPoolPreview = useCallback(async (forceRefresh: boolean): Promise<AffixPoolPreviewData | null> => {
    if (!enabled || itemId === null) return null;
    if (!forceRefresh && poolPreviewLoadedItemId === itemId && poolPreviewData) {
      return poolPreviewData;
    }

    const requestSerial = requestSerialRef.current + 1;
    requestSerialRef.current = requestSerial;
    setPoolPreviewAttemptedItemId(itemId);
    setPoolPreviewLoading(true);
    setPoolPreviewErrorMessage('');

    try {
      const response = await getAffixPoolPreview(itemId);
      if (requestSerial !== requestSerialRef.current) return null;

      if (!response.success || !response.data) {
        setPoolPreviewData(null);
        setPoolPreviewLoadedItemId(null);
        setPoolPreviewErrorMessage(response.message);
        return null;
      }

      setPoolPreviewData(response.data);
      setPoolPreviewLoadedItemId(itemId);
      return response.data;
    } catch {
      if (requestSerial !== requestSerialRef.current) return null;
      setPoolPreviewData(null);
      setPoolPreviewLoadedItemId(null);
      setPoolPreviewErrorMessage('获取词条池失败');
      return null;
    } finally {
      if (requestSerial === requestSerialRef.current) {
        setPoolPreviewLoading(false);
      }
    }
  }, [enabled, itemId, poolPreviewData, poolPreviewLoadedItemId]);

  const openPoolPreview = useCallback(async () => {
    if (!enabled || itemId === null || poolPreviewLoading) return;
    setPoolPreviewOpen(true);
    const data = await loadPoolPreview(true);
    if (!data) {
      setPoolPreviewOpen(false);
    }
  }, [enabled, itemId, loadPoolPreview, poolPreviewLoading]);

  const closePoolPreview = useCallback(() => {
    setPoolPreviewOpen(false);
  }, []);

  useEffect(() => {
    requestSerialRef.current += 1;
    setPoolPreviewOpen(false);
    setPoolPreviewLoading(false);
    setPoolPreviewData(null);
    setPoolPreviewLoadedItemId(null);
    setPoolPreviewAttemptedItemId(null);
    setPoolPreviewErrorMessage('');
  }, [itemId]);

  useEffect(() => {
    if (!enabled || !autoLoad || itemId === null) return;
    if (poolPreviewLoading) return;
    if (poolPreviewLoadedItemId === itemId) return;
    if (poolPreviewAttemptedItemId === itemId) return;

    void loadPoolPreview(false);
  }, [
    autoLoad,
    enabled,
    itemId,
    loadPoolPreview,
    poolPreviewAttemptedItemId,
    poolPreviewLoadedItemId,
    poolPreviewLoading,
  ]);

  return {
    poolPreviewOpen,
    poolPreviewLoading,
    poolPreviewData,
    poolPreviewReady: poolPreviewLoadedItemId === itemId && poolPreviewData !== null,
    poolPreviewErrorMessage,
    openPoolPreview,
    closePoolPreview,
  };
};
