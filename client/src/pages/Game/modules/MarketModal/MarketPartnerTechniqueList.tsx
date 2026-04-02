/**
 * 坊市伙伴功法列表共享组件
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中渲染坊市伙伴详情里的功法名称、当前层数与描述，并统一驱动完整功法详情弹层。
 * 2. 做什么：把“自有伙伴详情请求”和“坊市挂单详情请求”两条链路收敛在同一组件内，避免多个入口重复维护缓存、加载态和弹层容器。
 * 3. 不做什么：不处理坊市购买/上架按钮，也不负责伙伴属性区域布局。
 *
 * 输入 / 输出：
 * - 输入：伙伴功法列表、详情来源、单列布局开关，以及详情展示模式。
 * - 输出：统一的坊市功法列表 DOM 结构；无功法时输出占位文案，点击后进入完整功法详情。
 *
 * 数据流 / 状态流：
 * 坊市伙伴 DTO + 来源标识 -> 本组件选中功法 -> 请求 / 命中缓存 -> `TechniqueDetailPanel` -> 多个坊市详情入口共用。
 *
 * 复用设计说明：
 * 1. 购买详情、待上架预览、移动端预览都复用同一份列表组件，因此把详情请求与缓存收敛在这里，可以消除多处重复弹层状态。
 * 2. 详情视图继续复用共享 `buildPartnerTechniqueDetailView` 与 `TechniqueDetailPanel`，避免坊市再次维护一份层数表和技能区。
 * 3. 来源协议抽成显式联合类型后，后续若新增坊市伙伴入口，只需传入来源对象即可复用完整详情能力。
 *
 * 关键边界条件与坑点：
 * 1. 层数字样必须始终从 DTO 实际值读取，不能再写死“第一层”，否则坊市会与伙伴面板展示脱节。
 * 2. 详情缓存键必须包含来源种类与来源 ID，不能只按 `techniqueId` 缓存，否则不同挂单或不同伙伴会互相串数据。
 * 3. 单列与双列仅允许通过布局参数控制，内容结构本身保持一致，避免后续修文案时又在不同弹层漏改一处。
 */
import { useCallback, useMemo, useRef, useState, type FC } from 'react';
import {
  getMarketPartnerTechniqueDetail,
  getPartnerTechniqueDetail,
  type PartnerTechniqueDto,
} from '../../../../services/api';
import { buildPartnerTechniqueDetailView } from '../../shared/partnerTechniqueDetailView';
import type { TechniqueDetailView } from '../../shared/techniqueDetailView';
import { formatPartnerTechniqueLayerLabel } from '../../shared/partnerDisplay';
import MarketPartnerTechniqueDetailOverlay, {
  type MarketPartnerTechniqueDetailDisplayMode,
} from './MarketPartnerTechniqueDetailOverlay';
import {
  buildMarketPartnerTechniqueDetailCacheKey,
  type MarketPartnerTechniqueDetailSource,
} from './marketPartnerTechniqueDetailShared';

type MarketPartnerTechniqueListBaseProps = {
  techniques: PartnerTechniqueDto[];
  singleColumn?: boolean;
};

type MarketPartnerTechniqueListProps =
  | (MarketPartnerTechniqueListBaseProps & {
    detailDisplayMode?: 'none';
  })
  | (MarketPartnerTechniqueListBaseProps & {
    detailDisplayMode: MarketPartnerTechniqueDetailDisplayMode;
    detailSource: MarketPartnerTechniqueDetailSource;
  });

const MarketPartnerTechniqueList: FC<MarketPartnerTechniqueListProps> = (props) => {
  const {
    techniques,
    singleColumn = false,
  } = props;
  const detailDisplayMode = props.detailDisplayMode ?? 'none';
  const detailSource = 'detailSource' in props ? props.detailSource : null;
  const [selectedTechniqueId, setSelectedTechniqueId] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detail, setDetail] = useState<TechniqueDetailView | null>(null);
  const detailCacheRef = useRef(new Map<string, TechniqueDetailView>());
  const detailRequestIdRef = useRef(0);

  const selectedTechnique = useMemo(() => (
    selectedTechniqueId
      ? techniques.find((technique) => technique.techniqueId === selectedTechniqueId) ?? null
      : null
  ), [selectedTechniqueId, techniques]);

  const closeTechniqueDetail = useCallback(() => {
    detailRequestIdRef.current += 1;
    setSelectedTechniqueId(null);
    setDetailLoading(false);
    setDetail(null);
  }, []);

  const openTechniqueDetail = useCallback(async (technique: PartnerTechniqueDto) => {
    if (!detailSource || detailDisplayMode === 'none') return;

    const cacheKey = buildMarketPartnerTechniqueDetailCacheKey(detailSource, technique.techniqueId);
    const cached = detailCacheRef.current.get(cacheKey) ?? null;
    const requestId = detailRequestIdRef.current + 1;
    detailRequestIdRef.current = requestId;
    setSelectedTechniqueId(technique.techniqueId);
    setDetailLoading(true);

    if (cached) {
      setDetail(cached);
      setDetailLoading(false);
      return;
    }

    setDetail(null);

    try {
      const response = detailSource.kind === 'listing'
        ? await getMarketPartnerTechniqueDetail(detailSource.listingId, technique.techniqueId)
        : await getPartnerTechniqueDetail(detailSource.partnerId, technique.techniqueId);
      if (detailRequestIdRef.current !== requestId) return;
      if (!response.success || !response.data) {
        throw new Error(response.message || '获取伙伴功法详情失败');
      }

      const nextDetail = buildPartnerTechniqueDetailView(response.data);
      detailCacheRef.current.set(cacheKey, nextDetail);
      setDetail(nextDetail);
    } catch {
      if (detailRequestIdRef.current !== requestId) return;
      setDetail(null);
    } finally {
      if (detailRequestIdRef.current === requestId) {
        setDetailLoading(false);
      }
    }
  }, [detailDisplayMode, detailSource]);

  if (techniques.length <= 0) {
    return <div className="market-list-detail-text">暂无功法</div>;
  }

  return (
    <>
      <div
        className="market-partner-technique-grid"
        style={singleColumn ? { gridTemplateColumns: '1fr' } : undefined}
      >
        {techniques.map((technique) => {
          const isInteractive = detailDisplayMode !== 'none';
          const content = (
            <div
              className={[
                'market-partner-technique-cell',
                isInteractive ? 'market-partner-technique-cell--interactive' : '',
              ].filter(Boolean).join(' ')}
            >
              <div className="market-partner-technique-name">
                {technique.name}
                <span className="market-partner-technique-level">
                  {formatPartnerTechniqueLayerLabel(technique)}
                </span>
              </div>
              <div className="market-partner-technique-desc">{technique.description || '暂无描述'}</div>
            </div>
          );

          if (!isInteractive) {
            return <div key={technique.techniqueId}>{content}</div>;
          }

          return (
            <button
              key={technique.techniqueId}
              type="button"
              className="market-partner-technique-trigger"
              onClick={() => {
                void openTechniqueDetail(technique);
              }}
            >
              {content}
            </button>
          );
        })}
      </div>
      {detailDisplayMode !== 'none' ? (
        <MarketPartnerTechniqueDetailOverlay
          mode={detailDisplayMode}
          open={selectedTechnique !== null}
          technique={selectedTechnique}
          detail={detail}
          loading={detailLoading}
          onClose={closeTechniqueDetail}
        />
      ) : null}
    </>
  );
};

export default MarketPartnerTechniqueList;
