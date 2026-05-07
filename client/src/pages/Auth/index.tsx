import { useState } from 'react';
import { App, Button, Form, Input } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';

import CreateCharacter from '../../components/CreateCharacter';
import {
  checkCharacter,
  legacyBindPhone,
  phoneLogin,
  register as apiRegister,
} from '../../services/api';
import { IMG_LOGO as logo } from '../Game/shared/imageAssets';
import AuthSmsCodeField, {
  type AuthSmsCodeFormValues,
} from './components/AuthSmsCodeField';
import './index.scss';

interface AuthProps {
  onLoginSuccess: () => void;
}

type AuthMode = 'login' | 'register' | 'legacy-bind';

type PhoneLoginFormValues = AuthSmsCodeFormValues;

type RegisterFormValues = AuthSmsCodeFormValues & {
  username: string;
};

type LegacyBindFormValues = AuthSmsCodeFormValues & {
  username: string;
  password: string;
};

type AuthStorageUser = {
  id: number;
  username: string;
};

const AUTH_MODE_TITLE: Record<AuthMode, string> = {
  login: '手机号登录',
  register: '注册成为修仙者',
  'legacy-bind': '老账号绑定手机号',
};

const Auth: React.FC<AuthProps> = ({ onLoginSuccess }) => {
  const { message } = App.useApp();
  const [loginForm] = Form.useForm<PhoneLoginFormValues>();
  const [registerForm] = Form.useForm<RegisterFormValues>();
  const [legacyBindForm] = Form.useForm<LegacyBindFormValues>();
  const [mode, setMode] = useState<AuthMode>('login');
  const [loading, setLoading] = useState(false);
  const [showCreateCharacter, setShowCreateCharacter] = useState(false);

  const completeLogin = async (token: string, user: AuthStorageUser): Promise<void> => {
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
    message.success('登录成功');

    try {
      const charResult = await checkCharacter();
      if (charResult.success && charResult.data?.hasCharacter) {
        onLoginSuccess();
      } else {
        setShowCreateCharacter(true);
      }
    } catch {
      void 0;
    }
  };

  const handlePhoneLogin = async (values: PhoneLoginFormValues) => {
    const phoneNumber = values.phoneNumber?.trim() ?? '';
    const smsCode = values.smsCode?.trim() ?? '';
    setLoading(true);
    try {
      const result = await phoneLogin({ phoneNumber, smsCode });
      if (!result.data) {
        throw new Error('登录响应缺少账号数据');
      }
      await completeLogin(result.data.token, result.data.user);
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (values: RegisterFormValues) => {
    const phoneNumber = values.phoneNumber?.trim() ?? '';
    const smsCode = values.smsCode?.trim() ?? '';
    const username = values.username.trim();
    setLoading(true);
    try {
      await apiRegister({ username, phoneNumber, smsCode });
      message.success('注册成功，请使用手机号登录');
      registerForm.resetFields();
      setMode('login');
      loginForm.setFieldsValue({ phoneNumber });
    } finally {
      setLoading(false);
    }
  };

  const handleLegacyBind = async (values: LegacyBindFormValues) => {
    const phoneNumber = values.phoneNumber?.trim() ?? '';
    const smsCode = values.smsCode?.trim() ?? '';
    const username = values.username.trim();
    const password = values.password;
    setLoading(true);
    try {
      const result = await legacyBindPhone({ username, password, phoneNumber, smsCode });
      if (!result.data) {
        throw new Error('绑定登录响应缺少账号数据');
      }
      await completeLogin(result.data.token, result.data.user);
    } finally {
      setLoading(false);
    }
  };

  const handleCharacterCreated = () => {
    setShowCreateCharacter(false);
    onLoginSuccess();
  };

  return (
    <div className="auth-container">
      <div className="auth-background">
        <div className="cloud cloud-1" />
        <div className="cloud cloud-2" />
        <div className="cloud cloud-3" />
      </div>

      <div className="auth-card">
        <div className="card-face">
          <div className="card-header">
            <img src={logo} alt="九州修仙录" className="logo" />
            <p>{AUTH_MODE_TITLE[mode]}</p>
          </div>

          <div className="auth-mode-tabs" role="tablist" aria-label="登录方式">
            <Button
              type={mode === 'login' ? 'primary' : 'default'}
              onClick={() => setMode('login')}
            >
              手机登录
            </Button>
            <Button
              type={mode === 'register' ? 'primary' : 'default'}
              onClick={() => setMode('register')}
            >
              注册
            </Button>
            <Button
              type={mode === 'legacy-bind' ? 'primary' : 'default'}
              onClick={() => setMode('legacy-bind')}
            >
              老账号绑定
            </Button>
          </div>

          {mode === 'login' && (
            <Form form={loginForm} name="phone-login" onFinish={handlePhoneLogin} size="large">
              <AuthSmsCodeField form={loginForm} purpose="login" enabled={mode === 'login'} />

              <Form.Item>
                <Button type="primary" htmlType="submit" block loading={loading}>
                  踏入仙途
                </Button>
              </Form.Item>
            </Form>
          )}

          {mode === 'register' && (
            <Form form={registerForm} name="phone-register" onFinish={handleRegister} size="large">
              <AuthSmsCodeField form={registerForm} purpose="register" enabled={mode === 'register'} />

              <Form.Item
                name="username"
                rules={[
                  { required: true, message: '请输入道号' },
                  { min: 2, max: 20, message: '道号长度需在2-20个字符之间' },
                ]}
              >
                <Input prefix={<UserOutlined />} placeholder="道号" autoComplete="username" />
              </Form.Item>

              <Form.Item>
                <Button type="primary" htmlType="submit" block loading={loading}>
                  立下道心
                </Button>
              </Form.Item>
            </Form>
          )}

          {mode === 'legacy-bind' && (
            <Form form={legacyBindForm} name="legacy-bind" onFinish={handleLegacyBind} size="large">
              <Form.Item name="username" rules={[{ required: true, message: '请输入道号' }]}>
                <Input prefix={<UserOutlined />} placeholder="原道号" autoComplete="username" />
              </Form.Item>

              <Form.Item name="password" rules={[{ required: true, message: '请输入口令' }]}>
                <Input.Password prefix={<LockOutlined />} placeholder="原口令" autoComplete="current-password" />
              </Form.Item>

              <AuthSmsCodeField form={legacyBindForm} purpose="legacy-bind" enabled={mode === 'legacy-bind'} />

              <Form.Item>
                <Button type="primary" htmlType="submit" block loading={loading}>
                  绑定并进入
                </Button>
              </Form.Item>
            </Form>
          )}
        </div>
      </div>

      <CreateCharacter
        open={showCreateCharacter}
        onSuccess={handleCharacterCreated}
      />
    </div>
  );
};

export default Auth;
