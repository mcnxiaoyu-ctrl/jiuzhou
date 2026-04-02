/**
 * 伙伴功法详情视图构建
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把伙伴功法详情 DTO 统一转换成 `TechniqueDetailPanel` 可直接消费的视图结构。
 * 2. 做什么：集中补齐“天生功法 / 后天功法”标签与资源图标，避免伙伴面板和坊市详情各自维护一份转换逻辑。
 * 3. 不做什么：不负责详情请求、不管理弹层开关，也不决定详情来源是自有伙伴还是坊市挂单。
 *
 * 输入 / 输出：
 * - 输入：`PartnerTechniqueDetailDto`。
 * - 输出：`TechniqueDetailView`。
 *
 * 数据流 / 状态流：
 * 伙伴详情接口 / 坊市伙伴功法详情接口 -> 本模块归一化 -> `TechniqueDetailPanel`。
 *
 * 复用设计说明：
 * 1. 伙伴面板与坊市都展示同一种伙伴功法详情，抽到共享层后只保留一个转换入口，避免标签和图标规则再次分叉。
 * 2. 该模块只依赖共享详情视图构建器，后续若图鉴也要展示伙伴功法详情，可以直接复用而不需要重复拼装 `extraTags`。
 * 3. 伙伴功法的高频变化点是 `currentLayer` 与 `isInnate`，统一放在这里处理后，调用方只关心请求与容器状态。
 *
 * 关键边界条件与坑点：
 * 1. `isInnate` 必须始终映射成单一标签来源，不能让调用方自行拼字符串，否则不同入口很容易出现文案漂移。
 * 2. 伙伴功法详情复用角色功法视图时，图标解析必须统一走 `resolveIconUrl`，否则坊市快照与伙伴面板可能出现资源路径口径不一致。
 */
import type { PartnerTechniqueDetailDto } from '../../../services/api';
import { IMG_LINGSHI, IMG_TONGQIAN } from './imageAssets';
import { resolveIconUrl } from './resolveIcon';
import { buildTechniqueDetailView, type TechniqueDetailView } from './techniqueDetailView';

export const buildPartnerTechniqueDetailView = (
  detail: PartnerTechniqueDetailDto,
): TechniqueDetailView => {
  return buildTechniqueDetailView({
    technique: detail.technique,
    currentLayer: detail.currentLayer,
    layers: detail.layers,
    skills: detail.skills,
    resolveIcon: resolveIconUrl,
    spiritStoneIcon: IMG_LINGSHI,
    expIcon: IMG_TONGQIAN,
    extraTags: [detail.isInnate ? '天生功法' : '后天功法'],
  });
};
