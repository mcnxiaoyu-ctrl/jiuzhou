/**
 * 手机号绑定 / 换绑弹窗（支持 local 图片验证码和天御验证码双模式）
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一承接手机号绑定与更换绑定交互，供玩家信息入口和坊市拦截复用。
 * 2. 做什么：根据 captchaConfig.provider 自动切换图片验证码或天御弹窗模式，绑定/换绑成功后统一失效手机号状态缓存。
 * 3. 不做什么：不读取手机号绑定状态，也不决定哪个业务场景必须弹出本弹窗。
 *
 * 输入/输出：
 * - 输入：弹窗开关、关闭回调、成功回调、模式、当前脱敏手机号以及场景化文案。
 * - 输出：手机号绑定或换绑交互 UI；成功后触发 `onSuccess`。
 *
 * 数据流/状态流：
 * - local 模式：打开弹窗 -> 拉取图片验证码 -> 输入手机号与图片验证码 -> 发送短信验证码 -> 输入短信验证码 -> 提交绑定
 * - 换绑模式：打开弹窗 -> 发送并验证原手机号验证码 -> 获得短期换绑凭证 -> 输入新手机号并验证短信 -> 提交换绑
 * - tencent 模式：打开弹窗 -> 输入手机号 -> 点击发送验证码时触发天御弹窗 -> 天御通过后发送短信验证码 -> 输入短信验证码 -> 提交绑定
 *
 * 关键边界条件与坑点：
 * 1. local 模式下图片验证码是服务端一次性消费资源，每次发送尝试后都必须刷新。
 * 2. 换绑必须先完成原手机号验证并取得短期凭证，第二步才能绑定新手机号；不能把两个验证码混在同一步提交里。
 * 3. tencent 模式下天御验证码在"发送短信验证码"按钮点击时触发，不需要图片验证码输入框。
 */
import { App, Button, Input, Modal } from 'antd';
import { MobileOutlined, MessageOutlined } from '@ant-design/icons';
import { useEffect, useMemo, useState } from 'react';
import {
  bindPhoneNumber,
  changeBoundPhoneNumber,
  getCaptcha,
  notifyUnifiedApiError,
  SILENT_API_REQUEST_CONFIG,
  sendCurrentPhoneChangeCode,
  sendNewPhoneChangeCode,
  sendPhoneBindingCode,
  verifyCurrentPhoneForChange,
} from '../../../services/api';
import type { UnifiedCaptchaPayload } from '../../../services/api/auth-character';
import CaptchaChallengeInput from '../../shared/CaptchaChallengeInput';
import { useCaptchaChallenge } from '../../shared/useCaptchaChallenge';
import { useCaptchaConfig } from '../../shared/useCaptchaConfig';
import {
  isTencentCaptchaCancelledError,
  useTencentCaptcha,
} from '../../shared/useTencentCaptcha';
import { invalidatePhoneBindingStatus } from './usePhoneBindingStatus';
import './PhoneBindingDialog.scss';

interface PhoneBindingDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void | Promise<void>;
  mode?: 'bind' | 'change';
  maskedCurrentPhoneNumber?: string | null;
  title?: string;
  description?: string;
}

type PhoneBindingCodeTarget = 'bind' | 'change-current' | 'change-new';
type PhoneBindingChangeStep = 'verify-current' | 'bind-new';

const PhoneBindingDialog: React.FC<PhoneBindingDialogProps> = ({
  open,
  onClose,
  onSuccess,
  mode = 'bind',
  maskedCurrentPhoneNumber = null,
  title,
  description,
}) => {
  const { message } = App.useApp();
  const { config, isTencent, loading: configLoading } = useCaptchaConfig(open);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [currentVerificationCode, setCurrentVerificationCode] = useState('');
  const [captchaCode, setCaptchaCode] = useState('');
  const [sendingTarget, setSendingTarget] = useState<PhoneBindingCodeTarget | null>(null);
  const [binding, setBinding] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [currentCountdown, setCurrentCountdown] = useState(0);
  const [changeStep, setChangeStep] = useState<PhoneBindingChangeStep>('verify-current');
  const [changeToken, setChangeToken] = useState('');

  const { captcha, loading: captchaLoading, refreshCaptcha } = useCaptchaChallenge({
    enabled: open && !isTencent && !configLoading,
    refreshNonce: open ? 1 : 0,
    loadCaptcha: getCaptcha,
    fallbackMessage: '图片验证码加载失败',
    onLoadError: (errorMessage) => {
      message.error(errorMessage);
    },
  });

  const { triggerCaptcha } = useTencentCaptcha(config.tencentAppId ?? 0);

  useEffect(() => {
    if (!open) {
      setVerificationCode('');
      setCurrentVerificationCode('');
      setCaptchaCode('');
      setSendingTarget(null);
      setBinding(false);
      setCountdown(0);
      setCurrentCountdown(0);
      setChangeStep('verify-current');
      setChangeToken('');
    }
  }, [open]);

  useEffect(() => {
    if (countdown <= 0) return undefined;
    const timer = window.setTimeout(() => {
      setCountdown((current) => (current > 0 ? current - 1 : 0));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [countdown]);

  useEffect(() => {
    if (currentCountdown <= 0) return undefined;
    const timer = window.setTimeout(() => {
      setCurrentCountdown((current) => (current > 0 ? current - 1 : 0));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [currentCountdown]);

  const sendingCode = sendingTarget !== null;

  const sendCodeDisabledLocal = useMemo(() => {
    return (
      sendingCode
      || binding
      || countdown > 0
      || captchaLoading
      || !captcha
      || !phoneNumber.trim()
      || captchaCode.trim().length !== 4
    );
  }, [binding, captcha, captchaCode, captchaLoading, countdown, phoneNumber, sendingCode]);

  const sendCodeDisabledTencent = useMemo(() => {
    return sendingCode || binding || countdown > 0 || !phoneNumber.trim();
  }, [binding, countdown, phoneNumber, sendingCode]);

  const currentSendCodeDisabledLocal = useMemo(() => {
    return (
      sendingCode
      || binding
      || currentCountdown > 0
      || captchaLoading
      || !captcha
      || captchaCode.trim().length !== 4
    );
  }, [binding, captcha, captchaCode, captchaLoading, currentCountdown, sendingCode]);

  const currentSendCodeDisabledTencent = useMemo(() => {
    return sendingCode || binding || currentCountdown > 0;
  }, [binding, currentCountdown, sendingCode]);

  const confirmDisabled = useMemo(() => {
    if (mode === 'change') {
      if (changeStep === 'verify-current') {
        return binding || sendingCode || !currentVerificationCode.trim();
      }
      return (
        binding
        || sendingCode
        || !changeToken
        || !phoneNumber.trim()
        || !verificationCode.trim()
      );
    }
    return binding || sendingCode || !phoneNumber.trim() || !verificationCode.trim();
  }, [
    binding,
    changeStep,
    changeToken,
    currentVerificationCode,
    mode,
    phoneNumber,
    sendingCode,
    verificationCode,
  ]);
  const showLocalCaptchaField = !configLoading && !isTencent;
  const resolvedTitle = title ?? (mode === 'change' ? '更换绑定手机号' : '绑定手机号');
  const resolvedDescription = description ?? (
    mode === 'change'
      ? changeStep === 'verify-current'
        ? '第一步先验证当前绑定手机号。验证通过后，再填写新手机号并完成绑定。'
        : '当前手机号已验证，请填写新手机号并完成短信验证。每个手机号只能绑定一个账号。'
      : '绑定手机号后，可继续使用坊市相关功能。每个手机号只能绑定一个账号，请务必填写真实手机号，后续可能会进行随机安全验证。'
  );

  const doSendCode = async (
    target: PhoneBindingCodeTarget,
    captchaPayload: UnifiedCaptchaPayload,
  ): Promise<void> => {
    setSendingTarget(target);
    try {
      const response = target === 'change-current'
        ? await sendCurrentPhoneChangeCode(captchaPayload, SILENT_API_REQUEST_CONFIG)
        : target === 'change-new'
          ? await sendNewPhoneChangeCode(phoneNumber.trim(), captchaPayload, SILENT_API_REQUEST_CONFIG)
          : await sendPhoneBindingCode(phoneNumber.trim(), captchaPayload, SILENT_API_REQUEST_CONFIG);
      const cooldownSeconds = response.data?.cooldownSeconds;
      if (typeof cooldownSeconds !== 'number') {
        throw new Error('发送验证码响应缺少冷却时间');
      }
      if (target === 'change-current') {
        setCurrentCountdown(cooldownSeconds);
      } else {
        setCountdown(cooldownSeconds);
      }
      message.success('验证码已发送');
    } catch (error) {
      notifyUnifiedApiError(message, error, '发送验证码失败');
    } finally {
      if (!isTencent) {
        setCaptchaCode('');
        await refreshCaptcha();
      }
      setSendingTarget(null);
    }
  };

  const handleSendCodeLocal = async (target: PhoneBindingCodeTarget): Promise<void> => {
    if (target !== 'change-current' && !phoneNumber.trim()) {
      message.warning('请输入手机号');
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
    await doSendCode(target, { captchaId: captcha.captchaId, captchaCode });
  };

  const handleSendCodeTencent = async (target: PhoneBindingCodeTarget): Promise<void> => {
    if (target !== 'change-current' && !phoneNumber.trim()) {
      message.warning('请输入手机号');
      return;
    }
    try {
      const ticket = await triggerCaptcha();
      await doSendCode(target, { ticket: ticket.ticket, randstr: ticket.randstr });
    } catch (error) {
      if (!isTencentCaptchaCancelledError(error)) {
        message.error(error instanceof Error ? error.message : '验证码校验失败');
      }
    }
  };

  const handleBindPhoneNumber = async (): Promise<void> => {
    if (!phoneNumber.trim()) {
      message.warning('请输入手机号');
      return;
    }
    if (!verificationCode.trim()) {
      message.warning('请输入验证码');
      return;
    }

    setBinding(true);
    try {
      await bindPhoneNumber(phoneNumber.trim(), verificationCode.trim(), SILENT_API_REQUEST_CONFIG);
      invalidatePhoneBindingStatus();
      message.success('手机号绑定成功');
      await onSuccess?.();
      onClose();
    } catch (error) {
      notifyUnifiedApiError(message, error, '手机号绑定失败');
    } finally {
      setBinding(false);
    }
  };

  const handleVerifyCurrentPhone = async (): Promise<void> => {
    if (!currentVerificationCode.trim()) {
      message.warning('请输入原手机号验证码');
      return;
    }

    setBinding(true);
    try {
      const response = await verifyCurrentPhoneForChange(
        currentVerificationCode.trim(),
        SILENT_API_REQUEST_CONFIG,
      );
      const nextToken = response.data?.changeToken;
      if (!nextToken) {
        throw new Error('原手机号验证响应缺少换绑凭证');
      }
      setChangeToken(nextToken);
      setChangeStep('bind-new');
      setPhoneNumber('');
      setVerificationCode('');
      setCountdown(0);
      message.success('原手机号验证通过');
    } catch (error) {
      notifyUnifiedApiError(message, error, '原手机号验证失败');
    } finally {
      setBinding(false);
    }
  };

  const handleChangePhoneNumber = async (): Promise<void> => {
    if (!changeToken) {
      message.warning('请先完成原手机号验证');
      return;
    }
    if (!phoneNumber.trim()) {
      message.warning('请输入新手机号');
      return;
    }
    if (!verificationCode.trim()) {
      message.warning('请输入新手机号验证码');
      return;
    }

    setBinding(true);
    try {
      await changeBoundPhoneNumber(
        phoneNumber.trim(),
        changeToken,
        verificationCode.trim(),
        SILENT_API_REQUEST_CONFIG,
      );
      invalidatePhoneBindingStatus();
      message.success('手机号更换成功');
      await onSuccess?.();
      onClose();
    } catch (error) {
      notifyUnifiedApiError(message, error, '手机号更换失败');
    } finally {
      setBinding(false);
    }
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      title={null}
      closable
      destroyOnHidden
      centered
      width={420}
      className="phone-binding-dialog"
    >
      <div className="phone-binding">
        <div className="phone-binding__header">
          <h3 className="phone-binding__title">{resolvedTitle}</h3>
          <div className="phone-binding__hint">{resolvedDescription}</div>
        </div>

        <div className="phone-binding__form">
          {mode === 'change' && maskedCurrentPhoneNumber ? (
            <div className="phone-binding__current-phone">
              当前绑定：{maskedCurrentPhoneNumber}
            </div>
          ) : null}

          {mode !== 'change' || changeStep === 'bind-new' ? (
            <div className="phone-binding__field">
              <span className="phone-binding__label">{mode === 'change' ? '新手机号' : '手机号'}</span>
              <Input
                value={phoneNumber}
                onChange={(event) => setPhoneNumber(event.target.value)}
                placeholder="请输入大陆手机号"
                prefix={<MobileOutlined />}
                inputMode="numeric"
                maxLength={20}
                disabled={binding}
              />
            </div>
          ) : null}

          {showLocalCaptchaField && (
            <div className="phone-binding__field">
              <span className="phone-binding__label">图片验证码</span>
              <CaptchaChallengeInput
                value={captchaCode}
                captcha={captcha}
                loading={captchaLoading}
                disabled={binding || sendingCode}
                inputPlaceholder="请输入图片验证码"
                imageAlt="手机号绑定图片验证码"
                refreshAriaLabel="刷新手机号绑定图片验证码"
                onChange={setCaptchaCode}
                onRefresh={() => { void refreshCaptcha(); }}
              />
            </div>
          )}

          {mode === 'change' && changeStep === 'verify-current' ? (
            <div className="phone-binding__field">
              <span className="phone-binding__label">原手机号验证码</span>
              <div className="phone-binding__code-row">
                <Input
                  value={currentVerificationCode}
                  onChange={(event) => setCurrentVerificationCode(event.target.value)}
                  placeholder="请输入 6 位验证码"
                  prefix={<MessageOutlined />}
                  inputMode="numeric"
                  maxLength={6}
                  disabled={binding}
                />
                <Button
                  className="phone-binding__send-btn"
                  onClick={() => {
                    void (isTencent
                      ? handleSendCodeTencent('change-current')
                      : handleSendCodeLocal('change-current'));
                  }}
                  loading={sendingTarget === 'change-current'}
                  disabled={isTencent ? currentSendCodeDisabledTencent : currentSendCodeDisabledLocal}
                >
                  {currentCountdown > 0 ? `${currentCountdown}s` : '发送验证码'}
                </Button>
              </div>
            </div>
          ) : null}

          {mode !== 'change' || changeStep === 'bind-new' ? (
            <div className="phone-binding__field">
              <span className="phone-binding__label">{mode === 'change' ? '新手机号验证码' : '短信验证码'}</span>
              <div className="phone-binding__code-row">
                <Input
                  value={verificationCode}
                  onChange={(event) => setVerificationCode(event.target.value)}
                  placeholder="请输入 6 位验证码"
                  prefix={<MessageOutlined />}
                  inputMode="numeric"
                  maxLength={6}
                  disabled={binding}
                />
                <Button
                  className="phone-binding__send-btn"
                  onClick={() => {
                    void (isTencent
                      ? handleSendCodeTencent(mode === 'change' ? 'change-new' : 'bind')
                      : handleSendCodeLocal(mode === 'change' ? 'change-new' : 'bind'));
                  }}
                  loading={sendingTarget === 'bind' || sendingTarget === 'change-new'}
                  disabled={isTencent ? sendCodeDisabledTencent : sendCodeDisabledLocal}
                >
                  {countdown > 0 ? `${countdown}s` : '发送验证码'}
                </Button>
              </div>
            </div>
          ) : null}
        </div>

        <div className="phone-binding__actions">
          <Button
            disabled={binding || sendingCode}
            onClick={onClose}
          >
            取消
          </Button>
          <Button
            type="primary"
            loading={binding}
            disabled={confirmDisabled}
            onClick={() => {
              void (mode === 'change'
                ? changeStep === 'verify-current'
                  ? handleVerifyCurrentPhone()
                  : handleChangePhoneNumber()
                : handleBindPhoneNumber());
            }}
          >
            {mode === 'change'
              ? changeStep === 'verify-current'
                ? '下一步'
                : '确认更换'
              : '确认绑定'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default PhoneBindingDialog;
