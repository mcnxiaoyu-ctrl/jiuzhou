/**
 * 鉴权页短信验证码 Hook
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中处理登录、注册、老账号绑定、找回口令四类未登录态短信验证码发送、图片/天御人机验证和倒计时。
 * 2. 做什么：把发码请求、local 图片验证码刷新、腾讯天御弹窗触发收敛到单一 Hook，避免多个表单各自拼请求和维护倒计时。
 * 3. 不做什么：不提交登录/注册/绑定表单，不决定成功后的页面跳转，也不保存短信验证码输入值。
 *
 * 输入/输出：
 * - 输入：发码用途、当前手机号、是否启用。
 * - 输出：发送按钮状态、倒计时、图片验证码状态、图片验证码输入值和发码动作。
 *
 * 数据流/状态流：
 * 表单手机号 -> 本 Hook 读取验证码配置 -> local 模式拉图或腾讯模式弹窗 -> `/auth/phone-code/send` -> 倒计时回写 UI。
 *
 * 复用设计说明：
 * - 多个鉴权表单共享同一发码链路，Hook 保证验证码 provider、冷却倒计时和错误后的刷新策略只有一个入口。
 * - 发码属于高频安全规则变化点，因此用途、手机号和人机验证载荷统一在 Hook 内拼装。
 *
 * 关键边界条件与坑点：
 * 1. local 图片验证码是一次性资源，发码尝试结束后必须清空输入并刷新，避免重复提交已消费的 captchaId。
 * 2. 腾讯天御取消不是业务错误，不应触发接口请求；只有 SDK 异常才在页面内提示。
 */
import { useEffect, useMemo, useState } from 'react';
import { App } from 'antd';

import {
  getCaptcha,
  sendAuthPhoneCode,
  type AuthPhoneCodePurpose,
  type CaptchaChallenge,
  type UnifiedCaptchaPayload,
} from '../../../services/api';
import { useCaptchaChallenge } from '../../shared/useCaptchaChallenge';
import { useCaptchaConfig } from '../../shared/useCaptchaConfig';
import {
  TENCENT_CAPTCHA_CANCELLED_MESSAGE,
  useTencentCaptcha,
} from '../../shared/useTencentCaptcha';

interface UseAuthPhoneCodeOptions {
  purpose: AuthPhoneCodePurpose;
  phoneNumber: string;
  enabled: boolean;
}

interface UseAuthPhoneCodeResult {
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

export const useAuthPhoneCode = ({
  purpose,
  phoneNumber,
  enabled,
}: UseAuthPhoneCodeOptions): UseAuthPhoneCodeResult => {
  const { message } = App.useApp();
  const { config, isTencent, loading: configLoading } = useCaptchaConfig(enabled);
  const [captchaCode, setCaptchaCode] = useState('');
  const [sendingCode, setSendingCode] = useState(false);
  const [countdown, setCountdown] = useState(0);

  const { captcha, loading: captchaLoading, refreshCaptcha } = useCaptchaChallenge({
    enabled: enabled && !isTencent && !configLoading,
    refreshNonce: enabled ? 1 : 0,
    loadCaptcha: getCaptcha,
    fallbackMessage: '图片验证码加载失败',
    onLoadError: (errorMessage) => {
      message.error(errorMessage);
    },
  });

  const { triggerCaptcha } = useTencentCaptcha(config.tencentAppId ?? 0);

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

  const normalizedPhoneNumber = phoneNumber.trim();
  const showLocalCaptchaField = enabled && !configLoading && !isTencent;

  const sendDisabled = useMemo(() => {
    if (sendingCode || countdown > 0 || !normalizedPhoneNumber) {
      return true;
    }
    if (isTencent) {
      return false;
    }
    return captchaLoading || !captcha || captchaCode.trim().length !== 4;
  }, [
    captcha,
    captchaCode,
    captchaLoading,
    countdown,
    isTencent,
    normalizedPhoneNumber,
    sendingCode,
  ]);

  const doSendCode = async (captchaPayload: UnifiedCaptchaPayload): Promise<void> => {
    setSendingCode(true);
    try {
      const response = await sendAuthPhoneCode({
        phoneNumber: normalizedPhoneNumber,
        purpose,
        ...captchaPayload,
      });
      const cooldownSeconds = response.data?.cooldownSeconds;
      if (typeof cooldownSeconds !== 'number') {
        throw new Error('发送验证码响应缺少冷却时间');
      }
      setCountdown(cooldownSeconds);
      message.success('验证码已发送');
    } finally {
      if (!isTencent) {
        setCaptchaCode('');
        await refreshCaptcha();
      }
      setSendingCode(false);
    }
  };

  const sendCode = async (): Promise<void> => {
    if (!normalizedPhoneNumber) {
      message.warning('请输入手机号');
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
  };

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
