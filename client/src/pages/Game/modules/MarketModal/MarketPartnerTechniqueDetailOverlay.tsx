/**
 * 坊市伙伴功法详情容器
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一承载坊市伙伴功法的桌面弹窗与移动端抽屉，复用同一份完整功法详情内容。
 * 2. 做什么：把加载态、空态和详情面板收敛到单一容器，避免桌面与移动端各自拼一套壳层逻辑。
 * 3. 不做什么：不发起详情请求、不决定选中哪门功法，也不渲染功法列表入口。
 *
 * 输入 / 输出：
 * - 输入：展示模式、开关状态、当前功法、详情视图与加载态。
 * - 输出：一个 `Modal` 或 `Drawer` 节点。
 *
 * 数据流 / 状态流：
 * `MarketPartnerTechniqueList` 选中功法 -> 请求 / 命中缓存 -> 本容器 -> `TechniqueDetailPanel`。
 *
 * 复用设计说明：
 * 1. 坊市里的购买详情、待上架预览、移动端预览都通过列表组件进入同一个容器，因此把弹层壳子抽出来能避免样式和 loading 逻辑分散。
 * 2. 详情正文直接复用共享 `TechniqueDetailPanel`，不再保留 market 专用的二次展示结构，减少重复维护。
 * 3. 后续若还有新的坊市伙伴入口，只需要复用当前列表组件即可自动接入相同容器。
 *
 * 关键边界条件与坑点：
 * 1. 关闭时必须允许 `technique` 先置空，否则动画期间标题可能残留上一次选择。
 * 2. 移动端与桌面端共用同一份详情数据，但容器尺寸不同，正文组件必须根据 `mode` 精确切换 `isMobile`，不能混用窗口宽度猜测。
 */
import type { FC } from 'react';
import { Drawer, Modal, Skeleton } from 'antd';
import type { PartnerTechniqueDto } from '../../../../services/api';
import TechniqueDetailPanel from '../../shared/TechniqueDetailPanel';
import type { TechniqueDetailView } from '../../shared/techniqueDetailView';

export type MarketPartnerTechniqueDetailDisplayMode = 'modal' | 'drawer';

interface MarketPartnerTechniqueDetailOverlayProps {
  mode: MarketPartnerTechniqueDetailDisplayMode;
  open: boolean;
  technique: PartnerTechniqueDto | null;
  detail: TechniqueDetailView | null;
  loading: boolean;
  onClose: () => void;
}

const MarketPartnerTechniqueDetailOverlay: FC<MarketPartnerTechniqueDetailOverlayProps> = ({
  mode,
  open,
  technique,
  detail,
  loading,
  onClose,
}) => {
  const title = technique?.name ?? '功法详情';
  const content = loading
    ? <Skeleton active paragraph={{ rows: mode === 'drawer' ? 6 : 8 }} />
    : <TechniqueDetailPanel detail={detail} isMobile={mode === 'drawer'} />;

  if (mode === 'drawer') {
    return (
      <Drawer
        title={title}
        placement="bottom"
        open={open}
        onClose={onClose}
        height="62dvh"
        className="market-mobile-preview-drawer market-partner-technique-drawer"
        styles={{ body: { padding: '10px 12px 12px' } }}
      >
        {content}
      </Drawer>
    );
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      title={title}
      centered
      width="min(720px, calc(100vw - 16px))"
      className="tech-submodal tech-detail-submodal market-partner-technique-modal"
      destroyOnHidden
    >
      {content}
    </Modal>
  );
};

export default MarketPartnerTechniqueDetailOverlay;
