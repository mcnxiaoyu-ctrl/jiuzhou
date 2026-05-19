/**
 * 伙伴招募属性定位分布。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：按品质、seed、战斗风格与属性定位生成服务端锁定的伙伴基础属性和每级成长。
 * 2. 做什么：把“护卫高气血高防、输出高主攻、控制高速度”等数值差异收敛到单一纯函数入口。
 * 3. 不做什么：不调用 AI、不落库、不决定伙伴名字、描述、元素或天生功法文案。
 *
 * 输入 / 输出：
 * - 输入：伙伴品质、生成 seed，可选属性定位与 combatStyle。
 * - 输出：属性定位说明、锁定 combatStyle、完整 baseAttrs 与 levelAttrGains。
 *
 * 数据流 / 状态流：
 * buildGeneratedPartnerTextModelRequest -> rollPartnerRecruitLockedAttrProfile -> prompt lockedPartnerAttrs -> validate 后覆盖草稿数值 -> 落库预览。
 *
 * 复用设计说明：
 * - 招募与三魂归契共用伙伴文本请求构造，因此锁定属性也放在共享层，避免两个入口各自维护血量/攻击/防御分布。
 * - 属性定位是高频调参点，集中在这里后只改 profile 区间，不需要改 prompt、service 和 worker。
 *
 * 关键边界条件与坑点：
 * 1. 气血成长上限必须继续受 PARTNER_RECRUIT_MAX_QIXUE_GROWTH_BY_QUALITY 约束，不能因为护卫定位突破品质上限。
 * 2. combatStyle 必须和主攻成长一致，否则后续生成天生功法时会把物理/法术方向接错。
 */
import {
  buildDeterministicScopedSeed,
  hashTextUnitFloat,
} from './deterministicHash.js';
import {
  PARTNER_RECRUIT_MAX_QIXUE_GROWTH_BY_QUALITY,
  type PartnerRecruitBaseAttrs,
  type PartnerRecruitCombatStyle,
  type PartnerRecruitDraft,
  type PartnerRecruitQuality,
} from './partnerRecruitRules.js';

export type PartnerRecruitAttrProfileId =
  | 'burst_attacker'
  | 'sustained_attacker'
  | 'guard_tank'
  | 'support_healer'
  | 'speed_controller';

export type PartnerRecruitLockedAttrProfile = {
  id: PartnerRecruitAttrProfileId;
  label: string;
  description: string;
  roleKeywords: readonly string[];
  combatStyle: PartnerRecruitCombatStyle;
  baseAttrs: PartnerRecruitBaseAttrs;
  levelAttrGains: PartnerRecruitBaseAttrs;
};

type PartnerRecruitAttrProfileConfig = {
  id: PartnerRecruitAttrProfileId;
  label: string;
  description: string;
  roleKeywords: readonly string[];
  weight: number;
  qixueRatio: readonly [number, number];
  mainAttackRatio: readonly [number, number];
  secondaryAttackRatio: readonly [number, number];
  defenseRatio: readonly [number, number];
  speedRatio: readonly [number, number];
  baseQixueRatio: readonly [number, number];
  baseMainAttackRatio: readonly [number, number];
  baseDefenseRatio: readonly [number, number];
  sustainRatio: readonly [number, number];
};

type QualityMainAttackRange = {
  min: number;
  max: number;
};

const QUALITY_MAIN_ATTACK_RANGE: Record<PartnerRecruitQuality, QualityMainAttackRange> = {
  黄: { min: 10, max: 20 },
  玄: { min: 15, max: 30 },
  地: { min: 20, max: 40 },
  天: { min: 25, max: 50 },
};

const QUALITY_BASE_QIXUE_RANGE: Record<PartnerRecruitQuality, readonly [number, number]> = {
  黄: [220, 460],
  玄: [420, 820],
  地: [720, 1280],
  天: [960, 1800],
};

const QUALITY_BASE_ATTACK_RANGE: Record<PartnerRecruitQuality, readonly [number, number]> = {
  黄: [24, 54],
  玄: [48, 92],
  地: [82, 140],
  天: [118, 190],
};

const QUALITY_BASE_DEFENSE_RANGE: Record<PartnerRecruitQuality, readonly [number, number]> = {
  黄: [18, 42],
  玄: [34, 68],
  地: [58, 102],
  天: [78, 128],
};

const QUALITY_LINGQI_RANGE: Record<PartnerRecruitQuality, readonly [number, number]> = {
  黄: [60, 105],
  玄: [82, 128],
  地: [104, 152],
  天: [120, 180],
};

const QUALITY_BASE_SPEED_RANGE: Record<PartnerRecruitQuality, readonly [number, number]> = {
  黄: [5, 10],
  玄: [7, 13],
  地: [9, 16],
  天: [11, 20],
};

export const PARTNER_RECRUIT_LEVEL_DEFENSE_GROWTH_SCALE = 2 / 3;

const PARTNER_RECRUIT_ATTR_PROFILE_CONFIGS: readonly PartnerRecruitAttrProfileConfig[] = [
  {
    id: 'burst_attacker',
    label: '爆发输出',
    description: '主攻成长高，气血和双防偏低，适合刺杀、突进、爆发压制。',
    roleKeywords: ['刺客', '妖锋', '破阵', '猎杀'],
    weight: 26,
    qixueRatio: [0.42, 0.68],
    mainAttackRatio: [0.68, 1],
    secondaryAttackRatio: [0.36, 0.58],
    defenseRatio: [0.42, 0.62],
    speedRatio: [0.58, 0.86],
    baseQixueRatio: [0.4, 0.66],
    baseMainAttackRatio: [0.72, 1],
    baseDefenseRatio: [0.44, 0.64],
    sustainRatio: [0.35, 0.58],
  },
  {
    id: 'sustained_attacker',
    label: '持续输出',
    description: '主攻和气血都处于中高档，防御不极端，适合稳定压制。',
    roleKeywords: ['战修', '游侠', '斗士', '灵将'],
    weight: 24,
    qixueRatio: [0.55, 0.78],
    mainAttackRatio: [0.54, 0.82],
    secondaryAttackRatio: [0.38, 0.62],
    defenseRatio: [0.5, 0.72],
    speedRatio: [0.42, 0.68],
    baseQixueRatio: [0.54, 0.78],
    baseMainAttackRatio: [0.56, 0.84],
    baseDefenseRatio: [0.5, 0.74],
    sustainRatio: [0.46, 0.7],
  },
  {
    id: 'guard_tank',
    label: '护卫肉盾',
    description: '气血和双防成长最高，主攻成长让位给承伤和守护。',
    roleKeywords: ['护卫', '镇守', '盾卫', '守御'],
    weight: 20,
    qixueRatio: [0.78, 1],
    mainAttackRatio: [0.34, 0.56],
    secondaryAttackRatio: [0.28, 0.46],
    defenseRatio: [0.72, 1],
    speedRatio: [0.22, 0.46],
    baseQixueRatio: [0.72, 1],
    baseMainAttackRatio: [0.4, 0.62],
    baseDefenseRatio: [0.72, 1],
    sustainRatio: [0.72, 1],
  },
  {
    id: 'support_healer',
    label: '治疗辅助',
    description: '气血和回复成长偏高，主攻较低，适合治疗、护持、增益。',
    roleKeywords: ['医灵', '祝师', '护法', '灵侍'],
    weight: 16,
    qixueRatio: [0.66, 0.9],
    mainAttackRatio: [0.3, 0.5],
    secondaryAttackRatio: [0.28, 0.48],
    defenseRatio: [0.58, 0.82],
    speedRatio: [0.36, 0.62],
    baseQixueRatio: [0.62, 0.88],
    baseMainAttackRatio: [0.36, 0.58],
    baseDefenseRatio: [0.56, 0.82],
    sustainRatio: [0.7, 0.96],
  },
  {
    id: 'speed_controller',
    label: '高速控制',
    description: '速度成长最高，气血偏低，适合先手、干扰、控制。',
    roleKeywords: ['控灵', '疾使', '封咒', '影使'],
    weight: 14,
    qixueRatio: [0.38, 0.62],
    mainAttackRatio: [0.42, 0.66],
    secondaryAttackRatio: [0.32, 0.54],
    defenseRatio: [0.38, 0.58],
    speedRatio: [0.76, 1],
    baseQixueRatio: [0.38, 0.62],
    baseMainAttackRatio: [0.44, 0.7],
    baseDefenseRatio: [0.4, 0.6],
    sustainRatio: [0.36, 0.58],
  },
] as const;

const ATTR_PROFILE_BY_ID: Record<PartnerRecruitAttrProfileId, PartnerRecruitAttrProfileConfig> =
  PARTNER_RECRUIT_ATTR_PROFILE_CONFIGS.reduce<Record<PartnerRecruitAttrProfileId, PartnerRecruitAttrProfileConfig>>(
    (map, config) => ({
      ...map,
      [config.id]: config,
    }),
    {
      burst_attacker: PARTNER_RECRUIT_ATTR_PROFILE_CONFIGS[0],
      sustained_attacker: PARTNER_RECRUIT_ATTR_PROFILE_CONFIGS[1],
      guard_tank: PARTNER_RECRUIT_ATTR_PROFILE_CONFIGS[2],
      support_healer: PARTNER_RECRUIT_ATTR_PROFILE_CONFIGS[3],
      speed_controller: PARTNER_RECRUIT_ATTR_PROFILE_CONFIGS[4],
    },
  );

const normalizeSeed = (seed: number): number => {
  if (!Number.isFinite(seed)) {
    throw new Error('伙伴招募属性定位 seed 非法');
  }
  return Math.max(0, Math.floor(seed));
};

const rollUnit = (
  seed: number,
  scope: string,
): number => {
  return hashTextUnitFloat(buildDeterministicScopedSeed('partner-recruit-attr-profile', `${scope}:${seed}`));
};

const rollNumber = (
  seed: number,
  scope: string,
  range: readonly [number, number],
): number => {
  const [min, max] = range;
  return min + (max - min) * rollUnit(seed, scope);
};

const rollInteger = (
  seed: number,
  scope: string,
  range: readonly [number, number],
): number => {
  return Math.round(rollNumber(seed, scope, range));
};

const rollByRatio = (params: {
  seed: number;
  scope: string;
  sourceRange: readonly [number, number];
  ratioRange: readonly [number, number];
  integer?: boolean;
}): number => {
  const [sourceMin, sourceMax] = params.sourceRange;
  const [ratioMin, ratioMax] = params.ratioRange;
  const min = sourceMin + (sourceMax - sourceMin) * ratioMin;
  const max = sourceMin + (sourceMax - sourceMin) * ratioMax;
  return params.integer === false
    ? Number(rollNumber(params.seed, params.scope, [min, max]).toFixed(3))
    : rollInteger(params.seed, params.scope, [min, max]);
};

const rollQualityMainAttack = (params: {
  quality: PartnerRecruitQuality;
  seed: number;
  scope: string;
  ratioRange: readonly [number, number];
}): number => {
  const range = QUALITY_MAIN_ATTACK_RANGE[params.quality];
  return rollByRatio({
    seed: params.seed,
    scope: params.scope,
    sourceRange: [range.min, range.max],
    ratioRange: params.ratioRange,
  });
};

export const scalePartnerRecruitLevelDefenseGrowth = (
  value: number,
): number => {
  if (!Number.isFinite(value)) {
    throw new Error('伙伴招募双防成长值非法');
  }
  return Math.max(0, Math.round(value * PARTNER_RECRUIT_LEVEL_DEFENSE_GROWTH_SCALE));
};

const rollProfileConfig = (seed: number): PartnerRecruitAttrProfileConfig => {
  const totalWeight = PARTNER_RECRUIT_ATTR_PROFILE_CONFIGS.reduce((sum, config) => sum + config.weight, 0);
  let rolledWeight = rollUnit(seed, 'profile') * totalWeight;
  for (const config of PARTNER_RECRUIT_ATTR_PROFILE_CONFIGS) {
    rolledWeight -= config.weight;
    if (rolledWeight < 0) return config;
  }
  return PARTNER_RECRUIT_ATTR_PROFILE_CONFIGS[PARTNER_RECRUIT_ATTR_PROFILE_CONFIGS.length - 1];
};

const rollCombatStyle = (
  seed: number,
  profileId: PartnerRecruitAttrProfileId,
): PartnerRecruitCombatStyle => {
  const magicThreshold = profileId === 'support_healer' ? 0.75 : 0.5;
  return rollUnit(seed, `combat-style:${profileId}`) < magicThreshold ? 'magic' : 'physical';
};

const buildEmptyAttrs = (): PartnerRecruitBaseAttrs => ({
  max_qixue: 0,
  max_lingqi: 0,
  wugong: 0,
  fagong: 0,
  wufang: 0,
  fafang: 0,
  sudu: 0,
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
  kongzhi_kangxing: 0,
  jin_kangxing: 0,
  mu_kangxing: 0,
  shui_kangxing: 0,
  huo_kangxing: 0,
  tu_kangxing: 0,
  qixue_huifu: 0,
  lingqi_huifu: 0,
});

const buildProfileBaseAttrs = (params: {
  quality: PartnerRecruitQuality;
  seed: number;
  profile: PartnerRecruitAttrProfileConfig;
  combatStyle: PartnerRecruitCombatStyle;
}): PartnerRecruitBaseAttrs => {
  const { quality, seed, profile, combatStyle } = params;
  const mainAttackKey = combatStyle === 'physical' ? 'wugong' : 'fagong';
  const secondaryAttackKey = combatStyle === 'physical' ? 'fagong' : 'wugong';
  const mainAttack = rollByRatio({
    seed,
    scope: 'base-main-attack',
    sourceRange: QUALITY_BASE_ATTACK_RANGE[quality],
    ratioRange: profile.baseMainAttackRatio,
  });
  const secondaryAttack = rollByRatio({
    seed,
    scope: 'base-secondary-attack',
    sourceRange: QUALITY_BASE_ATTACK_RANGE[quality],
    ratioRange: profile.secondaryAttackRatio,
  });
  const attrs = buildEmptyAttrs();

  attrs.max_qixue = rollByRatio({
    seed,
    scope: 'base-qixue',
    sourceRange: QUALITY_BASE_QIXUE_RANGE[quality],
    ratioRange: profile.baseQixueRatio,
  });
  attrs.max_lingqi = rollInteger(seed, 'base-lingqi', QUALITY_LINGQI_RANGE[quality]);
  attrs[mainAttackKey] = mainAttack;
  attrs[secondaryAttackKey] = secondaryAttack;
  attrs.wufang = rollByRatio({
    seed,
    scope: 'base-wufang',
    sourceRange: QUALITY_BASE_DEFENSE_RANGE[quality],
    ratioRange: profile.baseDefenseRatio,
  });
  attrs.fafang = rollByRatio({
    seed,
    scope: 'base-fafang',
    sourceRange: QUALITY_BASE_DEFENSE_RANGE[quality],
    ratioRange: profile.baseDefenseRatio,
  });
  attrs.sudu = rollByRatio({
    seed,
    scope: 'base-sudu',
    sourceRange: QUALITY_BASE_SPEED_RANGE[quality],
    ratioRange: profile.speedRatio,
  });
  attrs.mingzhong = Number(rollNumber(seed, 'base-mingzhong', [0.94, 1.02]).toFixed(3));
  attrs.shanbi = Number(rollNumber(seed, 'base-shanbi', [0.03, 0.14 * profile.speedRatio[1]]).toFixed(3));
  attrs.zhaojia = Number(rollNumber(seed, 'base-zhaojia', [0.04, 0.18 * profile.defenseRatio[1]]).toFixed(3));
  attrs.baoji = Number(rollNumber(seed, 'base-baoji', [0.06, 0.16 * profile.mainAttackRatio[1]]).toFixed(3));
  attrs.baoshang = Number(rollNumber(seed, 'base-baoshang', [1.58, 1.82]).toFixed(3));
  attrs.jianbaoshang = Number(rollNumber(seed, 'base-jianbaoshang', [0.04, 0.1 * profile.defenseRatio[1]]).toFixed(3));
  attrs.jianfantan = Number(rollNumber(seed, 'base-jianfantan', [0.02, 0.08 * profile.defenseRatio[1]]).toFixed(3));
  attrs.kangbao = Number(rollNumber(seed, 'base-kangbao', [0.05, 0.12 * profile.defenseRatio[1]]).toFixed(3));
  attrs.zengshang = Number(rollNumber(seed, 'base-zengshang', [0.08, 0.14 * profile.mainAttackRatio[1]]).toFixed(3));
  attrs.zhiliao = Number(rollNumber(seed, 'base-zhiliao', [0, 0.08 * profile.sustainRatio[1]]).toFixed(3));
  attrs.jianliao = Number(rollNumber(seed, 'base-jianliao', [0, 0.04]).toFixed(3));
  attrs.xixue = Number(rollNumber(seed, 'base-xixue', [0, 0.06 * profile.mainAttackRatio[1]]).toFixed(3));
  attrs.lengque = Number(rollNumber(seed, 'base-lengque', [0, 0.04 * profile.speedRatio[1]]).toFixed(3));
  attrs.kongzhi_kangxing = Number(rollNumber(seed, 'base-control-resist', [0.06, 0.12]).toFixed(3));
  attrs.jin_kangxing = Number(rollNumber(seed, 'base-jin-resist', [0.05, 0.14]).toFixed(3));
  attrs.mu_kangxing = Number(rollNumber(seed, 'base-mu-resist', [0.05, 0.14]).toFixed(3));
  attrs.shui_kangxing = Number(rollNumber(seed, 'base-shui-resist', [0.05, 0.14]).toFixed(3));
  attrs.huo_kangxing = Number(rollNumber(seed, 'base-huo-resist', [0.05, 0.14]).toFixed(3));
  attrs.tu_kangxing = Number(rollNumber(seed, 'base-tu-resist', [0.05, 0.14]).toFixed(3));
  attrs.qixue_huifu = rollInteger(seed, 'base-qixue-recover', [4, 10 * profile.sustainRatio[1]]);
  attrs.lingqi_huifu = rollInteger(seed, 'base-lingqi-recover', [3, 6]);

  return attrs;
};

const buildProfileLevelAttrGains = (params: {
  quality: PartnerRecruitQuality;
  seed: number;
  profile: PartnerRecruitAttrProfileConfig;
  combatStyle: PartnerRecruitCombatStyle;
}): PartnerRecruitBaseAttrs => {
  const { quality, seed, profile, combatStyle } = params;
  const mainAttackKey = combatStyle === 'physical' ? 'wugong' : 'fagong';
  const secondaryAttackKey = combatStyle === 'physical' ? 'fagong' : 'wugong';
  const attrs = buildEmptyAttrs();

  attrs.max_qixue = rollByRatio({
    seed,
    scope: 'level-qixue',
    sourceRange: [0, PARTNER_RECRUIT_MAX_QIXUE_GROWTH_BY_QUALITY[quality]],
    ratioRange: profile.qixueRatio,
  });
  attrs.max_lingqi = rollInteger(seed, 'level-lingqi', [6, quality === '天' ? 13 : quality === '地' ? 11 : quality === '玄' ? 9 : 7]);
  attrs[mainAttackKey] = rollQualityMainAttack({
    quality,
    seed,
    scope: 'level-main-attack',
    ratioRange: profile.mainAttackRatio,
  });
  attrs[secondaryAttackKey] = rollQualityMainAttack({
    quality,
    seed,
    scope: 'level-secondary-attack',
    ratioRange: profile.secondaryAttackRatio,
  });
  attrs.wufang = rollQualityMainAttack({
    quality,
    seed,
    scope: 'level-wufang',
    ratioRange: profile.defenseRatio,
  });
  attrs.wufang = scalePartnerRecruitLevelDefenseGrowth(attrs.wufang);
  attrs.fafang = rollQualityMainAttack({
    quality,
    seed,
    scope: 'level-fafang',
    ratioRange: profile.defenseRatio,
  });
  attrs.fafang = scalePartnerRecruitLevelDefenseGrowth(attrs.fafang);
  attrs.sudu = rollByRatio({
    seed,
    scope: 'level-speed',
    sourceRange: [0.02, 0.14],
    ratioRange: profile.speedRatio,
    integer: false,
  });
  attrs.mingzhong = Number(rollNumber(seed, 'level-mingzhong', [0.001, 0.003]).toFixed(3));
  attrs.shanbi = Number(rollNumber(seed, 'level-shanbi', [0.0005, 0.003 * profile.speedRatio[1]]).toFixed(4));
  attrs.zhaojia = Number(rollNumber(seed, 'level-zhaojia', [0.001, 0.004 * profile.defenseRatio[1]]).toFixed(4));
  attrs.baoji = Number(rollNumber(seed, 'level-baoji', [0.001, 0.004 * profile.mainAttackRatio[1]]).toFixed(4));
  attrs.baoshang = Number(rollNumber(seed, 'level-baoshang', [0.006, 0.012]).toFixed(4));
  attrs.jianbaoshang = Number(rollNumber(seed, 'level-jianbaoshang', [0.001, 0.003 * profile.defenseRatio[1]]).toFixed(4));
  attrs.jianfantan = Number(rollNumber(seed, 'level-jianfantan', [0.0005, 0.003 * profile.defenseRatio[1]]).toFixed(4));
  attrs.kangbao = Number(rollNumber(seed, 'level-kangbao', [0.001, 0.003 * profile.defenseRatio[1]]).toFixed(4));
  attrs.zengshang = Number(rollNumber(seed, 'level-zengshang', [0.001, 0.004 * profile.mainAttackRatio[1]]).toFixed(4));
  attrs.zhiliao = Number(rollNumber(seed, 'level-zhiliao', [0, 0.0025 * profile.sustainRatio[1]]).toFixed(4));
  attrs.jianliao = Number(rollNumber(seed, 'level-jianliao', [0, 0.0015]).toFixed(4));
  attrs.xixue = Number(rollNumber(seed, 'level-xixue', [0, 0.002 * profile.mainAttackRatio[1]]).toFixed(4));
  attrs.lengque = Number(rollNumber(seed, 'level-cooldown', [0, 0.0015 * profile.speedRatio[1]]).toFixed(4));
  attrs.kongzhi_kangxing = Number(rollNumber(seed, 'level-control-resist', [0.001, 0.003]).toFixed(4));
  attrs.jin_kangxing = Number(rollNumber(seed, 'level-jin-resist', [0.001, 0.003]).toFixed(4));
  attrs.mu_kangxing = Number(rollNumber(seed, 'level-mu-resist', [0.001, 0.003]).toFixed(4));
  attrs.shui_kangxing = Number(rollNumber(seed, 'level-shui-resist', [0.001, 0.003]).toFixed(4));
  attrs.huo_kangxing = Number(rollNumber(seed, 'level-huo-resist', [0.001, 0.003]).toFixed(4));
  attrs.tu_kangxing = Number(rollNumber(seed, 'level-tu-resist', [0.001, 0.003]).toFixed(4));
  attrs.qixue_huifu = Number(rollNumber(seed, 'level-qixue-recover', [0.22, 0.55 * profile.sustainRatio[1]]).toFixed(3));
  attrs.lingqi_huifu = Number(rollNumber(seed, 'level-lingqi-recover', [0.18, 0.34]).toFixed(3));

  return attrs;
};

export const buildPartnerRecruitLockedAttrProfile = (params: {
  quality: PartnerRecruitQuality;
  seed: number;
  profileId: PartnerRecruitAttrProfileId;
  combatStyle: PartnerRecruitCombatStyle;
}): PartnerRecruitLockedAttrProfile => {
  const seed = normalizeSeed(params.seed);
  const profile = ATTR_PROFILE_BY_ID[params.profileId];
  return {
    id: profile.id,
    label: profile.label,
    description: profile.description,
    roleKeywords: profile.roleKeywords,
    combatStyle: params.combatStyle,
    baseAttrs: buildProfileBaseAttrs({
      quality: params.quality,
      seed,
      profile,
      combatStyle: params.combatStyle,
    }),
    levelAttrGains: buildProfileLevelAttrGains({
      quality: params.quality,
      seed,
      profile,
      combatStyle: params.combatStyle,
    }),
  };
};

export const rollPartnerRecruitLockedAttrProfile = (params: {
  quality: PartnerRecruitQuality;
  seed: number;
}): PartnerRecruitLockedAttrProfile => {
  const seed = normalizeSeed(params.seed);
  const profile = rollProfileConfig(seed);
  return buildPartnerRecruitLockedAttrProfile({
    quality: params.quality,
    seed,
    profileId: profile.id,
    combatStyle: rollCombatStyle(seed, profile.id),
  });
};

export const applyPartnerRecruitLockedAttrProfileToDraft = (
  draft: PartnerRecruitDraft,
  lockedAttrProfile: PartnerRecruitLockedAttrProfile,
): PartnerRecruitDraft | null => {
  if (draft.partner.combatStyle !== lockedAttrProfile.combatStyle) {
    return null;
  }
  return {
    ...draft,
    partner: {
      ...draft.partner,
      combatStyle: lockedAttrProfile.combatStyle,
      baseAttrs: lockedAttrProfile.baseAttrs,
      levelAttrGains: lockedAttrProfile.levelAttrGains,
    },
  };
};
