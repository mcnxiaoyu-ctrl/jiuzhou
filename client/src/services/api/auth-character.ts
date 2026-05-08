import type { AxiosRequestConfig } from 'axios';
import api from './core';
import { API_BASE } from '../runtimeUrls';
import { SILENT_API_REQUEST_CONFIG } from './requestConfig';

export interface CaptchaChallenge {
  captchaId: string;
  imageData: string;
  expiresAt: number;
}

export interface CaptchaVerifyPayload {
  captchaId: string;
  captchaCode: string;
}

/** 天御验证码票据载荷，与 CaptchaVerifyPayload 互斥使用 */
export interface TencentCaptchaVerifyPayload {
  ticket: string;
  randstr: string;
}

/** 统一验证码提交载荷：local 模式用 captchaId/captchaCode，tencent 模式用 ticket/randstr */
export type UnifiedCaptchaPayload = CaptchaVerifyPayload | TencentCaptchaVerifyPayload;

export interface AuthRequestPayload {
  username: string;
  password: string;
  captchaId?: string;
  captchaCode?: string;
  ticket?: string;
  randstr?: string;
}

export type AuthPhoneCodePurpose = 'login' | 'register' | 'legacy-bind' | 'reset-password';

export interface SendAuthPhoneCodePayload {
  phoneNumber: string;
  purpose: AuthPhoneCodePurpose;
  captchaId?: string;
  captchaCode?: string;
  ticket?: string;
  randstr?: string;
}

export interface PhoneLoginPayload {
  phoneNumber: string;
  smsCode: string;
}

export interface PhoneRegisterPayload {
  username: string;
  phoneNumber: string;
  smsCode: string;
}

export interface LegacyBindPhonePayload {
  username: string;
  password: string;
  phoneNumber: string;
  smsCode: string;
}

export interface ResetPasswordWithPhonePayload {
  phoneNumber: string;
  smsCode: string;
  newPassword: string;
}

export interface AuthResponse {
  success: boolean;
  message: string;
  data?: {
    user: {
      id: number;
      username: string;
    };
    token: string;
  };
}

export interface SendAuthPhoneCodeResponse {
  success: boolean;
  message?: string;
  data?: {
    cooldownSeconds: number;
    maskedPhoneNumber: string;
  };
}

export interface CaptchaResponse {
  success: boolean;
  message?: string;
  data: CaptchaChallenge;
}

export interface CharacterResponse {
  success: boolean;
  message: string;
  data?: {
    character: {
      id: number;
      nickname: string;
      gender: string;
      title: string;
      realm: string;
      sub_realm: string | null;
      auto_cast_skills?: boolean;
      auto_disassemble_enabled?: boolean;
      auto_disassemble_rules?: AutoDisassembleRulesDto | null;
      dungeon_no_stamina_cost?: boolean;
      spirit_stones: number;
      silver: number;
      qixue: number;
      max_qixue: number;
      wugong: number;
      wufang: number;
    };
    hasCharacter: boolean;
  };
}

export interface AutoDisassembleRuleDto {
  categories?: string[];
  subCategories?: string[];
  excludedSubCategories?: string[];
  includeNameKeywords?: string[];
  excludeNameKeywords?: string[];
  /** 规则级最高品质（1黄/2玄/3地/4天），不是全局配置 */
  maxQualityRank: number;
}

export type AutoDisassembleRulesDto = AutoDisassembleRuleDto[];

export const getCaptcha = (): Promise<CaptchaResponse> => {
  return api.get('/auth/captcha', SILENT_API_REQUEST_CONFIG);
};

export const sendAuthPhoneCode = (
  payload: SendAuthPhoneCodePayload,
): Promise<SendAuthPhoneCodeResponse> => {
  return api.post('/auth/phone-code/send', payload);
};

// 登录
export const login = (payload: AuthRequestPayload): Promise<AuthResponse> => {
  return api.post('/auth/login', payload);
};

export const phoneLogin = (payload: PhoneLoginPayload): Promise<AuthResponse> => {
  return api.post('/auth/phone-login', payload);
};

// 注册
export const register = (payload: PhoneRegisterPayload): Promise<AuthResponse> => {
  return api.post('/auth/register', payload);
};

export const legacyBindPhone = (payload: LegacyBindPhonePayload): Promise<AuthResponse> => {
  return api.post('/auth/legacy-bind-phone', payload);
};

export const resetPasswordWithPhone = (
  payload: ResetPasswordWithPhonePayload,
): Promise<{ success: boolean; message: string }> => {
  return api.post('/auth/password/reset', payload);
};

// 验证会话（持久登录检查）
export interface VerifyResponse {
  success: boolean;
  message: string;
  kicked?: boolean;
  data?: { userId: number };
}

export const verifySession = (): Promise<VerifyResponse> => {
  return api.get('/auth/verify');
};

export interface AuthBootstrapResponse {
  success: boolean;
  message: string;
  kicked?: boolean;
  data?: {
    userId: number;
    hasCharacter: boolean;
  };
}

export const getAuthBootstrap = (): Promise<AuthBootstrapResponse> => {
  return api.get('/auth/bootstrap');
};

// 检查是否有角色
export const checkCharacter = (): Promise<CharacterResponse> => {
  return api.get('/character/check');
};

// 创建角色
export const createCharacter = (nickname: string, gender: 'male' | 'female'): Promise<CharacterResponse> => {
  return api.post('/character/create', { nickname, gender });
};

// 获取角色信息
export const getCharacterInfo = (): Promise<CharacterResponse> => {
  return api.get('/character/info');
};

export const updateCharacterPosition = (
  currentMapId: string,
  currentRoomId: string,
  requestConfig?: AxiosRequestConfig,
): Promise<{ success: boolean; message: string }> => {
  return api.post('/character/updatePosition', { currentMapId, currentRoomId }, requestConfig);
};

export const updateCharacterPositionKeepalive = (currentMapId: string, currentRoomId: string): void => {
  const mapId = String(currentMapId || '').trim();
  const roomId = String(currentRoomId || '').trim();
  if (!mapId || !roomId) return;

  const token = localStorage.getItem('token');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  void fetch(`${API_BASE}/character/updatePosition`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ currentMapId: mapId, currentRoomId: roomId }),
    keepalive: true,
  }).catch(() => undefined);
};

export const updateCharacterAutoCastSkills = (enabled: boolean): Promise<{ success: boolean; message: string }> => {
  return api.post('/character/updateAutoCastSkills', { enabled });
};

export const updateCharacterAutoDisassemble = (
  enabled: boolean,
  rules?: AutoDisassembleRulesDto
): Promise<{ success: boolean; message: string }> => {
  return api.post('/character/updateAutoDisassemble', {
    enabled,
    ...(rules ? { rules } : {}),
  });
};

export const updateCharacterDungeonNoStaminaCost = (
  enabled: boolean,
): Promise<{ success: boolean; message: string }> => {
  return api.post('/character/updateDungeonNoStaminaCost', { enabled });
};

export const renameCharacterWithCard = (
  itemInstanceId: number,
  nickname: string,
  requestConfig?: AxiosRequestConfig,
): Promise<{ success: boolean; message: string }> => {
  return api.post('/character/renameWithCard', { itemInstanceId, nickname }, requestConfig);
};
