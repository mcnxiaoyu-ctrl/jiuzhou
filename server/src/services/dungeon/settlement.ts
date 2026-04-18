/**
 * 秘境真实结算服务
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一处理秘境开战后的真实体力扣减、实例落库，以及秘境通关后的真实奖励发放与 `dungeon_record` 落库。
 * 2. 做什么：同时给同步秘境链路与历史延迟结算 runner 复用，避免两条链路各自维护一套背包锁、邮件补发、体力持久化逻辑。
 * 3. 不做什么：不创建或推进在线战斗投影，不决定 battle runtime 的激活时机，也不负责延迟任务状态迁移。
 *
 * 输入 / 输出：
 * - `settleDungeonStartConsumptionInDb`：输入稳定的结算标识与秘境开战消耗快照；输出无，副作用是写入 `dungeon_instance`、进入次数与体力。
 * - `settleDungeonClearInDb`：输入参与者、领奖者与通关摘要；输出结算结果，副作用是写入背包/邮件、角色资源 Delta 与 `dungeon_record`。
 *
 * 数据流 / 状态流：
 * - 秘境同步链路或延迟任务 -> 调用本模块
 * - 开战结算：先在事务内写 `dungeon_instance` 与次数、体力 -> 调用方再更新投影
 * - 通关结算：先在事务内锁实例、锁背包目标 -> 发奖/补发邮件/写记录 -> 事务提交后资源 Delta 进入统一聚合器
 *
 * 复用设计说明：
 * 1. 高频变化点是秘境结算规则本身，而不是“同步调用还是异步调用”，因此把真实落库集中到这里，能同时消除 `combat.ts` 与 runner 的重复实现。
 * 2. 背包互斥锁、自动分解、邮件补发、体力持久化都属于秘境真实结算的单一职责边界，收口后后续规则调整只需要改这一处。
 *
 * 关键边界条件与坑点：
 * 1. 开战结算必须在 battle runtime 激活前完成；否则会出现战斗已运行但体力/实例尚未落库的不一致。
 * 2. 通关发奖必须与 `dungeon_record` 共用同一事务；不能出现物品已进包但记录没写，或记录已写但物品没发的裂缝。
 */

import { query, withTransaction } from '../../config/database.js';
import { getGameServer } from '../../game/gameServer.js';
import {
  grantRewardItemWithAutoDisassemble,
  type AutoDisassembleSetting,
} from '../autoDisassembleRewardService.js';
import { itemService } from '../itemService.js';
import { sendSystemMail, type MailAttachItem } from '../mailService.js';
import {
  addCharacterRewardDelta,
  applyCharacterRewardDeltas,
  type CharacterRewardDelta,
} from '../shared/characterRewardSettlement.js';
import { normalizeAutoDisassembleSetting } from '../autoDisassembleRules.js';
import {
  createInventorySlotSession,
  type InventorySlotSession,
} from '../shared/inventorySlotSession.js';
import { createCharacterBagSlotAllocatorFromSession } from '../shared/characterBagSlotAllocator.js';
import { createCharacterInventoryMutationContextFromSession } from '../shared/characterInventoryMutationContext.js';
import { lockCharacterRewardInventoryTargets } from '../shared/characterRewardTargetLock.js';
import { resolveQualityRankFromName } from '../shared/itemQuality.js';
import type { CreateItemOptions } from '../itemService.js';
import { recordDungeonClearEvent } from '../taskService.js';
import { applyStaminaDeltaByCharacterId } from '../staminaService.js';
import {
  getItemDefinitionById,
  getDungeonDifficultyById,
} from '../staticConfigLoader.js';
import { resolveDungeonRewardMultiplier } from './shared/difficulty.js';
import { rollDungeonRewardBundle, mergeDungeonRewardBundle } from './shared/rewards.js';
import { asNumber } from './shared/typeUtils.js';
import type { DungeonRewardBundle } from './types.js';
import type { DeferredSettlementTask } from '../onlineBattleProjectionService.js';
import { createScopedLogger } from '../../utils/logger.js';

const dungeonSettlementLogger = createScopedLogger('dungeon.settlement');

const DUNGEON_REWARD_PENDING_MAIL_CHUNK_SIZE = 10;

type DungeonStartConsumptionPayload = NonNullable<
  DeferredSettlementTask['payload']['dungeonStartConsumption']
>;
type DungeonClearPayload = NonNullable<
  DeferredSettlementTask['payload']['dungeonSettlement']
>;
type DungeonSettlementParticipant = DeferredSettlementTask['payload']['rewardParticipants'][number];
type DungeonClearSettlementResult = 'settled' | 'discarded_missing_instance';

type DungeonRewardGrantContext = {
  slotSession: InventorySlotSession;
  bagSlotAllocator: ReturnType<typeof createCharacterBagSlotAllocatorFromSession>;
  inventoryMutationContext: ReturnType<typeof createCharacterInventoryMutationContextFromSession>;
};

type PendingDungeonRewardMailEntry = {
  userId: number;
  items: MailAttachItem[];
};

const collectUniqueParticipantCharacterIds = (
  participants: DeferredSettlementTask['payload']['participants'],
): number[] => {
  return [...new Set(
    participants
      .map((participant) => Math.floor(Number(participant.characterId)))
      .filter((characterId) => Number.isFinite(characterId) && characterId > 0),
  )].sort((left, right) => left - right);
};

const upsertDungeonEntryCountSnapshots = async (
  entryCountSnapshots: DungeonStartConsumptionPayload['entryCountSnapshots'],
): Promise<void> => {
  if (entryCountSnapshots.length <= 0) {
    return;
  }

  await query(
    `
      INSERT INTO dungeon_entry_count (
        character_id,
        dungeon_id,
        daily_count,
        weekly_count,
        total_count,
        last_daily_reset,
        last_weekly_reset
      )
      SELECT
        row.character_id,
        row.dungeon_id,
        row.daily_count,
        row.weekly_count,
        row.total_count,
        row.last_daily_reset,
        row.last_weekly_reset
      FROM jsonb_to_recordset($1::jsonb) AS row(
        character_id int,
        dungeon_id text,
        daily_count int,
        weekly_count int,
        total_count int,
        last_daily_reset date,
        last_weekly_reset date
      )
      ON CONFLICT (character_id, dungeon_id)
      DO UPDATE
      SET
        daily_count = EXCLUDED.daily_count,
        weekly_count = EXCLUDED.weekly_count,
        total_count = EXCLUDED.total_count,
        last_daily_reset = EXCLUDED.last_daily_reset,
        last_weekly_reset = EXCLUDED.last_weekly_reset
    `,
    [JSON.stringify(entryCountSnapshots.map((snapshot) => ({
      character_id: snapshot.characterId,
      dungeon_id: snapshot.dungeonId,
      daily_count: snapshot.dailyCount,
      weekly_count: snapshot.weeklyCount,
      total_count: snapshot.totalCount,
      last_daily_reset: snapshot.lastDailyReset,
      last_weekly_reset: snapshot.lastWeeklyReset,
    })))],
  );
};

const getDungeonRewardGrantContext = async (
  characterId: number,
  contextByCharacterId: Map<number, DungeonRewardGrantContext>,
): Promise<DungeonRewardGrantContext> => {
  const existing = contextByCharacterId.get(characterId);
  if (existing) {
    return existing;
  }

  const slotSession = await createInventorySlotSession([characterId]);
  const context: DungeonRewardGrantContext = {
    slotSession,
    bagSlotAllocator: createCharacterBagSlotAllocatorFromSession(slotSession, [characterId]),
    inventoryMutationContext: createCharacterInventoryMutationContextFromSession(slotSession),
  };
  contextByCharacterId.set(characterId, context);
  return context;
};

const pushPendingDungeonRewardMailItem = (
  bucket: MailAttachItem[],
  mailItem: MailAttachItem,
): void => {
  const buildMergeKey = (entry: MailAttachItem): string => JSON.stringify({
    itemDefId: String(entry.item_def_id || '').trim(),
    bindType: String(entry.options?.bindType || '').trim(),
    metadata: entry.options?.metadata ?? null,
    quality: entry.options?.quality ?? null,
    qualityRank: entry.options?.qualityRank ?? null,
    equipOptions: entry.options?.equipOptions ?? null,
  });

  const mergeKey = buildMergeKey(mailItem);
  const existing = bucket.find((entry) => buildMergeKey(entry) === mergeKey);
  if (existing) {
    existing.qty += mailItem.qty;
    return;
  }

  bucket.push({
    item_def_id: mailItem.item_def_id,
    qty: mailItem.qty,
    ...(mailItem.options ? { options: { ...mailItem.options } } : {}),
  });
};

const normalizeDungeonRewardPendingMailItem = (mailItem: {
  item_def_id: string;
  qty: number;
  options?: {
    bindType?: string;
    equipOptions?: unknown;
  };
}): MailAttachItem => {
  const options = mailItem.options
    ? {
        ...(mailItem.options.bindType ? { bindType: mailItem.options.bindType } : {}),
        ...(mailItem.options.equipOptions !== undefined
          ? { equipOptions: mailItem.options.equipOptions as CreateItemOptions['equipOptions'] }
          : {}),
      }
    : undefined;

  return {
    item_def_id: mailItem.item_def_id,
    qty: mailItem.qty,
    ...(options ? { options } : {}),
  };
};

export const settleDungeonStartConsumptionInDb = async (params: {
  settlementKey: string;
  payload: DungeonStartConsumptionPayload;
}): Promise<void> => {
  const dungeonStartConsumption = params.payload;
  const safeStartTimeMs = new Date(dungeonStartConsumption.startTime).getTime();
  const safeStartTime = Number.isFinite(safeStartTimeMs)
    ? new Date(safeStartTimeMs).toISOString()
    : new Date().toISOString();
  const normalizedTeamId = typeof dungeonStartConsumption.teamId === 'string'
    && dungeonStartConsumption.teamId.trim().length > 0
    ? dungeonStartConsumption.teamId.trim()
    : null;
  const participantsJson = JSON.stringify(dungeonStartConsumption.participants);
  const rewardEligibleCharacterIdsJson = JSON.stringify(dungeonStartConsumption.rewardEligibleCharacterIds);

  await withTransaction(async () => {
    await query(
      `
        INSERT INTO dungeon_instance (
          id,
          dungeon_id,
          difficulty_id,
          creator_id,
          team_id,
          status,
          current_stage,
          current_wave,
          participants,
          start_time,
          end_time,
          time_spent_sec,
          total_damage,
          death_count,
          rewards_claimed,
          instance_data
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          (SELECT t.id FROM teams t WHERE t.id = $5),
          'preparing',
          1,
          1,
          $6::jsonb,
          NULL,
          NULL,
          0,
          0,
          0,
          FALSE,
          '{}'::jsonb
        )
        ON CONFLICT (id) DO NOTHING
      `,
      [
        dungeonStartConsumption.instanceId,
        dungeonStartConsumption.dungeonId,
        dungeonStartConsumption.difficultyId,
        dungeonStartConsumption.creatorCharacterId,
        normalizedTeamId,
        participantsJson,
      ],
    );

    const markResult = await query(
      `
        UPDATE dungeon_instance
        SET
          status = 'running',
          current_stage = $2,
          current_wave = $3,
          participants = $4::jsonb,
          start_time = COALESCE(start_time, $5::timestamptz),
          end_time = NULL,
          instance_data = jsonb_set(
            jsonb_set(
              jsonb_set(COALESCE(instance_data, '{}'::jsonb), '{currentBattleId}', to_jsonb($6::text), true),
              '{rewardEligibleCharacterIds}',
              $7::jsonb,
              true
            ),
            '{startResourceTaskId}',
            to_jsonb($8::text),
            true
          )
        WHERE id = $1
          AND COALESCE(instance_data->>'startResourceTaskId', '') = ''
        RETURNING id
      `,
      [
        dungeonStartConsumption.instanceId,
        dungeonStartConsumption.currentStage,
        dungeonStartConsumption.currentWave,
        participantsJson,
        safeStartTime,
        dungeonStartConsumption.currentBattleId,
        rewardEligibleCharacterIdsJson,
        params.settlementKey,
      ],
    );

    if (markResult.rows.length <= 0) {
      return;
    }

    await upsertDungeonEntryCountSnapshots(dungeonStartConsumption.entryCountSnapshots);

    for (const staminaConsumption of dungeonStartConsumption.staminaConsumptions) {
      const safeAmount = Math.max(0, Math.floor(Number(staminaConsumption.amount) || 0));
      if (safeAmount <= 0) continue;
      const staminaState = await applyStaminaDeltaByCharacterId(
        staminaConsumption.characterId,
        -safeAmount,
      );
      if (!staminaState) {
        throw new Error(`秘境开战体力落库失败: characterId=${staminaConsumption.characterId}`);
      }
    }
  });
};

const settleDungeonClearInDbInTransaction = async (params: {
  participants: DeferredSettlementTask['payload']['participants'];
  rewardParticipants: DeferredSettlementTask['payload']['rewardParticipants'];
  dungeonSettlement: DungeonClearPayload;
}): Promise<DungeonClearSettlementResult> => {
  const { participants, rewardParticipants, dungeonSettlement } = params;
  const difficultyDef = getDungeonDifficultyById(dungeonSettlement.difficultyId);
  const firstClearRewardConfig = difficultyDef?.first_clear_rewards ?? {};
  const rewardMultiplier = resolveDungeonRewardMultiplier(difficultyDef?.reward_mult);
  const participantCharacterIds = collectUniqueParticipantCharacterIds(rewardParticipants);
  const teamClearParticipantCount = collectUniqueParticipantCharacterIds(participants).length;

  const clearCountMap = new Map<number, number>();
  const autoDisassembleSettings = new Map<number, AutoDisassembleSetting>();
  const pendingCharacterRewardDeltas = new Map<number, CharacterRewardDelta>();
  const grantContextByCharacterId = new Map<number, DungeonRewardGrantContext>();
  const pendingMailByReceiver = new Map<number, PendingDungeonRewardMailEntry>();
  const itemMetaCache = new Map<
    string,
    {
      name: string;
      category: string;
      subCategory: string | null;
      effectDefs: unknown;
      qualityRank: number;
      disassemblable: boolean | null;
    }
  >();

  const instanceLockResult = await query(
    `
      SELECT id
      FROM dungeon_instance
      WHERE id = $1
      FOR UPDATE
    `,
    [dungeonSettlement.instanceId],
  );
  if (instanceLockResult.rows.length <= 0) {
    return 'discarded_missing_instance';
  }

  if (participantCharacterIds.length > 0) {
    await lockCharacterRewardInventoryTargets(participantCharacterIds);

    const clearCountRes = await query(
      `
        SELECT character_id, COUNT(1)::int AS cnt
        FROM dungeon_record
        WHERE character_id = ANY($1)
          AND dungeon_id = $2
          AND difficulty_id = $3
          AND result = 'cleared'
        GROUP BY character_id
      `,
      [participantCharacterIds, dungeonSettlement.dungeonId, dungeonSettlement.difficultyId],
    );
    for (const row of clearCountRes.rows as Array<{ character_id: unknown; cnt: unknown }>) {
      clearCountMap.set(asNumber(row.character_id, 0), asNumber(row.cnt, 0));
    }

    const settingRes = await query(
      `
        SELECT id, auto_disassemble_enabled, auto_disassemble_rules
        FROM characters
        WHERE id = ANY($1)
      `,
      [participantCharacterIds],
    );
    for (const row of settingRes.rows as Array<{
      id: unknown;
      auto_disassemble_enabled: boolean | null;
      auto_disassemble_rules: unknown;
    }>) {
      const characterId = asNumber(row.id, 0);
      if (!Number.isFinite(characterId) || characterId <= 0) continue;
      autoDisassembleSettings.set(
        characterId,
        normalizeAutoDisassembleSetting({
          enabled: row.auto_disassemble_enabled,
          rules: row.auto_disassemble_rules,
        }),
      );
    }
  }

  const appendGrantedItem = (
    list: Array<{ item_def_id: string; qty: number; item_ids: number[] }>,
    itemDefId: string,
    qty: number,
    itemIds: number[],
  ): void => {
    const normalizedQty = Math.max(0, Math.floor(qty));
    if (normalizedQty <= 0) return;
    const safeItemIds = itemIds.filter((itemId) => Number.isInteger(itemId) && itemId > 0);
    const existing = list.find((entry) => entry.item_def_id === itemDefId);
    if (existing) {
      existing.qty += normalizedQty;
      if (safeItemIds.length > 0) existing.item_ids.push(...safeItemIds);
      return;
    }
    list.push({
      item_def_id: itemDefId,
      qty: normalizedQty,
      item_ids: safeItemIds,
    });
  };

  const getItemMeta = async (itemDefId: string): Promise<{
    name: string;
    category: string;
    subCategory: string | null;
    effectDefs: unknown;
    qualityRank: number;
    disassemblable: boolean | null;
  }> => {
    const cached = itemMetaCache.get(itemDefId);
    if (cached) return cached;
    const row = getItemDefinitionById(itemDefId);
    const meta = {
      name: typeof row?.name === 'string' && row.name.length > 0 ? row.name : itemDefId,
      category: typeof row?.category === 'string' ? row.category : '',
      subCategory: typeof row?.sub_category === 'string' && row.sub_category.length > 0 ? row.sub_category : null,
      effectDefs: row?.effect_defs ?? null,
      qualityRank: resolveQualityRankFromName(row?.quality, 1),
      disassemblable: typeof row?.disassemblable === 'boolean' ? row.disassemblable : null,
    };
    itemMetaCache.set(itemDefId, meta);
    return meta;
  };

  for (const participant of rewardParticipants) {
    const characterId = Math.floor(Number(participant.characterId));
    if (!Number.isFinite(characterId) || characterId <= 0) continue;

    let rewardBundle: DungeonRewardBundle = { exp: 0, silver: 0, items: [] };
    const isFirstClear = asNumber(clearCountMap.get(characterId), 0) <= 0;
    if (isFirstClear) {
      rewardBundle = mergeDungeonRewardBundle(
        rewardBundle,
        rollDungeonRewardBundle(firstClearRewardConfig, rewardMultiplier),
      );
    }

    addCharacterRewardDelta(pendingCharacterRewardDeltas, characterId, {
      exp: rewardBundle.exp,
      silver: rewardBundle.silver,
    });

    const autoDisassembleSetting =
      autoDisassembleSettings.get(characterId)
      ?? normalizeAutoDisassembleSetting({ enabled: false, rules: undefined });
    const grantedItems: Array<{ item_def_id: string; qty: number; item_ids: number[] }> = [];
    let autoDisassembleSilverGained = 0;

    for (const rewardItem of rewardBundle.items) {
      const itemMeta = await getItemMeta(rewardItem.itemDefId);
      const grantResult = await grantRewardItemWithAutoDisassemble({
        characterId,
        itemDefId: rewardItem.itemDefId,
        qty: rewardItem.qty,
        ...(rewardItem.bindType ? { bindType: rewardItem.bindType } : {}),
        itemMeta: {
          itemName: itemMeta.name,
          category: itemMeta.category,
          subCategory: itemMeta.subCategory,
          effectDefs: itemMeta.effectDefs,
          qualityRank: itemMeta.qualityRank,
          disassemblable: itemMeta.disassemblable,
        },
        autoDisassembleSetting,
        sourceObtainedFrom: 'dungeon_clear_reward',
        createItem: async ({ itemDefId, qty, bindType, obtainedFrom, equipOptions }) => {
          const grantContext = await getDungeonRewardGrantContext(characterId, grantContextByCharacterId);
          return await itemService.createItem(
            participant.userId,
            characterId,
            itemDefId,
            qty,
            {
              location: 'bag',
              obtainedFrom,
              bindType,
              bagSlotAllocator: grantContext.bagSlotAllocator,
              inventoryMutationContext: grantContext.inventoryMutationContext,
              slotSession: grantContext.slotSession,
              inventoryMutexAlreadyLocked: true,
              persistImmediately: true,
              ...(equipOptions
                ? { equipOptions: equipOptions as CreateItemOptions['equipOptions'] }
                : {}),
            },
          );
        },
        addSilver: async (ownerCharacterId, silverGain) => {
          const safeSilver = Math.max(0, Math.floor(Number(silverGain) || 0));
          if (safeSilver <= 0) return { success: true, message: '无需增加银两' };
          addCharacterRewardDelta(pendingCharacterRewardDeltas, ownerCharacterId, {
            silver: safeSilver,
          });
          return { success: true, message: '银两增加成功' };
        },
      });

      for (const warning of grantResult.warnings) {
        dungeonSettlementLogger.warn({
          instanceId: dungeonSettlement.instanceId,
          characterId,
          warning,
        }, '秘境结算发奖失败');
      }
      if (grantResult.pendingMailItems.length > 0) {
        const pendingMailEntry = pendingMailByReceiver.get(characterId) ?? {
          userId: participant.userId,
          items: [],
        };
        for (const pendingMailItem of grantResult.pendingMailItems) {
          pushPendingDungeonRewardMailItem(
            pendingMailEntry.items,
            normalizeDungeonRewardPendingMailItem(pendingMailItem),
          );
        }
        pendingMailByReceiver.set(characterId, pendingMailEntry);
      }
      for (const grantedItem of grantResult.grantedItems) {
        appendGrantedItem(grantedItems, grantedItem.itemDefId, grantedItem.qty, grantedItem.itemIds);
      }
      if (grantResult.gainedSilver > 0) {
        autoDisassembleSilverGained += grantResult.gainedSilver;
      }
    }

    await query(
      `
        INSERT INTO dungeon_record (
          character_id,
          dungeon_id,
          difficulty_id,
          instance_id,
          result,
          time_spent_sec,
          damage_dealt,
          death_count,
          rewards,
          is_first_clear
        )
        VALUES ($1, $2, $3, $4, 'cleared', $5, $6, $7, $8::jsonb, $9)
      `,
      [
        characterId,
        dungeonSettlement.dungeonId,
        dungeonSettlement.difficultyId,
        dungeonSettlement.instanceId,
        dungeonSettlement.timeSpentSec,
        dungeonSettlement.totalDamage,
        dungeonSettlement.deathCount,
        JSON.stringify({
          exp: rewardBundle.exp,
          silver: rewardBundle.silver + autoDisassembleSilverGained,
          items: grantedItems,
          is_first_clear: isFirstClear,
        }),
        isFirstClear,
      ],
    );
  }

  for (const participant of rewardParticipants) {
    await recordDungeonClearEvent(
      participant.characterId,
      dungeonSettlement.dungeonId,
      1,
      teamClearParticipantCount,
      dungeonSettlement.difficultyId,
    );
  }

  for (const [receiverCharacterId, pendingMailEntry] of pendingMailByReceiver.entries()) {
    const items = pendingMailEntry.items;
    for (let index = 0; index < items.length; index += DUNGEON_REWARD_PENDING_MAIL_CHUNK_SIZE) {
      const chunk = items.slice(index, index + DUNGEON_REWARD_PENDING_MAIL_CHUNK_SIZE);
      const mailResult = await sendSystemMail(
        pendingMailEntry.userId,
        receiverCharacterId,
        '秘境奖励补发',
        '由于背包空间不足，部分秘境奖励已通过邮件补发，请前往邮箱领取。',
        { items: chunk },
        30,
      );
      if (!mailResult.success) {
        throw new Error(`秘境奖励补发邮件发送失败: characterId=${receiverCharacterId}, message=${mailResult.message}`);
      }
    }
  }

  await applyCharacterRewardDeltas(pendingCharacterRewardDeltas);
  return 'settled';
};

export const settleDungeonClearInDb = async (params: {
  participants: DeferredSettlementTask['payload']['participants'];
  rewardParticipants: DeferredSettlementTask['payload']['rewardParticipants'];
  dungeonSettlement: DungeonClearPayload;
}): Promise<DungeonClearSettlementResult> => {
  return withTransaction(async () => {
    return settleDungeonClearInDbInTransaction(params);
  });
};

export const pushDungeonSettlementCharacterUpdates = async (
  participants: Array<{ userId: number }>,
): Promise<void> => {
  const affectedUserIds = [...new Set(
    participants
      .map((participant) => Math.floor(Number(participant.userId)))
      .filter((userId) => Number.isFinite(userId) && userId > 0),
  )];
  if (affectedUserIds.length <= 0) {
    return;
  }

  const gameServer = getGameServer();
  await Promise.all(
    affectedUserIds.map(async (userId) => {
      await gameServer.pushCharacterUpdate(userId);
    }),
  );
};

export type {
  DungeonStartConsumptionPayload,
  DungeonClearPayload,
  DungeonClearSettlementResult,
  DungeonSettlementParticipant,
};
