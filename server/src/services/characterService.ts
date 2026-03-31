import { query } from '../config/database.js';
import { updateSectionProgress } from './mainQuest/index.js';
import { initCharacterAchievements, updateAchievementProgress } from './achievementService.js';
import { applyStaminaRecoveryByUserId } from './staminaService.js';
import { withTransaction } from '../config/database.js';
import {
  normalizeAutoDisassembleSetting,
  type AutoDisassembleRuleSet,
} from './autoDisassembleRules.js';
import {
  getCharacterComputedByUserId,
  invalidateCharacterComputedCache,
  type CharacterComputedRow,
} from './characterComputedService.js';
import {
  setOnlineBattleCharacterDungeonNoStaminaCost,
  setOnlineBattleCharacterPosition,
} from './onlineBattleProjectionService.js';
import { withUnlockedFeatures } from './featureUnlockService.js';
import { createInventoryForCharacter } from './shared/inventoryPersistence.js';
import { loadCharacterIdByUserIdDirect, primeCharacterIdByUserIdCache } from './shared/characterId.js';
import {
  normalizeCharacterNicknameInput,
  validateCharacterNickname,
} from './shared/characterNameRules.js';
import { consumeRenameCardItemInstance } from './shared/characterRenameCard.js';
import { broadcastWorldSystemMessage } from './shared/worldChatBroadcast.js';

export type Character = CharacterComputedRow & {
  feature_unlocks: string[];
};

export interface CharacterResult {
  success: boolean;
  message: string;
  data?: {
    character: Character | null;
    hasCharacter: boolean;
  };
}

export const characterServiceSideEffects = {
  invalidateCharacterComputedCacheByCharacterId: invalidateCharacterComputedCache,
  broadcastWorldSystemMessage,
};

const attachUnlockedFeaturesToCharacter = async (
  character: CharacterComputedRow,
): Promise<Character> => {
  return withUnlockedFeatures(character);
};

// 检查用户是否有角色
export const checkCharacter = async (userId: number): Promise<CharacterResult> => {
  await applyStaminaRecoveryByUserId(userId);
  const character = await getCharacterComputedByUserId(userId);
  if (character) {
    const characterWithUnlockedFeatures = await attachUnlockedFeaturesToCharacter(character);
    return {
      success: true,
      message: '已有角色',
      data: {
        character: characterWithUnlockedFeatures,
        hasCharacter: true,
      },
    };
  }
    
  return {
    success: true,
    message: '未创建角色',
    data: {
      character: null,
      hasCharacter: false,
    },
  };
};

// 创建角色
export const createCharacter = async (
  userId: number,
  nickname: string,
  gender: 'male' | 'female'
): Promise<CharacterResult> => {
  // 检查是否已有角色
  const existCheck = await query('SELECT id FROM characters WHERE user_id = $1', [userId]);
  if (existCheck.rows.length > 0) {
    return { success: false, message: '已存在角色，无法重复创建' };
  }

  const nicknameValidation = await validateCharacterNickname(nickname);
  if (!nicknameValidation.success) {
    return { success: false, message: nicknameValidation.message };
  }

  // 创建角色
  const insertSQL = `
    INSERT INTO characters (
      user_id, nickname, gender, title,
      spirit_stones, silver, realm, exp,
      attribute_points, jing, qi, shen,
      attribute_type, attribute_element,
      current_map_id, current_room_id
    ) VALUES (
      $1, $2, $3, '散修',
      0, 0, '凡人', 0,
      0, 0, 0, 0,
      'physical', 'none',
      'map-qingyun-village', 'room-village-center'
    ) RETURNING id
  `;
    
  const result = await query(insertSQL, [userId, nicknameValidation.nickname, gender]);
    
  // 创建角色背包
  const characterId = result.rows[0].id;
  await createInventoryForCharacter(characterId);
  await primeCharacterIdByUserIdCache(userId, Number(characterId));

  await initCharacterAchievements(characterId);
  await characterServiceSideEffects.invalidateCharacterComputedCacheByCharacterId(characterId);

  const computedCharacter = await getCharacterComputedByUserId(userId);
  if (!computedCharacter) {
    return { success: false, message: '角色创建成功，但读取角色数据失败' };
  }
  const characterWithUnlockedFeatures = await attachUnlockedFeaturesToCharacter(computedCharacter);

  return {
    success: true,
    message: '角色创建成功',
    data: {
      character: characterWithUnlockedFeatures,
      hasCharacter: true,
    },
  };
};

export const renameCharacterWithCard = async (
  userId: number,
  itemInstanceId: number,
  nickname: string,
): Promise<{ success: boolean; message: string }> => {
  const result = await withTransaction(async (): Promise<{
    success: boolean;
    message: string;
    broadcastContent: string | null;
  }> => {
    const characterId = await loadCharacterIdByUserIdDirect(userId);
    if (!characterId) {
      return { success: false, message: '角色不存在', broadcastContent: null };
    }

    const characterResult = await query(
      'SELECT nickname FROM characters WHERE id = $1 LIMIT 1',
      [characterId],
    );
    if (characterResult.rows.length === 0) {
      return { success: false, message: '角色不存在', broadcastContent: null };
    }
    const characterRow = characterResult.rows[0] as { nickname?: string | null };
    const previousNickname = String(characterRow.nickname || '').trim();

    const nicknameValidation = await validateCharacterNickname(nickname, {
      excludeCharacterId: characterId,
    });
    if (!nicknameValidation.success) {
      return { success: false, message: nicknameValidation.message, broadcastContent: null };
    }

    const consumeResult = await consumeRenameCardItemInstance(characterId, itemInstanceId);
    if (!consumeResult.success) {
      return { success: false, message: consumeResult.message, broadcastContent: null };
    }

    await query(
      `
        UPDATE characters
        SET nickname = $1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
      `,
      [nicknameValidation.nickname, characterId],
    );

    await characterServiceSideEffects.invalidateCharacterComputedCacheByCharacterId(characterId);

    return {
      success: true,
      message: '改名成功',
      broadcastContent: `【易名符】『${previousNickname}』改名为『${nicknameValidation.nickname}』，仙名重铸，声传九州！`,
    };
  });
  if (result.success && result.broadcastContent) {
    characterServiceSideEffects.broadcastWorldSystemMessage({
      senderTitle: '天机传音',
      content: result.broadcastContent,
    });
  }

  return {
    success: result.success,
    message: result.message,
  };
};

// 获取角色信息
export const getCharacter = async (userId: number): Promise<CharacterResult> => {
  await applyStaminaRecoveryByUserId(userId);
  const character = await getCharacterComputedByUserId(userId);
  if (!character) {
    return { success: false, message: '角色不存在' };
  }
  const characterWithUnlockedFeatures = await attachUnlockedFeaturesToCharacter(character);
    
  return {
    success: true,
    message: '获取成功',
    data: {
      character: characterWithUnlockedFeatures,
      hasCharacter: true,
    },
  };
};

export const updateCharacterPosition = async (
  userId: number,
  currentMapId: string,
  currentRoomId: string
): Promise<{ success: boolean; message: string }> => {
  const normalizedPosition = normalizeCharacterPositionInput(currentMapId, currentRoomId);
  if (!normalizedPosition.success) {
    return normalizedPosition;
  }

  const { mapId, roomId } = normalizedPosition;
  const result = await query(
    `
      UPDATE characters
      SET current_map_id = $1,
          current_room_id = $2,
          updated_at = CURRENT_TIMESTAMP
      WHERE user_id = $3
      RETURNING id
    `,
    [mapId, roomId, userId],
  );

  if (result.rowCount === 0) {
    return { success: false, message: '角色不存在' };
  }

  const characterId = Number(result.rows?.[0]?.id);
  if (Number.isFinite(characterId) && characterId > 0) {
    await syncCharacterRuntimePosition(characterId, mapId, roomId);
    await updateSectionProgress(characterId, { type: 'reach', roomId });
    await updateAchievementProgress(characterId, `map:discover:${mapId}`, 1);
    await updateAchievementProgress(characterId, `room:reach:${roomId}`, 1);
  }

  return { success: true, message: '位置更新成功' };
};

type NormalizedCharacterPositionResult =
  | { success: true; mapId: string; roomId: string }
  | { success: false; message: string };

const normalizeCharacterPositionInput = (
  currentMapId: string,
  currentRoomId: string,
): NormalizedCharacterPositionResult => {
  const mapId = String(currentMapId || '').trim();
  const roomId = String(currentRoomId || '').trim();

  if (!mapId || !roomId) {
    return { success: false, message: '位置参数不能为空' };
  }

  if (mapId.length > 64 || roomId.length > 64) {
    return { success: false, message: '位置参数过长' };
  }

  return { success: true, mapId, roomId };
};

const syncCharacterRuntimePosition = async (
  characterId: number,
  mapId: string,
  roomId: string,
): Promise<void> => {
  await setOnlineBattleCharacterPosition(characterId, {
    currentMapId: mapId,
    currentRoomId: roomId,
  });
};

/**
 * 系统强制迁移角色位置。
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：供地图关闭、运行态收口等服务端强制迁移场景复用，只同步 DB 与在线战斗位置。
 * 2. 做什么：避免后台迁移误触发“到达房间”型主线和探索成就。
 * 3. 不做什么：不负责客户端推送，不做地图可用性判定。
 *
 * 输入/输出：
 * - 输入：characterId、目标 mapId、目标 roomId。
 * - 输出：统一 `{ success, message, userId }`，供上层决定是否继续推送角色刷新。
 *
 * 数据流/状态流：
 * - 后台收口服务 -> 本方法写 `characters.current_map_id/current_room_id`
 * - -> `setOnlineBattleCharacterPosition` 同步在线战斗快照
 * - -> 调用方按需推送客户端刷新。
 *
 * 复用设计说明：
 * - 玩家主动移动与系统强制迁移对“位置持久化 + 在线战斗快照同步”的底层写入诉求相同。
 * - 但系统迁移不该顺带推进主线/成就，因此拆出独立入口，避免业务层到处复制“只写位置不记进度”的 SQL。
 * - 地图关闭、异常房间收口等都可以复用这条单一入口。
 *
 * 关键边界条件与坑点：
 * 1. 迁移必须沿用与前台移动相同的参数归一化，避免后台写入脏 roomId 造成后续房间匹配失败。
 * 2. 这里只做位置写入，不补任何兜底 map/room，落点是否合法必须由上层先解析完成。
 */
export const relocateCharacterPositionByCharacterId = async (
  characterId: number,
  currentMapId: string,
  currentRoomId: string,
): Promise<{ success: boolean; message: string; userId?: number }> => {
  const normalizedPosition = normalizeCharacterPositionInput(currentMapId, currentRoomId);
  if (!normalizedPosition.success) {
    return normalizedPosition;
  }

  const { mapId, roomId } = normalizedPosition;
  const result = await query(
    `
      UPDATE characters
      SET current_map_id = $1,
          current_room_id = $2,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING user_id
    `,
    [mapId, roomId, characterId],
  );

  if (result.rowCount === 0) {
    return { success: false, message: '角色不存在' };
  }

  await syncCharacterRuntimePosition(characterId, mapId, roomId);
  return {
    success: true,
    message: '位置迁移成功',
    userId: Number(result.rows?.[0]?.user_id),
  };
};

export const updateCharacterAutoCastSkills = async (
  userId: number,
  enabled: boolean,
): Promise<{ success: boolean; message: string }> => {
  const sql = `
    UPDATE characters
    SET auto_cast_skills = $1,
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = $2
  `;
  const result = await query(sql, [Boolean(enabled), userId]);

  if (result.rowCount === 0) {
    return { success: false, message: '角色不存在' };
  }

  return { success: true, message: '设置已保存' };
};

export const updateCharacterAutoDisassembleSettings = async (
  userId: number,
  enabled: boolean,
  rules?: AutoDisassembleRuleSet[],
): Promise<{ success: boolean; message: string }> => {
  try {
    const normalized = normalizeAutoDisassembleSetting({
      enabled,
      rules,
    });
    const parsedRulesJson = rules === undefined ? null : JSON.stringify(normalized.rules);
    const sql = `
      UPDATE characters
      SET auto_disassemble_enabled = $1,
          auto_disassemble_rules = COALESCE($2::jsonb, auto_disassemble_rules, '[]'::jsonb),
          updated_at = CURRENT_TIMESTAMP
      WHERE user_id = $3
    `;
    const result = await query(sql, [normalized.enabled, parsedRulesJson, userId]);

    if (result.rowCount === 0) {
      return { success: false, message: '角色不存在' };
    }

    return { success: true, message: '设置已保存' };
  } catch (error) {
    console.error('更新自动分解设置失败:', error);
    return { success: false, message: '更新设置失败' };
  }
};

export const updateCharacterDungeonNoStaminaCostSetting = async (
  userId: number,
  enabled: boolean,
): Promise<{ success: boolean; message: string }> => {
  const sql = `
    UPDATE characters
    SET dungeon_no_stamina_cost = $1,
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = $2
    RETURNING id
  `;
  const result = await query(sql, [Boolean(enabled), userId]);

  if (result.rowCount === 0) {
    return { success: false, message: '角色不存在' };
  }

  const characterId = Number(result.rows?.[0]?.id);
  if (Number.isFinite(characterId) && characterId > 0) {
    await setOnlineBattleCharacterDungeonNoStaminaCost(characterId, Boolean(enabled));
  }

  return { success: true, message: '设置已保存' };
};
