import type { AxiosRequestConfig } from 'axios';
import api from './core';
import type { UnifiedCaptchaPayload } from './auth-character';

export interface PhoneBindingStatusDto {
  enabled: boolean;
  isBound: boolean;
  maskedPhoneNumber: string | null;
}

export interface PhoneBindingStatusResponse {
  success: boolean;
  data?: PhoneBindingStatusDto;
}

export interface SendPhoneBindingCodeResponse {
  success: boolean;
  data?: {
    cooldownSeconds: number;
  };
}

export interface BindPhoneNumberResponse {
  success: boolean;
  data?: {
    maskedPhoneNumber: string;
  };
}

export interface ChangeBoundPhoneNumberResponse {
  success: boolean;
  data?: {
    maskedPhoneNumber: string;
  };
}

export interface VerifyCurrentPhoneForChangeResponse {
  success: boolean;
  data?: {
    changeToken: string;
    expiresSeconds: number;
  };
}

export const getPhoneBindingStatus = (
  requestConfig?: AxiosRequestConfig,
): Promise<PhoneBindingStatusResponse> => {
  return api.get('/account/phone-binding/status', requestConfig);
};

export const sendPhoneBindingCode = (
  phoneNumber: string,
  captcha: UnifiedCaptchaPayload,
  requestConfig?: AxiosRequestConfig,
): Promise<SendPhoneBindingCodeResponse> => {
  return api.post(
    '/account/phone-binding/send-code',
    { phoneNumber, ...captcha },
    requestConfig,
  );
};

export const bindPhoneNumber = (
  phoneNumber: string,
  code: string,
  requestConfig?: AxiosRequestConfig,
): Promise<BindPhoneNumberResponse> => {
  return api.post('/account/phone-binding/bind', { phoneNumber, code }, requestConfig);
};

export const sendCurrentPhoneChangeCode = (
  captcha: UnifiedCaptchaPayload,
  requestConfig?: AxiosRequestConfig,
): Promise<SendPhoneBindingCodeResponse> => {
  return api.post('/account/phone-binding/change/send-current-code', captcha, requestConfig);
};

export const sendNewPhoneChangeCode = (
  phoneNumber: string,
  captcha: UnifiedCaptchaPayload,
  requestConfig?: AxiosRequestConfig,
): Promise<SendPhoneBindingCodeResponse> => {
  return api.post(
    '/account/phone-binding/change/send-new-code',
    { phoneNumber, ...captcha },
    requestConfig,
  );
};

export const verifyCurrentPhoneForChange = (
  currentPhoneCode: string,
  requestConfig?: AxiosRequestConfig,
): Promise<VerifyCurrentPhoneForChangeResponse> => {
  return api.post(
    '/account/phone-binding/change/verify-current',
    { currentPhoneCode },
    requestConfig,
  );
};

export const changeBoundPhoneNumber = (
  newPhoneNumber: string,
  changeToken: string,
  newPhoneCode: string,
  requestConfig?: AxiosRequestConfig,
): Promise<ChangeBoundPhoneNumberResponse> => {
  return api.post(
    '/account/phone-binding/change',
    { newPhoneNumber, changeToken, newPhoneCode },
    requestConfig,
  );
};
