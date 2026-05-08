import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { query } from '../config/database.js';
import dotenv from 'dotenv';
import { BusinessError } from '../middleware/BusinessError.js';
import {
  assertPhoneNumberAvailableForBinding,
  normalizeAuthPhoneNumberOrThrow,
  verifyAuthPhoneCode,
} from './accountPhoneVerificationService.js';

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || 'jiuzhou-xiuxian-secret-key';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

export interface User {
  id: number;
  username: string;
  password?: string | null;
  phone_number?: string | null;
  created_at: Date;
  updated_at: Date;
  last_login: Date | null;
  status: number | null;
  session_token?: string;
}

export interface AuthResult {
  success: boolean;
  message: string;
  data?: {
    user: Omit<User, 'password' | 'session_token'>;
    token: string;
    sessionToken: string;
  };
}

export const PASSWORD_MIN_LENGTH = 6;

export const getPasswordPolicyError = (password: string): string | null => {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `密码长度至少${PASSWORD_MIN_LENGTH}位`;
  }
  return null;
};

// 生成会话token
const generateSessionToken = (): string => {
  return crypto.randomBytes(32).toString('hex');
};

export const hashPassword = async (password: string): Promise<string> => {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
};

export const verifyPasswordHash = (password: string, passwordHash: string): Promise<boolean> => {
  return bcrypt.compare(password, passwordHash);
};

const assertUserCanLogin = (user: Pick<User, 'status'>): void => {
  if (user.status === 0) {
    throw new BusinessError('账号已被禁用');
  }
};

const createAuthenticatedResult = async (user: User): Promise<AuthResult> => {
  assertUserCanLogin(user);

  const sessionToken = generateSessionToken();

  await query(
    'UPDATE users SET last_login = CURRENT_TIMESTAMP, session_token = $1 WHERE id = $2',
    [sessionToken, user.id],
  );

  const token = jwt.sign(
    { id: user.id, username: user.username, sessionToken },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'] },
  );

  const { password: _, session_token: __, ...userWithoutSensitive } = user;

  return {
    success: true,
    message: '登录成功',
    data: { user: userWithoutSensitive, token, sessionToken },
  };
};

// 注册
export const register = async (username: string, password: string): Promise<AuthResult> => {
  // 检查用户名是否已存在
  const existCheck = await query('SELECT id FROM users WHERE username = $1', [username]);
  if (existCheck.rows.length > 0) {
    return { success: false, message: '用户名已存在' };
  }

  // 加密密码
  const hashedPassword = await hashPassword(password);

  // 插入用户
  const insertSQL = `
    INSERT INTO users (username, password, created_at, updated_at) 
    VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) 
    RETURNING id, username, created_at, updated_at, status
  `;
  const result = await query(insertSQL, [username, hashedPassword]);
  const user = result.rows[0];

  // 生成token
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });

  return {
    success: true,
    message: '注册成功',
    data: { user, token, sessionToken: '' },
  };
};

export const registerWithPhone = async (
  username: string,
  rawPhoneNumber: string,
  smsCode: string,
): Promise<AuthResult> => {
  const existCheck = await query('SELECT id FROM users WHERE username = $1', [username]);
  if (existCheck.rows.length > 0) {
    return { success: false, message: '用户名已存在' };
  }

  const phoneNumber = await verifyAuthPhoneCode(rawPhoneNumber, smsCode);
  await assertPhoneNumberAvailableForBinding(phoneNumber);

  const insertSQL = `
    INSERT INTO users (username, password, phone_number, created_at, updated_at) 
    VALUES ($1, NULL, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) 
    RETURNING id, username, phone_number, created_at, updated_at, last_login, status
  `;
  await query(insertSQL, [username, phoneNumber]);

  return {
    success: true,
    message: '注册成功',
  };
};

// 登录
export const login = async (username: string, password: string): Promise<AuthResult> => {
  // 查询用户
  const result = await query('SELECT * FROM users WHERE username = $1', [username]);
  if (result.rows.length === 0) {
    return { success: false, message: '用户名或密码错误' };
  }

  const user = result.rows[0] as User;

  assertUserCanLogin(user);

  if (!user.password) {
    return { success: false, message: '该账号未设置口令，请使用手机号验证码登录' };
  }

  // 验证密码
  const isMatch = await verifyPasswordHash(password, user.password);
  if (!isMatch) {
    return { success: false, message: '用户名或密码错误' };
  }

  return createAuthenticatedResult(user);
};

export const loginWithPhone = async (
  rawPhoneNumber: string,
  smsCode: string,
): Promise<AuthResult> => {
  const phoneNumber = await verifyAuthPhoneCode(rawPhoneNumber, smsCode);
  const result = await query('SELECT * FROM users WHERE phone_number = $1', [phoneNumber]);
  if (result.rows.length === 0) {
    return { success: false, message: '手机号未注册' };
  }

  const user = result.rows[0] as User;
  return createAuthenticatedResult(user);
};

export const bindLegacyAccountPhoneAndLogin = async (
  username: string,
  password: string,
  rawPhoneNumber: string,
  smsCode: string,
): Promise<AuthResult> => {
  const phoneNumber = normalizeAuthPhoneNumberOrThrow(rawPhoneNumber);
  const result = await query('SELECT * FROM users WHERE username = $1', [username]);
  if (result.rows.length === 0) {
    return { success: false, message: '用户名或密码错误' };
  }

  const user = result.rows[0] as User;
  assertUserCanLogin(user);

  if (!user.password) {
    return { success: false, message: '该账号未设置口令，请使用手机号验证码登录' };
  }

  const isMatch = await verifyPasswordHash(password, user.password);
  if (!isMatch) {
    return { success: false, message: '用户名或密码错误' };
  }

  if (user.phone_number && user.phone_number !== phoneNumber) {
    return { success: false, message: '当前账号已绑定其他手机号，暂不支持换绑' };
  }

  await assertPhoneNumberAvailableForBinding(phoneNumber, user.id);

  await verifyAuthPhoneCode(phoneNumber, smsCode);

  if (!user.phone_number) {
    await query(
      'UPDATE users SET phone_number = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [phoneNumber, user.id],
    );
    user.phone_number = phoneNumber;
  }

  return createAuthenticatedResult(user);
};

export const resetPasswordWithPhone = async (
  rawPhoneNumber: string,
  smsCode: string,
  newPassword: string,
): Promise<{ success: boolean; message: string }> => {
  const passwordPolicyError = getPasswordPolicyError(newPassword);
  if (passwordPolicyError) {
    return { success: false, message: passwordPolicyError };
  }

  const phoneNumber = await verifyAuthPhoneCode(rawPhoneNumber, smsCode);
  const result = await query('SELECT id, status FROM users WHERE phone_number = $1', [phoneNumber]);
  if (result.rows.length === 0) {
    return { success: false, message: '手机号未注册' };
  }

  const user = result.rows[0] as Pick<User, 'id' | 'status'>;
  if (user.status === 0) {
    return { success: false, message: '账号已被禁用' };
  }

  const nextPasswordHash = await hashPassword(newPassword);
  const nextSessionToken = generateSessionToken();
  await query(
    'UPDATE users SET password = $1, session_token = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
    [nextPasswordHash, nextSessionToken, user.id],
  );

  return { success: true, message: '密码重置成功' };
};

// 验证token
export const verifyToken = (token: string): { valid: boolean; decoded?: jwt.JwtPayload } => {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as jwt.JwtPayload;
    return { valid: true, decoded };
  } catch {
    return { valid: false };
  }
};

// 验证会话是否有效（检查session_token是否匹配）
export const verifySession = async (
  userId: number,
  sessionToken: string
): Promise<{ valid: boolean; kicked?: boolean }> => {
  try {
    const result = await query('SELECT session_token FROM users WHERE id = $1', [userId]);
    if (result.rows.length === 0) {
      return { valid: false };
    }

    const dbSessionToken = result.rows[0].session_token;
    if (dbSessionToken && dbSessionToken !== sessionToken) {
      // 会话token不匹配，说明在其他地方登录了
      return { valid: false, kicked: true };
    }

    return { valid: true };
  } catch (error) {
    console.error('验证会话失败:', error);
    return { valid: false };
  }
};

// 验证token并检查会话
export const verifyTokenAndSession = async (
  token: string
): Promise<{ valid: boolean; decoded?: jwt.JwtPayload; kicked?: boolean }> => {
  const { valid, decoded } = verifyToken(token);
  if (!valid || !decoded) {
    return { valid: false };
  }

  // 检查会话token
  const sessionResult = await verifySession(decoded.id, decoded.sessionToken);
  if (!sessionResult.valid) {
    return { valid: false, kicked: sessionResult.kicked };
  }

  return { valid: true, decoded };
};

export const changePassword = async (
  userId: number,
  currentPassword: string,
  newPassword: string
): Promise<{ success: boolean; message: string }> => {
  const result = await query('SELECT password, status FROM users WHERE id = $1', [userId]);
  if (result.rows.length === 0) {
    return { success: false, message: '账号不存在' };
  }

  const user = result.rows[0] as Pick<User, 'password' | 'status'>;
  if (user.status === 0) {
    return { success: false, message: '账号已被禁用' };
  }

  const passwordHash = user.password;
  if (!passwordHash) {
    return { success: false, message: '账号密码状态异常' };
  }

  const isCurrentPasswordValid = await verifyPasswordHash(currentPassword, passwordHash);
  if (!isCurrentPasswordValid) {
    return { success: false, message: '当前密码错误' };
  }

  if (currentPassword === newPassword) {
    return { success: false, message: '新密码不能与当前密码相同' };
  }

  const nextPasswordHash = await hashPassword(newPassword);
  await query(
    'UPDATE users SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
    [nextPasswordHash, userId]
  );

  return { success: true, message: '密码修改成功' };
};
