/**
 * 设置页手机号短信验证码字段
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一渲染账号安全页里的图片验证码和短信验证码输入行。
 * 2. 做什么：把发码按钮、倒计时、图片验证码刷新与短信码表单规则集中封装，供首次绑定、验证原手机号、新手机号验证复用。
 * 3. 不做什么：不读取手机号、不选择发码接口，也不提交最终绑定/换绑请求。
 *
 * 输入/输出：
 * - 输入：表单字段名、文案、禁用态，以及 `useSettingPhoneCode` 返回的验证码状态。
 * - 输出：Ant Design 表单项，短信验证码写入调用方指定字段。
 *
 * 数据流/状态流：
 * 父组件维护手机号和发码请求 -> 本组件触发 `phoneCode.sendCode` -> 短信验证码输入值进入父表单 -> 父表单提交业务接口。
 *
 * 复用设计说明：
 * - 三个账号安全场景的验证码 UI 完全一致，组件化后只保留字段名和文案差异，避免 JSX 重复。
 * - 图片验证码组件继续复用共享 `CaptchaChallengeInput`，保证验证码归一化和刷新交互与鉴权页一致。
 *
 * 关键边界条件与坑点：
 * 1. 图片验证码只用于发短信，不进入最终绑定/换绑提交，避免重复消费一次性 captchaId。
 * 2. 发码按钮必须同时受表单禁用态与发码 Hook 禁用态控制，避免提交中重复发送短信。
 */
import { MessageOutlined } from '@ant-design/icons';
import { Button, Form, Input } from 'antd';

import CaptchaChallengeInput from '../../../shared/CaptchaChallengeInput';
import type { UseSettingPhoneCodeResult } from './useSettingPhoneCode';

interface PhoneBindingSmsCodeFieldProps {
  phoneCode: UseSettingPhoneCodeResult;
  name: string;
  label: string;
  placeholder: string;
  disabled?: boolean;
}

export default function PhoneBindingSmsCodeField({
  phoneCode,
  name,
  label,
  placeholder,
  disabled = false,
}: PhoneBindingSmsCodeFieldProps) {
  const fieldDisabled = disabled || phoneCode.sendingCode;

  return (
    <>
      {phoneCode.showLocalCaptchaField ? (
        <div className="setting-phone-captcha">
          <CaptchaChallengeInput
            value={phoneCode.captchaCode}
            captcha={phoneCode.captcha}
            loading={phoneCode.captchaLoading}
            disabled={fieldDisabled}
            inputPlaceholder="图片验证码"
            imageAlt="手机号短信图片验证码"
            refreshAriaLabel="刷新手机号短信图片验证码"
            onChange={phoneCode.setCaptchaCode}
            onRefresh={() => { void phoneCode.refreshCaptcha(); }}
          />
        </div>
      ) : null}

      <Form.Item
        label={label}
        name={name}
        rules={[
          { required: true, message: `请输入${label}` },
          { len: 6, message: '请输入 6 位验证码' },
        ]}
      >
        <Input
          className="setting-phone-code-input"
          prefix={<MessageOutlined />}
          placeholder={placeholder}
          inputMode="numeric"
          maxLength={6}
          autoComplete="one-time-code"
          disabled={disabled}
          addonAfter={(
            <Button
              htmlType="button"
              loading={phoneCode.sendingCode}
              disabled={disabled || phoneCode.sendDisabled}
              onClick={() => { void phoneCode.sendCode(); }}
            >
              {phoneCode.sendButtonLabel}
            </Button>
          )}
        />
      </Form.Item>
    </>
  );
}
