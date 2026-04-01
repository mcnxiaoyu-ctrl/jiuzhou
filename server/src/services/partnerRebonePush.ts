/**
 * 归元洗髓状态 Socket 推送模块
 *
 * 作用（做什么 / 不做什么）：
 * 1) 做什么：把“读取最新归元洗髓状态并推送给当前在线用户”收口为单一入口，避免路由和 runner 重复拼装状态。
 * 2) 做什么：复用 `partnerReboneService.getStatus`，保证伙伴页首屏查询与实时更新共用同一真值来源。
 * 3) 不做什么：不负责创建任务、执行洗髓或退回道具，也不替代结果提示事件 `partnerReboneResult`。
 *
 * 输入/输出：
 * - 输入：`characterId`，以及可选 `userId`。
 * - 输出：无；副作用是向在线用户发送 `partnerRebone:update`。
 *
 * 数据流/状态流：
 * route / runner / worker 写入洗髓状态 -> notifyPartnerReboneStatus -> 读取最新状态 -> emit `partnerRebone:update`。
 *
 * 关键边界条件与坑点：
 * 1) 推送前必须由调用方保证主线程动态伙伴快照已同步完成，否则状态虽然更新了，伙伴详情仍可能读到旧属性。
 * 2) 推送失败只能记日志，不能回滚已经落库的任务状态或退款结果。
 */
import { getGameServer } from '../game/gameServer.js';
import { getCharacterUserId } from './sect/db.js';
import { partnerReboneService } from './partnerReboneService.js';

export const notifyPartnerReboneStatus = async (
  characterId: number,
  userId?: number,
): Promise<void> => {
  try {
    const resolvedUserId = userId ?? await getCharacterUserId(characterId);
    if (!resolvedUserId) return;

    const result = await partnerReboneService.getStatus(characterId);
    if (!result.success || !result.data) return;

    getGameServer().emitToUser(resolvedUserId, 'partnerRebone:update', {
      characterId,
      status: result.data,
    });
  } catch (error) {
    console.error(`[partnerRebone] 推送洗髓状态失败: characterId=${characterId}`, error);
  }
};
