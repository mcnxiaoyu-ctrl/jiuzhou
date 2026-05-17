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
import { useCallback } from 'react';

import {
  sendAuthPhoneCode,
  type AuthPhoneCodePurpose,
  type UnifiedCaptchaPayload,
} from '../../../services/api';
import { useCaptchaSmsCodeSender } from '../../shared/useCaptchaSmsCodeSender';
import type { UseCaptchaSmsCodeSenderResult } from '../../shared/useCaptchaSmsCodeSender';

interface UseAuthPhoneCodeOptions {
  purpose: AuthPhoneCodePurpose;
  phoneNumber: string;
  enabled: boolean;
}

export const useAuthPhoneCode = ({
  purpose,
  phoneNumber,
  enabled,
}: UseAuthPhoneCodeOptions): UseCaptchaSmsCodeSenderResult => {
  const normalizedPhoneNumber = phoneNumber.trim();

  const sendCodeRequest = useCallback(
    (captchaPayload: UnifiedCaptchaPayload) => {
      return sendAuthPhoneCode({
        phoneNumber: normalizedPhoneNumber,
        purpose,
        ...captchaPayload,
      });
    },
    [normalizedPhoneNumber, purpose],
  );

  return useCaptchaSmsCodeSender({
    enabled,
    canSend: normalizedPhoneNumber.length > 0,
    missingTargetMessage: '请输入手机号',
    sendCodeRequest,
  });
};
