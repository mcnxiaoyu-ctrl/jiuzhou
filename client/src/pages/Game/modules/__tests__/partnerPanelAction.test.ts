/**
 * 伙伴面板出战动作、状态标签与选中回退规则测试
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：锁定伙伴面板“设为出战 / 下阵”文案规则、状态标签优先级，以及无出战伙伴时的默认选中回退逻辑。
 * 2. 做什么：把高频 UI 判断收敛到共享纯函数，避免按钮文案、状态标签和选中逻辑散在组件 JSX 与 effect 中。
 * 3. 不做什么：不渲染真实弹窗、不发请求，也不覆盖伙伴升级、功法或招募链路。
 *
 * 输入/输出：
 * - 输入：伙伴是否出战、上架/归契状态、伙伴总览 DTO 片段、当前选中伙伴 ID。
 * - 输出：伙伴操作文案、状态标签描述，以及伙伴弹窗下一次应选中的伙伴 ID。
 *
 * 数据流/状态流：
 * partner overview DTO -> partnerShared 纯函数 -> PartnerModal 按钮文案 / 状态标签 / 选中伙伴状态。
 *
 * 关键边界条件与坑点：
 * 1. 坊市中或归契中的伙伴都不能继续展示“待命中/未出战”，否则会和“当前不可出战”的业务语义冲突。
 * 2. 当前没有出战伙伴时，不能因为 `activePartnerId = null` 就让弹窗落到空详情，必须回退到第一个伙伴。
 * 3. 当前已选中的伙伴仍然存在时，不应因为总览刷新而强制跳走，否则玩家查看详情会频繁丢焦点。
 */

import { describe, expect, it } from 'vitest';
import type { PartnerDetailDto, PartnerOverviewDto } from '../../../../services/api/partner';
import {
  PARTNER_REBONE_ELIXIR_ITEM_DEF_ID,
  resolvePartnerReboneElixirItem,
  resolvePartnerActionLabel,
  resolvePartnerNextSelectedId,
  resolvePartnerStatusTagDescriptors,
} from '../PartnerModal/partnerShared';

const createPartner = (params: {
  id: number;
  isActive: boolean;
  name: string;
  isGenerated?: boolean;
  tradeStatus?: PartnerDetailDto['tradeStatus'];
  fusionStatus?: PartnerDetailDto['fusionStatus'];
}): PartnerDetailDto => ({
  id: params.id,
  partnerDefId: `partner-${params.id}`,
  nickname: params.name,
  name: params.name,
  description: `${params.name} 描述`,
  tradeStatus: params.tradeStatus ?? 'none',
  marketListingId: null,
  fusionStatus: params.fusionStatus ?? 'none',
  fusionJobId: null,
  isGenerated: params.isGenerated ?? false,
  avatar: null,
  element: 'mu',
  role: '剑修',
  quality: '黄',
  level: 1,
  currentEffectiveLevel: 1,
  progressExp: 0,
  nextLevelCostExp: 100,
  slotCount: 1,
  isActive: params.isActive,
  obtainedFrom: 'main_quest',
  growth: {
    max_qixue: 1000,
    wugong: 1000,
    fagong: 1000,
    wufang: 1000,
    fafang: 1000,
    sudu: 1000,
  },
  levelAttrGains: {
    max_qixue: 89,
    max_lingqi: 0,
    wugong: 12,
    fagong: 0,
    wufang: 8,
    fafang: 0,
    mingzhong: 0,
    shanbi: 0,
    zhaojia: 0,
    baoji: 0,
    baoshang: 0,
    jianbaoshang: 0,
    jianfantan: 0,
    kangbao: 0,
    zengshang: 0,
    zhiliao: 0,
    jianliao: 0,
    xixue: 0,
    lengque: 0,
    sudu: 5,
    kongzhi_kangxing: 0,
    jin_kangxing: 0,
    mu_kangxing: 0,
    shui_kangxing: 0,
    huo_kangxing: 0,
    tu_kangxing: 0,
    qixue_huifu: 0,
    lingqi_huifu: 0,
  },
  computedAttrs: {
    qixue: 100,
    max_qixue: 100,
    lingqi: 50,
    max_lingqi: 50,
    wugong: 10,
    fagong: 10,
    wufang: 10,
    fafang: 10,
    mingzhong: 0,
    shanbi: 0,
    zhaojia: 0,
    baoji: 0,
    baoshang: 0,
    jianbaoshang: 0,
    jianfantan: 0,
    kangbao: 0,
    zengshang: 0,
    zhiliao: 0,
    jianliao: 0,
    xixue: 0,
    lengque: 0,
    sudu: 10,
    kongzhi_kangxing: 0,
    jin_kangxing: 0,
    mu_kangxing: 0,
    shui_kangxing: 0,
    huo_kangxing: 0,
    tu_kangxing: 0,
    qixue_huifu: 0,
    lingqi_huifu: 0,
  },
  techniques: [],
});

const createOverview = (params: {
  activePartnerId: number | null;
  partners: PartnerDetailDto[];
  partnerConsumables?: PartnerOverviewDto['partnerConsumables'];
}): PartnerOverviewDto => ({
  featureCode: 'partner_system',
  activePartnerId: params.activePartnerId,
  characterExp: 0,
  partners: params.partners,
  books: [],
  partnerConsumables: params.partnerConsumables ?? [],
});

describe('partnerShared 出战动作', () => {
  it('未出战伙伴应显示设为出战', () => {
    expect(resolvePartnerActionLabel(false)).toBe('设为出战');
  });

  it('当前出战伙伴应显示下阵', () => {
    expect(resolvePartnerActionLabel(true)).toBe('下阵');
  });
});

describe('resolvePartnerStatusTagDescriptors', () => {
  it('坊市中的伙伴应把坊市中排到最前，且不再显示待命中', () => {
    expect(resolvePartnerStatusTagDescriptors(createPartner({
      id: 31,
      isActive: false,
      name: '青萝',
      tradeStatus: 'market_listed',
      fusionStatus: 'fusion_locked',
    }), 'list')).toEqual([
      { key: 'market_listed', color: 'orange', label: '坊市中' },
      { key: 'fusion_locked', color: 'magenta', label: '归契中' },
    ]);
  });

  it('归契中的伙伴应把归契中排到最前，且不再显示未出战标签', () => {
    expect(resolvePartnerStatusTagDescriptors(createPartner({
      id: 33,
      isActive: false,
      name: '墨麟',
      fusionStatus: 'fusion_locked',
    }), 'summary')).toEqual([
      { key: 'fusion_locked', color: 'magenta', label: '归契中' },
    ]);
  });

  it('详情卡片应沿用统一状态顺序，但保留当前出战文案', () => {
    expect(resolvePartnerStatusTagDescriptors(createPartner({
      id: 32,
      isActive: true,
      name: '玄槐',
    }), 'summary')).toEqual([
      { key: 'active', color: 'green', label: '当前出战' },
    ]);
  });
});

describe('resolvePartnerNextSelectedId', () => {
  it('当前已选中的伙伴仍存在时应保持原选择', () => {
    const overview = createOverview({
      activePartnerId: null,
      partners: [
        createPartner({ id: 1, isActive: false, name: '青萝' }),
        createPartner({ id: 2, isActive: false, name: '玄槐' }),
      ],
    });

    expect(resolvePartnerNextSelectedId(overview, 2)).toBe(2);
  });

  it('无出战伙伴且当前选择失效时应回退到第一个伙伴', () => {
    const overview = createOverview({
      activePartnerId: null,
      partners: [
        createPartner({ id: 11, isActive: false, name: '青萝' }),
        createPartner({ id: 12, isActive: false, name: '玄槐' }),
      ],
    });

    expect(resolvePartnerNextSelectedId(overview, 99)).toBe(11);
  });

  it('存在出战伙伴且当前选择失效时应优先回退到出战伙伴', () => {
    const overview = createOverview({
      activePartnerId: 22,
      partners: [
        createPartner({ id: 21, isActive: false, name: '青萝' }),
        createPartner({ id: 22, isActive: true, name: '玄槐' }),
      ],
    });

    expect(resolvePartnerNextSelectedId(overview, null)).toBe(22);
  });
});

describe('resolvePartnerReboneElixirItem', () => {
  it('动态伙伴存在归元洗髓露时应返回可用道具', () => {
    const partner = createPartner({ id: 41, isActive: false, name: '玄槐', isGenerated: true });
    const overview = createOverview({
      activePartnerId: null,
      partners: [partner],
      partnerConsumables: [{
        itemDefId: PARTNER_REBONE_ELIXIR_ITEM_DEF_ID,
        itemInstanceId: 9001,
        name: '归元洗髓露',
        icon: '/assets/items/pill_xisui.png',
        qty: 2,
      }],
    });

    expect(resolvePartnerReboneElixirItem(partner, overview)).toEqual({
      itemDefId: PARTNER_REBONE_ELIXIR_ITEM_DEF_ID,
      itemInstanceId: 9001,
      name: '归元洗髓露',
      icon: '/assets/items/pill_xisui.png',
      qty: 2,
    });
  });

  it('静态伙伴即使存在归元洗髓露也不应返回可用道具', () => {
    const partner = createPartner({ id: 42, isActive: false, name: '青萝', isGenerated: false });
    const overview = createOverview({
      activePartnerId: null,
      partners: [partner],
      partnerConsumables: [{
        itemDefId: PARTNER_REBONE_ELIXIR_ITEM_DEF_ID,
        itemInstanceId: 9002,
        name: '归元洗髓露',
        icon: '/assets/items/pill_xisui.png',
        qty: 1,
      }],
    });

    expect(resolvePartnerReboneElixirItem(partner, overview)).toBeNull();
  });
});
