/**
 * 扩展 Express Request：
 * - `userId` 由 requireAuth 中间件注入。
 * - `characterId` 由 requireCharacter 中间件注入。
 * - 仅用于后端内部类型提示，不影响 HTTP 协议。
 */
declare global {
  namespace Express {
    interface Request {
      userId?: number;
      characterId?: number;
    }
  }
}

export {};
