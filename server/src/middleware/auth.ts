/**
 * 统一鉴权中间件。
 * 输入：HTTP Authorization Bearer Token。
 * 输出：
 * - `requireAuth` 成功时在 `req.userId` 写入用户ID；失败返回 401。
 * - `requireCharacter` 在 requireAuth 基础上查询角色ID，写入 `req.characterId`；角色不存在返回 404。
 * - `getOptionalUserId` 尝试解析 token，失败时返回 `undefined`（不抛错）。
 * 约束：
 * - 401 文案统一为"登录状态无效，请重新登录"。
 */
import type { NextFunction, Request, Response } from 'express';
import { verifyToken } from '../services/authService.js';
import { getCharacterIdByUserId } from '../services/shared/characterId.js';

const AUTH_INVALID_MESSAGE = '登录状态无效，请重新登录';

const readBearerToken = (req: Request): string | null => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice('Bearer '.length).trim();
  return token ? token : null;
};

const parseUserIdFromToken = (token: string): number | null => {
  const { valid, decoded } = verifyToken(token);
  if (!valid || !decoded) return null;
  const userId = Number(decoded.id);
  if (!Number.isFinite(userId) || userId <= 0) return null;
  return userId;
};

export const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
  const token = readBearerToken(req);
  if (!token) {
    res.status(401).json({ success: false, message: AUTH_INVALID_MESSAGE });
    return;
  }

  const userId = parseUserIdFromToken(token);
  if (!userId) {
    res.status(401).json({ success: false, message: AUTH_INVALID_MESSAGE });
    return;
  }

  req.userId = userId;
  next();
};

/**
 * 鉴权 + 角色查询中间件。
 * 成功时同时在 req 上写入 userId 和 characterId；角色不存在返回 404。
 */
export const requireCharacter = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const token = readBearerToken(req);
  if (!token) {
    res.status(401).json({ success: false, message: AUTH_INVALID_MESSAGE });
    return;
  }

  const userId = parseUserIdFromToken(token);
  if (!userId) {
    res.status(401).json({ success: false, message: AUTH_INVALID_MESSAGE });
    return;
  }

  req.userId = userId;

  const characterId = await getCharacterIdByUserId(userId);
  if (!characterId) {
    res.status(404).json({ success: false, message: '角色不存在' });
    return;
  }

  req.characterId = characterId;
  next();
};

export const getOptionalUserId = (req: Request): number | undefined => {
  const token = readBearerToken(req);
  if (!token) return undefined;
  const userId = parseUserIdFromToken(token);
  return userId ?? undefined;
};
