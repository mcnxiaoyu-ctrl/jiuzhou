/**
 * 正式称号效果文案共享工具
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把正式称号属性加成的标签映射、排序和格式化口径收敛为一个纯函数工具，供成就页与云游奇遇弹窗复用。
 * 2. 做什么：统一平面值与百分比值的显示规则，避免称号效果在不同页面出现顺序和文案不一致。
 * 3. 不做什么：不处理称号来源、不请求接口，也不决定哪些称号该展示。
 *
 * 输入/输出：
 * - 输入：`effects` 属性映射。
 * - 输出：可直接展示的中文文案；无有效属性时返回“无属性加成”。
 *
 * 数据流/状态流：
 * 正式称号 DTO -> 本模块格式化 -> 成就页/云游页展示统一效果文本。
 *
 * 关键边界条件与坑点：
 * 1. 百分比属性必须继续复用统一的 `formatSignedPercent` 口径，否则不同页面会出现“同值不同格式”。
 * 2. 新增属性键时要同时补标签和排序，不然会退回原始 key，影响玩家可读性。
 */
import { formatSignedNumber, formatSignedPercent } from './formatAttr';

const titleEffectLabel: Record<string, string> = {
  qixue: '气血',
  max_qixue: '气血上限',
  lingqi: '灵气',
  max_lingqi: '灵气上限',
  wugong: '物攻',
  fagong: '法攻',
  wufang: '物防',
  fafang: '法防',
  mingzhong: '命中',
  shanbi: '闪避',
  zhaojia: '招架',
  baoji: '暴击',
  baoshang: '暴伤',
  jianbaoshang: '暴伤减免',
  jianfantan: '反伤减免',
  kangbao: '抗暴',
  zengshang: '增伤',
  zhiliao: '治疗',
  jianliao: '减疗',
  xixue: '吸血',
  lengque: '冷却',
  sudu: '速度',
  qixue_huifu: '气血恢复',
  lingqi_huifu: '灵气恢复',
  kongzhi_kangxing: '控制抗性',
  jin_kangxing: '金抗性',
  mu_kangxing: '木抗性',
  shui_kangxing: '水抗性',
  huo_kangxing: '火抗性',
  tu_kangxing: '土抗性',
};

const titleEffectOrder: Record<string, number> = Object.fromEntries(
  [
    'qixue',
    'max_qixue',
    'lingqi',
    'max_lingqi',
    'wugong',
    'fagong',
    'wufang',
    'fafang',
    'mingzhong',
    'shanbi',
    'zhaojia',
    'baoji',
    'baoshang',
    'jianbaoshang',
    'jianfantan',
    'kangbao',
    'zengshang',
    'zhiliao',
    'jianliao',
    'xixue',
    'lengque',
    'sudu',
    'qixue_huifu',
    'lingqi_huifu',
    'kongzhi_kangxing',
    'jin_kangxing',
    'mu_kangxing',
    'shui_kangxing',
    'huo_kangxing',
    'tu_kangxing',
  ].map((key, idx) => [key, idx]),
);

const titlePercentEffectKeys = new Set<string>([
  'mingzhong',
  'shanbi',
  'zhaojia',
  'baoji',
  'baoshang',
  'jianbaoshang',
  'jianfantan',
  'kangbao',
  'zengshang',
  'zhiliao',
  'jianliao',
  'xixue',
  'lengque',
  'kongzhi_kangxing',
  'jin_kangxing',
  'mu_kangxing',
  'shui_kangxing',
  'huo_kangxing',
  'tu_kangxing',
]);

const normalizeEffectKey = (key: string): string => {
  return key.trim().replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
};

const formatEffectValue = (key: string, value: number): string | null => {
  if (!Number.isFinite(value) || value === 0) return null;
  if (titlePercentEffectKeys.has(key)) return formatSignedPercent(value);
  return formatSignedNumber(value);
};

export const formatTitleEffectsText = (effects: Record<string, number>): string => {
  const rows = Object.entries(effects || {})
    .map(([rawKey, rawValue]) => {
      const key = normalizeEffectKey(rawKey);
      const value = Number(rawValue);
      const valueText = formatEffectValue(key, value);
      if (!valueText) return null;
      const label = titleEffectLabel[key] ?? titleEffectLabel[rawKey] ?? rawKey;
      return { key, text: `${label}${valueText}` };
    })
    .filter((entry): entry is { key: string; text: string } => entry !== null)
    .sort((a, b) => {
      const orderA = titleEffectOrder[a.key] ?? 999;
      const orderB = titleEffectOrder[b.key] ?? 999;
      return orderA - orderB || a.key.localeCompare(b.key);
    });

  if (rows.length <= 0) return '无属性加成';
  return rows.map((entry) => entry.text).join('，');
};
