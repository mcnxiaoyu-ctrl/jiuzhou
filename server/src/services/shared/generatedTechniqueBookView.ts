/**
 * 生成功法书展示信息解析
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：把 `book-generated-technique` 的实例 metadata 解析成可展示的真实功法信息。
 * 2) 不做什么：不做权限校验、不做道具发放或学习，仅提供展示层字段拼装。
 *
 * 输入/输出：
 * - 输入：itemDefId + itemInstance.metadata。
 * - 输出：命中时返回展示覆盖字段（名称/图标/品质/描述/标签/关联功法ID）；否则返回 null。
 *
 * 数据流/状态流：
 * metadata.generatedTechniqueId -> 生成功法缓存/功法定义 -> 组装展示 DTO 覆盖字段。
 *
 * 关键边界条件与坑点：
 * 1) metadata 可能为空或非对象，必须严格判空，避免把异常结构写进展示层。
 * 2) 功法可能被禁用或缓存暂未刷新，优先使用实时可见定义，缺失时再退化到 metadata 名称。
 */
import { getGeneratedTechniqueDefinitionById } from '../generatedTechniqueConfigStore.js';
import { getTechniqueDefinitions } from '../staticConfigLoader.js';
import { isCharacterVisibleTechniqueDefinition } from './techniqueUsageScope.js';

const GENERATED_TECHNIQUE_BOOK_ITEM_DEF_ID = 'book-generated-technique';

const asString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const asStringList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry): entry is string => entry.length > 0);
};

export type GeneratedTechniqueBookDisplay = {
  generatedTechniqueId: string;
  generatedTechniqueName: string;
  name: string;
  icon: string | null;
  quality: string | null;
  description: string;
  longDesc: string;
  tags: string[];
};

export const resolveGeneratedTechniqueBookDisplay = (
  itemDefId: string,
  metadataRaw: unknown,
): GeneratedTechniqueBookDisplay | null => {
  if (itemDefId !== GENERATED_TECHNIQUE_BOOK_ITEM_DEF_ID) return null;
  if (!metadataRaw || typeof metadataRaw !== 'object' || Array.isArray(metadataRaw)) return null;

  const metadata = metadataRaw as Record<string, unknown>;
  const generatedTechniqueId = asString(metadata.generatedTechniqueId);
  if (!generatedTechniqueId) return null;

  const generatedTechniqueDef = getGeneratedTechniqueDefinitionById(generatedTechniqueId);
  const fallbackTechniqueDef =
    generatedTechniqueDef ??
    getTechniqueDefinitions().find((entry) => (
      entry.id === generatedTechniqueId &&
      entry.enabled !== false &&
      isCharacterVisibleTechniqueDefinition(entry)
    )) ??
    null;
  const generatedTechniqueName =
    asString(fallbackTechniqueDef?.name) || asString(metadata.generatedTechniqueName);
  if (!generatedTechniqueName) return null;

  const icon = asString(metadata.generatedBookCoverIcon) || null;
  const quality = asString(fallbackTechniqueDef?.quality) || null;
  const description =
    asString(fallbackTechniqueDef?.description) ||
    `记载功法「${generatedTechniqueName}」的生成功法书，使用后学习该功法。`;
  const longDesc =
    asString(fallbackTechniqueDef?.long_desc) ||
    `该秘卷为洞府研修推演所得，关联功法：${generatedTechniqueName}。`;
  const tags = ['研修生成', ...asStringList(fallbackTechniqueDef?.tags)];

  return {
    generatedTechniqueId,
    generatedTechniqueName,
    name: `《${generatedTechniqueName}》秘卷`,
    icon,
    quality,
    description,
    longDesc,
    tags: [...new Set(tags)],
  };
};
