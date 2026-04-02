/**
 * 伙伴详情预览浮层。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把伙伴详情的桌面端弹窗和移动端底部 Sheet 统一封装成一个入口，给聊天、排行榜等多个模块复用。
 * 2. 做什么：保持所有“查看伙伴详情”入口看到完全一致的详情内容，避免一个入口用 modal、另一个入口用自写卡片。
 * 3. 不做什么：不负责拉取伙伴详情，也不负责决定何时打开或关闭。
 *
 * 输入/输出：
 * - 输入：伙伴详情 DTO、当前是否移动端、关闭回调。
 * - 输出：对应端形态的伙伴详情浮层。
 *
 * 数据流/状态流：
 * 调用方通过 `usePartnerPreview` 拿到 `previewPartner` -> 本组件按 `isMobile` 选择预览容器 -> 用户关闭后回调给调用方清空状态。
 *
 * 复用设计说明：
 * 1. 详情内容继续完全复用坊市里已经稳定使用的伙伴详情组件，避免再维护第三份伙伴属性/功法详情 UI。
 * 2. 调用方只关心“渲染详情浮层”，不需要知道移动端和桌面端分别该挂哪个组件。
 * 3. 移动端 Sheet 在这里统一提升到 `document.body`，避免调用方若位于带 `transform` 的抽屉/面板内时把 fixed 浮层裁进局部坐标系。
 * 4. 后续如果伙伴详情容器样式要统一调整，只改这里一处即可同步多个入口。
 *
 * 关键边界条件与坑点：
 * 1. `partner` 为空时必须直接返回 `null`，避免容器组件挂空壳遮罩。
 * 2. 移动端 Sheet 必须挂到 `document.body`，否则当父级存在 `transform` 时，fixed 定位会相对父级而不是视口，导致顶部被裁切。
 * 3. 移动端和桌面端都必须吃同一份 `partner` 数据，不能在这里再做字段裁剪，否则会引入展示口径分叉。
 */
import type { PartnerDisplayDto } from '../../../services/api';
import { createPortal } from 'react-dom';
import MarketPartnerBuyModal from '../modules/MarketModal/MarketPartnerBuyModal';
import MarketPartnerPreviewSheet from '../modules/MarketModal/MarketPartnerPreviewSheet';
import type { MarketPartnerTechniqueDetailSource } from '../modules/MarketModal/marketPartnerTechniqueDetailShared';

interface PartnerPreviewOverlayProps {
  partner: PartnerDisplayDto | null;
  isMobile: boolean;
  onClose: () => void;
}

const PartnerPreviewOverlay = ({
  partner,
  isMobile,
  onClose,
}: PartnerPreviewOverlayProps) => {
  if (!partner) return null;
  const detailSource: MarketPartnerTechniqueDetailSource = {
    kind: 'partner',
    partnerId: partner.id,
  };

  if (isMobile) {
    if (typeof document === 'undefined') {
      return null;
    }
    return createPortal(
      <MarketPartnerPreviewSheet partner={partner} detailSource={detailSource} onClose={onClose} />,
      document.body,
    );
  }

  return <MarketPartnerBuyModal partner={partner} detailSource={detailSource} onClose={onClose} />;
};

export default PartnerPreviewOverlay;
