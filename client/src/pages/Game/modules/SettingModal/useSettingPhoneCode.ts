/**
 * 设置页手机号短信发码 Hook
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：把游戏内账号安全页的短信发码接入共享人机验证码状态机，并统一处理静默请求失败提示。
 * 2. 做什么：让首次绑定、验证原手机号、新手机号发码都复用同一套按钮禁用、倒计时和验证码刷新逻辑。
 * 3. 不做什么：不渲染验证码字段，不提交绑定/换绑表单，也不缓存手机号绑定状态。
 *
 * 输入/输出：
 * - 输入：启用状态、是否满足发码条件、缺失目标提示、实际发码请求和失败兜底文案。
 * - 输出：验证码 UI 状态、发送按钮状态和已包裹统一错误提示的发码动作。
 *
 * 数据流/状态流：
 * 账号安全表单字段 -> 调用方构造发码请求 -> 共享 Hook 处理验证码与倒计时 -> 本 Hook 捕获静默接口错误并单点提示。
 *
 * 复用设计说明：
 * - 与鉴权页共用 `useCaptchaSmsCodeSender`，避免设置页复制 provider、倒计时、local 刷新和天御取消处理。
 * - 设置页三种发码场景只替换请求函数，错误提示和验证码状态流保持一个入口。
 *
 * 关键边界条件与坑点：
 * 1. 设置页发码接口使用静默请求配置，失败必须在这里集中提示，避免拦截器和页面重复弹 toast。
 * 2. 本 Hook 不吞掉验证码取消流程；天御取消已由共享 Hook 处理，不会继续触发账号接口。
 */
import { App } from 'antd';
import { useCallback } from 'react';

import {
  notifyUnifiedApiError,
  type UnifiedCaptchaPayload,
} from '../../../../services/api';
import {
  useCaptchaSmsCodeSender,
  type CaptchaSmsCodeSenderResponse,
  type UseCaptchaSmsCodeSenderResult,
} from '../../../shared/useCaptchaSmsCodeSender';

interface UseSettingPhoneCodeOptions {
  enabled: boolean;
  canSend: boolean;
  missingTargetMessage: string;
  sendCodeRequest: (captchaPayload: UnifiedCaptchaPayload) => Promise<CaptchaSmsCodeSenderResponse>;
  fallbackMessage: string;
}

export interface UseSettingPhoneCodeResult extends Omit<UseCaptchaSmsCodeSenderResult, 'sendCode'> {
  sendCode: () => Promise<void>;
}

export const useSettingPhoneCode = ({
  enabled,
  canSend,
  missingTargetMessage,
  sendCodeRequest,
  fallbackMessage,
}: UseSettingPhoneCodeOptions): UseSettingPhoneCodeResult => {
  const { message } = App.useApp();
  const sender = useCaptchaSmsCodeSender({
    enabled,
    canSend,
    missingTargetMessage,
    sendCodeRequest,
  });
  const baseSendCode = sender.sendCode;

  const sendCode = useCallback((): Promise<void> => {
    return baseSendCode().catch((error: Error) => {
      notifyUnifiedApiError(message, error, fallbackMessage);
    });
  }, [baseSendCode, fallbackMessage, message]);

  return {
    ...sender,
    sendCode,
  };
};
