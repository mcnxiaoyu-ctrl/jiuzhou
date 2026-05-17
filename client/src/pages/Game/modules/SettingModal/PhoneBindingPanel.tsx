/**
 * 游戏内账号安全手机号面板
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：在设置页账号安全中按账号状态展示首次绑定或两步式手机号换绑流程。
 * 2. 做什么：集中读取绑定状态、驱动短信发码、提交绑定/换绑，并在成功后刷新脱敏手机号。
 * 3. 不做什么：不恢复聊天/坊市等游戏内手机号守卫，不修改登录页找回口令，也不新增服务端接口。
 *
 * 输入/输出：
 * - 输入：`enabled`，控制账号安全面板是否需要拉取绑定状态和启用验证码链路。
 * - 输出：账号安全 UI；成功绑定或换绑后只更新本组件内的绑定状态与表单状态。
 *
 * 数据流/状态流：
 * 面板启用 -> 拉取 `/account/phone-binding/status` -> 根据 `isBound` 选择首次绑定或换绑表单 ->
 * 发码 Hook 处理人机验证码与倒计时 -> 业务提交接口返回最新脱敏手机号 -> 本组件刷新状态。
 *
 * 复用设计说明：
 * - 三个发码场景复用 `useSettingPhoneCode` 与 `PhoneBindingSmsCodeField`，避免页面内重复维护验证码按钮和倒计时。
 * - 账号手机号接口集中来自 `accountPhoneBinding.ts`，页面只保留状态编排，不散落接口路径和请求载荷结构。
 *
 * 关键边界条件与坑点：
 * 1. 未绑定账号只能走首次绑定；已绑定账号必须先拿到 `changeToken` 才能发送新手机号验证码并提交换绑。
 * 2. 绑定状态是最终展示真值，提交成功后立即用服务端返回的脱敏手机号更新状态，并清空旧表单和换绑凭证。
 */
import { MobileOutlined } from '@ant-design/icons';
import { App, Button, Form, Input, Skeleton, Space, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';

import {
  bindAccountPhoneNumber,
  changeAccountPhoneBinding,
  getAccountPhoneBindingStatus,
  notifyUnifiedApiError,
  sendAccountPhoneBindingCode,
  sendAccountPhoneBindingCurrentCode,
  sendAccountPhoneBindingNewCode,
  SILENT_API_REQUEST_CONFIG,
  verifyAccountPhoneBindingCurrent,
  type AccountPhoneBindingStatus,
  type UnifiedCaptchaPayload,
} from '../../../../services/api';
import PhoneBindingSmsCodeField from './PhoneBindingSmsCodeField';
import { useSettingPhoneCode } from './useSettingPhoneCode';

interface PhoneBindingPanelProps {
  enabled: boolean;
}

interface FirstBindFormValues {
  phoneNumber?: string;
  smsCode?: string;
}

interface VerifyCurrentFormValues {
  currentPhoneCode?: string;
}

interface ChangePhoneFormValues {
  newPhoneNumber?: string;
  newPhoneCode?: string;
}

const formatChangeTokenExpiresText = (expiresSeconds: number): string => {
  const minutes = Math.max(1, Math.ceil(expiresSeconds / 60));
  return `${minutes} 分钟内完成新手机号验证`;
};

export default function PhoneBindingPanel({ enabled }: PhoneBindingPanelProps) {
  const { message } = App.useApp();
  const [bindForm] = Form.useForm<FirstBindFormValues>();
  const [verifyCurrentForm] = Form.useForm<VerifyCurrentFormValues>();
  const [changePhoneForm] = Form.useForm<ChangePhoneFormValues>();
  const [status, setStatus] = useState<AccountPhoneBindingStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [binding, setBinding] = useState(false);
  const [verifyingCurrent, setVerifyingCurrent] = useState(false);
  const [changingPhone, setChangingPhone] = useState(false);
  const [changeToken, setChangeToken] = useState('');
  const [changeTokenExpiresSeconds, setChangeTokenExpiresSeconds] = useState(0);

  const bindPhoneNumber = Form.useWatch('phoneNumber', bindForm) ?? '';
  const newPhoneNumber = Form.useWatch('newPhoneNumber', changePhoneForm) ?? '';
  const normalizedBindPhoneNumber = bindPhoneNumber.trim();
  const normalizedNewPhoneNumber = newPhoneNumber.trim();
  const featureEnabled = Boolean(status?.enabled);
  const isBound = Boolean(status?.isBound);

  const resetPhoneBindingForms = useCallback((): void => {
    bindForm.resetFields();
    verifyCurrentForm.resetFields();
    changePhoneForm.resetFields();
    setChangeToken('');
    setChangeTokenExpiresSeconds(0);
  }, [bindForm, changePhoneForm, verifyCurrentForm]);

  const applyLoadedStatus = useCallback((nextStatus: AccountPhoneBindingStatus): void => {
    setStatus(nextStatus);
    resetPhoneBindingForms();
  }, [resetPhoneBindingForms]);

  const requestPhoneBindingStatus = useCallback(async (): Promise<AccountPhoneBindingStatus> => {
    const response = await getAccountPhoneBindingStatus(SILENT_API_REQUEST_CONFIG);
    return response.data;
  }, []);

  const refreshPhoneBindingStatus = useCallback((): Promise<void> => {
    setStatusLoading(true);
    return requestPhoneBindingStatus()
      .then(applyLoadedStatus)
      .catch((error: Error) => {
        notifyUnifiedApiError(message, error, '手机号绑定状态加载失败');
      })
      .finally(() => {
        setStatusLoading(false);
      });
  }, [applyLoadedStatus, message, requestPhoneBindingStatus]);

  useEffect(() => {
    if (!enabled) {
      setStatus(null);
      setStatusLoading(false);
      resetPhoneBindingForms();
      return undefined;
    }

    let active = true;
    setStatusLoading(true);
    void requestPhoneBindingStatus()
      .then((nextStatus) => {
        if (!active) return;
        applyLoadedStatus(nextStatus);
      })
      .catch((error: Error) => {
        if (!active) return;
        notifyUnifiedApiError(message, error, '手机号绑定状态加载失败');
      })
      .finally(() => {
        if (active) {
          setStatusLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [applyLoadedStatus, enabled, message, requestPhoneBindingStatus, resetPhoneBindingForms]);

  const sendBindCodeRequest = useCallback(
    (captchaPayload: UnifiedCaptchaPayload) => {
      return sendAccountPhoneBindingCode(
        {
          phoneNumber: normalizedBindPhoneNumber,
          ...captchaPayload,
        },
        SILENT_API_REQUEST_CONFIG,
      );
    },
    [normalizedBindPhoneNumber],
  );

  const sendCurrentCodeRequest = useCallback((captchaPayload: UnifiedCaptchaPayload) => {
    return sendAccountPhoneBindingCurrentCode(captchaPayload, SILENT_API_REQUEST_CONFIG);
  }, []);

  const sendNewCodeRequest = useCallback(
    (captchaPayload: UnifiedCaptchaPayload) => {
      return sendAccountPhoneBindingNewCode(
        {
          phoneNumber: normalizedNewPhoneNumber,
          ...captchaPayload,
        },
        SILENT_API_REQUEST_CONFIG,
      );
    },
    [normalizedNewPhoneNumber],
  );

  const bindPhoneCode = useSettingPhoneCode({
    enabled: enabled && featureEnabled && !isBound,
    canSend: normalizedBindPhoneNumber.length > 0,
    missingTargetMessage: '请输入手机号',
    sendCodeRequest: sendBindCodeRequest,
    fallbackMessage: '绑定手机号验证码发送失败',
  });

  const currentPhoneCode = useSettingPhoneCode({
    enabled: enabled && featureEnabled && isBound && changeToken.length <= 0,
    canSend: enabled && featureEnabled && isBound,
    missingTargetMessage: '当前账号尚未绑定手机号',
    sendCodeRequest: sendCurrentCodeRequest,
    fallbackMessage: '原手机号验证码发送失败',
  });

  const newPhoneCode = useSettingPhoneCode({
    enabled: enabled && featureEnabled && isBound && changeToken.length > 0,
    canSend: normalizedNewPhoneNumber.length > 0 && changeToken.length > 0,
    missingTargetMessage: changeToken ? '请输入新手机号' : '请先验证当前绑定手机号',
    sendCodeRequest: sendNewCodeRequest,
    fallbackMessage: '新手机号验证码发送失败',
  });

  const handleBindPhone = useCallback((values: FirstBindFormValues): void => {
    const phoneNumber = values.phoneNumber?.trim() ?? '';
    const code = values.smsCode?.trim() ?? '';
    setBinding(true);
    void bindAccountPhoneNumber(
      { phoneNumber, code },
      SILENT_API_REQUEST_CONFIG,
    )
      .then((response) => {
        message.success('手机号绑定成功');
        applyLoadedStatus({
          enabled: true,
          isBound: true,
          maskedPhoneNumber: response.data.maskedPhoneNumber,
        });
      })
      .catch((error: Error) => {
        notifyUnifiedApiError(message, error, '手机号绑定失败');
      })
      .finally(() => {
        setBinding(false);
      });
  }, [applyLoadedStatus, message]);

  const handleVerifyCurrentPhone = useCallback((values: VerifyCurrentFormValues): void => {
    const currentPhoneCodeValue = values.currentPhoneCode?.trim() ?? '';
    setVerifyingCurrent(true);
    void verifyAccountPhoneBindingCurrent(
      { currentPhoneCode: currentPhoneCodeValue },
      SILENT_API_REQUEST_CONFIG,
    )
      .then((response) => {
        setChangeToken(response.data.changeToken);
        setChangeTokenExpiresSeconds(response.data.expiresSeconds);
        verifyCurrentForm.resetFields();
        changePhoneForm.resetFields();
        message.success('原手机号验证通过');
      })
      .catch((error: Error) => {
        notifyUnifiedApiError(message, error, '原手机号验证失败');
      })
      .finally(() => {
        setVerifyingCurrent(false);
      });
  }, [changePhoneForm, message, verifyCurrentForm]);

  const handleChangePhone = useCallback((values: ChangePhoneFormValues): void => {
    const newPhoneNumberValue = values.newPhoneNumber?.trim() ?? '';
    const newPhoneCodeValue = values.newPhoneCode?.trim() ?? '';
    setChangingPhone(true);
    void changeAccountPhoneBinding(
      {
        newPhoneNumber: newPhoneNumberValue,
        changeToken,
        newPhoneCode: newPhoneCodeValue,
      },
      SILENT_API_REQUEST_CONFIG,
    )
      .then((response) => {
        message.success('绑定手机号已更换');
        applyLoadedStatus({
          enabled: true,
          isBound: true,
          maskedPhoneNumber: response.data.maskedPhoneNumber,
        });
      })
      .catch((error: Error) => {
        notifyUnifiedApiError(message, error, '手机号换绑失败');
      })
      .finally(() => {
        setChangingPhone(false);
      });
  }, [applyLoadedStatus, changeToken, message]);

  const resetCurrentVerification = useCallback((): void => {
    verifyCurrentForm.resetFields();
    changePhoneForm.resetFields();
    setChangeToken('');
    setChangeTokenExpiresSeconds(0);
  }, [changePhoneForm, verifyCurrentForm]);

  if (statusLoading && !status) {
    return (
      <div className="setting-rule-card setting-phone-panel">
        <Skeleton active paragraph={{ rows: 4 }} />
      </div>
    );
  }

  if (!status) {
    return (
      <div className="setting-rule-card setting-phone-panel">
        <Typography.Text type="secondary">
          手机号绑定状态暂未加载。
        </Typography.Text>
        <Button
          type="primary"
          loading={statusLoading}
          onClick={() => { void refreshPhoneBindingStatus(); }}
        >
          重新加载
        </Button>
      </div>
    );
  }

  if (!status.enabled) {
    return (
      <div className="setting-rule-card setting-phone-panel">
        <Typography.Text strong>手机号绑定暂未开启</Typography.Text>
        <Typography.Text type="secondary" className="setting-rule-tip">
          当前服务器未开启账号手机号绑定能力，请稍后再试。
        </Typography.Text>
      </div>
    );
  }

  if (!status.isBound) {
    return (
      <Space orientation="vertical" size={12} style={{ width: '100%' }}>
        <Typography.Text type="secondary" className="setting-rule-tip">
          绑定手机号后，可用于短信登录和账号找回。
        </Typography.Text>

        <div className="setting-rule-card setting-phone-panel">
          <Typography.Text strong>绑定手机号</Typography.Text>
          <Form
            form={bindForm}
            layout="vertical"
            onFinish={handleBindPhone}
            disabled={binding}
            className="setting-phone-form"
          >
            <Form.Item
              label="手机号"
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

            <PhoneBindingSmsCodeField
              phoneCode={bindPhoneCode}
              name="smsCode"
              label="短信验证码"
              placeholder="请输入短信验证码"
              disabled={binding}
            />

            <div className="setting-phone-actions">
              <Button
                onClick={() => bindForm.resetFields()}
                disabled={binding}
              >
                重置
              </Button>
              <Button type="primary" htmlType="submit" loading={binding}>
                确认绑定
              </Button>
            </div>
          </Form>
        </div>
      </Space>
    );
  }

  return (
    <Space orientation="vertical" size={12} style={{ width: '100%' }}>
      <div className="setting-rule-card setting-phone-status-card">
        <div className="setting-phone-status">
          <div className="setting-phone-status-main">
            <Typography.Text strong>当前绑定手机号</Typography.Text>
            <Typography.Text className="setting-phone-number">
              {status.maskedPhoneNumber ?? '-'}
            </Typography.Text>
          </div>
          <Button
            size="small"
            loading={statusLoading}
            onClick={() => { void refreshPhoneBindingStatus(); }}
          >
            刷新
          </Button>
        </div>
      </div>

      <div className="setting-rule-card setting-phone-panel">
        <Typography.Text strong>第一步：验证当前手机号</Typography.Text>
        {changeToken ? (
          <div className="setting-phone-verified">
            <Typography.Text type="secondary">
              原手机号已验证，{formatChangeTokenExpiresText(changeTokenExpiresSeconds)}。
            </Typography.Text>
            <Button size="small" onClick={resetCurrentVerification}>
              重新验证
            </Button>
          </div>
        ) : (
          <Form
            form={verifyCurrentForm}
            layout="vertical"
            onFinish={handleVerifyCurrentPhone}
            disabled={verifyingCurrent}
            className="setting-phone-form"
          >
            <PhoneBindingSmsCodeField
              phoneCode={currentPhoneCode}
              name="currentPhoneCode"
              label="原手机号验证码"
              placeholder="发送到当前绑定手机号"
              disabled={verifyingCurrent}
            />

            <div className="setting-phone-actions">
              <Button type="primary" htmlType="submit" loading={verifyingCurrent}>
                验证原手机号
              </Button>
            </div>
          </Form>
        )}
      </div>

      <div className="setting-rule-card setting-phone-panel">
        <Typography.Text strong>第二步：绑定新手机号</Typography.Text>
        <Form
          form={changePhoneForm}
          layout="vertical"
          onFinish={handleChangePhone}
          disabled={changingPhone || changeToken.length <= 0}
          className="setting-phone-form"
        >
          <Form.Item
            label="新手机号"
            name="newPhoneNumber"
            rules={[{ required: true, message: '请输入新手机号' }]}
          >
            <Input
              prefix={<MobileOutlined />}
              placeholder="大陆手机号"
              inputMode="numeric"
              maxLength={20}
              autoComplete="tel"
            />
          </Form.Item>

          <PhoneBindingSmsCodeField
            phoneCode={newPhoneCode}
            name="newPhoneCode"
            label="新手机号验证码"
            placeholder="请输入新手机号验证码"
            disabled={changingPhone || changeToken.length <= 0}
          />

          <div className="setting-phone-actions">
            <Button
              onClick={() => changePhoneForm.resetFields()}
              disabled={changingPhone || changeToken.length <= 0}
            >
              重置
            </Button>
            <Button
              type="primary"
              htmlType="submit"
              loading={changingPhone}
              disabled={changeToken.length <= 0}
            >
              确认换绑
            </Button>
          </div>
        </Form>
      </div>
    </Space>
  );
}
