/**
 * 物品聚合查询模块
 *
 * 作用：提供带物品定义、套装聚合、装备属性计算、词条元数据注入的物品列表查询。
 *       纯只读查询，不修改数据库。
 *
 * 输入/输出：
 * - getInventoryItemsWithDefs(characterId, location, page, pageSize) — 单 location 聚合查询
 * - getBagInventorySnapshot(characterId) — 背包弹窗所需快照（容量 + 背包物品 + 已穿戴物品）
 * - getWarehouseInventorySnapshot(characterId) — 仓库弹窗所需快照（容量 + 背包物品 + 仓库物品）
 * - getEquippedItemDefIds(characterId) — 已装备物品定义 ID 列表
 *
 * 数据流：
 * 1. getInventoryItems → 物品实例列表
 * 2. getItemDefinitionsByIds → 批量加载物品静态定义
 * 3. getItemSetDefinitions → 套装定义（仅当有套装 ID 时）
 * 4. getEquippedItemDefIds → 已装备物品（仅当有套装 ID 时）
 * 5. buildEquipmentDisplayBaseAttrs → 装备基础属性折算
 * 6. enrichAffixesWithRollMeta → 词条 roll 百分比注入
 *
 * 被引用方：service.ts（InventoryService 对应方法）
 *
 * 边界条件：
 * 1. 空物品列表直接返回，不执行后续查询
 * 2. 缺少物品定义的物品，def 设为 undefined
 */
import { query } from "../../config/database.js";
import {
  getItemDefinitionById,
  getItemDefinitionsByIds,
  getItemSetDefinitions,
  type ItemDefConfig,
} from "../staticConfigLoader.js";
import {
  buildEquipmentDisplayBaseAttrs,
} from "../equipmentGrowthRules.js";
import {
  enrichAffixesWithRollMeta,
  getEquipRealmRankForReroll,
  getQualityMultiplierForReroll,
  loadAffixPoolForReroll,
  parseGeneratedAffixesForReroll,
} from "../equipmentAffixRerollService.js";
import { resolveQualityRankFromName } from "../shared/itemQuality.js";
import { resolveItemCanDisassemble } from "../shared/itemDisassembleRule.js";
import { resolveGeneratedTechniqueBookDisplay } from "../shared/generatedTechniqueBookView.js";
import { buildAffixPoolSlotCacheKey } from "../shared/affixPoolSlotResolver.js";
import type {
  InventoryInfo,
  InventoryItem,
  InventoryItemWithDef,
  InventoryLocation,
} from "./shared/types.js";
import { getInventoryInfo, getInventoryItems } from "./bag.js";
import { getEquippedSetPieceCountMap } from "./shared/equippedSetCount.js";
import {
  loadCharacterPendingItemInstanceMutations,
  loadProjectedCharacterItemInstances,
  loadProjectedCharacterItemInstancesByLocation,
  type BufferedCharacterItemInstanceMutation,
  type CharacterItemInstanceSnapshot,
} from "../shared/characterItemInstanceMutationService.js";

type InventoryItemDefContext = {
  staticDefMap: Map<string, Record<string, unknown>>;
  setBonusMap: Map<string, Array<{ piece_count: number; effect_defs: unknown }>>;
  equippedSetCountMap: Map<string, number>;
  setNameMap: Map<string, string>;
};

type BuildInventoryItemDefContextOptions = {
  equippedItems?: readonly InventoryItem[];
  pendingMutations?: readonly BufferedCharacterItemInstanceMutation[];
};

type GetInventoryItemsWithDefsOptions = {
  /**
   * 作用：
   * 1. 调用方已确认当前角色库存实体态与 `item_instance` 权威表一致时，允许跳过 pending mutation 读取，
   *    并把底层列表查询切到实体态分页快路径。
   * 2. 主要用于已经执行过 `prepareInventoryInteraction` 的 HTTP 热路径，减少 Redis 读取与 projected 全量构建。
   *
   * 不做什么：
   * - 不会替调用方执行 pending grants / pending mutations flush。
   * - 不适用于仍依赖 projected 视图读取未落库实例的场景。
   *
   * 关键边界条件与坑点：
   * 1. 若调用方误判为实体态，列表与套装件数都会丢失未 flush 的变更。
   * 2. 开启后 `pendingMutations` 必须固定为空数组，避免 `getEquippedSetPieceCountMap` 又回退去读取 Redis。
   */
  knownConcreteState?: boolean;
};

export type WarehouseInventorySnapshot = {
  info: InventoryInfo;
  bagItems: InventoryItemWithDef[];
  warehouseItems: InventoryItemWithDef[];
};

export type InventorySaleCandidateDto = {
  id: number;
  itemDefId: string;
  name: string;
  icon: string | null;
  quality: string | null;
  category: string;
  subCategory: string | null;
  qty: number;
  locked: boolean;
  bindType: string;
  strengthenLevel: number;
  refineLevel: number;
  location: InventoryLocation;
  equippedSlot: string | null;
  stackMax: number;
  canDisassemble: boolean;
  equipSlot: string | null;
  baseAttrs: Record<string, number>;
  baseAttrsRaw: Record<string, number> | null;
  identified: boolean;
};

/**
 * 背包上架候选轻量 DTO 构建器。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把背包实例与静态物品定义压缩成上架选择所需字段。
 * 2. 不做什么：不返回长描述、效果定义、套装效果、完整词条元数据等详情字段。
 *
 * 输入 / 输出：
 * - 输入：背包实例、静态定义，以及可选的生成功法书展示名。
 * - 输出：`InventorySaleCandidateDto`，供市场上架面板直接渲染候选项。
 *
 * 数据流 / 状态流：
 * getInventoryItems(bag) -> getItemDefinitionById 静态定义索引 -> 装备基础属性折算 -> 轻量 DTO。
 *
 * 复用设计说明：
 * - 将市场上架候选字段收敛在 inventory 查询层，避免前端继续复用富化列表并传输大字段。
 * - `getInventorySaleCandidates` 与路由、InventoryService 共享这一构建入口，后续候选字段变化只维护一处。
 *
 * 关键边界条件与坑点：
 * 1. 缺少静态定义的实例会被跳过，否则前端无法得到名称、分类、堆叠上限等上架必需字段。
 * 2. 装备基础属性必须按实例品质、强化、精炼和宝石折算；但词条只用于完整详情，不进入候选载荷。
 */
const buildInventorySaleCandidateDto = (
  item: InventoryItem,
  itemDef: ItemDefConfig,
): InventorySaleCandidateDto => {
  const generatedTechniqueBookDisplay = resolveGeneratedTechniqueBookDisplay(
    item.item_def_id,
    item.metadata,
  );
  const resolvedQuality = item.quality ?? generatedTechniqueBookDisplay?.quality ?? itemDef.quality ?? null;
  const defQualityRank = resolveQualityRankFromName(itemDef.quality, 1);
  const resolvedQualityRank = Math.max(
    1,
    Math.floor(Number(item.quality_rank) || defQualityRank),
  );
  const baseAttrsRaw = itemDef.base_attrs ?? null;
  const baseAttrs = itemDef.category === "equipment"
    ? buildEquipmentDisplayBaseAttrs({
        baseAttrsRaw,
        defQualityRankRaw: defQualityRank,
        resolvedQualityRankRaw: resolvedQualityRank,
        strengthenLevelRaw: item.strengthen_level,
        refineLevelRaw: item.refine_level,
        socketedGemsRaw: item.socketed_gems,
      })
    : itemDef.base_attrs ?? {};

  return {
    id: item.id,
    itemDefId: item.item_def_id,
    name: generatedTechniqueBookDisplay?.name ?? itemDef.name,
    icon: itemDef.icon ?? null,
    quality: resolvedQuality,
    category: itemDef.category,
    subCategory: itemDef.sub_category ?? null,
    qty: item.qty,
    locked: item.locked,
    bindType: item.bind_type,
    strengthenLevel: item.strengthen_level,
    refineLevel: item.refine_level,
    location: item.location,
    equippedSlot: item.equipped_slot,
    stackMax: Math.max(1, Math.floor(Number(itemDef.stack_max) || 1)),
    canDisassemble: resolveItemCanDisassemble(itemDef),
    equipSlot: itemDef.equip_slot ?? null,
    baseAttrs,
    baseAttrsRaw,
    identified: item.identified,
  };
};

/**
 * 单次 projected 全量读取结果按库存位置拆分。
 *
 * 作用：
 * 1. 让背包快照在一次 projected 读取后即可同时复用 bag / equipped / warehouse 三段结果。
 * 2. 把位置拆分逻辑集中到单一入口，避免多个调用点重复 filter 同一份快照。
 *
 * 不做什么：
 * - 不做排序、不做富化，也不改写实例字段；只负责轻量分桶。
 *
 * 关键边界条件与坑点：
 * 1. 仅识别当前 inventory 读路径会消费的三种 location，其他位置会被忽略。
 * 2. 返回数组保持输入顺序；展示顺序仍由 `getInventoryItems` 统一排序。
 */
const partitionProjectedInventoryItemsByLocation = (
  projectedItems: readonly CharacterItemInstanceSnapshot[],
): Record<InventoryLocation, CharacterItemInstanceSnapshot[]> => {
  const partitioned: Record<InventoryLocation, CharacterItemInstanceSnapshot[]> = {
    bag: [],
    warehouse: [],
    equipped: [],
  };
  for (const item of projectedItems) {
    if (item.location === "bag" || item.location === "warehouse" || item.location === "equipped") {
      partitioned[item.location].push(item);
    }
  }
  return partitioned;
};

/**
 * 查询角色已装备物品的 item_def_id 列表
 *
 * 作用：用于套装激活件数统计（判断当前查看的物品所在套装已装备多少件）。
 * 输入：characterId — 角色 ID
 * 输出：已装备物品的 item_def_id 字符串数组
 *
 * 边界条件：
 * - 若角色无装备，返回空数组
 * - item_def_id 为空/null 的行会被过滤
 */
export const getEquippedItemDefIds = async (
  characterId: number,
): Promise<string[]> => {
  return (await loadProjectedCharacterItemInstancesByLocation(characterId, "equipped"))
    .map((row) => String(row.item_def_id || "").trim())
    .filter((id) => id.length > 0);
};

/**
 * 构建物品定义聚合上下文
 *
 * 作用：
 * - 统一预加载物品定义、套装定义、已穿戴套装件数，避免不同查询入口重复拼装同一份上下文。
 * - 为 `getInventoryItemsWithDefs` 与 `getBagInventorySnapshot` 共享同一套富化依赖，减少重复逻辑。
 *
 * 输入/输出：
 * - 输入：角色 ID、待富化的原始物品列表。
 * - 输出：物品定义、套装效果、套装已穿戴件数等只读上下文。
 *
 * 数据流/状态流：
 * 原始物品列表 -> 收集 item_def_id / set_id -> 预加载静态定义与已穿戴套装件数 -> 返回上下文。
 *
 * 关键边界条件与坑点：
 * 1. 传入空列表时必须直接返回空上下文，避免做无意义的静态定义与数据库查询。
 * 2. 套装已穿戴件数统计依赖角色当前全部已穿戴装备，不能只看传入列表，否则套装件数会失真。
 */
const buildInventoryItemDefContext = async (
  characterId: number,
  sourceItems: InventoryItem[],
  options: BuildInventoryItemDefContextOptions = {},
): Promise<InventoryItemDefContext> => {
  if (sourceItems.length <= 0) {
    return {
      staticDefMap: new Map<string, Record<string, unknown>>(),
      setBonusMap: new Map<string, Array<{ piece_count: number; effect_defs: unknown }>>(),
      equippedSetCountMap: new Map<string, number>(),
      setNameMap: new Map<string, string>(),
    };
  }

  const itemDefIds = [
    ...new Set(
      sourceItems
        .map((item) => String(item.item_def_id || "").trim())
        .filter((id) => id.length > 0),
    ),
  ];
  const staticDefMap = getItemDefinitionsByIds(itemDefIds);

  // 2. 收集套装 ID
  const setIds = [
    ...new Set(
      Array.from(staticDefMap.values())
        .map((d: Record<string, unknown>) =>
          typeof d.set_id === "string" ? d.set_id.trim() : "",
        )
        .filter((x) => x.length > 0),
    ),
  ];

  const setBonusMap = new Map<
    string,
    Array<{ piece_count: number; effect_defs: unknown }>
  >();
  const equippedSetCountMap = new Map<string, number>();
  const setNameMap = new Map<string, string>();

  // 3. 加载套装定义 + 已装备件数统计
  if (setIds.length > 0) {
    const setIdSet = new Set(setIds);
    const staticSetMap = new Map(
      getItemSetDefinitions()
        .filter((entry: Record<string, unknown>) => entry.enabled !== false)
        .map(
          (entry: Record<string, unknown>) =>
            [entry.id, entry] as const,
        ),
    );
    for (const setId of setIds) {
      const setDef = staticSetMap.get(setId) as
        | Record<string, unknown>
        | undefined;
      if (!setDef) continue;
      setNameMap.set(setId, String(setDef.name || setId));
      const normalizedBonuses = (
        Array.isArray(setDef.bonuses) ? setDef.bonuses : []
      )
        .map(
          (bonus: {
            piece_count?: unknown;
            priority?: unknown;
            effect_defs?: unknown;
          }) => ({
            piece_count: Math.max(
              1,
              Math.floor(Number(bonus.piece_count) || 1),
            ),
            priority: Math.max(0, Math.floor(Number(bonus.priority) || 0)),
            effect_defs: Array.isArray(bonus.effect_defs)
              ? bonus.effect_defs
              : [],
          }),
        )
        .sort(
          (
            left: { priority: number; piece_count: number },
            right: { priority: number; piece_count: number },
          ) => left.priority - right.priority || left.piece_count - right.piece_count,
        )
        .map((bonus: { piece_count: number; effect_defs: unknown }) => ({
          piece_count: bonus.piece_count,
          effect_defs: bonus.effect_defs,
        }));
      setBonusMap.set(setId, normalizedBonuses);
    }

    const rawEquippedSetCountMap = await getEquippedSetPieceCountMap(characterId, options.equippedItems, {
      pendingMutations: options.pendingMutations,
    });
    for (const [setId, pieceCount] of rawEquippedSetCountMap.entries()) {
      if (!setIdSet.has(setId)) continue;
      equippedSetCountMap.set(setId, pieceCount);
    }
  }

  return {
    staticDefMap,
    setBonusMap,
    equippedSetCountMap,
    setNameMap,
  };
};

/**
 * 为物品实例列表注入定义、套装、装备成长显示属性与词条元数据
 *
 * 作用：
 * - 让单 location 查询与背包快照查询共用同一份富化流程，避免在多个入口重复写映射逻辑。
 * - 将高频变化的“物品展示规则”集中在一处，后续新增展示字段时只改这里。
 *
 * 输入/输出：
 * - 输入：原始物品列表、预构建的定义聚合上下文。
 * - 输出：可直接返回给前端的 `InventoryItemWithDef[]`。
 *
 * 数据流/状态流：
 * 原始实例列表 + 预加载上下文 -> 逐项富化定义/套装/属性/词条 -> 返回展示态物品列表。
 *
 * 关键边界条件与坑点：
 * 1. 缺少静态定义时仍需保留原物品实例，避免因为静态表遗漏把物品直接吞掉。
 * 2. 词条 roll 元数据依赖词条池缓存，必须在单次富化流程内共享缓存，避免同池装备重复加载。
 */
const enrichInventoryItemsWithDefs = (
  sourceItems: InventoryItem[],
  context: InventoryItemDefContext,
): InventoryItemWithDef[] => {
  const affixPoolCache = new Map<
    string,
    ReturnType<typeof loadAffixPoolForReroll>
  >();

  return sourceItems.map((item) => {
    const def = context.staticDefMap.get(item.item_def_id) as
      | Record<string, unknown>
      | undefined;
    if (!def) return { ...item, def: undefined };

    const generatedTechniqueBookDisplay = resolveGeneratedTechniqueBookDisplay(
      item.item_def_id,
      item.metadata,
    );
    const normalizedDef = generatedTechniqueBookDisplay
      ? {
          ...def,
          name: generatedTechniqueBookDisplay.name,
          quality: generatedTechniqueBookDisplay.quality ?? def.quality,
          description: generatedTechniqueBookDisplay.description,
          long_desc: generatedTechniqueBookDisplay.longDesc,
          tags: generatedTechniqueBookDisplay.tags,
          generated_technique_id: generatedTechniqueBookDisplay.generatedTechniqueId,
          generated_technique_name: generatedTechniqueBookDisplay.generatedTechniqueName,
        }
      : def;

    const setId =
      typeof normalizedDef.set_id === "string"
        ? (normalizedDef.set_id as string).trim()
        : "";
    const setBonuses = setId ? (context.setBonusMap.get(setId) || []) : [];
    const setEquippedCount = setId
      ? (context.equippedSetCountMap.get(setId) || 0)
      : 0;
    const baseDef = {
      ...normalizedDef,
      can_disassemble: resolveItemCanDisassemble(normalizedDef),
      set_id: setId || null,
      set_name: setId ? (context.setNameMap.get(setId) ?? null) : null,
      set_bonuses: setBonuses,
      set_equipped_count: setEquippedCount,
    };

    if (normalizedDef.category !== "equipment") return { ...item, def: baseDef };

    const defQualityRank = resolveQualityRankFromName(
      normalizedDef.quality as string | undefined,
      1,
    );
    const resolvedQualityRank = Math.max(
      1,
      Math.floor(Number(item.quality_rank) || defQualityRank),
    );

    const displayBaseAttrs = buildEquipmentDisplayBaseAttrs({
      baseAttrsRaw: normalizedDef.base_attrs,
      defQualityRankRaw: defQualityRank,
      resolvedQualityRankRaw: resolvedQualityRank,
      strengthenLevelRaw: item.strengthen_level,
      refineLevelRaw: item.refine_level,
      socketedGemsRaw: item.socketed_gems,
    });

    let normalizedAffixes = parseGeneratedAffixesForReroll(item.affixes);
    const affixPoolId =
      typeof normalizedDef.affix_pool_id === "string"
        ? (normalizedDef.affix_pool_id as string).trim()
        : "";
    const equipSlot =
      typeof normalizedDef.equip_slot === "string"
        ? (normalizedDef.equip_slot as string).trim()
        : "";
    if (normalizedAffixes.length > 0 && affixPoolId && equipSlot) {
      const affixPoolCacheKey = buildAffixPoolSlotCacheKey(affixPoolId, equipSlot);
      if (!affixPoolCache.has(affixPoolCacheKey)) {
        affixPoolCache.set(affixPoolCacheKey, loadAffixPoolForReroll(affixPoolId, equipSlot));
      }
      const affixPool = affixPoolCache.get(affixPoolCacheKey);
      if (affixPool) {
        const realmRank = getEquipRealmRankForReroll(
          normalizedDef.equip_req_realm as string | undefined,
        );
        const resolvedQualityMultiplier =
          getQualityMultiplierForReroll(resolvedQualityRank);
        const defQualityMultiplier =
          getQualityMultiplierForReroll(defQualityRank);
        const attrFactor =
          Number.isFinite(defQualityMultiplier) && defQualityMultiplier > 0
            ? resolvedQualityMultiplier / defQualityMultiplier
            : 1;
        normalizedAffixes = enrichAffixesWithRollMeta({
          affixes: normalizedAffixes,
          affixDefs: affixPool.affixes,
          realmRank,
          attrFactor,
        });
      }
    }

    const mergedDef = {
      ...baseDef,
      base_attrs_raw: normalizedDef.base_attrs,
      base_attrs: displayBaseAttrs,
    };

    return {
      ...item,
      affixes:
        normalizedAffixes.length > 0 ? normalizedAffixes : item.affixes,
      def: mergedDef,
    };
  });
};

/**
 * 带物品定义、套装聚合、装备属性计算、词条元数据注入的物品列表查询
 */
export const getInventoryItemsWithDefs = async (
  characterId: number,
  location: InventoryLocation,
  page: number,
  pageSize: number,
  options: GetInventoryItemsWithDefsOptions = {},
): Promise<{ items: InventoryItemWithDef[]; total: number }> => {
  const pendingMutations = options.knownConcreteState
    ? []
    : await loadCharacterPendingItemInstanceMutations(characterId);
  const result = await getInventoryItems(characterId, location, page, pageSize, {
    pendingMutations,
    knownConcreteState: options.knownConcreteState,
  });

  if (result.items.length === 0) {
    return { items: [], total: 0 };
  }

  const context = await buildInventoryItemDefContext(characterId, result.items, {
    equippedItems: location === 'equipped' ? result.items : undefined,
    pendingMutations,
  });
  const items = enrichInventoryItemsWithDefs(result.items, context);

  return { items, total: result.total };
};

/**
 * 查询背包上架候选轻量列表。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：只读取背包前 200 个实例，并按静态定义补齐市场上架选择所需的轻量展示字段。
 * 2. 不做什么：不调用 `getInventoryItemsWithDefs`，不加载套装、效果、长描述与词条池元数据。
 *
 * 输入 / 输出：
 * - 输入：角色 ID。
 * - 输出：可上架候选 DTO 数组。
 *
 * 数据流 / 状态流：
 * characterId -> getInventoryItems(characterId, "bag", 1, 200) -> getItemDefinitionById 去重读取静态定义 -> DTO。
 *
 * 复用设计说明：
 * - 让市场上架面板复用独立轻量入口，避免和背包详情弹窗共享富化接口导致载荷膨胀。
 * - 定义读取使用本函数内 `Map` 去重，重复堆叠或同名实例不会重复查静态定义。
 *
 * 关键边界条件与坑点：
 * 1. 只返回当前背包页上限内实例，与旧市场上架读取 `pageSize=200` 的可见范围保持一致。
 * 2. 静态定义缺失时跳过该实例，避免下发无法渲染或无法上架的半成品候选。
 */
export const getInventorySaleCandidates = async (
  characterId: number,
): Promise<InventorySaleCandidateDto[]> => {
  const result = await getInventoryItems(characterId, "bag", 1, 200);
  if (result.items.length <= 0) return [];

  const itemDefCache = new Map<string, ItemDefConfig | null>();
  const candidates: InventorySaleCandidateDto[] = [];
  for (const item of result.items) {
    const itemDefId = String(item.item_def_id || "").trim();
    if (!itemDefId) continue;
    if (!itemDefCache.has(itemDefId)) {
      itemDefCache.set(itemDefId, getItemDefinitionById(itemDefId));
    }
    const itemDef = itemDefCache.get(itemDefId) ?? null;
    if (!itemDef) continue;
    candidates.push(buildInventorySaleCandidateDto(item, itemDef));
  }

  return candidates;
};

/**
 * 背包弹窗快照查询
 *
 * 作用：
 * - 一次性返回背包弹窗首屏所需的容量信息、背包物品与已穿戴物品，收敛前端打开弹窗时的多次请求。
 * - 保持纯 projected 读语义：实例列表直接复用 pending mutation 投影视图，容量信息单独叠加 pending grant 占用，避免只读接口被同步 flush 阻塞。
 * - 共享同一套物品定义聚合上下文，避免背包物品与已穿戴物品分别富化造成重复计算。
 *
 * 输入/输出：
 * - 输入：角色 ID。
 * - 输出：`info`、`bagItems`、`equippedItems` 三段只读快照数据。
 *
 * 数据流/状态流：
 * pending item instance mutations -> projected item instances -> getInventoryInfo pending grant overlay + getInventoryItems(bag/equipped) -> 共享上下文富化 -> 返回弹窗快照。
 *
 * 关键边界条件与坑点：
 * 1. 背包和已穿戴需要共用一份上下文，否则套装件数、静态定义加载会被重复计算。
 * 2. 空背包也必须返回容量信息，不能因为物品为空就跳过 `info`。
 * 3. 待 flush 的普通奖励只参与容量占用，不进入可点击物品列表，否则前端会拿到不存在的实例 ID。
 */
export const getBagInventorySnapshot = async (
  characterId: number,
): Promise<{
  info: InventoryInfo;
  bagItems: InventoryItemWithDef[];
  equippedItems: InventoryItemWithDef[];
}> => {
  const pendingMutations = await loadCharacterPendingItemInstanceMutations(characterId);
  const projectedItems = await loadProjectedCharacterItemInstances(characterId, {
    pendingMutations,
  });
  const {
    bag: bagProjectedItems,
    equipped: equippedProjectedItems,
    warehouse: warehouseProjectedItems,
  } = partitionProjectedInventoryItemsByLocation(projectedItems);

  const [info, bagResult, equippedResult] = await Promise.all([
    getInventoryInfo(characterId, {
      bagProjectedItems,
      warehouseProjectedItems,
    }),
    getInventoryItems(characterId, "bag", 1, 200, {
      projectedItems: bagProjectedItems,
      pendingMutations,
    }),
    getInventoryItems(characterId, "equipped", 1, 200, {
      projectedItems: equippedProjectedItems,
      pendingMutations,
    }),
  ]);

  const sourceItems = [...bagResult.items, ...equippedResult.items];
  if (sourceItems.length <= 0) {
    return {
      info,
      bagItems: [],
      equippedItems: [],
    };
  }

  const context = await buildInventoryItemDefContext(characterId, sourceItems, {
    equippedItems: equippedResult.items,
    pendingMutations,
  });

  return {
    info,
    bagItems: enrichInventoryItemsWithDefs(bagResult.items, context),
    equippedItems: enrichInventoryItemsWithDefs(equippedResult.items, context),
  };
};

/**
 * 仓库弹窗快照查询
 *
 * 作用：
 * - 一次性返回仓库弹窗所需的容量信息、背包物品与仓库物品，收敛前端打开仓库时的多次请求。
 * - 保持纯 projected 读语义：列表只展示真实 projected 实例，容量通过 `getInventoryInfo` 叠加 pending grant 占用。
 * - 不做写入、不触发 pending grant flush，也不返回待 flush 奖励生成的临时实例 ID。
 *
 * 输入/输出：
 * - 输入：角色 ID。
 * - 输出：`info`、`bagItems`、`warehouseItems` 三段只读快照数据。
 *
 * 数据流/状态流：
 * pending item instance mutations -> 单次 projected item instances -> bag/equipped/warehouse 分桶
 * -> 容量信息 -> 背包、已装备与仓库分页并发读取 -> 单次上下文构建 -> 单次富化后按 ID 索引拆回两侧。
 *
 * 复用设计说明：
 * - 复用 `partitionProjectedInventoryItemsByLocation`，避免 bag/equipped/warehouse 各自读取并过滤同一批快照。
 * - 复用 `buildInventoryItemDefContext` 与 `enrichInventoryItemsWithDefs`，把仓库弹窗和背包弹窗的展示富化规则收敛到同一入口。
 * - `sourceItems` 合并后只富化一次，使词条池缓存和静态定义上下文在背包、仓库两侧共享。
 *
 * 关键边界条件与坑点：
 * 1. 空仓库或空背包仍必须返回容量信息，不能因为物品为空跳过 `info`。
 * 2. 待 flush 普通奖励只参与容量 overlay，不进入可点击物品列表，避免前端拿到不存在的实例 ID。
 */
export const getWarehouseInventorySnapshot = async (
  characterId: number,
): Promise<WarehouseInventorySnapshot> => {
  const pendingMutations = await loadCharacterPendingItemInstanceMutations(characterId);
  const projectedItems = await loadProjectedCharacterItemInstances(characterId, {
    pendingMutations,
  });
  const {
    bag: bagProjectedItems,
    equipped: equippedProjectedItems,
    warehouse: warehouseProjectedItems,
  } = partitionProjectedInventoryItemsByLocation(projectedItems);

  const info = await getInventoryInfo(characterId, {
    bagProjectedItems,
    warehouseProjectedItems,
  });
  const warehousePageSize = Math.max(warehouseProjectedItems.length, info.warehouse_capacity);
  const [bagResult, warehouseResult, equippedResult] = await Promise.all([
    getInventoryItems(characterId, "bag", 1, 200, {
      projectedItems: bagProjectedItems,
      pendingMutations,
    }),
    getInventoryItems(characterId, "warehouse", 1, warehousePageSize, {
      projectedItems: warehouseProjectedItems,
      pendingMutations,
    }),
    getInventoryItems(characterId, "equipped", 1, 200, {
      projectedItems: equippedProjectedItems,
      pendingMutations,
    }),
  ]);

  const sourceItems = [...bagResult.items, ...warehouseResult.items];
  if (sourceItems.length <= 0) {
    return {
      info,
      bagItems: [],
      warehouseItems: [],
    };
  }

  const context = await buildInventoryItemDefContext(characterId, sourceItems, {
    equippedItems: equippedResult.items,
    pendingMutations,
  });
  const enrichedItems = enrichInventoryItemsWithDefs(sourceItems, context);
  const bagItemIdSet = new Set(bagResult.items.map((item) => item.id));
  const bagItems: InventoryItemWithDef[] = [];
  const warehouseItems: InventoryItemWithDef[] = [];

  for (const item of enrichedItems) {
    if (bagItemIdSet.has(item.id)) {
      bagItems.push(item);
      continue;
    }
    warehouseItems.push(item);
  }

  return {
    info,
    bagItems,
    warehouseItems,
  };
};
