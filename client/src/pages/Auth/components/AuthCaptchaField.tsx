/**
 * 鉴权页图片验证码字段
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：集中处理登录/注册共用的验证码图片拉取、刷新、输入框展示与表单字段同步，避免两个表单各自维护同一套请求和状态逻辑。
 * 2. 做什么：统一维护 `captchaId` 与 `captchaCode` 的表单写入规则，让服务端验证码契约只在一个前端组件里落地。
 * 3. 不做什么：不负责登录注册提交，不处理账号密码校验，也不决定表单成功后的跳转。
 *
 * 输入/输出：
 * - 输入：`refreshNonce` 刷新信号、`onChange` 字段同步回调。
 * - 输出：通过 `onChange` 回写最新的 `captchaId/captchaCode`，并渲染验证码输入与图片刷新交互。
 *
 * 数据流/状态流：
 * - 页面挂载或 `refreshNonce` 变化 -> 请求 `/api/auth/captcha` -> 更新本地图片状态 -> 同步写入表单 `captchaId`
 * - 用户点击图片刷新 -> 重新拉取验证码 -> 清空 `captchaCode`
 *
 * 关键边界条件与坑点：
 * 1. 验证码在服务端是一次性消费，因此每次刷新都必须同步更新隐藏的 `captchaId`，不能只替换图片而沿用旧 ID。
 * 2. 组件会被登录和注册两处复用，错误提示与加载态必须集中在这里，避免表单页再复制同样的刷新失败处理。
 */
import { useEffect, useRef, useState } from 'react';
import { App, Form, Input } from 'antd';
import { SafetyCertificateOutlined } from '@ant-design/icons';

import { getUnifiedApiErrorMessage } from '../../../services/api/error';
import {
  getCaptcha,
  type CaptchaChallenge,
  type CaptchaVerifyPayload,
} from '../../../services/api/auth-character';

interface AuthCaptchaFieldProps {
  onChange: (values: CaptchaVerifyPayload) => void;
  refreshNonce: number;
}

export default function AuthCaptchaField({
  onChange,
  refreshNonce,
}: AuthCaptchaFieldProps) {
  const { message } = App.useApp();
  const [captcha, setCaptcha] = useState<CaptchaChallenge | null>(null);
  const [loading, setLoading] = useState(false);
  const requestIdRef = useRef(0);

  const refreshCaptcha = async (): Promise<void> => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);

    try {
      const result = await getCaptcha();
      if (requestIdRef.current !== requestId) {
        return;
      }

      setCaptcha(result.data);
      onChange({
        captchaId: result.data.captchaId,
        captchaCode: '',
      });
    } catch (error) {
      if (requestIdRef.current !== requestId) {
        return;
      }

      const errorMessage = getUnifiedApiErrorMessage(error, '图片验证码加载失败');
      setCaptcha(null);
      onChange({
        captchaId: '',
        captchaCode: '',
      });
      message.error(errorMessage);
    } finally {
      if (requestIdRef.current === requestId) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    void refreshCaptcha();
  }, [refreshNonce]);

  return (
    <div className="auth-captcha">
      <Form.Item name="captchaId" hidden>
        <Input />
      </Form.Item>

      <div className="auth-captcha__row">
        <Form.Item
          className="auth-captcha__input"
          name="captchaCode"
          rules={[
            { required: true, message: '请输入图片验证码' },
            { len: 4, message: '图片验证码为4位' },
          ]}
        >
          <Input
            autoComplete="off"
            maxLength={4}
            prefix={<SafetyCertificateOutlined />}
            placeholder="图片验证码"
          />
        </Form.Item>

        <div className="auth-captcha__visual">
          <button
            type="button"
            className="auth-captcha__image-button"
            onClick={() => {
              void refreshCaptcha();
            }}
            disabled={loading}
            aria-label="刷新图片验证码"
          >
            {captcha ? (
              <img
                className="auth-captcha__image"
                src={captcha.imageData}
                alt="图片验证码"
              />
            ) : (
              <span className="auth-captcha__placeholder">
              {loading ? '加载中...' : '点击重试'}
            </span>
          )}
        </button>
        </div>
      </div>
    </div>
  );
}
