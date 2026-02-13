import { query } from '../config/database.js';
import type { MapObjectDto } from './roomObjectService.js';
import { getMonsterDefinitions, getNpcDefinitions, getTechniqueDefinitions } from './staticConfigLoader.js';

type InfoTargetType = 'npc' | 'monster' | 'item' | 'player';

type DropEntryRow = {
  mode: string;
  item_def_id: string;
  chance: number | null;
  weight: number | null;
  qty_min: number | null;
  qty_max: number | null;
  sort_order: number | null;
  item_name: string | null;
  item_quality: string | null;
};

type NpcRow = {
  id: string;
  name: string;
  title: string | null;
  gender: string | null;
  realm: string | null;
  avatar: string | null;
  description: string | null;
  drop_pool_id: string | null;
};

type MonsterRow = {
  id: string;
  name: string;
  title: string | null;
  realm: string | null;
  avatar: string | null;
  base_attrs: unknown;
  attr_variance: unknown;
  attr_multiplier_min: unknown;
  attr_multiplier_max: unknown;
  display_stats: unknown;
  drop_pool_id: string | null;
};

type ItemRow = {
  id: string;
  name: string;
  category: string | null;
  quality: string | null;
  level: number | null;
  icon: string | null;
  description: string | null;
  long_desc: string | null;
  equip_req_realm: string | null;
  use_req_realm: string | null;
  base_attrs: unknown;
};

type CharacterRow = {
  id: number;
  nickname: string | null;
  title: string | null;
  gender: string | null;
  avatar: string | null;
  realm: string | null;
  sub_realm: string | null;
};

type EquippedRow = {
  equipped_slot: string | null;
  item_name: string | null;
  resolved_quality: string | null;
};

type EquippedTechniqueRow = {
  technique_id: string | null;
  current_layer: number | null;
};

const asStatList = (value: unknown): Array<{ label: string; value: string | number }> | undefined => {
  if (!value) return undefined;
  if (Array.isArray(value)) return value as Array<{ label: string; value: string | number }>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? (parsed as Array<{ label: string; value: string | number }>) : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
};

const attrLabelMap: Record<string, string> = {
  qixue: '气血',
  max_qixue: '最大气血',
  lingqi: '灵气',
  max_lingqi: '最大灵气',
  wugong: '物攻',
  fagong: '法攻',
  wufang: '物防',
  fafang: '法防',
  mingzhong: '命中',
  shanbi: '闪避',
  zhaojia: '招架',
  baoji: '暴击',
  baoshang: '爆伤',
  kangbao: '抗暴',
  zengshang: '增伤',
  zhiliao: '治疗',
  jianliao: '减疗',
  xixue: '吸血',
  lengque: '冷却',
  shuxing_shuzhi: '属性数值',
  kongzhi_kangxing: '控制抗性',
  jin_kangxing: '金抗性',
  mu_kangxing: '木抗性',
  shui_kangxing: '水抗性',
  huo_kangxing: '火抗性',
  tu_kangxing: '土抗性',
  qixue_huifu: '气血恢复',
  lingqi_huifu: '灵气恢复',
  sudu: '速度',
  fuyuan: '福源',
};

const PERCENT_ATTR_KEYS = new Set<string>([
  'shuxing_shuzhi',
  'mingzhong',
  'shanbi',
  'zhaojia',
  'baoji',
  'baoshang',
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

const formatPercent = (value: number): string => {
  const percent = value * 100;
  const fixed = Math.abs(percent - Math.round(percent)) < 1e-9 ? percent.toFixed(0) : percent.toFixed(2);
  const trimmed = fixed.replace(/\.?0+$/, '') || '0';
  return `${trimmed}%`;
};

const toStatsFromAttrs = (attrs: unknown, prefix: string): Array<{ label: string; value: string | number }> => {
  if (!attrs) return [];
  let obj: unknown = attrs;
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj) as unknown;
    } catch {
      return [];
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  const entries = Object.entries(obj as Record<string, unknown>);
  const rows: Array<{ label: string; value: string | number }> = [];
  for (const [key, value] of entries) {
    if (value === null || value === undefined) continue;
    if (typeof value !== 'number' && typeof value !== 'string') continue;
    const label = attrLabelMap[key] ?? key;
    if (PERCENT_ATTR_KEYS.has(key)) {
      const n = typeof value === 'number' ? value : Number(value);
      if (Number.isFinite(n)) {
        rows.push({ label: `${prefix}${label}`, value: formatPercent(n) });
        continue;
      }
    }
    rows.push({ label: `${prefix}${label}`, value });
  }
  return rows;
};

const asNumberRecord = (value: unknown): Record<string, number> | undefined => {
  if (!value) return undefined;
  const parsed =
    typeof value === 'string'
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return null;
          }
        })()
      : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj)) {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (Number.isFinite(n)) out[k] = n;
  }
  return out;
};

const asNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};

const buildMonsterStats = (
  baseAttrs: Record<string, number> | undefined,
  fallback: Array<{ label: string; value: string | number }> | undefined,
) => {
  const attrs = baseAttrs ?? {};
  if (Object.keys(attrs).length === 0) return fallback;

  const knownKeys = Object.keys(attrLabelMap);
  const used = new Set<string>();
  const rows: Array<{ label: string; value: string | number }> = [];

  for (const k of knownKeys) {
    if (!(k in attrs)) continue;
    used.add(k);
    rows.push({ label: attrLabelMap[k] ?? k, value: attrs[k] });
  }

  const extraKeys = Object.keys(attrs).filter((k) => !used.has(k));
  extraKeys.sort((a, b) => a.localeCompare(b));
  for (const k of extraKeys) {
    rows.push({ label: attrLabelMap[k] ?? k, value: attrs[k] });
  }

  return rows;
};

const formatRatioPercent = (ratio: number): string => {
  return formatPercent(ratio);
};

const formatChance = (mode: string, chance: number, weight: number, totalWeight: number): string => {
  if (mode === 'weight') {
    if (totalWeight <= 0) return '-';
    return formatRatioPercent(weight / totalWeight);
  }
  return formatRatioPercent(chance);
};

const buildFullRealm = (realmRaw: string | null, subRealmRaw: string | null): string => {
  const realm = typeof realmRaw === 'string' ? realmRaw.trim() : '';
  const sub = typeof subRealmRaw === 'string' ? subRealmRaw.trim() : '';
  if (!realm) return '凡人';
  if (realm === '凡人' || !sub) return realm;
  return `${realm}·${sub}`;
};

const normalizeGender = (value: string | null): string | undefined => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return undefined;
  if (raw === 'male') return '男';
  if (raw === 'female') return '女';
  return raw;
};

const EQUIPPED_SLOT_TO_UI_LABEL: Record<string, string> = {
  weapon: '武器',
  head: '头部',
  clothes: '衣服',
  gloves: '护手',
  pants: '下装',
  necklace: '项链',
  accessory: '饰品',
  artifact: '法宝',
};

const getDropsByPoolId = async (dropPoolId: string): Promise<Array<{ name: string; quality: string; chance: string }>> => {
  const result = await query(
    `
      SELECT
        p.mode,
        e.item_def_id,
        e.chance,
        e.weight,
        e.qty_min,
        e.qty_max,
        e.sort_order,
        d.name AS item_name,
        d.quality AS item_quality
      FROM drop_pool p
      JOIN drop_pool_entry e ON e.drop_pool_id = p.id
      LEFT JOIN item_def d ON d.id = e.item_def_id
      WHERE p.enabled = true AND p.id = $1 AND e.show_in_ui = true
      ORDER BY e.sort_order ASC, e.id ASC
    `,
    [dropPoolId]
  );

  const rows = result.rows as DropEntryRow[];
  if (rows.length === 0) return [];

  const mode = rows[0]?.mode || 'prob';
  const totalWeight = mode === 'weight' ? rows.reduce((sum, r) => sum + Number(r.weight ?? 0), 0) : 0;

  return rows.map((r) => {
    const baseName = (r.item_name ?? r.item_def_id ?? '未知').trim() || '未知';
    const qtyMin = Number(r.qty_min ?? 1);
    const qtyMax = Number(r.qty_max ?? 1);
    const qtyText =
      qtyMin === qtyMax ? (qtyMin > 1 ? `×${qtyMin}` : '') : `×${Math.max(1, qtyMin)}-${Math.max(qtyMin, qtyMax)}`;
    const name = `${baseName}${qtyText}`;

    const quality = (r.item_quality ?? '-').trim() || '-';
    const chanceVal = Number(r.chance ?? 0);
    const weightVal = Number(r.weight ?? 0);
    const chance = formatChance(mode, chanceVal, weightVal, totalWeight);

    return { name, quality, chance };
  });
};

export const getInfoTargetDetail = async (type: InfoTargetType, id: string): Promise<MapObjectDto | null> => {
  if (type === 'npc') {
    const npc = (getNpcDefinitions().find((entry) => entry.enabled !== false && entry.id === id) ?? null) as NpcRow | null;
    if (!npc) return null;
    const drops = npc.drop_pool_id ? await getDropsByPoolId(npc.drop_pool_id) : [];
    return {
      type: 'npc',
      id: npc.id,
      name: npc.name,
      title: npc.title ?? undefined,
      gender: npc.gender ?? undefined,
      realm: npc.realm ?? undefined,
      avatar: npc.avatar ?? null,
      desc: npc.description ?? undefined,
      drops,
    };
  }

  if (type === 'monster') {
    const monster = (getMonsterDefinitions().find((entry) => entry.enabled !== false && entry.id === id) ?? null) as MonsterRow | null;
    if (!monster) return null;
    const drops = monster.drop_pool_id ? await getDropsByPoolId(monster.drop_pool_id) : [];
    const baseAttrs = asNumberRecord(monster.base_attrs);
    const stats = buildMonsterStats(baseAttrs, asStatList(monster.display_stats)) ?? [];
    const variance = asNumber(monster.attr_variance);
    const multMin = asNumber(monster.attr_multiplier_min);
    const multMax = asNumber(monster.attr_multiplier_max);

    if (typeof variance === 'number') stats.push({ label: '属性波动', value: `±${formatRatioPercent(variance)}` });
    if (typeof multMin === 'number' && typeof multMax === 'number') {
      stats.push({ label: '整体倍率', value: `${multMin.toFixed(2)} - ${multMax.toFixed(2)}` });
    }

    return {
      type: 'monster',
      id: monster.id,
      name: monster.name,
      title: monster.title ?? undefined,
      gender: '-',
      realm: monster.realm ?? undefined,
      avatar: monster.avatar ?? null,
      base_attrs: baseAttrs,
      attr_variance: variance,
      attr_multiplier_min: multMin,
      attr_multiplier_max: multMax,
      stats: stats.length > 0 ? stats : undefined,
      drops,
    };
  }

  if (type === 'item') {
    const itemRes = await query(
      `
        SELECT
          id, name, category, quality, level, icon, description, long_desc,
          equip_req_realm, use_req_realm, base_attrs
        FROM item_def
        WHERE enabled = true AND id = $1
        LIMIT 1
      `,
      [id]
    );
    const item = (itemRes.rows[0] ?? null) as ItemRow | null;
    if (!item) return null;

    const desc = item.long_desc || item.description || null;
    const realm = item.equip_req_realm || item.use_req_realm || (item.level !== null ? `等级${item.level}` : null);
    const baseStats = toStatsFromAttrs(item.base_attrs, '');
    const stats = baseStats;

    return {
      type: 'item',
      id: item.id,
      name: item.name,
      title: item.quality ?? undefined,
      gender: '-',
      realm: realm ?? undefined,
      avatar: item.icon ?? null,
      desc: desc ?? undefined,
      stats: stats.length > 0 ? stats : undefined,
    };
  }

  if (type === 'player') {
    const characterId = Math.floor(Number(id));
    if (!Number.isFinite(characterId) || characterId <= 0) return null;

    const charRes = await query(
      `
        SELECT id, nickname, title, gender, avatar, realm, sub_realm
        FROM characters
        WHERE id = $1
        LIMIT 1
      `,
      [characterId]
    );
    const c = (charRes.rows[0] ?? null) as CharacterRow | null;
    if (!c) return null;

    const [equipRes, techRes] = await Promise.all([
      query(
        `
          SELECT
            ii.equipped_slot,
            id.name AS item_name,
            COALESCE(NULLIF(ii.quality, ''), id.quality) AS resolved_quality
          FROM item_instance ii
          JOIN item_def id ON id.id = ii.item_def_id
          WHERE ii.owner_character_id = $1 AND ii.location = 'equipped'
          ORDER BY ii.equipped_slot ASC, ii.id ASC
        `,
        [characterId]
      ),
      query(
        `
          SELECT
            ct.technique_id,
            ct.current_layer
          FROM character_technique ct
          WHERE ct.character_id = $1 AND ct.slot_type IS NOT NULL
          ORDER BY ct.slot_type ASC, ct.slot_index ASC
        `,
        [characterId]
      ),
    ]);

    const equipRows = equipRes.rows as EquippedRow[];
    const equipment = equipRows
      .map((r, idx) => {
        const slotCode = typeof r.equipped_slot === 'string' ? r.equipped_slot.trim() : '';
        const slot = slotCode ? (EQUIPPED_SLOT_TO_UI_LABEL[slotCode] ?? slotCode) : `槽位${idx + 1}`;
        const name = typeof r.item_name === 'string' ? r.item_name.trim() : '';
        const quality = typeof r.resolved_quality === 'string' ? r.resolved_quality.trim() : '';
        if (!slot || !name) return null;
        return { slot, name, quality: quality || '-' };
      })
      .filter((x): x is { slot: string; name: string; quality: string } => Boolean(x));

    const techRows = techRes.rows as EquippedTechniqueRow[];
    const techniqueMap = new Map(
      getTechniqueDefinitions()
        .filter((entry) => entry.enabled !== false)
        .map((entry) => [entry.id, entry] as const),
    );
    const techniques = techRows
      .map((r) => {
        const techniqueId = typeof (r as Record<string, unknown>).technique_id === 'string' ? String((r as Record<string, unknown>).technique_id) : '';
        const def = techniqueMap.get(techniqueId) ?? null;
        const name = typeof def?.name === 'string' ? def.name.trim() : '';
        if (!name) return null;
        const typeText = typeof def?.type === 'string' ? def.type.trim() : '';
        const layer = Number(r.current_layer ?? 0) || 0;
        const level = layer > 0 ? `${layer}重` : '-';
        return { name, level, type: typeText || '功法' };
      })
      .filter((x): x is { name: string; level: string; type: string } => Boolean(x));

    const name = typeof c.nickname === 'string' && c.nickname.trim() ? c.nickname.trim() : `修士${c.id}`;
    const title = typeof c.title === 'string' && c.title.trim() ? c.title.trim() : '散修';

    return {
      type: 'player',
      id: String(c.id),
      name,
      title,
      gender: normalizeGender(c.gender) ?? '-',
      realm: buildFullRealm(c.realm, c.sub_realm),
      avatar: c.avatar ?? null,
      equipment,
      techniques,
    };
  }

  return null;
};
