import type { CSSProperties } from 'react';

/**
 * 作用：统一装备词条 ROLL 的解析、格式化与双主题颜色渐变算法。
 * 输入：词条中的 roll_ratio(0~1) 或 roll_percent(0~100)。
 * 输出：可直接给 UI 使用的百分比与浅/深主题颜色变量。
 * 关键约束：颜色分段固定为 0~25 绿、25~50 蓝、50~75 紫、75~100 红。
 */

export type AffixRollLike = {
  roll_ratio?: number;
  roll_percent?: number;
};

const clampPercent = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
};

/**
 * 读取词条 roll 百分比，兼容后端返回的 ratio(0~1) 与 percent(0~100)。
 */
export const getAffixRollPercent = (affix: AffixRollLike): number | null => {
  if (typeof affix.roll_percent === 'number' && Number.isFinite(affix.roll_percent)) {
    return clampPercent(affix.roll_percent);
  }
  if (typeof affix.roll_ratio === 'number' && Number.isFinite(affix.roll_ratio)) {
    return clampPercent(affix.roll_ratio * 100);
  }
  return null;
};

export const formatAffixRollPercent = (rollPercent: number | null): string => {
  if (rollPercent === null || !Number.isFinite(rollPercent)) return '--';
  const normalized = clampPercent(rollPercent);
  if (Math.abs(normalized - Math.round(normalized)) <= 1e-6) {
    return `${Math.round(normalized)}%`;
  }
  return `${Number(normalized.toFixed(2))}%`;
};

type Rgb = readonly [number, number, number];

const lerpChannel = (start: number, end: number, progress: number): number => {
  return Math.round(start + (end - start) * progress);
};

const mixRgb = (start: Rgb, end: Rgb, progress: number): Rgb => {
  const t = Math.max(0, Math.min(1, progress));
  return [
    lerpChannel(start[0], end[0], t),
    lerpChannel(start[1], end[1], t),
    lerpChannel(start[2], end[2], t),
  ] as const;
};

const rgbToCss = (rgb: Rgb): string => {
  return `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]})`;
};

type RollColorSegment = {
  start: number;
  end: number;
  from: Rgb;
  to: Rgb;
};

export type AffixRollThemeColor = {
  light: string;
  dark: string;
};

export type AffixRollColorVars = {
  '--affix-roll-color-light': string;
  '--affix-roll-color-dark': string;
};

export type AffixRollColorStyle = CSSProperties & AffixRollColorVars;

const ROLL_COLOR_SEGMENTS: ReadonlyArray<RollColorSegment> = [
  { start: 0, end: 25, from: [111, 195, 145], to: [45, 138, 94] }, // 青玉
  { start: 25, end: 50, from: [126, 190, 228], to: [54, 116, 185] }, // 霁青
  { start: 50, end: 75, from: [191, 165, 228], to: [111, 73, 174] }, // 灵紫
  { start: 75, end: 100, from: [227, 128, 116], to: [155, 52, 47] }, // 朱砂
];

/**
 * ROLL 颜色分段规则：
 * 1) 浅色主题：数值越高颜色越深，强化亮底上的对比度。
 * 2) 暗色主题：数值越高颜色越亮，强化暗底上的高 roll 感知。
 * 3) 色相分段保持 0~25 绿、25~50 蓝、50~75 紫、75~100 红。
 */
export const getAffixRollColor = (rollPercent: number | null): AffixRollThemeColor | null => {
  if (rollPercent === null || !Number.isFinite(rollPercent)) return null;
  const normalized = clampPercent(rollPercent);
  const segment =
    ROLL_COLOR_SEGMENTS.find((item) => normalized >= item.start && normalized <= item.end) ??
    ROLL_COLOR_SEGMENTS[ROLL_COLOR_SEGMENTS.length - 1];
  if (!segment) return null;
  const span = Math.max(1, segment.end - segment.start);
  const progress = (normalized - segment.start) / span;
  return {
    light: rgbToCss(mixRgb(segment.from, segment.to, progress)),
    dark: rgbToCss(mixRgb(segment.to, segment.from, progress)),
  };
};

export const getAffixRollColorVars = (rollPercent: number | null): AffixRollColorStyle | null => {
  const colors = getAffixRollColor(rollPercent);
  if (!colors) return null;
  return {
    '--affix-roll-color-light': colors.light,
    '--affix-roll-color-dark': colors.dark,
  };
};
