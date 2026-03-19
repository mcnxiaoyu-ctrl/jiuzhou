/**
 * 正式称号定义双源读取服务
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把静态 `title_def.json` 与数据库里的动态称号定义合并成同一套读取口径，供称号列表、装备与属性结算复用。
 * 2. 做什么：为云游奇遇这类“运行时生成正式称号”的系统提供接入正式称号体系的唯一入口，避免各业务再各写一份查找逻辑。
 * 3. 不做什么：不负责称号归属发放，不负责装备切换，也不负责生成 AI 文案。
 *
 * 输入/输出：
 * - 输入：称号 ID 列表，或单个称号 ID。
 * - 输出：统一的称号定义对象映射，字段结构与现有正式称号消费口径保持一致。
 *
 * 数据流/状态流：
 * 业务服务传入 titleId -> 本模块先读静态称号定义 -> 再补查 DB 动态称号定义 -> 返回统一 definition map 给上层。
 *
 * 关键边界条件与坑点：
 * 1. 静态与动态称号可同名但不能同 ID；一旦静态命中，动态查询不会覆盖，避免运行时定义污染已有正式称号。
 * 2. 动态称号 effects 仍走现有称号属性键白名单校验；本模块只提供原始定义，不额外放宽字段范围。
 */
import { query } from '../config/database.js';
import { getTitleDefinitions, type TitleDefConfig } from './staticConfigLoader.js';

type GeneratedTitleDefRow = {
  id: string;
  name: string;
  description: string;
  color: string | null;
  icon: string | null;
  effects: Record<string, number> | null;
  source_type: string;
  source_id: string;
  enabled: boolean;
};

const normalizeTitleId = (titleId: string): string => titleId.trim();

const buildStaticTitleMap = (): Map<string, TitleDefConfig> => {
  return new Map(
    getTitleDefinitions()
      .filter((row) => row.enabled !== false)
      .map((row) => [row.id, row]),
  );
};

export const listTitleDefinitionsByIds = async (
  titleIds: readonly string[],
): Promise<Map<string, TitleDefConfig>> => {
  const staticTitleMap = buildStaticTitleMap();
  const result = new Map<string, TitleDefConfig>();
  const dynamicIds: string[] = [];

  for (const rawTitleId of titleIds) {
    const titleId = normalizeTitleId(rawTitleId);
    if (!titleId || result.has(titleId)) continue;
    const staticDef = staticTitleMap.get(titleId);
    if (staticDef) {
      result.set(titleId, staticDef);
      continue;
    }
    dynamicIds.push(titleId);
  }

  if (dynamicIds.length <= 0) {
    return result;
  }

  const queryResult = await query<GeneratedTitleDefRow>(
    `
      SELECT id, name, description, color, icon, effects, source_type, source_id, enabled
      FROM generated_title_def
      WHERE enabled = true
        AND id = ANY($1::varchar[])
    `,
    [dynamicIds],
  );

  for (const row of queryResult.rows) {
    result.set(row.id, {
      id: row.id,
      name: row.name,
      description: row.description,
      color: row.color ?? undefined,
      icon: row.icon ?? undefined,
      effects: row.effects ?? {},
      source_type: row.source_type,
      source_id: row.source_id,
      enabled: row.enabled,
      version: 1,
    });
  }

  return result;
};

export const getTitleDefinitionById = async (titleId: string): Promise<TitleDefConfig | null> => {
  const titleMap = await listTitleDefinitionsByIds([titleId]);
  return titleMap.get(normalizeTitleId(titleId)) ?? null;
};
