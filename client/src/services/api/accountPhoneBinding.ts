/**
 * 账号手机号绑定接口模块
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中封装登录态下手机号绑定状态、首次绑定、两步换绑和短信发码接口。
 * 2. 做什么：把 `/account/phone-binding/*` 的请求载荷和响应类型收敛到账号手机号模块，供游戏内账号安全面板复用。
 * 3. 不做什么：不处理表单校验、不保存换绑步骤状态，也不决定错误提示展示时机。
 *
 * 输入/输出：
 * - 输入：手机号、人机验证码票据、短信验证码、换绑凭证和可选 Axios 请求配置。
 * - 输出：绑定状态、发码冷却秒数、换绑凭证或最新脱敏手机号。
 *
 * 数据流/状态流：
 * 设置页表单 -> 本模块拼接账号手机号接口请求 -> 服务端账号路由 -> 调用方根据响应刷新绑定状态。
 *
 * 复用设计说明：
 * - 首次绑定、验证原手机号、新手机号发码三类请求共用同一个验证码载荷结构，集中在这里可避免页面重复拼 `captchaId/captchaCode` 与 `ticket/randstr`。
 * - 手机号绑定是账号安全高频变化点，请求类型集中后，后续新增入口只复用本模块，不需要在页面内散落接口字符串。
 *
 * 关键边界条件与坑点：
 * 1. 发码接口必须透传人机验证码字段；本模块不主动补默认值，避免绕过服务端安全策略。
 * 2. `changeToken` 只由验证原手机号接口产生并在最终换绑时使用，本模块不缓存它，避免跨表单状态污染。
 */
import type { AxiosRequestConfig } from 'axios';

import type { UnifiedCaptchaPayload } from './auth-character';
import api from './core';

export interface AccountPhoneBindingStatus {
  enabled: boolean;
  isBound: boolean;
  maskedPhoneNumber: string | null;
}

export interface AccountPhoneBindingStatusResponse {
  success: boolean;
  data: AccountPhoneBindingStatus;
}

export interface AccountPhoneBindingSendCodeResponse {
  success: boolean;
  data: {
    cooldownSeconds: number;
  };
}

export interface AccountPhoneBindingMutationResponse {
  success: boolean;
  data: {
    maskedPhoneNumber: string;
  };
}

export interface AccountPhoneBindingVerifyCurrentResponse {
  success: boolean;
  data: {
    changeToken: string;
    expiresSeconds: number;
  };
}

export type AccountPhoneBindingSendCodePayload = UnifiedCaptchaPayload & {
  phoneNumber: string;
};

export type AccountPhoneBindingCurrentCodePayload = UnifiedCaptchaPayload;

export type AccountPhoneBindingChangeNewCodePayload = UnifiedCaptchaPayload & {
  phoneNumber: string;
};

export interface AccountPhoneBindingBindPayload {
  phoneNumber: string;
  code: string;
}

export interface AccountPhoneBindingVerifyCurrentPayload {
  currentPhoneCode: string;
}

export interface AccountPhoneBindingChangePayload {
  newPhoneNumber: string;
  changeToken: string;
  newPhoneCode: string;
}

export const getAccountPhoneBindingStatus = (
  requestConfig?: AxiosRequestConfig,
): Promise<AccountPhoneBindingStatusResponse> => {
  return api.get('/account/phone-binding/status', requestConfig);
};

export const sendAccountPhoneBindingCode = (
  payload: AccountPhoneBindingSendCodePayload,
  requestConfig?: AxiosRequestConfig,
): Promise<AccountPhoneBindingSendCodeResponse> => {
  return api.post('/account/phone-binding/send-code', payload, requestConfig);
};

export const sendAccountPhoneBindingCurrentCode = (
  payload: AccountPhoneBindingCurrentCodePayload,
  requestConfig?: AxiosRequestConfig,
): Promise<AccountPhoneBindingSendCodeResponse> => {
  return api.post('/account/phone-binding/change/send-current-code', payload, requestConfig);
};

export const sendAccountPhoneBindingNewCode = (
  payload: AccountPhoneBindingChangeNewCodePayload,
  requestConfig?: AxiosRequestConfig,
): Promise<AccountPhoneBindingSendCodeResponse> => {
  return api.post('/account/phone-binding/change/send-new-code', payload, requestConfig);
};

export const bindAccountPhoneNumber = (
  payload: AccountPhoneBindingBindPayload,
  requestConfig?: AxiosRequestConfig,
): Promise<AccountPhoneBindingMutationResponse> => {
  return api.post('/account/phone-binding/bind', payload, requestConfig);
};

export const verifyAccountPhoneBindingCurrent = (
  payload: AccountPhoneBindingVerifyCurrentPayload,
  requestConfig?: AxiosRequestConfig,
): Promise<AccountPhoneBindingVerifyCurrentResponse> => {
  return api.post('/account/phone-binding/change/verify-current', payload, requestConfig);
};

export const changeAccountPhoneBinding = (
  payload: AccountPhoneBindingChangePayload,
  requestConfig?: AxiosRequestConfig,
): Promise<AccountPhoneBindingMutationResponse> => {
  return api.post('/account/phone-binding/change', payload, requestConfig);
};
