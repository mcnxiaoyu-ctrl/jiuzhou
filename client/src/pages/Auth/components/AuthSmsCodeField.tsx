/**
 * 鉴权页手机号短信验证码字段
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一渲染手机号、图片验证码和短信验证码输入区，供手机号登录、注册、老账号绑定和找回口令复用。
 * 2. 做什么：把发码按钮、倒计时、人机验证码输入和短信码输入布局集中管理，避免三个表单复制同一套 JSX。
 * 3. 不做什么：不提交最终登录/注册/绑定请求，不决定注册是否需要道号，也不保存账号密码。
 *
 * 输入/输出：
 * - 输入：Ant Design 表单实例、发码用途、当前模式是否启用。
 * - 输出：写入表单中的 `phoneNumber` 和 `smsCode` 字段，以及内部管理的人机验证码发码动作。
 *
 * 数据流/状态流：
 * 表单 phoneNumber 字段 -> `useAuthPhoneCode` -> 发码接口 -> 倒计时状态留在本组件 -> smsCode 字段交给父表单提交。
 *
 * 复用设计说明：
 * - 多种鉴权模式都要求手机号和短信码，只是最终提交接口不同，因此字段组件化可消除重复布局和禁用态判断。
 * - 人机验证码是发码前置条件，属于高频安全策略变化点，放在这里能让所有鉴权入口同步生效。
 *
 * 关键边界条件与坑点：
 * 1. 图片验证码输入不进入最终业务提交，只作为发送短信前的人机验证载荷，避免注册/登录接口重复消费验证码。
 * 2. 组件可能在模式切换时卸载，Hook 会清理倒计时和验证码输入，避免不同模式互相污染。
 */
import type { FormInstance } from 'antd';
import { Button, Form, Input } from 'antd';
import { MobileOutlined, MessageOutlined } from '@ant-design/icons';

import type { AuthPhoneCodePurpose } from '../../../services/api';
import CaptchaChallengeInput from '../../shared/CaptchaChallengeInput';
import { useAuthPhoneCode } from '../hooks/useAuthPhoneCode';

export interface AuthSmsCodeFormValues {
  phoneNumber?: string;
  smsCode?: string;
}

interface AuthSmsCodeFieldProps<FormValues extends AuthSmsCodeFormValues> {
  form: FormInstance<FormValues>;
  purpose: AuthPhoneCodePurpose;
  enabled: boolean;
}

const AuthSmsCodeField = <FormValues extends AuthSmsCodeFormValues,>({
  form,
  purpose,
  enabled,
}: AuthSmsCodeFieldProps<FormValues>) => {
  const phoneNumber = Form.useWatch('phoneNumber', form) ?? '';
  const {
    captchaCode,
    setCaptchaCode,
    captcha,
    captchaLoading,
    showLocalCaptchaField,
    sendingCode,
    sendDisabled,
    sendButtonLabel,
    refreshCaptcha,
    sendCode,
  } = useAuthPhoneCode({
    purpose,
    phoneNumber,
    enabled,
  });

  return (
    <>
      <Form.Item
        name="phoneNumber"
        rules={[{ required: true, message: '请输入手机号' }]}
      >
        <Input
          prefix={<MobileOutlined />}
          placeholder="大陆手机号"
          inputMode="numeric"
          maxLength={20}
          autoComplete="tel"
        />
      </Form.Item>

      {showLocalCaptchaField && (
        <div className="auth-sms-captcha">
          <CaptchaChallengeInput
            value={captchaCode}
            captcha={captcha}
            loading={captchaLoading}
            disabled={sendingCode}
            inputPlaceholder="图片验证码"
            imageAlt="短信图片验证码"
            refreshAriaLabel="刷新短信图片验证码"
            onChange={setCaptchaCode}
            onRefresh={() => { void refreshCaptcha(); }}
          />
        </div>
      )}

      <Form.Item
        name="smsCode"
        rules={[
          { required: true, message: '请输入短信验证码' },
          { len: 6, message: '请输入 6 位验证码' },
        ]}
      >
        <Input
          className="auth-sms-code-input"
          prefix={<MessageOutlined />}
          placeholder="短信验证码"
          inputMode="numeric"
          maxLength={6}
          autoComplete="one-time-code"
          addonAfter={(
            <Button
              className="auth-sms-code-row__button"
              htmlType="button"
              loading={sendingCode}
              disabled={sendDisabled}
              onClick={() => { void sendCode(); }}
            >
              {sendButtonLabel}
            </Button>
          )}
        />
      </Form.Item>
    </>
  );
};

export default AuthSmsCodeField;
