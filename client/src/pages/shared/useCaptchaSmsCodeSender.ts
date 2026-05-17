/**
 * 人机验证码短信发码 Hook
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一处理短信发码前的人机验证码、发送中状态、冷却倒计时和 local 验证码刷新。
 * 2. 做什么：让鉴权页和游戏内账号安全页共用同一条发码状态流，避免两个入口各自复制验证码 provider 判断。
 * 3. 不做什么：不渲染表单 UI，不提交最终业务表单，也不决定接口失败时是否由页面弹 toast。
 *
 * 输入/输出：
 * - 输入：是否启用、当前业务目标是否可发送、缺失目标提示、发码请求函数和提示文案。
 * - 输出：图片验证码状态、短信发码状态、倒计时、按钮禁用态和发码动作。
 *
 * 数据流/状态流：
 * 业务表单字段 -> 调用方计算 `canSend` -> 本 Hook 读取验证码配置 -> local 拉图或天御弹窗 -> 调用方传入的发码请求 -> 倒计时回写 UI。
 *
 * 复用设计说明：
 * - 验证码 provider、倒计时和刷新策略属于高频安全策略变化点，集中到这里后登录、注册、绑定、换绑都只维护一个入口。
 * - 调用方只提供“如何发码”的函数，Hook 不关心业务场景，从而避免账号安全页重复拼装鉴权页已有的验证码状态机。
 *
 * 关键边界条件与坑点：
 * 1. local 图片验证码是一次性资源，发码尝试结束后必须清空输入并刷新，避免复用已消费的 captchaId。
 * 2. 天御用户取消不是业务失败，不应继续发请求；只有 SDK 或服务端错误才交由页面或自动 toast 处理。
 */
import { App } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  getCaptcha,
  type CaptchaChallenge,
  type UnifiedCaptchaPayload,
} from '../../services/api';
import { useCaptchaChallenge } from './useCaptchaChallenge';
import { useCaptchaConfig } from './useCaptchaConfig';
import {
  TENCENT_CAPTCHA_CANCELLED_MESSAGE,
  useTencentCaptcha,
} from './useTencentCaptcha';

export interface CaptchaSmsCodeSenderResponse {
  success: boolean;
  data?: {
    cooldownSeconds: number;
  };
}

interface UseCaptchaSmsCodeSenderOptions {
  enabled: boolean;
  canSend: boolean;
  missingTargetMessage: string;
  sendCodeRequest: (captchaPayload: UnifiedCaptchaPayload) => Promise<CaptchaSmsCodeSenderResponse>;
  loadCaptchaFallbackMessage?: string;
  sentMessage?: string;
}

export interface UseCaptchaSmsCodeSenderResult {
  captchaCode: string;
  setCaptchaCode: (value: string) => void;
  captcha: CaptchaChallenge | null;
  captchaLoading: boolean;
  showLocalCaptchaField: boolean;
  sendingCode: boolean;
  countdown: number;
  sendDisabled: boolean;
  sendButtonLabel: string;
  refreshCaptcha: () => Promise<void>;
  sendCode: () => Promise<void>;
}

export const useCaptchaSmsCodeSender = ({
  enabled,
  canSend,
  missingTargetMessage,
  sendCodeRequest,
  loadCaptchaFallbackMessage = '图片验证码加载失败',
  sentMessage = '验证码已发送',
}: UseCaptchaSmsCodeSenderOptions): UseCaptchaSmsCodeSenderResult => {
  const { message } = App.useApp();
  const { config, isTencent, loading: configLoading } = useCaptchaConfig(enabled);
  const [captchaCode, setCaptchaCode] = useState('');
  const [sendingCode, setSendingCode] = useState(false);
  const [countdown, setCountdown] = useState(0);

  const { captcha, loading: captchaLoading, refreshCaptcha } = useCaptchaChallenge({
    enabled: enabled && !isTencent && !configLoading,
    refreshNonce: enabled ? 1 : 0,
    loadCaptcha: getCaptcha,
    fallbackMessage: loadCaptchaFallbackMessage,
    onLoadError: (errorMessage) => {
      message.error(errorMessage);
    },
  });

  const { triggerCaptcha, sdkLoading } = useTencentCaptcha(config.tencentAppId ?? 0);

  useEffect(() => {
    if (!enabled) {
      setCaptchaCode('');
      setSendingCode(false);
      setCountdown(0);
    }
  }, [enabled]);

  useEffect(() => {
    if (countdown <= 0) return undefined;
    const timer = window.setTimeout(() => {
      setCountdown((current) => (current > 0 ? current - 1 : 0));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [countdown]);

  const showLocalCaptchaField = enabled && !configLoading && !isTencent;

  const sendDisabled = useMemo(() => {
    if (sendingCode || sdkLoading || countdown > 0 || !canSend) {
      return true;
    }
    if (isTencent) {
      return false;
    }
    return captchaLoading || !captcha || captchaCode.trim().length !== 4;
  }, [
    canSend,
    captcha,
    captchaCode,
    captchaLoading,
    countdown,
    isTencent,
    sdkLoading,
    sendingCode,
  ]);

  const doSendCode = useCallback(async (captchaPayload: UnifiedCaptchaPayload): Promise<void> => {
    setSendingCode(true);
    try {
      const response = await sendCodeRequest(captchaPayload);
      const cooldownSeconds = response.data?.cooldownSeconds;
      if (typeof cooldownSeconds !== 'number') {
        throw new Error('发送验证码响应缺少冷却时间');
      }
      setCountdown(cooldownSeconds);
      message.success(sentMessage);
    } finally {
      if (!isTencent) {
        setCaptchaCode('');
        await refreshCaptcha();
      }
      setSendingCode(false);
    }
  }, [isTencent, message, refreshCaptcha, sendCodeRequest, sentMessage]);

  const sendCode = useCallback(async (): Promise<void> => {
    if (!canSend) {
      message.warning(missingTargetMessage);
      return;
    }

    if (isTencent) {
      const ticket = await triggerCaptcha().catch((error: Error) => {
        if (error.message !== TENCENT_CAPTCHA_CANCELLED_MESSAGE) {
          message.error(error.message || '验证码校验失败');
        }
        return null;
      });
      if (!ticket) {
        return;
      }
      await doSendCode({ ticket: ticket.ticket, randstr: ticket.randstr });
      return;
    }

    if (!captcha) {
      message.warning('图片验证码加载中，请稍后重试');
      return;
    }

    if (captchaCode.trim().length !== 4) {
      message.warning('请输入图片验证码');
      return;
    }

    await doSendCode({ captchaId: captcha.captchaId, captchaCode });
  }, [
    canSend,
    captcha,
    captchaCode,
    doSendCode,
    isTencent,
    message,
    missingTargetMessage,
    triggerCaptcha,
  ]);

  return {
    captchaCode,
    setCaptchaCode,
    captcha,
    captchaLoading,
    showLocalCaptchaField,
    sendingCode,
    countdown,
    sendDisabled,
    sendButtonLabel: countdown > 0 ? `${countdown}s` : '发送验证码',
    refreshCaptcha,
    sendCode,
  };
};
