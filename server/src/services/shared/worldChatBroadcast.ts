/**
 * 世界频道系统广播共享模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一封装“以系统身份向世界频道广播消息”的 Socket 发送逻辑，避免业务服务各自拼接 `chat:message` 载荷。
 * 2. 做什么：为需要全服公告的业务提供单一入口，后续活动、首通、稀有产出等场景可直接复用。
 * 3. 不做什么：不负责决定哪些业务应该广播，也不负责拼接具体业务文案。
 *
 * 输入/输出：
 * - 输入：`content` 广播正文，`senderTitle` 系统称号（可选）。
 * - 输出：`boolean`，表示本次是否成功投递到已认证玩家频道。
 *
 * 数据流/状态流：
 * 业务服务生成文案 -> 本模块统一组装世界聊天消息 -> `GameServer` Socket 房间 `chat:authed` 广播。
 *
 * 关键边界条件与坑点：
 * 1. 这里只发“世界频道系统消息”，不能混入私聊/队伍/宗门等频道语义，否则前端聊天归类会错乱。
 * 2. 广播属于附加通知，不能反向影响主业务提交；若游戏 Socket 尚未初始化，仅记录告警并返回失败状态。
 */
import { randomUUID } from 'crypto';
import { getGameServer } from '../../game/gameServer.js';

type BroadcastWorldSystemMessageParams = {
  content: string;
  senderTitle?: string;
};

const SYSTEM_SENDER_NAME = '系统';

export const broadcastWorldSystemMessage = (
  params: BroadcastWorldSystemMessageParams,
): boolean => {
  const content = String(params.content || '').trim();
  if (!content) {
    return false;
  }

  try {
    const gameServer = getGameServer();
    gameServer.getIO().to('chat:authed').emit('chat:message', {
      id: randomUUID(),
      channel: 'world',
      content,
      timestamp: Date.now(),
      senderUserId: 0,
      senderCharacterId: 0,
      senderName: SYSTEM_SENDER_NAME,
      senderTitle: String(params.senderTitle || '').trim(),
    });
    return true;
  } catch (error) {
    console.warn(
      '[WorldChatBroadcast] 世界频道系统广播失败:',
      error instanceof Error ? error.message : error,
    );
    return false;
  }
};
