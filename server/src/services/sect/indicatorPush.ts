/**
 * 宗门首页指示器 Socket 推送模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把宗门红点推送的发送范围收敛为单一入口，避免各路由分别手写“查谁、推给谁”。
 * 2. 做什么：复用 indicator.ts 的轻量计算与角色范围查询，只负责把结果发到对应用户 Socket。
 * 3. 不做什么：不参与宗门业务写逻辑、不替代事务、不返回宗门详情。
 *
 * 输入/输出：
 * - 输入：characterIds、sectId、applicationId。
 * - 输出：无返回值；副作用是向在线用户发送 `sect:update`。
 *
 * 数据流/状态流：
 * - 路由在写操作成功后调用本模块。
 * - 本模块先解析受影响角色集合，再按角色计算最新指示器，最后逐个 emit 给在线用户。
 *
 * 关键边界条件与坑点：
 * 1. 申请处理/取消后仍需通过 applicationId 回查 sect_id 与申请人，避免路由层重复保存同一份上下文。
 * 2. Socket 推送属于非阻塞提示能力，失败时只记录日志，不能反向影响已经成功提交的业务写操作。
 */
import { query } from '../../config/database.js';
import { getGameServer } from '../../game/gameServer.js';
import {
  getCharacterUserIdMap,
  getSectIndicatorByCharacterId,
  listSectManagerCharacterIds,
  listSectMemberCharacterIds,
  normalizeCharacterIdList,
} from './indicator.js';

interface SectApplicationScopeRow {
  sect_id: string;
  character_id: number | string;
}

const normalizeCount = (value: number | string | null | undefined): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
};

const runSectIndicatorTask = (label: string, task: Promise<void>): void => {
  void task.catch((error) => {
    console.error(`[sect:update] ${label} 失败:`, error);
  });
};

const emitSectIndicatorToCharacterIdsInternal = async (characterIds: number[]): Promise<void> => {
  const ids = normalizeCharacterIdList(characterIds);
  if (ids.length <= 0) return;

  const userIdMap = await getCharacterUserIdMap(ids);
  if (userIdMap.size <= 0) return;

  const payloadEntries = await Promise.all(
    ids.map(async (characterId) => {
      const payload = await getSectIndicatorByCharacterId(characterId);
      return [characterId, payload] as const;
    })
  );

  const gameServer = getGameServer();
  for (const [characterId, payload] of payloadEntries) {
    const userId = userIdMap.get(characterId);
    if (!userId) continue;
    gameServer.emitToUser(userId, 'sect:update', payload);
  }
};

const loadApplicationScope = async (applicationId: number): Promise<{ sectId: string; applicantCharacterId: number } | null> => {
  const result = await query<SectApplicationScopeRow>(
    `
      SELECT sect_id, character_id
      FROM sect_application
      WHERE id = $1
      LIMIT 1
    `,
    [applicationId]
  );
  const row = result.rows[0];
  if (!row) return null;

  const applicantCharacterId = normalizeCount(row.character_id);
  if (!row.sect_id || applicantCharacterId <= 0) return null;
  return {
    sectId: row.sect_id,
    applicantCharacterId,
  };
};

export const notifySectIndicatorToCharacterIds = (characterIds: number[]): void => {
  runSectIndicatorTask(`characterIds=${characterIds.join(',')}`, emitSectIndicatorToCharacterIdsInternal(characterIds));
};

export const notifySectIndicatorToSectManagers = (sectId: string, extraCharacterIds: number[] = []): void => {
  runSectIndicatorTask(
    `sectManagers=${sectId}`,
    (async () => {
      const managerIds = await listSectManagerCharacterIds(sectId);
      await emitSectIndicatorToCharacterIdsInternal([...managerIds, ...extraCharacterIds]);
    })()
  );
};

export const notifySectIndicatorToSectMembers = (sectId: string, extraCharacterIds: number[] = []): void => {
  runSectIndicatorTask(
    `sectMembers=${sectId}`,
    (async () => {
      const memberIds = await listSectMemberCharacterIds(sectId);
      await emitSectIndicatorToCharacterIdsInternal([...memberIds, ...extraCharacterIds]);
    })()
  );
};

export const notifySectIndicatorByApplicationId = (applicationId: number): void => {
  runSectIndicatorTask(
    `application=${applicationId}`,
    (async () => {
      const scope = await loadApplicationScope(applicationId);
      if (!scope) return;
      const managerIds = await listSectManagerCharacterIds(scope.sectId);
      await emitSectIndicatorToCharacterIdsInternal([...managerIds, scope.applicantCharacterId]);
    })()
  );
};
